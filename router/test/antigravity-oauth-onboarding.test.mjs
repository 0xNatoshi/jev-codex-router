import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  antigravityRedirectUri,
  antigravityUserAgent,
} from "../src/antigravity-oauth-constants.mjs";
import {
  antigravityAuthorizationUrl,
  antigravityLoopbackRequestTarget,
  exchangeAntigravityCode,
  generateAntigravityPkce,
  signInAntigravity,
} from "../src/antigravity-oauth-onboarding.mjs";
import {
  removeAntigravityToken,
  setAntigravityTokenPathForTests,
} from "../src/antigravity-oauth-session.mjs";

const CLIENT = Object.freeze({
  client_id: "operator-owned.apps.googleusercontent.com",
  client_secret: "test-client-secret",
});
const OTHER_CLIENT = Object.freeze({
  client_id: "different-operator.apps.googleusercontent.com",
  client_secret: "different-client-secret",
});
const ACTIVE_GENERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function activeCredential(overrides = {}) {
  return {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...CLIENT,
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: 2_000_000_000,
    expires_in: 3600,
    project_id: "managed-project",
    project_source: "managed",
    probe_version: 1,
    probe_verified_at: 1_999_999_000_000,
    probe_model: "gemini-3.1-pro",
    probe_activation: {
      version: 1,
      state: "active",
      generation: ACTIVE_GENERATION,
    },
    ...overrides,
  };
}

async function withTokenPath(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-sign-in-"));
  const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  const tokenPath = path.join(directory, "token.json");
  setAntigravityTokenPathForTests(tokenPath);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  try {
    return await run(tokenPath);
  } finally {
    setAntigravityTokenPathForTests(undefined);
    if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
    rmSync(directory, { recursive: true, force: true });
  }
}

