import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Machine-local subagent capability proofs.
//
// The registry's `multiAgentVersion: "v2"` marks models proven through the
// full native collaboration probe and shipped to every installer. This file
// holds local triage evidence for models the operator nominated for
// certification. It is deliberately not a second source of v2 claims: only a
// checked-in registry entry has completed the full native collaboration proof
// and may be exposed to Codex as a v2 subagent.
//
// Lifecycle per slug:
//   checking      the probe worker is running; nothing is advertised yet
//   candidate     the low-cost stream/tool probe passed; submit its redacted
//                 application for the native encrypted-relay proof
//   experimental  retained only for legacy local records; later child traffic
//                 may refine the diagnostic record, but cannot advertise v2
//   proven        retained only for legacy local records; it means one child
//                 HTTP turn once completed, not that delegated work finished
//   failed        the probe or legacy observed child traffic failed; the
//                 reason remains visible where the model was nominated
//
// Legacy experimental/proven records are certification candidates, not
// authority. They are kept so upgrades neither erase useful evidence nor
// automatically repeat quota-spending probes. Completing the encrypted relay,
// marker-return, and same-thread checks belongs in v2_agent/; only the matching
// checked-in registry declaration may expose the route as v2.
export const SUBAGENT_PROOFS_PATH =
  process.env.MODEL_ROUTER_SUBAGENT_PROOFS ||
  path.join(STATE_DIR, "multi-agent-proofs.json");

const KNOWN_STATUSES = new Set([
  "checking",
  "candidate",
  "experimental",
  "proven",
  "failed",
  "verified",
]);

// The five live checks in v2_agent/README.md, in the order a reviewer runs
// them. A record may promote only when every one of them passed in the same
// run: 1-2 are the cheap stream/tool probe that must never stand in for native
// collaboration, and 3-5 are the delegation itself.
export const VERIFICATION_CHECKS = Object.freeze([
  "streaming",
  "toolCall",
  "encryptedRelay",
  "markerReturn",
  "sameThreadFollowUp",
]);

// Raise this only when a change makes previously gathered evidence untrue -- a
// different relay format, a different check set. Every existing record then
// stops promoting and has to be measured again, so invalidation is a
// deliberate act rather than a side effect of shipping a release.
export const PROOF_EPOCH = 1;

// A file that exists but cannot be parsed promotes nothing: somebody's
// evidence was here and we can no longer read it, so the conservative v1
// default applies until the operator re-verifies.
export function readSubagentProofs(filePath = SUBAGENT_PROOFS_PATH) {
  if (!existsSync(filePath)) return { version: 1, proofs: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.proofs && typeof parsed.proofs === "object") {
      const proofs = {};
      for (const [slug, proof] of Object.entries(parsed.proofs)) {
        if (proof && typeof proof === "object" && KNOWN_STATUSES.has(proof.status)) {
          proofs[slug] = proof;
        }
      }
      return { version: 1, proofs };
    }
  } catch {
    // Fall through to the empty (promote-nothing) state.
  }
  return { version: 1, proofs: {} };
}

function writeProofs(state, filePath = SUBAGENT_PROOFS_PATH) {
  writePrivateJson(filePath, state, { directoryMode: 0o700 });
}

function updateProof(slug, update, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  const key = String(slug);
  const next = {
    version: 1,
    proofs: { ...state.proofs, [key]: { ...state.proofs[key], ...update } },
  };
  writeProofs(next, filePath);
  return next.proofs[key];
}

export function recordProbeStarted(slug, { at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "checking", startedAt: at });
}

export function recordProbeResult(slug, { ok, checks, detail, at = new Date().toISOString() }) {
  if (ok) {
    return updateProof(slug, {
      status: "candidate",
      toolProbe: { ok: true, checks, at },
      reason: undefined,
    });
  }
  return updateProof(slug, {
    status: "failed",
    toolProbe: { ok: false, checks, at },
    reason: detail || "compatibility probe failed",
  });
}

export function recordSpawnObserved(slug, { status, at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "proven", spawn: { ok: true, status, at } });
}

// `turns` and `newInputTokens` are carried so the recorded evidence says how
// much of a spawn it took, not just that one failed: the proofs snapshot is
// what `control subagents verify`, `control subagents status` and the tray
// render, so this is where negative diagnostic evidence becomes readable.
export function recordSpawnFailure(
  slug,
  { status, reason, turns, newInputTokens, at = new Date().toISOString() } = {},
) {
  return updateProof(slug, {
    status: "failed",
    spawn: {
      ok: false,
      status,
      at,
      ...(Number.isInteger(turns) && turns > 0 ? { turns } : {}),
      ...(Number.isInteger(newInputTokens) && newInputTokens > 0
        ? { newInputTokens }
        : {}),
    },
    reason: reason || `spawn failed with HTTP ${status}`,
  });
}

