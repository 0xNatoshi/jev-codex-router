import assert from "node:assert/strict";
import test from "node:test";

import {
  isProviderPrefixedSlug,
  UNROUTED_MODEL_CODE,
  unroutedModelError,
} from "../src/unrouted-model.mjs";

test("only provider-prefixed slugs are candidates for the local refusal", () => {
  assert.equal(isProviderPrefixedSlug("unorouter/gpt-6-astra"), true);
  assert.equal(isProviderPrefixedSlug("openrouter/vendor/model"), true);
  // Native GPT slugs, context variants, and image/search models never carry a
  // provider prefix, so they keep their native passthrough.
  for (const slug of ["gpt-6-astra", "gpt-5.6-sol-1m", "codex-auto-review", "gpt-image-2", "", undefined]) {
    assert.equal(isProviderPrefixedSlug(slug), false, String(slug));
  }
});

test("the refusal is an OpenAI-style invalid_request_error that names the slug", () => {
  const body = unroutedModelError("unorouter/gpt-6-astra", {});
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.code, UNROUTED_MODEL_CODE);
  assert.equal(body.error.param, "model");
  assert.match(body.error.message, /"unorouter\/gpt-6-astra" has no route in this running router/);
  assert.match(body.error.message, /not sent to ChatGPT|instead of being sent to ChatGPT/);
  assert.match(body.error.message, /No enabled provider named "unorouter"/);
  assert.match(body.error.message, /bin\/control service restart/);
  assert.match(body.error.message, /user-models\.json/);
  assert.match(body.error.message, /bin\/curate-models unorouter/);
});

test("the refusal distinguishes an enabled provider, a hidden one, and a skipped entry", () => {
  const enabled = unroutedModelError("unorouter/gpt-6-astra", {
    provider: { id: "unorouter", generic: true },
    providerEnabled: true,
    skippedReason: "model unorouter/gpt-6-astra may not declare multiAgentVersion v2",
  });
  assert.match(enabled.error.message, /Provider "unorouter" is registered and enabled/);
  assert.match(
    enabled.error.message,
    /skipped the user model with this slug: model unorouter\/gpt-6-astra may not declare multiAgentVersion v2\./,
  );

  const hidden = unroutedModelError("deepseek/deepseek-typo", {
    provider: { id: "deepseek" },
    providerEnabled: false,
  });
  assert.match(hidden.error.message, /Provider "deepseek" is registered but not enabled; run bin\/providers enable deepseek\./);
  assert.doesNotMatch(hidden.error.message, /skipped/);
});

test("the refusal bounds caller-controlled text and carries no URL", () => {
  const long = `${"p".repeat(500)}/${"m".repeat(500)}`;
  const body = unroutedModelError(long, {});
  assert.ok(body.error.message.length < 1_200, String(body.error.message.length));
  assert.doesNotMatch(body.error.message, /https?:\/\//);

  const leading = unroutedModelError("/model", {});
  assert.match(leading.error.message, /does not start with a provider id/);
  assert.match(leading.error.message, /bin\/curate-models PROVIDER/);
});
