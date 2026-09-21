import { readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";

// Persist only the Router opt-in, never hook commands or trust. Native Codex
// still owns installation, discovery, validation and authorization of hooks.
export function serviceGrokPatchHookEnvironment({ environment = process.env, stateDir = STATE_DIR } = {}) {
  if (Object.hasOwn(environment, "CODEX_ROUTER_GROK_PATCH_HOOK")) {
    return { CODEX_ROUTER_GROK_PATCH_HOOK: environment.CODEX_ROUTER_GROK_PATCH_HOOK === "1" ? "1" : "0" };
  }
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "grok-patch-hook.json"), "utf8"));
    if (value?.version === 1 && value.enabled === true && Object.keys(value).length === 2) {
      return { CODEX_ROUTER_GROK_PATCH_HOOK: "1" };
    }
  } catch {
    // Missing or invalid opt-in cannot enable the experiment.
  }
  return {};
}
