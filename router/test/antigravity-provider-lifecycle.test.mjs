import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "antigravity-provider-lifecycle-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_USER_MODELS = path.join(root, "state", "user-models.json");

const {
  antigravityTokenPath,
  ensureFreshAntigravitySession,
  pendingAntigravityProbeActivation,
  saveAntigravityToken,
} = await import("../src/antigravity-oauth-session.mjs");
const {
  providerOnboardingSnapshot,
  removeApiCredential,
} = await import("../src/provider-onboarding.mjs");
const {
  antigravityOAuthStatus,
  antigravityOAuthHealth,
  antigravityOAuthStartupState,
  repairAntigravityOAuthPermissions,
} = await import("../src/antigravity-oauth-status.mjs");
const {
  configuredProviderIds,
  enableProvider,
  readProviderSelection,
  selectedConfiguredListedModels,
} = await import("../src/provider-selection.mjs");

const CLIENT = {
  client_id: "operator-owned.apps.googleusercontent.com",
  client_secret: "test-client-secret",
};
const VERIFIED = {
  probe_version: 1,
  probe_verified_at: 1_999_999_000_000,
  probe_model: "gemini-3.1-pro",
  project_id: "managed-project",
  project_source: "managed",
  probe_activation: {
    version: 1,
    state: "active",
    generation: "99999999-9999-4999-8999-999999999999",
  },
};
const PENDING_GENERATION = "44444444-4444-4444-8444-444444444444";

