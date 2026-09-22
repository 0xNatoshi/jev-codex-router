import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";

export const TRAY_SUPERVISION_PREFERENCE_VERSION = 1;
const MAX_PREFERENCE_BYTES = 4_096;

export function traySupervisionPreferencePath({
  environment = process.env,
  home = os.homedir(),
} = {}) {
  const codexHome = environment.CODEX_HOME || path.join(home, ".codex");
  const stateDirectory = environment.MODEL_ROUTER_STATE_DIR
    || environment.CODEX_ROUTER_STATE_DIR
    || environment.KIMI_CODEX_STATE_DIR
    || path.join(codexHome, "codex-router");
  return path.join(stateDirectory, "tray-supervision.json");
}

export function readTraySupervisionPreference({
  file = traySupervisionPreferencePath(),
} = {}) {
  if (!existsSync(file)) return Object.freeze({ state: "unset", enabled: null });
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PREFERENCE_BYTES) {
      return Object.freeze({ state: "invalid", enabled: null });
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      parsed?.version !== TRAY_SUPERVISION_PREFERENCE_VERSION
      || typeof parsed.enabled !== "boolean"
    ) {
      return Object.freeze({ state: "invalid", enabled: null });
    }
    return Object.freeze({
      state: parsed.enabled ? "enabled" : "disabled",
      enabled: parsed.enabled,
    });
  } catch {
    // An unreadable or damaged preference must never be interpreted as consent
    // to resurrect a tray the user may have explicitly disabled.
    return Object.freeze({ state: "invalid", enabled: null });
  }
}

export function automaticTraySupervisionAllowed(preference) {
  const resolved = preference ?? readTraySupervisionPreference();
  return resolved?.state === "unset" || resolved?.state === "enabled";
}

export function setTraySupervisionPreference(enabled, {
  file = traySupervisionPreferencePath(),
} = {}) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("The tray supervision preference must be a boolean.");
  }
  writePrivateJson(file, {
    version: TRAY_SUPERVISION_PREFERENCE_VERSION,
    enabled,
  });
  return Object.freeze({ state: enabled ? "enabled" : "disabled", enabled });
}
