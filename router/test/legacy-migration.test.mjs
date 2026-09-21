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
import test, { after } from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-migration-"));
const codexHome = path.join(testRoot, "codex");
const launchAgents = path.join(testRoot, "LaunchAgents");
const stateDir = path.join(codexHome, "codex-router");
process.env.CODEX_HOME = codexHome;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_PORT = "46192";
process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR = launchAgents;
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";

// Individual tests tear down what they created; this sweep guarantees the
// shared fixture root itself never outlives the file.
after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const {
  applyKnownMigrations,
  detectLegacyInstallations,
  rollbackLatestMigration,
} = await import("../src/legacy-migration.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test("known prototype migration snapshots, cleans, and restores exact state", () => {
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const plistPath = path.join(launchAgents, "com.ziwenxu.kimi-codex-proxy.plist");
  const prototypeCatalog = path.join(codexHome, "kimi-proxy", "merged-models.json");
  const original = `model = "kimi-oauth/k3"

# BEGIN kimi-codex-router-managed
openai_base_url = "http://127.0.0.1:46192/v1"
model_catalog_json = "${prototypeCatalog}"

[profiles.work]
model_reasoning_effort = "xhigh"
`;
  writeFileSync(configPath, original, { mode: 0o644 });
  writeFileSync(plistPath, "prototype plist\n", { mode: 0o644 });

  try {
    const detected = detectLegacyInstallations();
    assert.deepEqual(detected.installations.map((item) => item.id), ["kimi-proxy-prototype"]);
    assert.equal(detected.unknownConflict, false);

    const migration = applyKnownMigrations();
    assert.equal(migration.migrated, true);
    assert.equal(existsSync(plistPath), false);
    assert.equal(privateFileIsProtected(migration.manifestPath), true);
    assert.equal(privateFileIsProtected(migration.snapshot.configBackup), true);
    const cleaned = readFileSync(configPath, "utf8");
    assert.doesNotMatch(cleaned, /openai_base_url|model_catalog_json|kimi-codex-router-managed/);
    assert.match(cleaned, /model = "kimi-oauth\/k3"/);
    assert.match(cleaned, /\[profiles\.work\]/);

    rollbackLatestMigration();
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(privateFileIsProtected(configPath), true);
    assert.equal(readFileSync(plistPath, "utf8"), "prototype plist\n");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a foreign catalog is an unknown conflict at any TOML spacing", () => {
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const foreign = path.join(testRoot, "some-other-router", "merged-models.json");
  try {
    // `key = "value"` is the conventional TOML spacing, and indented keys are
    // ordinary too. Detection has to see the foreign catalog in every one of
    // these forms: a miss here reports no conflict, which is what clears the
    // router to migrate over an installation it does not own.
    const spacings = [
      `model_catalog_json="${foreign}"`,
      `model_catalog_json = "${foreign}"`,
      `model_catalog_json   =   "${foreign}"`,
      `  model_catalog_json = "${foreign}"`,
      `\tmodel_catalog_json = "${foreign}"`,
      `model_catalog_json = "${foreign}" # user-owned catalog`,
    ];
    for (const line of spacings) {
      writeFileSync(configPath, `model = "gpt-5.6-sol"\n${line}\n`, { mode: 0o644 });
      const detected = detectLegacyInstallations();
      assert.equal(detected.unknownConflict, true, `spacing: ${JSON.stringify(line)}`);
      assert.equal(detected.config.modelCatalogJson, foreign);
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a Windows-shaped catalog path is an unknown conflict, escaped or not", () => {
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  // Windows users write native paths straight into a basic string, and
  // `\U`/`\A` are not TOML escapes. Reading those lines as unparseable reported
  // no conflict at all, which is what clears migration over a foreign install.
  const cases = [
    [String.raw`"C:\Users\me\AppData\Local\other-router\models.json"`, String.raw`C:\Users\me\AppData\Local\other-router\models.json`],
    [String.raw`"C:\\Users\\me\\other-router\\models.json"`, String.raw`C:\Users\me\other-router\models.json`],
    [String.raw`'C:\Users\me\literal\models.json'`, String.raw`C:\Users\me\literal\models.json`],
    [String.raw`"\\\\server\\share\\models.json"`, String.raw`\\server\share\models.json`],
    [String.raw`"C:\\tools\u002Drouter\\models.json"`, String.raw`C:\tools-router\models.json`],
  ];
  try {
    for (const [line, expected] of cases) {
      writeFileSync(configPath, `model_catalog_json = ${line}\n`, { mode: 0o644 });
      const detected = detectLegacyInstallations();
      assert.equal(detected.unknownConflict, true, `line: ${line}`);
      assert.equal(detected.config.modelCatalogJson, expected, `line: ${line}`);
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a valid user-owned native catalog is explicitly adoptable", () => {
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const foreign = path.join(testRoot, "user-native", "models.json");
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(
    foreign,
    `${JSON.stringify({ models: [{ slug: "gpt-user-native" }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    configPath,
    `model_catalog_json = ${JSON.stringify(foreign)}\n`,
    { mode: 0o600 },
  );
  try {
    const detected = detectLegacyInstallations();
    assert.equal(detected.unknownConflict, true);
    assert.equal(detected.adoptableNativeCatalog, true);

    writeFileSync(
      configPath,
      `openai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = ${JSON.stringify(foreign)}\n`,
      { mode: 0o600 },
    );
    assert.equal(detectLegacyInstallations().adoptableNativeCatalog, false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Windows-style escaped catalog paths are not unknown conflicts", () => {
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const catalog = path.join(stateDir, "merged-models.json");
  try {
    // The config manager writes a TOML basic string (JSON escaping) for
    // POSIX paths and, after the literal-string change, a single-quoted
    // literal for Windows paths. Both forms must be recognized as the
    // router's own catalog, never as an unknown conflicting one.
    const variants = [JSON.stringify(catalog), `'${catalog}'`];
    for (const quoted of variants) {
      writeFileSync(
        configPath,
        `model = "gpt-5.6-sol"\nmodel_catalog_json = ${quoted}\n`,
        { mode: 0o644 },
      );
      const detected = detectLegacyInstallations();
      assert.equal(detected.unknownConflict, false, `catalog quoted as ${quoted}`);
      assert.deepEqual(detected.installations, []);
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
