import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  EmptyCompletionGuard,
  EmptyCompletionTerminalGuard,
} from "../src/empty-completion-guard.mjs";

async function runGuard(
  input,
  {
    contentType = "text/event-stream; charset=utf-8",
    chunkSize = 0,
    maxPreludeBytes,
    maxPreludeMs,
  } = {},
) {
  const guard = new EmptyCompletionGuard(contentType, {
    ...(maxPreludeBytes === undefined ? {} : { maxPreludeBytes }),
    ...(maxPreludeMs === undefined ? {} : { maxPreludeMs }),
  });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = [];
  if (chunkSize > 0) {
    for (let at = 0; at < input.length; at += chunkSize) {
      source.push(Buffer.from(input.slice(at, at + chunkSize)));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), guard, collector);
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    empty: guard.isEmpty(),
    suppressed: guard.suppressedPrologue(),
    live: guard.releasedForLiveness(),
    preludeLimit: guard.preludeLimitKind(),
  };
}

function block(...parts) {
  return parts.join("\n") + "\n\n";
}

// DeepSeek V4 Flash with many MCP tools: large tool declarations in prologue
// plus reasoning can exceed byte limit before tool call content appears.
test("Large MCP tool declarations plus reasoning before tool call should not hit byte limit prematurely", async () => {
  // Simulate many MCP tools with large schemas (each ~50KB)
  const largeToolSchema = JSON.stringify({
    properties: {
      param1: { type: "string", description: "x".repeat(10000) },
      param2: { type: "string", description: "y".repeat(10000) },
      param3: { type: "string", description: "z".repeat(10000) },
      param4: { type: "string", description: "w".repeat(10000) },
      param5: { type: "string", description: "v".repeat(10000) },
    }
  });

  // Build a large response.created event with many tools
  const manyTools = [];
  for (let i = 0; i < 15; i++) {
    manyTools.push({ name: `mcp_tool_${i}`, schema: largeToolSchema });
  }

  const createdEvent = {
    type: "response.created",
    response: {
      id: "r_mcp",
      tools: manyTools,
      metadata: { large_field: "x".repeat(50000) }
    }
  };

  // ~800KB in response.created
  const createdBlock = block(
    'event: response.created',
    `data: ${JSON.stringify(createdEvent)}`
  );

  // Add reasoning that pushes total over 1MB
  const reasoning = "thinking".repeat(30000); // ~240KB

  const input = [
    createdBlock,
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_mcp"}}'
    ),
    block(
      'event: response.reasoning_text.delta',
      `data: {"type":"response.reasoning_text.delta","delta":"${reasoning}"}`
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_mcp","name":"mcp_tool_0"}}'
    ),
    block(
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_mcp","arguments":"{}"}'
    ),
    block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r_mcp","output":[]}}'
    ),
  ].join("");

  const result = await runGuard(input, { maxPreludeBytes: 1024 * 1024 });
  assert.equal(result.empty, false, "turn with tool call should not be empty");
  // If this fails with preludeLimit: "bytes", that's the bug
  assert.equal(result.preludeLimit, undefined, "should not hit prelude byte limit before tool call");
  assert.match(result.body, /response\.function_call_arguments\.done/);
});

// Bug #684 reproduction: DeepSeek V4.1 Flash with incremental delivery of
// massive reasoning can hit parse buffer limit if reasoning delta arrives
// in many small network chunks, causing buffer to accumulate.
test("Bug #684: incremental delivery of massive reasoning should not kill stream", async () => {
  // Simulate realistic network chunking: large reasoning arrives in small pieces
  const massiveReasoning = "x".repeat(1100000); // 1.1 MB reasoning

  const input = [
    block(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r_684"}}'
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_684"}}'
    ),
    // Trigger liveness release
    block(
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"initial"}'
    ),
    // Large reasoning event that will be chunked
    block(
      'event: response.reasoning_text.delta',
      `data: {"type":"response.reasoning_text.delta","delta":"${massiveReasoning}"}`
    ),
    // Tool call arrives after reasoning
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_684","name":"exec"}}'
    ),
    block(
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_684","arguments":"{}"}'
    ),
    block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r_684","output":[]}}"}'
    ),
  ].join("");

  try {
    // Use small chunks (1KB) to simulate incremental network delivery
    const result = await runGuard(input, {
      maxPreludeBytes: 1024 * 1024,
      chunkSize: 1024
    });
    assert.equal(result.empty, false, "turn with tool call should not be empty");
    assert.equal(result.preludeLimit, undefined, "Bug #684: should not hit parse buffer limit with chunked delivery");
    assert.match(result.body, /response\.function_call_arguments\.done/);
  } catch (error) {
    // This is bug #684: guard throws when massive reasoning is delivered in chunks
    assert.fail(`Bug #684: Guard threw error with chunked massive reasoning: ${error.message}`);
  }
});

