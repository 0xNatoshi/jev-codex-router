// DeepSeek states the rule for its thinking mode: once a request carries
// `tools`, the chain of thought of every previous turn is expected back, and a
// history that omits it -- from one turn or from all of them -- is answered
// with HTTP 400 "The `reasoning_content` in the thinking mode must be passed
// back to the API". Codex stores a native turn's reasoning as ciphertext plus a
// summary, and the summary is empty whenever the provider had none to give --
// so a session handed to a Chat thinking route (the Codex-dry tandem, or a
// manual switch after native turns) replays turns the vendor has no chain of
// thought for. Measured end to end on a captured 155-item native history
// against opencode Go on 18 September 2026: the request 400s as captured, 200
// with the empty-summary turn filled in, and 400 again with every summary
// emptied. The short tool loops that answer 200 with no reasoning at all are
// therefore not the rule; the tool-bearing history is. These tests hold what
// the repair does and the two boundaries it must not cross: nothing is added to
// a history that carries no tools, and a route outside the contract keeps the
// caller's own bytes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";

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
    env: { ...process.env, CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_SHOW_ALL_MODELS: "1", ...env },
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

function curatedModels() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reasoning-replay-"));
  const file = path.join(dir, "user-models.json");
  const model = ({ provider, id, gatewayModel }) => ({
    slug: `${provider}/${id}`,
    gatewayModel,
    upstreamModel: id,
    provider,
    listed: true,
    displayName: `${id} (curated)`,
    description: "Test fixture.",
    priority: 500,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-user-v1`,
  });
  // A fixture id, not a shipped one: the registry keys a route by
  // provider + upstream id, so reusing `deepseek-v4.1-flash` here would be
  // dropped as a duplicate of the shipped opencode Go entry rather than stand
  // in for it. `upstreamModel` is what carries the vendor identity the family
  // table matches, and `deepseek-v9-fixture` is in the family that table names
  // without being a route anyone ships.
  const tandem = model({
    provider: "opencode-go",
    id: "reasoning-fixture",
    gatewayModel: "opencode-go-reasoning-fixture",
  });
  tandem.upstreamModel = "deepseek-v9-fixture";
  tandem.requestProfile = "auto-tool-choice";
  // A Chat route outside the contract: no family table entry covers it, so its
  // history must reach upstream exactly as the caller wrote it.
  const outside = model({
    provider: "openrouter",
    id: "outside-fixture",
    gatewayModel: "openrouter-outside-fixture",
  });
  outside.upstreamModel = "qwen3.8-max";
  writeFileSync(file, JSON.stringify({ version: 1, models: [tandem, outside] }), "utf8");
  return { dir, file, tandem: tandem.gatewayModel, outside: outside.gatewayModel };
}

function call(id) {
  return { id, type: "function", function: { name: "exec_command", arguments: "{}" } };
}

// The shape a native session produces once its reasoning summaries run out: the
// first tool turn replays a summary, the second has nothing to give.
function history({ withThinking }) {
  const firstTurn = withThinking
    ? { role: "assistant", content: [{ type: "thinking", text: "PLAN_ONE" }], tool_calls: [call("call_1")] }
    : { role: "assistant", tool_calls: [call("call_1")] };
  return [
    { role: "user", content: "start" },
    firstTurn,
    { role: "tool", tool_call_id: "call_1", content: "result one" },
    { role: "user", content: "keep going" },
    { role: "assistant", tool_calls: [call("call_2")] },
    { role: "tool", tool_call_id: "call_2", content: "result two" },
    { role: "user", content: "now answer" },
  ];
}

function toolTurns(messages) {
  return messages.filter((message) => Array.isArray(message.tool_calls));
}

test("a tool-bearing history replays reasoning on every tool turn", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const models = curatedModels();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "reasoning-replay-state-"));
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_USER_MODELS: models.file,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENCODE_GO_API_KEY: "TEST_OPENCODE_GO_API_KEY",
    OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  async function forward(model, messages, { tools = true } = {}) {
    const body = { model, messages };
    if (tools) body.tools = [{ type: "function", function: { name: "exec_command" } }];
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    return upstreamRequests.at(-1).messages;
  }

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });

    // A summary that exists is replayed as the vendor's own field, and the turn
    // that had none still carries a labelled stub so the history is uniform.
    const forwarded = await forward(models.tandem, history({ withThinking: true }));
    const [planned, unrecorded] = toolTurns(forwarded);
    assert.equal(planned.reasoning_content, "PLAN_ONE");
    assert.equal(typeof unrecorded.reasoning_content, "string");
    assert.match(unrecorded.reasoning_content, /reasoning unavailable/);
    assert.notEqual(unrecorded.reasoning_content, planned.reasoning_content);
    // The stub is reasoning, not an answer: it must not become assistant text.
    for (const message of forwarded) {
      if (message.role !== "assistant") continue;
      assert.ok(!JSON.stringify(message.content ?? null).includes("reasoning unavailable"));
    }

    // Uniform absence is the other shape the vendor refuses: with tools in
    // play, a turn it has no chain of thought for still gets one.
    for (const message of toolTurns(await forward(models.tandem, history({ withThinking: false })))) {
      assert.match(message.reasoning_content ?? "", /reasoning unavailable/);
    }

    // Without tools the vendor ignores reasoning entirely, so no stub is
    // invented and the caller's body stays as small as it was. A summary the
    // caller did send keeps its existing replay.
    const toolFree = toolTurns(await forward(models.tandem, history({ withThinking: true }), { tools: false }));
    assert.equal(toolFree[0].reasoning_content, "PLAN_ONE");
    assert.equal(toolFree[1].reasoning_content, undefined);

    // A route outside the contract keeps the caller's own history.
    const untouched = toolTurns(await forward(models.outside, history({ withThinking: true })));
    assert.deepEqual(untouched[0].content, [{ type: "thinking", text: "PLAN_ONE" }]);
    assert.equal(untouched[0].reasoning_content, undefined);
    assert.equal(untouched[1].reasoning_content, undefined);
  } finally {
    await stopChild(forwarder);
    upstream.server.closeAllConnections();
    await new Promise((resolve) => upstream.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(models.dir, { recursive: true, force: true });
  }
});
