import assert from "node:assert/strict";
import test from "node:test";
import { readControlActivity } from "../src/control-activity.mjs";

const KEY = "test-caller-secret-0123456789abcdef";
test("activity probe keeps credentials and payloads out of its projection", async () => {
  const value = await readControlActivity({
    threadId: "worker-1", routerPort: 43210, readCallerSecret: () => KEY,
    fetchImpl: async (url, options) => {
      assert.equal(url, `http://127.0.0.1:43210/_codex-router/${KEY}/v1/activity?threadId=worker-1`);
      assert.equal(options.redirect, "error");
      return { ok: true, json: async () => ({
        version: 1, instanceId: "instance", observedAt: 123,
        active: [{ requestId: "request", phase: "reasoning", lastEventAt: 122, credential: KEY, content: "private" }],
        recent: [], credential: KEY,
      }) };
    },
  });
  assert.equal(value.ok, true);
  assert.deepEqual(value.active, [{ requestId: "request", phase: "reasoning", lastEventAt: 122 }]);
  assert.doesNotMatch(JSON.stringify(value), /private|test-caller-secret/);
});

test("offline, missing endpoint, bad ID and missing key are unknown, never a completed worker", async () => {
  for (const options of [
    { readCallerSecret: () => "invalid" },
    { threadId: "bad/id" },
    { fetchImpl: async () => ({ ok: false }) },
    { fetchImpl: async () => { throw new Error(`failed ${KEY}`); } },
    { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) },
  ]) {
    const result = await readControlActivity({ readCallerSecret: () => KEY, ...options });
    assert.equal(result.ok, false);
    assert.equal(result.state, "unknown");
    assert.equal(result.active, undefined);
    assert.doesNotMatch(JSON.stringify(result), /test-caller-secret/);
  }
});
