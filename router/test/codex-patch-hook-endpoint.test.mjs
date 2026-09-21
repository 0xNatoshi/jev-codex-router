import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_PATCH_HOOK_BASE_PATH as base, codexPatchHookEndpoint } from "../src/codex-patch-hook-endpoint.mjs";
import { authenticatedRoute, isManagedCodexBaseUrl, redactCallerUrl } from "../src/caller-auth.mjs";

test("only the exact authenticated capability endpoint normalizes", () => {
  for (const suffix of ["", "/responses", "/responses/compact", "/models"]) {
    assert.deepEqual(codexPatchHookEndpoint(base + suffix), { pathname: `/v1${suffix}`, capability: "structured-patch-v1" });
  }
  for (const pathname of ["/v1/responses", base + "0/responses", base.replace("v1", "v2"), "/v1/_codex-router/structured-patch-v2/responses"]) {
    assert.deepEqual(codexPatchHookEndpoint(pathname), { pathname });
  }
});

test("Codex capability bases retain caller authentication and redaction", () => {
  const secret = "test-hook-caller-secret-with-sufficient-length";
  for (const path of [base, `/_codex-router/${secret}${base}`]) {
    assert.equal(isManagedCodexBaseUrl(`http://127.0.0.1:46192${path}`, 46192), true);
    assert.equal(isManagedCodexBaseUrl(`http://127.0.0.1:46192${path}`, 4102), false);
    for (const suffix of ["?hook=true", "#fragment", "/responses"]) {
      assert.equal(isManagedCodexBaseUrl(`http://127.0.0.1:46192${path}${suffix}`, 46192), false);
    }
  }
  assert.equal(authenticatedRoute(`/_codex-router/${secret}${base}/responses`, "wrong"), undefined);
  assert.equal(authenticatedRoute(`/_codex-router/${secret}${base}/responses`, secret), `${base}/responses`);
  assert.equal(redactCallerUrl(`http://127.0.0.1:46192/_codex-router/${secret}${base}`).includes(secret), false);
});
