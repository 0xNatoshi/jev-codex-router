import { readAgentChecks } from "./local-models.mjs";
import { canonicalLocalModelTag } from "./local-model-ref.mjs";
import { lmstudioServedModels } from "./lmstudio-models.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { rankFailoverCandidates, readFailoverSettings } from "./model-failover.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { localOllamaRuntimeSnapshot } from "./ollama-runtime.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { cooldownScope } from "./provider-cooldown.mjs";

const JEV_PROVIDER = "jev";
const JEV_ROUTE = "jev/auto";

function checkedLocalModel(model, agentChecks) {
  const wanted = canonicalLocalModelTag(model.upstreamModel || "");
  return Object.entries(agentChecks || {}).some(
    ([tag, result]) =>
      (
        tag === model.slug ||
        canonicalLocalModelTag(tag) === wanted
      ) && result?.agentCapable === true,
  );
}

// Jev asks for this list only after the native ChatGPT allowance is known to
// be unavailable. It is deliberately derived from the parent router's live
// inventory instead of being sent to System One: provider configuration is a
// local execution concern, not evidence Jev needs to choose a native tier.
//
// Local models have a stricter gate than cloud routes. Being installed and
// checked is not enough: the Ollama runtime must answer now and the real Codex
// agent check must have passed consistently. This avoids replacing an honest
// quota error with a dead localhost or a model that only prints tool calls.
export function jevFallbackCandidates({
  models = selectedConfiguredListedModels(),
  hidden = readHiddenModels(),
  settings = readFailoverSettings(),
  agentChecks = readAgentChecks(),
  localRuntime,
  lmstudioRuntime = { reachable: false, models: [] },
  estimatedTokens,
  needsImage = false,
  needsMultiAgentV2 = false,
  requiredSearchMode,
  hasSearchHistory = false,
  limit = 2,
} = {}) {
  if (settings.enabled === false) return [];
  const ollamaRuntime = localRuntime || (
    models.some((model) => model.provider === "local")
      ? localOllamaRuntimeSnapshot()
      : { running: false }
  );
  const eligibleModels = (Array.isArray(models) ? models : []).filter((model) => {
    if (!model?.slug || hidden.has(model.slug)) return false;
    if (model.slug === JEV_ROUTE || model.provider === JEV_PROVIDER) return false;
    const provider = PROVIDERS.get(model.provider);
    if (!provider?.keyless) return true;
    if (!checkedLocalModel(model, agentChecks)) return false;
    if (model.provider === "local") return ollamaRuntime?.running === true;
    if (model.provider === "lmstudio") {
      return lmstudioRuntime?.reachable === true &&
        (lmstudioRuntime.models || []).includes(model.upstreamModel);
    }
    // A new keyless provider needs an explicit liveness adapter before it can
    // participate automatically.
    return false;
  });

  const ranked = rankFailoverCandidates(eligibleModels, {
    // Native OpenAI models are outside the routed registry. This synthetic
    // source only prevents a future routed OpenAI entry from being mistaken
    // for an independent fallback family.
    from: { slug: "__jev_native__", provider: "openai" },
    estimatedTokens,
    needsImage,
    needsMultiAgentV2,
    requiredSearchMode,
    hasSearchHistory,
    chain: settings.chain,
    // This caller already proved both live runtime and real Codex agent
    // capability above. General router failover keeps its conservative default.
    allowKeyless: true,
  });

  // The retry budget counts independent chances, not catalog rows. Duplicate
  // slugs can enter through an explicit chain, and protocol/model siblings on
  // one quota family are equally unable to answer after that family's balance
  // is exhausted. De-duplicate both before applying the limit so one provider
  // cannot consume every bounded attempt while a distinct provider is ready.
  const bounded = [];
  const seenSlugs = new Set();
  const seenFamilies = new Set();
  const boundedLimit = Math.max(0, Number(limit) || 0);
  if (boundedLimit === 0) return bounded;
  for (const { tier, model } of ranked) {
    const slug = String(model.slug || "").trim();
    const family = cooldownScope(model.provider);
    if (!slug || seenSlugs.has(slug) || (family && seenFamilies.has(family))) continue;
    seenSlugs.add(slug);
    if (family) seenFamilies.add(family);
    bounded.push({
      slug,
      provider: model.provider,
      tier,
      contextWindow: model.contextWindow,
      local: Boolean(PROVIDERS.get(model.provider)?.keyless),
    });
    if (bounded.length >= boundedLimit) break;
  }
  return bounded;
}

export async function liveJevFallbackCandidates(options = {}) {
  const models = options.models || selectedConfiguredListedModels();
  const lmstudioRuntime = models.some((model) => model.provider === "lmstudio")
    ? await lmstudioServedModels()
    : { reachable: false, models: [] };
  return jevFallbackCandidates({ ...options, models, lmstudioRuntime });
}
