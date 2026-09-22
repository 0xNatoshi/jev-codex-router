import { spawnSync } from "node:child_process";

// A client that cannot reach the router reports nothing the router can see:
// the request dies at the proxy hop, so `router.log` stays empty and every
// diagnostic here looks healthy while Codex repeats a bare transport error.
// That is the gap this module closes.
//
// `proxy-environment.mjs` covers the other direction -- making sure the
// router's own outbound calls use the operator's proxy. This one covers the
// inbound side: making sure clients do *not* send loopback traffic through it.
// Both halves are needed, and only one existed.
//
// The failure is specific to GUI clients. A terminal inherits the shell's
// `no_proxy`, so the CLI works; an app launched by launchd/Explorer inherits
// nothing and falls back to the *system* proxy, whose bypass list routinely
// omits loopback. The two disagree silently, which is why this reads the
// system settings rather than `process.env`.

const LOOPBACK_TOKENS = ["127.0.0.1", "localhost", "::1"];

function runText(command, args, exec) {
  try {
    const result = exec(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return undefined;
    return String(result.stdout || "");
  } catch {
    return undefined;
  }
}

// `scutil --proxy` prints the resolved settings for the active service, which
// is what a GUI app actually gets. Reading `networksetup` per service would
// instead report every configured interface, including ones not in use.
export function parseScutilProxy(text) {
  if (typeof text !== "string" || !text) return undefined;
  const number = (key) => {
    const match = text.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
    return match ? Number(match[1]) : undefined;
  };
  const string = (key) => {
    const match = text.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
    return match ? match[1] : undefined;
  };
  const exceptions = [];
  const list = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/);
  if (list) {
    for (const line of list[1].split("\n")) {
      const entry = line.match(/^\s*\d+\s*:\s*(\S+)\s*$/);
      if (entry) exceptions.push(entry[1]);
    }
  }
  return {
    httpEnabled: number("HTTPEnable") === 1,
    httpsEnabled: number("HTTPSEnable") === 1,
    host: string("HTTPProxy") || string("HTTPSProxy"),
    port: number("HTTPPort") ?? number("HTTPSPort"),
    exceptions,
  };
}

// Only an exact loopback token counts. A wildcard like `*.local` does not
// match `127.0.0.1`, and treating a non-empty list as sufficient is precisely
// the reading that makes a broken configuration look correct at a glance.
export function bypassesLoopback(entries) {
  if (!Array.isArray(entries)) return false;
  const normalized = entries.map((entry) =>
    String(entry || "").trim().toLowerCase().replace(/^\[|\]$/g, ""),
  );
  return LOOPBACK_TOKENS.every((token) => normalized.includes(token));
}

export function readSystemProxy(platform = process.platform, exec = spawnSync) {
  if (platform !== "darwin") return undefined;
  return parseScutilProxy(runText("scutil", ["--proxy"], exec));
}

// The GUI session's environment, which is what launchd hands a bundled app.
// It is deliberately not `process.env`: doctor usually runs from a terminal,
// whose `no_proxy` says nothing about what Codex Desktop will see.
export function readSessionNoProxy(platform = process.platform, exec = spawnSync) {
  if (platform !== "darwin") return undefined;
  const value = runText("launchctl", ["getenv", "NO_PROXY"], exec) ??
    runText("launchctl", ["getenv", "no_proxy"], exec);
  return value === undefined ? undefined : value.trim();
}

export const LOOPBACK_BYPASS_COMMAND =
  'launchctl setenv NO_PROXY "localhost,127.0.0.1,::1"';

// Returns undefined when a GUI client will reach the router directly, and a
// problem otherwise. Never guesses: with no system proxy configured there is
// nothing to bypass, and a platform this cannot inspect reports nothing rather
// than a warning the operator cannot act on.
export function loopbackProxyBypassProblem({
  platform = process.platform,
  systemProxy,
  sessionNoProxy,
} = {}) {
  if (platform !== "darwin") return undefined;
  if (!systemProxy) return undefined;
  if (!systemProxy.httpEnabled && !systemProxy.httpsEnabled) return undefined;
  if (bypassesLoopback(systemProxy.exceptions)) return undefined;
  // The session variable overrides the system settings for every app launched
  // afterwards, so a correct one makes an incomplete exception list harmless.
  if (bypassesLoopback(String(sessionNoProxy || "").split(","))) return undefined;

  const where = systemProxy.host
    ? `${systemProxy.host}${systemProxy.port ? `:${systemProxy.port}` : ""}`
    : "a system proxy";
  return {
    detail:
      `a system proxy (${where}) is enabled and does not bypass loopback, so ` +
      "apps launched from the Dock -- Codex Desktop, IDE extensions -- send " +
      "router traffic to it instead of to the router and fail before reaching it",
    remedy: `Run: ${LOOPBACK_BYPASS_COMMAND}  then fully quit and reopen the client.`,
  };
}

export function loopbackProxyBypassStatus({
  platform = process.platform,
  exec = spawnSync,
} = {}) {
  return loopbackProxyBypassProblem({
    platform,
    systemProxy: readSystemProxy(platform, exec),
    sessionNoProxy: readSessionNoProxy(platform, exec),
  });
}
