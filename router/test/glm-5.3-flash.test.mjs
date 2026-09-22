import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "glm-5.3-flash-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// This inventory asserts checked-in metadata only. The Ollama Cloud entry is a
// candidate until its own current-head router-level exact-route certificate is
// recorded; presence in this array is not that proof.
const ROUTES = [
  // Command Code shipped with neither the 400K threshold nor a clamp profile,
  // which is what being absent from this inventory bought it: the provider's
  // house 900K compaction value, and a pre-0.143 Codex sending `xhigh` --
  // the one rung this model names in its own refusal -- straight through.
  ["commandcode/glm-5.3-flash", "z-ai/glm-5.3-flash", "ox-alpha"],
  ["opencode-go/glm-5.3-flash", "glm-5.3-flash", "ox-alpha"],
  ["ollama-cloud/glm-5.3-flash", "glm-5.3-flash:cloud", "ollama-cloud-glm-5-3-flash"],
  ["openrouter/glm-5.3-flash", "z-ai/glm-5.3-flash", "ox-alpha"],
  ["zai-api/glm-5.3-flash", "glm-5.3-flash", "glm-thinking"],
  ["zai-coding/glm-5.3-flash", "glm-5.3-flash", "glm-thinking"],
];

// Every checked-in route reads images, because the model does: Z.ai documents
// GLM-5.3-Flash's input modality as "Video / Image / Text / File" and its
// `image_url` content block, and the full-size GLM-5.3 is the text-only member
// of the family. Three of these entries were written text-only by default --
// never as a measurement, and never with a note -- which sent every pasted
// screenshot through the vision bridge and hid a capability the operator was
// already paying for (#756). The assertion is a set rather than a per-slug
// ternary so a new Flash route cannot quietly ship the same default.
const IMAGE_INPUT = Object.freeze(["text", "image"]);

test("every checked-in GLM-5.3-Flash route records its static metadata", () => {
  for (const [slug, upstreamModel, requestProfile] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
    assert.equal(model.defaultEffort, "max");
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.autoCompact, 400_000);
    assert.deepEqual(model.inputModalities, IMAGE_INPUT, slug);
    assert.equal(model.requestProfile, requestProfile);
  }
});

// A shipped route that no inventory names is a route whose metadata nobody
// rereads: `commandcode/glm-5.3-flash` sat outside ROUTES from the day it was
// added and kept a threshold that contradicts the rule above for two weeks.
// Deriving the expected set from the registry makes the next omission a
// failure here rather than a silent one.
test("the ROUTES inventory names every checked-in GLM-5.3-Flash route", () => {
  const shipped = [...MODEL_BY_SLUG.keys()].filter((slug) => /(^|\/)glm-5\.3-flash$/.test(slug));
  assert.deepEqual(shipped.sort(), ROUTES.map(([slug]) => slug).sort());
});

test("withdrawn or uncertified reseller routes stay absent while direct-proven routes remain", () => {
  for (const slug of [
    "commandcode/ox-alpha",
    "nousresearch/ox-alpha",
    "opencode-free/ox-alpha",
    "openrouter/ox-alpha",
    "venice/ox-alpha",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} should not exist`);
  }
  for (const slug of [
    "nousresearch/glm-5.3-flash",
    "venice/glm-5.3-flash",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} is not route-certified`);
  }
  assert.equal(MODEL_BY_SLUG.has("commandcode/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("openrouter/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-api/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-coding/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("opencode-go/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("ollama-cloud/glm-5.3-flash"), true);
});

// The other half of the same fact. Flash is the multimodal member of the
// family, so widening it must not be read as licence to widen GLM-5.3 itself:
// every provider catalog that publishes both describes the full-size model as
// text-only, and an entry claiming otherwise would have Codex offer a paste the
// upstream refuses.
test("the full-size GLM-5.3 routes stay text-only", () => {
  const fullSize = [...MODEL_BY_SLUG.values()].filter(
    (model) => /(^|\/)glm-5\.3$/.test(model.slug),
  );
  assert.ok(fullSize.length >= 4, "expected the checked-in GLM-5.3 routes");
  for (const model of fullSize) {
    assert.deepEqual(model.inputModalities, ["text"], model.slug);
  }
});

test("Ollama Cloud Flash candidate records its upstream id and request profile", () => {
  assert.equal(MODEL_BY_SLUG.has("ollama-cloud/glm-5.3-flash"), true);
  const model = MODEL_BY_SLUG.get("ollama-cloud/glm-5.3-flash");
  assert.equal(model?.upstreamModel, "glm-5.3-flash:cloud");
  assert.equal(model?.requestProfile, "ollama-cloud-glm-5-3-flash");
});
