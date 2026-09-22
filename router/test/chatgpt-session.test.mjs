import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-session-command-"));
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authPath = path.join(root, "codex", "auth.json");
process.env.MODEL_ROUTER_CODEX_AUTH = authPath;
process.env.MODEL_ROUTER_STATE_DIR = path.join(root, "state");
process.env.CODEX_HOME = path.join(root, "codex");
delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;

const { setChatGptSessionSharing } = await import("../src/chatgpt-session.mjs");
const { nativeSessionAvailable, nativeSessionStatus } = await import(
  "../src/codex-native-session.mjs"
);

function writeAuth() {
  mkdirSync(path.dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "test-access", account_id: "test-account" },
    }),
    { encoding: "utf8", flag: "w" },
  );
}

test("enable requires the user's own Codex login", async () => {
  await assert.rejects(setChatGptSessionSharing(true), /codex login/i);
  assert.equal(nativeSessionStatus().sharingEnabled, false);
});

test("one authorization applies to the shared local router plane and can be revoked", async () => {
  writeAuth();
  const enabled = await setChatGptSessionSharing(true);
  assert.deepEqual(
    { sharing: enabled.sharing, session: enabled.session, refreshed: enabled.refreshed },
    { sharing: "enabled", session: "usable", refreshed: false },
  );
  assert.equal(nativeSessionAvailable(), true);

  const disabled = await setChatGptSessionSharing(false);
  assert.equal(disabled.sharing, "disabled");
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionStatus().usable, true, "revocation does not sign Codex out");
});

test("the command does not pretend to override an operator environment policy", async () => {
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "0";
  await assert.rejects(
    setChatGptSessionSharing(true),
    /forced off by CODEX_ROUTER_NATIVE_SESSION_FALLBACK/,
  );

  delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  await setChatGptSessionSharing(true);
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "1";
  await assert.rejects(
    setChatGptSessionSharing(false),
    /forces ChatGPT session sharing on/,
  );
  assert.equal(nativeSessionStatus().sharingEnabled, true);
  delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  assert.equal(
    nativeSessionStatus().sharingEnabled,
    true,
    "the saved authorization remains coherent until disable can republish",
  );
  await setChatGptSessionSharing(false);
  assert.equal(nativeSessionStatus().sharingEnabled, false);
});

test(
  "both POSIX dispatchers expose the safe status command",
  { skip: process.platform === "win32" ? "POSIX dispatchers are not the Windows entry point" : false },
  () => {
    for (const invocation of [
      [path.join(checkoutRoot, "bin", "model-router"), "codex", "chatgpt-session"],
      [path.join(checkoutRoot, "bin", "codex-router"), "chatgpt-session"],
    ]) {
      const result = spawnSync(invocation[0], [...invocation.slice(1), "status", "--json"], {
        encoding: "utf8",
        env: process.env,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        sharing: "disabled",
        session: "usable",
        present: true,
      });
      assert.doesNotMatch(result.stdout, /test-access|test-account/);
    }
  },
);

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