// DeepSeek V4 Flash with incomplete massive reasoning event should not kill
// stream. This tests the parse buffer limit when an SSE event is very large
// and hasn't been fully received yet.
test("Incomplete massive reasoning event should not hit parse buffer limit", async () => {
  // Create a massive data payload that will be incomplete (no double newline yet)
  const massiveReasoning = "x".repeat(1100000); // 1.1 MB

  const input = [
    block(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r_incomplete"}}'
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_incomplete"}}'
    ),
    // Trigger liveness release
    block(
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"initial"}'
    ),
    // Now send an incomplete SSE block (no double newline yet) that exceeds the limit
    `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"${massiveReasoning}"}`,
    // No double newline yet - this makes the parse buffer exceed 1MB
    // Then complete it and add the tool call
    '\n\n',
    ...block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_incomplete","name":"exec"}}'
    ),
    ...block(
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_incomplete","arguments":"{}"}'
    ),
    ...block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r_incomplete","output":[]}}"}'
    ),
  ].join("");

  try {
    const result = await runGuard(input, { maxPreludeBytes: 1024 * 1024 });
    assert.equal(result.empty, false, "turn with tool call should not be empty");
    assert.equal(result.preludeLimit, undefined, "should not hit parse buffer limit with incomplete block");
    assert.match(result.body, /response\.function_call_arguments\.done/);
  } catch (error) {
    // This is the bug! The guard throws when parse buffer exceeds limit
    assert.fail(`Guard threw error with incomplete massive reasoning: ${error.message}`);
  }
});

// DeepSeek V4 Flash with massive reasoning AFTER liveness release should not
// hit parse buffer byte limit before tool call content appears. This is the
// actual bug from #684: reasoning releases for liveness, but continued parsing
// behind the relay can hit the byte limit if reasoning is large enough.
test("Massive reasoning after liveness release should not kill stream before tool call", async () => {
  // First, release for liveness with initial reasoning
  const initialReasoning = "initial thinking...";

  // Then add MASSIVE reasoning that will exceed parse buffer limit (>1MB)
  // while parsing behind the relay AFTER the stream was released for liveness
  const massiveReasoning = "x".repeat(1100000); // 1.1 MB

  const input = [
    block(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r_bug"}}'
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_bug"}}'
    ),
    // This triggers liveness release
    block(
      'event: response.reasoning_text.delta',
      `data: {"type":"response.reasoning_text.delta","delta":"${initialReasoning}"}`
    ),
    // Now stream is released, but guard keeps parsing behind relay.
    // This massive reasoning delta will cause parse buffer to exceed 1MB
    block(
      'event: response.reasoning_text.delta',
      `data: {"type":"response.reasoning_text.delta","delta":"${massiveReasoning}"}`
    ),
    // Tool call arrives after the massive reasoning
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_bug","name":"exec"}}'
    ),
    block(
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_bug","arguments":"{}"}'
    ),
    block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r_bug","output":[]}}"}'
    ),
  ].join("");

  try {
    const result = await runGuard(input, { maxPreludeBytes: 1024 * 1024 });
    assert.equal(result.empty, false, "turn with tool call should not be empty");
    // This is the bug: result.preludeLimit should be undefined but it's "bytes"
    assert.equal(result.preludeLimit, undefined, "should not hit parse buffer limit after liveness release");
    assert.match(result.body, /response\.function_call_arguments\.done/);
  } catch (error) {
    // This catch block should NOT trigger - if it does, that's the bug!
    assert.fail(`Guard threw error after liveness release: ${error.message}`);
  }
});

// The guard should still detect truly empty turns (reasoning only, no tool calls)
test("DeepSeek reasoning without any content is still recognized as empty", async () => {
  const input = [
    block(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r2"}}'
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_2"}}'
    ),
    block(
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}'
    ),
    block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r2","output":[]}}'
    ),
    block(
      'event: response.done',
      'data: {"type":"response.done","response":{"id":"r2"}}'
    ),
  ].join("");

  const result = await runGuard(input);
  assert.equal(result.empty, true, "turn with only reasoning should be empty");
  assert.equal(result.suppressed, false, "reasoning delta ends the hold");
  assert.equal(result.live, true, "reasoning proves liveness");
});

// Verify the guard recognizes tool call opening event as content immediately
test("response.output_item.added with function_call type is recognized as content", async () => {
  const input = [
    block(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r3"}}'
    ),
    block(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_immediate","name":"test"}}'
    ),
    block(
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_immediate","arguments":"{}"}'
    ),
    block(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r3","output":[]}}'
    ),
    block(
      'event: response.done',
      'data: {"type":"response.done","response":{"id":"r3"}}'
    ),
  ].join("");

  const result = await runGuard(input);
  assert.equal(result.empty, false, "function_call item should be content");
  // When the content event and terminal are adjacent, the terminal may be
  // processed before the guard releases, so suppressed can be either true or false
});
