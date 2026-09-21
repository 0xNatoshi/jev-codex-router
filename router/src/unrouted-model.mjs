// The local answer for a provider-prefixed model slug the running router has
// no route for (#689).
//
// Every model this router routes is namespaced `provider/model`, and no native
// GPT slug contains a "/". An unregistered slug on `/v1/responses` used to be
// forwarded to ChatGPT unchanged, so a routed model the live process had not
// loaded -- added to user-models.json after the service started, or skipped at
// load as invalid -- came back as ChatGPT's own refusal ("The 'vendor/model'
// model is not supported when using Codex with a ChatGPT account"), which reads
// as an OpenAI restriction and names nothing the operator can fix. Answering
// locally keeps the prompt off chatgpt.com and says what is actually wrong.
//
// The message is built from the slug, provider ids, and load-time skip reasons
// only. Those reasons name slugs, provider ids, and field names; never put a
// credential, a caller key, a base URL, or a filesystem path in it, because it
// is shown to the client and lands in transcripts.

export const UNROUTED_MODEL_CODE = "unrouted_model";

const MAX_SHOWN_CHARS = 160;

function shown(value) {
  const text = String(value);
  return text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text;
}

export function isProviderPrefixedSlug(model) {
  return typeof model === "string" && model.includes("/");
}

export function unroutedModelError(slug, { provider, providerEnabled = false, skippedReason } = {}) {
  const value = String(slug);
  const prefix = value.slice(0, value.indexOf("/"));
  const sentences = [
    `The model "${shown(value)}" has no route in this running router, so it was refused locally instead of being sent to ChatGPT.`,
  ];
  if (!prefix) {
    sentences.push("The slug does not start with a provider id.");
  } else if (!provider) {
    sentences.push(`No enabled provider named "${shown(prefix)}" is registered with this router.`);
  } else if (!providerEnabled) {
    sentences.push(
      `Provider "${shown(prefix)}" is registered but not enabled; run bin/providers enable ${shown(prefix)}.`,
    );
  } else {
    sentences.push(
      `Provider "${shown(prefix)}" is registered and enabled, but the router loaded no model with this slug.`,
    );
  }
  if (skippedReason) {
    sentences.push(`At startup the router skipped the user model with this slug: ${shown(skippedReason)}.`);
  }
  sentences.push(
    "A model added to or renamed in user-models.json after the router started has no route until the service restarts (bin/control service restart).",
    `Curated models live in user-models.json in the router state directory; bin/curate-models ${
      prefix ? shown(prefix) : "PROVIDER"
    } adds one.`,
  );
  return {
    error: {
      message: sentences.join(" "),
      type: "invalid_request_error",
      param: "model",
      code: UNROUTED_MODEL_CODE,
    },
  };
}
