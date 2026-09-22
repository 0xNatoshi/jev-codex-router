import { CALLER_PATH_PREFIX } from "./caller-auth.mjs";
import { PORTS } from "./paths.mjs";

export const CLIENT_EXPORT_SCHEMA_VERSION = 1;

const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SUPPORTED_OPTIONS = new Set(["baseUrl", "secretEnv"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message) {
  throw new Error(`Invalid client export: ${message}`);
}

function normalizeSecretEnv(value) {
  const name = text(value) || "CODEX_ROUTER_CALLER_KEY";
  if (!ENV_PATTERN.test(name)) {
    invalid("secretEnv must be an environment variable name.");
  }
  return name;
}

function rejectUnsupportedOptions(options) {
  for (const key of Object.keys(options)) {
    if (SUPPORTED_OPTIONS.has(key)) continue;
    if (key === "client") {
      invalid("client-specific adapters are not wired.");
    }
    invalid(`${key} is not supported by the router endpoint export.`);
  }
}

function defaultBaseUrl(secretEnv) {
  return `http://127.0.0.1:${PORTS.router}${CALLER_PATH_PREFIX}/\${${secretEnv}}/v1`;
}

function validateBaseUrl(value, secretEnv) {
  const baseUrl = text(value).replace(/\/+$/, "");
  const expected = defaultBaseUrl(secretEnv);
  if (baseUrl !== expected) {
    invalid("baseUrl must be the configured loopback router endpoint.");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    invalid("baseUrl must be an absolute loopback HTTP URL.");
  }
  const expectedPort = PORTS.router === 80 ? "" : String(PORTS.router);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== expectedPort ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("baseUrl must target the configured loopback router endpoint.");
  }
  return baseUrl;
}

/**
 * Build the one export shape the router can currently stand behind. The
 * descriptor contains an environment reference, never the caller capability.
 * Client-specific adapters stay out until they have a real writer and reader.
 */
export function buildRouterEndpointExport(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    invalid("options must be an object.");
  }
  rejectUnsupportedOptions(options);
  const secretEnv = normalizeSecretEnv(options.secretEnv);
  const baseUrl = options.baseUrl
    ? validateBaseUrl(options.baseUrl, secretEnv)
    : defaultBaseUrl(secretEnv);
  return {
    schemaVersion: CLIENT_EXPORT_SCHEMA_VERSION,
    kind: "router-endpoint",
    gateway: {
      baseUrl,
      protocol: "openai-compatible",
      auth: {
        type: "path-capability",
        secretRef: { type: "environment", name: secretEnv },
      },
    },
  };
}

export function renderRouterEndpointExport(options = {}) {
  return `${JSON.stringify(buildRouterEndpointExport(options), null, 2)}\n`;
}

// Keep the original helper names for callers of the draft PR while exposing no
// client list or client-specific contract.
export const buildClientExport = buildRouterEndpointExport;
export const renderClientExport = renderRouterEndpointExport;
