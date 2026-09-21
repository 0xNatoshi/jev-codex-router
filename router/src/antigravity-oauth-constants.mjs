// Shared OAuth and wire constants for the optional Google Antigravity
// compatibility route. The router never borrows the official Antigravity
// client's identity or OAuth credential.

export const ANTIGRAVITY_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]);

export const ANTIGRAVITY_CALLBACK_HOST = "127.0.0.1";
export const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
export const ANTIGRAVITY_PROBE_VERSION = 1;
export const ANTIGRAVITY_PROBE_MODEL = "gemini-3.1-pro";

export function antigravityRedirectUri(port) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
    throw new Error("Antigravity OAuth requires an OS-assigned loopback port.");
  }
  return `http://${ANTIGRAVITY_CALLBACK_HOST}:${numeric}${ANTIGRAVITY_CALLBACK_PATH}`;
}

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINT = (
  process.env.ANTIGRAVITY_ENDPOINT ||
  "https://daily-cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

export const ANTIGRAVITY_PROD_ENDPOINT = (
  process.env.ANTIGRAVITY_PROD_ENDPOINT || "https://cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

function normalizePlatform(platform) {
  if (platform === "win32") return "windows";
  return platform || "unknown";
}

function normalizeArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch || "unknown";
}

// This string is intentionally plain and truthful. In particular it must not
// be replaced with the official `antigravity/...` User-Agent: acceptance that
// depends on impersonating another client is not support this router can ship.
export function antigravityUserAgent(
  platform = process.platform,
  arch = process.arch,
) {
  return `codex-router (os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)})`;
}

export function antigravityBootstrapHeaders(accessToken) {
  return {
    "User-Agent": antigravityUserAgent(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

// Leaving provider-specific IDE metadata empty is deliberate. Claiming the
// ANTIGRAVITY enum would tell Google this request came from the vendor client.
// The opt-in live probe decides whether the upstream accepts the truthful
// request before this provider can be enabled.
export function antigravityLoadCodeAssistMetadata() {
  return {};
}

export function antigravityClientMetadata() {
  return JSON.stringify(antigravityLoadCodeAssistMetadata());
}
