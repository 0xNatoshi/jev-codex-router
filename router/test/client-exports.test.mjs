import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const {
  buildClientExport,
  buildRouterEndpointExport,
  renderClientExport,
} = await import("../src/client-exports.mjs");
const { PORTS } = await import("../src/paths.mjs");

const expectedBase = (name = "CODEX_ROUTER_CALLER_KEY") =>
  `http://127.0.0.1:${PORTS.router}/_codex-router/\${${name}}/v1`;

test("builds only the wired loopback router descriptor", () => {
  const descriptor = buildRouterEndpointExport();

  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.kind, "router-endpoint");
  assert.equal(descriptor.gateway.baseUrl, expectedBase());
  assert.equal(descriptor.gateway.protocol, "openai-compatible");
  assert.deepEqual(descriptor.gateway.auth, {
    type: "path-capability",
    secretRef: { type: "environment", name: "CODEX_ROUTER_CALLER_KEY" },
  });
  assert.equal(Object.hasOwn(descriptor, "client"), false);
  assert.equal(Object.hasOwn(descriptor, "models"), false);
  assert.equal(Object.hasOwn(descriptor, "capabilities"), false);
  assert.equal(Object.hasOwn(descriptor, "metadata"), false);
});

test("keeps the caller capability as an environment reference only", () => {
  const descriptor = buildClientExport({ secretEnv: "MY_ROUTER_KEY" });
  const rendered = renderClientExport({ secretEnv: "MY_ROUTER_KEY" });

  assert.equal(descriptor.gateway.baseUrl, expectedBase("MY_ROUTER_KEY"));
  assert.equal(descriptor.gateway.auth.secretRef.name, "MY_ROUTER_KEY");
  assert.match(rendered, /MY_ROUTER_KEY/);
  assert.doesNotMatch(rendered, /codex-router-local|sk-[A-Za-z0-9]|raw-secret/);
});

test("accepts only the configured loopback origin and router path", () => {
  const accepted = buildClientExport({
    baseUrl: `${expectedBase("ROUTER_KEY")}/`,
    secretEnv: "ROUTER_KEY",
  });
  assert.equal(accepted.gateway.baseUrl, expectedBase("ROUTER_KEY"));

  for (const baseUrl of [
    `https://127.0.0.1:${PORTS.router}/_codex-router/\${ROUTER_KEY}/v1`,
    `http://localhost:${PORTS.router}/_codex-router/\${ROUTER_KEY}/v1`,
    `http://127.0.0.2:${PORTS.router}/_codex-router/\${ROUTER_KEY}/v1`,
    `http://127.0.0.1:${PORTS.router + 1}/_codex-router/\${ROUTER_KEY}/v1`,
    `http://127.0.0.1:${PORTS.router}/_codex-router/\${ROUTER_KEY}/panel`,
    `http://127.0.0.1:${PORTS.router}/_codex-router/\${ROUTER_KEY}/v1?redirect=https://evil.test`,
    `http://user:password@127.0.0.1:${PORTS.router}/_codex-router/\${ROUTER_KEY}/v1`,
  ]) {
    assert.throws(
      () => buildClientExport({ baseUrl, secretEnv: "ROUTER_KEY" }),
      /configured loopback router endpoint/,
      baseUrl,
    );
  }
});

test("rejects client adapters and secret-bearing values until wired", () => {
  assert.throws(
    () => buildClientExport({ client: "opencode" }),
    /client-specific adapters are not wired/,
  );
  for (const options of [
    { models: [{ id: "model" }] },
    { capabilities: { tools: true } },
    { metadata: { token: "do-not-export" } },
    { callerCapability: "do-not-export" },
    { token: "do-not-export" },
  ]) {
    assert.throws(() => buildClientExport(options), /not supported/);
  }
  assert.throws(() => buildClientExport({ secretEnv: "router-key" }), /environment variable/);
});

test("control exposes the same safe descriptor without embedding a token", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("src/control.mjs"), "client-export", "--secret-env", "TEST_ROUTER_KEY"],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const descriptor = JSON.parse(result.stdout);
  assert.equal(descriptor.kind, "router-endpoint");
  assert.equal(descriptor.gateway.auth.secretRef.name, "TEST_ROUTER_KEY");
  assert.match(descriptor.gateway.baseUrl, /127\.0\.0\.1/);
  assert.doesNotMatch(result.stdout, /raw-secret|sk-[A-Za-z0-9]/);
});
