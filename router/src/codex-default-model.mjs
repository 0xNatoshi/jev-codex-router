import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { CODEX_DEFAULT_MODEL_PATH } from "./paths.mjs";

// This is intentionally a small claim over Codex's `model` setting, not a
// second Codex configuration file. The first pre-router value is retained so
// disabling the opt-in returns the user to exactly that default.
export function readCodexRouterDefault() {
  if (!existsSync(CODEX_DEFAULT_MODEL_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_DEFAULT_MODEL_PATH, "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.model !== "string" ||
      !parsed.model.trim() ||
      typeof parsed.previousPresent !== "boolean" ||
      (parsed.previousPresent && typeof parsed.previousModel !== "string")
    ) {
      throw new Error("invalid state");
    }
    return {
      version: 1,
      model: parsed.model,
      previousPresent: parsed.previousPresent,
      ...(parsed.previousPresent ? { previousModel: parsed.previousModel } : {}),
    };
  } catch {
    throw new Error(`Invalid Codex router default state at ${CODEX_DEFAULT_MODEL_PATH}.`);
  }
}

export function writeCodexRouterDefault(state) {
  const value = {
    version: 1,
    model: String(state?.model || "").trim(),
    previousPresent: state?.previousPresent === true,
    ...(state?.previousPresent ? { previousModel: state.previousModel } : {}),
  };
  if (!value.model || (value.previousPresent && typeof value.previousModel !== "string")) {
    throw new Error("Invalid Codex router default state.");
  }
  mkdirSync(path.dirname(CODEX_DEFAULT_MODEL_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CODEX_DEFAULT_MODEL_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CODEX_DEFAULT_MODEL_PATH);
    protectPrivateFile(CODEX_DEFAULT_MODEL_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function clearCodexRouterDefault() {
  if (existsSync(CODEX_DEFAULT_MODEL_PATH)) unlinkSync(CODEX_DEFAULT_MODEL_PATH);
}

export function codexRouterDefaultSnapshot() {
  const state = readCodexRouterDefault();
  return {
    managed: Boolean(state),
    ...(state ? { model: state.model } : {}),
    path: CODEX_DEFAULT_MODEL_PATH,
  };
}
