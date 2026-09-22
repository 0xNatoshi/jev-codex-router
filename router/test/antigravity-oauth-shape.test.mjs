import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAntigravitySsePayload,
  createAntigravityTurnState,
  finalizeAntigravityTurn,
  toAntigravityRequest,
} from "../src/antigravity-oauth-shape.mjs";

test("translates a plain user turn into Gemini contents", () => {
  const request = toAntigravityRequest(
    {
      model: "gemini-3-pro-high",
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "hello" },
      ],
    },
    { projectId: "my-project" },
  );
  assert.equal(request.model, "gemini-3-pro-high");
  assert.equal(request.project, "my-project");
  assert.equal(request.userAgent, "codex-router");
  assert.equal(request.request.systemInstruction.parts[0].text, "You are a coding assistant.");
  assert.deepEqual(request.request.contents, [
    { role: "user", parts: [{ text: "hello" }] },
  ]);
});

test("maps OpenAI tool choices onto Gemini function calling modes", () => {
  const base = {
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "use tools" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  };
  const config = (tool_choice) => toAntigravityRequest({ ...base, tool_choice })
    .request.toolConfig.functionCallingConfig;

  assert.deepEqual(config("auto"), { mode: "VALIDATED" });
  assert.deepEqual(config("none"), { mode: "NONE" });
  assert.deepEqual(config("required"), { mode: "ANY" });
  assert.deepEqual(
    config({ type: "function", function: { name: "read" } }),
    { mode: "ANY", allowedFunctionNames: ["read"] },
  );
});

test("pairs function calls with their named function responses", () => {
  const request = toAntigravityRequest(
    {
      model: "gemini-3-pro-high",
      messages: [
        { role: "user", content: "read file a" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
        },
      ],
    },
    { projectId: "p" },
  );
  assert.equal(request.request.contents.length, 3);
  assert.equal(request.request.contents[1].role, "model");
  assert.equal(request.request.contents[1].parts[0].functionCall.name, "read_file");
  assert.equal(request.request.contents[2].role, "user");
  assert.equal(request.request.contents[2].parts[0].functionResponse.name, "read_file");
  assert.equal(request.request.contents[2].parts[0].functionResponse.id, "call_1");
  assert.equal(
    request.request.contents[1].parts[0].thoughtSignature,
    "skip_thought_signature_validator",
  );
});

test("preserves a Gemini thought signature on a prior function call", () => {
  const request = toAntigravityRequest({
    model: "gemini-3.1-pro",
    messages: [
      { role: "user", content: "read file" },
      {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          thought_signature: "upstream-signature",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  });
  assert.equal(
    request.request.contents[1].parts[0].thoughtSignature,
    "upstream-signature",
  );
});

test("sanitizes unsupported JSON Schema constructs for Antigravity", () => {
  const request = toAntigravityRequest(
    {
      model: "gemini-3-pro-high",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "pick",
            parameters: {
              type: "object",
              properties: {
                mode: { type: "string", const: "fast" },
                retries: { type: "integer", enum: [1, 2] },
                enabled: { type: "boolean", const: true },
                count: { type: "integer", default: 1, encrypted: true },
                bounded: { type: "number", minimum: 0, exclusiveMaximum: 10 },
              },
              $schema: "https://json-schema.org/draft/2020-12/schema",
            },
          },
        },
      ],
    },
    { projectId: "p" },
  );
  const declaration = request.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.parameters.properties.mode.enum[0], "fast");
  assert.deepEqual(declaration.parameters.properties.retries.enum, ["1", "2"]);
  assert.deepEqual(declaration.parameters.properties.enabled.enum, ["true"]);
  assert.equal("const" in declaration.parameters.properties.mode, false);
  assert.equal("default" in declaration.parameters.properties.count, false);
  assert.equal("encrypted" in declaration.parameters.properties.count, false);
  assert.equal("minimum" in declaration.parameters.properties.bounded, false);
  assert.equal("exclusiveMaximum" in declaration.parameters.properties.bounded, false);
  assert.equal("$schema" in declaration.parameters, false);
});

test("sanitizes Codex tool schemas accepted by Claude Antigravity", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "inspect" }],
    tools: [{
      type: "function",
      function: {
        name: "inspect",
        parameters: {
          type: "object",
          id: "legacy-root",
          discriminator: { propertyName: "kind" },
          properties: {
            optional: { anyOf: [{ type: "string" }, { type: "null" }] },
            flexible: { anyOf: [{ type: "string" }, { type: "number" }] },
            metadata: { type: "array", items: true },
          },
        },
      },
    }],
  });
  const schema = request.request.tools[0].functionDeclarations[0].parameters;
  assert.equal("id" in schema, false);
  assert.equal("discriminator" in schema, false);
  assert.deepEqual(schema.properties.optional, { type: "string" });
  assert.deepEqual(schema.properties.flexible, { type: "string" });
  assert.deepEqual(schema.properties.metadata.items, {});
});

