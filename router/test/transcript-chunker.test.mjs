import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  coverageMatches,
  chunkFile,
  chunkLines,
} from "../src/transcript-chunker.mjs";

test("splits a transcript into slices within the budget", () => {
  // 12 lines of ~20 chars each with a 50-char budget -> ~3 lines per slice.
  const lines = Array.from({ length: 12 }, (_, i) => `event-${i} ${"x".repeat(15)}`);
  const { slices } = chunkLines(lines, { budgetTokens: 12, charsPerToken: 4 });
  assert.ok(slices.length >= 3);
  for (const slice of slices) {
    assert.ok(slice.estimatedTokens <= 12, `slice ${slice.index} within budget`);
    assert.ok(slice.firstLine <= slice.lastLine);
    assert.ok(slice.lineCount === slice.lastLine - slice.firstLine + 1);
  }
  // Coverage is exact: no event dropped, duplicated, or reordered.
  assert.equal(coverageMatches(slices, lines), true);
  // Ranges are contiguous and cover every line exactly once.
  let expected = 1;
  for (const slice of slices) {
    assert.equal(slice.firstLine, expected);
    expected = slice.lastLine + 1;
  }
  assert.equal(expected, lines.length + 1);
});

test("empty input produces no slices", () => {
  const { slices } = chunkLines([]);
  assert.equal(slices.length, 0);
  assert.equal(coverageMatches(slices, []), true);
});

test("a single oversized event gets its own flagged slice", () => {
  const huge = `{"payload":"${"y".repeat(10_000)}"}`;
  const lines = ["small-1", huge, "small-2"];
  const { slices } = chunkLines(lines, { budgetTokens: 100, charsPerToken: 4 });
  assert.equal(slices.length, 3);
  assert.equal(slices[1].content, huge);
  assert.equal(slices[1].oversized, true);
  assert.equal(slices[0].oversized, false);
  assert.equal(coverageMatches(slices, lines), true);
});

test("two runs produce byte-identical slices and manifests", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i} ${"z".repeat(30)}`);
  const first = chunkLines(lines, { budgetTokens: 40, charsPerToken: 4 });
  const second = chunkLines(lines, { budgetTokens: 40, charsPerToken: 4 });
  assert.deepEqual(second.slices, first.slices);
  assert.deepEqual(second.budgetTokens, first.budgetTokens);
  // And against the file-level entry point, with no timestamps in the output.
  const dir = mkdtempSync(path.join(os.tmpdir(), "chunker-"));
  try {
    const file = path.join(dir, "rollout-2026-08-09-example.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const a = chunkFile(file, { budgetTokens: 40, charsPerToken: 4 });
    const b = chunkFile(file, { budgetTokens: 40, charsPerToken: 4 });
    assert.deepEqual(b, a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid budgets", () => {
  assert.throws(() => chunkLines(["x"], { budgetTokens: 0 }), RangeError);
  assert.throws(() => chunkLines(["x"], { budgetTokens: -1 }), RangeError);
  assert.throws(() => chunkLines("not-an-array"), TypeError);
});

test("chunkFile matches the real referenced transcript shape", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chunker-"));
  try {
    const file = path.join(dir, "rollout-2026-08-09.jsonl");
    const events = [];
    for (let i = 0; i < 300; i += 1) {
      events.push(
        `${JSON.stringify({ timestamp: `2026-08-09T${String(i).padStart(2, "0")}:00:00.000Z`, type: "response_item", payload: { id: `item-${i}` } })}`,
      );
    }
    writeFileSync(file, `${events.join("\n")}\n`);
    const result = chunkFile(file, { budgetTokens: 50, charsPerToken: 4 });
    const originalLines = events;
    assert.equal(result.totalLines, originalLines.length);
    assert.equal(result.sliceCount, result.slices.length);
    assert.equal(coverageMatches(result.slices, originalLines), true);
    for (const slice of result.slices) {
      assert.ok(slice.firstLine >= 1 && slice.lastLine <= originalLines.length);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chunker handles a real router log line stream", () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`14:${String(i % 60).padStart(2, "0")}:00 - INFO: [codex-router] model=opencode-go/deepseek-v4-flash status=200 ${"d".repeat(40)}`);
  }
  const { slices } = chunkLines(lines, { budgetTokens: 30, charsPerToken: 4 });
  assert.equal(coverageMatches(slices, lines), true);
});
