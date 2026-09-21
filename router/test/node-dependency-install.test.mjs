import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureNodeDependencies,
  nodeDependencyInstallDeadline,
} from "../src/node-dependency-install.mjs";

test("ordinary node dependency installs receive a finite capped deadline", () => {
  const before = Date.now();
  const deadline = nodeDependencyInstallDeadline(undefined, {
    CODEX_ROUTER_OPERATION_TIMEOUT_MS: String(24 * 60 * 60_000),
  });
  assert.ok(Number.isSafeInteger(deadline));
  assert.ok(deadline >= before);
  assert.ok(deadline <= Date.now() + 10 * 60_000);
});

test("node dependency installs preserve an earlier inherited deadline", () => {
  const inherited = Date.now() + 30_000;
  assert.equal(
    nodeDependencyInstallDeadline(undefined, {
      CODEX_ROUTER_OPERATION_DEADLINE_MS: String(inherited),
    }),
    inherited,
  );
  assert.equal(nodeDependencyInstallDeadline(inherited, {}), inherited);
});

test("ensureNodeDependencies hands npm the finite ordinary deadline", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-node-deadline-"));
  let invocation;
  try {
    writeFileSync(path.join(root, "package-lock.json"), "{}\n", { mode: 0o600 });
    const before = Date.now();
    const result = await ensureNodeDependencies({
      root,
      env: { ...process.env },
      run: async (command, args, options) => {
        invocation = { command, args, options };
        mkdirSync(path.join(root, "node_modules"), { recursive: true });
        writeFileSync(path.join(root, "node_modules", ".package-lock.json"), "{}\n");
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });
    assert.equal(result, "installed");
    if (process.platform === "win32") {
      assert.equal(path.basename(invocation.command).toLowerCase(), "cmd.exe");
      assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(invocation.args[3], /^".*[\\/]npm\.cmd ci --omit=dev"$/i);
      assert.equal(invocation.options.windowsVerbatimArguments, true);
    } else {
      assert.deepEqual(invocation.args, ["ci", "--omit=dev"]);
      assert.equal(invocation.options.windowsVerbatimArguments, false);
    }
    assert.ok(invocation.options.deadline >= before);
    assert.ok(invocation.options.deadline <= Date.now() + 10 * 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
