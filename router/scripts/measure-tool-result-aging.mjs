#!/usr/bin/env node

import { createReadStream } from "node:fs";
import readline from "node:readline";

import { ageToolResults } from "../src/tool-result-aging.mjs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/measure-tool-result-aging.mjs ROLLOUT.jsonl");
  process.exitCode = 2;
} else {
  const lines = readline.createInterface({ input: createReadStream(path) });
  let input = [];
  let compactions = 0;
  const samples = [];

  function measure(label) {
    const beforeBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const result = ageToolResults(input);
    const afterBytes = Buffer.byteLength(JSON.stringify(result.input), "utf8");
    const bytesSaved = beforeBytes - afterBytes;
    return {
      label,
      items: input.length,
      beforeBytes,
      afterBytes,
      bytesSaved,
      reductionPercent: Number(((bytesSaved / Math.max(1, beforeBytes)) * 100).toFixed(2)),
      estimatedInputTokensBefore: Math.ceil(beforeBytes / 3.3),
      estimatedInputTokensAfter: Math.ceil(afterBytes / 3.3),
      estimatedInputTokensSaved: Math.floor(bytesSaved / 3.3),
      ...result.stats,
    };
  }

  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "compacted") {
      if (input.length) samples.push(measure(`before compaction ${compactions + 1}`));
      input = Array.isArray(row.payload?.replacement_history)
        ? row.payload.replacement_history
        : [];
      compactions += 1;
    } else if (row.type === "response_item" && row.payload) {
      input.push(row.payload);
    }
  }
  const latest = measure("latest history");
  samples.push(latest);
  const savingSamples = samples.filter((sample) => sample.bytesSaved > 0);
  const peakBytes = savingSamples.reduce(
    (peak, sample) => !peak || sample.bytesSaved > peak.bytesSaved ? sample : peak,
    null,
  );
  const peakPercent = savingSamples.reduce(
    (peak, sample) => !peak || sample.reductionPercent > peak.reductionPercent ? sample : peak,
    null,
  );
  console.log(JSON.stringify({
    source: "compaction boundaries and latest history from one rollout",
    compactions,
    sampledHistories: samples.length,
    historiesWithSavings: savingSamples.length,
    sampledBytesSaved: savingSamples.reduce((total, sample) => total + sample.bytesSaved, 0),
    sampledEstimatedInputTokensSaved: savingSamples.reduce(
      (total, sample) => total + sample.estimatedInputTokensSaved,
      0,
    ),
    peakBytes,
    peakPercent,
    latest,
  }, null, 2));
}
