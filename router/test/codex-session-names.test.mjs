import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activityMetadataFromHeaders,
  sessionNameFromHeaders,
  threadIdFromHeaders,
} from "../src/codex-session-names.mjs";

const THREAD_ID = "019f8821-881a-7582-9e60-633bff68789f";

test("resolves a Codex thread header to its user-facing session name", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-session-name-"));
  const indexPath = path.join(directory, "session_index.jsonl");
  writeFileSync(
    indexPath,
    `${JSON.stringify({ id: THREAD_ID, thread_name: "  Add   thinking orb to island  " })}\n`,
  );

  assert.equal(
    sessionNameFromHeaders({ "thread-id": THREAD_ID }, { indexPath }),
    "Add thinking orb to island",
  );
});

test("finds nested thread metadata without exposing unrelated metadata", () => {
  assert.equal(
    threadIdFromHeaders({
      "x-codex-turn-metadata": JSON.stringify({ turn: { thread_id: THREAD_ID }, prompt: "private" }),
    }),
    THREAD_ID,
  );
  assert.equal(threadIdFromHeaders({ "x-codex-turn-metadata": "not-json" }), undefined);
});

test("groups subagent activity under its root session with a short agent name", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-agent-session-"));
  const sessionsPath = path.join(directory, "sessions");
  const indexPath = path.join(directory, "session_index.jsonl");
  const childId = "019fa7d4-e478-7640-be48-1b2698b4a975";
  const day = path.join(sessionsPath, "2026", "07", "28");
  mkdirSync(day, { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify({ id: THREAD_ID, thread_name: "Build arena" })}\n`);
  writeFileSync(
    path.join(day, `rollout-2026-07-28T00-00-00-${childId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: THREAD_ID,
              agent_path: "/root/harsh_critic",
              agent_nickname: "Heisenberg",
            },
          },
        },
      },
    })}\n`,
  );

  assert.deepEqual(
    activityMetadataFromHeaders(
      { "thread-id": childId, "x-codex-parent-thread-id": THREAD_ID },
      { indexPath, sessionsPath },
    ),
    {
      threadId: childId,
      parentThreadId: THREAD_ID,
      sessionId: THREAD_ID,
      sessionName: "Build arena",
      agentName: "harsh_critic",
      agentNickname: "Heisenberg",
      isSubagent: true,
    },
  );
});
