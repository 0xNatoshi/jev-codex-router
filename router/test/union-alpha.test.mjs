import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "union-alpha-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG, PROVIDERS } = await import("../src/model-registry.mjs");
const {
  OPENCODE_MESSAGE_CONTENT_LIMIT,
  UNION_ALPHA_COMPLETION_CAP,
  clampOpenCodeMessageContent,
  clampUnionAlphaCompletion,
  contentChars,
  isUnionAlphaMessagesRoute,
  openCodeOversizedImageNotice,
} = await import("../src/union-alpha-compat.mjs");

test("OpenCode Go Messages Union Alpha compacts above the Desktop tool floor", () => {
  const model = MODEL_BY_SLUG.get("opencode-go-messages/union-alpha");
  assert.equal(PROVIDERS.get(model.provider).protocol, "anthropic");
  assert.equal(model.contextWindow, 262_144);
  assert.equal(model.autoCompact, 180_000);
  assert.equal(model.maxOutputTokens, UNION_ALPHA_COMPLETION_CAP);
  assert.ok(model.autoCompact > 110_000);
  assert.ok(model.autoCompact < model.contextWindow);
  assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["high"]);
  assert.equal(isUnionAlphaMessagesRoute(model), true);
});

test("OpenRouter Union Alpha is a separate route this compact policy does not own", () => {
  const model = MODEL_BY_SLUG.get("openrouter/union-alpha");
  if (!model) return;
  assert.equal(isUnionAlphaMessagesRoute(model), false);
  const payload = { max_tokens: 131_072 };
  assert.equal(clampUnionAlphaCompletion(payload, model), payload);
  assert.equal(payload.max_tokens, 131_072);
});

test("Union Alpha Messages caps an oversized completion budget and leaves smaller ones", () => {
  const model = MODEL_BY_SLUG.get("opencode-go-messages/union-alpha");
  const oversized = { max_tokens: 131_072, max_output_tokens: 200_000 };
  assert.equal(clampUnionAlphaCompletion(oversized, model), oversized);
  assert.equal(oversized.max_tokens, UNION_ALPHA_COMPLETION_CAP);
  assert.equal(oversized.max_output_tokens, UNION_ALPHA_COMPLETION_CAP);

  const modest = { max_tokens: 4096 };
  clampUnionAlphaCompletion(modest, model);
  assert.equal(modest.max_tokens, 4096);
  assert.equal(modest.max_output_tokens, UNION_ALPHA_COMPLETION_CAP);

  const omitted = {};
  clampUnionAlphaCompletion(omitted, model);
  assert.equal(omitted.max_tokens, UNION_ALPHA_COMPLETION_CAP);
  assert.equal(omitted.max_output_tokens, UNION_ALPHA_COMPLETION_CAP);

  const sibling = {
    max_tokens: 131_072,
  };
  clampUnionAlphaCompletion(sibling, MODEL_BY_SLUG.get("opencode-go-messages/minimax-m3"));
  assert.equal(sibling.max_tokens, 131_072);
});

test("OpenCode Messages replaces a Console Go-oversized ImageGen data URL", () => {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
  const huge = `data:image/png;base64,${"A".repeat(2_700_000)}`;
  const notice = openCodeOversizedImageNotice();
  assert.match(notice, new RegExp(String(OPENCODE_MESSAGE_CONTENT_LIMIT)));

  const original = [
    { role: "user", content: "look at the vehicle sheet" },
    { role: "assistant", content: "calling imagegen" },
    { role: "user", content: huge },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: huge } }],
    },
    {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2_700_000) } }],
    },
    { role: "user", content: [{ type: "image_url", image_url: { url: pixel } }] },
  ];
  const clamped = clampOpenCodeMessageContent(original);
  assert.equal(clamped[0], original[0]);
  assert.equal(clamped[1], original[1]);
  assert.equal(clamped[2].content, notice);
  assert.deepEqual(clamped[3].content, [{ type: "text", text: notice }]);
  assert.deepEqual(clamped[4].content, [{ type: "text", text: notice }]);
  assert.equal(clamped[5], original[5]);
  assert.ok(contentChars(clamped[2].content) < OPENCODE_MESSAGE_CONTENT_LIMIT);
  assert.ok(contentChars(clamped[3].content) < OPENCODE_MESSAGE_CONTENT_LIMIT);
  assert.ok(!JSON.stringify(clamped).includes("A".repeat(1000)));
});
