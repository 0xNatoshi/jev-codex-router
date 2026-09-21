import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callerCapabilityBackupPath,
  discardCallerCapabilityBackup,
  restoreCallerCapability,
  swapCallerCapability,
} from "../src/caller-key-rotation.mjs";

const oldKey = "o".repeat(48);
const newKey = "n".repeat(48);
const operationId = "a".repeat(32);

async function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-caller-rotation-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try { return await run({ directory, secretPath }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("caller capability swap keeps one protected rollback generation until commit", async () => {
  await fixture(async ({ directory, secretPath }) => {
    const result = swapCallerCapability({
      secretPath, operationId, generateSecret: () => newKey, protect: () => {},
    });
    assert.equal(result.previousSecret, oldKey);
    assert.equal(result.currentSecret, newKey);
    assert.equal(readFileSync(secretPath, "utf8").trim(), newKey);
    assert.equal(readFileSync(callerCapabilityBackupPath(secretPath, operationId), "utf8").trim(), oldKey);
    assert.equal(discardCallerCapabilityBackup({ secretPath, operationId }), true);
    assert.deepEqual(readdirSync(directory), ["caller-secret"]);
  });
});

test("caller capability restore returns to the exact prior generation", async () => {
  await fixture(async ({ directory, secretPath }) => {
    swapCallerCapability({ secretPath, operationId, generateSecret: () => newKey, protect: () => {} });
    const result = restoreCallerCapability({ secretPath, operationId, protect: () => {} });
    assert.equal(result.restored, true);
    assert.equal(result.currentSecret, oldKey);
    assert.equal(result.displacedSecret, newKey);
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
    assert.deepEqual(readdirSync(directory), ["caller-secret"]);
  });
});

test("ACL protection failure before commit restores the old live capability", async () => {
  await fixture(async ({ directory, secretPath }) => {
    let calls = 0;
    assert.throws(() => swapCallerCapability({
      secretPath, operationId, generateSecret: () => newKey,
      protect: () => { calls += 1; if (calls === 3) throw new Error("acl failed"); },
    }), /acl failed/);
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
    assert.deepEqual(readdirSync(directory), ["caller-secret"]);
  });
});

test("an existing rollback generation is never overwritten", async () => {
  await fixture(async ({ secretPath }) => {
    const backup = callerCapabilityBackupPath(secretPath, operationId);
    writeFileSync(backup, `${"x".repeat(48)}\n`, { mode: 0o600 });
    assert.throws(() => swapCallerCapability({
      secretPath, operationId, generateSecret: () => newKey, protect: () => {},
    }), /generation already exists/i);
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
    assert.equal(readFileSync(backup, "utf8").trim(), "x".repeat(48));
  });
});

test("rollback protection failure preserves both live and rollback generations", async () => {
  assert.equal(typeof restoreCallerCapability, "function");
  await fixture(async ({ directory, secretPath }) => {
    const operationId = "f".repeat(32);
    swapCallerCapability({ secretPath, operationId, generateSecret: () => "n".repeat(48), protect: () => {} });
    const backupPath = callerCapabilityBackupPath(secretPath, operationId);
    let failed = false;
    await assert.rejects(async () => restoreCallerCapability({
      secretPath, operationId, protect: (target) => {
        if (!failed && target === secretPath) { failed = true; throw new Error("ACL restore failed"); }
      },
    }), /ACL restore failed/);
    assert.equal(readFileSync(secretPath, "utf8").trim(), "n".repeat(48));
    assert.equal(readFileSync(backupPath, "utf8").trim(), "o".repeat(48));
    assert.deepEqual(readdirSync(directory).sort(), ["caller-secret", `caller-secret.rotate-rollback.${operationId}`]);
  });
});
