import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  doctorRestartRequired,
  maintenanceSourceRoot,
  runCodexMaintenance,
} from "../src/codex-maintenance.mjs";

test("maintenance targets the checkout that owns the installed router", () => {
  const owner = mkdtempSync(path.join(os.tmpdir(), "codex-router-owner-"));
  try {
    mkdirSync(path.join(owner, ".git"));
    const manifest = {
      version: 1,
      current: { sourceRoot: owner },
    };
    assert.equal(
      maintenanceSourceRoot("/Users/example/Code/codex-router", manifest),
      owner,
    );
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

test("maintenance falls back to the tray checkout when no owner exists", () => {
  assert.equal(
    maintenanceSourceRoot("/Users/example/Code/codex-router", {
      version: 1,
      current: {},
    }),
    "/Users/example/Code/codex-router",
  );
});

test("tray maintenance runs update before doctor", () => {
  const calls = [];
  const sourceRoot = path.resolve("router");
  const runner = (command, args, options) => {
    calls.push({ command, args, target: options.env.MODEL_ROUTER_TARGET });
    if (args.at(-1) === "--json") {
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, checks: [{ status: "ok", name: "Agents" }] }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };

  const result = runCodexMaintenance({
    sourceRoot,
    runner,
    executable: "/node",
    environment: {},
  });

  assert.deepEqual(calls, [
    {
      command: "/node",
      args: [path.join(sourceRoot, "src", "update.mjs"), "update"],
      target: "codex",
    },
    {
      command: "/node",
      args: [path.join(sourceRoot, "src", "doctor.mjs"), "--json"],
      target: "codex",
    },
  ]);
  assert.deepEqual(result, {
    updated: true,
    verified: true,
    restartRequired: false,
    checks: 1,
  });
});

test("a stale in-memory Codex catalog completes maintenance and requests a restart", () => {
  let call = 0;
  const runner = () => {
    call += 1;
    if (call === 1) return { status: 0, stdout: "{}", stderr: "" };
    return {
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        checks: [
          {
            status: "warn",
            name: "Codex model catalog",
            detail: "startup catalog is stale",
          },
        ],
      }),
      stderr: "",
    };
  };

  assert.deepEqual(runCodexMaintenance({ sourceRoot: "/router", runner }), {
    updated: true,
    verified: true,
    restartRequired: true,
    checks: 1,
  });
});

test("only the stale startup catalog is classified as restart-required", () => {
  assert.equal(
    doctorRestartRequired({
      checks: [
        {
          status: "warn",
          name: "Codex model catalog",
          detail: "Codex debug models timed out",
        },
      ],
    }),
    false,
  );
  assert.equal(
    doctorRestartRequired({
      checks: [
        {
          status: "fail",
          name: "Codex model catalog",
          detail: "startup catalog is stale",
        },
      ],
    }),
    false,
  );
});

test("tray maintenance summarizes failed doctor checks", () => {
  let call = 0;
  const runner = () => {
    call += 1;
    if (call === 1) return { status: 0, stdout: "{}", stderr: "" };
    return {
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        checks: [
          { status: "fail", name: "Routed model agents" },
          { status: "ok", name: "Background service" },
        ],
      }),
      stderr: "",
    };
  };

  assert.throws(
    () => runCodexMaintenance({ sourceRoot: "/router", runner }),
    /Doctor found problems: Routed model agents\./,
  );
});
