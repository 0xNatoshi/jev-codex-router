import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(directory, providersFile, userModelsFile) {
  return {
    ...process.env,
    HOME: directory,
    CODEX_HOME: path.join(directory, "codex"),
    CODEX_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(directory, "state", "model-picker.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_SKIP_SYSTEMCTL: "1",
  };
}

function provider(id, adapter = "openai-chat", extra = {}) {
  return {
    id,
    displayName: `Runtime ${id}`,
    baseUrl: `https://${id}.example.test/v1`,
    adapter,
    headers: { "X-Routing-Metadata": `private-${id}` },
    enabled: true,
    allowPrivate: false,
    ...extra,
  };
}

function runJson(script, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("runtime providers merge enabled generic descriptors without changing checked-in authority", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-runtime-registry-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const providers = [
    provider("runtime-chat"),
    provider("runtime-responses", "openai-responses"),
    provider("runtime-completions", "openai-completions"),
    provider("runtime-needs-key", "openai-chat", {
      credentialRef: "cred_runtime_needs_key_01",
    }),
    provider("runtime-disabled", "openai-chat", { enabled: false }),
  ];
  const models = [
    userModelEntry({
      providerId: "runtime-chat",
      upstreamId: "vendor/model-a",
      requestProfile: "codex-encrypted-schema",
      priority: 100,
    }),
    userModelEntry({
      providerId: "runtime-responses",
      upstreamId: "vendor/model-b",
      requestProfile: "auto-tool-choice",
      priority: 101,
    }),
    userModelEntry({
      providerId: "runtime-chat",
      upstreamId: "vendor/forged-profile",
      requestProfile: "qwen-plan",
      priority: 102,
    }),
    userModelEntry({
      providerId: "runtime-completions",
      upstreamId: "legacy-text-model",
      priority: 103,
    }),
    userModelEntry({
      providerId: "runtime-needs-key",
      upstreamId: "credential-bound-model",
      priority: 104,
    }),
    userModelEntry({
      providerId: "runtime-disabled",
      upstreamId: "disabled-model",
      priority: 105,
    }),
    userModelEntry({
      providerId: "runtime-removed",
      upstreamId: "removed-model",
      priority: 106,
    }),
  ];
  writeFileSync(providersFile, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models }, null, 2)}\n`);

  try {
    const result = runJson(`
      const registry = await import("./src/model-registry.mjs");
      const selection = await import("./src/provider-selection.mjs");
      selection.writeProviderSelection(["deepseek"]);
      const genericModels = registry.MODELS.filter((model) => model.provider.startsWith("runtime-"));
      process.stdout.write(JSON.stringify({
        checkedInHasGeneric: registry.PROVIDERS.has("runtime-chat"),
        runtimeProviders: [...registry.RUNTIME_PROVIDERS.keys()].filter((id) => id.startsWith("runtime-")).sort(),
        descriptors: [...registry.RUNTIME_PROVIDERS.values()]
          .filter((entry) => entry.generic === true)
          .map((entry) => ({ id: entry.id, adapter: entry.adapter, protocol: entry.protocol, headers: entry.headers })),
        models: genericModels.map((model) => ({ slug: model.slug, requestProfile: model.requestProfile })),
        apiModels: registry.API_MODELS.filter((model) => model.provider.startsWith("runtime-")).map((model) => model.slug),
        selectedConfigured: selection.selectedConfiguredListedModels()
          .filter((model) => model.provider.startsWith("runtime-"))
          .map((model) => model.slug),
        persistedSelection: selection.providerSelectionStatus().providers,
        warnings: registry.USER_MODEL_WARNINGS,
        runtimeWarnings: registry.RUNTIME_PROVIDER_WARNINGS,
      }));
    `, environment(directory, providersFile, userModelsFile));

    assert.equal(result.checkedInHasGeneric, false);
    assert.deepEqual(result.runtimeProviders, [
      "runtime-chat",
      "runtime-completions",
      "runtime-needs-key",
      "runtime-responses",
    ]);
    assert.deepEqual(result.models, [
      { slug: "runtime-chat/vendor/model-a", requestProfile: "codex-encrypted-schema" },
      { slug: "runtime-responses/vendor/model-b", requestProfile: "auto-tool-choice" },
      { slug: "runtime-needs-key/credential-bound-model" },
    ]);
    assert.deepEqual(result.apiModels, [
      "runtime-chat/vendor/model-a",
      "runtime-responses/vendor/model-b",
      "runtime-needs-key/credential-bound-model",
    ]);
    assert.deepEqual(result.selectedConfigured, [
      "runtime-chat/vendor/model-a",
      "runtime-responses/vendor/model-b",
    ]);
    assert.deepEqual(result.persistedSelection, ["deepseek"]);
    assert.ok(result.descriptors.every(({ headers }) => (
      headers["X-Routing-Metadata"] === "[redacted]"
    )));
    assert.equal(JSON.stringify(result).includes("private-runtime"), false);
    assert.equal(result.runtimeWarnings.length, 0);
    assert.ok(result.warnings.some((warning) => /explicitly curatable requestProfile/.test(warning)));
    assert.ok(result.warnings.some((warning) => /unsupported openai-completions publication/.test(warning)));
    assert.ok(result.warnings.some((warning) => /unknown provider runtime-disabled/.test(warning)));
    assert.ok(result.warnings.some((warning) => /unknown provider runtime-removed/.test(warning)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid generic state fails closed while built-in providers remain usable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-runtime-invalid-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const env = environment(directory, providersFile, userModelsFile);
  try {
    const diagnosticSecret = "STATIC_HEADER_VALUE_MUST_NOT_LEAK";
    writeFileSync(providersFile, `${diagnosticSecret} is not json\n`);
    const malformed = runJson(`
      const registry = await import("./src/model-registry.mjs");
      process.stdout.write(JSON.stringify({
        sameProviders: [...registry.PROVIDERS.keys()].every((id) => registry.RUNTIME_PROVIDERS.get(id) === registry.PROVIDERS.get(id)) &&
          registry.PROVIDERS.size === registry.RUNTIME_PROVIDERS.size,
        deepseek: registry.RUNTIME_PROVIDERS.get("deepseek")?.displayName,
        warnings: registry.RUNTIME_PROVIDER_WARNINGS,
      }));
    `, env);
    assert.equal(malformed.sameProviders, true);
    assert.ok(malformed.deepseek);
    assert.match(malformed.warnings[0], /Ignored generic provider state: Invalid generic provider state/);
    assert.equal(JSON.stringify(malformed).includes(diagnosticSecret), false);

    writeFileSync(providersFile, `${JSON.stringify({
      version: 1,
      providers: [provider("deepseek")],
    })}\n`);
    const collision = runJson(`
      const registry = await import("./src/model-registry.mjs?collision");
      process.stdout.write(JSON.stringify({
        sameProviders: [...registry.PROVIDERS.keys()].every((id) => registry.RUNTIME_PROVIDERS.get(id) === registry.PROVIDERS.get(id)) &&
          registry.PROVIDERS.size === registry.RUNTIME_PROVIDERS.size,
        genericDeepseek: registry.RUNTIME_PROVIDERS.get("deepseek")?.generic === true,
        warnings: registry.RUNTIME_PROVIDER_WARNINGS,
      }));
    `, env);
    assert.equal(collision.sameProviders, true);
    assert.equal(collision.genericDeepseek, false);
    assert.match(collision.warnings[0], /already used by the built-in registry/);

    writeFileSync(providersFile, `${JSON.stringify({
      version: 1,
      providers: [
        provider("otherwise-valid", "openai-chat", {
          headers: { "X-Routing-Metadata": diagnosticSecret },
        }),
        provider("invalid-sibling", "openai-chat", { enabled: "yes" }),
      ],
    })}\n`);
    const invalidSibling = runJson(`
      const registry = await import("./src/model-registry.mjs?invalid-sibling");
      process.stdout.write(JSON.stringify({
        sameProviders: [...registry.PROVIDERS.keys()].every((id) => registry.RUNTIME_PROVIDERS.get(id) === registry.PROVIDERS.get(id)) &&
          registry.PROVIDERS.size === registry.RUNTIME_PROVIDERS.size,
        warnings: registry.RUNTIME_PROVIDER_WARNINGS,
      }));
    `, env);
    assert.equal(invalidSibling.sameProviders, true);
    assert.match(invalidSibling.warnings[0], /enabled must be a boolean/);
    assert.equal(JSON.stringify(invalidSibling).includes(diagnosticSecret), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generic discovery stays non-authoritative and curation stores only explicit closed profiles", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-runtime-curation-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const fixtureFile = path.join(directory, "models.json");
  const providers = [
    provider("runtime-chat"),
    provider("runtime-completions", "openai-completions"),
  ];
  const fixture = {
    object: "list",
    data: [
      {
        id: "vendor/model-a",
        context_length: 200_000,
        requestProfile: "qwen-plan",
      },
      {
        id: "vendor/model-b",
        context_length: 400_000,
        requestProfile: "anthropic-reasoning",
      },
    ],
  };
  writeFileSync(providersFile, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`);
  writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
  const env = environment(directory, providersFile, userModelsFile);

  try {
    const discovery = spawnSync(
      process.execPath,
      ["src/model-discovery.mjs", "runtime-chat", "--fixture", fixtureFile, "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    const discovered = JSON.parse(discovery.stdout);
    assert.deepEqual(discovered.addable, ["vendor/model-a", "vendor/model-b"]);
    assert.deepEqual(discovered.contextLengths, {
      "vendor/model-a": 200_000,
      "vendor/model-b": 400_000,
    });
    assert.ok(discovered.modelMetadata.every((model) => model.requestProfile === undefined));
    assert.equal(JSON.stringify(discovered).includes("private-runtime-chat"), false);

    const curation = spawnSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "runtime-chat",
        "--fixture",
        fixtureFile,
        "--models",
        "vendor/model-a,vendor/model-b",
        "--request-profile",
        "codex-encrypted-schema",
        "--no-apply",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(curation.status, 0, curation.stderr);
    const stored = JSON.parse(readFileSync(userModelsFile, "utf8")).models;
    assert.deepEqual(stored.map((model) => model.slug), [
      "runtime-chat/vendor/model-a",
      "runtime-chat/vendor/model-b",
    ]);
    assert.ok(stored.every((model) => model.requestProfile === "codex-encrypted-schema"));
    assert.deepEqual(stored.map((model) => model.contextWindow), [200_000, 400_000]);

    const untrustedProfile = spawnSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "runtime-chat",
        "--fixture",
        fixtureFile,
        "--models",
        "vendor/model-a",
        "--request-profile",
        "qwen-plan",
        "--no-apply",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(untrustedProfile.status, 2);
    assert.match(untrustedProfile.stderr, /Unknown request profile/);

    const completionsDiscovery = spawnSync(
      process.execPath,
      ["src/model-discovery.mjs", "runtime-completions", "--fixture", fixtureFile, "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(completionsDiscovery.status, 0, completionsDiscovery.stderr);
    const legacy = JSON.parse(completionsDiscovery.stdout);
    assert.deepEqual(legacy.addable, []);
    assert.deepEqual(Object.keys(legacy.blocked), ["vendor/model-a", "vendor/model-b"]);

    const completionsCuration = spawnSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "runtime-completions",
        "--fixture",
        fixtureFile,
        "--models",
        "vendor/model-a",
        "--no-apply",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(completionsCuration.status, 2);
    assert.match(completionsCuration.stderr, /has no completions caller surface/);
    assert.equal(
      JSON.parse(readFileSync(userModelsFile, "utf8")).models.some(
        (model) => model.provider === "runtime-completions",
      ),
      false,
    );
  } finally {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});
