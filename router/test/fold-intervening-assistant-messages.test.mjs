import assert from "node:assert/strict";
import test from "node:test";

import { foldInterveningAssistantMessages } from "../src/http-utils.mjs";

function assistant(content, toolCalls) {
  return { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function call(id, name = "exec_command") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function toolResult(id, content = "ok") {
  return { role: "tool", tool_call_id: id, content };
}

// summarize() — compact, order-preserving view used to assert exact layouts.
function summarize(messages) {
  return messages.map((message) =>
    message.role === "tool"
      ? `tool:${message.tool_call_id}`
      : (message.tool_calls ?? []).map((toolCall) => toolCall.id).join(",") ||
        `text:${message.content}`,
  );
}

// assertStrictProviderShape() — the invariant strict chat-completions providers
// enforce. Deliberately stricter than "no exception thrown": it also rejects
// the degenerate shapes an earlier version of this pass could emit, because a
// validator that accepts them cannot prove the pass did its job.
function assertStrictProviderShape(messages) {
  messages.forEach((message, index) => {
    assert.ok(
      message && typeof message === "object",
      `message ${index} is not an object (${JSON.stringify(message)})`,
    );

    if (message.role === "assistant") {
      assert.notEqual(
        messages[index - 1]?.role,
        "assistant",
        `assistant message ${index} is consecutive with the previous assistant turn`,
      );
      const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      assert.ok(
        !Array.isArray(message.tool_calls) || hasCalls,
        `message ${index} carries an empty tool_calls array`,
      );
      const hasContent =
        (typeof message.content === "string" && message.content.trim().length > 0) ||
        (Array.isArray(message.content) && message.content.length > 0);
      assert.ok(
        hasCalls || hasContent,
        `message ${index} is an empty husk: no content and no tool_calls`,
      );

      if (hasCalls) {
        // Collect the adjacent tool run, rejecting a result that answers the
        // same call twice — a duplicate is as malformed as a missing one.
        const answered = new Set();
        let cursor = index + 1;
        while (messages[cursor]?.role === "tool") {
          const answeredId = messages[cursor].tool_call_id;
          assert.ok(
            !answered.has(answeredId),
            `call ${answeredId} is answered twice in the run after message ${index}`,
          );
          answered.add(answeredId);
          cursor += 1;
        }
        for (const toolCall of message.tool_calls) {
          assert.ok(toolCall?.id, `message ${index} has a tool_call with no id`);
          assert.ok(
            answered.has(toolCall.id),
            `message ${index} call ${toolCall.id} is not answered by the adjacent tool run`,
          );
        }
      }
    }

    if (message.role === "tool") {
      assert.ok(
        message.tool_call_id,
        `tool result at ${index} has no tool_call_id`,
      );
      let owner = index - 1;
      while (messages[owner]?.role === "tool") owner -= 1;
      const calling = messages[owner];
      assert.ok(
        calling?.role === "assistant" &&
          Array.isArray(calling.tool_calls) &&
          calling.tool_calls.some((toolCall) => toolCall.id === message.tool_call_id),
        `tool result ${message.tool_call_id} has no owning calling message above it`,
      );
    }
  });
}

// runBounded() — run the pass while capping how many times it may splice the
// array, so a non-terminating rewrite fails as an assertion instead of hanging
// the whole suite in an unbreakable synchronous loop.
function runBounded(messages, limit = 200) {
  const nativeSplice = Array.prototype.splice;
  let spliceCount = 0;
  Array.prototype.splice = function splice(...args) {
    if (this === messages) {
      spliceCount += 1;
      if (spliceCount > limit) throw new Error("pass did not terminate");
    }
    return nativeSplice.apply(this, args);
  };
  try {
    foldInterveningAssistantMessages(messages);
  } finally {
    Array.prototype.splice = nativeSplice;
  }
  return messages;
}

test("folds assistant commentary that sits between a call and its result", () => {
  const messages = [
    assistant(null, [call("A")]),
    assistant("thinking out loud"),
    toolResult("A"),
  ];

  foldInterveningAssistantMessages(messages);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, "thinking out loud");
  assert.deepEqual(summarize(messages), ["A", "tool:A"]);
  assertStrictProviderShape(messages);
});

test("re-seats trailing calls whose results are split by a nearer calling message", () => {
  // The subagent-closer shape: interrupt_agent (B) is spliced into the model's
  // wait_agent message, so B's result lands after an unrelated call C.
  const messages = [
    assistant(null, [call("A", "wait_agent"), call("B", "interrupt_agent")]),
    toolResult("A"),
    assistant(null, [call("C")]),
    toolResult("C"),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  assertStrictProviderShape(messages);
  assert.deepEqual(summarize(messages), ["A", "tool:A", "C", "tool:C", "B", "tool:B"]);
});

test("coalesces consecutive assistant call items before pairing their results", () => {
  const messages = [
    assistant("first", [call("A")]),
    assistant("second", [call("B")]),
    toolResult("A"),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, "first\nsecond");
  assert.deepEqual(messages[0].tool_calls.map((toolCall) => toolCall.id), ["A", "B"]);
  assertStrictProviderShape(messages);
});

test("does not leave an empty tool_calls array when every call is re-seated", () => {
  // Regression: with commentary between the calling message and the results,
  // pass 1 declines to fold (not all calls are answered by the next run), so
  // pass 2 moves EVERY call away. The emptied message must lose the key
  // entirely — `tool_calls: []` is rejected just as firmly as a call with no
  // adjacent result, which would swap one malformed payload for another.
  const messages = [
    assistant("lead", [call("A"), call("B")]),
    assistant("commentary"),
    toolResult("A"),
    assistant("more"),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  const emptied = messages[0];
  assert.equal(emptied.role, "assistant");
  assert.equal(emptied.content, "lead\ncommentary");
  assert.deepEqual(
    emptied.tool_calls.map((toolCall) => toolCall.id),
    ["A"],
    "the first re-seated call owns the preserved prose instead of an empty husk",
  );
  assertStrictProviderShape(messages);
});

test("removes the emptied calling message when it has no text of its own", () => {
  // A bridged `function_call` item carries no text, so the real-world shape of
  // the case above has `content: null`. Merely dropping the key would leave
  // `{role:"assistant",content:null}` — no content, no calls, nothing a
  // provider can act on — so the husk goes entirely.
  const messages = [
    assistant(null, [call("A"), call("B")]),
    assistant("commentary"),
    toolResult("A"),
    assistant("more"),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  for (const message of messages) {
    assert.ok(
      message.role !== "assistant" ||
        (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        (typeof message.content === "string" && message.content.trim().length > 0),
      `an empty husk survived: ${JSON.stringify(message)}`,
    );
  }
  assert.deepEqual(summarize(messages), ["A", "tool:A", "B", "tool:B"]);
  assert.equal(messages[0].content, "commentary");
  assert.equal(messages[2].content, "more");
  assertStrictProviderShape(messages);
});

test("keeps a message that carries fields beyond content and tool_calls", () => {
  // The husk removal must not silently discard data it does not understand,
  // so a message with any other field survives even when it looks empty.
  const messages = [
    { role: "assistant", content: null, reasoning_content: "deliberating", tool_calls: [call("A")] },
    assistant("commentary"),
    toolResult("A"),
    assistant(null, [call("B")]),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  const survivor = messages.find((message) => message.reasoning_content);
  assert.ok(survivor, "a message carrying reasoning_content must not be dropped");
});

test("carries structured content and metadata onto the re-seated call", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  const messages = [
    {
      role: "assistant",
      content: [image],
      reasoning_content: "thinking",
      tool_calls: [call("A"), call("B")],
    },
    assistant("commentary", undefined),
    toolResult("A"),
    assistant("more", undefined),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  assertStrictProviderShape(messages);
  assert.equal(messages[0].tool_calls[0].id, "A");
  assert.equal(messages[0].reasoning_content, "thinking");
  assert.deepEqual(messages[0].content, [image, { type: "text", text: "commentary" }]);
  assert.equal(messages[2].tool_calls[0].id, "B");
  assert.equal(messages[2].content, "more");
});

test("coalescing preserves every reasoning fragment", () => {
  const messages = [
    {
      role: "assistant",
      content: null,
      reasoning_content: "first thought",
      tool_calls: [call("A")],
    },
    {
      role: "assistant",
      content: "commentary",
      reasoning_content: "second thought",
      tool_calls: [call("B")],
    },
    toolResult("A"),
    toolResult("B"),
  ];

  foldInterveningAssistantMessages(messages);

  assertStrictProviderShape(messages);
  assert.equal(messages[0].reasoning_content, "first thought\nsecond thought");
  assert.equal(messages[0].content, "commentary");
  assert.deepEqual(messages[0].tool_calls.map((toolCall) => toolCall.id), ["A", "B"]);
});

test("conflicting unknown assistant metadata is preserved instead of guessed away", () => {
  const messages = [
    {
      role: "assistant",
      content: null,
      vendor_state: { sequence: 1 },
      tool_calls: [call("A")],
    },
    {
      role: "assistant",
      content: "commentary",
      vendor_state: { sequence: 2 },
    },
    toolResult("A"),
  ];
  const beforeMetadata = messages.slice(0, 2).map((message) => message.vendor_state);

  foldInterveningAssistantMessages(messages);

  assert.equal(messages.length, 3);
  assert.deepEqual(messages.slice(0, 2).map((message) => message.vendor_state), beforeMetadata);
  assert.equal(messages[0].tool_calls[0].id, "A");
  assert.equal(messages[1].content, "commentary");
});

test("terminates on a tool_call that has no id", () => {
  // Regression: an id-less call was classed as an orphan, and `undefined`
  // matched any tool message that also lacked a tool_call_id — so the same
  // call was re-seated on every turn of the outer loop, splicing forever and
  // growing the array without bound. Such calls must stay where they are.
  const messages = [
    assistant(null, [{ type: "function", function: { name: "f", arguments: "{}" } }, call("B")]),
    assistant("text"),
    { role: "tool", content: "ok" },
    toolResult("B"),
  ];

  runBounded(messages);

  assert.ok(messages.length <= 6, `array grew unexpectedly to ${messages.length}`);
  const idless = messages.find((message) =>
    (message.tool_calls ?? []).some((toolCall) => !toolCall.id),
  );
  assert.ok(idless, "the id-less call must be left in place, not re-seated");
});

test("terminates on duplicate call ids without rewriting malformed arguments", () => {
  const duplicate = {
    id: "B",
    type: "function",
    function: { name: "f", arguments: "not json" },
  };
  const messages = [
    assistant(null, [duplicate, { ...duplicate }, call("C")]),
    toolResult("A"),
    assistant("commentary"),
    toolResult("B"),
  ];

  runBounded(messages);

  const calls = messages.find((message) => message.role === "assistant").tool_calls;
  assert.deepEqual(calls.map((toolCall) => toolCall.id), ["B", "B", "C"]);
  assert.equal(calls[0].function.arguments, "not json");
});

test("is stable when applied twice", () => {
  const shapes = [
    () => [
      assistant(null, [call("A"), call("B")]),
      toolResult("A"),
      assistant(null, [call("C")]),
      toolResult("C"),
      toolResult("B"),
    ],
    () => [
      assistant(null, [call("A"), call("B")]),
      assistant("commentary"),
      toolResult("A"),
      assistant("more"),
      toolResult("B"),
    ],
  ];

  for (const build of shapes) {
    const messages = build();
    foldInterveningAssistantMessages(messages);
    const afterFirstPass = JSON.stringify(messages);
    foldInterveningAssistantMessages(messages);
    assert.equal(JSON.stringify(messages), afterFirstPass);
  }
});

test("leaves a call whose result never arrives exactly where it was", () => {
  // Deliberate limitation: dropping the call would rewrite history the
  // provider may still legitimately answer, so the pass prefers to leave it.
  const messages = [assistant(null, [call("A"), call("B")]), toolResult("A")];

  foldInterveningAssistantMessages(messages);

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages[0].tool_calls.map((toolCall) => toolCall.id),
    ["A", "B"],
  );
});

// ------------------------------------------------------------
// Known limitations — these record what the pass does NOT fix, so a future
// change that closes either gap fails here loudly instead of going unnoticed.
// ------------------------------------------------------------

test("KNOWN GAP: a kept unanswered call still ends up with no adjacent run", () => {
  // A never gets a result, B does but further down. B is re-seated and A is
  // kept, leaving message 0 followed by a non-tool message — the very shape
  // the pass exists to remove. Fixing this means deciding what to do with a
  // call the provider never answered, which is a separate question.
  const messages = [assistant("lead", [call("A"), call("B")]), assistant("commentary"), toolResult("B")];

  foldInterveningAssistantMessages(messages);

  assert.deepEqual(summarize(messages), ["A,B", "tool:B"]);
  assert.throws(
    () => assertStrictProviderShape(messages),
    /not answered by the adjacent tool run/,
    "if this stops throwing, the gap was closed and this test should become a positive one",
  );
});

test("KNOWN GAP: an empty tool_calls array present in the input is passed through", () => {
  // The pass only removes an array it emptied itself; one that arrived empty
  // is left alone, even though the same providers reject it.
  const messages = [assistant("hi", [])];

  foldInterveningAssistantMessages(messages);

  assert.deepEqual(messages[0].tool_calls, []);
});
