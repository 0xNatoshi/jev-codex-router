// LiteLLM's Responses -> Chat Completions translation (`use_chat_completions_api`)
// drops `web_search_call` input items outright. The turn still returns 200, so
// nothing in the router or the client learns that the replayed search context
// went missing -- the model simply answers from a hole in the history and
// guesses. Issue #640 measured it: asked which city a replayed search queried,
// a Responses-passthrough route answered correctly while two chat-wire routes
// answered with a different city and with "there is no search record in this
// conversation".
//
// A chat-wire route cannot carry the structured item, but it can carry text.
// Replaying the call as an ordinary assistant marker keeps the fact of the
// search, its query, and its status in the transcript the model actually sees.
// This is deliberately not a claim that the route can *execute* a search:
// `supportsSearchHistory` still gates whether a model may accept replayed
// search history at all, and this runs only for turns that already passed it.

const MARKER_PREFIX = "[completed web search";

// The Responses API has carried the query on `action` since hosted search
// gained action types; older stored items put it at the top level. Read both
// rather than silently emitting a marker with no query in it.
export function webSearchCallQuery(item) {
  const candidates = [item?.action?.query, item?.query];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function webSearchCallMarkerText(item) {
  const query = webSearchCallQuery(item);
  // An incomplete or failed call is not the same evidence as a completed one,
  // and a model that is told "completed" for a search that failed will invent
  // results for it.
  const status = typeof item?.status === "string" && item.status.trim()
    ? item.status.trim()
    : "completed";
  const label = status === "completed" ? MARKER_PREFIX : `[web search (${status})`;
  return query ? `${label}: ${query}]` : `${label}]`;
}

function markerItem(item) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: webSearchCallMarkerText(item) }],
  };
}

/// Replace every `web_search_call` item with a text marker the chat wire keeps.
/// Returns the original array untouched when there is nothing to replace, so a
/// turn without search history costs one scan and no allocation.
export function markChatWireSearchHistory(input) {
  if (!Array.isArray(input)) return { input, replaced: 0 };
  let replaced = 0;
  const marked = input.map((item) => {
    if (item?.type !== "web_search_call") return item;
    replaced += 1;
    return markerItem(item);
  });
  return replaced === 0 ? { input, replaced: 0 } : { input: marked, replaced };
}

// The gateway deployment sets `use_chat_completions_api: true` for every
// provider whose protocol is not `openai-responses` (see litellm-config.mjs),
// and local Ollama routes are chat-shaped as well. Keeping the rule stated once
// here means the translation boundary and this repair cannot drift apart.
export function usesChatCompletionsWire(provider) {
  return provider?.protocol !== "openai-responses";
}
