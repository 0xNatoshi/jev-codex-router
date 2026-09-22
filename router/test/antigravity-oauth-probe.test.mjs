import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writePrivateJson } from "../src/file-security.mjs";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-probe-"));
const tokenPath = path.join(testRoot, "antigravity-oauth.json");
const previousStateDir = process.env.CODEX_ROUTER_STATE_DIR;
const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
const previousTerminalGrace = process.env.ANTIGRAVITY_TERMINAL_GRACE_MS;
process.env.CODEX_ROUTER_STATE_DIR = testRoot;
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
process.env.ANTIGRAVITY_TERMINAL_GRACE_MS = "25";

const { probeAntigravity } = await import("../src/antigravity-oauth-probe.mjs");
const { antigravityOAuthStatus } = await import("../src/antigravity-oauth-status.mjs");

const TOKEN = {
  version: 3,
  managed_by: "codex-router",
  session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  client_id: "operator-owned.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  access_token: "access",
  refresh_token: "refresh",
  expires_at: 2_000_000_000,
  expires_in: 3600,
  token_type: "Bearer",
};
const ACTIVATION_GENERATION = "33333333-3333-4333-8333-333333333333";
const VERIFIED = {
  project_id: "previous-project",
  project_source: "managed",
  project_checked_at: 1_699_999_999_000,
  probe_version: 1,
  probe_verified_at: 1_699_999_999_000,
  probe_model: "gemini-3.1-pro",
  probe_activation: {
    version: 1,
    state: "active",
    generation: ACTIVATION_GENERATION,
  },
};

function writeToken(overrides = {}) {
  writePrivateJson(tokenPath, { ...TOKEN, ...overrides });
}

function completion({ text = "OK", finishReason = "STOP", parts } = {}) {
  return streamPayload(completionPayload({ text, finishReason, parts }));
}

function completionPayload({ text = "OK", finishReason = "STOP", parts } = {}) {
  return {
    candidates: [{
      content: { parts: parts || [{ text }] },
      finishReason,
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
  };
}

function streamPayload(payload) {
  return new Response(
    `data: ${JSON.stringify(payload)}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function delayedStreamPayloads(payloads, { delayMs = 5, onEmit } = {}) {
  const encoder = new TextEncoder();
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      let index = 0;
      const emit = () => {
        const payload = payloads[index++];
        const data = payload === "[DONE]" ? payload : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        onEmit?.(payload);
        if (index < payloads.length) {
          timer = setTimeout(emit, delayMs);
        } else {
          controller.close();
        }
      };
      emit();
    },
    cancel() {
      clearTimeout(timer);
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function projectAndStreamFetch(makeStreamResponse) {
  return async (url) => {
    const value = String(url);
    if (value.includes("loadCodeAssist")) {
      return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (value.includes("streamGenerateContent")) return makeStreamResponse();
    throw new Error(`Unexpected request: ${value}`);
  };
}

function openStreamPayload(payload, onCancel) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify(payload)}\n\n`,
      ));
    },
    cancel: onCancel,
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("refuses the quota-consuming probe before any network call without both consent flags", async () => {
  writeToken();
  let calls = 0;
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: false,
      fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
    }),
    { code: "live_probe_consent_required" },
  );
  assert.equal(calls, 0);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("records proof only after project discovery and one exact raw STOP candidate", async () => {
  writeToken();
  const calls = [];
  const now = 1_700_000_000_000;
  const result = await probeAntigravity({
    live: true,
    confirmed: true,
    activationGeneration: ACTIVATION_GENERATION,
    now: () => now,
    endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
    fetchImpl: async (url, options) => {
      const value = String(url);
      calls.push(value);
      assert.match(options.headers["User-Agent"], /^codex-router /);
      if (value.includes("loadCodeAssist")) {
        assert.deepEqual(JSON.parse(options.body), { metadata: {} });
        return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (value.includes("streamGenerateContent")) {
        const body = JSON.parse(options.body);
        assert.equal(body.project, "operator-project");
        assert.equal(body.userAgent, "codex-router");
        assert.match(JSON.stringify(body), /Reply with exactly OK/);
        return completion();
      }
      throw new Error(`Unexpected request: ${value}`);
    },
  });
  assert.deepEqual(calls.map((value) => new URL(value).pathname), [
    "/v1internal:loadCodeAssist",
    "/v1internal:streamGenerateContent",
  ]);
  assert.deepEqual(result, {
    verified: true,
    identity: "codex-router",
    model: "gemini-3.1-pro",
    verifiedAt: now,
    sessionGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    activationGeneration: ACTIVATION_GENERATION,
    activationPending: true,
    projectAvailable: true,
    projectProvisioningAllowed: false,
  });
  const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
  assert.equal(stored.probe_version, 1);
  assert.equal(stored.probe_verified_at, now);
  assert.equal(stored.project_id, "operator-project");
  assert.deepEqual(stored.probe_activation, {
    version: 1,
    state: "pending_activation",
    generation: ACTIVATION_GENERATION,
  });
  assert.equal(antigravityOAuthStatus().configured, false);
  assert.equal(antigravityOAuthStatus().activationPending, true);
  assert.equal(JSON.stringify(result).includes(TOKEN.client_secret), false);
  assert.equal(JSON.stringify(antigravityOAuthStatus()).includes(TOKEN.client_secret), false);
});

test("a valid terminal prefix cannot hide a later contradictory candidate before DONE", async () => {
  writeToken(VERIFIED);
  let emitted = 0;
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: true,
      endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
      fetchImpl: projectAndStreamFetch(() => delayedStreamPayloads([
        completionPayload(),
        {
          candidates: [{
            content: { parts: [] },
            finishReason: "SAFETY",
          }],
        },
        "[DONE]",
      ], { onEmit: () => { emitted += 1; } })),
    }),
    { code: "antigravity_probe_result_mismatch" },
  );
  assert.equal(emitted, 3, "proof must inspect every SSE member through upstream DONE");
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, undefined);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("a delayed DONE is observed before an otherwise exact proof is recorded", async () => {
  writeToken();
  let emitted = 0;
  const result = await probeAntigravity({
    live: true,
    confirmed: true,
    activationGeneration: ACTIVATION_GENERATION,
    endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
    fetchImpl: projectAndStreamFetch(() => delayedStreamPayloads([
      completionPayload(),
      "[DONE]",
    ], { onEmit: () => { emitted += 1; } })),
  });
  assert.equal(result.verified, true);
  assert.equal(emitted, 2, "proof must wait for the upstream DONE sentinel");
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, 1);
});

