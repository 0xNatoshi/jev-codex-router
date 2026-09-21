import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-dashboard-safe-"));
process.env.MODEL_ROUTER_TARGET = "dsh";
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = path.join(stateDir, "codex");
process.env.KIMI_CODE_HOME = path.join(stateDir, "kimi-code");
process.env.GROK_AUTH_PATH = path.join(stateDir, "grok", "auth.json");
process.env.DEVIN_CREDENTIALS_PATH = path.join(stateDir, "devin", "credentials.toml");
const { PROVIDERS } = await import("../src/model-registry.mjs");
for (const provider of PROVIDERS.values()) {
  for (const name of provider.credential?.environment || []) delete process.env[name];
}

const { routerDashboardState } = await import("../src/router-dashboard.mjs");
const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const {
  disableProvider,
  enableProvider,
  writeProviderSelection,
} = await import("../src/provider-selection.mjs");

writeProviderCredential("deepseek", "TEST_DASHBOARD_DEEPSEEK_KEY");
writeProviderCredential("opencode-go", "TEST_DASHBOARD_OPENCODE_KEY");
writeProviderSelection(["deepseek"]);

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("dashboard snapshot contains only validated route metadata", () => {
  const snapshot = routerDashboardState({
    models: [{
      slug: "deepseek/v4",
      displayName: "DeepSeek V4",
      provider: "deepseek",
      endpoint: "https://provider.invalid/v1",
      credentialRef: "secret-account-id",
      visible: false,
    }],
  });

  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");
  assert.equal(deepseek?.enabled, true);
  assert.deepEqual(snapshot.models, [{
    slug: "deepseek/v4",
    displayName: "DeepSeek V4",
    provider: "deepseek",
    enabled: true,
    visible: false,
  }]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /provider\.invalid|secret-account-id|credential|endpoint|session|account/i);
});

test("dashboard provider rows do not expose protocol variants as extra routes", () => {
  const snapshot = routerDashboardState({ models: [] });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(snapshot.providers.every((provider) => provider.kind && provider.displayName));
  assert.deepEqual(snapshot.enabledProviders, ["deepseek"]);
});

test("a configured provider family survives disable, refresh, and re-enable", () => {
  writeProviderSelection(["deepseek", "opencode-go"]);
  assert.equal(
    routerDashboardState({ models: [] }).providers.find((provider) => provider.id === "opencode-go")?.enabled,
    true,
  );

  assert.deepEqual(disableProvider("opencode-go-messages"), ["deepseek"]);
  const disabled = routerDashboardState({ models: [] });
  const disabledFamily = disabled.providers.filter((provider) => provider.id.startsWith("opencode-go"));
  assert.deepEqual(disabledFamily.map((provider) => provider.id), ["opencode-go"]);
  assert.equal(disabledFamily[0].enabled, false);
  assert.equal(disabled.providers.some((provider) => provider.id === "anthropic-api"), false);

  assert.deepEqual(enableProvider("opencode-go-responses"), ["deepseek", "opencode-go"]);
  const reenabled = routerDashboardState({ models: [] });
  assert.equal(
    reenabled.providers.find((provider) => provider.id === "opencode-go")?.enabled,
    true,
  );
  assert.deepEqual(reenabled.enabledProviders, ["deepseek", "opencode-go"]);
});
