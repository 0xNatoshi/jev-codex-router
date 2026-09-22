import { realpathSync } from "node:fs";
import path from "node:path";

import { readInstallManifest } from "./install-manifest.mjs";
import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";

// One state directory is owned by exactly one checkout. A second checkout can
// still read it, but writing the generated catalog or gateway config from there
// silently desynchronizes the two: the running service keeps serving routes
// from its own registry while Codex is handed a catalog built from a different
// one, so the picker advertises models the gateway cannot route.
//
// `bin/install` is the sanctioned ownership transfer and sets the override
// below, because it regenerates state before recording the new owner.
const OVERRIDE_ENV = "MODEL_ROUTER_ALLOW_FOREIGN_STATE";

function canonical(directory) {
  if (typeof directory !== "string" || !directory) return undefined;
  const resolved = path.resolve(directory);
  try {
    return realpathSync(resolved);
  } catch {
    // A recorded root that no longer exists still compares usefully as a path.
    return resolved;
  }
}

export function stateOwnershipStatus() {
  const current = canonical(SOURCE_ROOT);
  const recorded = readInstallManifest()?.current?.sourceRoot;
  const owner = canonical(recorded);
  return {
    stateDir: STATE_DIR,
    current,
    owner,
    // Unowned state (a fresh or hand-made directory) belongs to whoever writes
    // it first; only a recorded, different owner is a conflict.
    foreign: Boolean(owner && current && owner !== current),
    overridden: process.env[OVERRIDE_ENV] === "1",
  };
}

export function stateOwnershipMessage(operation, status) {
  return [
    `Refusing to ${operation}: ${status.stateDir} is owned by another checkout.`,
    `  owner:   ${status.owner}`,
    `  current: ${status.current}`,
    "Writing generated state from a second checkout makes Codex advertise",
    "models the running gateway cannot route. Run `./bin/model-router codex",
    "doctor --fix` from this checkout; when the recorded owner is available,",
    "repair runs there without changing ownership. To deliberately transfer",
    `ownership to this checkout, reinstall from here or set ${OVERRIDE_ENV}=1.`,
  ].join("\n");
}

export function assertStateOwnership(operation) {
  const status = stateOwnershipStatus();
  if (!status.foreign || status.overridden) return status;
  const error = new Error(stateOwnershipMessage(operation, status));
  error.code = "foreign_state_owner";
  throw error;
}