test("an exact proof may finish at the one bounded grace when DONE and EOF are absent", async () => {
  writeToken();
  let cancelled = false;
  const result = await probeAntigravity({
    live: true,
    confirmed: true,
    activationGeneration: ACTIVATION_GENERATION,
    endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
    fetchImpl: projectAndStreamFetch(() => openStreamPayload(
      completionPayload(),
      () => { cancelled = true; },
    )),
  });
  assert.equal(result.verified, true);
  assert.equal(cancelled, true, "the bounded grace must cancel the still-open upstream body");
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, 1);
});

test("an absolute-operation abort cancels an incomplete proof body without recording it", async () => {
  writeToken(VERIFIED);
  let cancelled = false;
  const operation = new AbortController();
  const reason = new Error("probe operation reached its absolute deadline");
  reason.code = "router_operation_timeout";
  const timer = setTimeout(() => operation.abort(reason), 15);
  try {
    await assert.rejects(
      probeAntigravity({
        live: true,
        confirmed: true,
        signal: operation.signal,
        endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
        fetchImpl: projectAndStreamFetch(() => openStreamPayload(
          { candidates: [{ content: { parts: [{ text: "O" }] } }] },
          () => { cancelled = true; },
        )),
      }),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(cancelled, true);
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, undefined);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("a rejected re-probe revokes seeded proof before its first network request", async () => {
  writeToken(VERIFIED);
  assert.equal(antigravityOAuthStatus().configured, true);
  let withdrawals = 0;
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: true,
      onProofInvalidated: async () => {
        withdrawals += 1;
        assert.equal(antigravityOAuthStatus().configured, false);
      },
      endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
      fetchImpl: async (url) => {
        assert.equal(antigravityOAuthStatus().configured, false);
        if (String(url).includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("vendor identity required", { status: 403 });
      },
    }),
    (error) => error.code === "antigravity_probe_failed" && error.status === 403,
  );
  assert.equal(withdrawals, 1);
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, undefined);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("a refresh failure after explicit consent cannot leave seeded proof configured", async () => {
  writeToken({
    ...VERIFIED,
    expires_at: 1_699_999_000,
  });
  let calls = 0;
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: true,
      now: () => 1_700_000_000_000,
      delayImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        assert.equal(antigravityOAuthStatus().configured, false);
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    { code: "oauth_transient" },
  );
  assert.equal(calls, 3);
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).probe_version, undefined);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("malformed and blocked re-probe streams cannot retain seeded proof", async () => {
  const cases = [
    {
      name: "malformed",
      response: () => new Response("data: {not-json}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      code: "malformed_sse",
    },
    {
      name: "blocked",
      response: () => new Response(
        `data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
      code: "content_filter",
    },
  ];
  for (const fixture of cases) {
    writeToken(VERIFIED);
    await assert.rejects(
      probeAntigravity({
        live: true,
        confirmed: true,
        endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
        fetchImpl: async (url) => {
          if (String(url).includes("loadCodeAssist")) {
            return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return fixture.response();
        },
      }),
      (error) => error.code === fixture.code,
      fixture.name,
    );
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(stored.probe_version, undefined, fixture.name);
    assert.equal(antigravityOAuthStatus().configured, false, fixture.name);
  }
});

test("proof requires stop, no tool calls, and trimmed content exactly OK", async () => {
  const cases = [
    { name: "safety finish", response: () => completion({ finishReason: "SAFETY" }) },
    { name: "near-match text", response: () => completion({ text: "NOT OK" }) },
    {
      name: "tool call",
      response: () => completion({
        parts: [
          { text: "OK" },
          { functionCall: { name: "unexpected", args: {}, id: "call-1" } },
        ],
      }),
    },
  ];
  for (const fixture of cases) {
    writeToken(VERIFIED);
    await assert.rejects(
      probeAntigravity({
        live: true,
        confirmed: true,
        endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
        fetchImpl: async (url) => {
          if (String(url).includes("loadCodeAssist")) {
            return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return fixture.response();
        },
      }),
      { code: "antigravity_probe_result_mismatch" },
      fixture.name,
    );
    assert.equal(antigravityOAuthStatus().configured, false, fixture.name);
  }
});

test("normalized finish-reason lookalikes cannot satisfy the raw STOP proof", async () => {
  for (const finishReason of ["OTHER", "MALFORMED", "UNKNOWN_VENDOR_REASON"]) {
    writeToken(VERIFIED);
    await assert.rejects(
      probeAntigravity({
        live: true,
        confirmed: true,
        endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
        fetchImpl: async (url) => {
          if (String(url).includes("loadCodeAssist")) {
            return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return completion({ finishReason });
        },
      }),
      { code: "antigravity_probe_result_mismatch" },
      finishReason,
    );
    assert.equal(antigravityOAuthStatus().configured, false, finishReason);
  }
});

test("multiple or ambiguous candidate payloads cannot satisfy the live proof", async () => {
  const fixtures = [
    {
      name: "multiple candidates",
      payload: {
        candidates: [
          { content: { parts: [{ text: "OK" }] }, finishReason: "STOP" },
          { content: { parts: [] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
      },
    },
    {
      name: "competing wrapped and top-level candidates",
      payload: {
        candidates: [
          { content: { parts: [{ text: "ignored" }] }, finishReason: "OTHER" },
        ],
        response: {
          candidates: [
            { content: { parts: [{ text: "OK" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        },
      },
    },
  ];
  for (const fixture of fixtures) {
    writeToken(VERIFIED);
    await assert.rejects(
      probeAntigravity({
        live: true,
        confirmed: true,
        endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
        fetchImpl: async (url) => {
          if (String(url).includes("loadCodeAssist")) {
            return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return streamPayload(fixture.payload);
        },
      }),
      { code: "antigravity_probe_result_mismatch" },
      fixture.name,
    );
    assert.equal(antigravityOAuthStatus().configured, false, fixture.name);
  }
});

test("project creation is never attempted without its separate opt-in", async () => {
  writeToken();
  const calls = [];
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: true,
      projectAttempts: 1,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    /--provision-project/,
  );
  assert.equal(calls.some((url) => url.includes("onboardUser")), false);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test("the separate provisioning opt-in permits one project setup before the live proof", async () => {
  writeToken();
  const calls = [];
  await probeAntigravity({
    live: true,
    confirmed: true,
    allowOnboard: true,
    projectAttempts: 1,
    endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
    fetchImpl: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({ allowedTiers: [{ id: "operator-tier", isDefault: true }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (value.includes("onboardUser")) {
        return new Response(JSON.stringify({
          done: true,
          response: { cloudaicompanionProject: "provisioned-project" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("streamGenerateContent")) return completion();
      throw new Error(`Unexpected request: ${value}`);
    },
  });
  assert.equal(calls.filter((value) => value.includes("onboardUser")).length, 1);
  const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
  assert.equal(stored.project_id, "provisioned-project");
  assert.equal(stored.tier_id, "operator-tier");
  const status = antigravityOAuthStatus();
  assert.equal(status.configured, false);
  assert.equal(status.activationPending, true);
});

test("a concurrent account replacement cannot inherit another account's live proof", async () => {
  writeToken();
  await assert.rejects(
    probeAntigravity({
      live: true,
      confirmed: true,
      endpoints: ["https://daily-cloudcode-pa.googleapis.com"],
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "operator-project" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (value.includes("streamGenerateContent")) {
          writeToken({
            session_generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            access_token: "replacement-access",
            refresh_token: "replacement-refresh",
          });
          return completion();
        }
        throw new Error(`Unexpected request: ${value}`);
      },
    }),
    /session changed|credential changed while the live probe was running/,
  );
  const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
  assert.equal(stored.refresh_token, "replacement-refresh");
  assert.equal(stored.probe_version, undefined);
  assert.equal(antigravityOAuthStatus().configured, false);
});

test.after(() => {
  if (previousStateDir === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
  else process.env.CODEX_ROUTER_STATE_DIR = previousStateDir;
  if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
  else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
  if (previousTerminalGrace === undefined) delete process.env.ANTIGRAVITY_TERMINAL_GRACE_MS;
  else process.env.ANTIGRAVITY_TERMINAL_GRACE_MS = previousTerminalGrace;
  rmSync(testRoot, { recursive: true, force: true });
});
