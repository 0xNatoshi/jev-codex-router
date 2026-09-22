import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-source-"));
const codexHome = path.join(testRoot, "codex");
const stateDir = path.join(testRoot, "state");
process.env.CODEX_HOME = codexHome;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  activateNativeCatalogSource,
  clearNativeCatalogSource,
  prepareNativeCatalogSourceFromConfig,
  readNativeCatalogFile,
  readNativeCatalogSource,
} = await import("../src/native-catalog-source.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

const configPath = path.join(codexHome, "config.toml");
const sourceStatePath = path.join(stateDir, "native-catalog-source.json");

function reset() {
  if (existsSync(configPath)) rmSync(configPath);
  if (existsSync(sourceStatePath)) rmSync(sourceStatePath);
  mkdirSync(codexHome, { recursive: true });
}

test("native catalog adoption is pending until config activation", () => {
  reset();
  const catalogPath = path.join(testRoot, "user catalog's", "models.json");
  mkdirSync(path.dirname(catalogPath), { recursive: true });
  writeFileSync(
    catalogPath,
    `${JSON.stringify({ models: [{ slug: "gpt-user-native" }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    configPath,
    `model_catalog_json = ${JSON.stringify(catalogPath)}\n`,
    { mode: 0o600 },
  );

  const prepared = prepareNativeCatalogSourceFromConfig();
  assert.equal(prepared.created, true);
  assert.deepEqual(readNativeCatalogSource(), {
    version: 1,
    path: catalogPath,
    status: "pending",
  });
  assert.equal(privateFileIsProtected(sourceStatePath), true);
  assert.equal(clearNativeCatalogSource({ pendingOnly: true }), true);
  assert.equal(existsSync(sourceStatePath), false);

  prepareNativeCatalogSourceFromConfig();
  activateNativeCatalogSource();
  assert.equal(readNativeCatalogSource().status, "active");
  assert.equal(clearNativeCatalogSource({ pendingOnly: true }), false);
  assert.equal(existsSync(sourceStatePath), true);
  assert.equal(clearNativeCatalogSource(), true);
});

test("native catalog adoption rejects custom routing and routed slugs", () => {
  reset();
  const catalogPath = path.join(testRoot, "invalid-models.json");
  writeFileSync(
    catalogPath,
    `${JSON.stringify({ models: [{ slug: "kimi-oauth/k3" }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    configPath,
    `openai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`,
    { mode: 0o600 },
  );
  assert.equal(readNativeCatalogFile(catalogPath), undefined);
  assert.throws(
    () => prepareNativeCatalogSourceFromConfig(),
    /no openai_base_url/,
  );

  writeFileSync(
    configPath,
    `model_catalog_json = ${JSON.stringify(catalogPath)}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => prepareNativeCatalogSourceFromConfig(),
    /invalid native model catalog/,
  );
  assert.equal(existsSync(sourceStatePath), false);
});

test.after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});
