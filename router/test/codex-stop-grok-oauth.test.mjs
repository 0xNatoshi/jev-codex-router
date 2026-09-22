import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  decideStop,
  isGrokOauthModel,
  lastTurnLooksLikeToolThenStatus,
} from "../hooks/codex-stop-grok-oauth.mjs";

const hookPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hooks/codex-stop-grok-oauth.mjs");

const midTask = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "check the figures" }] },
  { type: "function_call", name: "exec_command", arguments: "{}" },
  { type: "function_call_output", call_id: "c1", output: "wrote figures.png" },
];

test("isGrokOauthModel matches only the OAuth routes", () => {
  assert.equal(isGrokOauthModel("grok-oauth/grok-4.6"), true);
  assert.equal(isGrokOauthModel("grok-oauth"), true);
  assert.equal(isGrokOauthModel("grok-api/grok-4.5"), false);
  assert.equal(isGrokOauthModel("gpt-5.6-luna"), false);
  assert.equal(isGrokOauthModel("gpt-5.6-sol"), false);
  assert.equal(isGrokOauthModel(""), false);
});

test("lastTurnLooksLikeToolThenStatus requires a tool result and a short status", () => {
  assert.equal(
    lastTurnLooksLikeToolThenStatus(midTask, "The figures are ready."),
    true,
  );
  assert.equal(
    lastTurnLooksLikeToolThenStatus(midTask, ""),
    true,
  );
  assert.equal(
    lastTurnLooksLikeToolThenStatus(
      [
        ...midTask,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "\n" }] },
      ],
      "",
    ),
    true,
  );
  assert.equal(
    lastTurnLooksLikeToolThenStatus(
      [
        ...midTask,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(121) }] },
      ],
      "",
    ),
    false,
  );
  assert.equal(
    lastTurnLooksLikeToolThenStatus(
      [...midTask, { type: "function_call", name: "view_image", arguments: "{}" }],
      "The figures are ready.",
    ),
    false,
  );
  assert.equal(
    lastTurnLooksLikeToolThenStatus(
      [{ type: "message", role: "user", content: "done?" }],
      "Yes, that is correct.",
    ),
    false,
  );
});

test("decideStop never continues a GPT turn", () => {
  const decision = decideStop(
    {
      hook_event_name: "Stop",
      model: "gpt-5.6-luna",
      last_assistant_message: "The figures are ready.",
    },
    midTask,
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.reason, "not-grok-oauth");
});

test("decideStop continues a grok-oauth mid-task status once", () => {
  const decision = decideStop(
    {
      hook_event_name: "Stop",
      model: "grok-oauth/grok-4.6",
      last_assistant_message: "The figures are ready.",
    },
    midTask,
  );
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /call it now/);
});

test("decideStop continues when Codex sends an empty last_assistant_message", () => {
  const decision = decideStop(
    {
      hook_event_name: "Stop",
      model: "grok-oauth/grok-4.6",
      last_assistant_message: "",
    },
    [
      ...midTask,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "\n" }] },
    ],
  );
  assert.equal(decision.action, "block");
});

test("decideStop respects the continue cap and the kill switch", () => {
  assert.equal(
    decideStop(
      {
        hook_event_name: "Stop",
        model: "grok-oauth/grok-4.6",
        stop_hook_active: true,
        last_assistant_message: "The figures are ready.",
      },
      midTask,
    ).reason,
    "continue-cap",
  );
  assert.equal(
    decideStop(
      {
        hook_event_name: "Stop",
        model: "grok-oauth/grok-4.6",
        last_assistant_message: "The figures are ready.",
      },
      midTask,
      { disabled: true },
    ).reason,
    "disabled",
  );
});

test("the hook process fail-opens on GPT and blocks grok-oauth mid-task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-stop-hook-"));
  const transcript = path.join(dir, "rollout.jsonl");
  writeFileSync(
    transcript,
    midTask.map((item) => JSON.stringify({ type: "response_item", payload: item })).join("\n") + "\n",
  );

  const gpt = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      model: "gpt-5.6-sol",
      transcript_path: transcript,
      last_assistant_message: "The figures are ready.",
    }),
    encoding: "utf8",
  });
  assert.equal(gpt.status, 0);
  assert.deepEqual(JSON.parse(gpt.stdout), { continue: true });

  const grok = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      model: "grok-oauth/grok-4.6",
      transcript_path: transcript,
      last_assistant_message: "The figures are ready.",
    }),
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: dir },
  });
  assert.equal(grok.status, 0);
  const body = JSON.parse(grok.stdout);
  assert.equal(body.decision, "block");
  assert.match(body.reason, /call it now/);
  const [logged] = readFileSync(path.join(dir, "codex-router", "grok-stop-hook.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(logged.action, "block");
  assert.equal(logged.items, midTask.length);
});
