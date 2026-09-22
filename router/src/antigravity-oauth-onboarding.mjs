import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

import {
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_CALLBACK_HOST,
  ANTIGRAVITY_CALLBACK_PATH,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_URL,
  antigravityRedirectUri,
  antigravityUserAgent,
} from "./antigravity-oauth-constants.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  beginAntigravitySignInIntent,
  readAntigravityOAuthClient,
  readAntigravityToken,
  revokeRejectedAntigravityClient,
  saveAntigravityToken,
  validateAntigravityOAuthClient,
} from "./antigravity-oauth-session.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import { remainingOperationMs } from "./process-tree.mjs";

installStableFetchTransport();

const CLIENT_SETUP_PATH = "/oauth-client";
const OAUTH_START_PATH = "/oauth-start";
const MAX_FORM_BYTES = 16 * 1024;
const FORM_READ_TIMEOUT_MS = 5_000;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function generateAntigravityPkce(random = randomBytes) {
  const verifier = base64Url(random(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function verifierChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function antigravityAuthorizationUrl(
  verifier,
  state,
  { client, redirectUri } = {},
) {
  const validatedClient = validateAntigravityOAuthClient(client);
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== ANTIGRAVITY_CALLBACK_HOST ||
    redirect.pathname !== ANTIGRAVITY_CALLBACK_PATH ||
    redirect.username ||
    redirect.password ||
    !redirect.port ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error("Antigravity OAuth redirect must use the bound IPv4 loopback callback.");
  }
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.searchParams.set("client_id", validatedClient.client_id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect.toString());
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", verifierChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeAntigravityCode(
  code,
  verifier,
  { client, fetchImpl = fetch, now = Date.now, redirectUri, signal, deadline } = {},
) {
  const validatedClient = validateAntigravityOAuthClient(client);
  // Reuse the authorization URL validator without constructing a request.
  antigravityAuthorizationUrl(verifier, "redirect-validation", {
    client: validatedClient,
    redirectUri,
  });
  const remaining = remainingOperationMs(deadline, signal);
  const requestTimeout = Math.min(30_000, remaining ?? 30_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)])
    : AbortSignal.timeout(requestTimeout);
  const response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": antigravityUserAgent(),
    },
    body: new URLSearchParams({
      client_id: validatedClient.client_id,
      client_secret: validatedClient.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: requestSignal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = typeof payload?.error === "string" ? payload.error : undefined;
    const error = new Error(
      `Antigravity OAuth token exchange failed with HTTP ${response.status}.`,
    );
    error.code = response.status >= 500 ? "oauth_transient" : "oauth_unauthorized";
    error.status = response.status >= 500 ? 503 : 401;
    if (providerCode) error.providerCode = providerCode;
    throw error;
  }

  const expiresIn = Number(payload.expires_in);
  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("Antigravity OAuth token exchange returned an incomplete response.");
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Math.floor(now() / 1_000) + expiresIn,
    expires_in: expiresIn,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
  };
}

export async function fetchAntigravityUserEmail(
  accessToken,
  { fetchImpl = fetch, signal, deadline } = {},
) {
  try {
    const remaining = remainingOperationMs(deadline, signal);
    const requestTimeout = Math.min(10_000, remaining ?? 10_000);
    const response = await fetchImpl("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)])
        : AbortSignal.timeout(requestTimeout),
    });
    if (!response.ok) return undefined;
    const data = await response.json().catch(() => ({}));
    return typeof data?.email === "string" ? data.email : undefined;
  } catch {
    return undefined;
  }
}

function openBrowser(url) {
  let command;
  let args;
  let env;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process $env:CODEX_ROUTER_BROWSER_URL",
    ];
    env = { ...process.env, CODEX_ROUTER_BROWSER_URL: url };
  } else {
    command = "xdg-open";
    args = [url];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      ...(env ? { env } : {}),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(new Error(
          signal
            ? `browser launcher was terminated by ${signal}`
            : `browser launcher exited with status ${String(code)}`,
        ));
      }
    });
    child.unref();
  });
}

