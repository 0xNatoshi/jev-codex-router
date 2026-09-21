// A routed Chat call has to tell the provider how deep to think, and the field
// LiteLLM knows for that does not survive the gateway: its Responses bridge
// derives `reasoning_effort` from `reasoning`, then its parameter filter keeps
// only what the deployment's model label is known to support -- and every label
// here is this router's own gateway id. Measured on 18 September 2026 against
// opencode Go: the provider body carried no `reasoning_effort` for
// `deepseek-v4.1-flash` or `glm-5.3-flash`, while the same value passed through
// on LiteLLM's chat surface once the parameter was allowed. Reading the other
// half off the wire settled it: a field LiteLLM does not recognize crosses its
// bridge untouched (`client_metadata` already proves the channel), so the
// router labels the call and the forwarder -- which owns each model's ladder --
// restores it. These tests hold both ends: the label leaves the router, and the
// provider receives a rung its model actually declares.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", script)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function responsesFixture(model) {
  return {
    id: "resp_effort_fixture",
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_effort_fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  };
}

test("a routed Chat call leaves the router with the depth it decided", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    gatewayRequests.push(body);
    json(response, 200, responsesFixture(body.model));
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-effort-state-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "router-effort-home-"));
  mkdirSync(codexHome, { recursive: true });
  // The router resolves a routed provider's credential before it relays.
  writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "TEST_OPENCODE_GO_KEY", { mode: 0o600 });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_QUIET: "1",
  });
  const send = (model) => fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      reasoning: { effort: "medium", summary: "auto" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    // A Chat Completions route: the bridge will drop `reasoning_effort`, so the
    // decided depth travels beside it, in a field the bridge relays.
    const chat = await send("opencode-go/deepseek-v4.1-flash");
    assert.equal(chat.status, 200, `${await chat.text()}\n${router.testErrors()}`);
    assert.equal(gatewayRequests.at(-1).router_reasoning_effort, "medium");

    // A Responses-native route keeps the field it already had: its provider
    // reads `reasoning.effort` directly, and the marker would be an unknown
    // field on a strict endpoint.
    const native = await send("opencode-go-responses/gpt-5.6-luna");
    assert.equal(native.status, 200, `${await native.text()}\n${router.testErrors()}`);
    assert.equal(gatewayRequests.at(-1).router_reasoning_effort, undefined);
    assert.equal(gatewayRequests.at(-1).reasoning.effort, "medium");
  } finally {
    await stopChild(router);
    gateway.server.closeAllConnections();
    await new Promise((resolve) => gateway.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("the forwarder restores the carried depth onto the model's own ladder", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-effort-models-"));
  const modelsFile = path.join(directory, "user-models.json");
  const model = ({ id, levels }) => ({
    slug: `opencode-go/${id}`,
    gatewayModel: `opencode-go-${id}`,
    upstreamModel: id,
    provider: "opencode-go",
    listed: true,
    displayName: `${id} (curated)`,
    description: "Test fixture.",
    priority: 500,
    defaultEffort: levels[0],
    reasoningLevels: levels.map((effort) => ({ effort, description: `${effort} reasoning` })),
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: `opencode-go-${id}-user-v1`,
    requestProfile: "auto-tool-choice",
  });
  // The ladder the shipped DeepSeek and GLM routes declare, and a route with a
  // single rung, which is not a ladder at all.
  const laddered = model({ id: "laddered-fixture", levels: ["low", "high", "max"] });
  const single = model({ id: "single-fixture", levels: ["high"] });
  writeFileSync(modelsFile, JSON.stringify({ version: 1, models: [laddered, single] }), "utf8");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-effort-fwd-state-"));
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_USER_MODELS: modelsFile,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    OPENCODE_GO_API_KEY: "TEST_OPENCODE_GO_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  const forward = async (modelId, effort) => {
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `opencode-go-${modelId}`,
        messages: [{ role: "user", content: "hi" }],
        router_reasoning_effort: effort,
      }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    return upstreamRequests.at(-1);
  };

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });

    // Codex's rungs land on the rungs this model declares: the top rungs mean
    // "as deep as it goes", a rung below the floor lands on the floor, and
    // anything else takes the nearest declared rung at or below the request.
    for (const [requested, expected] of [
      ["low", "low"], ["medium", "low"], ["high", "high"], ["xhigh", "max"], ["max", "max"],
    ]) {
      const sent = await forward("laddered-fixture", requested);
      assert.equal(sent.reasoning_effort, expected, `effort ${requested}`);
      // The router's marker is this router's own label, never the provider's.
      assert.equal(sent.router_reasoning_effort, undefined);
      assert.equal(sent.model, "laddered-fixture");
    }

    // One declared rung is not a ladder: the parameter stays off the wire, the
    // way every other single-rung route behaves.
    const singleRung = await forward("single-fixture", "max");
    assert.equal(singleRung.reasoning_effort, undefined);
    assert.equal(singleRung.router_reasoning_effort, undefined);

    // A client that talks to the gateway directly sends no marker, and keeps
    // the flat field it always sent.
    const direct = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode-go-laddered-fixture",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      }),
    });
    assert.equal(direct.status, 200, forwarder.testErrors());
    assert.equal(upstreamRequests.at(-1).reasoning_effort, "max");
  } finally {
    await stopChild(forwarder);
    upstream.server.closeAllConnections();
    await new Promise((resolve) => upstream.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
