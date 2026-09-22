import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "native-session-publication-"));
const stateDir = path.join(root, "state");
const authPath = path.join(root, "codex", "auth.json");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.MODEL_ROUTER_CODEX_AUTH = authPath;
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;

mkdirSync(path.dirname(authPath), { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  authPath,
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "test-access", account_id: "test-account" },
  }),
);
writeFileSync(
  path.join(stateDir, "enabled-providers.json"),
  `${JSON.stringify({ version: 1, providers: [] })}\n`,
);
writeFileSync(
  path.join(stateDir, "native-models.json"),
  `${JSON.stringify({
    models: [{
      slug: "gpt-test-native",
      display_name: "GPT Test Native",
      visibility: "list",
      context_window: 128_000,
      input_modalities: ["text"],
    }],
  })}\n`,
);

const { routedClientModels } = await import("../src/routed-client-models.mjs");
const { setNativeSessionSharingEnabled } = await import("../src/codex-native-session.mjs");

test("a usable login is not published until the shared plane is authorized", () => {
  assert.deepEqual(routedClientModels().models, []);

  setNativeSessionSharingEnabled(true);
  assert.deepEqual(
    routedClientModels().models.map((model) => model.slug),
    ["gpt-test-native"],
  );

  setNativeSessionSharingEnabled(false);
  assert.deepEqual(routedClientModels().models, []);
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
