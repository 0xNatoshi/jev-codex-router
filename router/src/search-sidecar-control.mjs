import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGenericProvider } from "./generic-providers.mjs";
import { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import {
  readSearchSidecarState,
  removeSearchSidecarBinding,
  SEARCH_SIDECARS_PATH,
  setSearchSidecarBinding,
} from "./search-sidecar-state.mjs";
import { trustedSearchProviderDescriptor } from "./search-sidecar-policy.mjs";
import { targetRestartHint } from "./target-integration.mjs";

const SET_OPTIONS = new Map([
  ["--timeout-ms", "timeoutMs"],
  ["--max-results", "maxResults"],
  ["--cache-ttl-ms", "cacheTtlMs"],
  ["--cache-max-entries", "cacheMaxEntries"],
  ["--max-attempts", "maxAttempts"],
  ["--retry-delay-ms", "retryDelayMs"],
]);

function parseSetOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const field = SET_OPTIONS.get(name);
    const raw = args[index + 1];
    if (!field || raw === undefined || !/^\d+$/.test(raw)) {
      throw new Error(`${name || "Search sidecar option"} must be a supported integer option.`);
    }
    if (field in values) throw new Error(`${name} may be specified only once.`);
    values[field] = Number(raw);
  }
  return values;
}

function diagnostics(binding, {
  modelForSlug = (slug) => MODEL_BY_SLUG.get(slug),
  providerForId = getGenericProvider,
  providerReady = genericProviderConfigured,
} = {}) {
  const model = modelForSlug(binding.model);
  let provider;
  try {
    provider = providerForId(binding.providerId);
  } catch {
    provider = undefined;
  }
  const issues = [];
  if (!model) issues.push("model is not registered");
  else if (model.searchTool !== undefined) issues.push("model already owns native or hosted search");
  if (!provider) issues.push("generic search provider is missing");
  else {
    if (!trustedSearchProviderDescriptor(provider)) issues.push("provider is not the trusted Perplexity Search endpoint");
    if (!providerReady(provider.id)) issues.push("provider credential is unavailable");
  }
  return {
    ...binding,
    ready: binding.enabled && issues.length === 0,
    issues,
  };
}

export function searchSidecarStatus(model, dependencies) {
  const bindings = readSearchSidecarState().bindings
    .filter((binding) => !model || binding.model === model)
    .map((binding) => diagnostics(binding, dependencies));
  return { path: SEARCH_SIDECARS_PATH, bindings };
}

function assertConfigurable(modelSlug, providerId, {
  modelForSlug = (slug) => MODEL_BY_SLUG.get(slug),
  providerForId = getGenericProvider,
  providerReady = genericProviderConfigured,
} = {}) {
  const model = modelForSlug(modelSlug);
  if (!model) throw new Error(`Unknown routed model: ${modelSlug}`);
  if (model.searchTool !== undefined) {
    throw new Error(`${modelSlug} already has ${model.searchTool.mode} search; sidecar override is refused.`);
  }
  const provider = providerForId(providerId);
  if (!trustedSearchProviderDescriptor(provider)) {
    throw new Error(
      "The search provider must be an enabled credential-bound openai-chat generic provider at https://api.perplexity.ai.",
    );
  }
  if (!providerReady(provider.id)) {
    throw new Error(`The bound credential for generic provider ${provider.id} is unavailable.`);
  }
}

function usage() {
  throw new Error(
    "Usage: search-sidecar status [MODEL] | set MODEL PROVIDER " +
      "[--timeout-ms N] [--max-results N] [--cache-ttl-ms N] " +
      "[--cache-max-entries N] [--max-attempts N] [--retry-delay-ms N] | " +
      "enable MODEL | disable MODEL | remove MODEL",
  );
}

export async function runSearchSidecarControl(args = process.argv.slice(2), {
  output = process.stdout,
  modelForSlug = (slug) => MODEL_BY_SLUG.get(slug),
  providerForId = getGenericProvider,
  providerReady = genericProviderConfigured,
  transact = transactModelOverlayMutation,
  applyPublication = applyModelOverlayPublication,
  restartHint = targetRestartHint,
} = {}) {
  const dependencies = { modelForSlug, providerForId, providerReady };
  const action = args[0] || "status";
  if (action === "status") {
    if (args.length > 2) usage();
    const status = searchSidecarStatus(args[1], dependencies);
    output.write(`${JSON.stringify(status, null, 2)}\n`);
    return status;
  }
  if (!["set", "enable", "disable", "remove"].includes(action)) usage();
  const model = String(args[1] || "").trim();
  if (!model) usage();
  if (action !== "set" && args.length !== 2) usage();
  const setOptions = action === "set" ? parseSetOptions(args.slice(3)) : {};
  let result;
  await transact({
    files: [SEARCH_SIDECARS_PATH],
    mutate: async () => {
      const existing = readSearchSidecarState().bindings.find((binding) => binding.model === model);
      if (action === "remove") {
        result = removeSearchSidecarBinding(model);
        return;
      }
      if (action === "enable" || action === "disable") {
        if (!existing) throw new Error(`No search sidecar binding exists for ${model}.`);
        if (action === "enable") assertConfigurable(existing.model, existing.providerId, dependencies);
        result = setSearchSidecarBinding({ ...existing, enabled: action === "enable" });
        return;
      }
      const providerId = String(args[2] || "").trim();
      if (!providerId) usage();
      assertConfigurable(model, providerId, dependencies);
      result = setSearchSidecarBinding({
        ...(existing || {}),
        model,
        providerId,
        enabled: true,
        ...setOptions,
      });
    },
    applyPublication,
  });
  const status = searchSidecarStatus(model, dependencies);
  output.write(`${JSON.stringify({ result, ...status }, null, 2)}\n`);
  output.write(`${restartHint()}\n`);
  return { result, ...status };
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  runSearchSidecarControl().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
