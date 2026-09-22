import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

// Latest observed rate-limit snapshot per provider, refreshed from response
// headers as traffic flows. Unlike usage-events.jsonl this is a small
// last-write-wins document, because only the current window matters.

export const RATE_LIMITS_PATH = path.join(STATE_DIR, "rate-limits.json");

const MAX_PROVIDERS = 64;

function readDocument() {
  if (!existsSync(RATE_LIMITS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(RATE_LIMITS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt file must never take routing down; it is rebuilt from the next
    // response that carries headers.
    return {};
  }
}

export function recordRateLimitSnapshot(providerId, snapshot, { at = Date.now() } = {}) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  if (!id || !snapshot) return;
  try {
    const document = readDocument();
    document[id] = { ...snapshot, observedAt: new Date(at).toISOString() };
    const entries = Object.entries(document)
      .sort((left, right) => String(right[1]?.observedAt).localeCompare(String(left[1]?.observedAt)))
      .slice(0, MAX_PROVIDERS);
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${RATE_LIMITS_PATH}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, RATE_LIMITS_PATH);
    chmodSync(RATE_LIMITS_PATH, 0o600);
  } catch {
    // Rate-limit telemetry must never interrupt or fail a model request.
  }
}

export function readRateLimitSnapshots() {
  return readDocument();
}

export function rateLimitSnapshotFor(providerId) {
  return readDocument()[String(providerId || "").trim()];
}