export function clearSubagentProof(slug, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  if (!(String(slug) in state.proofs)) return;
  const proofs = { ...state.proofs };
  delete proofs[String(slug)];
  writeProofs({ version: 1, proofs }, filePath);
}

export function subagentProofSnapshot(filePath = SUBAGENT_PROOFS_PATH) {
  return readSubagentProofs(filePath).proofs;
}

// Whether one record is a completed local verification of THIS route.
//
// Every clause here keeps the original failure closed: a stream/tool probe
// must never masquerade as native collaboration proof, or an actually-v1 route
// reaches Codex's v2 subagent list and breaks at spawn time, after the user
// picked it. So a diagnostic status can never promote, a partial run can never
// promote, and a record can never promote a route it was not produced for.
export function verifiedForRoute(proof, slug, { routerVersion } = {}) {
  if (!proof || typeof proof !== "object") return false;
  if (proof.status !== "verified") return false;
  if (String(proof.slug || "") !== String(slug)) return false;
  const checks = proof.checks;
  if (!checks || typeof checks !== "object") return false;
  for (const name of VERIFICATION_CHECKS) {
    if (checks[name]?.outcome !== "pass") return false;
  }
  // `routerVersion` is provenance, not a gate. What the five checks measure is
  // the provider route's behaviour through the relay, and a router patch bump
  // does not change the provider. Expiring on every upgrade would silently
  // demote every verified route and charge the operator again to re-learn the
  // same answer -- which is the opposite of why the record exists. A change
  // that genuinely invalidates old evidence should raise PROOF_EPOCH instead,
  // so the invalidation is deliberate and reviewable.
  if (Number(proof.epoch || 0) !== PROOF_EPOCH) return false;
  void routerVersion;
  return true;
}

// Registry `multiAgentVersion: "v2"` and a completed local verification are
// the only two ways a route becomes a subagent. Local records reach this only
// through `verifiedForRoute`, so the diagnostic statuses this file has always
// held -- candidate, experimental, proven -- still promote nothing.
export function applySubagentProofs(
  models,
  proofs,
  { hidden, disabled, routerVersion } = {},
) {
  const hiddenSlugs = hidden instanceof Set ? hidden : new Set(hidden || []);
  const disabledSlugs = disabled instanceof Set ? disabled : new Set(disabled || []);
  const records = proofs && typeof proofs === "object" ? proofs : {};
  if (!Array.isArray(models)) return [];
  let promotedAny = false;
  const next = models.map((model) => {
    const slug = String(model?.slug || "");
    if (!slug || model.multiAgentVersion === "v2") return model;
    if (hiddenSlugs.has(slug) || disabledSlugs.has(slug)) return model;
    if (!verifiedForRoute(records[slug], slug, { routerVersion })) return model;
    promotedAny = true;
    return { ...model, multiAgentVersion: "v2", subagentVerifiedLocally: true };
  });
  // Promoting nothing is a pass-through, not a rewrite. Callers compare the
  // result by identity to tell "no local evidence applied" from "applied".
  return promotedAny ? next : models;
}

export function recordVerificationStarted(slug, { at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "checking", slug: String(slug), startedAt: at });
}

// Written from one run, as a whole. The `checks` object is replaced rather
// than merged, so a caller cannot lay a fresh pass over a stale record to
// complete a set: a run that reached only three checks leaves a record that
// promotes nothing.
export function recordVerification(
  slug,
  { checks, routerVersion, failed, reason, at = new Date().toISOString() },
) {
  const complete = VERIFICATION_CHECKS.every((name) => checks?.[name]?.outcome === "pass");
  return updateProof(slug, {
    slug: String(slug),
    status: complete ? "verified" : "failed",
    epoch: PROOF_EPOCH,
    checks: { ...(checks || {}) },
    routerVersion: routerVersion ? String(routerVersion) : undefined,
    verifiedAt: complete ? at : undefined,
    failedCheck: complete ? undefined : failed || firstIncompleteCheck(checks),
    reason: complete ? undefined : reason || "subagent verification did not complete",
  });
}

function firstIncompleteCheck(checks) {
  return VERIFICATION_CHECKS.find((name) => checks?.[name]?.outcome !== "pass");
}

// Legacy helper retained only to refine an historical experimental record from
// child traffic. New candidate records never reach Codex's v2 catalog.
export function awaitingSpawnProof(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}

// Whether child traffic may refine a legacy experimental diagnostic. This can
// change only the local record; it cannot demote or promote registry authority.
export function spawnProofRevocable(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}
