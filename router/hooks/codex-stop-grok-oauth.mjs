#!/usr/bin/env node
// Codex Stop hook: continue a grok-oauth turn that stopped after a tool
// result with only a short status sentence. Every other model, including
// native GPT, is left alone. Fail open on any parse or I/O error.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_STATUS_CHARS = 120;
export const MAX_CONTINUES = 1;

const ALLOW = { continue: true };
const DISABLED = process.env.CODEX_GROK_OAUTH_STOP_HOOK === "0";

export function isGrokOauthModel(model) {
  const value = String(model || "");
  return value === "grok-oauth" || value.startsWith("grok-oauth/");
}

export function assistantTextFromItem(item) {
  if (item?.type !== "message" || item.role !== "assistant") return "";
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return part.text || part.output_text || "";
    })
    .join("");
}

// Codex often sends last_assistant_message="" on Stop. Judge the turn by
// what happened after the last tool result: another tool call means the
// model continued; a long answer means it finished; empty or a short
// status means it stopped mid-task.
export function lastTurnLooksLikeToolThenStatus(items, lastMessage, maxChars = MAX_STATUS_CHARS) {
  const list = Array.isArray(items) ? items : [];
  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (item?.type === "user_message") {
      lastUser = index;
      break;
    }
    if (item?.type === "message" && item.role === "user") {
      lastUser = index;
      break;
    }
  }
  const turn = list.slice(lastUser + 1);
  let lastOutput = -1;
  turn.forEach((item, index) => {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      lastOutput = index;
    }
  });
  if (lastOutput < 0) return false;
  const after = turn.slice(lastOutput + 1);
  if (after.some((item) => item?.type === "function_call" || item?.type === "custom_tool_call")) {
    return false;
  }
  const afterTexts = after
    .map((item) => assistantTextFromItem(item).trim())
    .filter(Boolean);
  const eventText = typeof lastMessage === "string" ? lastMessage.trim() : "";
  const finalText = afterTexts.length ? afterTexts[afterTexts.length - 1] : eventText;
  if (!finalText) return true;
  return finalText.length <= maxChars;
}

export function decideStop(event, items, { disabled = DISABLED, maxContinues = MAX_CONTINUES } = {}) {
  if (disabled) return { action: "allow", reason: "disabled" };
  if (event?.hook_event_name && event.hook_event_name !== "Stop") {
    return { action: "allow", reason: "not-stop" };
  }
  if (!isGrokOauthModel(event?.model)) return { action: "allow", reason: "not-grok-oauth" };
  const already = event?.stop_hook_active === true ? 1 : 0;
  if (already >= maxContinues) return { action: "allow", reason: "continue-cap" };
  if (!lastTurnLooksLikeToolThenStatus(items, event?.last_assistant_message)) {
    return { action: "allow", reason: "not-mid-task" };
  }
  return {
    action: "block",
    reason:
      "Tool finished. If the user's request still needs a tool, call it now. " +
      "Do not only announce the next step.",
  };
}

function responseItem(entry) {
  if (entry?.type === "response_item" && entry.payload && typeof entry.payload === "object") {
    return entry.payload;
  }
  if (entry && typeof entry.type === "string" && entry.type !== "event_msg" && entry.type !== "world_state") {
    return entry;
  }
  return undefined;
}

export function loadTranscriptItems(transcriptPath) {
  if (!transcriptPath) return [];
  const text = readFileSync(transcriptPath, "utf8");
  const items = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = responseItem(JSON.parse(line));
      if (item) items.push(item);
    } catch {
      // Skip a corrupt line; fail open on the rest.
    }
  }
  return items;
}

function writeDecision(decision) {
  if (decision.action === "block") {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(ALLOW)}\n`);
}

function logDecision(event, decision, items = []) {
  const dir = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const file = path.join(dir, "codex-router", "grok-stop-hook.jsonl");
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(
      file,
      `${JSON.stringify({
        at: new Date().toISOString(),
        model: event?.model || null,
        turn: event?.turn_id || null,
        action: decision.action,
        reason: decision.reason,
        statusChars:
          typeof event?.last_assistant_message === "string"
            ? event.last_assistant_message.trim().length
            : 0,
        items: Array.isArray(items) ? items.length : 0,
      })}\n`,
    );
  } catch {
    // Logging must never fail the hook.
  }
}

function main() {
  let event = {};
  try {
    const raw = readFileSync(0, "utf8");
    event = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    writeDecision({ action: "allow", reason: "bad-stdin" });
    return;
  }
  let items = [];
  try {
    items = loadTranscriptItems(event.transcript_path);
  } catch {
    items = [];
  }
  const decision = decideStop(event, items);
  logDecision(event, decision, items);
  writeDecision(decision);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stdout.write(`${JSON.stringify(ALLOW)}\n`);
  }
}
