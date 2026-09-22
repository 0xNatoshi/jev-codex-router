import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildServiceProcessState,
  clearServiceProcessState,
  serviceProcessOwns,
  writeServiceProcessState,
} from "../src/service-process.mjs";

const root = path.join(os.tmpdir(), "codex-router-checkout");
const stateDir = path.join(os.tmpdir(), "codex-router-service-state");

function identity() {
  return "2026-08-18T00:00:00Z|node.exe";
}

function commandLine() {
  return `node "${root}/src/start.mjs"`;
}

test("service process state requires the router start.mjs command line", () => {
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
    ports: { router: 4202, api: 4203 },
  });
  assert.equal(state.pid, 4242);
  assert.equal(state.managed, true);
  assert.deepEqual(state.ports, { router: 4202, api: 4203 });
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
    }),
    true,
  );
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    false,
  );
  assert.equal(
    buildServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    undefined,
  );
});

test("service process state is private, readable, and removable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-state-"));
  const statePath = path.join(directory, "service-process.json");
  try {
    const state = writeServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
      statePath,
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).pid, state.pid);
    clearServiceProcessState(statePath);
    assert.throws(() => readFileSync(statePath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
