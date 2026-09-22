import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GROK_STREAM_STALL_MS,
  grokGatewayStreamTimeoutSeconds,
  grokStreamStallMs,
  grokTransportIdleTimeoutMs,
} from "../src/grok-stream-timeouts.mjs";

test("the Grok stall bound accepts only a positive, timer-safe value", () => {
  assert.equal(grokStreamStallMs({}), DEFAULT_GROK_STREAM_STALL_MS);
  assert.equal(grokStreamStallMs({ CODEX_ROUTER_GROK_STREAM_STALL_MS: "90000" }), 90_000);
  // Node clamps a timer above 2^31-1 ms to 1ms, which would end every Grok
  // turn at its first reasoning event.
  for (const value of ["", "0", "-1", "abc", "Infinity", "3000000000", "2147483647"]) {
    assert.equal(
      grokStreamStallMs({ CODEX_ROUTER_GROK_STREAM_STALL_MS: value }),
      DEFAULT_GROK_STREAM_STALL_MS,
      value,
    );
  }
});

test("every Grok transport bound outlasts the stall guard and never shortens a hop", () => {
  for (const stall of [1, 90_000, DEFAULT_GROK_STREAM_STALL_MS, 30 * 60_000]) {
    const environment = { CODEX_ROUTER_GROK_STREAM_STALL_MS: String(stall) };
    const transportMs = grokTransportIdleTimeoutMs(environment);
    const gatewayMs = grokGatewayStreamTimeoutSeconds(environment) * 1000;
    assert.ok(transportMs > stall, `transport ${transportMs} <= stall ${stall}`);
    assert.ok(gatewayMs > stall, `gateway ${gatewayMs} <= stall ${stall}`);
    // Undici's own body idle default and the gateway's request_timeout.
    assert.ok(transportMs >= 300_000);
    assert.ok(gatewayMs >= 600_000);
  }
  assert.equal(grokTransportIdleTimeoutMs({}), 660_000);
  assert.equal(grokGatewayStreamTimeoutSeconds({}), 660);
});
