import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { bridgeCustomTools, buildNamespaceLookups, flattenNamespaceTools, NamespaceToolCallTransform } from "../src/namespace-relay.mjs";
import { GROK_PATCH_HOOK_CODEC as codec, GROK_PATCH_HOOK_PREFIX as prefix, GROK_PATCH_HOOK_HEADER as header, GROK_PATCH_HOOK_CAPABILITY as capability, grokPatchHookEnabled } from "../src/grok-patch-hook-transport.mjs";
import { MAX_STRUCTURED_PATCH_BYTES } from "../src/grok-structured-patch.mjs";

const native = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "preserved" } };
function setup(tools = [native], input = []) {
  const flattened = flattenNamespaceTools(tools);
  const bridge = bridgeCustomTools(flattened.tools, input, flattened.namespaces, undefined, undefined, { codecs: new Map([["apply_patch", codec]]) });
  const lookups = buildNamespaceLookups(flattened.namespaces);
  return { ...bridge, namespaces: flattened.namespaces, lookups, name: [...lookups.customCodecs.keys()][0] };
}
const frame = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
async function relay(bridge, chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), new NamespaceToolCallTransform(bridge.namespaces, "text/event-stream", "grok-oauth/grok-4.6"), new Writable({ write(chunk, _, next) { output.push(chunk); next(); } }));
  return Buffer.concat(output).toString("utf8").split("\n\n").filter(Boolean).map(part => JSON.parse(part.split("\n").find(line => line.startsWith("data: ")).slice(6)));
}

test("hook transport requires exact route, flag, and capability together", () => {
  for (const slug of ["grok-oauth/grok-4.6", "grok-oauth/grok-4.5", "grok-api/grok-4.6"]) {
    for (const flag of [undefined, "0", "true", "1"]) {
      for (const declaration of [undefined, capability, `${capability}, ${capability}`, "structured-patch-v2"]) {
        assert.equal(grokPatchHookEnabled({ slug }, { [header]: declaration }, { CODEX_ROUTER_GROK_PATCH_HOOK: flag }), slug === "grok-oauth/grok-4.6" && flag === "1" && declaration === capability);
        assert.equal(grokPatchHookEnabled({ slug }, {}, { CODEX_ROUTER_GROK_PATCH_HOOK: flag }, declaration), slug === "grok-oauth/grok-4.6" && flag === "1" && declaration === capability);
      }
    }
  }
});

test("transport and history preserve all bounded raw strings, including invalid JSON", () => {
  for (const raw of ["", "{", '{"operations":[],"operations":[]}', ' \n{"number":1.0,"escaped":"\\u0061","unicode":"🧙 Привет"}\n', "*** Begin Patch\n*** End Patch"]) {
    assert.equal(codec.decodeArguments(raw), prefix + raw);
    for (const tools of [[native], []]) {
      const result = setup(tools, [{ type: "custom_tool_call", name: "apply_patch", id: "fc_old", call_id: "old", input: prefix + raw }, { type: "custom_tool_call_output", call_id: "old", output: "native error" }]);
      assert.equal(result.input[0].arguments, raw);
      assert.equal(result.input[0].id, "fc_old");
      assert.equal(result.input[0].call_id, "old");
      assert.deepEqual(result.input[1], { type: "function_call_output", call_id: "old", output: "native error" });
      assert.equal(result.lookups.customCodecs.size, tools.length);
    }
  }
  assert.equal(codec.encodeHistoryInput("legacy patch"), undefined);
  assert.equal(JSON.parse(setup([native], [{ type: "custom_tool_call", name: "apply_patch", input: "legacy patch" }]).input[0].arguments).input, "legacy patch");
});

test("raw argument bounds count UTF-8 bytes and reject invalid Unicode", () => {
  const maximum = "é".repeat(MAX_STRUCTURED_PATCH_BYTES / 2);
  assert.equal(codec.encodeHistoryInput(codec.decodeArguments(maximum)), maximum);
  for (const bad of [maximum + "a", "\ud800", undefined, {}]) assert.throws(() => codec.decodeArguments(bad));
  assert.throws(() => codec.encodeHistoryInput(prefix + maximum + "a"));
});

test("fragmented SSE preserves malformed arguments and identities for native hook feedback", async () => {
  for (const raw of ["{", '{"operations":[]}', '{"operations":[{"op":"add","path":"café.txt","lines":["Привет 🧙"]}]}']) {
    const ordinary = { type: "function", name: "apply_patch", parameters: { type: "object" } };
    const bridge = setup([native, ordinary, { type: "namespace", name: "plugin", tools: [ordinary] }]);
    assert.notEqual(bridge.name, "apply_patch");
    const call = { type: "function_call", id: "fc_patch", call_id: "call_patch", name: bridge.name, arguments: raw };
    const wire = frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }) +
      [...raw].map(delta => frame("response.function_call_arguments.delta", { output_index: 0, item_id: call.id, delta })).join("") +
      frame("response.function_call_arguments.done", { output_index: 0, item_id: call.id, arguments: raw }) +
      frame("response.output_item.done", { output_index: 0, item: call }) +
      frame("response.completed", { response: { output: [call] } });
    const events = await relay(bridge, [...Buffer.from(wire)].map(byte => Buffer.from([byte])));
    const expected = { type: "custom_tool_call", id: call.id, call_id: call.call_id, name: "apply_patch", input: prefix + raw };
    assert.deepEqual(events.find(e => e.type === "response.output_item.done").item, expected);
    assert.deepEqual(events.at(-1).response.output, [expected]);
    assert.equal(events.filter(e => e.type === "response.custom_tool_call_input.done").length, 1);
    assert.equal(events.filter(e => e.type === "response.custom_tool_call_input.delta").length, 0);
  }
});

test("hook mode still rejects conflicting closes and invalid outer SSE", async () => {
  const bridge = setup();
  const call = { type: "function_call", id: "fc", call_id: "call", name: bridge.name, arguments: "{" };
  await assert.rejects(relay(bridge, [frame("response.output_item.done", { item: call }), frame("response.output_item.done", { item: { ...call, arguments: "[" } })]));
  await assert.rejects(relay(bridge, ["event: response.output_item.done\ndata: {invalid\n\n"]));
});

test("atomic malformed arguments reach only the declared hook, never same-name tools", async () => {
  const ordinary = { type: "function", name: "apply_patch", parameters: { type: "object" } };
  for (const raw of ["", "{", '{"operations":[],"operations":[]}', ' {"number":1.0} ']) {
    const bridge = setup([native, ordinary]);
    const call = { type: "function_call", id: "fc", call_id: "call", name: bridge.name, arguments: raw };
    for (const type of ["response.output_item.done", "response.completed"]) {
      const frames = await relay(bridge, [frame(type, type === "response.completed" ? { response: { output: [call] } } : { item: call })]);
      assert.equal((frames[0].item || frames[0].response.output[0]).input, prefix + raw);
    }
  }
  for (const name of ["apply_patch", "unknown"]) {
    const bridge = setup([native, ordinary]);
    await assert.rejects(relay(bridge, [frame("response.output_item.done", { item: { type: "function_call", id: "fc", call_id: "call", name, arguments: "{" } })]));
  }
  const bridge = setup([native, ordinary]);
  await assert.rejects(relay(bridge, [frame("response.output_item.done", { item: { type: "function_call", id: "fc", call_id: "call", name: bridge.name, namespace: "plugin", arguments: "{" } })]));
});
