const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SSE_FIELD = /^(?:event|data|id|retry)(?::.*)?$/;
const SSE_FIELDS = ["event", "data", "id", "retry"];

export const HEADERLESS_SSE_SNIFF_BYTES = 512;
export const HEADERLESS_SSE_SNIFF_MS = 30_000;

function startsWithPartialBom(bytes) {
  if (bytes.length >= UTF8_BOM.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== UTF8_BOM[index]) return false;
  }
  return bytes.length > 0;
}

// Returns `event-stream` only after the prefix proves SSE framing, `other`
// after it proves a different body shape, and `pending` while more bytes can
// still settle the question. Leading BOM, comments, and blank dispatches are
// valid SSE prelude and are intentionally handled before the first field.
export function classifySsePrefix(value, { end = false } = {}) {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
  if (startsWithPartialBom(bytes)) return end ? "other" : "pending";
  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    bytes = bytes.subarray(UTF8_BOM.length);
  }

  const text = bytes.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const nextCr = text.indexOf("\r", offset);
    const nextLf = text.indexOf("\n", offset);
    let newline;
    if (nextCr === -1) newline = nextLf;
    else if (nextLf === -1) newline = nextCr;
    else newline = Math.min(nextCr, nextLf);
    if (newline === -1) {
      const line = text.slice(offset);
      if (line.startsWith(":")) return "event-stream";
      if (SSE_FIELDS.some((field) => line.startsWith(`${field}:`))) {
        return "event-stream";
      }
      if (!end && SSE_FIELDS.some((field) => field.startsWith(line))) {
        return "pending";
      }
      return end && SSE_FIELD.test(line) ? "event-stream" : "other";
    }

    const line = text.slice(offset, newline);
    offset =
      text[newline] === "\r" && text[newline + 1] === "\n"
        ? newline + 2
        : newline + 1;
    if (!line) continue;
    if (line.startsWith(":") || SSE_FIELD.test(line)) return "event-stream";
    return "other";
  }
  return end ? "other" : "pending";
}

// Holds only the undecided prefix. Once framing is known, the exact buffered
// bytes and any remainder are returned in order for the caller to process
// normally. A body that cannot prove SSE within the byte limit falls back to
// the non-SSE path rather than growing memory without bound.
export class HeaderlessSseDetector {
  #buffer = Buffer.alloc(0);
  #decision;
  #maxBytes;

  constructor({ maxBytes = HEADERLESS_SSE_SNIFF_BYTES } = {}) {
    this.#maxBytes =
      Number.isInteger(maxBytes) && maxBytes >= 0
        ? maxBytes
        : HEADERLESS_SSE_SNIFF_BYTES;
  }

  write(chunk) {
    const bytes = Buffer.from(chunk);
    if (this.#decision) return { decision: this.#decision, chunks: [bytes] };

    const capacity = Math.max(0, this.#maxBytes - this.#buffer.length);
    const prefix = bytes.subarray(0, capacity);
    const remainder = bytes.subarray(prefix.length);
    if (prefix.length) {
      this.#buffer = this.#buffer.length
        ? Buffer.concat([this.#buffer, prefix])
        : Buffer.from(prefix);
    }
    let decision = classifySsePrefix(this.#buffer);
    if (
      decision === "pending" &&
      (this.#buffer.length >= this.#maxBytes || remainder.length)
    ) {
      decision = "other";
    }
    if (decision === "pending") return { decision, chunks: [] };
    return this.#settle(decision, remainder);
  }

  end() {
    if (this.#decision) return { decision: this.#decision, chunks: [] };
    const decision = classifySsePrefix(this.#buffer, { end: true });
    return this.#settle(decision === "event-stream" ? decision : "other");
  }

  #settle(decision, remainder = Buffer.alloc(0)) {
    this.#decision = decision;
    const chunks = [];
    if (this.#buffer.length) chunks.push(this.#buffer);
    if (remainder.length) chunks.push(Buffer.from(remainder));
    this.#buffer = Buffer.alloc(0);
    return { decision, chunks };
  }
}
