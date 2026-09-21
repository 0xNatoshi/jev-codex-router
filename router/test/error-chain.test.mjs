import assert from "node:assert/strict";
import test from "node:test";

import { formatErrorChain } from "../src/http-utils.mjs";

// The failure #171 could not explain from its logs: undici reports a connect
// failure as a bare `TypeError: fetch failed` and hides the socket-level code
// on the cause. The chain has to surface every link, or the log answers
// "something failed" and nothing else.
test("a fetch failure names the socket-level cause behind it", () => {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  assert.equal(
    formatErrorChain(error),
    "TypeError: fetch failed <- Error: connect ECONNREFUSED 127.0.0.1:443 (ECONNREFUSED)",
  );
});

// A dual-stack connect failure arrives as an AggregateError whose members,
// not whose cause, carry the socket codes.
test("an AggregateError is followed through its first member", () => {
  const error = new TypeError("fetch failed");
  const aggregate = new AggregateError(
    [
      Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("connect ENETUNREACH ::1:443"), { code: "ENETUNREACH" }),
    ],
    "",
  );
  error.cause = aggregate;
  assert.match(formatErrorChain(error), /AggregateError/);
  assert.match(formatErrorChain(error), /ETIMEDOUT/);
});

// The forwarders sit behind providers whose failures can wrap upstream
// response text into a message. Names and codes never carry a body, so that
// is all they may log.
test("messages can be suppressed while names and codes survive", () => {
  const error = new Error('upstream said {"secret":"leaky body text"}');
  error.code = "UND_ERR_SOCKET";
  error.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const formatted = formatErrorChain(error, { messages: false });
  assert.equal(formatted, "Error (UND_ERR_SOCKET) <- Error (ECONNRESET)");
  assert.equal(/leaky/.test(formatted), false);
});

test("a thrown non-error is stringified rather than dropped", () => {
  assert.equal(formatErrorChain("boom"), "boom");
  assert.equal(formatErrorChain(42), "42");
});

// A cyclic cause chain must terminate rather than loop; depth is the bound.
test("a cyclic cause chain terminates at the depth bound", () => {
  const first = new Error("first");
  const second = new Error("second");
  first.cause = second;
  second.cause = first;
  const formatted = formatErrorChain(first);
  assert.match(formatted, /^Error: first <- Error: second/);
  assert.equal(formatted.split(" <- ").length, 8);
});
