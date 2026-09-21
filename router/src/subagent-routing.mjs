import { CHECKED_IN_MODELS } from "./model-registry.mjs";
import { readMultiAgentSettings, subagentEligibleModels } from "./multi-agent-state.mjs";

// This module is an unadvertised routing primitive. Codex's agent definitions
// still come from codex-agent-catalog.mjs; the router calls this planner only
// after a verified child route reports a pre-response transport failure.

export const MAX_SUBAGENT_WEIGHT = 16;
export const MAX_SUBAGENT_ATTEMPTS = 3;

const FAILURE_KINDS = new Set(["transport", "connection", "timeout", "dns", "reset"]);
const ID_PATTERN = /^[^\s\u0000]{1,240}$/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validId(value) {
  return ID_PATTERN.test(text(value));
}

function boundedPositiveInteger(value, fallback = 1, max = MAX_SUBAGENT_WEIGHT) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

function identityOf(model) {
  const slug = text(model?.slug || model?.id || model?.model);
  const provider = text(model?.provider || model?.providerId);
  return slug && provider ? `${slug}\u0000${provider}` : "";
}

function authorityMap(authority) {
  const map = new Map();
  for (const model of Array.isArray(authority) ? authority : []) {
    const identity = identityOf(model);
    if (!identity || model.multiAgentVersion !== "v2") continue;
    if (!map.has(identity)) map.set(identity, model);
  }
  return map;
}

function eligibleAuthority(authority, settings) {
  const configured = settings || readMultiAgentSettings();
  const checkedIn = authorityMap(
    subagentEligibleModels(CHECKED_IN_MODELS, configured),
  );
  if (authority === undefined || authority === CHECKED_IN_MODELS) return checkedIn;

  // A caller may provide a runtime projection to limit or order the checked-in
  // routes, but its metadata is never an authority. Intersect by exact identity
  // and always return the immutable checked-in record.
  const requested = new Set(
    (Array.isArray(authority) ? authority : [])
      .map((model) => identityOf(model))
      .filter(Boolean),
  );
  return new Map([...checkedIn].filter(([identity]) => requested.has(identity)));
}

function supports(record, capability) {
  if (capability === "tools") return record.multiAgentVersion === "v2";
  if (capability === "vision") {
    return Array.isArray(record.inputModalities) && record.inputModalities.includes("image");
  }
  if (capability === "search") {
    return record.searchTool?.mode === "hosted" || record.searchTool?.mode === "standalone";
  }
  return false;
}

function authorityRecord(model, authority = CHECKED_IN_MODELS, settings) {
  const records = eligibleAuthority(authority, settings);
  return records.get(identityOf(model));
}

function capabilityNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item).toLowerCase()).filter(Boolean))];
}

/**
 * Normalize an explicit model/provider chain.  A bare model is accepted only
 * when the caller's authoritative registry has one provider for that slug;
 * callers must provide provider for an ambiguous slug.  Provider-only entries
 * are rejected because they do not identify a concrete delegation target.
 */
