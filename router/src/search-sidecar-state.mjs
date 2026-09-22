import { existsSync, readFileSync } from "node:fs";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { SEARCH_SIDECARS_PATH } from "./paths.mjs";

export { SEARCH_SIDECARS_PATH } from "./paths.mjs";

export const SEARCH_SIDECAR_SCHEMA_VERSION = 1;
export const SEARCH_SIDECAR_ADAPTER = "perplexity-search";
export const SEARCH_SIDECAR_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxResults: 8,
  cacheTtlMs: 60_000,
  cacheMaxEntries: 128,
  maxAttempts: 2,
  retryDelayMs: 100,
});

const DOCUMENT_KEYS = new Set(["version", "bindings"]);
const BINDING_KEYS = new Set([
  "model",
  "providerId",
  "adapter",
  "enabled",
  "timeoutMs",
  "maxResults",
  "cacheTtlMs",
  "cacheMaxEntries",
  "maxAttempts",
  "retryDelayMs",
]);
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function allowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unsupported field ${key}.`);
  }
}

function boundedInteger(value, field, fallback, { min = 0, max }) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer from ${min} through ${max}.`);
  }
  return resolved;
}

export function normalizeSearchSidecarBinding(value) {
  plainObject(value, "Search sidecar binding");
  allowedKeys(value, BINDING_KEYS, "Search sidecar binding");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  if (!MODEL_SLUG.test(model)) throw new Error("Search sidecar model must be a routed model slug.");
  if (!PROVIDER_ID.test(providerId)) throw new Error("Search sidecar providerId is invalid.");
  const adapter = value.adapter === undefined ? SEARCH_SIDECAR_ADAPTER : value.adapter;
  if (adapter !== SEARCH_SIDECAR_ADAPTER) {
    throw new Error(`Search sidecar adapter must be ${SEARCH_SIDECAR_ADAPTER}.`);
  }
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") throw new Error("Search sidecar enabled must be a boolean.");
  return Object.freeze({
    model,
    providerId,
    adapter,
    enabled,
    timeoutMs: boundedInteger(value.timeoutMs, "timeoutMs", SEARCH_SIDECAR_DEFAULTS.timeoutMs, {
      min: 1_000,
      max: 120_000,
    }),
    maxResults: boundedInteger(value.maxResults, "maxResults", SEARCH_SIDECAR_DEFAULTS.maxResults, {
      min: 1,
      max: 20,
    }),
    cacheTtlMs: boundedInteger(value.cacheTtlMs, "cacheTtlMs", SEARCH_SIDECAR_DEFAULTS.cacheTtlMs, {
      min: 0,
      max: 86_400_000,
    }),
    cacheMaxEntries: boundedInteger(
      value.cacheMaxEntries,
      "cacheMaxEntries",
      SEARCH_SIDECAR_DEFAULTS.cacheMaxEntries,
      { min: 1, max: 2_000 },
    ),
    maxAttempts: boundedInteger(value.maxAttempts, "maxAttempts", SEARCH_SIDECAR_DEFAULTS.maxAttempts, {
      min: 1,
      max: 3,
    }),
    retryDelayMs: boundedInteger(
      value.retryDelayMs,
      "retryDelayMs",
      SEARCH_SIDECAR_DEFAULTS.retryDelayMs,
      { min: 0, max: 10_000 },
    ),
  });
}

export function parseSearchSidecarDocument(payload) {
  if (payload === undefined) return { version: SEARCH_SIDECAR_SCHEMA_VERSION, bindings: [] };
  plainObject(payload, "Search sidecar state");
  allowedKeys(payload, DOCUMENT_KEYS, "Search sidecar state");
  if (payload.version !== SEARCH_SIDECAR_SCHEMA_VERSION || !Array.isArray(payload.bindings)) {
    throw new Error(
      `Search sidecar state must use version ${SEARCH_SIDECAR_SCHEMA_VERSION} with a bindings array.`,
    );
  }
  const bindings = [];
  const seen = new Set();
  for (const candidate of payload.bindings) {
    const binding = normalizeSearchSidecarBinding(candidate);
    if (seen.has(binding.model)) throw new Error(`Duplicate search sidecar binding for ${binding.model}.`);
    seen.add(binding.model);
    bindings.push(binding);
  }
  return { version: SEARCH_SIDECAR_SCHEMA_VERSION, bindings };
}

export function readSearchSidecarState(filePath = SEARCH_SIDECARS_PATH) {
  if (!existsSync(filePath)) return parseSearchSidecarDocument(undefined);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read search sidecar state ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseSearchSidecarDocument(payload);
}

function writeSearchSidecarState(state, filePath = SEARCH_SIDECARS_PATH) {
  const normalized = parseSearchSidecarDocument(state);
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

export function searchSidecarBindingForModel(model, filePath = SEARCH_SIDECARS_PATH) {
  return readSearchSidecarState(filePath).bindings.find(
    (binding) => binding.enabled && binding.model === model,
  );
}

export function setSearchSidecarBinding(input, filePath = SEARCH_SIDECARS_PATH) {
  const binding = normalizeSearchSidecarBinding(input);
  return withAtomicStateLock(filePath, () => {
    const current = readSearchSidecarState(filePath);
    const bindings = current.bindings.filter((candidate) => candidate.model !== binding.model);
    bindings.push(binding);
    writeSearchSidecarState({ version: SEARCH_SIDECAR_SCHEMA_VERSION, bindings }, filePath);
    return binding;
  });
}

export function removeSearchSidecarBinding(model, filePath = SEARCH_SIDECARS_PATH) {
  const slug = typeof model === "string" ? model.trim() : "";
  return withAtomicStateLock(filePath, () => {
    const current = readSearchSidecarState(filePath);
    if (!current.bindings.some((binding) => binding.model === slug)) {
      throw new Error(`No search sidecar binding exists for ${slug || "<empty>"}.`);
    }
    const bindings = current.bindings.filter((binding) => binding.model !== slug);
    writeSearchSidecarState({ version: SEARCH_SIDECAR_SCHEMA_VERSION, bindings }, filePath);
    return { removed: slug };
  });
}

export function removeSearchSidecarBindingsForProvider(
  providerId,
  filePath = SEARCH_SIDECARS_PATH,
) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  return withAtomicStateLock(filePath, () => {
    const current = readSearchSidecarState(filePath);
    const removed = current.bindings.filter((binding) => binding.providerId === id);
    if (!removed.length) return [];
    writeSearchSidecarState({
      version: SEARCH_SIDECAR_SCHEMA_VERSION,
      bindings: current.bindings.filter((binding) => binding.providerId !== id),
    }, filePath);
    return removed.map((binding) => binding.model);
  });
}
