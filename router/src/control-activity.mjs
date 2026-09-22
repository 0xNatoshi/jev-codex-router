import { readFileSync } from "node:fs";
import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

// No provider request, model invocation, or task mutation is made by this probe.
// Keep capability URLs out of both errors and the JSON returned to an agent.
export async function readControlActivity({
  threadId,
  fetchImpl = globalThis.fetch,
  readCallerSecret = () => readFileSync(CALLER_SECRET_PATH, "utf8"),
  routerPort = PORTS.router,
  timeoutMs = 3_000,
} = {}) {
  const unavailable = (error) => ({ ok: false, state: "unknown", error });
  if (threadId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(threadId)) {
    return unavailable("Invalid thread ID.");
  }
  let callerSecret;
  try { callerSecret = assertCallerSecret(readCallerSecret().trim()); }
  catch { return unavailable("The local router caller key is unavailable."); }
  try {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const response = await fetchImpl(`${callerBaseUrl(routerPort, callerSecret)}/activity${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return unavailable("Router activity is unavailable; the router may need updating.");
    const body = await response.json();
    if (body?.version !== 1 || !Array.isArray(body.active) || !Array.isArray(body.recent)) {
      return unavailable("Router activity returned an unsupported response.");
    }
    return {
      ok: true,
      version: 1,
      instanceId: body.instanceId,
      observedAt: body.observedAt,
      observationPoint: "router_upstream",
      active: body.active.map(safeRecord),
      recent: body.recent.map(safeRecord),
    };
  } catch {
    return unavailable("Router activity could not be read.");
  }
}

function safeRecord(record) {
  const result = {};
  if (!record || typeof record !== "object") return result;
  for (const key of ["requestId", "state", "phase", "provider", "model", "threadId", "parentThreadId", "sessionId", "agentName", "cancelReason", "terminalEvent", "terminalStatus", "observationPoint"]) {
    if (typeof record[key] === "string" && record[key].length <= 160) result[key] = record[key];
  }
  for (const key of ["startedAt", "endedAt", "status", "upstreamAttempts", "receivedBytes", "receivedEvents", "lastHeadersAt", "lastEventAt", "lastByteAt", "cancelRequestedAt"]) {
    if (Number.isFinite(record[key]) && record[key] >= 0) result[key] = record[key];
  }
  if (typeof record.isSubagent === "boolean") result.isSubagent = record.isSubagent;
  return result;
}
