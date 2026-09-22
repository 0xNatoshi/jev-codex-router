import {
  actualServiceTierFromValue,
} from "./request-diagnostics.mjs";

// SSE joins repeated `data:` fields with a line feed before dispatch.
// Reading only the first field truncates multiline JSON.
export function sseDataFromBlock(rawEvent) {
  if (typeof rawEvent !== "string" || !rawEvent) return undefined;
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return dataLines.length ? dataLines.join("\n") : undefined;
}

// Parse one SSE block to a JSON event. Malformed JSON is a skipped event;
// the caller must not wrap `handlers()` in the same try/catch.
export function parseSseBlockEvent(rawEvent) {
  const data = sseDataFromBlock(rawEvent);
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export const DEFAULT_PROGRESS_ONLY_MAX_TEXT = 120;
export const DEFAULT_PROGRESS_ONLY_MIN_OUTPUT_TOKENS = 400;
export const REPAIR_FINAL_TOOL = "__codex_router_submit_final";
// The trigger below cannot tell a stalled turn from a finished one -- a task
// that ends "Done." is byte-for-byte the same shape as one that stops after
// "Next I will update the deck.". So the nudge must let the model decline. An
// imperative "call tools now" makes a finished turn invent a tool call, and
// `shouldPreferRetryTurn` would then graft that call onto the answer and the
// client would run it. Offering the no-tool branch first routes the finished
// case into keep-first instead.
const PROGRESS_ONLY_NUDGE =
  "If your previous message already completed the task, restate the final answer " +
  "and call no tool. Otherwise continue the same task now by calling the tools you need.";
// After a tool result the model is mid-task. Leading with "if you are done,
// stop" lets it treat a status sentence as completion. Lead with continue,
// and still allow a finished request to call nothing.
const AFTER_TOOL_NUDGE =
  "The previous tool call finished. Continue the user's task now. " +
  "You must make exactly one function call: call the next task tool if more work is needed, " +
  `or call ${REPAIR_FINAL_TOOL} with the complete final answer if the task is fully done. ` +
  "Do not return prose outside a function call.";

const REPAIR_FINAL_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: REPAIR_FINAL_TOOL,
    description: "Submit the complete final answer only when the user's task is fully finished.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
};

// The last non-system message is a tool result. Language-independent: a
// short stop after tool output is a mid-task stall, not a caption match.
export function lastClientMessageWasToolResult(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    return message.role === "tool";
  }
  return false;
}

export function requestOffersClientTools(chat) {
  return (
    Array.isArray(chat?.tools) &&
    chat.tools.some((tool) => tool?.type === "function" && tool.function?.name)
  );
}

// Not a detector for "the model stalled" -- no such signal exists in the turn.
// This matches the observable shape: short visible text, no client tool call,
// and enough output tokens that the model clearly reasoned. A finished task
// answered in one line matches too, which is why the retry has to be safe to
// lose rather than accurate to fire. See PROGRESS_ONLY_NUDGE.
//
// After a tool result, a short no-tool stop is mid-task even when this turn
// was cheap. The token floor stays for turns that follow a user message, so
// a one-line verdict like "Done." is not retried.
export function isProgressOnlyStop(
  turn,
  {
    maxText = DEFAULT_PROGRESS_ONLY_MAX_TEXT,
    minOutputTokens = DEFAULT_PROGRESS_ONLY_MIN_OUTPUT_TOKENS,
    afterToolResult = false,
  } = {},
) {
  if (turn?.terminalStatus !== "completed" || turn.toolCalls?.length > 0) return false;
  // After a tool result, prose alone is never accepted as proof of completion.
  // It is repaired into either another client tool call or an internal final
  // answer, regardless of length. This is the invariant that prevents a long
  // progress update from bypassing the short-text heuristic.
  if (afterToolResult) return true;
  const text = typeof turn.contentText === "string" ? turn.contentText : "";
  if (text.length > maxText) return false;
  const tokens = Number(turn.usage?.completion_tokens);
  return Number.isFinite(tokens) && tokens >= minOutputTokens;
}