export function normalizeSubagentChain(chain) {
  if (!Array.isArray(chain)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of chain) {
    const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    const model = text(typeof raw === "string" ? raw : object?.model || object?.slug);
    const provider = text(object?.provider || object?.providerId);
    if (!validId(model) || (provider && !validId(provider))) continue;
    const key = `${model}\u0000${provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ model, ...(provider ? { provider } : {}), weight: boundedPositiveInteger(object?.weight) });
  }
  return result;
}

function targetMatches(model, target, candidates) {
  const slug = text(model?.slug);
  if (slug !== target.model) return false;
  if (target.provider) return text(model?.provider) === target.provider;
  return candidates.filter((candidate) => text(candidate?.slug) === slug).length === 1;
}

/**
 * Return the reason a candidate is not a verified v2 delegation target.
 * Capability and version fields on the candidate are never trusted: the
 * checked-in registry record is the authority and supplies both.
 */
export function subagentEligibility(
  model,
  { authority = CHECKED_IN_MODELS, settings, requiredCapabilities = [], estimatedTokens } = {},
) {
  if (!validId(model?.slug)) return "missing-model-id";
  if (!validId(model?.provider)) return "missing-provider-id";
  const record = authorityRecord(model, authority, settings);
  if (!record) return "unverified-model";
  const missing = capabilityNames(requiredCapabilities).filter((capability) => !supports(record, capability));
  if (missing.length) return `missing-capability:${missing.join(",")}`;
  if (
    Number.isFinite(estimatedTokens) &&
    Number.isFinite(Number(record.contextWindow)) &&
    Number(record.contextWindow) < estimatedTokens
  ) {
    return "context-window-too-small";
  }
  return undefined;
}

/**
 * Rank runtime candidates against checked-in v2 delegation records.  Runtime
 * metadata may choose health/order, but it cannot add a model, provider,
 * capability, or v2 certificate.  The returned model is the authoritative
 * registry record, preserving the exact provider identity for the caller.
 */
export function rankSubagentCandidates(
  candidates,
  { authority = CHECKED_IN_MODELS, settings, chain = [], requiredCapabilities = [], estimatedTokens } = {},
) {
  const runtime = Array.isArray(candidates) ? candidates : [];
  const authorityByIdentity = eligibleAuthority(authority, settings);
  const runtimeByIdentity = new Map();
  for (const candidate of runtime) {
    const record = authorityByIdentity.get(identityOf(candidate));
    if (!record || subagentEligibility(candidate, { authority, settings, requiredCapabilities, estimatedTokens })) {
      continue;
    }
    if (!runtimeByIdentity.has(identityOf(record))) runtimeByIdentity.set(identityOf(record), candidate);
  }
  const available = [...runtimeByIdentity.keys()].map((identity) => authorityByIdentity.get(identity));
  const normalized = normalizeSubagentChain(chain);
  const ranked = [];
  const seen = new Set();
  const add = (record, weight, source) => {
    const identity = identityOf(record);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    ranked.push({
      model: record,
      slug: record.slug,
      provider: record.provider,
      weight: boundedPositiveInteger(weight),
      source,
    });
  };

  if (normalized.length) {
    for (const target of normalized) {
      for (const record of available) {
        if (targetMatches(record, target, available)) add(record, target.weight, "chain");
      }
    }
  } else {
    for (const record of available) add(record, 1, "available");
  }
  return ranked;
}

/** Return the currently enabled, checked-in v2 delegation targets. */
export function verifiedSubagentTargets({ authority = CHECKED_IN_MODELS, settings } = {}) {
  return [...eligibleAuthority(authority, settings).values()].map((model) => ({
    model,
    slug: model.slug,
    provider: model.provider,
    weight: 1,
    source: "registry-v2",
  }));
}

/**
 * Select a deterministic weighted entry without expanding a large repeated
 * array.  Weights are bounded during chain normalization and again here for
 * callers that construct ranked entries directly.
 */
export function selectWeightedSubagentTarget(ranked, { selectionIndex = 0 } = {}) {
  const entries = Array.isArray(ranked) ? ranked : [];
  const total = entries.reduce((sum, entry) => sum + boundedPositiveInteger(entry?.weight), 0);
  if (!total) return undefined;
  const index = Number.isInteger(selectionIndex) && selectionIndex >= 0 ? selectionIndex % total : 0;
  let cursor = 0;
  for (const entry of entries) {
    cursor += boundedPositiveInteger(entry?.weight);
    if (index < cursor) return entry;
  }
  return entries[entries.length - 1];
}

/**
 * Plan a bounded pre-response transport retry. Application errors and any
 * response that has committed bytes are never silently moved to another
 * provider. `failedTarget` is excluded by exact model/provider identity only.
 */
export function subagentFallbackPlan(
  ranked,
  {
    committed = false,
    failureKind,
    selectionIndex = 0,
    failedTarget,
    maxAttempts = MAX_SUBAGENT_ATTEMPTS,
    settings,
  } = {},
) {
  const kind = text(failureKind).toLowerCase();
  if (committed || !FAILURE_KINDS.has(kind)) return undefined;
  const authority = eligibleAuthority(undefined, settings);
  const entriesByIdentity = new Map();
  for (const entry of Array.isArray(ranked) ? ranked : []) {
    const model = entry?.model || entry;
    const record = authority.get(identityOf(model));
    if (!record) continue;
    const identity = identityOf(record);
    if (!entriesByIdentity.has(identity)) {
      entriesByIdentity.set(identity, {
        ...(entry && typeof entry === "object" ? entry : {}),
        model: record,
        slug: record.slug,
        provider: record.provider,
      });
    }
  }
  const entries = [...entriesByIdentity.values()];
  const identity = identityOf(failedTarget?.model || failedTarget);
  // A failed route without both fields cannot be excluded safely. Refuse a
  // retry instead of guessing by slug and risking the same provider again.
  if (!identity) return undefined;
  const excluded = new Set([identity]);
  const candidates = entries.filter((entry) => !excluded.has(identityOf(entry.model || entry)));
  const target = selectWeightedSubagentTarget(candidates, { selectionIndex });
  if (!target) return undefined;
  const targetIdentity = identityOf(target.model || target);
  const limit = boundedPositiveInteger(maxAttempts, MAX_SUBAGENT_ATTEMPTS, MAX_SUBAGENT_ATTEMPTS);
  const fallbacks = candidates
    .filter((entry) => identityOf(entry.model || entry) !== targetIdentity)
    .slice(0, Math.max(0, limit - 1));
  return {
    target,
    fallbacks,
    attempts: [target, ...fallbacks],
    maxAttempts: Math.min(limit, 1 + fallbacks.length),
    committed: false,
    failureKind: kind,
  };
}

/** Stable diagnostic containing only the selected target identity. */
export function subagentTargetDiagnostic({ agentId, target, attempt = 0, source = "available" } = {}) {
  const model = target?.model || target;
  return {
    ...(text(agentId) ? { agentId: text(agentId) } : {}),
    target: text(model?.slug),
    provider: text(model?.provider),
    attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
    source: text(source) || "available",
  };
}
