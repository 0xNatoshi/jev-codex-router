import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CODEX_ROUTER_STATE_DIR = mkdtempSync(
  path.join(os.tmpdir(), "jev-fallback-test-"),
);

const { jevFallbackCandidates } = await import("../src/jev-fallback.mjs");

const cloud = {
  slug: "deepseek/deepseek-v4.1-flash",
  provider: "deepseek",
  upstreamModel: "deepseek-v4.1-flash",
  contextWindow: 1_000_000,
  priority: 20,
  inputModalities: ["text", "image"],
  multiAgentVersion: "v2",
};
const jev = {
  slug: "jev/auto",
  provider: "jev",
  upstreamModel: "auto",
  contextWindow: 258_400,
  priority: 1,
};
const local = {
  slug: "local/qwen3:8b",
  provider: "local",
  upstreamModel: "qwen3:8b",
  contextWindow: 32_768,
  priority: 900,
  inputModalities: ["text"],
};
const lmstudio = {
  slug: "lmstudio/qwen3-coder",
  provider: "lmstudio",
  upstreamModel: "qwen3-coder",
  contextWindow: 32_768,
  priority: 950,
  inputModalities: ["text"],
};
const cloudSibling = {
  ...cloud,
  slug: "deepseek/deepseek-v4.1-flash-alias",
  upstreamModel: "deepseek-v4.1-flash-alias",
  priority: 21,
};
const secondCloud = {
  ...cloud,
  slug: "zai-api/glm-5.2",
  provider: "zai-api",
  upstreamModel: "glm-5.2",
  priority: 22,
};

function candidates(overrides = {}) {
  return jevFallbackCandidates({
    models: [jev, cloud, local, lmstudio],
    hidden: new Set(),
    settings: { enabled: true, chain: [] },
    agentChecks: { "qwen3:8b": { agentCapable: true } },
    localRuntime: { running: true },
    limit: 3,
    ...overrides,
  });
}

test("fallback candidates exclude jev and admit only a live qualified local model", () => {
  assert.deepEqual(
    candidates().map((entry) => entry.slug),
    ["local/qwen3:8b", "deepseek/deepseek-v4.1-flash"],
  );
  assert.equal(candidates()[0].local, true);
});

test("an offline or unqualified local model is never selected automatically", () => {
  assert.deepEqual(
    candidates({ localRuntime: { running: false } }).map((entry) => entry.slug),
    ["deepseek/deepseek-v4.1-flash"],
  );
  assert.deepEqual(
    candidates({ agentChecks: { "qwen3:8b": { agentCapable: false } } })
      .map((entry) => entry.slug),
    ["deepseek/deepseek-v4.1-flash"],
  );
});

test("LM Studio needs both its own live inventory and a real agent qualification", () => {
  assert.deepEqual(
    candidates({
      agentChecks: {
        "qwen3:8b": { agentCapable: true },
        "lmstudio/qwen3-coder": { agentCapable: true },
      },
      lmstudioRuntime: { reachable: true, models: ["qwen3-coder"] },
    }).map((entry) => entry.slug),
    [
      "local/qwen3:8b",
      "lmstudio/qwen3-coder",
      "deepseek/deepseek-v4.1-flash",
    ],
  );
  assert.ok(!candidates({
    agentChecks: { "lmstudio/qwen3-coder": { agentCapable: true } },
    lmstudioRuntime: { reachable: false, models: [] },
  }).some((entry) => entry.slug === "lmstudio/qwen3-coder"));
});

test("an explicit chain cannot reintroduce jev recursion or an unqualified local route", () => {
  assert.deepEqual(
    candidates({
      settings: {
        enabled: true,
        chain: ["jev/auto", "local/qwen3:8b", "deepseek/deepseek-v4.1-flash"],
      },
      agentChecks: {},
    }).map((entry) => entry.slug),
    ["deepseek/deepseek-v4.1-flash"],
  );
});

test("context and capability requirements are applied before the bounded plan", () => {
  assert.deepEqual(
    candidates({ estimatedTokens: 40_000 }).map((entry) => entry.slug),
    ["deepseek/deepseek-v4.1-flash"],
  );
  assert.deepEqual(
    candidates({ needsMultiAgentV2: true }).map((entry) => entry.slug),
    ["deepseek/deepseek-v4.1-flash"],
  );
});

test("the operator's global failover switch disables dynamic Jev candidates", () => {
  assert.deepEqual(
    candidates({ settings: { enabled: false, chain: [] } }),
    [],
  );
});

test("duplicate routes and quota siblings do not consume the bounded fallback plan", () => {
  assert.deepEqual(
    candidates({
      models: [cloud, cloudSibling, secondCloud],
      settings: {
        enabled: true,
        chain: [cloud.slug, cloud.slug, cloudSibling.slug, secondCloud.slug],
      },
      limit: 2,
    }).map((entry) => entry.slug),
    [cloud.slug, secondCloud.slug],
  );
});
