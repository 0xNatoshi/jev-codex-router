import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = path.join(root, "src", "caller-key-auth-command.mjs");
const callerKey = "test-command-caller-capability-with-sufficient-length";

test("Codex auth command reads the protected caller key without embedding it in config", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caller-key-auth-command-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${callerKey}\n`, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [command, secretPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), callerKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