// Prefer the retry only when it actually called a tool. A second short
// status sentence is not an improvement; keep the first answer.
export function shouldPreferRetryTurn(second) {
  return second?.terminalStatus === "completed" && Boolean(second.toolCalls?.length);
}

// A repair turn after a tool result is a protocol decision, not a prose
// heuristic. The retry must either call a tool or explicitly certify a final
// answer tool call requested above. Anything else is an invalid repair
// and must become a visible router error rather than a clean `stop`.
export function classifyAfterToolRepair(second) {
  // An item-level close only finishes that call's arguments. It does not
  // certify the response: failed, incomplete, and truncated attempts can all
  // contain a complete-looking client call or private final-answer call.
  if (second?.terminalStatus !== "completed") return { action: "fail" };
  const calls = Array.isArray(second?.toolCalls) ? second.toolCalls : [];
  if (calls.length !== 1) return { action: "fail" };
  const [call] = calls;
  if (call?.function?.name !== REPAIR_FINAL_TOOL) return { action: "tools" };
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { action: "fail" };
  }
  const finalText = typeof args?.answer === "string" ? args.answer.trim() : "";
  if (!finalText) return { action: "fail" };
  return { action: "final", contentText: finalText };
}

// Codex needs the context size of the selected attempt, not the sum of two
// prompts. Keep aggregate billed usage in explicit extension fields so a
// retry cannot make a ~150k context look like ~300k to the client.
export function selectedRetryUsage(first, second) {
  const selected = second || first;
  const usage = selected ? { ...selected } : {};
  delete usage.service_tier;
  delete usage.billed_service_tier;
  const billedPromptTokens =
    (first?.prompt_tokens || 0) + (second?.prompt_tokens || 0);
  const billedCompletionTokens =
    (first?.completion_tokens || 0) + (second?.completion_tokens || 0);
  return {
    ...usage,
    retries: 1,
    progress_only_retried: true,
    billed_prompt_tokens: billedPromptTokens,
    billed_completion_tokens: billedCompletionTokens,
  };
}

export function toolCallDeltas(turn) {
  return (turn?.deltas || []).filter(
    (delta) => Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0,
  );
}

export function withProgressOnlyNudge(chat, { afterToolResult = false } = {}) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const nudged = {
    ...chat,
    messages: [
      ...messages,
      {
        // Keep the tool result as the last model input. A trailing user message
        // starts a new conversational turn on xAI and can make a forced tool
        // choice complete empty. Developer text is hoisted into `instructions`.
        role: afterToolResult ? "developer" : "user",
        content: afterToolResult ? AFTER_TOOL_NUDGE : PROGRESS_ONLY_NUDGE,
      },
    ],
  };
  if (!afterToolResult) return nudged;
  const tools = Array.isArray(chat?.tools) ? chat.tools : [];
  return {
    ...nudged,
    tools: [
      ...tools.filter((tool) => tool?.function?.name !== REPAIR_FINAL_TOOL),
      REPAIR_FINAL_TOOL_DEFINITION,
    ],
    tool_choice: "required",
  };
}

function markProgressOnlyUsage(usage) {
  if (!usage) return { retries: 1, progress_only_retried: true };
  return { ...usage, retries: 1, progress_only_retried: true };
}

