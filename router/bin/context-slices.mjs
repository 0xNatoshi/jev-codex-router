#!/usr/bin/env node
// Split Codex session rollouts and router logs into verbatim ~100k-token
// slices, one slice per file, plus a deterministic manifest. Each slice keeps
// every byte of its events; no event is dropped or truncated; identical input
// produces byte-identical output, so slices can be handed to separate agents
// without overlap or loss.
//
// Usage:
//   node bin/context-slices.mjs <file>... --out <dir> [--budget 100000]
//                                [--chars-per-token 4]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_CHARS_PER_TOKEN,
  chunkFile,
} from "../src/transcript-chunker.mjs";

function parseArgs(argv) {
  const files = [];
  const options = { out: undefined, budget: DEFAULT_BUDGET_TOKENS, charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--budget") {
      options.budget = Number(argv[++i]);
    } else if (arg === "--chars-per-token") {
      options.charsPerToken = Number(argv[++i]);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error("no input files");
  if (!options.out) throw new Error("--out <dir> is required");
  return { files, options };
}

const { files, options } = parseArgs(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const manifest = { generatedBy: "bin/context-slices.mjs", files: [] };
for (const source of files) {
  const result = chunkFile(source, {
    budgetTokens: options.budget,
    charsPerToken: options.charsPerToken,
  });
  const base = path.basename(source).replace(/\.[^.]+$/, "");
  const ext = path.extname(source) || ".txt";
  const entry = {
    source,
    budgetTokens: result.budgetTokens,
    totalLines: result.totalLines,
    totalChars: result.totalChars,
    sliceCount: result.sliceCount,
    slices: [],
  };
  for (const slice of result.slices) {
    const file = `${base}-slice-${String(slice.index).padStart(3, "0")}${ext}`;
    writeFileSync(path.join(options.out, file), `${slice.content}\n`);
    entry.slices.push({
      index: slice.index,
      file,
      firstLine: slice.firstLine,
      lastLine: slice.lastLine,
      lineCount: slice.lineCount,
      chars: slice.chars,
      estimatedTokens: slice.estimatedTokens,
      oversized: slice.oversized,
    });
  }
  manifest.files.push(entry);
  for (const slice of entry.slices) {
    const flag = slice.oversized ? " (oversized event)" : "";
    console.log(
      `${base}: slice ${slice.index}/${result.sliceCount} lines ${slice.firstLine}-${slice.lastLine} ~${Math.round(slice.estimatedTokens / 1000)}k tokens${flag}`,
    );
  }
}
writeFileSync(path.join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.files.length} file(s) -> ${options.out}`);
