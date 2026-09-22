import assert from "node:assert/strict";
import test from "node:test";
import { createRequestProgress } from "../src/request-progress.mjs";

test("silence and repeated polls retain live requests without inventing progress", () => {
  let time = 100;
  const tracker = createRequestProgress({ now: () => time, recentTtlMs: 10 });
  const request = tracker.begin();
  request.setRoute({ threadId: "worker-1", model: "grok-oauth/grok-4.6", secret: "never" });
  request.attempt();
  const initial = tracker.snapshot().active[0];
  time += 1_000_000;
  const silent = tracker.snapshot({ threadId: "worker-1" }).active[0];
  assert.deepEqual(silent, initial);
  assert.equal(silent.phase, "awaiting_upstream");
  assert.equal(silent.lastEventAt, undefined);
  assert.equal(silent.secret, undefined);
  assert.equal(tracker.snapshot({ threadId: "other" }).active.length, 0);
  request.headers();
  request.event({ type: "response.reasoning_summary_text.delta", delta: "private reasoning" });
  const progress = tracker.snapshot().active[0];
  assert.equal(progress.phase, "reasoning");
  assert.equal(progress.lastEventAt, time);
  assert.equal(progress.receivedEvents, 1);
  assert.doesNotMatch(JSON.stringify(progress), /private reasoning/);
  progress.state = "tampered";
  assert.equal(tracker.snapshot().active[0].state, "running");
});

test("cancel remains active until cleanup and recent results are bounded and expire", () => {
  let time = 0;
  const tracker = createRequestProgress({ now: () => time, recentLimit: 2, recentTtlMs: 10 });
  const request = tracker.begin();
  request.attempt();
  request.cancel("client_disconnected");
  request.headers();
  request.event({ type: "response.output_text.delta", delta: "late" });
  assert.equal(tracker.snapshot().active[0].phase, "canceling");
  request.finish(0);
  request.finish(200);
  assert.equal(tracker.snapshot().active.length, 0);
  const canceled = tracker.snapshot().recent[0];
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.cancelReason, "client_disconnected");
  tracker.begin().finish(200);
  const deadline = tracker.begin();
  deadline.cancel("execution_deadline");
  deadline.finish(504);
  assert.deepEqual(tracker.snapshot().recent.map((r) => r.state), ["completed", "failed"]);
  time = 11;
  assert.deepEqual(tracker.snapshot().recent, []);
});

test("byte observer is transparent and counts only received bytes", async () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  const observer = request.byteObserver();
  const bytes = Buffer.from('data: {"type":"response.created"}\n\n');
  observer.end(bytes);
  const output = [];
  for await (const chunk of observer) output.push(chunk);
  assert.deepEqual(Buffer.concat(output), bytes);
  assert.equal(tracker.snapshot().active[0].receivedBytes, bytes.length);
  assert.equal(tracker.snapshot().active[0].receivedEvents, 0);
});


test("unsuccessful response terminal is failed even under an HTTP 200 envelope", () => {
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    const tracker = createRequestProgress();
    const request = tracker.begin();
    assert.equal(tracker.snapshot().active[0].phase, "unobserved");
    assert.equal(tracker.snapshot().active[0].upstreamAttempts, undefined);
    request.event({ type });
    request.event({ type: "response.completed" });
    request.finish(200);
    assert.equal(tracker.snapshot().recent[0].state, "failed");
    assert.equal(tracker.snapshot().recent[0].status, 200);
    assert.equal(tracker.snapshot().recent[0].terminalEvent, type);
  }
});


test("response.completed carrying an unsuccessful embedded status is failed", () => {
  for (const status of ["failed", "incomplete", "cancelled"]) {
    const tracker = createRequestProgress();
    const request = tracker.begin();
    request.attempt();
    request.event({ type: "response.completed", response: { status } });
    request.finish(200);
    const [record] = tracker.snapshot().recent;
    assert.equal(record.state, "failed", status);
    assert.equal(record.terminalEvent, "response.completed");
    assert.equal(record.terminalStatus, status);
  }
  for (const response of [undefined, {}, { status: "completed" }]) {
    const tracker = createRequestProgress();
    const request = tracker.begin();
    request.event({ type: "response.completed", ...(response ? { response } : {}) });
    request.finish(200);
    const [record] = tracker.snapshot().recent;
    assert.equal(record.state, "completed");
    assert.equal(record.terminalEvent, undefined);
    assert.equal(record.terminalStatus, undefined);
  }
});

test("a new attempt clears an embedded unsuccessful status", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.attempt();
  request.event({ type: "response.completed", response: { status: "incomplete" } });
  request.attempt();
  request.event({ type: "response.completed", response: { status: "completed" } });
  request.finish(200);
  const [record] = tracker.snapshot().recent;
  assert.equal(record.state, "completed");
  assert.equal(record.terminalStatus, undefined);
});

test("a successful new attempt replaces an unsuccessful earlier terminal", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.attempt();
  request.event({ type: "response.failed" });
  request.attempt();
  request.event({ type: "response.completed" });
  request.finish(200);
  assert.equal(tracker.snapshot().recent[0].state, "completed");
  assert.equal(tracker.snapshot().recent[0].upstreamAttempts, 2);
});
