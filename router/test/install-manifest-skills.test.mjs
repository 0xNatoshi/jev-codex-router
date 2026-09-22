import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packSkillNames } from "../src/skills-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("recordInstall records the skill pack from the checkout source", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "manifest-skills-"));
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "install-manifest.mjs"), "record"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: stateDir,
          CODEX_HOME: path.join(stateDir, "home"),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const manifest = JSON.parse(output);
    const pack = packSkillNames();
    assert.ok(pack.length >= 4, "pack has at least the 4 core skills");
    assert.deepEqual(manifest.current.skills.names, pack);
    assert.equal(manifest.current.skills.count, pack.length);
    // The recorded manifest on disk matches the stdout record.
    const onDisk = JSON.parse(
      readFileSync(path.join(stateDir, "install-manifest.json"), "utf8"),
    );
    assert.deepEqual(onDisk.current.skills, manifest.current.skills);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
