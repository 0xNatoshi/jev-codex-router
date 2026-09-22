import { renameSync, statSync } from "node:fs";

// The router and the gateway share one append-only file, and nothing ever
// trimmed it. The gateway logs an access line for every `/health/liveliness`
// probe, and the companion polls the router's health continuously, so an idle
// machine still wrote roughly a line a second: one observed log had reached
// 191 MB across 2.9 million lines, the overwhelming majority of them probes.
// A crash loop under launchd's KeepAlive adds to the same file at whatever
// rate the process restarts.
//
// Rotation happens at startup rather than on a timer: the writers hold the
// file open for the life of the service, so renaming underneath them would
// leave them appending to an unlinked inode until the next restart.
export const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024;

export function logRotationPlan(sizeBytes, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "keep";
  return sizeBytes > maxBytes ? "rotate" : "keep";
}

// Keeps exactly one previous generation. Two files bound the worst case at
// 2x the cap, and the older one is what you still want when a service dies at
// startup and the fresh log only holds the successful retry.
export function rotateLog(logPath, { maxBytes = DEFAULT_MAX_LOG_BYTES } = {}) {
  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    return { rotated: false, reason: "absent" };
  }
  if (logRotationPlan(size, maxBytes) === "keep") {
    return { rotated: false, reason: "under-cap", size };
  }
  const previous = `${logPath}.1`;
  try {
    // rename replaces an existing destination atomically on both POSIX and
    // Windows. Unlinking first would add a window where neither generation
    // exists if the rename then failed, for no benefit.
    renameSync(logPath, previous);
    return { rotated: true, size, previous };
  } catch (error) {
    // Never let housekeeping stop the service from starting.
    return { rotated: false, reason: "failed", size, error: String(error) };
  }
}
