import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kimiOAuthHealth } from "../src/oauth-status.mjs";

function withCredentialsFile(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-health-"));
  const credentialsPath = path.join(dir, "credentials", "kimi-code.json");
  if (contents !== undefined) {
    mkdirSync(path.dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, contents, { mode: 0o600 });
  }
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = dir;
  try {
    return run(credentialsPath);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function futureSeconds() {
  return Math.floor(Date.now() / 1000) + 3600;
}

test("health is ok for a live credential", () => {
  const health = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: futureSeconds(),
      expires_in: 3600,
      scope: "kimi-code",
    }),
    () => kimiOAuthHealth(),
  );
  assert.equal(health.status, "ok");
  assert.match(health.detail, /credential present/);
});

test("health is stale, not failed, for an expired access token", () => {
  // An expired access token is a normal state: ensureFreshKimiOAuthToken()
  // refreshes it with the still-valid refresh token before forwarding, so the
  // diagnosis must not tell the operator to re-login.
  const health = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: futureSeconds() - 7200,
      expires_in: 3600,
    }),
    () => kimiOAuthHealth(),
  );
  assert.equal(health.status, "stale");
  assert.match(health.detail, /refreshes automatically/);
  assert.match(health.fix, /No action needed/);
});

test("health is revoked for a rejected session tombstone", () => {
  const health = withCredentialsFile(
    JSON.stringify({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      expires_in: 0,
    }),
    () => kimiOAuthHealth(),
  );
  assert.equal(health.status, "revoked");
  assert.match(health.fix, /kimi login/);
});

test("health is missing when the credential file does not exist", () => {
  const health = withCredentialsFile(undefined, () => kimiOAuthHealth());
  assert.equal(health.status, "missing");
  assert.match(health.fix, /kimi login/);
});

test("health is incomplete when tokens are missing", () => {
  const health = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      expires_at: futureSeconds(),
      expires_in: 3600,
    }),
    () => kimiOAuthHealth(),
  );
  assert.equal(health.status, "incomplete");
  assert.match(health.fix, /kimi login/);
});

test("health is incomplete when expiry metadata is not finite seconds", () => {
  for (const value of [
    { access_token: "a", refresh_token: "r", expires_at: "not-a-number", expires_in: 3600 },
    { access_token: "a", refresh_token: "r", expires_at: futureSeconds() },
  ]) {
    const health = withCredentialsFile(JSON.stringify(value), () => kimiOAuthHealth());
    assert.equal(health.status, "incomplete", JSON.stringify(value));
    assert.match(health.fix, /kimi login/);
  }
});

test("health is invalid when the credential file is not JSON", () => {
  const health = withCredentialsFile("{ not json", () => kimiOAuthHealth());
  assert.equal(health.status, "invalid");
  assert.match(health.fix, /kimi login/);
});
