import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { Readable } from "node:stream";

import { ZaiCacheUsageCompatTransform } from "../src/zai-cache-usage.mjs";

const python = process.argv[2];
if (!python) {
  throw new Error("usage: node scripts/verify-zai-litellm-usage.mjs <venv-python>");
}

const providerChunk = {
  id: "chatcmpl-zai-usage-proof",
  object: "chat.completion.chunk",
  created: 1_787_167_000,
  model: "glm-5.3",
  choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 8,
    total_tokens: 1208,
    prompt_tokens_details: { cached_tokens: 800 },
  },
};

async function normalize(body) {
  const stream = Readable.from([body]).pipe(new ZaiCacheUsageCompatTransform());
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const normalized = await normalize(
  `data: ${JSON.stringify(providerChunk)}\n\ndata: [DONE]\n\n`,
);
let receivedRequest;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  receivedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(normalized);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const { port } = server.address();
const pythonCode = String.raw`
import json
import sys
import litellm

port = int(sys.argv[1])
completed = None
stream = litellm.responses(
    model="openai/zai-coding-glm-5-3",
    input="cached prompt",
    stream=True,
    api_base=f"http://127.0.0.1:{port}/v1",
    api_key="test-zai-usage-proof",
    use_chat_completions_api=True,
)
for event in stream:
    if getattr(event, "type", None) == "response.completed":
        completed = event.response.usage.model_dump()
if completed is None:
    raise AssertionError("LiteLLM did not emit response.completed usage")
assert completed["input_tokens"] == 1200, completed
assert completed["output_tokens"] == 8, completed
assert completed["input_tokens_details"]["cached_tokens"] == 800, completed
print(json.dumps(completed, sort_keys=True))
`;

const child = spawn(python, ["-c", pythonCode, String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.once("exit", resolve));
await new Promise((resolve) => server.close(resolve));

assert.equal(exitCode, 0, stderr || stdout);
assert.equal(receivedRequest?.stream, true);
assert.equal(receivedRequest?.stream_options?.include_usage, true);
process.stdout.write(stdout);
