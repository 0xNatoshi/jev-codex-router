// Bounded request diagnostics for usage events. Counts, billing, routes, and
// retries stay in usage-events.mjs; this module only names a request and the
// Grok OAuth 4.6 ingress byte split. It never stores headers, bodies, thread
// titles, or paths.
//
// The request ID is created by the /activity observer and includes its process
// instance ID, so a service restart cannot accidentally join unrelated requests.

export const ROUTER_INGRESS_OBSERVATION_POINT = "router_ingress";
export const GROK_OAUTH_46_SLUG = "grok-oauth/grok-4.6";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;
const MAX_CONTEXT_FIELD_BYTES = 1024 * 1024 * 1024;

export function safeDiagnosticRequestId(value) {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      value = String(value);
    } else {
      return undefined;
    }
  }
  const text = value.trim();
  return REQUEST_ID_PATTERN.test(text) ? text : undefined;
}

function safeByteCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(MAX_CONTEXT_FIELD_BYTES, Math.round(number));
}

export function utf8JsonBytes(value) {
  if (value === undefined) return 0;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return 0;
    return Buffer.byteLength(encoded, "utf8");
  } catch {
    return 0;
  }
}

export function measureIngressContextBytes(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return {
    observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
    instructionsBytes: utf8JsonBytes(payload.instructions),
    toolsBytes: utf8JsonBytes(payload.tools),
    historyBytes: utf8JsonBytes(payload.input),
  };
}

export function grokOauth46IngressContextBytes(payload, route) {
  if (route?.slug !== GROK_OAUTH_46_SLUG) return undefined;
  return measureIngressContextBytes(payload);
}

export function sanitizeContextBytes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.observationPoint !== ROUTER_INGRESS_OBSERVATION_POINT) return undefined;
  return {
    observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
    instructionsBytes: safeByteCount(value.instructionsBytes) ?? 0,
    toolsBytes: safeByteCount(value.toolsBytes) ?? 0,
    historyBytes: safeByteCount(value.historyBytes) ?? 0,
  };
}

export function sanitizeGrokStructuredPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.enabled !== "boolean" || typeof value.applied !== "boolean") return undefined;
  if (value.schemaVersion !== 1 || (value.applied && !value.enabled)) return undefined;
  if (value.mode !== undefined && value.mode !== "client_hook") return undefined;
  return {
    enabled: value.enabled, applied: value.applied, schemaVersion: 1,
    ...(value.mode === "client_hook" ? { mode: "client_hook" } : {}),
  };
}

export const KNOWN_SERVICE_TIERS = Object.freeze(["default", "priority"]);

export function knownServiceTier(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return KNOWN_SERVICE_TIERS.includes(text) ? text : undefined;
}

export function actualServiceTierFromValue(value) {
  if (value === undefined || value === null) return { kind: "missing" };
  if (typeof value !== "string") return { kind: "unknown" };
  const text = value.trim();
  if (!text) return { kind: "missing" };
  const known = knownServiceTier(text);
  return known ? { kind: "known", value: known } : { kind: "unknown" };
}

export function serviceTierMetadata({
  requestedServiceTier,
  serviceTier,
  serviceTierUnknown,
  retries,
  emptyCompletionRetried,
} = {}) {
  const requested = knownServiceTier(requestedServiceTier);
  const actual = knownServiceTier(serviceTier);
  // A row that covers more than one charged attempt cannot carry one
  // attempt's tier, whichever retry path produced the second attempt.
  const multipleAttempts = Boolean(retries) || emptyCompletionRetried === true;
  return {
    ...(requested ? { requestedServiceTier: requested } : {}),
    ...(!multipleAttempts && actual ? { serviceTier: actual } : {}),
    ...(!multipleAttempts && !actual && serviceTierUnknown === true ? { serviceTierUnknown: true } : {}),
  };
}

export function usageDiagnosticMetadata({ requestId, contextBytes, grokStructuredPatch, requestedServiceTier } = {}) {
  const safeRequestId = safeDiagnosticRequestId(requestId);
  const safeContextBytes = sanitizeContextBytes(contextBytes);
  const safeStructuredPatch = sanitizeGrokStructuredPatch(grokStructuredPatch);
  return {
    ...serviceTierMetadata({ requestedServiceTier }),
    ...(safeRequestId ? { requestId: safeRequestId } : {}),
    ...(safeContextBytes ? { contextBytes: safeContextBytes } : {}),
    ...(safeStructuredPatch ? { grokStructuredPatch: safeStructuredPatch } : {}),
  };
}
