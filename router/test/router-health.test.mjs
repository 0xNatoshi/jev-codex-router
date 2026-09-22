import assert from "node:assert/strict";
import test from "node:test";

import { waitForRouterHealth } from "../src/router-health.mjs";

test("router health waits through a transient startup failure", async () => {
  let requests = 0;
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("connection refused");
      return new Response(JSON.stringify({ service: "codex-router", version: "test" }), {
        status: 200,
      });
    },
  });

  assert.equal(requests, 2);
  assert.equal(health.ok, true);
  assert.equal(health.payload.version, "test");
});

// A router that answers while the gateway is being restarted is a different
// failure from a router that is not listening, and doctor says so only if the
// payload survives the non-ok response.
test("router health names the unreachable dependency behind a 503", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ ok: false, service: "codex-router", version: "test", degraded: ["gateway"] }),
        { status: 503 },
      ),
  });

  assert.equal(health.ok, false);
  assert.match(health.error, /listening but reports gateway unreachable \(HTTP 503\)/);
  assert.deepEqual(health.degradedPayload.degraded, ["gateway"]);
});

test("router health rejects a different service on the configured port", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ service: "another-router" })),
  });

  assert.equal(health.ok, false);
  assert.match(health.error, /different service/);
  assert.equal(health.connectionRefused, false);
});

test("router health identifies only an exact refused loopback transport graph", async () => {
  const nestedRefusal = Object.assign(new Error("IPv4 refused"), { code: "ECONNREFUSED" });
  const causedRefusal = new Error("IPv6 refused", {
    cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
  });
  const refused = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => {
      throw new AggregateError([nestedRefusal, causedRefusal], "all loopback addresses refused");
    },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.connectionRefused, true);

  const reset = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => {
      throw new AggregateError([
        nestedRefusal,
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      ], "ambiguous transport failure");
    },
  });
  assert.equal(reset.connectionRefused, false);

  const timeout = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => {
      throw new DOMException("request timed out", "TimeoutError");
    },
  });
  assert.equal(timeout.connectionRefused, false);
});

test("router health bounds a request by the remaining overall deadline", async () => {
  const startedAt = Date.now();
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 80,
    requestTimeoutMs: 500,
    intervalMs: 1,
    fetchImpl: (_url, { signal }) =>
      new Promise((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("request was never aborted")), 1_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });

  assert.equal(health.ok, false);
  assert.ok(Date.now() - startedAt < 250, "health request exceeded the overall timeout budget");
});