const BROWSER_RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function browserResponse(response, status, html, headers = {}) {
  response.writeHead(status, { ...BROWSER_RESPONSE_HEADERS, ...headers });
  response.end(html);
}

// A socket may be accepted in the narrow interval between listen(2) binding
// the ephemeral port and its callback publishing redirectUri. Keep request
// parsing outside the async handler so both that race and a malformed request
// target become an ordinary HTTP error instead of a rejected callback promise.
export function antigravityLoopbackRequestTarget(requestUrl, requestHost, redirectUri) {
  if (!redirectUri) {
    return { status: 503, html: "<h1>OAuth callback is not ready</h1>" };
  }
  let callback;
  let url;
  try {
    callback = new URL(redirectUri);
    url = new URL(requestUrl || "/", callback.origin);
  } catch {
    return { status: 400, html: "<h1>Loopback request was not accepted</h1>" };
  }
  if (
    requestHost !== callback.host ||
    url.origin !== callback.origin ||
    url.username ||
    url.password
  ) {
    return { status: 400, html: "<h1>Loopback request was not accepted</h1>" };
  }
  return { url };
}

async function readForm(request, { timeoutMs = FORM_READ_TIMEOUT_MS } = {}) {
  if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    throw new Error("The OAuth client form used an unsupported content type.");
  }
  let timer;
  const body = (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) throw new Error("The OAuth client form was too large.");
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("The OAuth client form body timed out.");
      request.destroy(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([body, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function clientSetupHtml(state) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex Router OAuth setup</title></head>
<body style="font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Connect your Google OAuth client</h1>
<p>Enter the client ID and matching client secret from a Google OAuth <strong>Desktop app</strong> you own. These values are posted only to this loopback listener and are saved in the router's owner-only credential file after Google sign-in succeeds.</p>
<form method="post" action="${CLIENT_SETUP_PATH}?state=${encodeURIComponent(state)}" autocomplete="off">
<input type="hidden" name="state" value="${state}">
<label>Client ID<br><input name="client_id" size="70" required autocomplete="off"></label><br><br>
<label>Client secret<br><input name="client_secret" type="password" size="70" required autocomplete="new-password"></label><br><br>
<button type="submit">Continue to Google</button>
</form></body></html>`;
}

// Runs the interactive Google OAuth authorization-code + PKCE flow. The
// listener is bound to an OS-assigned port before the redirect URI exists.
// No Antigravity/private endpoint is contacted here; compatibility is proved
// separately by the explicit quota-consuming live probe.
export async function signInAntigravity({
  fetchImpl = fetch,
  open = openBrowser,
  timeoutMs = 10 * 60_000,
  formReadTimeoutMs = FORM_READ_TIMEOUT_MS,
  now = Date.now,
  oauthClient,
  signal,
  deadline,
} = {}) {
  if (discoveryDisabled()) {
    throw new Error(
      "Provider credential discovery is disabled; rerun setup without --no-discovery before signing in.",
    );
  }
  let client = oauthClient
    ? validateAntigravityOAuthClient(oauthClient)
    : readAntigravityOAuthClient({ optional: true });
  let reloginToken;
  try {
    const stored = readAntigravityToken();
    if (
      stored.client_id === client?.client_id &&
      stored.client_secret === client?.client_secret
    ) {
      reloginToken = stored;
    }
  } catch {
    // A first sign-in has no token. An incompatible or revoked record remains
    // governed by the existing read/save refusal paths; it is never selected
    // as the compare-and-set target for a later provider rejection.
  }
  const operationDeadline = Number.isSafeInteger(deadline) ? deadline : Date.now() + timeoutMs;
  const intent = await beginAntigravitySignInIntent({ signal });
  const disconnectFence = intent.disconnect_fence;

  return new Promise((resolve, reject) => {
    const pkce = generateAntigravityPkce();
    const state = randomUUID();
    let redirectUri;
    let settled = false;
    let processing = false;
    let timer;
    let server;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (server?.listening) server.close(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("Antigravity OAuth sign-in was aborted."),
    );
    const authorizationUrl = () => antigravityAuthorizationUrl(pkce.verifier, state, {
      client,
      redirectUri,
    });

    server = http.createServer((request, response) => {
      void (async () => {
        const target = antigravityLoopbackRequestTarget(
          request.url,
          request.headers.host,
          redirectUri,
        );
        if (!target.url) {
          browserResponse(response, target.status, target.html);
          return;
        }
        const { url } = target;

      if (url.pathname === OAUTH_START_PATH && request.method === "GET") {
        if (!client || url.searchParams.get("state") !== state) {
          browserResponse(response, 400, "<h1>Sign-in request did not match</h1>");
          return;
        }
        browserResponse(
          response,
          303,
          "<h1>Continue to Google</h1>",
          { Location: authorizationUrl() },
        );
        return;
      }

      if (url.pathname === CLIENT_SETUP_PATH && request.method === "GET") {
        if (client || url.searchParams.get("state") !== state) {
          browserResponse(response, 400, "<h1>Setup request did not match</h1>");
          return;
        }
        browserResponse(response, 200, clientSetupHtml(state));
        return;
      }

      if (url.pathname === CLIENT_SETUP_PATH && request.method === "POST") {
        // Authenticate the request target before reading one byte of its body.
        // An untrusted peer therefore cannot latch setup or hold the only
        // client-submission slot open with a slow POST.
        if (url.searchParams.get("state") !== state) {
          browserResponse(
            response,
            400,
            "<h1>Setup request did not match</h1>",
            { Connection: "close" },
          );
          return;
        }
        if (client) {
          browserResponse(response, 409, "<h1>OAuth client is already configured</h1>");
          return;
        }
        try {
          const form = await readForm(request, { timeoutMs: formReadTimeoutMs });
          if (form.get("state") !== state) {
            browserResponse(response, 400, "<h1>Setup request did not match</h1>");
            return;
          }
          const submittedClient = validateAntigravityOAuthClient({
            client_id: form.get("client_id"),
            client_secret: form.get("client_secret"),
          });
          // Another valid form can finish while this request awaits its body.
          // Check again, then assign synchronously: no latch exists before the
          // complete authenticated body has been bounded and validated.
          if (client) {
            browserResponse(response, 409, "<h1>OAuth client is already configured</h1>");
            return;
          }
          client = submittedClient;
          browserResponse(
            response,
            303,
            "<h1>Continue to Google</h1>",
            { Location: authorizationUrl() },
          );
        } catch (error) {
          // A slow peer is deliberately destroyed by readForm. Its unusable
          // socket must not reject the whole sign-in flow for the real tab.
          try {
            browserResponse(
              response,
              400,
              "<h1>OAuth client was not accepted</h1><p>Check the Desktop app client ID and matching secret.</p>",
            );
          } catch {
            // The request timeout already closed this peer.
          }
        }
        return;
      }

      if (url.pathname !== ANTIGRAVITY_CALLBACK_PATH) {
        browserResponse(response, 404, "<h1>Not found</h1>");
        return;
      }
      if (request.method !== "GET") {
        browserResponse(response, 405, "<h1>Method not allowed</h1>", { Allow: "GET" });
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        browserResponse(
          response,
          400,
          "<h1>Sign-in request did not match</h1><p>Return to the original sign-in tab.</p>",
        );
        return;
      }

      const code = url.searchParams.get("code");
      const providerError = url.searchParams.get("error");
      if (providerError || !code || !client) {
        browserResponse(
          response,
          400,
          "<h1>Sign-in failed</h1><p>You can close this window and retry.</p>",
        );
        finish(new Error("Antigravity OAuth sign-in was not completed."));
        return;
      }
      if (processing) {
        browserResponse(response, 409, "<h1>Sign-in is already being completed</h1>");
        return;
      }
      processing = true;

      try {
        const token = await exchangeAntigravityCode(code, pkce.verifier, {
          client,
          fetchImpl,
          now,
          redirectUri,
          signal,
          deadline: operationDeadline,
        });
        const email = await fetchAntigravityUserEmail(token.access_token, {
          fetchImpl,
          signal,
          deadline: operationDeadline,
        });
        await saveAntigravityToken(
          {
            ...client,
            ...token,
            project_id: "",
            email,
          },
          {
            disconnectFence,
            signInGeneration: intent.generation,
            signal,
          },
        );
        browserResponse(response, 200, "<h1>Signed in</h1><p>You can close this window. Return to Codex Router to run the explicit live compatibility test.</p>");
        // Callers need only completion. Returning the stored object would put
        // the OAuth client secret and tokens one accidental log away from a
        // UI process even though every current caller ignores the value.
        finish(null, { signedIn: true, ...(email ? { email } : {}) });
      } catch (error) {
        if (error?.providerCode === "invalid_client" && reloginToken && client) {
          try {
            await revokeRejectedAntigravityClient(reloginToken, client);
          } catch (revocationError) {
            // Preserve Google's actionable provider code even if the private
            // credential lock itself is temporarily unavailable. The cause is
            // kept in-process and never rendered into the loopback response.
            if (error instanceof Error && error.cause === undefined) {
              error.cause = revocationError;
            }
          }
        }
        browserResponse(
          response,
          500,
          "<h1>Sign-in failed</h1><p>You can close this window and retry.</p>",
        );
        finish(error instanceof Error ? error : new Error(String(error)));
      }
      })().catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // This is the terminal catch for the async request body. Even a peer
        // that tears its socket down while we write the error must not turn
        // the catch callback itself into an unhandled rejected promise.
        try {
          if (!response.headersSent) {
            browserResponse(response, 500, "<h1>Sign-in request could not be processed</h1>");
          } else if (!response.writableEnded) {
            response.end();
          }
        } catch {
          // The socket is already unusable; finish still closes the listener.
        }
        finish(failure);
      });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.on("error", (error) => finish(error));
    server.listen(0, ANTIGRAVITY_CALLBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== ANTIGRAVITY_CALLBACK_HOST) {
        finish(new Error("Antigravity OAuth could not bind its IPv4 loopback callback."));
        return;
      }
      redirectUri = antigravityRedirectUri(address.port);
      let remaining;
      try {
        remaining = remainingOperationMs(operationDeadline, signal);
      } catch (error) {
        finish(error);
        return;
      }
      timer = setTimeout(() => {
        finish(new Error("Antigravity OAuth sign-in timed out; run it again."));
      }, remaining);

      // The operating-system browser command receives only this loopback URL.
      // The Google URL contains the client id, so it is produced as an HTTP
      // redirect inside the local listener rather than appearing in argv or
      // terminal output.
      const startPath = client ? OAUTH_START_PATH : CLIENT_SETUP_PATH;
      const startUrl = `${new URL(redirectUri).origin}${startPath}?state=${encodeURIComponent(state)}`;
      process.stdout.write(
        client
          ? `Open this local URL to sign in with the saved operator-owned Google OAuth client:\n\n  ${startUrl}\n\n`
          : "Create a Google OAuth Desktop app client you own, then enter its client ID and matching secret in this local setup page.\n" +
            `Open this URL to continue:\n\n  ${startUrl}\n\n`,
      );
      Promise.resolve()
        .then(() => open(startUrl))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          const failure = new Error(
            "Codex Router could not open the browser automatically " +
              `(${detail}). Run sign-in in a terminal and open the printed loopback URL.`,
          );
          failure.code = "oauth_browser_launch_failed";
          finish(failure);
        });
    });
  });
}
