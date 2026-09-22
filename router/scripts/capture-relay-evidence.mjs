// Capture the real router's outgoing relay body (relay-out.json) and the
// final streamed response (relay-in.json) for plan verification #2. Boots the
// router with a mock gateway exactly like test/namespace-relay-routing.test.mjs
// and dumps both bodies.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const OUT_DIR = process.argv[2];
if (!OUT_DIR) {
  console.error("usage: node scripts/capture-relay-evidence.mjs <out-dir>");
  process.exit(1);
}

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const payload = {
  model: "opencode-go/deepseek-v4-flash",
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [
    { type: "function", name: "exec_command" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "load_workspace_dependencies" },
        { type: "function", name: "navigate_to_codex_page" },
        { type: "function", name: "read_thread_terminal" },
      ],
    },
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [{ type: "function", name: "js" }],
    },
  ],
};

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
const gatewaySse = [
  sse({ type: "response.created" }),
  sse({
    type: "response.output_item.done",
    item: { type: "function_call", name: "mcp__node_repl__js", call_id: "call_1", arguments: "{}" },
  }),
  sse({
    type: "response.output_item.done",
    item: { type: "function_call", name: "codex_app__create_thread", call_id: "call_2", arguments: "{}" },
  }),
  sse({
    type: "response.output_item.done",
    item: { type: "function_call", name: "collaboration__spawn_agent", call_id: "call_3", arguments: "{}" },
  }),
  sse({ type: "response.completed" }),
  "data: [DONE]\n\n",
].join("");

let outgoing;
const gateway = http.createServer(async (request, response) => {
  if (request.url === "/v1/responses") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    outgoing = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const body = Buffer.from(gatewaySse, "utf8");
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Content-Length": String(body.length),
    });
    response.end(body);
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = gateway.address().port;

const routerPort = await openPort();
const stateDir = mkdtempSync(path.join(os.tmpdir(), "relay-evidence-"));
const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_QUIET: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  errors += chunk;
});

const deadline = Date.now() + 8_000;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${routerBase(routerPort)}/models`);
    if (res.ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const response = await fetch(`${routerBase(routerPort)}/responses`, {
  method: "POST",
  headers: {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});
const clientBody = await response.text();
if (response.status !== 200) {
  console.error(`router returned ${response.status}: ${clientBody}`);
  console.error(errors);
  process.exit(1);
}
writeFileSync(path.join(OUT_DIR, "relay-out.json"), `${JSON.stringify(outgoing, null, 2)}\n`);
writeFileSync(path.join(OUT_DIR, "relay-in.json"), `${clientBody}\n`);
console.log(`wrote ${OUT_DIR}/relay-out.json (${JSON.stringify(outgoing).length} bytes) and relay-in.json (${clientBody.length} bytes)`);
child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));
gateway.close();