test("omits only Claude tools whose false schemas or conjunctions cannot be represented", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "inspect" }],
    tools: [
      {
        type: "function",
        function: {
          name: "safe",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "false_property",
          parameters: {
            type: "object",
            properties: { impossible: false },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "conjunction",
          parameters: {
            type: "object",
            properties: {
              value: {
                allOf: [
                  { type: "string", minLength: 1 },
                  { type: "string", pattern: "^[a-z]+$" },
                ],
              },
            },
          },
        },
      },
    ],
  });

  assert.deepEqual(
    request.request.tools[0].functionDeclarations.map((declaration) => declaration.name),
    ["safe"],
  );
});

test("omits Claude tools whose refs cannot be dereferenced without widening", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "inspect" }],
    tools: [
      {
        type: "function",
        function: {
          name: "safe",
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "safe_ref",
          parameters: {
            type: "object",
            properties: {
              value: { $ref: "#/$defs/alias", description: "Alias value." },
            },
            required: ["value"],
            $defs: {
              base: { type: "string", enum: ["a"] },
              alias: { $ref: "#/$defs/base" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "safe_unused_defs",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            $defs: { node: { $ref: "#/$defs/node" } },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "dangling_ref",
          parameters: {
            type: "object",
            properties: { value: { $ref: "#/$defs/missing" } },
            required: ["value"],
            $defs: {},
          },
        },
      },
      {
        type: "function",
        function: {
          name: "recursive_ref",
          parameters: {
            type: "object",
            properties: { node: { $ref: "#/$defs/node" } },
            $defs: {
              node: {
                type: "object",
                properties: { child: { $ref: "#/$defs/node" } },
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "conflicting_ref",
          parameters: {
            type: "object",
            properties: {
              base: { type: "string", enum: ["a"] },
              alias: { $ref: "#/properties/base", enum: ["a", "b"] },
            },
            required: ["alias"],
          },
        },
      },
    ],
  });

  assert.deepEqual(
    request.request.tools[0].functionDeclarations.map((declaration) => declaration.name),
    ["safe", "safe_ref", "safe_unused_defs"],
  );
  const safeRef = request.request.tools[0].functionDeclarations.find(
    (declaration) => declaration.name === "safe_ref",
  );
  assert.deepEqual(safeRef.parameters, {
    type: "object",
    properties: {
      value: { type: "string", enum: ["a"], description: "Alias value." },
    },
    required: ["value"],
  });
});

test("narrows Claude anyOf and provably disjoint oneOf branches deterministically", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "pick" }],
    tools: [{
      type: "function",
      function: {
        name: "pick",
        parameters: {
          type: "object",
          properties: {
            alternative: {
              anyOf: [
                { type: "string", pattern: "^safe$" },
                { type: "number" },
              ],
            },
            exclusive: { oneOf: [{ type: "string" }, { type: "number" }] },
            literalUnion: { type: ["number", "string"], enum: [1, "safe"] },
          },
        },
      },
    }],
  });
  const schema = request.request.tools[0].functionDeclarations[0].parameters;
  assert.deepEqual(schema.properties.alternative, { type: "number" });
  assert.deepEqual(schema.properties.exclusive, { type: "string" });
  assert.deepEqual(schema.properties.literalUnion, { type: "string", enum: ["safe"] });
});

test("omits a Claude oneOf tool when branch overlap cannot be excluded", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "pick" }],
    tools: [
      {
        type: "function",
        function: {
          name: "ambiguous",
          parameters: {
            type: "object",
            properties: {
              value: { oneOf: [{ type: "number" }, { type: "integer" }] },
            },
          },
        },
      },
      {
        type: "function",
        function: { name: "fallback", parameters: { type: "object", properties: {} } },
      },
    ],
  });
  assert.deepEqual(
    request.request.tools[0].functionDeclarations.map((declaration) => declaration.name),
    ["fallback"],
  );
});

test("narrows a discriminated Claude oneOf to its first provably exclusive branch", () => {
  const request = toAntigravityRequest({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "read" }],
    tools: [{
      type: "function",
      function: {
        name: "file_action",
        parameters: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { type: "string", const: "read" },
                path: { type: "string" },
              },
              required: ["action", "path"],
            },
            {
              type: "object",
              properties: {
                action: { type: "string", const: "write" },
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["action", "path", "content"],
            },
          ],
        },
      },
    }],
  });
  assert.deepEqual(request.request.tools[0].functionDeclarations[0].parameters, {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read"] },
      path: { type: "string" },
    },
    required: ["action", "path"],
  });
});

