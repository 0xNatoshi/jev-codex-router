// Ollama accepts both a short tag (`gemma4:12b`) and a namespaced tag
// (`hf.co/user/repo:Q4_K_M`). The tray also accepts a model-page URL so a user
// can paste the link they were already looking at. Keep this parser separate
// from the registry lookup: the registry is advisory and does not have a
// complete list-all endpoint, while Ollama itself can pull any valid tag.

const OLLAMA_PAGE_HOSTS = new Set(["ollama.com", "www.ollama.com"]);
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function normalizeLocalModelTag(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("A model tag or Ollama model URL is required.");
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("That model URL is not valid.");
    }
    if (!OLLAMA_PAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error("Use an Ollama model-page URL or enter the model tag directly.");
    }
    const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    // `/library/<model>` and `/<namespace>/<model>` are the two model-page
    // shapes; anything shorter is a family or search page with no tag in it.
    if (parts.length < 2 || parts[0] === "search") {
      throw new Error("That URL does not contain an Ollama model tag.");
    }
    candidate = parts[0] === "library" ? parts.slice(1).join("/") : parts.join("/");
  }
  // The page URL has no tag when it points at the family overview. Ollama's
  // explicit spelling is easier to compare with `ollama list`, so make latest
  // visible instead of silently relying on an implicit alias.
  if (!candidate.includes(":")) candidate = `${candidate}:latest`;
  if (!TAG_PATTERN.test(candidate) || candidate.includes("//") || candidate.startsWith("-")) {
    throw new Error(`Invalid Ollama model tag: ${candidate}`);
  }
  return candidate;
}

// `gemma3` and `gemma3:latest` are the same model, but only the second is what
// `ollama list` prints. State written from either spelling has to compare
// equal, or `set gemma3 off` silently fails to clear an entry the downloader
// stored as `gemma3:latest`. Unparseable input falls back to its trimmed self
// instead of throwing: callers use this to match stored entries, and a corrupt
// entry should be inert rather than fatal.
export function canonicalLocalModelTag(input) {
  try {
    return normalizeLocalModelTag(input);
  } catch {
    return String(input || "").trim();
  }
}

export function splitLocalModelTag(input) {
  const tag = normalizeLocalModelTag(input);
  const colon = tag.lastIndexOf(":");
  const name = colon === -1 ? tag : tag.slice(0, colon);
  const variant = colon === -1 ? "latest" : tag.slice(colon + 1);
  const pieces = name.split("/");
  const model = pieces.at(-1) || name;
  const namespace = pieces.length > 1 ? pieces.slice(0, -1).join("/") : "library";
  return { tag, name, model, namespace, variant, family: name };
}

export function localModelFamily(input) {
  return splitLocalModelTag(input).family;
}

export function localModelDisplayName(input) {
  const { model, variant, namespace } = splitLocalModelTag(input);
  const title = model
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const prefix = namespace === "library" ? "" : `${namespace}/`;
  return `${prefix}${title} · ${variant}`;
}