export function mergeMappedUsage(first, second) {
  if (!first) return markProgressOnlyUsage(second);
  if (!second) return markProgressOnlyUsage(first);
  const prompt = (first.prompt_tokens || 0) + (second.prompt_tokens || 0);
  const completion = (first.completion_tokens || 0) + (second.completion_tokens || 0);
  const cached =
    first.prompt_tokens_details?.cached_tokens === undefined &&
    second.prompt_tokens_details?.cached_tokens === undefined
      ? undefined
      : (first.prompt_tokens_details?.cached_tokens || 0) +
        (second.prompt_tokens_details?.cached_tokens || 0);
  const reasoning =
    first.completion_tokens_details?.reasoning_tokens === undefined &&
    second.completion_tokens_details?.reasoning_tokens === undefined
      ? undefined
      : (first.completion_tokens_details?.reasoning_tokens || 0) +
        (second.completion_tokens_details?.reasoning_tokens || 0);
  const merged = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    retries: 1,
    progress_only_retried: true,
  };
  if (cached !== undefined) merged.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning !== undefined) {
    merged.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return merged;
}

const TOOL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

export function createTurnState({ toolNameMapper = (name) => name } = {}) {
  return {
    contentText: "",
    reasoningText: "",
    toolCalls: [],
    toolByItemId: new Map(),
    usage: undefined,
    serviceTier: undefined,
    serviceTierUnknown: false,
    terminalStatus: undefined,
    deltas: [],
    toolNameMapper,
  };
}

export function chatServiceTierFields(turn) {
  // LiteLLM's Responses bridge drops the standard Chat field but preserves
  // provider_specific_fields. Carry only provider-reported bounded metadata.
  if (turn?.serviceTierUnknown) return { provider_specific_fields: { grok_service_tier: "unknown" } };
  if (turn?.serviceTier) return {
    service_tier: turn.serviceTier,
    provider_specific_fields: { grok_service_tier: turn.serviceTier },
  };
  return {};
}

function attachActualServiceTier(state, response) {
  const actual = actualServiceTierFromValue(response?.service_tier);
  state.serviceTier = actual.kind === "known" ? actual.value : undefined;
  state.serviceTierUnknown = actual.kind === "unknown";
}

