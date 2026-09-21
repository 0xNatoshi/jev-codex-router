import assert from "node:assert/strict";
import test from "node:test";

import { nativeCatalogVersionDrift } from "../src/native-catalog-freshness.mjs";

const catalog = (captured_with) => ({
  ...(captured_with === undefined ? {} : { captured_with }),
  models: [{ slug: "gpt-5.6-sol" }],
});

test("native catalog version drift follows router capture ownership", () => {
  assert.equal(nativeCatalogVersionDrift(catalog("codex-cli 0.151.0"), "codex-cli 0.151.0"), undefined);
  assert.deepEqual(nativeCatalogVersionDrift(catalog("codex-cli 0.150.0"), "codex-cli 0.151.0"), {
    captured: "codex-cli 0.150.0",
    current: "codex-cli 0.151.0",
  });
  assert.deepEqual(nativeCatalogVersionDrift(catalog(), "codex-cli 0.151.0"), {
    captured: "unknown build",
    current: "codex-cli 0.151.0",
  });
  assert.equal(nativeCatalogVersionDrift(catalog("codex-cli 0.150.0"), undefined), undefined);
  assert.equal(nativeCatalogVersionDrift(catalog("codex-cli 0.150.0"), "codex-cli 0.151.0", { adopted: true }), undefined);
});
