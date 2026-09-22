import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import {
  PORTS,
  SERVICE_PROCESS_STATE_PATH,
  SOURCE_ROOT,
  STATE_DIR,
} from "./paths.mjs";
import { processCommandLine, processStartIdentity } from "./process-identity.mjs";

const STATE_VERSION = 1;

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function entrypointFor(sourceRoot) {
  return normalized(path.join(sourceRoot, "src", "start.mjs"));
}

function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function buildServiceProcessState({
  pid = process.pid,
  platform = process.platform,
  identity = processStartIdentity,
  commandLine = processCommandLine,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  ports = PORTS,
} = {}) {
  const safe = safePid(pid);
  if (!safe) return undefined;
  const processIdentity = identity(safe, { platform });
  const liveCommandLine = commandLine(safe, { platform });
  if (!processIdentity || !liveCommandLine) return undefined;
  const entrypoint = entrypointFor(sourceRoot);
  if (!normalized(liveCommandLine).includes(entrypoint)) return undefined;
  return {
    version: STATE_VERSION,
    managed: true,
    pid: safe,
    processIdentity: String(processIdentity),
    commandLine: String(liveCommandLine),
    sourceRoot: path.resolve(sourceRoot),
    stateDir: path.resolve(stateDir),
    ports: Object.fromEntries(
      Object.entries(ports || {})
        .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
        .map(([name, value]) => [name, value]),
    ),
    startedAt: Date.now(),
  };
}

export function writeServiceProcessState(options = {}) {
  const state = buildServiceProcessState(options);
  if (!state) {
    throw new Error(
      "The Windows service could not verify its own start.mjs process identity; refusing to run without a stoppable process record.",
    );
  }
  writePrivateJson(options.statePath || SERVICE_PROCESS_STATE_PATH, state);
  return state;
}

export function readServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.version === STATE_VERSION && state?.managed === true ? state : undefined;
  } catch {
    return undefined;
  }
}

export function clearServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function serviceProcessOwns(
  state,
  {
    platform = process.platform,
    identity = processStartIdentity,
    commandLine = processCommandLine,
    sourceRoot = SOURCE_ROOT,
    stateDir = STATE_DIR,
  } = {},
) {
  const pid = safePid(state?.pid);
  if (
    !state ||
    state.version !== STATE_VERSION ||
    state.managed !== true ||
    !pid ||
    typeof state.processIdentity !== "string" ||
    !state.processIdentity ||
    typeof state.commandLine !== "string" ||
    !state.commandLine ||
    typeof state.sourceRoot !== "string" ||
    !state.sourceRoot ||
    typeof state.stateDir !== "string" ||
    !state.stateDir
  ) {
    return false;
  }
  // The record lives in a user-writable state directory. Require both path
  // anchors to still be this installation before a PID can be terminated; a
  // hand-edited record for another checkout must never become a kill switch.
  if (
    normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot)) ||
    normalized(state.stateDir) !== normalized(path.resolve(stateDir))
  ) {
    return false;
  }
  const entrypoint = entrypointFor(state.sourceRoot);
  if (!normalized(state.commandLine).includes(entrypoint)) return false;
  if (identity(pid, { platform }) !== state.processIdentity) return false;
  const liveCommandLine = commandLine(pid, { platform });
  return Boolean(liveCommandLine && normalized(liveCommandLine).includes(entrypoint));
}