function oauthFetch(calls, { gate, started } = {}) {
  return async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    assert.doesNotMatch(value, /cloudcode-pa|streamGenerateContent|loadCodeAssist/);
    if (value.includes("oauth2.googleapis.com/token")) {
      started?.();
      if (gate) await gate;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_id"), CLIENT.client_id);
      assert.equal(body.get("client_secret"), CLIENT.client_secret);
      return new Response(
        JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (value.includes("userinfo")) {
      return new Response(JSON.stringify({ email: "person@example.test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${value}`);
  };
}

async function callbackUrlFor(opened) {
  const start = await fetch(await opened, { redirect: "manual" });
  assert.equal(start.status, 303);
  const authorizationUrl = new URL(start.headers.get("location"));
  return (
    `${authorizationUrl.searchParams.get("redirect_uri")}` +
    `?state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}&code=code`
  );
}

test("generates a PKCE verifier and matching challenge", () => {
  const { verifier, challenge } = generateAntigravityPkce(() => Buffer.alloc(64, 7));
  assert.ok(verifier.length > 40);
  assert.ok(challenge.length > 40);
  assert.notEqual(verifier, challenge);
});

test("builds an operator-client authorization URL with PKCE and offline access", () => {
  const { verifier } = generateAntigravityPkce(() => Buffer.alloc(64, 3));
  const redirectUri = antigravityRedirectUri(54321);
  const url = new URL(antigravityAuthorizationUrl(verifier, "state-123", {
    client: CLIENT,
    redirectUri,
  }));
  assert.equal(url.searchParams.get("client_id"), CLIENT.client_id);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("rejects non-IP, non-ephemeral callback construction", () => {
  assert.throws(() => antigravityRedirectUri(0), /OS-assigned/);
  assert.throws(() => antigravityRedirectUri(65_536), /OS-assigned/);
  assert.throws(
    () => antigravityAuthorizationUrl("verifier", "state", {
      client: CLIENT,
      redirectUri: "http://localhost:54321/oauth-callback",
    }),
    /IPv4 loopback/,
  );
  assert.throws(
    () => antigravityAuthorizationUrl("verifier", "state", {
      client: CLIENT,
      redirectUri: "http://user:password@127.0.0.1:54321/oauth-callback",
    }),
    /IPv4 loopback/,
  );
});

test("loopback requests fail closed before redirect initialization and on malformed URLs", () => {
  const redirectUri = antigravityRedirectUri(54321);
  assert.deepEqual(
    antigravityLoopbackRequestTarget("/", "127.0.0.1:54321", undefined),
    { status: 503, html: "<h1>OAuth callback is not ready</h1>" },
  );
  assert.deepEqual(
    antigravityLoopbackRequestTarget("http://[", "127.0.0.1:54321", redirectUri),
    { status: 400, html: "<h1>Loopback request was not accepted</h1>" },
  );
  assert.equal(
    antigravityLoopbackRequestTarget("/oauth-callback", "attacker.invalid", redirectUri).status,
    400,
  );
  assert.equal(
    antigravityLoopbackRequestTarget(
      "http://attacker.invalid/oauth-start",
      "127.0.0.1:54321",
      redirectUri,
    ).status,
    400,
  );
  assert.equal(
    antigravityLoopbackRequestTarget(
      "http://user:password@127.0.0.1:54321/oauth-start",
      "127.0.0.1:54321",
      redirectUri,
    ).status,
    400,
  );
  assert.equal(
    antigravityLoopbackRequestTarget("/oauth-callback", "127.0.0.1:54321", redirectUri).url
      .pathname,
    "/oauth-callback",
  );
});

test("refuses to overwrite an invalid or foreign credential record during sign-in", async () => {
  await withTokenPath(async (tokenPath) => {
    const foreign = JSON.stringify({
      client_id: CLIENT.client_id,
      client_secret: CLIENT.client_secret,
      refresh_token: "foreign-refresh",
    });
    writeFileSync(tokenPath, foreign, { mode: 0o600 });
    let opened = false;
    await assert.rejects(
      signInAntigravity({
        open: () => { opened = true; },
        fetchImpl: async () => { throw new Error("must not run"); },
      }),
      /only a credential created by this Codex Router/,
    );
    assert.equal(opened, false);
    assert.equal(readFileSync(tokenPath, "utf8"), foreign);
  });
});

test("uses the truthful Codex Router identity on every host platform", () => {
  assert.equal(antigravityUserAgent("win32", "x64"), "codex-router (os_type=windows; arch=amd64)");
  assert.equal(antigravityUserAgent("linux", "ia32"), "codex-router (os_type=linux; arch=386)");
  assert.equal(antigravityUserAgent("darwin", "arm64"), "codex-router (os_type=darwin; arch=arm64)");
});

test("exchanges a code only with the supplied coherent client pair", async () => {
  const redirectUri = antigravityRedirectUri(54321);
  const token = await exchangeAntigravityCode("code", "verifier", {
    client: CLIENT,
    redirectUri,
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      assert.match(url, /oauth2\.googleapis\.com\/token$/);
      assert.equal(options.headers["User-Agent"].startsWith("codex-router"), true);
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_id"), CLIENT.client_id);
      assert.equal(body.get("client_secret"), CLIENT.client_secret);
      assert.equal(body.get("redirect_uri"), redirectUri);
      assert.equal(body.get("code"), "code");
      assert.equal(body.get("code_verifier"), "verifier");
      return new Response(
        JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(token.access_token, "access");
  assert.equal(token.refresh_token, "refresh");
  assert.equal(token.expires_at, 1_700_000_000 + 3600);
});

test("preserves Google's provider code when the authorization-code exchange fails", async () => {
  await assert.rejects(
    exchangeAntigravityCode("code", "verifier", {
      client: CLIENT,
      redirectUri: antigravityRedirectUri(54321),
      fetchImpl: async () => new Response(
        JSON.stringify({ error: "invalid_client", error_description: "must stay private" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    }),
    (error) => {
      assert.equal(error.code, "oauth_unauthorized");
      assert.equal(error.status, 401);
      assert.equal(error.providerCode, "invalid_client");
      assert.doesNotMatch(error.message, /must stay private/);
      return true;
    },
  );
});

test("re-login invalid_client tombstones only the exact active credential and proof", async () => {
  await withTokenPath(async (tokenPath) => {
    writeFileSync(tokenPath, JSON.stringify(activeCredential()), { mode: 0o600 });
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const signIn = signInAntigravity({
      open: openedResolve,
      // Re-login writes both the sign-in intent and the rejected-client
      // tombstone. Windows hardens each private JSON write through its own
      // bounded 15-second PowerShell operation, so a five-second interactive
      // deadline can replace the real invalid_client error while the exact
      // tombstone is still being secured on a loaded CI runner.
      timeoutMs: 45_000,
      fetchImpl: async (url) => {
        assert.match(String(url), /oauth2\.googleapis\.com\/token$/);
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const rejected = assert.rejects(signIn, (error) => {
      assert.equal(error.providerCode, "invalid_client");
      return true;
    });

    assert.equal((await fetch(await callbackUrlFor(opened))).status, 500);
    await rejected;
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(stored.client_id, CLIENT.client_id);
    assert.equal(stored.client_secret, CLIENT.client_secret);
    assert.equal(stored.access_token, "");
    assert.equal(stored.refresh_token, "");
    assert.equal(stored.rejection_reason, "invalid_client");
    assert.equal(stored.probe_version, undefined);
    assert.equal(stored.probe_activation, undefined);
  });
});

test("exchange-time invalid_client cannot tombstone a concurrent replacement", async () => {
  await withTokenPath(async (tokenPath) => {
    writeFileSync(tokenPath, JSON.stringify(activeCredential()), { mode: 0o600 });
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const replacement = activeCredential({
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      expires_at: 2_000_001_000,
      probe_activation: {
        version: 1,
        state: "active",
        generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    const signIn = signInAntigravity({
      open: openedResolve,
      timeoutMs: 5_000,
      fetchImpl: async () => {
        writeFileSync(tokenPath, JSON.stringify(replacement), { mode: 0o600 });
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const rejected = assert.rejects(signIn, { providerCode: "invalid_client" });

    assert.equal((await fetch(await callbackUrlFor(opened))).status, 500);
    await rejected;
    assert.deepEqual(JSON.parse(readFileSync(tokenPath, "utf8")), replacement);
  });
});

test("exchange-time invalid_client cannot erase a concurrent proof generation", async () => {
  await withTokenPath(async (tokenPath) => {
    writeFileSync(tokenPath, JSON.stringify(activeCredential()), { mode: 0o600 });
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const replacement = activeCredential({
      probe_activation: {
        version: 1,
        state: "pending_activation",
        generation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    });
    const signIn = signInAntigravity({
      open: openedResolve,
      timeoutMs: 5_000,
      fetchImpl: async () => {
        writeFileSync(tokenPath, JSON.stringify(replacement), { mode: 0o600 });
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const rejected = assert.rejects(signIn, { providerCode: "invalid_client" });

    assert.equal((await fetch(await callbackUrlFor(opened))).status, 500);
    await rejected;
    assert.deepEqual(JSON.parse(readFileSync(tokenPath, "utf8")), replacement);
  });
});

test("invalid_client for a different attempted pair never revokes the stored credential", async () => {
  await withTokenPath(async (tokenPath) => {
    const existing = activeCredential();
    writeFileSync(tokenPath, JSON.stringify(existing), { mode: 0o600 });
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const signIn = signInAntigravity({
      oauthClient: OTHER_CLIENT,
      open: openedResolve,
      timeoutMs: 5_000,
      fetchImpl: async (_url, options) => {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("client_id"), OTHER_CLIENT.client_id);
        assert.equal(body.get("client_secret"), OTHER_CLIENT.client_secret);
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const rejected = assert.rejects(signIn, { providerCode: "invalid_client" });

    assert.equal((await fetch(await callbackUrlFor(opened))).status, 500);
    await rejected;
    assert.deepEqual(JSON.parse(readFileSync(tokenPath, "utf8")), existing);
  });
});

test("binds an ephemeral IP-literal listener before constructing the redirect", async () => {
  await withTokenPath(async (tokenPath) => {
    const calls = [];
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const signIn = signInAntigravity({
      oauthClient: CLIENT,
      open: openedResolve,
      fetchImpl: oauthFetch(calls),
      now: () => 1_700_000_000_000,
    });

    const startUrl = new URL(await opened);
    assert.equal(startUrl.hostname, "127.0.0.1");
    assert.equal(startUrl.pathname, "/oauth-start");
    assert.equal(startUrl.toString().includes(CLIENT.client_id), false);
    assert.equal(startUrl.toString().includes(CLIENT.client_secret), false);
    const start = await fetch(startUrl, { redirect: "manual" });
    assert.equal(start.status, 303);
    const authorizationUrl = new URL(start.headers.get("location"));
    const redirectUri = new URL(authorizationUrl.searchParams.get("redirect_uri"));
    assert.equal(redirectUri.hostname, "127.0.0.1");
    assert.ok(Number(redirectUri.port) > 0);
    const state = authorizationUrl.searchParams.get("state");

    const wrong = await fetch(`${redirectUri}?state=wrong&code=wrong`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get("cache-control"), "no-store");
    assert.match(wrong.headers.get("content-security-policy"), /default-src 'none'/);

    const correct = await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=code`);
    assert.equal(correct.status, 200);
    const result = await signIn;
    assert.deepEqual(result, { signedIn: true, email: "person@example.test" });
    assert.equal(JSON.stringify(result).includes(CLIENT.client_secret), false);
    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(onDisk.version, 3);
    assert.match(onDisk.session_generation, /^[0-9a-f-]{36}$/i);
    assert.equal(onDisk.managed_by, "codex-router");
    assert.equal(onDisk.client_id, CLIENT.client_id);
    assert.equal(onDisk.client_secret, CLIENT.client_secret);
    assert.equal(onDisk.project_id, "");
    assert.equal(onDisk.probe_version, undefined);
    assert.equal(onDisk.email, "person@example.test");
    if (process.platform !== "win32") assert.equal(statSync(tokenPath).mode & 0o077, 0);
    assert.equal(calls.some(({ url }) => /cloudcode-pa/.test(url)), false);
  });
});

test("collects a first-time client pair only through the loopback POST", async () => {
  await withTokenPath(async (tokenPath) => {
    const calls = [];
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const signIn = signInAntigravity({
      open: openedResolve,
      fetchImpl: oauthFetch(calls),
      formReadTimeoutMs: 50,
      now: () => 1_700_000_000_000,
    });

    const setupUrl = new URL(await opened);
    assert.equal(setupUrl.hostname, "127.0.0.1");
    assert.equal(setupUrl.pathname, "/oauth-client");
    const page = await fetch(setupUrl);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /type="password"/);
    assert.match(pageHtml, /action="\/oauth-client\?state=[0-9a-f-]+"/);

    // Send only an unauthenticated request's headers and deliberately hold its
    // body open. The state in the request target must reject it immediately;
    // it cannot occupy a submission latch while the real tab continues.
    const heldStatus = await new Promise((resolve, reject) => {
      const heldUrl = new URL(setupUrl);
      heldUrl.searchParams.set("state", "wrong");
      const request = http.request(heldUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }, (response) => {
        response.resume();
        response.once("end", () => {
          request.destroy();
          resolve(response.statusCode);
        });
      });
      request.once("error", reject);
      request.flushHeaders();
    });
    assert.equal(heldStatus, 400);

    const authenticatedSlowPost = new Promise((resolve) => {
      const request = http.request(setupUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("error", resolve);
      request.flushHeaders();
    });
    await authenticatedSlowPost;

    const badUrl = new URL(setupUrl);
    badUrl.searchParams.set("state", "wrong");
    const bad = await fetch(badUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        state: "wrong",
        client_id: CLIENT.client_id,
        client_secret: CLIENT.client_secret,
      }),
      redirect: "manual",
    });
    assert.equal(bad.status, 400);

    const configured = await fetch(setupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        state: setupUrl.searchParams.get("state"),
        client_id: CLIENT.client_id,
        client_secret: CLIENT.client_secret,
      }),
      redirect: "manual",
    });
    assert.equal(configured.status, 303);
    const authorizationUrl = new URL(configured.headers.get("location"));
    assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT.client_id);
    assert.equal(authorizationUrl.toString().includes(CLIENT.client_secret), false);
    const redirectUri = new URL(authorizationUrl.searchParams.get("redirect_uri"));
    assert.equal(redirectUri.origin, setupUrl.origin);

    const callback = await fetch(
      `${redirectUri}?state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}&code=code`,
    );
    assert.equal(callback.status, 200);
    await signIn;
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(stored.client_id, CLIENT.client_id);
    assert.equal(stored.client_secret, CLIENT.client_secret);
  });
});

test("a browser-launch failure rejects the desktop flow instead of waiting ten minutes", async () => {
  await withTokenPath(async (tokenPath) => {
    await assert.rejects(
      signInAntigravity({
        oauthClient: CLIENT,
        open: async () => { throw new Error("launcher missing"); },
        fetchImpl: async () => { throw new Error("must not run"); },
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.equal(error.code, "oauth_browser_launch_failed");
        assert.match(error.message, /launcher missing/);
        assert.match(error.message, /printed loopback URL/);
        return true;
      },
    );
    assert.equal(existsSync(tokenPath), false);
  });
});

test("guards a valid callback while its token exchange is in progress", async () => {
  await withTokenPath(async () => {
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    let exchangeStartedResolve;
    const exchangeStarted = new Promise((resolve) => { exchangeStartedResolve = resolve; });
    let releaseExchange;
    const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
    const signIn = signInAntigravity({
      oauthClient: CLIENT,
      open: openedResolve,
      timeoutMs: 5_000,
      fetchImpl: oauthFetch([], { gate: exchangeGate, started: exchangeStartedResolve }),
    });
    const startUrl = new URL(await opened);
    assert.equal(startUrl.pathname, "/oauth-start");
    const start = await fetch(startUrl, { redirect: "manual" });
    assert.equal(start.status, 303);
    const authorizationUrl = new URL(start.headers.get("location"));
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    const state = authorizationUrl.searchParams.get("state");
    const callbackUrl = `${redirectUri}?state=${encodeURIComponent(state)}&code=code`;
    const first = fetch(callbackUrl);
    await exchangeStarted;
    const duplicate = await fetch(callbackUrl);
    assert.equal(duplicate.status, 409);
    releaseExchange();
    assert.equal((await first).status, 200);
    await signIn;
  });
});

test("disconnect wins over a callback whose token exchange is already in flight", async () => {
  await withTokenPath(async (tokenPath) => {
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    let exchangeStartedResolve;
    const exchangeStarted = new Promise((resolve) => { exchangeStartedResolve = resolve; });
    let releaseExchange;
    const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
    const signIn = signInAntigravity({
      oauthClient: CLIENT,
      open: openedResolve,
      timeoutMs: 5_000,
      fetchImpl: oauthFetch([], { gate: exchangeGate, started: exchangeStartedResolve }),
    });
    const signInRejected = assert.rejects(signIn, { code: "oauth_disconnected" });

    const start = await fetch(await opened, { redirect: "manual" });
    const authorizationUrl = new URL(start.headers.get("location"));
    const callback = fetch(
      `${authorizationUrl.searchParams.get("redirect_uri")}` +
        `?state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}&code=code`,
    );
    await exchangeStarted;
    assert.equal(await removeAntigravityToken(), false);
    releaseExchange();

    assert.equal((await callback).status, 500);
    await signInRejected;
    assert.equal(existsSync(tokenPath), false);
  });
});

test("a newer persisted sign-in intent fences an older callback", async () => {
  await withTokenPath(async (tokenPath) => {
    let firstOpenedResolve;
    let secondOpenedResolve;
    const firstOpened = new Promise((resolve) => { firstOpenedResolve = resolve; });
    const secondOpened = new Promise((resolve) => { secondOpenedResolve = resolve; });
    const fetchImpl = async (url, options = {}) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        const code = new URLSearchParams(options.body).get("code");
        return new Response(JSON.stringify({
          access_token: `${code}-access`,
          refresh_token: `${code}-refresh`,
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("userinfo")) {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const first = signInAntigravity({
      oauthClient: CLIENT,
      fetchImpl,
      open: (url) => firstOpenedResolve(url),
    });
    const firstRejected = assert.rejects(first, /newer.*sign-in|superseded/i);
    const firstCallback = await callbackUrlFor(firstOpened);
    const second = signInAntigravity({
      oauthClient: CLIENT,
      fetchImpl,
      open: (url) => secondOpenedResolve(url),
    });
    const secondCallback = (await callbackUrlFor(secondOpened)).replace("code=code", "code=newer");
    assert.equal((await fetch(secondCallback)).status, 200);
    await second;
    assert.equal((await fetch(firstCallback)).status, 500);
    await firstRejected;
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(stored.refresh_token, "newer-refresh");
  });
});