test("rejects a forced Claude tool when its schema was omitted", () => {
  assert.throws(
    () => toAntigravityRequest({
      model: "claude-opus-4-6-thinking",
      messages: [{ role: "user", content: "use impossible" }],
      tool_choice: { type: "function", function: { name: "impossible" } },
      tools: [{
        type: "function",
        function: {
          name: "impossible",
          parameters: { type: "object", properties: { value: false } },
        },
      }],
    }),
    (error) =>
      error.status === 400 &&
      error.code === "unsupported_forced_tool_schema" &&
      /impossible/.test(error.message),
  );
});

test("rejects required Claude tool use when every declaration was omitted", () => {
  assert.throws(
    () => toAntigravityRequest({
      model: "claude-opus-4-6-thinking",
      messages: [{ role: "user", content: "use a tool" }],
      tool_choice: "required",
      tools: [{
        type: "function",
        function: {
          name: "impossible",
          parameters: { type: "object", properties: { value: false } },
        },
      }],
    }),
    (error) =>
      error.status === 400 &&
      error.code === "no_representable_required_tool",
  );
});

test("does not mutate messages or schemas while shaping Claude tools", () => {
  const chat = {
    model: "claude-opus-4-6-thinking",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        }],
      },
      { role: "assistant", content: "checking" },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "inspect",
        parameters: {
          type: "object",
          id: "legacy",
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    }],
  };
  const before = structuredClone(chat);
  toAntigravityRequest(chat);
  assert.deepEqual(chat, before);
});

test("keeps Gemini boolean, union, id, and discriminator schemas unchanged", () => {
  const request = toAntigravityRequest({
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "inspect" }],
    tools: [{
      type: "function",
      function: {
        name: "inspect",
        parameters: {
          type: "object",
          id: "legacy",
          discriminator: { propertyName: "kind" },
          properties: {
            forbidden: false,
            list: { type: "array", items: true },
            union: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      },
    }],
  });
  assert.deepEqual(request.request.tools[0].functionDeclarations[0].parameters, {
    type: "object",
    id: "legacy",
    discriminator: { propertyName: "kind" },
    properties: {
      forbidden: false,
      list: { type: "array", items: true },
      union: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  });
});

test("accumulates Gemini SSE parts into an OpenAI-style turn", () => {
  const state = createAntigravityTurnState();
  applyAntigravitySsePayload(state, {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }],
    },
  });
  applyAntigravitySsePayload(state, {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    },
  });
  const turn = finalizeAntigravityTurn(state);
  assert.equal(turn.contentText, "Hello");
  assert.equal(turn.finishReason, "stop");
  assert.deepEqual(turn.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test("maps thinking parts and function calls", () => {
  const state = createAntigravityTurnState();
  applyAntigravitySsePayload(state, {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { thought: true, text: "reasoning" },
            { functionCall: { name: "look", args: { q: "x" }, id: "c1" } },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7, thoughtsTokenCount: 4 },
    },
  });
  const turn = finalizeAntigravityTurn(state);
  assert.equal(turn.reasoningText, "reasoning");
  assert.equal(turn.finishReason, "tool_calls");
  assert.equal(turn.toolCalls[0].function.name, "look");
  assert.equal(turn.toolCalls[0].function.arguments, "{\"q\":\"x\"}");
  assert.equal(turn.usage.completion_tokens_details.reasoning_tokens, 4);
});

