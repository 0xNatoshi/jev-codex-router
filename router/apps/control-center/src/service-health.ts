import type { RouterHealth, RouterServiceHealth } from "./types";

export type ServiceHealthState = "ready" | "degraded" | "offline" | "standby" | "unknown";
export type ServiceHealthTone = "success" | "warning" | "danger" | "neutral";

export interface ServiceHealthRow {
  id: string;
  label: string;
  state: ServiceHealthState;
  status: string;
  detail: string;
  tone: ServiceHealthTone;
}

// Which forwarders the router can report on. The labels live here so the row
// order and the wording cannot drift from the keys `printHealth` projects.
const FORWARDERS = [
  ["oauth", "OAuth forwarder"],
  ["api", "API forwarder"],
  ["grokOauth", "Grok OAuth forwarder"],
] as const;

function dependencyRow(
  id: string,
  label: string,
  service: RouterServiceHealth | undefined,
  degraded: Set<string>,
  routerOk?: boolean,
): ServiceHealthRow {
  if (!service) {
    const offline = degraded.has(id);
    // An absent per-service payload is not the same as no information. A
    // router that reported `ok` has already probed every dependency it knows
    // about, so an id missing from `degraded` is reachable -- rendering it as
    // Unknown made a healthy install look like it had never answered.
    if (!offline && routerOk === true) {
      return { id, label, state: "ready", status: "Ready", detail: "Reachable", tone: "success" };
    }
    return {
      id,
      label,
      state: offline ? "offline" : "unknown",
      status: offline ? "Offline" : "Unknown",
      detail: offline ? "Unreachable" : "Waiting for health report",
      tone: offline ? "danger" : "neutral",
    };
  }
  if (service.enabled === false && !degraded.has(id)) {
    return { id, label, state: "standby", status: "Standby", detail: "Not enabled", tone: "neutral" };
  }
  if (service.reachable !== true || degraded.has(id)) {
    return {
      id,
      label,
      state: service.reachable === false || degraded.has(id) ? "offline" : "unknown",
      status: service.reachable === false || degraded.has(id) ? "Offline" : "Unknown",
      detail: service.reachable === false || degraded.has(id) ? "Unreachable" : "Waiting for health report",
      tone: service.reachable === false || degraded.has(id) ? "danger" : "neutral",
    };
  }
  return { id, label, state: "ready", status: "Ready", detail: "Reachable", tone: "success" };
}

export function serviceHealthRows(health?: RouterHealth): ServiceHealthRow[] {
  const degraded = new Set((health?.degraded ?? []).map(String));
  const hasHealth = Boolean(health);
  const routerOk = health?.ok;
  const rows: ServiceHealthRow[] = [{
    id: "router",
    label: "Router",
    state: !hasHealth ? "unknown" : routerOk ? "ready" : degraded.size ? "degraded" : "offline",
    status: !hasHealth ? "Unknown" : routerOk ? "Ready" : degraded.size ? "Degraded" : "Offline",
    detail: !hasHealth
      ? "Waiting for health report"
      : routerOk
        ? "Serving locally"
        : degraded.size
          ? `${degraded.size} ${degraded.size === 1 ? "dependency needs" : "dependencies need"} attention`
          : health?.error || "Health endpoint unavailable",
    tone: !hasHealth ? "neutral" : routerOk ? "success" : degraded.size ? "warning" : "danger",
  }];

  rows.push(dependencyRow("gateway", "Gateway", health?.gateway, degraded, routerOk));

  const forwarders = FORWARDERS.filter(([id]) => health?.[id] || degraded.has(id));
  for (const [id, label] of forwarders) {
    rows.push(dependencyRow(id, label, health?.[id], degraded, routerOk));
  }
  if (!forwarders.length) {
    rows.push({
      id: "forwarders",
      label: "External forwarders",
      state: hasHealth ? "standby" : "unknown",
      status: hasHealth ? "Standby" : "Unknown",
      detail: hasHealth ? "No external forwarders enabled" : "Waiting for health report",
      tone: "neutral",
    });
  }
  return rows;
}
