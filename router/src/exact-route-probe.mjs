// Live compatibility checks certify one requested route, not the router's
// ability to rescue it with a different model. The marker is accepted only on
// the caller-authenticated local Responses surface, and it is never forwarded
// upstream because routed requests build their own header set.
export const EXACT_ROUTE_PROBE_HEADER = "x-codex-router-exact-route";

export function exactRouteProbeRequested(headers) {
  const value = headers?.[EXACT_ROUTE_PROBE_HEADER];
  if (Array.isArray(value)) return value.some((entry) => String(entry) === "1");
  return String(value || "") === "1";
}
