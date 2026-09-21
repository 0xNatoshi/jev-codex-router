import assert from "node:assert/strict";
import test from "node:test";

import { CHECKPOINT_WARNING } from "../src/compaction-checkpoint.mjs";
import {
  CONVERSATION_WINDOW_TAIL_BYTES,
  conversationWindowEnabled,
  conversationWindowTailBytes,
  windowConversation,
} from "../src/conversation-window.mjs";

function message(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: `${role === "user" ? "input" : "output"}_text`, text }],
  };
}

function call(id, name = "exec_command", args = "{}") {
  return { type: "function_call", call_id: id, name, arguments: args };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

function reasoning(id, text) {
  return { type: "reasoning", id, summary: [{ type: "summary_text", text }] };
}

const FORCED = { enabled: true, tailBytes: 4 * 1024, minTotalBytes: 0 };

// Builds a conversation whose consumed middle is far larger than the tail
// budget, so the window has something to drop.
function longConversation({ turns = 12, fillerBytes = 4_000 } = {}) {
  const input = [message("system", "Follow the operator rules.")];
  for (let index = 0; index < turns; index += 1) {
    input.push(message("user", `question ${index}`));
    input.push(message("assistant", `answer ${index} ${"x".repeat(fillerBytes)}`));
  }
  return input;
}

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

test("keeps a conversation that already fits the budget byte-for-byte", () => {
  const input = [
    message("system", "Follow the operator rules."),
    message("user", "who wrote Dune?"),
    message("assistant", "Frank Herbert."),
    message("user", "and the sequel?"),
  ];

  const result = windowConversation(input);
  assert.deepEqual(result.input, input);
  // The pass ran and saw nothing to drop: the marker proves it, since every
  // counter is legitimately zero here.
  assert.equal(result.stats.conversationWindowRan, true);
  assert.equal(result.stats.conversationWindowItemsDropped, 0);
  assert.equal(result.stats.conversationWindowBytesSaved, 0);
  assert.equal(result.stats.conversationWindowTailBytes, CONVERSATION_WINDOW_TAIL_BYTES);
});

test("drops the consumed middle while keeping instructions and the newest request", () => {
  const input = longConversation();
  input.push(message("user", "now finish the job"));

  const result = windowConversation(input, FORCED);
  assert.ok(result.stats.conversationWindowItemsDropped > 0);
  assert.ok(result.stats.conversationWindowBytesSaved > 0);
  assert.ok(result.input.length < input.length);
  // The operator's rules survive regardless of age.
  assert.deepEqual(result.input[0], input[0]);
  // The request being answered is the last thing the provider reads.
  assert.deepEqual(result.input.at(-1), input.at(-1));
  // The oldest consumed turn is gone.
  assert.equal(result.input.includes(input[1]), false);
  // What survives is a suffix of the original conversation.
  const kept = result.input.slice(1);
  assert.deepEqual(kept, input.slice(input.length - kept.length));
});

test("a follow-up keeps the turn it depends on", () => {
  const input = longConversation();
  input.push(message("user", "who wrote Dune?"));
  input.push(message("assistant", "Frank Herbert."));
  input.push(message("user", "and the sequel?"));

  const result = windowConversation(input, FORCED);
  const tail = result.input.slice(-3);
  assert.deepEqual(tail, [
    message("user", "who wrote Dune?"),
    message("assistant", "Frank Herbert."),
    message("user", "and the sequel?"),
  ]);
});

test("never keeps a tool result whose call was dropped", () => {
  const input = [message("system", "rules")];
  for (let index = 0; index < 10; index += 1) {
    input.push(call(`old-${index}`));
    input.push(output(`old-${index}`, "y".repeat(4_000)));
  }
  input.push(call("fresh"));
  input.push(output("fresh", "small"));
  input.push(message("user", "continue"));

  const result = windowConversation(input, FORCED);
  const callIds = new Set(
    result.input.filter((item) => item.type === "function_call").map((item) => item.call_id),
  );
  const outputs = result.input.filter((item) => item.type === "function_call_output");
  assert.ok(outputs.length > 0);
  for (const item of outputs) {
    assert.ok(callIds.has(item.call_id), `dangling tool result ${item.call_id}`);
  }
});

test("keeps the native tool-search call when its discovery output crosses the cut", () => {
  const searchCall = {
    type: "tool_search_call",
    execution: "client",
    status: "completed",
    call_id: "search-1",
    arguments: { query: "find a tool" },
  };
  const searchOutput = {
    type: "tool_search_output",
    execution: "client",
    status: "completed",
    call_id: "search-1",
    tools: [{ type: "function", name: "discovered", parameters: { type: "object" } }],
  };
  const input = [...longConversation(), searchCall, searchOutput, message("user", "continue")];
  const snapshot = structuredClone(input);
  const result = windowConversation(input, {
    tailBytes: bytesOf(searchOutput) + bytesOf(input.at(-1)),
    boundarySlackItems: 0,
  });
  assert.deepEqual(result.input.slice(-3), [searchCall, searchOutput, input.at(-1)]);
  assert.ok(result.stats.conversationWindowItemsDropped > 0);
  assert.deepEqual(input, snapshot);
});

test("all retained parallel results keep their calls even after a non-result frontier", () => {
  const first = call("first");
  const second = call("second");
  const boundary = message("assistant", "Both tools are running.");
  const results = [output("second", "two"), output("first", "one")];
  const gap = message("assistant", "Waiting.");
  const input = [...longConversation(), first, second, gap, boundary, ...results];
  const result = windowConversation(input, {
    tailBytes: bytesOf(boundary) + results.reduce((sum, item) => sum + bytesOf(item), 0),
    boundarySlackItems: 0,
  });
  assert.deepEqual(result.input.slice(-6), [first, second, gap, boundary, ...results]);
});

test("widening the frontier closes dependencies newly pulled into the retained tail", () => {
  const a = call("a");
  const b = call("b");
  const c = call("c");
  const tail = [a, b, output("b", "b"), c, output("a", "a"), output("c", "c")];
  const input = [...longConversation(), ...tail];
  const result = windowConversation(input, {
    tailBytes: bytesOf(tail.at(-1)),
    boundarySlackItems: 0,
  });
  assert.deepEqual(result.input.slice(-tail.length), tail);
});

test("dependency matching uses the call type and id, never a later or unrelated call", () => {
  const originalOrphan = {
    type: "tool_search_output", execution: "client", status: "completed",
    call_id: "shared", tools: [],
  };
  const laterSearch = {
    type: "tool_search_call", execution: "client", status: "completed",
    call_id: "shared", arguments: { query: "later" },
  };
  const unrelated = call("shared");
  const tail = [originalOrphan, laterSearch, message("user", "continue")];
  const input = [...longConversation(), unrelated, message("assistant", "gap"), ...tail];
  const result = windowConversation(input, {
    tailBytes: tail.reduce((sum, item) => sum + bytesOf(item), 0),
    boundarySlackItems: 0,
  });
  assert.equal(result.input.includes(unrelated), false);
  assert.deepEqual(result.input.slice(-tail.length), tail);
});

test("never begins the kept region on a reasoning item", () => {
  const input = [message("system", "rules")];
  for (let index = 0; index < 8; index += 1) {
    input.push(message("user", `question ${index}`));
    input.push(reasoning(`rs_${index}`, "z".repeat(4_000)));
    input.push(message("assistant", `answer ${index}`));
  }
  input.push(message("user", "continue"));

  const result = windowConversation(input, FORCED);
  assert.notEqual(result.input[1]?.type, "reasoning");
});

test("pins the carriers of already-compacted history", () => {
  const carrier = message(
    "user",
    `${CHECKPOINT_WARNING}\n\ncheckpoint body ${"c".repeat(2_000)}`,
  );
  const input = [message("system", "rules"), carrier, ...longConversation().slice(1)];
  input.push(message("user", "continue"));

  const result = windowConversation(input, FORCED);
  assert.equal(result.input.includes(carrier), true);
  assert.equal(result.stats.conversationWindowItemsDropped > 0, true);
});

test("drops an old compaction carrier only when it is not a carrier", () => {
  const ordinary = message("user", `unrelated question ${"q".repeat(2_000)}`);
  const input = [message("system", "rules"), ordinary, ...longConversation().slice(1)];
  input.push(message("user", "continue"));

  const result = windowConversation(input, FORCED);
  assert.equal(result.input.includes(ordinary), false);
});

test("a request larger than the whole budget still reaches the model in full", () => {
  const current = message("user", `read this ${"v".repeat(40_000)}`);
  const input = [...longConversation(), current];

  const result = windowConversation(input, FORCED);
  assert.deepEqual(result.input.at(-1), current);
  // The oversized request survives in full; only older turns give way.
  assert.equal(result.input.includes(current), true);
  assert.ok(result.stats.conversationWindowBytesAfter >= bytesOf(current));
});

test("keeps the current request while dropping the tool traffic it already consumed", () => {
  const request = message("user", "audit the repository");
  const input = [message("system", "rules"), request];
  for (let index = 0; index < 10; index += 1) {
    input.push(call(`step-${index}`));
    input.push(output(`step-${index}`, "y".repeat(8_000)));
  }
  input.push(call("latest"));
  input.push(output("latest", "small"));

  const result = windowConversation(input, FORCED);
  // The request that opened the turn still reaches the model...
  assert.equal(result.input.includes(request), true);
  assert.deepEqual(result.input[0], input[0]);
  // ...while the middle of its own tool traffic is dropped, and the newest step
  // with its result survives so the loop can continue from it.
  assert.equal(result.input.includes(input[2]), false);
  assert.ok(result.stats.conversationWindowBytesSaved > 0);
  assert.deepEqual(result.input.slice(-2), [call("latest"), output("latest", "small")]);
});

test("the newest request is pinned even when the tail budget cannot reach it", () => {
  const request = message("user", "keep going");
  const input = [message("system", "rules"), request];
  for (let index = 0; index < 30; index += 1) {
    input.push(call(`step-${index}`));
    input.push(output(`step-${index}`, "z".repeat(6_000)));
  }

  const result = windowConversation(input, FORCED);
  assert.equal(result.input.includes(request), true);
  assert.ok(result.input.length < input.length);
  // Dropping the middle never leaves a tool result without its call.
  const callIds = new Set(
    result.input.filter((item) => item.type === "function_call").map((item) => item.call_id),
  );
  const outputs = result.input.filter((item) => item.type === "function_call_output");
  assert.ok(outputs.length > 0);
  for (const item of outputs) {
    assert.ok(callIds.has(item.call_id), `dangling tool result ${item.call_id}`);
  }
});

test("the rewrite is deterministic so an unchanged prefix keeps its cache match", () => {
  const input = [...longConversation(), message("user", "continue")];
  const first = windowConversation(input, FORCED);
  const second = windowConversation(input, FORCED);
  assert.deepEqual(first.input, second.input);
  assert.deepEqual(first.stats, second.stats);
});

test("the kill switch leaves the conversation untouched", () => {
  const input = [...longConversation(), message("user", "continue")];
  const result = windowConversation(input, { enabled: false, tailBytes: 4 * 1024 });
  assert.equal(result.input, input);
  // A disabled pass is distinguishable from "ran and found nothing": the
  // marker stays false so the ledger never claims the window looked.
  assert.equal(result.stats.conversationWindowRan, false);
  assert.equal(result.stats.conversationWindowBytesSaved, 0);
  assert.equal(result.stats.conversationWindowItemsDropped, 0);
});

test("the ran marker is true whenever the pass is enabled and reads input", () => {
  const trimmed = windowConversation([...longConversation(), message("user", "go")], FORCED);
  assert.equal(trimmed.stats.conversationWindowRan, true);
  const untouched = windowConversation([message("user", "hi")]);
  assert.equal(untouched.stats.conversationWindowRan, true);
});

test("a zero tail keeps only pinned items and the request", () => {
  const input = [...longConversation(), message("user", "continue")];
  const result = windowConversation(input, { enabled: true, tailBytes: 0 });
  assert.equal(result.input.length, 2);
  assert.deepEqual(result.input[0], input[0]);
  assert.deepEqual(result.input.at(-1), input.at(-1));
});

test("empty and non-array input are returned untouched", () => {
  assert.deepEqual(windowConversation([]).input, []);
  assert.equal(windowConversation(undefined).input, undefined);
});

test("the byte budget is reported so operators can see the saving", () => {
  const input = [...longConversation(), message("user", "continue")];
  const result = windowConversation(input, FORCED);
  assert.equal(
    result.stats.conversationWindowBytesBefore,
    input.reduce((sum, item) => sum + bytesOf(item), 0),
  );
  assert.equal(
    result.stats.conversationWindowBytesAfter,
    result.input.reduce((sum, item) => sum + bytesOf(item), 0),
  );
  assert.equal(
    result.stats.conversationWindowBytesSaved,
    result.stats.conversationWindowBytesBefore - result.stats.conversationWindowBytesAfter,
  );
  assert.ok(
    result.stats.conversationWindowBytesAfter <= result.stats.conversationWindowBytesBefore,
  );
});

test("the window is on unless the operator sets the kill switch", () => {
  const previous = process.env.CODEX_ROUTER_CONVERSATION_WINDOW;
  try {
    delete process.env.CODEX_ROUTER_CONVERSATION_WINDOW;
    assert.equal(conversationWindowEnabled(), true);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW = "1";
    assert.equal(conversationWindowEnabled(), true);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW = "0";
    assert.equal(conversationWindowEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_CONVERSATION_WINDOW;
    else process.env.CODEX_ROUTER_CONVERSATION_WINDOW = previous;
  }
});

test("the tail budget is tunable and falls back to the default on junk", () => {
  const previous = process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB;
  try {
    delete process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB;
    assert.equal(conversationWindowTailBytes(), CONVERSATION_WINDOW_TAIL_BYTES);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = "  ";
    assert.equal(conversationWindowTailBytes(), CONVERSATION_WINDOW_TAIL_BYTES);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = "nope";
    assert.equal(conversationWindowTailBytes(), CONVERSATION_WINDOW_TAIL_BYTES);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = "-4";
    assert.equal(conversationWindowTailBytes(), CONVERSATION_WINDOW_TAIL_BYTES);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = "32";
    assert.equal(conversationWindowTailBytes(), 32 * 1024);
    process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = "0";
    assert.equal(conversationWindowTailBytes(), 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB;
    else process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB = previous;
  }
});
