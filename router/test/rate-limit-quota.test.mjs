import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// State paths bind at import time, so the isolated root must be set first.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-rate-limit-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { parseRateLimitHeaders } = await import("../src/rate-limit-headers.mjs");
const { recordRateLimitSnapshot, readRateLimitSnapshots } = await import(
  "../src/rate-limit-state.mjs"
);
const { providerAccountUsageSnapshot } = await import("../src/provider-account-usage.mjs");

const NEVER_CALLED = async () => {
  throw new Error("header-derived quota must not reach the network");
};

test("observed response headers become quota cards for a catalog-only provider", async () => {
  try {
    recordRateLimitSnapshot(
      "groq",
      parseRateLimitHeaders(
        new Headers({
          "x-ratelimit-limit-requests": "14400",
          "x-ratelimit-remaining-requests": "14370",
          "x-ratelimit-reset-requests": "2m59.56s",
          "x-ratelimit-limit-tokens": "18000",
          "x-ratelimit-remaining-tokens": "9000",
          "x-ratelimit-reset-tokens": "7.66s",
        }),
      ),
    );

    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["groq", "mistral"],
      fetchImpl: NEVER_CALLED,
    });

    const groq = snapshot.groq;
    assert.equal(groq.status, "available");
    assert.equal(groq.source, "response-headers");
    assert.deepEqual(
      groq.metrics.map((metric) => [metric.label, metric.unit, metric.remaining]),
      [
        ["Request limit", "requests", 14370],
        ["Token limit", "tokens", 9000],
      ],
    );
    // Percentages are derived, not echoed, so a half-spent token window reads 50.
    assert.equal(groq.metrics[1].usedPercent, 50);

    // A provider that has served no traffic yet must not invent a card.
    assert.equal(snapshot.mistral.status, "local-only");
    assert.deepEqual(snapshot.mistral.metrics, []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an exhausted window is retained as a cooldown hint", async () => {
  try {
    recordRateLimitSnapshot(
      "cerebras",
      parseRateLimitHeaders(new Headers({ "retry-after": "30" })),
    );
    const stored = readRateLimitSnapshots().cerebras;
    assert.ok(stored.retryAt, "retry-after should persist as an absolute instant");
    assert.ok(stored.observedAt, "every snapshot records when it was observed");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
