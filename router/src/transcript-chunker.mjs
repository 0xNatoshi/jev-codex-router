// Verbatim, deterministic transcript/log chunker.
//
// A Codex session rollout or a router log is one long stream of events. An
// agent that reads the whole thing rots its context window and hallucinates.
// This module splits a file at event (line) boundaries into slices that stay
// within a token budget, keeps every byte of every event, and is fully
// deterministic: the same input always produces byte-identical slices and an
// identical manifest, so two runs are comparable and slices can be handed to
// separate agents without overlap or loss.
//
// Events are atomic: a single line is never split, even when it exceeds the
// budget. Oversized events get their own slice, flagged in the manifest.

import { readFileSync } from "node:fs";

export const DEFAULT_BUDGET_TOKENS = 100_000;
export const DEFAULT_CHARS_PER_TOKEN = 4;

// Split `lines` into slices. `lines` may be empty. The estimate is a
// deterministic character-count heuristic (JSON and logs average roughly four
// characters per token); callers that need an exact provider tokenizer can
// pass their own `charsPerToken`.
export function chunkLines(lines, { budgetTokens = DEFAULT_BUDGET_TOKENS, charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  if (!Array.isArray(lines)) throw new TypeError("chunkLines expects an array of lines");
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new RangeError("budgetTokens must be a positive number");
  }
  const slices = [];
  let current = [];
  let currentChars = 0;
  let startLine = 1;
  const budgetChars = Math.floor(budgetTokens * charsPerToken);
  const pushSlice = (endLine) => {
    if (current.length === 0) return;
    const chars = currentChars;
    slices.push({
      index: slices.length + 1,
      firstLine: startLine,
      lastLine: endLine,
      lineCount: current.length,
      chars,
      estimatedTokens: Math.ceil(chars / charsPerToken),
      oversized: chars - 1 > budgetChars,
      content: current.join("\n"),
    });
    current = [];
    currentChars = 0;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineChars = line.length;
    if (current.length > 0 && currentChars + lineChars + 1 > budgetChars) {
      pushSlice(i); // 1-based: previous line index i is the last of this slice
      startLine = i + 1;
    }
    current.push(line);
    currentChars += lineChars + 1; // +1 for the newline the join restores
  }
  if (current.length > 0) {
    // A single event larger than the budget cannot be split; it is flagged.
    pushSlice(lines.length);
  }
  return { slices, budgetTokens, charsPerToken };
}

// Read a file and produce its slices plus a deterministic manifest. The
// manifest deliberately carries no timestamp or random id -- only the input
// identity and the measurable slice properties -- so identical inputs produce
// identical manifests.
export function chunkFile(source, { budgetTokens = DEFAULT_BUDGET_TOKENS, charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  const text = readFileSync(source, "utf8");
  const lines = text.split("\n");
  // A trailing newline yields one empty final line; drop it so the slices
  // concatenate back to exactly the file's event lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const { slices } = chunkLines(lines, { budgetTokens, charsPerToken });
  return {
    source,
    budgetTokens,
    charsPerToken,
    totalLines: lines.length,
    totalChars: lines.reduce((sum, line) => sum + line.length + 1, 0),
    sliceCount: slices.length,
    slices,
  };
}

// Deterministic byte-identical check: joining every slice's content with "\n"
// between slices must reproduce the original line stream exactly.
export function coverageMatches(slices, originalLines) {
  const rebuilt = slices.map((slice) => slice.content).join("\n");
  return rebuilt === originalLines.join("\n");
}
