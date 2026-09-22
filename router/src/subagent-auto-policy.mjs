import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

// Policies are an operator's standing permission to spend the small
// compatibility-probe budget for unknown models that match a route or family.
// They do not assert a v2 capability: only a reviewed repository certificate
// may set multiAgentVersion: "v2". Explicit registry-v1 models are excluded
// by the caller before a policy can spend a probe on them.
export const SUBAGENT_AUTO_POLICY_PATH =
  process.env.MODEL_ROUTER_SUBAGENT_AUTO_POLICY ||
  path.join(STATE_DIR, "subagent-auto-policy.json");

export const SUBAGENT_AUTO_POLICY_KINDS = Object.freeze(["provider", "model", "family"]);

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function validPolicy(kind, value) {
  if (!SUBAGENT_AUTO_POLICY_KINDS.includes(kind)) return false;
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (kind === "family") return normalized(raw).length >= 3;
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(raw);
}

function policyKey(policy) {
  return `${policy.kind}:${policy.value}`;
}

function cleanPolicies(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const policies = [];
  for (const raw of value) {
    const kind = typeof raw?.kind === "string" ? raw.kind : "";
    const value = typeof raw?.value === "string" ? raw.value.trim() : "";
    if (!validPolicy(kind, value)) continue;
    const policy = { kind, value };
    const key = policyKey(policy);
    if (seen.has(key)) continue;
    seen.add(key);
    policies.push(policy);
  }
  return policies.sort((left, right) => policyKey(left).localeCompare(policyKey(right)));
}

export function readSubagentAutoPolicies(filePath = SUBAGENT_AUTO_POLICY_PATH) {
  if (!existsSync(filePath)) return { version: 1, policies: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version === 1) return { version: 1, policies: cleanPolicies(parsed.policies) };
  } catch {
    // An unreadable policy document is permission to spend nothing.
  }
  return { version: 1, policies: [] };
}

function writePolicies(policies, filePath = SUBAGENT_AUTO_POLICY_PATH) {
  writePrivateJson(filePath, { version: 1, policies: cleanPolicies(policies) }, { directoryMode: 0o700 });
}

export function setSubagentAutoPolicy(kind, value, enabled, filePath = SUBAGENT_AUTO_POLICY_PATH) {
  const normalizedKind = String(kind || "").trim();
  const normalizedValue = String(value || "").trim();
  if (!validPolicy(normalizedKind, normalizedValue)) {
    throw new Error(
      "Invalid subagent auto policy. Use provider <provider-id>, model <model-slug>, or family <model-family>.",
    );
  }
  const current = readSubagentAutoPolicies(filePath).policies;
  const key = `${normalizedKind}:${normalizedValue}`;
  const policies = enabled
    ? [...current, { kind: normalizedKind, value: normalizedValue }]
    : current.filter((policy) => policyKey(policy) !== key);
  writePolicies(policies, filePath);
  return readSubagentAutoPolicies(filePath);
}

export function modelMatchesSubagentAutoPolicy(model, policy) {
  if (!model?.slug || !policy) return false;
  if (policy.kind === "model") return String(model.slug) === policy.value;
  if (policy.kind === "provider") {
    return canonicalProviderId(String(model.provider)) === canonicalProviderId(policy.value);
  }
  if (policy.kind === "family") {
    const family = normalized(policy.value);
    return [model.slug, model.displayName, model.upstreamModel]
      .some((value) => normalized(value).includes(family));
  }
  return false;
}

// Keep matching data-only. Callers decide which models are configured and
// listed, and the verifier separately decides which ones still need a probe.
export function matchingSubagentAutoPolicyModels(models, policies = readSubagentAutoPolicies().policies) {
  const active = cleanPolicies(policies);
  const seen = new Set();
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (!model?.slug || seen.has(model.slug)) return false;
    if (!active.some((policy) => modelMatchesSubagentAutoPolicy(model, policy))) return false;
    seen.add(model.slug);
    return true;
  });
}

export function subagentAutoPolicySnapshot(models) {
  const state = readSubagentAutoPolicies();
  return {
    ...state,
    matchingSlugs: matchingSubagentAutoPolicyModels(models, state.policies).map((model) => model.slug),
    path: SUBAGENT_AUTO_POLICY_PATH,
  };
}