export function mapUpstreamUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const mapped = {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens:
      (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
  };
  const cached = Number(usage.input_tokens_details?.cached_tokens);
  if (Number.isFinite(cached)) {
    mapped.prompt_tokens_details = { cached_tokens: cached };
  }
  const reasoning = Number(
    usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  );
  if (Number.isFinite(reasoning)) {
    mapped.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return mapped;
}

function toolArguments(item) {
  if (typeof item?.arguments === "string") return item.arguments;
  if (typeof item?.input === "string") return item.input;
  return "";
}

function streamedToolArguments(state, index) {
  return state.deltas
    .flatMap((delta) => delta.tool_calls || [])
    .filter((call) => call.index === index)
    .map((call) => call.function?.arguments || "")
    .join("");
}

function pushToolArgumentDelta(state, entry, delta) {
  if (!entry || !delta) return;
  const index = state.toolCalls.indexOf(entry);
  state.deltas.push({
    tool_calls: [{ index, function: { arguments: delta } }],
  });
}

function appendToolArgumentDelta(state, itemId, delta) {
  const entry = itemId ? state.toolByItemId.get(itemId) : undefined;
  if (!entry || !delta) return;
  entry.function.arguments += delta;
  pushToolArgumentDelta(state, entry, delta);
}

function backfillToolArgumentDeltas(state) {
  state.toolCalls.forEach((entry, index) => {
    const finalArgs = entry.function.arguments || "";
    const streamed = streamedToolArguments(state, index);
    if (!finalArgs || streamed === finalArgs) return;
    const extra = finalArgs.startsWith(streamed) ? finalArgs.slice(streamed.length) : finalArgs;
    pushToolArgumentDelta(state, entry, extra);
  });
}

function ensureToolCall(state, item, itemId, { complete = false } = {}) {
  if (!item || !TOOL_ITEM_TYPES.has(item.type)) return undefined;
  const key = itemId || item.id || item.call_id;
  let entry = key ? state.toolByItemId.get(key) : undefined;
  if (!entry) {
    const args = toolArguments(item);
    entry = {
      id: item.call_id || item.id || key,
      type: "function",
      function: { name: state.toolNameMapper(item.name || ""), arguments: args },
    };
    state.toolCalls.push(entry);
    if (key) state.toolByItemId.set(key, entry);
    state.deltas.push({
      tool_calls: [
        {
          index: state.toolCalls.length - 1,
          id: entry.id,
          type: "function",
          function: { name: entry.function.name, arguments: complete ? args : "" },
        },
      ],
    });
  } else {
    if (item.name) entry.function.name = state.toolNameMapper(item.name);
    const args = toolArguments(item);
    if (args) entry.function.arguments = args;
  }
  return entry;
}

function completedStatus(response) {
  const status = response?.status;
  if (!status || status === "completed") return "completed";
  return status === "failed" ? "failed" : "incomplete";
}

function recordTerminal(state, terminalStatus, response) {
  state.terminalStatus = terminalStatus;
  state.usage = mapUpstreamUsage(response?.usage);
  attachActualServiceTier(state, response);
}

export function applyResponsesEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  // The first terminal seals the attempt. A failure cannot be revived, and a
  // completed terminal certifies only what preceded it: content, reasoning,
  // tool, or terminal frames after it were never covered by a successful
  // terminal and cannot add actions or change the outcome. In particular,
  // [DONE] is never success evidence.
  if (state.terminalStatus) return state;
  switch (event.type) {
    case "response.output_text.delta": {
      if (event.delta) {
        state.contentText += event.delta;
        state.deltas.push({ content: event.delta });
      }
      break;
    }
    // xAI streams grok-4.6 summaries as reasoning_summary_text, and also
    // documents reasoning_text. Both belong on the chat `reasoning_content`
    // field so LiteLLM can put them back on the Responses reasoning channel
    // Codex uses to show-then-collapse thinking.
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      if (event.delta) {
        state.reasoningText += event.delta;
        state.deltas.push({ reasoning_content: event.delta });
      }
      break;
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = event.item;
      if (TOOL_ITEM_TYPES.has(item?.type)) {
        ensureToolCall(state, item, item.id, {
          complete: event.type === "response.output_item.done",
        });
      }
      break;
    }
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta": {
      appendToolArgumentDelta(state, event.item_id, event.delta);
      break;
    }
    case "response.function_call_arguments.done":
    case "response.custom_tool_call_input.done": {
      const complete = event.arguments ?? event.input ?? event.text;
      if (typeof complete === "string") {
        const entry = event.item_id ? state.toolByItemId.get(event.item_id) : undefined;
        if (entry) {
          const extra = complete.startsWith(entry.function.arguments)
            ? complete.slice(entry.function.arguments.length)
            : complete;
          entry.function.arguments = complete;
          pushToolArgumentDelta(state, entry, extra);
        }
      }
      break;
    }
    case "response.completed": {
      recordTerminal(state, completedStatus(event.response), event.response);
      break;
    }
    case "response.failed":
    case "error": {
      recordTerminal(state, "failed", event.response);
      break;
    }
    case "response.incomplete": {
      recordTerminal(state, "incomplete", event.response);
      break;
    }
    default:
      break;
  }
  return state;
}

export function finalizeTurn(state) {
  const terminalStatus = state.terminalStatus || "missing";
  if (terminalStatus === "completed") backfillToolArgumentDeltas(state);
  return {
    contentText: state.contentText,
    reasoningText: state.reasoningText,
    toolCalls: state.toolCalls,
    usage: state.usage,
    serviceTier: state.serviceTier,
    serviceTierUnknown: state.serviceTierUnknown === true,
    deltas: state.deltas,
    terminalStatus,
    finishReason: terminalStatus === "completed"
      ? state.toolCalls.length ? "tool_calls" : "stop"
      : null,
  };
}

export function collectResponsesEvents(events) {
  const state = createTurnState();
  for (const event of events || []) applyResponsesEvent(state, event);
  return finalizeTurn(state);
}
