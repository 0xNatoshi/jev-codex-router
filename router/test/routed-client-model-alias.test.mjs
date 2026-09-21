import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-client-alias-"));
const stateDir = path.join(root, "state");
const pickerPath = path.join(stateDir, "model-picker.json");
const oldSlug = "opencode-go/grok-4.5";
const newSlug = "opencode-go-responses/grok-4.5";

process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_MODEL_PICKER_STATE = pickerPath;

mkdirSync(stateDir, { recursive: true });
writeFileSync(
  path.join(stateDir, "enabled-providers.json"),
  `${JSON.stringify({ version: 1, providers: ["opencode-go"] })}\n`,
  "utf8",
);
writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "test-key\n", "utf8");

const { dshRoutedModels } = await import("../src/dsh-config-manager.mjs");
const { geminiRoutedModels } = await import("../src/gemini-config-manager.mjs");

function stageLegacyPickerDecision() {
  writeFileSync(
    pickerPath,
    `${JSON.stringify({ version: 1, hidden: [], visible: [oldSlug], seeded: [oldSlug] })}\n`,
    "utf8",
  );
}

function assertMigratedBy(publisher) {
  stageLegacyPickerDecision();
  const published = publisher().models.map((model) => model.slug);
  assert.deepEqual(published, [newSlug]);
  const picker = JSON.parse(readFileSync(pickerPath, "utf8"));
  assert.deepEqual(picker.visible, [newSlug]);
  assert.deepEqual(picker.seeded, [newSlug]);
  assert.equal(picker.visible.includes(oldSlug), false);
}

test("a DSH-only publisher migrates an explicit legacy slug before filtering", () => {
  assertMigratedBy(dshRoutedModels);
});

test("a Gemini-only publisher migrates an explicit legacy slug before filtering", () => {
  assertMigratedBy(geminiRoutedModels);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
