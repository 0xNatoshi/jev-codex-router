import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "vision-download-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  VISION_DOWNLOAD_STATE_PATH,
  VISION_DOWNLOAD_HEARTBEAT_TIMEOUT_MS,
  activeVisionDownloadResult,
  claimVisionDownloadStart,
  createProgressTracker,
  finalizeVisionDownload,
  parseNdjsonLines,
  readVisionDownload,
  reconcileVisionDownload,
  shouldAdoptDownloadedVisionModel,
  streamOllamaPull,
  writeVisionDownload,
} = await import("../src/vision-download.mjs");

function ndjsonResponse(events) {
  const body = Readable.from(
    events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, "utf8")),
  );
  return { ok: true, status: 200, body };
}

test("progress sums every layer so it only moves forward", () => {
  const tracker = createProgressTracker();
  // One layer half done.
  assert.equal(tracker.update({ digest: "a", completed: 50, total: 100 }), 50);
  // A second layer starting must not drop the overall number to zero.
  assert.equal(tracker.update({ digest: "b", completed: 0, total: 100 }), 25);
  assert.equal(tracker.update({ digest: "b", completed: 100, total: 100 }), 75);
  assert.equal(tracker.update({ digest: "a", completed: 100, total: 100 }), 100);
  // Status-only events carry no totals and report nothing.
  assert.equal(tracker.update({ status: "verifying sha256 digest" }), undefined);
});

test("same-tag vision pulls are idempotent and different active tags are refused", () => {
  const active = {
    status: "downloading",
    tag: "qwen2.5vl:3b",
    percent: 42,
  };
  assert.deepEqual(activeVisionDownloadResult(active, "qwen2.5vl:3b"), {
    started: false,
    existing: true,
    tag: "qwen2.5vl:3b",
    percent: 42,
  });
  assert.throws(
    () => activeVisionDownloadResult(active, "moondream:latest"),
    /qwen2\.5vl:3b is already downloading \(42%\)/,
  );
  assert.equal(activeVisionDownloadResult({ status: "done" }, "qwen2.5vl:3b"), null);
});

test("vision pull controllers cannot both seed and spawn a worker", () => {
  const claimPath = path.join(stateDir, "vision-start.claim");
  const first = claimVisionDownloadStart({ claimPath, now: () => 10_000 });
  assert.equal(first.acquired, true);
  const second = claimVisionDownloadStart({ claimPath, now: () => 10_001 });
  assert.equal(second.acquired, false);
  first.release();
  const third = claimVisionDownloadStart({ claimPath, now: () => 10_002 });
  assert.equal(third.acquired, true);
  third.release();
});

test("dead or stale vision workers become interrupted so a pull can retry", () => {
  const active = {
    version: 1,
    tag: "qwen2.5vl:3b",
    status: "downloading",
    percent: 42,
    workerPid: 321,
    updatedAt: 10_000,
  };
  const alive = reconcileVisionDownload(active, {
    now: 10_001,
    kill: () => {},
    persist: false,
  });
  assert.equal(alive, active);

  const dead = reconcileVisionDownload(active, {
    now: 10_001,
    kill: () => {
      const error = new Error("not running");
      error.code = "ESRCH";
      throw error;
    },
    persist: false,
  });
  assert.equal(dead.status, "error");
  assert.equal(dead.detail, "interrupted");
  assert.equal(dead.workerPid, null);

  const stale = reconcileVisionDownload(active, {
    now: 10_000 + VISION_DOWNLOAD_HEARTBEAT_TIMEOUT_MS + 1,
    kill: () => {},
    persist: false,
  });
  assert.equal(stale.status, "error");
  assert.match(stale.error, /Retry the download/);
});

test("ndjson parsing keeps a partial trailing line for the next chunk", () => {
  const first = parseNdjsonLines('{"status":"a"}\n{"status":"b"}\n{"stat');
  assert.deepEqual(first.events.map((e) => e.status), ["a", "b"]);
  assert.equal(first.remainder, '{"stat');
  const second = parseNdjsonLines(`${first.remainder}us":"c"}\n`);
  assert.deepEqual(second.events.map((e) => e.status), ["c"]);
});

