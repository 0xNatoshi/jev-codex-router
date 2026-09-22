// Live compatibility checks certify one requested route, not the router's
// ability to rescue it with a different model. The marker is accepted only on
// the caller-authenticated local Responses surface, and it is never forwarded
// upstream because routed requests build their own header set.
export const EXACT_ROUTE_PROBE_HEADER = "x-codex-router-exact-route";
export const CANONICAL_REPLAY_HEADER = "x-codex-router-canonical-replay";

function enabled(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.some((entry) => String(entry) === "1");
  return String(value || "") === "1";
}

export function exactRouteProbeRequested(headers) {
  return enabled(headers, EXACT_ROUTE_PROBE_HEADER);
}

export function canonicalReplayRequested(headers) {
  return enabled(headers, CANONICAL_REPLAY_HEADER);
}
