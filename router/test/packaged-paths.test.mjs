import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSourceRoot(value) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import("./src/paths.mjs").then(({ SOURCE_ROOT }) => console.log(SOURCE_ROOT))',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_SOURCE_ROOT: value },
    },
  );
}

test("a package manager can provide an absolute stable source root", () => {
  const stable = path.join(root, "stable", "codex-router", "libexec");
  const result = readSourceRoot(stable);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.normalize(stable));
});

test("a relative packaged source root is rejected", () => {
  const result = readSourceRoot("relative/libexec");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODEX_ROUTER_SOURCE_ROOT must be an absolute path/);
});