test("uses the captured Antigravity thinking budget for each tier", () => {
  const request = toAntigravityRequest({
    model: "gemini-3.1-pro-high",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.deepEqual(request.request.generationConfig.thinkingConfig, {
    thinkingBudget: 10001,
    includeThoughts: true,
  });
  assert.equal(request.model, "gemini-pro-agent");
});

test("routes each Gemini family and effort to its current Antigravity model id", () => {
  const cases = [
    ["gemini-3.1-pro", undefined, "gemini-3.1-pro-low", 1001, 65535],
    ["gemini-3.1-pro", "high", "gemini-pro-agent", 10001, 65535],
    ["gemini-3.5-flash", undefined, "gemini-3.5-flash-low", 4000, 65536],
    ["gemini-3.5-flash", "low", "gemini-3.5-flash-extra-low", 1000, 65536],
    ["gemini-3.5-flash", "high", "gemini-3-flash-agent", 10000, 65536],
    ["gemini-3.6-flash", undefined, "gemini-3.6-flash-medium", 4000, 65536],
    ["gemini-3.6-flash", "low", "gemini-3.6-flash-low", 1000, 65536],
    ["gemini-3.6-flash", "high", "gemini-3.6-flash-high", 10000, 65536],
    ["gemini-3.7-flash", undefined, "gemini-3.7-flash-medium", 4000, 65536],
    ["gemini-3.7-flash", "low", "gemini-3.7-flash-low", 1000, 65536],
    ["gemini-3.7-flash", "high", "gemini-3.7-flash-high", -1, 65536],
  ];
  for (const [model, effort, upstreamModel, thinkingBudget, maxOutputTokens] of cases) {
    const request = toAntigravityRequest({
      model,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(request.model, upstreamModel);
    assert.equal(request.request.generationConfig.thinkingConfig.thinkingBudget, thinkingBudget);
    assert.equal(request.request.generationConfig.maxOutputTokens, maxOutputTokens);
  }
});

test("rejects unsupported efforts and caps caller output limits by family", () => {
  assert.throws(
    () =>
      toAntigravityRequest({
        model: "gemini-3.1-pro",
        reasoning_effort: "medium",
        messages: [{ role: "user", content: "hello" }],
      }),
    (error) => error.status === 400 && error.code === "unsupported_reasoning_effort",
  );
  const limited = toAntigravityRequest({
    model: "gemini-3.7-flash",
    max_tokens: 1200,
    max_completion_tokens: 900,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(limited.request.generationConfig.maxOutputTokens, 900);
  const capped = toAntigravityRequest({
    model: "gemini-3.7-flash",
    max_completion_tokens: 999999,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(capped.request.generationConfig.maxOutputTokens, 65536);
});

test("dereferences ref-heavy tool schemas before stripping protobuf keywords", () => {
  const parameters = {
    oneOf: [
      { $ref: "#/$defs/read" },
      { $ref: "#/$defs/write" },
    ],
    $defs: {
      read: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, pattern: ".+" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      write: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", contentMediaType: "text/plain" },
        },
        required: ["path", "content"],
      },
    },
    $comment: "not accepted by google.protobuf.Schema",
  };
  const request = toAntigravityRequest({
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "read" }],
    tools: [{ type: "function", function: { name: "files", parameters } }],
  });
  const schema = request.request.tools[0].functionDeclarations[0].parameters;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["content", "path"]);
  assert.deepEqual(schema.required, ["path"]);
  assert.equal("$defs" in schema, false);
  assert.equal("additionalProperties" in schema, false);
  assert.equal("minLength" in schema.properties.path, false);
  assert.equal("contentMediaType" in schema.properties.content, false);
  assert.equal(parameters.$defs.read.properties.path.minLength, 1, "input is not mutated");
  assert.deepEqual(request.request.toolConfig, {
    functionCallingConfig: { mode: "VALIDATED" },
  });
});

test("replays signed tool ids without leaking the signature into Google call ids", () => {
  const signedId = "call_1__thought__signature-value";
  const request = toAntigravityRequest({
    model: "gemini-3.7-flash",
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        tool_calls: [{
          id: signedId,
          type: "function",
          function: { name: "look", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: signedId, content: ["one", "two"] },
    ],
  });
  const call = request.request.contents[1].parts[0];
  const result = request.request.contents[2].parts[0].functionResponse;
  assert.equal(call.functionCall.id, "call_1");
  assert.equal(call.thoughtSignature, "signature-value");
  assert.equal(result.id, "call_1");
  assert.deepEqual(result.response, { output: ["one", "two"] });
});

test("puts one thought signature on the first call in a parallel replay batch", () => {
  const request = toAntigravityRequest({
    model: "gemini-3.7-flash",
    messages: [
      { role: "user", content: "compare both" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_a__thought__first-signature",
            type: "function",
            function: { name: "inspect_a", arguments: "{}" },
          },
          {
            id: "call_b__thought__second-signature",
            type: "function",
            function: { name: "inspect_b", arguments: "{}" },
          },
        ],
      },
    ],
  });
  const [first, second] = request.request.contents[1].parts;
  assert.equal(first.thoughtSignature, "first-signature");
  assert.equal("thoughtSignature" in second, false);
});

test("uses globally unique call ids when Google omits functionCall ids", () => {
  const idFromNewTurn = () => {
    const state = createAntigravityTurnState();
    applyAntigravitySsePayload(state, {
      candidates: [{
        content: { parts: [{ functionCall: { name: "inspect", args: {} } }] },
        finishReason: "STOP",
      }],
    });
    return finalizeAntigravityTurn(state).toolCalls[0].id;
  };
  const first = idFromNewTurn();
  const second = idFromNewTurn();
  assert.match(first, /^call_[0-9a-f-]{36}$/);
  assert.match(second, /^call_[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test("associates a preceding thought signature with a function call and emits empty args", () => {
  const state = createAntigravityTurnState();
  applyAntigravitySsePayload(state, {
    candidates: [{
      content: {
        parts: [
          { thought: true, text: "", thoughtSignature: "real-signature" },
          { functionCall: { id: "call_7", name: "inspect", args: {} } },
        ],
      },
      finishReason: "STOP",
    }],
  });
  const turn = finalizeAntigravityTurn(state);
  assert.equal(turn.toolCalls[0].id, "call_7__thought__real-signature");
  assert.deepEqual(turn.toolCalls[0].provider_specific_fields, {
    thought_signature: "real-signature",
  });
  assert.equal(turn.toolCalls[0].function.arguments, "{}");
  assert.deepEqual(turn.deltas[1].tool_calls[0].function, { arguments: "{}" });
});

test("does not carry signatures from visible text or reasoning onto a later tool", () => {
  for (const signedPart of [
    { text: "visible", thoughtSignature: "visible-signature" },
    { thought: true, text: "reasoning", thoughtSignature: "reasoning-signature" },
  ]) {
    const state = createAntigravityTurnState();
    applyAntigravitySsePayload(state, {
      candidates: [{ content: { parts: [signedPart] } }],
    });
    applyAntigravitySsePayload(state, {
      candidates: [{
        content: { parts: [{ functionCall: { id: "call_later", name: "inspect", args: {} } }] },
        finishReason: "STOP",
      }],
    });
    const call = finalizeAntigravityTurn(state).toolCalls[0];
    assert.equal(call.id, "call_later");
    assert.equal(call.provider_specific_fields, undefined);
  }
});

test("accepts wrapped and unwrapped payloads while rejecting embedded failures", () => {
  const state = createAntigravityTurnState();
  applyAntigravitySsePayload(state, {
    candidates: [{ content: { parts: [{ text: "unwrapped" }] } }],
  });
  applyAntigravitySsePayload(state, {
    response: {
      candidates: [{ content: { parts: [{ text: " wrapped" }] }, finishReason: "STOP" }],
    },
  });
  assert.equal(finalizeAntigravityTurn(state).contentText, "unwrapped wrapped");
  assert.throws(
    () => applyAntigravitySsePayload(createAntigravityTurnState(), {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "try later" },
    }),
    (error) => error.status === 429 && error.code === "RESOURCE_EXHAUSTED",
  );
  assert.throws(
    () => applyAntigravitySsePayload(createAntigravityTurnState(), {
      promptFeedback: { blockReason: "SAFETY" },
    }),
    (error) => error.status === 400 && error.code === "content_filter",
  );
});

test("rejects truncated streams and maps safety finishes to content_filter", () => {
  const incomplete = createAntigravityTurnState();
  applyAntigravitySsePayload(incomplete, {
    candidates: [{ content: { parts: [{ text: "partial" }] } }],
  });
  assert.throws(
    () => finalizeAntigravityTurn(incomplete),
    (error) => error.status === 502 && error.code === "incomplete_stream",
  );
  const filtered = createAntigravityTurnState();
  applyAntigravitySsePayload(filtered, {
    candidates: [{
      content: { parts: [{ text: "partial" }] },
      finishReason: "SAFETY",
    }],
  });
  assert.equal(finalizeAntigravityTurn(filtered).finishReason, "content_filter");

  const emptyFiltered = createAntigravityTurnState();
  applyAntigravitySsePayload(emptyFiltered, {
    candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
  });
  assert.equal(finalizeAntigravityTurn(emptyFiltered).finishReason, "content_filter");

  const emptyStop = createAntigravityTurnState();
  applyAntigravitySsePayload(emptyStop, {
    candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
  });
  assert.throws(
    () => finalizeAntigravityTurn(emptyStop),
    (error) => error.status === 502 && error.code === "empty_response",
  );
});

test("counts thought tokens as completion tokens and repairs inconsistent totals", () => {
  const state = createAntigravityTurnState();
  applyAntigravitySsePayload(state, {
    candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 4,
      totalTokenCount: 7,
    },
  });
  assert.deepEqual(finalizeAntigravityTurn(state).usage, {
    prompt_tokens: 5,
    completion_tokens: 6,
    total_tokens: 11,
    completion_tokens_details: { reasoning_tokens: 4 },
  });
});
