import { LISTED_MODELS, PROVIDERS } from "./model-registry.mjs";
import {
  canonicalProviderId,
  configuredProviderIds,
  readProviderSelection,
} from "./provider-selection.mjs";

const MAX_MODELS = 500;

function safeLabel(value, fallback, limit = 160) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, limit) : fallback;
}

function dashboardProvider(provider, enabled) {
  return {
    id: provider.id,
    displayName: safeLabel(provider.displayName, provider.id),
    kind: safeLabel(provider.kind, "unknown", 40),
    enabled,
    ...(provider.ownedBy ? { ownedBy: safeLabel(provider.ownedBy, "", 80) } : {}),
    ...(provider.authMode ? { authMode: safeLabel(provider.authMode, "", 40) } : {}),
  };
}

function dashboardModel(model) {
  return {
    slug: safeLabel(model.slug, "", 240),
    displayName: safeLabel(model.displayName, model.slug, 160),
    provider: canonicalProviderId(model.provider),
    enabled: true,
    ...(model.visible === false ? { visible: false } : { visible: true }),
    ...(model.native === true ? { native: true } : {}),
    ...(model.isFree === true ? { isFree: true } : {}),
  };
}

/**
 * Return the small, metadata-only dashboard contract shared by desktop
 * surfaces. It deliberately excludes credentials, endpoints, account ids,
 * session identifiers, request policy, and provider health error text.
 */
export function routerDashboardState({ models } = {}) {
  const enabled = new Set(readProviderSelection().map(canonicalProviderId));
  const configured = new Set(configuredProviderIds().map(canonicalProviderId));
  const candidates = Array.isArray(models) ? models : LISTED_MODELS;
  const providers = [...PROVIDERS.values()]
    .filter((provider) => !provider.variantOf)
    .filter((provider) => configured.has(provider.id))
    .map((provider) => dashboardProvider(provider, enabled.has(provider.id)));
  const safeModels = candidates
    .filter((model) => model && typeof model.slug === "string" && model.slug.trim())
    .slice(0, MAX_MODELS)
    .map(dashboardModel);
  return {
    version: 1,
    source: "codex-router",
    enabledProviders: [...enabled],
    providers,
    models: safeModels,
  };
}
