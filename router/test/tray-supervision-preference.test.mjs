import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { trayRebuildPlan } from "../src/install-plan.mjs";
import {
  automaticTraySupervisionAllowed,
  readTraySupervisionPreference,
  setTraySupervisionPreference,
  traySupervisionPreferencePath,
} from "../src/tray-supervision-preference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "tray-supervision-"));
}

test("tray supervision preference is private, explicit, and fail closed", () => {
  const temporary = scratch();
  const file = path.join(temporary, "state", "tray-supervision.json");
  try {
    assert.deepEqual(readTraySupervisionPreference({ file }), { state: "unset", enabled: null });
    assert.equal(automaticTraySupervisionAllowed(readTraySupervisionPreference({ file })), true);

    setTraySupervisionPreference(false, { file });
    assert.deepEqual(readTraySupervisionPreference({ file }), { state: "disabled", enabled: false });
    assert.equal(automaticTraySupervisionAllowed(readTraySupervisionPreference({ file })), false);
    // Windows privacy is enforced with an owner-only ACL; its stat mode does
    // not expose POSIX chmod bits. The file-security suite verifies that ACL.
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, enabled: false });

    setTraySupervisionPreference(true, { file });
    assert.deepEqual(readTraySupervisionPreference({ file }), { state: "enabled", enabled: true });
    assert.equal(automaticTraySupervisionAllowed(readTraySupervisionPreference({ file })), true);

    writeFileSync(file, "{ damaged\n", { encoding: "utf8", mode: 0o600 });
    assert.deepEqual(readTraySupervisionPreference({ file }), { state: "invalid", enabled: null });
    assert.equal(automaticTraySupervisionAllowed(readTraySupervisionPreference({ file })), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("tray supervision preference follows the shared state-directory aliases", () => {
  const home = path.join(path.sep, "Users", "example");
  assert.equal(
    traySupervisionPreferencePath({ home, environment: {} }),
    path.join(home, ".codex", "codex-router", "tray-supervision.json"),
  );
  assert.equal(
    traySupervisionPreferencePath({
      home,
      environment: { CODEX_ROUTER_STATE_DIR: path.join(home, "router-state") },
    }),
    path.join(home, "router-state", "tray-supervision.json"),
  );
});

test("automatic macOS rebuild planning preserves disable and invalid markers", () => {
  const fakeRoot = scratch();
  const home = scratch();
  try {
    assert.equal(
      trayRebuildPlan({
        root: fakeRoot,
        platform: "darwin",
        home,
        supervisionPreference: { state: "disabled", enabled: false },
      }),
      "disabled",
    );
    assert.equal(
      trayRebuildPlan({
        root: fakeRoot,
        platform: "darwin",
        home,
        supervisionPreference: { state: "invalid", enabled: null },
      }),
      "unavailable",
    );
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("macOS enable and disable commands persist intent before launchd changes", () => {
  const service = readFileSync(path.join(root, "src", "tray-service-macos.mjs"), "utf8");
  const install = service.slice(service.indexOf('command === "install"'), service.indexOf('command === "uninstall"'));
  const uninstall = service.slice(service.indexOf('command === "uninstall"'), service.indexOf('command === "stop"'));
  assert.ok(
    install.indexOf("setTraySupervisionPreference(true)") < install.indexOf("bootout()"),
    "enable intent must survive a later bootstrap failure",
  );
  assert.ok(
    uninstall.indexOf("setTraySupervisionPreference(false)") < uninstall.indexOf("bootout()"),
    "disable intent must survive an interrupted stop",
  );
  assert.match(service, /supervisionPreference: preference\.state/);

  const installer = readFileSync(path.join(root, "bin", "install"), "utf8");
  assert.match(installer, /disabled\)[\s\S]*explicitly disabled; leaving it disabled/);
  assert.match(installer, /unavailable\)[\s\S]*preference is unreadable; leaving the companion untouched/);
});
