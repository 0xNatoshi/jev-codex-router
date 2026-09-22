// Union Alpha on OpenCode Go Messages advertises a 262,144-token window and a
// 131,072-token output. Compact-at-window-minus-output therefore fires at
// 131,072, which leaves no room for Console Go to add a completion budget on
// top of a prompt it tokenizes independently of Codex.
//
// Live turns reported ~90–100k Codex tokens — still under that threshold —
// then Console Go answered HTTP 400 "Prompt too long for every available
// model, including the completion". OpenCode itself reserves 32,768 output
// tokens when estimating whether a prompt will fit. A request that omits
// `max_tokens` still reserves the advertised 131,072: a ~140k Desktop prompt
// plus that reserve exceeds 262,144 even though the hop would have fitted
// the same prompt at 32,768. Always send the measured cap, and clamp any
// larger caller budget down to it. Do not invent effort rungs here;
// OpenCode publishes `reasoning_options=[]`.

export const UNION_ALPHA_MESSAGES_PROVIDER = "opencode-go-messages";
export const UNION_ALPHA_UPSTREAM_MODEL = "union-alpha";
export const UNION_ALPHA_COMPLETION_CAP = 32_768;

export function isUnionAlphaMessagesRoute(model) {
  return model?.provider === UNION_ALPHA_MESSAGES_PROVIDER
    && model?.upstreamModel === UNION_ALPHA_UPSTREAM_MODEL;
}

function positiveTokenLimit(value) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

export function clampUnionAlphaCompletion(payload, model) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!isUnionAlphaMessagesRoute(model)) return payload;
  for (const field of ["max_tokens", "max_output_tokens"]) {
    const tokens = positiveTokenLimit(payload[field]);
    if (tokens === undefined || tokens > UNION_ALPHA_COMPLETION_CAP) {
      payload[field] = UNION_ALPHA_COMPLETION_CAP;
    }
  }
  return payload;
}

// Console Go rejects a single Anthropic/Chat message whose `content` is longer
// than 2,500,000 characters (`messages[N].content exceeds maximum length of
// 2500000`). Live Union Alpha ImageGen (17 September 2026, session
// 01a0ae2b-ef63-7993-8d0e-8660cfd7c587) generated a 1536×1024 PNG whose data
// URL is 2,707,238 characters. Codex stored the file; the follow-up turn 400'd
// before a final_answer. The Chat Completions hoist keeps those bytes and
// still overflows. Replace oversized image payloads with a labeled stub so
// the hop can continue. Do not invent image bytes or repair tool JSON.
export const OPENCODE_MESSAGE_CONTENT_LIMIT = 2_500_000;
const OPENCODE_MESSAGE_CONTENT_BUDGET = 2_400_000;
const DATA_URL_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;

export function openCodeOversizedImageNotice() {
  return (
    "[Image from a tool result omitted: Console Go rejects a single message " +
    `over ${OPENCODE_MESSAGE_CONTENT_LIMIT} characters. The generated image ` +
    "was delivered to the Codex client.]"
  );
}

export function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (content == null) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

function replaceOversizedDataUrls(text) {
  if (typeof text !== "string") return text;
  const notice = openCodeOversizedImageNotice();
  return text.replace(DATA_URL_PATTERN, (match) =>
    match.length > OPENCODE_MESSAGE_CONTENT_BUDGET ? notice : match,
  );
}

function imageUrlValue(part) {
  if (typeof part?.image_url === "string") return part.image_url;
  if (typeof part?.image_url?.url === "string") return part.image_url.url;
  if (typeof part?.url === "string") return part.url;
  return undefined;
}

function imageSourceChars(source) {
  if (!source || typeof source !== "object") return 0;
  if (typeof source.data === "string") return source.data.length;
  if (typeof source.url === "string") return source.url.length;
  return contentChars(source);
}

function clampContentPart(part) {
  if (typeof part === "string") return replaceOversizedDataUrls(part);
  if (!part || typeof part !== "object") return part;
  if (part.type === "image_url" || part.type === "input_image") {
    const url = imageUrlValue(part);
    if (typeof url === "string" && url.length > OPENCODE_MESSAGE_CONTENT_BUDGET) {
      return { type: "text", text: openCodeOversizedImageNotice() };
    }
    return part;
  }
  if (part.type === "image" && imageSourceChars(part.source) > OPENCODE_MESSAGE_CONTENT_BUDGET) {
    return { type: "text", text: openCodeOversizedImageNotice() };
  }
  if (typeof part.text === "string") {
    const text = replaceOversizedDataUrls(part.text);
    return text === part.text ? part : { ...part, text };
  }
  if (part.content !== undefined) {
    const content = clampMessageContent(part.content);
    return content === part.content ? part : { ...part, content };
  }
  return part;
}

function clampMessageContent(content) {
  if (typeof content === "string") return replaceOversizedDataUrls(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((part) => {
    const clamped = clampContentPart(part);
    if (clamped !== part) changed = true;
    return clamped;
  });
  return changed ? next : content;
}

export function clampOpenCodeMessageContent(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (contentChars(message.content) <= OPENCODE_MESSAGE_CONTENT_BUDGET) return message;
    const content = clampMessageContent(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}
