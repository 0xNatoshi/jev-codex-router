import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { firstFrameImage, parseArgs, runMedia } from "../src/minimax-media.mjs";

const SECRET = "sk-test-media-secret";

// A stub provider keeps the tests off the real registry and resolver; the
// fetch stub records every request so payload shape is asserted, not assumed.
function harness(responses) {
  const requests = [];
  const queue = [...responses];
  const logs = [];
  const emitted = [];
  const hooks = {
    provider: { id: "minimax-token-plan", baseUrl: "https://api.minimax.io/v1" },
    resolveCredential: () => ({ value: SECRET, source: "test", persistent: true }),
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error(`Unexpected request: ${url}`);
      return {
        ok: next.status === undefined || next.status < 400,
        status: next.status ?? 200,
        text: async () => JSON.stringify(next.body),
        body: next.stream,
      };
    },
    sleep: async () => {},
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    log: (line) => logs.push(line),
    emit: (line) => emitted.push(line),
  };
  return { hooks, requests, logs, emitted };
}

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("parseArgs separates flags, values, and booleans", () => {
  const { action, options } = parseArgs([
    "music",
    "--prompt",
    "lofi",
    "--instrumental",
    "--json",
  ]);
  assert.equal(action, "music");
  assert.deepEqual(options, { prompt: "lofi", instrumental: true, json: true });
  assert.throws(() => parseArgs(["music", "--prompt"]), /Missing value/);
  assert.throws(() => parseArgs(["music", "stray"]), /Unexpected argument/);
});

test("music generation posts the documented payload and downloads the track", async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "track.mp3");
  const { hooks, requests } = harness([
    {
      body: {
        data: { audio: "https://cdn.example/track.mp3" },
        extra_info: { music_duration: 1234 },
        base_resp: { status_code: 0, status_msg: "success" },
      },
    },
    { body: null, stream: streamOf("mp3-bytes") },
  ]);
  const result = await runMedia(
    ["music", "--prompt", "upbeat synthwave", "--instrumental", "--out", out],
    hooks,
  );
  assert.equal(requests[0].url, "https://api.minimax.io/v1/music_generation");
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.model, "music-3.0");
  assert.equal(payload.lyrics, "[inst]");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(result.file, out);
  assert.equal(readFileSync(out, "utf8"), "mp3-bytes");
});

test("video polls the task and downloads the finished clip", async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "clip.mp4");
  const ok = { status_code: 0, status_msg: "success" };
  const { hooks, requests } = harness([
    { body: { task_id: "42", base_resp: ok } },
    { body: { status: "Processing", base_resp: ok } },
    { body: { status: "Success", file_id: "77", base_resp: ok } },
    { body: { file: { download_url: "https://cdn.example/clip.mp4" }, base_resp: ok } },
    { body: null, stream: streamOf("mp4-bytes") },
  ]);
  const result = await runMedia(
    ["video", "--prompt", "a paper boat", "--out", out, "--json"],
    hooks,
  );
  assert.equal(requests[0].url, "https://api.minimax.io/v1/video_generation");
  assert.equal(JSON.parse(requests[0].init.body).model, "MiniMax-Hailuo-02");
  assert.match(requests[1].url, /query\/video_generation\?task_id=42/);
  assert.match(requests[3].url, /files\/retrieve\?file_id=77/);
  assert.equal(result.file, out);
  assert.equal(readFileSync(out, "utf8"), "mp4-bytes");
});

test("H3 video is refused locally with Token Plan guidance", async () => {
  const { hooks, requests } = harness([]);
  await assert.rejects(
    runMedia(["video", "--prompt", "x", "--model", "MiniMax-H3"], hooks),
    /not available on the Token Plan/,
  );
  assert.equal(requests.length, 0);
});

test("an in-band MiniMax error surfaces its status_msg, never the key", async () => {
  const { hooks } = harness([
    { body: { base_resp: { status_code: 1008, status_msg: "insufficient balance" } } },
  ]);
  await assert.rejects(
    runMedia(["music", "--prompt", "x", "--instrumental"], hooks),
    (error) => {
      assert.match(error.message, /insufficient balance/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    },
  );
});

test("a missing credential names the provider-key command", async () => {
  const { hooks } = harness([]);
  hooks.resolveCredential = () => undefined;
  await assert.rejects(
    runMedia(["speech", "--text", "hi"], hooks),
    /provider-key minimax-token-plan set/,
  );
});

test("a still-rendering task points at media status instead of resubmitting", async () => {
  const ok = { status_code: 0, status_msg: "success" };
  const pending = { body: { status: "Processing", base_resp: ok } };
  const { hooks } = harness([
    { body: { task_id: "9", base_resp: ok } },
    ...Array.from({ length: 90 }, () => pending),
  ]);
  await assert.rejects(
    runMedia(["video", "--prompt", "x"], hooks),
    /media status --task-id 9/,
  );
});

test("firstFrameImage passes URLs through and inlines local files", () => {
  assert.equal(firstFrameImage("https://example.com/a.png"), "https://example.com/a.png");
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "frame.png");
  const bytes = Buffer.from("png-bytes");
  writeFileSync(file, bytes);
  assert.equal(
    firstFrameImage(file),
    `data:image/png;base64,${bytes.toString("base64")}`,
  );
});
