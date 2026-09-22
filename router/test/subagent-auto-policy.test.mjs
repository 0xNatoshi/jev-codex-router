import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "subagent-auto-policy-test-"));
process.env.MODEL_ROUTER_SUBAGENT_AUTO_POLICY = path.join(stateDir, "policies.json");

const {
  matchingSubagentAutoPolicyModels,
  modelMatchesSubagentAutoPolicy,
  readSubagentAutoPolicies,
  setSubagentAutoPolicy,
  SUBAGENT_AUTO_POLICY_PATH,
} = await import("../src/subagent-auto-policy.mjs");

const models = [
  { slug: "deepseek/deepseek-v4-pro", provider: "deepseek", upstreamModel: "deepseek-v4-pro" },
  { slug: "opencode-free/x-preview-f-free", provider: "opencode-free", displayName: "Ox Alpha Free" },
  { slug: "qwen-plan/qwen3.8-max", provider: "qwen-plan", upstreamModel: "qwen3.8-max" },
  { slug: "commandcode/qwen3.8-max", provider: "commandcode", upstreamModel: "Qwen/Qwen3.8-Max" },
  { slug: "kimi-api/kimi-k3", provider: "kimi-api", upstreamModel: "kimi-k3" },
  {
    slug: "opencode-go-messages/kimi-k2.5",
    provider: "opencode-go-messages",
    upstreamModel: "kimi-k2.5",
  },
];

test("provider, model, and family policies match independently", () => {
  setSubagentAutoPolicy("provider", "deepseek", true);
  setSubagentAutoPolicy("model", "opencode-free/x-preview-f-free", true);
  setSubagentAutoPolicy("family", "qwen 3.8", true);
  const matched = matchingSubagentAutoPolicyModels(models).map((model) => model.slug);
  assert.deepEqual(matched, [
    "deepseek/deepseek-v4-pro",
    "opencode-free/x-preview-f-free",
    "qwen-plan/qwen3.8-max",
    "commandcode/qwen3.8-max",
  ]);
});

test("provider policies include protocol variants of the same credential family", () => {
  assert.equal(
    modelMatchesSubagentAutoPolicy(models.at(-1), {
      kind: "provider",
      value: "opencode-go",
    }),
    true,
  );
});

test("policy removal withdraws only that standing permission", () => {
  setSubagentAutoPolicy("family", "qwen 3.8", false);
  assert.deepEqual(
    matchingSubagentAutoPolicyModels(models).map((model) => model.slug),
    ["deepseek/deepseek-v4-pro", "opencode-free/x-preview-f-free"],
  );
});

test("corrupt or invalid policy state authorizes no probes", () => {
  writeFileSync(SUBAGENT_AUTO_POLICY_PATH, "{not json", { mode: 0o600 });
  assert.deepEqual(readSubagentAutoPolicies().policies, []);
  assert.throws(() => setSubagentAutoPolicy("family", "!!", true), /Invalid subagent auto policy/);
});
