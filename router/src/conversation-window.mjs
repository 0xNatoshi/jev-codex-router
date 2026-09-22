import {
  CHECKPOINT_WARNING,
  LEGACY_V1_SUMMARY_PREFIX,
  LEGACY_WARNING,
} from "./compaction-checkpoint.mjs";

// A routed or native turn leaves this router as a stateless full conversation:
// neither Codex nor a routed provider keeps server-side turn state, because
// `previous_response_id` is stripped before the turn leaves. The client
// therefore replays every previous item on every turn, so a thread whose own
// text is a few kilobytes still bills hundreds of thousands of input tokens.
//
// This pass keeps the newest slice of the conversation byte-for-byte and drops
// what came before, rather than summarizing it. Nothing the model reads was
// rewritten behind the operator's back, and the client's own compaction
// threshold is left alone. Instruction messages and the carriers of
// already-compacted history are pinned regardless of age: dropping the former
// would lose the operator's rules, and dropping the latter would silently
// discard everything the client already compacted.
//
// The budget is measured over the whole conversation, and the frontier is
// pulled back onto safe boundaries, so a follow-up keeps the turn it depends on
// and a call is never separated from its result. The newest user request is
// pinned like an instruction, but the tool traffic that request already
// consumed is not: a long agentic turn used to replay every one of its own tool
// results on each following step, so the frontier is now allowed to advance
// past the newest user message and keep only the newest slice of the turn. The
// cut is deterministic, so an unchanged prefix still matches the provider's
// prompt cache.
export const CONVERSATION_WINDOW_TAIL_BYTES = 64 * 1024;
export const CONVERSATION_WINDOW_MIN_TOTAL_BYTES = 0;
export const CONVERSATION_WINDOW_BOUNDARY_SLACK_ITEMS = 4;

const OUTPUT_CALL_TYPES = new Map([
  ["function_call_output", "function_call"],
  ["custom_tool_call_output", "custom_tool_call"],
  ["local_shell_call_output", "local_shell_call"],
  ["tool_search_output", "tool_search_call"],
]);
const CALL_TYPES = new Set(OUTPUT_CALL_TYPES.values());
const REASONING_TYPES = new Set(["reasoning"]);
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const COMPACTION_TYPES = new Set(["compaction", "compaction_trigger"]);
// `renderCompactionValue` emits this when a compaction payload cannot be
// decoded. The text carries no history, but it must still survive: it is the
// client's only record that the earlier turns existed.
const UNREADABLE_COMPACTION_PREFIX =
  "[Earlier conversation history was compacted in an unreadable format.]";

// `CODEX_ROUTER_CONVERSATION_WINDOW=0` is the operator kill switch. Everything
// else, including an unset variable, leaves the pass enabled.
export function conversationWindowEnabled() {
  return process.env.CODEX_ROUTER_CONVERSATION_WINDOW !== "0";
}

// Native (provider) turns keep their whole conversation by default. Dropping
// items from them -- their own tool traffic is exactly what the budget trims --
// makes the upstream model lose the tool-call structure and re-emit calls as
// text markup (`to=functions.…`, `<|recipient|>…`, `<tool_call>{…}`), which
// Codex shows as plain text instead of executing. Observed on 21 September
// 2026: every windowed native call (1, then 78, then 91 items dropped) leaked,
// every unwindowed call was clean. Opt back in with
// `CODEX_ROUTER_NATIVE_CONVERSATION_WINDOW=1`.
export function nativeConversationWindowEnabled() {
  return process.env.CODEX_ROUTER_NATIVE_CONVERSATION_WINDOW === "1";
}

// `CODEX_ROUTER_CONVERSATION_WINDOW_KB=<n>` tunes how much of the newest
// conversation survives. Unset, blank, or unparsable falls back to the default,
// and `0` keeps only the pinned items plus the current turn. The value is read
// per turn, so it can be changed without restarting the router.
export function conversationWindowTailBytes() {
  const raw = process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB;
  if (raw === undefined || raw.trim() === "") return CONVERSATION_WINDOW_TAIL_BYTES;
  const kilobytes = Number(raw);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) {
    return CONVERSATION_WINDOW_TAIL_BYTES;
  }
  return Math.floor(kilobytes * 1024);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function isInstruction(item) {
  return item?.type === "message" && INSTRUCTION_ROLES.has(item.role);
}

function isUserMessage(item) {
  return item?.type === "message" && item.role === "user";
}

function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return undefined;
  const text = [];
  for (const part of item.content) {
    if (typeof part?.text !== "string") return undefined;
    text.push(part.text);
  }
  return text.join("");
}

// Compaction survives as a rewritten user message, not as ordinary history:
// `normalizeRoutedInput` and the native pass both turn a `compaction` item into
// a user message rendered by `renderCompactionValue`. Dropping it because it is
// an old user turn would silently throw away everything the client compacted,
// so carriers of compacted history are pivots exactly like instructions are.
function carriesCompactedHistory(item) {
  if (COMPACTION_TYPES.has(item?.type)) return true;
  if (!isUserMessage(item)) return false;
  const text = messageText(item);
  if (typeof text !== "string") return false;
  return (
    text.startsWith(CHECKPOINT_WARNING) ||
    text.startsWith(LEGACY_WARNING) ||
    text.startsWith(LEGACY_V1_SUMMARY_PREFIX) ||
    text.startsWith(UNREADABLE_COMPACTION_PREFIX)
  );
}