test("a dangling credential symlink remains visible and safely disconnectable", {
  skip: process.platform === "win32" ? "unprivileged Windows fixtures cannot create symlinks" : false,
}, async () => {
  try {
    const tokenPath = antigravityTokenPath();
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    const missingTarget = path.join(root, "operator-store-that-does-not-exist");
    symlinkSync(missingTarget, tokenPath);

    const status = antigravityOAuthStatus();
    assert.equal(status.credentialPresent, true);
    assert.equal(status.configured, false);
    assert.match(status.recoveryNote || "", /symlink.*without touching its target/i);
    assert.equal(antigravityOAuthHealth().status, "invalid");
    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.disconnectable, true);
    assert.equal(provider?.action, "blocked");

    const removal = await removeApiCredential("antigravity-oauth");
    assert.equal(removal.removedFiles, 1);
    assert.equal(existsSync(tokenPath), false);
    assert.equal(existsSync(missingTarget), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router-managed Antigravity disconnect removes its token and selection", async () => {
  try {
    await saveAntigravityToken({
      ...CLIENT,
      ...VERIFIED,
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "managed-project",
      project_source: "managed",
    });
    enableProvider("antigravity-oauth");
    assert.ok(readProviderSelection().includes("antigravity-oauth"));
    assert.equal(antigravityOAuthHealth().status, "ok");

    const removal = await removeApiCredential("antigravity-oauth");

    assert.equal(removal.removedFiles, 1);
    assert.equal(removal.stillConfigured, false);
    assert.equal(existsSync(antigravityTokenPath()), false);
    assert.equal(readProviderSelection().includes("antigravity-oauth"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent publisher cannot expose a pending Antigravity activation", async () => {
  try {
    await saveAntigravityToken({
      ...CLIENT,
      ...VERIFIED,
      access_token: "pending-access-token",
      refresh_token: "pending-refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      probe_activation: pendingAntigravityProbeActivation(PENDING_GENERATION),
    });
    enableProvider("antigravity-oauth");

    const status = antigravityOAuthStatus();
    assert.equal(status.configured, false);
    assert.equal(status.verified, false);
    assert.equal(status.activationPending, true);
    assert.equal(configuredProviderIds().includes("antigravity-oauth"), false);
    assert.equal(
      selectedConfiguredListedModels().some((model) => model.provider === "antigravity-oauth"),
      false,
    );
    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.configured, false);
    assert.equal(provider?.action, "blocked");
    assert.match(provider?.blockedNote || "", /pending router health activation/i);
    assert.equal(antigravityOAuthHealth().status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete v3 proof without activation metadata must be probed again", async () => {
  try {
    const { probe_activation: _oldUnsafeActivation, ...preActivationProof } = VERIFIED;
    await saveAntigravityToken({
      ...CLIENT,
      ...preActivationProof,
      access_token: "pre-activation-access-token",
      refresh_token: "pre-activation-refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    });
    enableProvider("antigravity-oauth");

    const status = antigravityOAuthStatus();
    assert.equal(status.configured, false);
    assert.equal(status.verified, false);
    assert.equal(status.activationPending, undefined);
    assert.match(status.setup || "", /explicit live compatibility test/i);
    assert.deepEqual(antigravityOAuthStartupState(), { startForwarder: false });
    assert.equal(configuredProviderIds().includes("antigravity-oauth"), false);
    assert.equal(
      selectedConfiguredListedModels().some((model) => model.provider === "antigravity-oauth"),
      false,
    );
    assert.equal(antigravityOAuthHealth().status, "unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected Antigravity session remains disconnectable and is withdrawn", async () => {
  try {
    const tokenPath = antigravityTokenPath();
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${JSON.stringify({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ...CLIENT,
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      expires_in: 0,
      revoked_at: 2_000_000_000,
    })}\n`, { mode: 0o600 });
    enableProvider("antigravity-oauth");

    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.configured, false);
    assert.equal(provider?.disconnectable, true);
    assert.equal(provider?.credentialLabel, "Operator OAuth client");
    assert.equal(provider?.action, "login");
    assert.ok(readProviderSelection().includes("antigravity-oauth"));
    assert.equal(configuredProviderIds().includes("antigravity-oauth"), false);
    assert.equal(
      selectedConfiguredListedModels().some((model) => model.provider === "antigravity-oauth"),
      false,
    );
    const health = antigravityOAuthHealth();
    assert.equal(health.status, "revoked");
    assert.doesNotMatch(health.fix || "", /disconnect/i);

    const removal = await removeApiCredential("antigravity-oauth");

    assert.equal(removal.removedFiles, 1);
    assert.equal(removal.stillConfigured, false);
    assert.equal(existsSync(tokenPath), false);
    assert.equal(readProviderSelection().includes("antigravity-oauth"), false);
    const disconnected = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(disconnected?.disconnectable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid_client withdraws the route and requires replacing the rejected client", async () => {
  try {
    await saveAntigravityToken({
      ...CLIENT,
      ...VERIFIED,
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    });
    enableProvider("antigravity-oauth");
    assert.equal(antigravityOAuthStatus().configured, true);

    await assert.rejects(
      ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => new Response(
          JSON.stringify({ error: "invalid_client" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      }),
      (error) =>
        error?.code === "oauth_unauthorized" &&
        error?.providerCode === "invalid_client" &&
        /disconnect.*sign in/i.test(error.message),
    );

    const stored = JSON.parse(readFileSync(antigravityTokenPath(), "utf8"));
    assert.equal(stored.access_token, "");
    assert.equal(stored.refresh_token, "");
    assert.equal(stored.probe_version, undefined);
    assert.equal(stored.probe_verified_at, undefined);
    assert.equal(stored.probe_model, undefined);
    assert.equal(stored.probe_activation, undefined);
    assert.equal(stored.client_id, CLIENT.client_id);
    assert.equal(stored.client_secret, CLIENT.client_secret);
    assert.equal(stored.rejection_reason, "invalid_client");

    const status = antigravityOAuthStatus();
    assert.equal(status.configured, false);
    assert.equal(status.clientReady, false);
    assert.equal(status.reconnectRequired, true);
    assert.match(status.setup || "", /disconnect.*login/i);
    assert.equal(configuredProviderIds().includes("antigravity-oauth"), false);
    assert.equal(
      selectedConfiguredListedModels().some((model) => model.provider === "antigravity-oauth"),
      false,
    );

    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.configured, false);
    assert.equal(provider?.disconnectable, true);
    assert.equal(provider?.action, "blocked");
    assert.match(provider?.blockedNote || "", /rejected.*Disconnect/i);

    const health = antigravityOAuthHealth();
    assert.equal(health.status, "revoked");
    assert.match(health.detail, /client.*rejected/i);
    assert.match(health.fix || "", /disconnect.*login/i);

    // Preserve enabled intent only in the private selection file. Every
    // publishable-model reader has already withdrawn the unusable route, and
    // the required explicit disconnect will remove the stale selection.
    assert.equal(readProviderSelection().includes("antigravity-oauth"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an incompatible legacy record is preserved and blocked until explicit disconnect", async () => {
  try {
    const tokenPath = antigravityTokenPath();
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    const legacy = `${JSON.stringify({
      version: 1,
      access_token: "legacy-access",
      refresh_token: "legacy-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    })}\n`;
    writeFileSync(tokenPath, legacy, { mode: 0o600 });

    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.configured, false);
    assert.equal(provider?.disconnectable, true);
    assert.equal(provider?.action, "blocked");
    assert.match(provider?.blockedNote || "", /preserved.*Disconnect/i);
    assert.match(antigravityOAuthHealth().fix || "", /disconnect/i);
    assert.equal(existsSync(tokenPath), true);

    const removal = await removeApiCredential("antigravity-oauth");
    assert.equal(removal.removedFiles, 1);
    assert.equal(existsSync(tokenPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor permission repair protects an existing Antigravity token", {
  skip: process.platform === "win32" ? "chmod cannot widen the Windows ACL fixture" : false,
}, async () => {
  try {
    await saveAntigravityToken({
      ...CLIENT,
      ...VERIFIED,
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    });
    chmodSync(antigravityTokenPath(), 0o644);
    assert.equal(antigravityOAuthHealth().status, "insecure");
    assert.equal(antigravityOAuthStatus().configured, false);
    assert.deepEqual(antigravityOAuthStartupState(), { startForwarder: false });

    assert.equal(repairAntigravityOAuthPermissions(), antigravityTokenPath());
    assert.equal(antigravityOAuthHealth().status, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
