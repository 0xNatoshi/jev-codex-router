#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  PORTS,
  STATE_DIR,
} from "../src/paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex === -1 ? "grok-oauth/grok-4.6" : args[modelIndex + 1];

if (!args.includes("--yes")) {
  console.error(
    "This benchmark makes two live provider requests. Re-run with --yes to spend quota.\n" +
      "Usage: node scripts/live-test-tool-result-aging.mjs --yes [--model provider/model]",
  );
  process.exitCode = 2;
} else if (!model) {
  console.error("--model requires a routed model slug.");
  process.exitCode = 2;
} else {
  const internalSecret = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
  const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
  const large = `BEGIN_PROOF\n${"deterministic-tool-output-0123456789\n".repeat(1_800)}END_PROOF`;
  const input = [
    { type: "function_call", call_id: "old-proof", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "old-proof", output: large },
    { type: "message", role: "assistant", content: "I consumed the old proof output." },
    ...Array.from({ length: 4 }, (_, index) => [
      { type: "function_call", call_id: `new-${index}`, name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: `new-${index}`, output: `recent-${index}` },
      { type: "message", role: "assistant", content: `I consumed recent result ${index}.` },
    ]).flat(),
    { type: "message", role: "user", content: "Reply with exactly OK." },
  ];
  const body = { model, stream: false, input };
  const bodyJson = JSON.stringify(body);
  const enabledStatePath = path.join(
    os.tmpdir(),
    `codex-router-tool-result-aging-benchmark-${randomUUID()}.json`,
  );
  writeFileSync(enabledStatePath, `${JSON.stringify({ version: 1, enabled: true })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  async function openPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : undefined;
    await new Promise((resolve) => server.close(resolve));
    if (!port) throw new Error("Could not reserve a local benchmark port.");
    return port;
  }

  async function waitForRouter(base, child) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`Benchmark router exited early (${child.exitCode}): ${child.errors()}`);
      }
      try {
        const response = await fetch(`${base}/models`);
        if (response.ok) return;
      } catch {
        // The benchmark router has not bound its port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Benchmark router did not start: ${child.errors()}`);
  }

  async function runCase(label, enabled) {
    const port = await openPort();
    const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: STATE_DIR,
        MODEL_ROUTER_TOOL_RESULT_AGING_STATE: enabledStatePath,
        CODEX_ROUTER_PORT: String(port),
        CODEX_ROUTER_INTERNAL_KEY: internalSecret,
        CODEX_ROUTER_CALLER_KEY: callerSecret,
        CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${PORTS.gateway}/v1`,
        CODEX_ROUTER_TOOL_RESULT_AGING: enabled ? "1" : "0",
        CODEX_ROUTER_QUIET: "1",
        CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    child.errors = () => errors;
    const base = callerBaseUrl(port, callerSecret);
    try {
      await waitForRouter(base, child);
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer CODEX_CALLER_SECRET",
          "Content-Type": "application/json",
        },
        body: bodyJson,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Provider returned non-JSON HTTP ${response.status}.`);
      }
      if (!response.ok) {
        throw new Error(
          `Provider returned HTTP ${response.status}: ${payload?.error?.message || "request failed"}`,
        );
      }
      const inputTokens = payload?.usage?.input_tokens;
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
        throw new Error(
          "The provider did not report a positive input-token count; this model cannot prove a live token A/B.",
        );
      }
      return {
        label,
        status: response.status,
        providerInputTokens: inputTokens,
        providerOutputTokens: payload?.usage?.output_tokens ?? null,
        responseText:
          payload?.output
            ?.flatMap((item) => item?.content || [])
            .map((part) => part?.text)
            .filter(Boolean)
            .join("") || null,
      };
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }

  try {
    const off = await runCase("OFF", false);
    const on = await runCase("ON", true);
    const saved = off.providerInputTokens - on.providerInputTokens;
    process.stdout.write(
      `${JSON.stringify(
        {
          evidence: "provider-reported live A/B",
          model,
          identicalRequestBodySha256: createHash("sha256").update(bodyJson).digest("hex"),
          requestBodyBytes: Buffer.byteLength(bodyJson),
          largeToolResultBytes: Buffer.byteLength(large),
          off,
          on,
          actualProviderInputTokensSaved: saved,
          actualProviderInputTokenReductionPercent: Number(
            ((saved / off.providerInputTokens) * 100).toFixed(2),
          ),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    unlinkSync(enabledStatePath);
  }
}