function lastUserIndex(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(input[index])) return index;
  }
  return -1;
}

function emptyStats() {
  return {
    // False until the pass actually runs. A disabled pass keeps the zeroed
    // counters below but leaves this false, so "off" stays distinguishable
    // from "on and the conversation already fit" on the usage ledger.
    conversationWindowRan: false,
    conversationWindowBytesBefore: 0,
    conversationWindowBytesAfter: 0,
    conversationWindowBytesSaved: 0,
    conversationWindowItemsDropped: 0,
    conversationWindowTailItems: 0,
    conversationWindowFrontierIndex: 0,
    conversationWindowLatestUserIndex: -1,
    conversationWindowTailBytes: 0,
  };
}

// Walks back from the end of the conversation until the newest `tailBytes`
// worth of items are covered, then widens the frontier until it sits on a
// boundary a provider will accept. Returns 0 when the whole conversation
// already fits, which is the caller's signal to return the input untouched.
function findFrontier(input, sizes, tailBytes, boundarySlackItems) {
  let frontier = input.length;
  let tail = 0;
  while (frontier > 0 && tail < tailBytes) {
    frontier -= 1;
    tail += sizes[frontier];
  }
  // The slack only widens a cut the budget already made. With a zero budget
  // the frontier stays at the end, so an operator who asks for "the request
  // only" gets exactly the pinned items instead of a few extra ones.
  if (tail > 0) frontier = Math.max(0, frontier - boundarySlackItems);
  if (frontier === 0 || frontier === input.length) return frontier;
  // Every retained result needs its earlier call, not just the first result at
  // the cut. Parallel results can arrive out of order or after a message.
  // Match type as well as id: a function call cannot satisfy a tool-search
  // output. Existing orphans are left alone; this pass never invents a call.
  const calls = new Map();
  const dependencies = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item?.call_id !== "string" || !item.call_id) continue;
    if (CALL_TYPES.has(item.type)) {
      if (!calls.has(item.type)) calls.set(item.type, new Map());
      calls.get(item.type).set(item.call_id, index);
    } else {
      const callIndex = calls.get(OUTPUT_CALL_TYPES.get(item.type))?.get(item.call_id);
      if (callIndex !== undefined) {
        dependencies.set(index, callIndex);
      }
    }
  }
  // Walking backwards through a moving frontier also visits any results pulled
  // into the tail by an earlier dependency, closing the whole retained suffix.
  for (let index = input.length - 1; index >= frontier; index -= 1) {
    const callIndex = dependencies.get(index);
    if (callIndex !== undefined) frontier = Math.min(frontier, callIndex);
  }
  while (frontier > 0 && CALL_TYPES.has(input[frontier - 1]?.type)) {
    frontier -= 1;
  }
  // Nor split reasoning from the assistant turn it was produced for.
  while (frontier > 0 && REASONING_TYPES.has(input[frontier - 1]?.type)) {
    frontier -= 1;
  }
  return frontier;
}

export function windowConversation(
  input,
  {
    enabled = true,
    tailBytes = CONVERSATION_WINDOW_TAIL_BYTES,
    minTotalBytes = CONVERSATION_WINDOW_MIN_TOTAL_BYTES,
    boundarySlackItems = CONVERSATION_WINDOW_BOUNDARY_SLACK_ITEMS,
  } = {},
) {
  const stats = emptyStats();
  if (!enabled || !Array.isArray(input) || input.length === 0) {
    return { input, stats };
  }
  stats.conversationWindowRan = true;
  stats.conversationWindowTailBytes = tailBytes;
  // The request being answered is pinned by the emit loop below rather than by
  // the frontier: the turn's own tool traffic is exactly what the budget trims,
  // and clamping the frontier here would keep all of it.
  const latestUserIndex = lastUserIndex(input);
  stats.conversationWindowLatestUserIndex = latestUserIndex;

  const sizes = input.map(jsonBytes);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes <= minTotalBytes) return { input, stats };

  const frontier = findFrontier(
    input,
    sizes,
    tailBytes,
    boundarySlackItems,
  );
  if (frontier === 0) {
    stats.conversationWindowBytesBefore = totalBytes;
    stats.conversationWindowBytesAfter = totalBytes;
    stats.conversationWindowTailItems = input.length;
    return { input, stats };
  }

  const next = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    // The newest user message is the request this turn answers, so it is pinned
    // with the instructions even once the tail budget no longer reaches it.
    // Everything it left behind before the kept tail is consumed tool traffic.
    if (isInstruction(item) || carriesCompactedHistory(item) || index === latestUserIndex) {
      next.push(item);
      continue;
    }
    if (index < frontier) {
      stats.conversationWindowItemsDropped += 1;
      continue;
    }
    next.push(item);
  }

  const afterBytes = next.reduce((sum, item) => sum + jsonBytes(item), 0);
  stats.conversationWindowBytesBefore = totalBytes;
  stats.conversationWindowBytesAfter = afterBytes;
  stats.conversationWindowBytesSaved = totalBytes - afterBytes;
  stats.conversationWindowTailItems = input.length - frontier;
  stats.conversationWindowFrontierIndex = frontier;
  return { input: next, stats };
}
