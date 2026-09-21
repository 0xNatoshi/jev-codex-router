import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-search-control-"));
process.env.MODEL_ROUTER_SEARCH_SIDECARS = path.join(directory, "search-sidecars.json");

const { runSearchSidecarControl } = await import("../src/search-sidecar-control.mjs");
const { readSearchSidecarState } = await import("../src/search-sidecar-state.mjs");

const model = { slug: "deepseek/deepseek-v4-pro" };
const provider = {
  id: "perplexity-sidecar",
  displayName: "Perplexity Search",
  baseUrl: "https://api.perplexity.ai",
  adapter: "openai-chat",
  headers: {},
  credentialRef: "cred_perplexity_sidecar_01",
  allowPrivate: false,
  enabled: true,
};

function dependencies(output, calls) {
  return {
    output,
    modelForSlug: (slug) => slug === model.slug ? model : undefined,
    providerForId: (id) => {
      if (id !== provider.id) throw new Error(`Unknown generic provider: ${id}`);
      return provider;
    },
    providerReady: () => true,
    transact: async ({ mutate, applyPublication }) => {
      calls.push("mutate");
      await mutate();
      calls.push("publish");
      await applyPublication();
    },
    applyPublication: async () => {},
    restartHint: () => "Restart Codex to refresh the model picker.",
  };
}

test.after(() => rmSync(directory, { recursive: true, force: true }));

test("search sidecar control validates, republishes, and manages the exact model binding", async () => {
  let text = "";
  const calls = [];
  const output = { write(chunk) { text += chunk; return true; } };
  await runSearchSidecarControl([
    "set",
    model.slug,
    provider.id,
    "--timeout-ms",
    "2000",
    "--max-results",
    "6",
  ], dependencies(output, calls));
  assert.deepEqual(calls, ["mutate", "publish"]);
  assert.match(text, /Restart Codex/);
  assert.deepEqual(readSearchSidecarState().bindings, [{
    model: model.slug,
    providerId: provider.id,
    adapter: "perplexity-search",
    enabled: true,
    timeoutMs: 2_000,
    maxResults: 6,
    cacheTtlMs: 60_000,
    cacheMaxEntries: 128,
    maxAttempts: 2,
    retryDelayMs: 100,
  }]);

  text = "";
  await runSearchSidecarControl(["disable", model.slug], dependencies(output, calls));
  assert.equal(readSearchSidecarState().bindings[0].enabled, false);
  await runSearchSidecarControl(["enable", model.slug], dependencies(output, calls));
  assert.equal(readSearchSidecarState().bindings[0].enabled, true);
  await runSearchSidecarControl(["remove", model.slug], dependencies(output, calls));
  assert.deepEqual(readSearchSidecarState().bindings, []);
});

test("search sidecar control rejects unknown options and unsafe or ineligible bindings", async () => {
  const output = { write() { return true; } };
  await assert.rejects(
    () => runSearchSidecarControl(
      ["set", model.slug, provider.id, "--unknown", "1"],
      dependencies(output, []),
    ),
    /supported integer option/,
  );
  await assert.rejects(
    () => runSearchSidecarControl(
      ["set", model.slug, provider.id],
      {
        ...dependencies(output, []),
        providerForId: () => ({ ...provider, allowPrivate: true }),
      },
    ),
    /enabled credential-bound.*Perplexity/i,
  );
  await assert.rejects(
    () => runSearchSidecarControl(
      ["set", model.slug, provider.id],
      {
        ...dependencies(output, []),
        modelForSlug: () => ({ ...model, searchTool: { mode: "hosted" } }),
      },
    ),
    /already has hosted search/,
  );
});

test("the top-level wrapper refuses this Codex-only control on other targets", () => {
  const result = spawnSync("sh", ["bin/model-router", "dsh", "search-sidecar", "status"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only for the Codex target/);
});