test("a completed pull reports progress and resolves", async () => {
  const seen = [];
  await streamOllamaPull("qwen2.5vl:3b", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/pull");
      assert.deepEqual(JSON.parse(init.body), { model: "qwen2.5vl:3b", stream: true });
      return ndjsonResponse([
        { status: "pulling manifest" },
        { status: "pulling abc", digest: "abc", completed: 500, total: 1000 },
        { status: "pulling abc", digest: "abc", completed: 1000, total: 1000 },
        { status: "success" },
      ]);
    },
    onProgress: (update) => seen.push(update.percent),
  });
  // Manifest and success events carry no byte totals, so they report no
  // percentage; the worker holds the last known value across them.
  assert.deepEqual(seen, [undefined, 50, 100, undefined]);
});

test("an error event fails the pull with the server's message", async () => {
  await assert.rejects(
    streamOllamaPull("nope", {
      fetchImpl: async () => ndjsonResponse([{ error: "model 'nope' not found" }]),
    }),
    /model 'nope' not found/,
  );
});

test("a stream that ends without success is a failure, not a silent pass", async () => {
  await assert.rejects(
    streamOllamaPull("qwen2.5vl:3b", {
      fetchImpl: async () =>
        ndjsonResponse([{ status: "pulling abc", digest: "abc", completed: 1, total: 100 }]),
    }),
    /ended before Ollama confirmed success/,
  );
});

test("an unreachable daemon names the cause", async () => {
  await assert.rejects(
    streamOllamaPull("x", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /Could not reach Ollama/,
  );
});

test("the /v1 inference prefix is stripped for the daemon API", async () => {
  let seenUrl;
  await streamOllamaPull("x", {
    baseUrl: "http://127.0.0.1:11434/v1",
    fetchImpl: async (url) => {
      seenUrl = url;
      return ndjsonResponse([{ status: "success" }]);
    },
  });
  assert.equal(seenUrl, "http://127.0.0.1:11434/api/pull");
});

test("a completed pull never re-enables a bridge explicitly switched off", async () => {
  const events = [];
  const result = await finalizeVisionDownload("qwen2.5vl:3b", {
    readSettings: () => ({ enabled: false, engine: null }),
    configured: () => true,
    setLocal: () => assert.fail("an explicit off choice must not be replaced"),
    setEnabled: () => assert.fail("an explicit off choice must not be re-enabled"),
    finalizePublication: async (options) => {
      events.push("publish");
      assert.equal(options.warningOnly, true);
      return { warnings: {} };
    },
  });

  assert.equal(shouldAdoptDownloadedVisionModel({ enabled: false, engine: null }, true), false);
  assert.deepEqual(result, { adopt: false });
  assert.deepEqual(events, ["publish"]);
});

test("a first-run vision pull adopts only after download", async () => {
  const events = [];
  const result = await finalizeVisionDownload("qwen2.5vl:3b", {
    // The default has an engine, but no state file means nobody chose it. A
    // completed local pull is the first explicit setup and may become local.
    readSettings: () => ({ enabled: true, engine: "default-vision" }),
    configured: () => false,
    setLocal: ({ model }) => events.push(`local:${model}`),
    setEnabled: (enabled) => events.push(`enabled:${enabled}`),
    finalizePublication: async (options) => {
      events.push("publish");
      assert.equal(options.warningOnly, true);
      return { warnings: {} };
    },
  });

  assert.deepEqual(events, ["local:qwen2.5vl:3b", "enabled:true", "publish"]);
  assert.deepEqual(result, { adopt: true });
});

test("download state round-trips through protected state", () => {
  assert.equal(readVisionDownload(), null);
  writeVisionDownload({
    version: 1,
    tag: "moondream",
    status: "downloading",
    percent: 12,
    updatedAt: Date.now(),
  });
  assert.equal(readVisionDownload().percent, 12);
  assert.ok(VISION_DOWNLOAD_STATE_PATH.startsWith(stateDir));
});
