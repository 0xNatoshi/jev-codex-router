import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  antigravityProbeActivationIsActive,
  antigravityProbeActivationState,
  antigravityProbeIsVerified,
  antigravityProbeStartupState,
  antigravityTokenPath,
  deactivateAntigravityProbeActivation,
  ensureFreshAntigravitySession,
  ensureFreshAntigravityToken,
  pendingAntigravityProbeActivation,
  promoteAntigravityProbeActivation,
  protectAntigravityToken,
  readAntigravityToken,
  removeAntigravityToken,
  saveAntigravityToken,
  setAntigravityTokenPathForTests,
  updateAntigravityToken,
  validateAntigravityToken,
} from "../src/antigravity-oauth-session.mjs";
import {
  antigravityOAuthHealth,
  antigravityOAuthStartupState,
  antigravityOAuthStatus,
} from "../src/antigravity-oauth-status.mjs";
import { writePrivateJson } from "../src/file-security.mjs";

const CLIENT = Object.freeze({
  client_id: "operator-owned.apps.googleusercontent.com",
  client_secret: "test-client-secret",
});
const PENDING_GENERATION = "11111111-1111-4111-8111-111111111111";
const STALE_GENERATION = "22222222-2222-4222-8222-222222222222";
const SUCCESSOR_REFRESH_OWNER = "33333333-3333-4333-8333-333333333333";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForFile(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target}`);
}

function startRefreshWorker(args) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "test", "fixtures", "antigravity-refresh-worker.mjs"), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, CODEX_ROUTER_NO_DISCOVERY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function finishWorker(worker) {
  const outcome = await waitForWorker(worker);
  assert.equal(outcome.code, 0, worker.stderr());
  return JSON.parse(worker.stdout());
}

async function waitForWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return { code: worker.child.exitCode, signal: worker.child.signalCode };
  }
  return new Promise((resolve, reject) => {
    worker.child.once("error", reject);
    worker.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function terminateWorker(worker) {
  if (!worker) return;
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGKILL");
  }
  await waitForWorker(worker).catch(() => {});
}

test("an inherited pending-pipe setting cannot crash a losing Windows lease bind", {
  skip: process.platform === "win32" ? false : "Windows named-pipe regression",
}, async () => {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "test", "fixtures", "antigravity-pipe-race.mjs")],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_PENDING_PIPE_INSTANCES: "32" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  assert.equal(stdout, "survived\n");
});

test("the router never inherits a vendor token-path variable", () => {
  const previousVendor = process.env.ANTIGRAVITY_TOKEN_PATH;
  const previousRouter = process.env.CODEX_ROUTER_ANTIGRAVITY_TOKEN_PATH;
  try {
    process.env.ANTIGRAVITY_TOKEN_PATH = path.join(os.tmpdir(), "official-ide-credential.json");
    delete process.env.CODEX_ROUTER_ANTIGRAVITY_TOKEN_PATH;
    assert.notEqual(antigravityTokenPath(), process.env.ANTIGRAVITY_TOKEN_PATH);
    const routerOwned = path.join(os.tmpdir(), "router-owned-antigravity.json");
    process.env.CODEX_ROUTER_ANTIGRAVITY_TOKEN_PATH = routerOwned;
    assert.notEqual(antigravityTokenPath(), routerOwned);
    setAntigravityTokenPathForTests(routerOwned);
    assert.equal(antigravityTokenPath(), routerOwned);
  } finally {
    if (previousVendor === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = previousVendor;
    if (previousRouter === undefined) delete process.env.CODEX_ROUTER_ANTIGRAVITY_TOKEN_PATH;
    else process.env.CODEX_ROUTER_ANTIGRAVITY_TOKEN_PATH = previousRouter;
    setAntigravityTokenPathForTests(undefined);
  }
});

test("refuses the previously bundled vendor OAuth client identity", () => {
  assert.throws(
    () => validateAntigravityToken({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client_id:
        "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      client_secret: "vendor-secret-must-not-be-used",
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    }),
    /operator-owned Google Desktop app client ID/,
  );
});

test("refuses an oversized regular credential before parsing it", async () => {
  await withToken(
    {
      access_token: "active",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      writeFileSync(tokenPath, `{"padding":"${"x".repeat(64 * 1024)}"}`, { mode: 0o600 });
      assert.throws(() => readAntigravityToken(), /could not be read safely/i);
    },
  );
});

async function withToken(token, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-oauth-"));
  const tokenPath = path.join(directory, "token.json");
  const write = (value) => writePrivateJson(
    tokenPath,
    {
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ...CLIENT,
      ...value,
    },
  );
  write(token);
  const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  setAntigravityTokenPathForTests(tokenPath);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  try {
    return await run(write, tokenPath);
  } finally {
    setAntigravityTokenPathForTests(undefined);
    if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a rejected OAuth client cannot be overwritten before explicit disconnect", async () => {
  await withToken(
    {
      project_revision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      expires_in: 0,
      rejection_reason: "invalid_client",
    },
    async (_write, tokenPath) => {
      const before = readFileSync(tokenPath, "utf8");
      await assert.rejects(
        saveAntigravityToken({
          ...CLIENT,
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_at: 2_000_000_000,
          expires_in: 3600,
        }),
        (error) =>
          error?.code === "oauth_unauthorized" &&
          error?.providerCode === "invalid_client" &&
          /rejected.*disconnect/i.test(error.message),
      );
      assert.equal(readFileSync(tokenPath, "utf8"), before);
    },
  );
});

test("keeps an active Antigravity token without refreshing", async () => {
  await withToken(
    {
      access_token: "active",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let refreshes = 0;
      const token = await ensureFreshAntigravityToken({
        now: () => 1_000_000_000_000,
        fetchImpl: async () => { refreshes += 1; throw new Error("should not run"); },
      });
      assert.equal(token, "active");
      assert.equal(refreshes, 0);
    },
  );
});

test("uses a fixed 60 second refresh window", async () => {
  const now = 1_700_000_000_000;
  await withToken(
    {
      access_token: "active",
      refresh_token: "refresh",
      expires_at: Math.floor(now / 1_000) + 120,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let refreshes = 0;
      const session = await ensureFreshAntigravitySession({
        now: () => now,
        fetchImpl: async () => { refreshes += 1; throw new Error("should not run"); },
      });
      assert.equal(session.access_token, "active");
      assert.equal(refreshes, 0);
    },
  );
});

test("rejects non-positive live-token expiry lifetimes", () => {
  assert.throws(
    () => validateAntigravityToken({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ...CLIENT,
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 0,
    }),
    /invalid expiry metadata/,
  );
});

test("rejects a malformed durable project revision", () => {
  assert.throws(
    () => validateAntigravityToken({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      project_revision: "not-a-revision",
      ...CLIENT,
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    }),
    /invalid project revision/,
  );
});

test("requires a complete project-bound live-proof tuple", () => {
  const proof = {
    probe_version: 1,
    probe_verified_at: 1_700_000_000_000,
    probe_model: "gemini-3.1-pro",
    project_id: "operator-project",
    project_source: "managed",
  };
  const base = {
    ...proof,
    probe_activation: {
      version: 1,
      state: "active",
      generation: PENDING_GENERATION,
    },
  };
  assert.equal(antigravityProbeIsVerified(base), true);
  assert.equal(antigravityProbeIsVerified(proof), false);
  for (const field of Object.keys(base)) {
    assert.equal(
      antigravityProbeIsVerified({ ...base, [field]: undefined }),
      false,
      `missing ${field} must fail closed`,
    );
  }
  assert.equal(antigravityProbeIsVerified({ ...base, probe_model: "different-model" }), false);
});

test("keeps a pending proof startup-only until the exact generation is promoted", async () => {
  await withToken(
    {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_700_000_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: pendingAntigravityProbeActivation(PENDING_GENERATION),
    },
    async () => {
      const pending = readAntigravityToken();
      assert.equal(antigravityProbeIsVerified(pending), false);
      assert.deepEqual(antigravityProbeActivationState(pending), {
        version: 1,
        state: "pending_activation",
        generation: PENDING_GENERATION,
      });
      assert.deepEqual(antigravityProbeStartupState(pending), {
        startForwarder: true,
        pendingActivationGeneration: PENDING_GENERATION,
        pendingSessionGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });

      assert.equal(await promoteAntigravityProbeActivation(STALE_GENERATION), false);
      assert.equal(antigravityProbeActivationState(readAntigravityToken()).state, "pending_activation");

      assert.equal(await promoteAntigravityProbeActivation(PENDING_GENERATION), true);
      const active = readAntigravityToken();
      assert.equal(antigravityProbeIsVerified(active), true);
      assert.equal(antigravityProbeActivationIsActive(active, PENDING_GENERATION), true);
      assert.equal(await promoteAntigravityProbeActivation(PENDING_GENERATION), true);
      assert.equal(await deactivateAntigravityProbeActivation(STALE_GENERATION), true);
      assert.equal(
        antigravityProbeActivationIsActive(readAntigravityToken(), PENDING_GENERATION),
        true,
      );
      assert.equal(await deactivateAntigravityProbeActivation(PENDING_GENERATION), true);
      const rolledBack = readAntigravityToken();
      assert.equal(antigravityProbeIsVerified(rolledBack), false);
      assert.equal(antigravityProbeActivationState(rolledBack).state, "pending_activation");
    },
  );
});

test("ignores a dispatched journal that belongs to a different credential snapshot", async () => {
  await withToken(
    {
      access_token: "active-access",
      refresh_token: "active-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_700_000_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: {
        version: 1,
        state: "active",
        generation: PENDING_GENERATION,
      },
    },
    async (_write, tokenPath) => {
      writeFileSync(`${tokenPath}.refresh-state.json`, `${JSON.stringify({
        version: 2,
        epoch: 1,
        owner_nonce: SUCCESSOR_REFRESH_OWNER,
        phase: "dispatched",
        session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        token_fingerprint: "0".repeat(64),
      }, null, 2)}\n`, { mode: 0o600 });
      assert.equal(antigravityOAuthStatus().configured, true);
      assert.equal(antigravityOAuthHealth().status, "ok");
      assert.deepEqual(antigravityOAuthStartupState(), { startForwarder: true });
    },
  );
});

test("version-one fast-hash refresh journals fail closed after the verifier upgrade", async () => {
  await withToken(
    {
      access_token: "active-access",
      refresh_token: "active-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
    },
    async (_write, tokenPath) => {
      const token = readAntigravityToken();
      writeFileSync(`${tokenPath}.refresh-state.json`, `${JSON.stringify({
        version: 1,
        epoch: 1,
        owner_nonce: SUCCESSOR_REFRESH_OWNER,
        phase: "dispatched",
        session_generation: token.session_generation,
        token_fingerprint: "0".repeat(64),
      }, null, 2)}\n`, { mode: 0o600 });
      let fetchCalls = 0;
      await assert.rejects(
        ensureFreshAntigravitySession({
          force: true,
          now: () => 1_999_999_999_000,
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("an old refresh journal must block provider dispatch");
          },
        }),
        (error) => error?.code === "oauth_credential_recovery_required",
      );
      assert.equal(fetchCalls, 0);
      assert.equal(antigravityOAuthStatus().configured, false);
      assert.equal(antigravityOAuthStartupState().startForwarder, false);
    },
  );
});

test("credential replacement invalidates a pending proof generation", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_700_000_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: pendingAntigravityProbeActivation(PENDING_GENERATION),
    },
    async () => {
      await saveAntigravityToken({
        ...CLIENT,
        access_token: "replacement",
        refresh_token: "replacement-refresh",
        expires_at: 2_000_000_100,
        expires_in: 3600,
      });
      assert.equal(await promoteAntigravityProbeActivation(PENDING_GENERATION), false);
      const replacement = readAntigravityToken();
      assert.equal(replacement.access_token, "replacement");
      assert.equal(antigravityProbeActivationState(replacement).state, "unverified");
    },
  );
});

test("disconnect invalidates a pending proof generation without recreating its record", async () => {
  await withToken(
    {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_700_000_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: pendingAntigravityProbeActivation(PENDING_GENERATION),
    },
    async (_write, tokenPath) => {
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(await promoteAntigravityProbeActivation(PENDING_GENERATION), false);
      assert.equal(existsSync(tokenPath), false);
    },
  );
});

test("rejects malformed or extensible activation records instead of treating them as active", () => {
  const token = {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...CLIENT,
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 2_000_000_000,
    expires_in: 3600,
    project_id: "operator-project",
    project_source: "managed",
    probe_version: 1,
    probe_verified_at: 1_700_000_000_000,
    probe_model: "gemini-3.1-pro",
  };
  assert.throws(
    () => validateAntigravityToken({
      ...token,
      probe_activation: { state: "active", generation: PENDING_GENERATION },
    }),
    /activation state is invalid/,
  );
  assert.throws(
    () => validateAntigravityToken({
      ...token,
      probe_activation: {
        ...pendingAntigravityProbeActivation(PENDING_GENERATION),
        unexpected_secret: "must-not-be-tolerated",
      },
    }),
    /activation state is invalid/,
  );
  assert.throws(
    () => validateAntigravityToken({
      ...token,
      probe_activation: {
        ...pendingAntigravityProbeActivation(PENDING_GENERATION),
        version: "1",
      },
    }),
    /activation state is invalid/,
  );
});

test("refreshes an expiring Antigravity token", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (write) => {
      const token = await ensureFreshAntigravityToken({
        now: () => 1_999_999_999_000,
        fetchImpl: async (_url, options) => {
          const body = new URLSearchParams(options.body);
          assert.equal(body.get("client_id"), CLIENT.client_id);
          assert.equal(body.get("client_secret"), CLIENT.client_secret);
          return new Response(
            JSON.stringify({ access_token: "new", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      });
      assert.equal(token, "new");
      assert.equal(readAntigravityToken().access_token, "new");
      assert.equal(readAntigravityToken().project_id, "p");
    },
  );
});

test("writes the existing revoked tombstone after invalid_grant", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      await assert.rejects(
        ensureFreshAntigravityToken({
          now: () => 1_999_999_999_000,
          delayImpl: async () => {},
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ error: "invalid_grant" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            ),
        }),
        /rejected/,
      );
      const tombstone = JSON.parse(
        readFileSync(antigravityTokenPath(), "utf8"),
      );
      assert.equal(tombstone.access_token, "");
      assert.equal(tombstone.refresh_token, "");
      assert.equal(tombstone.client_id, CLIENT.client_id);
      assert.equal(tombstone.client_secret, CLIENT.client_secret);
      assert.equal(tombstone.rejection_reason, undefined);
      assert.equal(tombstone.probe_version, undefined);
      assert.equal(tombstone.probe_verified_at, undefined);
      assert.equal(tombstone.probe_model, undefined);
    },
  );
});

test("tombstones tokens and proof when Google rejects the operator OAuth client", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "managed-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_999_999_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: {
        version: 1,
        state: "active",
        generation: PENDING_GENERATION,
      },
    },
    async () => {
      await assert.rejects(
        ensureFreshAntigravitySession({
          force: true,
          now: () => 1_999_999_999_000,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ error: "invalid_client" }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            ),
        }),
        (error) =>
          error?.code === "oauth_unauthorized" &&
          error?.status === 401 &&
          error?.providerCode === "invalid_client" &&
          /disconnect.*sign in/i.test(error.message),
      );
      const tombstone = JSON.parse(
        readFileSync(antigravityTokenPath(), "utf8"),
      );
      assert.equal(tombstone.access_token, "");
      assert.equal(tombstone.refresh_token, "");
      assert.equal(tombstone.client_id, CLIENT.client_id);
      assert.equal(tombstone.client_secret, CLIENT.client_secret);
      assert.equal(tombstone.rejection_reason, "invalid_client");
      assert.equal(tombstone.probe_version, undefined);
      assert.equal(tombstone.probe_verified_at, undefined);
      assert.equal(tombstone.probe_model, undefined);
      assert.equal(tombstone.probe_activation, undefined);
    },
  );
});

test("retries transient refresh failures and honors Retry-After", async () => {
  const delays = [];
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let attempts = 0;
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        random: () => 0,
        delayImpl: async (milliseconds) => delays.push(milliseconds),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts < 3) {
            return new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "2" },
            });
          }
          return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "new");
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [2_000, 2_000]);
    },
  );
});

test("aborts an in-flight refresh when the caller disconnects", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      const controller = new AbortController();
      let started;
      const fetchStarted = new Promise((resolve) => { started = resolve; });
      const refreshing = ensureFreshAntigravitySession({
        now: () => 1_999_999_999_000,
        signal: controller.signal,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      });
      await fetchStarted;
      controller.abort(Object.freeze(new Error("caller disconnected")));
      await assert.rejects(refreshing, /caller disconnected/);
      const stored = JSON.parse(readFileSync(antigravityTokenPath(), "utf8"));
      assert.equal(stored.access_token, "");
      assert.equal(stored.refresh_token, "");
      assert.equal(stored.rejection_reason, "refresh_outcome_unknown");
      assert.equal(antigravityOAuthStatus().refreshOutcomeUnknown, true);
      assert.equal(
        JSON.parse(readFileSync(`${antigravityTokenPath()}.refresh-state.json`, "utf8")).phase,
        "uncertain",
      );
    },
  );
});

test("commits a successful refresh rotation after the caller cancels", async () => {
  await withToken(
    {
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      const controller = new AbortController();
      const refreshing = ensureFreshAntigravitySession({
        force: true,
        signal: controller.signal,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            // Google has already accepted the one-time refresh credential and
            // returned its rotation. Caller lifetime must no longer be able to
            // discard the only durable copy of that result.
            controller.abort(new Error("caller cancelled after provider success"));
            return {
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
            };
          },
        }),
      });

      const session = await refreshing;
      assert.equal(session.access_token, "rotated-access");
      assert.equal(session.refresh_token, "rotated-refresh");
      const stored = readAntigravityToken();
      assert.equal(stored.access_token, "rotated-access");
      assert.equal(stored.refresh_token, "rotated-refresh");
    },
  );
});

test("does not replay a one-time refresh token after an ambiguous transport failure", async () => {
  await withToken(
    {
      access_token: "still-valid",
      refresh_token: "one-time-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let attempts = 0;
      await assert.rejects(
        ensureFreshAntigravitySession({
          force: true,
          now: () => 1_999_999_999_000,
          delayImpl: async () => {
            throw new Error("an ambiguous request must not reach retry delay");
          },
          fetchImpl: async () => {
            attempts += 1;
            throw new Error("connection reset after request write");
          },
        }),
        /could not confirm Google's authentication response/,
      );
      assert.equal(attempts, 1);
      const stored = JSON.parse(readFileSync(antigravityTokenPath(), "utf8"));
      assert.equal(stored.rejection_reason, "refresh_outcome_unknown");
      assert.equal(stored.refresh_token, "");
    },
  );
});

test("clears the journal and preserves a hard-valid token after proven pre-connect failures", async () => {
  for (const code of [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "EADDRNOTAVAIL",
    "ENOBUFS",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    await withToken(
      {
        access_token: `still-valid-${code}`,
        refresh_token: `unspent-${code}`,
        expires_at: 2_000_000_000,
        expires_in: 3600,
        project_id: "p",
      },
      async (_write, tokenPath) => {
        let attempts = 0;
        const session = await ensureFreshAntigravitySession({
          now: () => 1_999_999_999_000,
          random: () => 0,
          delayImpl: async () => {},
          fetchImpl: async () => {
            attempts += 1;
            const cause = Object.assign(new Error(`pre-connect ${code}`), { code });
            throw new TypeError("fetch failed", { cause });
          },
        });
        assert.equal(attempts, 3, code);
        assert.equal(session.access_token, `still-valid-${code}`, code);
        assert.equal(session.refresh_token, `unspent-${code}`, code);
        assert.equal(existsSync(`${tokenPath}.refresh-state.json`), false, code);
        const stored = readAntigravityToken();
        assert.equal(stored.access_token, `still-valid-${code}`, code);
        assert.equal(stored.refresh_token, `unspent-${code}`, code);
      },
    );
  }
});

test("accepts an aggregate only when every transport branch is proven pre-connect", async () => {
  await withToken(
    {
      access_token: "still-valid-aggregate",
      refresh_token: "unspent-aggregate",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      let attempts = 0;
      const session = await ensureFreshAntigravitySession({
        now: () => 1_999_999_999_000,
        random: () => 0,
        delayImpl: async () => {},
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("fetch failed", {
            cause: new AggregateError([
              Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
              Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
            ]),
          });
        },
      });
      assert.equal(attempts, 3);
      assert.equal(session.access_token, "still-valid-aggregate");
      assert.equal(session.refresh_token, "unspent-aggregate");
      assert.equal(existsSync(`${tokenPath}.refresh-state.json`), false);
    },
  );
});

test("keeps reset and response timeouts ambiguous after refresh dispatch", async () => {
  for (const { label, error } of [
    ...["ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].map((code) => ({
      label: code,
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error(`ambiguous ${code}`), { code }),
      }),
    })),
    {
      label: "mixed aggregate",
      error: new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
          Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        ]),
      }),
    },
    {
      label: "aggregate with an unknown leaf",
      error: new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
          new Error("outcome unknown"),
        ]),
      }),
    },
    {
      label: "nested response status",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("provider answered"), {
          code: "ECONNREFUSED",
          status: 503,
        }),
      }),
    },
    {
      label: "nested timeout",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("timed out"), {
          code: "ECONNREFUSED",
          name: "TimeoutError",
        }),
      }),
    },
  ]) {
    await withToken(
      {
        access_token: `old-${label}`,
        refresh_token: `one-time-${label}`,
        expires_at: 2_000_000_000,
        expires_in: 3600,
        project_id: "p",
      },
      async (_write, tokenPath) => {
        let attempts = 0;
        await assert.rejects(
          ensureFreshAntigravitySession({
            force: true,
            now: () => 1_999_999_999_000,
            fetchImpl: async () => {
              attempts += 1;
              throw error;
            },
          }),
          /could not confirm Google's authentication response/,
          label,
        );
        assert.equal(attempts, 1, label);
        const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
        assert.equal(stored.access_token, "", label);
        assert.equal(stored.refresh_token, "", label);
        assert.equal(stored.rejection_reason, "refresh_outcome_unknown", label);
        assert.equal(
          JSON.parse(readFileSync(`${tokenPath}.refresh-state.json`, "utf8")).phase,
          "uncertain",
          label,
        );
      },
    );
  }
});

test("disconnect is not blocked by refresh network I/O and fences its late result", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let startedResolve;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      let releaseResolve;
      const release = new Promise((resolve) => { releaseResolve = resolve; });
      const refreshing = ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => {
          startedResolve();
          await release;
          return new Response(JSON.stringify({ access_token: "late", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      await started;
      const disconnected = await Promise.race([
        removeAntigravityToken(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect blocked")), 500)),
      ]);
      assert.equal(disconnected, true);
      releaseResolve();
      await assert.rejects(refreshing, /session changed|credentials were not found/i);
      assert.equal(existsSync(antigravityTokenPath()), false);
    },
  );
});

test("a slower valid refresh rotation wins over an overlapping invalid_grant", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let startedResolve;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      let releaseResolve;
      const release = new Promise((resolve) => { releaseResolve = resolve; });
      const firstController = new AbortController();
      const secondController = new AbortController();
      let rejectedRefreshCalls = 0;
      const valid = ensureFreshAntigravitySession({
        force: true,
        signal: firstController.signal,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => {
          startedResolve();
          await release;
          return new Response(JSON.stringify({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });
      await started;
      const rejected = ensureFreshAntigravitySession({
        force: true,
        signal: secondController.signal,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => {
          rejectedRefreshCalls += 1;
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      // Give the independently signalled call time to take its preliminary
      // snapshot and block on the cross-process refresh lease.
      await new Promise((resolve) => setTimeout(resolve, 40));
      releaseResolve();
      const [left, right] = await Promise.all([valid, rejected]);
      assert.equal(left.access_token, "rotated-access");
      assert.equal(right.access_token, "rotated-access");
      assert.equal(right.refresh_token, "rotated-refresh");
      assert.equal(rejectedRefreshCalls, 0);
      assert.equal(readAntigravityToken().access_token, "rotated-access");
    },
  );
});

test("the OS-held refresh lease excludes an overlapping invalid_grant without mtime state", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      const directory = path.dirname(tokenPath);
      const validStarted = path.join(directory, "valid-started");
      const releaseValid = path.join(directory, "release-valid");
      const rejectedInvoked = path.join(directory, "rejected-invoked");
      const rejectedFetch = path.join(directory, "rejected-fetch");
      const valid = startRefreshWorker([
        tokenPath,
        "valid",
        validStarted,
        releaseValid,
        path.join(directory, "valid-invoked"),
        path.join(directory, "valid-fetch"),
      ]);
      await waitForFile(validStarted);
      // Ownership is a kernel-held endpoint, not a filesystem timestamp that a
      // stalled event loop must keep refreshing.
      assert.equal(existsSync(`${tokenPath}.refresh.guard.lock`), false);
      const rejected = startRefreshWorker([
        tokenPath,
        "invalid",
        path.join(directory, "invalid-started"),
        path.join(directory, "unused-release"),
        rejectedInvoked,
        rejectedFetch,
      ]);
      await waitForFile(rejectedInvoked);
      // The valid process is holding the lease in network I/O. Keep it there
      // while the second process enters ensureFresh and waits on that lease.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(existsSync(rejectedFetch), false);
      writeFileSync(releaseValid, "go");
      const [validResult, rejectedResult] = await Promise.all([
        finishWorker(valid),
        finishWorker(rejected),
      ]);
      assert.equal(validResult.accessToken, "rotated-access");
      assert.equal(rejectedResult.accessToken, "rotated-access");
      assert.equal(existsSync(rejectedFetch), false);
      const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
      assert.equal(stored.access_token, "rotated-access");
      assert.equal(stored.refresh_token, "rotated-refresh");
    },
  );
});

test("process suspension cannot make a live refresh owner stale", {
  skip: process.platform === "win32" ? "Windows has no SIGSTOP/SIGCONT" : false,
}, async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      const directory = path.dirname(tokenPath);
      const firstStarted = path.join(directory, "suspended-owner-started");
      const releaseFirst = path.join(directory, "release-suspended-owner");
      const followerInvoked = path.join(directory, "suspended-follower-invoked");
      const followerFetch = path.join(directory, "suspended-follower-fetch");
      let first;
      let follower;
      try {
        first = startRefreshWorker([
          tokenPath,
          "valid",
          firstStarted,
          releaseFirst,
          path.join(directory, "suspended-owner-invoked"),
          path.join(directory, "suspended-owner-fetch"),
        ]);
        await waitForFile(firstStarted);
        assert.equal(first.child.kill("SIGSTOP"), true);

        follower = startRefreshWorker([
          tokenPath,
          "invalid",
          path.join(directory, "suspended-follower-started"),
          path.join(directory, "unused-suspended-release"),
          followerInvoked,
          followerFetch,
        ]);
        await waitForFile(followerInvoked);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(existsSync(followerFetch), false);

        assert.equal(first.child.kill("SIGCONT"), true);
        writeFileSync(releaseFirst, "go");
        const [winner, joined] = await Promise.all([
          finishWorker(first),
          finishWorker(follower),
        ]);
        assert.equal(winner.refreshToken, "rotated-refresh");
        assert.equal(joined.refreshToken, "rotated-refresh");
        assert.equal(existsSync(followerFetch), false);
      } finally {
        if (first?.child.exitCode === null && first?.child.signalCode === null) {
          first.child.kill("SIGCONT");
        }
        await Promise.all([terminateWorker(first), terminateWorker(follower)]);
      }
    },
  );
});

test("a suspended refresh commit cannot be reaped by disconnect or re-login", {
  skip: process.platform === "win32" ? "Windows has no SIGSTOP/SIGCONT" : false,
}, async () => {
  for (const mutationName of ["disconnect", "re-login"]) {
    await withToken(
      {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: 2_000_000_000,
        expires_in: 3600,
        project_id: "p",
      },
      async (_write, tokenPath) => {
        const directory = path.dirname(tokenPath);
        const commitReady = path.join(directory, `${mutationName}-commit-ready`);
        const releaseCommit = path.join(directory, `${mutationName}-release-commit`);
        let owner;
        try {
          owner = startRefreshWorker([
            tokenPath,
            "commit-paused-valid",
            commitReady,
            releaseCommit,
            path.join(directory, `${mutationName}-invoked`),
            path.join(directory, `${mutationName}-fetch`),
          ]);
          await waitForFile(commitReady);
          assert.equal(owner.child.kill("SIGSTOP"), true);

          // The previous proper-lockfile implementation held this directory.
          // Age it past the former stale threshold while its live owner is
          // suspended: a stale-lock implementation now admits the competing
          // mutation and lets the paused refresh resurrect or overwrite it.
          const legacyLock = `${tokenPath}.guard.lock`;
          if (!existsSync(legacyLock)) mkdirSync(legacyLock, { mode: 0o700 });
          const stale = new Date(Date.now() - 10 * 60_000);
          utimesSync(legacyLock, stale, stale);

          let mutationSettled = false;
          const mutation = (mutationName === "disconnect"
            ? removeAntigravityToken()
            : saveAntigravityToken({
              ...CLIENT,
              access_token: "reauthorized-access",
              refresh_token: "reauthorized-refresh",
              expires_at: 2_000_003_600,
              expires_in: 3600,
            }))
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
            .finally(() => { mutationSettled = true; });

          await new Promise((resolve) => setTimeout(resolve, 500));
          assert.equal(
            mutationSettled,
            false,
            `${mutationName} must remain behind the suspended OS-owned mutation lease`,
          );

          assert.equal(owner.child.kill("SIGCONT"), true);
          writeFileSync(releaseCommit, "go");
          const [refreshResult, mutationResult] = await Promise.all([
            finishWorker(owner),
            mutation,
          ]);
          if (mutationResult.error) throw mutationResult.error;
          assert.equal(refreshResult.refreshToken, "rotated-refresh");
          if (mutationName === "disconnect") {
            assert.equal(mutationResult.value, true);
            assert.equal(existsSync(tokenPath), false);
          } else {
            const stored = readAntigravityToken();
            assert.equal(stored.access_token, "reauthorized-access");
            assert.equal(stored.refresh_token, "reauthorized-refresh");
          }
        } finally {
          if (owner?.child.exitCode === null && owner?.child.signalCode === null) {
            owner.child.kill("SIGCONT");
          }
          await terminateWorker(owner);
        }
      },
    );
  }
});

test("a superseded refresh owner cannot commit or remove its successor's lease", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      const directory = path.dirname(tokenPath);
      const refreshStatePath = `${tokenPath}.refresh-state.json`;
      const firstStarted = path.join(directory, "first-predispatch-started");
      const releaseFirst = path.join(directory, "release-first-predispatch");
      const secondStarted = path.join(directory, "second-refresh-started");
      const releaseSecond = path.join(directory, "release-second-refresh");
      const thirdInvoked = path.join(directory, "third-refresh-invoked");
      const thirdFetch = path.join(directory, "third-refresh-fetch");
      let first;
      let second;
      let third;
      try {
        first = startRefreshWorker([
          tokenPath,
          "predispatch-valid",
          firstStarted,
          releaseFirst,
          path.join(directory, "first-refresh-invoked"),
          path.join(directory, "first-refresh-fetch"),
        ]);
        await waitForFile(firstStarted);

        // Force the durable state a successor would own after takeover. The OS
        // endpoint prevents this overlap in production, but the epoch is the
        // final mutation fence if ownership and credential I/O are interrupted
        // at an adversarial boundary.
        const firstFence = JSON.parse(readFileSync(refreshStatePath, "utf8"));
        const successorFence = {
          ...firstFence,
          epoch: firstFence.epoch + 1,
          owner_nonce: SUCCESSOR_REFRESH_OWNER,
        };
        writeFileSync(refreshStatePath, `${JSON.stringify(successorFence, null, 2)}\n`);

        writeFileSync(releaseFirst, "go");
        const firstOutcome = await waitForWorker(first);
        assert.equal(firstOutcome.code, 1);
        assert.match(first.stderr(), /oauth_refresh_superseded/);
        assert.deepEqual(JSON.parse(readFileSync(refreshStatePath, "utf8")), successorFence);

        second = startRefreshWorker([
          tokenPath,
          "valid",
          secondStarted,
          releaseSecond,
          path.join(directory, "second-refresh-invoked"),
          path.join(directory, "second-refresh-fetch"),
        ]);
        await waitForFile(secondStarted);
        const activeFence = JSON.parse(readFileSync(refreshStatePath, "utf8"));
        assert.equal(activeFence.epoch, successorFence.epoch + 1);
        assert.notEqual(activeFence.owner_nonce, successorFence.owner_nonce);
        assert.equal(activeFence.phase, "dispatched");

        third = startRefreshWorker([
          tokenPath,
          "invalid",
          path.join(directory, "third-refresh-started"),
          path.join(directory, "unused-third-release"),
          thirdInvoked,
          thirdFetch,
        ]);
        await waitForFile(thirdInvoked);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(existsSync(thirdFetch), false);
        assert.deepEqual(JSON.parse(readFileSync(refreshStatePath, "utf8")), activeFence);

        writeFileSync(releaseSecond, "go");
        const [secondResult, thirdResult] = await Promise.all([
          finishWorker(second),
          finishWorker(third),
        ]);
        assert.equal(secondResult.refreshToken, "rotated-refresh");
        assert.equal(thirdResult.refreshToken, "rotated-refresh");
        assert.equal(existsSync(thirdFetch), false);
      } finally {
        await Promise.all([
          terminateWorker(first),
          terminateWorker(second),
          terminateWorker(third),
        ]);
      }
    },
  );
});

test("recovers a dead refresh owner that crashed before provider dispatch", async () => {
  await withToken(
    {
      access_token: "access-secret-sentinel",
      refresh_token: "refresh-secret-sentinel",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      const directory = path.dirname(tokenPath);
      const firstStarted = path.join(directory, "crash-predispatch-started");
      let crashed;
      let recovered;
      try {
        crashed = startRefreshWorker([
          tokenPath,
          "predispatch-valid",
          firstStarted,
          path.join(directory, "never-release-crashed-owner"),
          path.join(directory, "crashed-owner-invoked"),
          path.join(directory, "crashed-owner-fetch"),
        ]);
        await waitForFile(firstStarted);
        const refreshStateText = readFileSync(`${tokenPath}.refresh-state.json`, "utf8");
        assert.equal(
          JSON.parse(refreshStateText).phase,
          "claimed",
        );
        for (const secret of [
          "access-secret-sentinel",
          "refresh-secret-sentinel",
          CLIENT.client_id,
          CLIENT.client_secret,
        ]) {
          assert.equal(refreshStateText.includes(secret), false);
        }
        crashed.child.kill("SIGKILL");
        const crashedOutcome = await waitForWorker(crashed);
        assert.ok(crashedOutcome.signal || crashedOutcome.code !== 0);

        const releaseRecovered = path.join(directory, "release-recovered-owner");
        writeFileSync(releaseRecovered, "go");
        recovered = startRefreshWorker([
          tokenPath,
          "valid",
          path.join(directory, "recovered-owner-started"),
          releaseRecovered,
          path.join(directory, "recovered-owner-invoked"),
          path.join(directory, "recovered-owner-fetch"),
        ]);
        const result = await finishWorker(recovered);
        assert.equal(result.accessToken, "rotated-access");
        assert.equal(result.refreshToken, "rotated-refresh");
        assert.equal(existsSync(`${tokenPath}.refresh-state.json`), false);
      } finally {
        await Promise.all([terminateWorker(crashed), terminateWorker(recovered)]);
      }
    },
  );
});

test("fails closed when a refresh owner crashes after provider dispatch", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "operator-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: 1_700_000_000_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: {
        version: 1,
        state: "active",
        generation: PENDING_GENERATION,
      },
    },
    async (_write, tokenPath) => {
      const directory = path.dirname(tokenPath);
      let crashed;
      let follower;
      const followerFetch = path.join(directory, "ambiguous-follower-fetch");
      try {
        assert.equal(antigravityOAuthStatus().configured, true);
        assert.equal(antigravityOAuthHealth().status, "ok");
        assert.deepEqual(antigravityOAuthStartupState(), { startForwarder: true });
        crashed = startRefreshWorker([
          tokenPath,
          "valid",
          path.join(directory, "crash-dispatched-started"),
          path.join(directory, "never-release-dispatched-owner"),
          path.join(directory, "crash-dispatched-invoked"),
          path.join(directory, "crash-dispatched-fetch"),
        ]);
        await waitForFile(path.join(directory, "crash-dispatched-started"));
        assert.equal(
          JSON.parse(readFileSync(`${tokenPath}.refresh-state.json`, "utf8")).phase,
          "dispatched",
        );
        crashed.child.kill("SIGKILL");
        await waitForWorker(crashed);

        // No second request is needed to finish the fail-closed transition.
        // Read-only publication, health, and startup paths inspect the durable
        // matching journal immediately after the dispatched owner disappears.
        const unresolvedStatus = antigravityOAuthStatus();
        assert.equal(unresolvedStatus.configured, false);
        assert.equal(unresolvedStatus.refreshOutcomeUnknown, true);
        assert.equal(antigravityOAuthHealth().status, "blocked");
        assert.deepEqual(antigravityOAuthStartupState(), { startForwarder: false });
        assert.equal(readAntigravityToken().refresh_token, "old-refresh");

        follower = startRefreshWorker([
          tokenPath,
          "invalid",
          path.join(directory, "ambiguous-follower-started"),
          path.join(directory, "unused-ambiguous-release"),
          path.join(directory, "ambiguous-follower-invoked"),
          followerFetch,
        ]);
        const outcome = await waitForWorker(follower);
        assert.equal(outcome.code, 1);
        assert.match(follower.stderr(), /oauth_refresh_outcome_unknown/);
        assert.equal(existsSync(followerFetch), false);
        const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
        assert.equal(stored.access_token, "");
        assert.equal(stored.refresh_token, "");
        assert.equal(stored.rejection_reason, "refresh_outcome_unknown");
        assert.equal(antigravityOAuthStatus().refreshOutcomeUnknown, true);
        assert.match(antigravityOAuthHealth().detail, /refresh outcome is unknown/i);
        assert.equal(
          JSON.parse(readFileSync(`${tokenPath}.refresh-state.json`, "utf8")).phase,
          "uncertain",
        );
        await saveAntigravityToken({
          ...CLIENT,
          access_token: "reauthorized-access",
          refresh_token: "reauthorized-refresh",
          expires_at: 2_000_003_600,
          expires_in: 3600,
        });
        assert.equal(existsSync(`${tokenPath}.refresh-state.json`), false);
        assert.equal(readAntigravityToken().refresh_token, "reauthorized-refresh");
      } finally {
        await Promise.all([terminateWorker(crashed), terminateWorker(follower)]);
      }
    },
  );
});

test("caps an excessive refresh Retry-After delay", async () => {
  const delays = [];
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let attempts = 0;
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        random: () => 0,
        delayImpl: async (milliseconds) => delays.push(milliseconds),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "86400" },
            });
          }
          return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "new");
      assert.deepEqual(delays, [30_000]);
    },
  );
});

test("recovers a concurrently replaced credential instead of tombstoning it", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "old-project",
    },
    async (write) => {
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        delayImpl: async () => {},
        fetchImpl: async () => {
          write({
            access_token: "replacement",
            refresh_token: "new-refresh",
            expires_at: 2_000_001_000,
            expires_in: 3600,
            project_id: "new-project",
          });
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "replacement");
      assert.equal(session.refresh_token, "new-refresh");
    },
  );
});

test("an invalid_client response cannot tombstone a concurrently replaced credential", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "old-project",
    },
    async (write) => {
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        delayImpl: async () => {},
        fetchImpl: async () => {
          write({
            access_token: "replacement",
            refresh_token: "new-refresh",
            expires_at: 2_000_001_000,
            expires_in: 3600,
            project_id: "new-project",
          });
          return new Response(JSON.stringify({ error: "invalid_client" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "replacement");
      assert.equal(session.refresh_token, "new-refresh");
      const stored = JSON.parse(
        readFileSync(antigravityTokenPath(), "utf8"),
      );
      assert.equal(stored.access_token, "replacement");
      assert.equal(stored.refresh_token, "new-refresh");
      assert.equal(stored.rejection_reason, undefined);
    },
  );
});

test("does not overwrite a concurrently replaced credential after a successful refresh", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "old-project",
    },
    async (write) => {
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => {
          write({
            access_token: "replacement",
            refresh_token: "new-refresh",
            expires_at: 2_000_001_000,
            expires_in: 3600,
            project_id: "new-project",
          });
          return new Response(JSON.stringify({ access_token: "stale-refresh", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "replacement");
      assert.equal(session.refresh_token, "new-refresh");
      assert.equal(readAntigravityToken().project_id, "new-project");
    },
  );
});

test("preserves concurrent project metadata when the same credential refreshes", async () => {
  const initial = {
    access_token: "old",
    refresh_token: "refresh",
    expires_at: 2_000_000_000,
    expires_in: 3600,
    project_id: "",
  };
  await withToken(initial, async (write) => {
    const session = await ensureFreshAntigravitySession({
      force: true,
      now: () => 1_999_999_999_000,
      fetchImpl: async () => {
        write({
          ...initial,
          project_id: "managed-project",
          project_source: "managed",
          project_checked_at: 1234,
          tier_id: "pro-tier",
        });
        return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.equal(session.access_token, "new");
    assert.equal(session.project_id, "managed-project");
    assert.equal(session.project_source, "managed");
    assert.equal(session.project_checked_at, 1234);
    assert.equal(session.tier_id, "pro-tier");
  });
});

test("keeps a hard-valid token and proof byte-identical after definitive transient responses", async () => {
  const now = Date.now();
  await withToken(
    {
      access_token: "still-valid",
      refresh_token: "refresh",
      expires_at: Math.floor(now / 1_000) + 30,
      expires_in: 3600,
      project_id: "managed-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: now - 1_000,
      probe_model: "gemini-3.1-pro",
      probe_activation: {
        version: 1,
        state: "active",
        generation: PENDING_GENERATION,
      },
    },
    async (_write, tokenPath) => {
      const before = readFileSync(tokenPath, "utf8");
      let attempts = 0;
      const token = await ensureFreshAntigravityToken({
        now: () => now,
        delayImpl: async () => {},
        fetchImpl: async () => {
          attempts += 1;
          return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(token, "still-valid");
      assert.equal(attempts, 3);
      assert.equal(readFileSync(tokenPath, "utf8"), before);
    },
  );
});

test("serializes save/update/remove operations and can repair file protection", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      await saveAntigravityToken({
        ...CLIENT,
        access_token: "saved",
        refresh_token: "refresh",
        expires_at: 2_000_000_000,
        expires_in: 3600,
        project_id: "p",
      });
      const updated = await updateAntigravityToken((latest) => ({
        ...latest,
        project_id: "managed",
        project_source: "managed",
      }));
      assert.equal(updated.access_token, "saved");
      assert.equal(updated.project_id, "managed");
      assert.equal(protectAntigravityToken(), tokenPath);
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(await removeAntigravityToken(), false);
      assert.equal(existsSync(tokenPath), false);
    },
  );
});

test("never follows a credential-path symlink into another store", {
  skip: process.platform === "win32" ? "unprivileged Windows fixtures cannot create symlinks" : false,
}, async () => {
  await withToken(
    {
      access_token: "router-access",
      refresh_token: "router-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      const foreignPath = `${tokenPath}.official-ide`;
      const foreign = JSON.stringify({
        version: 2,
        managed_by: "codex-router",
        ...CLIENT,
        access_token: "official-access-must-not-be-read",
        refresh_token: "official-refresh-must-not-be-read",
        expires_at: 2_000_000_000,
        expires_in: 3600,
      });
      writeFileSync(foreignPath, foreign, { mode: 0o600 });
      rmSync(tokenPath);
      symlinkSync(foreignPath, tokenPath);

      assert.throws(readAntigravityToken, /refuses a symlink/);
      assert.equal(protectAntigravityToken(), false);
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(existsSync(tokenPath), false);
      assert.equal(readFileSync(foreignPath, "utf8"), foreign);
    },
  );
});

test("never follows a refresh-journal symlink into another store", {
  skip: process.platform === "win32" ? "unprivileged Windows fixtures cannot create symlinks" : false,
}, async () => {
  await withToken(
    {
      access_token: "router-access",
      refresh_token: "router-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      const refreshStatePath = `${tokenPath}.refresh-state.json`;
      const foreignPath = `${tokenPath}.foreign-refresh-state`;
      const foreign = "foreign state must remain byte-identical\n";
      writeFileSync(foreignPath, foreign, { mode: 0o600 });
      let fetchCalls = 0;

      await assert.rejects(
        ensureFreshAntigravitySession({
          force: true,
          now: () => 1_999_999_999_000,
          _beforeRefreshDispatch: async () => {
            rmSync(refreshStatePath);
            symlinkSync(foreignPath, refreshStatePath);
          },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not dispatch through an unsafe journal");
          },
        }),
        (error) => error?.code === "oauth_credential_recovery_required",
      );
      assert.equal(fetchCalls, 0);
      assert.equal(readFileSync(foreignPath, "utf8"), foreign);
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(existsSync(refreshStatePath), false);
      assert.equal(readFileSync(foreignPath, "utf8"), foreign);
    },
  );
});

test("disconnect removes only an exact empty credential directory", async () => {
  await withToken(
    {
      access_token: "router-access",
      refresh_token: "router-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      rmSync(tokenPath);
      mkdirSync(tokenPath);
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(existsSync(tokenPath), false);
    },
  );
});

test("disconnect preserves a nonempty credential directory for manual recovery", async () => {
  await withToken(
    {
      access_token: "router-access",
      refresh_token: "router-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      rmSync(tokenPath);
      mkdirSync(tokenPath);
      const sentinel = path.join(tokenPath, "operator-owned-file");
      writeFileSync(sentinel, "preserve me");
      await assert.rejects(
        removeAntigravityToken(),
        (error) =>
          error?.code === "oauth_credential_recovery_required" &&
          error?.status === 409 &&
          /nonempty directory/i.test(error.message),
      );
      assert.equal(readFileSync(sentinel, "utf8"), "preserve me");
    },
  );
});

test("refuses to overwrite an existing credential with a different OAuth client pair", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (_write, tokenPath) => {
      const before = readFileSync(tokenPath, "utf8");
      await assert.rejects(
        saveAntigravityToken({
          client_id: "different.apps.googleusercontent.com",
          client_secret: "different-secret",
          access_token: "replacement",
          refresh_token: "replacement-refresh",
          expires_at: 2_000_000_000,
          expires_in: 3600,
        }),
        /Disconnect the existing Antigravity OAuth client/,
      );
      assert.equal(readFileSync(tokenPath, "utf8"), before);
    },
  );
});

test("rejects a legacy token instead of borrowing an environment client", async () => {
  const previousId = process.env.ANTIGRAVITY_CLIENT_ID;
  const previousSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  process.env.ANTIGRAVITY_CLIENT_ID = "vendor.apps.googleusercontent.com";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "vendor-secret";
  try {
    await withToken(
      {
        client_id: undefined,
        client_secret: undefined,
        access_token: "legacy",
        refresh_token: "legacy-refresh",
        expires_at: 2_000_000_000,
        expires_in: 3600,
      },
      async () => {
        await assert.rejects(ensureFreshAntigravitySession(), /operator-owned/);
      },
    );
  } finally {
    if (previousId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
    else process.env.ANTIGRAVITY_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_CLIENT_SECRET = previousSecret;
  }
});

test("rejects a foreign OAuth record even when its fields resemble this router's schema", async () => {
  await withToken(
    {
      access_token: "foreign-access",
      refresh_token: "foreign-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async (write) => {
      write({
        version: undefined,
        managed_by: undefined,
        ...CLIENT,
        access_token: "foreign-access",
        refresh_token: "foreign-refresh",
        expires_at: 2_000_000_000,
        expires_in: 3600,
      });
      assert.throws(readAntigravityToken, /only a credential created by this Codex Router/);
    },
  );
});

test("no-discovery mode refuses the router OAuth record before refresh or repair", async () => {
  await withToken(
    {
      access_token: "private-access",
      refresh_token: "private-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async () => {
      process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
      let networkCalls = 0;
      assert.throws(readAntigravityToken, /discovery is disabled/);
      assert.equal(protectAntigravityToken(), false);
      await assert.rejects(
        ensureFreshAntigravitySession({
          fetchImpl: async () => {
            networkCalls += 1;
            throw new Error("must not run");
          },
        }),
        /discovery is disabled/,
      );
      assert.equal(networkCalls, 0);
    },
  );
});
