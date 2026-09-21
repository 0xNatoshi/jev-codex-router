import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-redirect-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  NATIVE_REDIRECT_PATH,
  clearNativeRedirect,
  nativeRedirectSnapshot,
  readNativeRedirect,
  setNativeRedirect,
} = await import("../src/native-redirect.mjs");

test("native redirect defaults to unset", () => {
  assert.equal(readNativeRedirect(), undefined);
  assert.deepEqual(nativeRedirectSnapshot(), { model: null, path: NATIVE_REDIRECT_PATH });
});

test("native redirect round-trips through protected state", () => {
  assert.deepEqual(setNativeRedirect("grok-oauth/grok-4.5"), {
    model: "grok-oauth/grok-4.5",
    path: NATIVE_REDIRECT_PATH,
  });
  assert.equal(readNativeRedirect(), "grok-oauth/grok-4.5");
  assert.equal(privateFileIsProtected(NATIVE_REDIRECT_PATH), true);
  // Windows protects private files with ACLs, not POSIX modes.
  if (process.platform !== "win32") {
    assert.equal(statSync(NATIVE_REDIRECT_PATH).mode & 0o777, 0o600);
  }

  clearNativeRedirect();
  assert.equal(readNativeRedirect(), undefined);
});

test("native redirect rejects an empty slug", () => {
  assert.throws(() => setNativeRedirect(""), /routed model slug is required/);
  assert.throws(() => setNativeRedirect("   "), /routed model slug is required/);
});

test("native redirect ignores an unusable state file", () => {
  writeFileSync(NATIVE_REDIRECT_PATH, "{ not json", "utf8");
  assert.equal(readNativeRedirect(), undefined);

  writeFileSync(NATIVE_REDIRECT_PATH, JSON.stringify({ version: 2, model: "kimi-oauth/k3" }), "utf8");
  assert.equal(readNativeRedirect(), undefined);

  writeFileSync(NATIVE_REDIRECT_PATH, JSON.stringify({ version: 1, model: "  " }), "utf8");
  assert.equal(readNativeRedirect(), undefined);
  clearNativeRedirect();
});
