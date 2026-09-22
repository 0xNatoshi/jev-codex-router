import { agentMessagesAsUserMessages } from "./namespace-relay.mjs";

// The current direct Flash endpoint speaks Responses natively. Keep older
// aliases and reseller routes on their separately verified wire contracts.
export function usesDeepSeekResponses(model) {
  return model?.provider === "deepseek" && model?.upstreamModel === "deepseek-flash";
}

// Current native endpoint aliases, documented in DeepSeek's thinking guide.
// In particular xhigh maps to high; it is not the legacy Chat profile's max.
export function deepSeekResponsesEffort(value) {
  if (value === "none") return "none";
  if (["minimal", "low"].includes(value)) return "low";
  return ["max", "ultra"].includes(value) ? "max" : "high";
}

function reasoningContent(value) {
  const texts = typeof value === "string" ? [value]
    : Array.isArray(value) ? value.map((part) => part?.text) : [];
  return texts.filter((text) => typeof text === "string" && text)
    .map((text) => ({ type: "reasoning_text", text }));
}

// Plaintext reasoning uses an array of reasoning_text parts, not a JSON string.
// DeepSeek ignores summary/encrypted_content; older Chat-bridged turns can have
// only a summary. Replay its text once as reasoning, preserving part boundaries.
export function deepSeekResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  // The task text is already recovered; expose Codex handoffs as ordinary
  // messages because the public endpoint does not understand agent_message.
  return agentMessagesAsUserMessages(input).flatMap((item) => {
    if (item?.type !== "reasoning") return [item];
    let content = reasoningContent(item.content);
    if (!content.length) content = reasoningContent(item.summary);
    return content.length ? [{ type: "reasoning", content }] : [];
  });
}

// Only apply_patch has a native custom-tool contract at this endpoint. Other
// Codex freeform tools use the existing reversible function-tool bridge.
export function deepSeekCustomToolNames(tools, input, choice) {
  const names = new Set();
  const add = (type, name) => {
    if ((type === "custom" || type === "custom_tool_call") &&
        typeof name === "string" && name && name !== "apply_patch") names.add(name);
  };
  for (const tool of Array.isArray(tools) ? tools : []) add(tool?.type, tool?.name);
  for (const item of Array.isArray(input) ? input : []) add(item?.type, item?.name);
  add(choice?.type, choice?.name);
  for (const tool of choice?.type === "allowed_tools" && Array.isArray(choice.tools)
    ? choice.tools : []) add(tool?.type, tool?.name);
  return [...names];
}
