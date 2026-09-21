import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-mlx-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  DEFAULT_MLX_URL,
  LOCAL_MLX_CONTEXT,
  LOCAL_MLX_ID,
  MLX_INCLUDE,
  findLms,
  findUvx,
  installLocalMlx,
  localMlxStatus,
  missingLmsMessage,
} = await import("../src/local-mlx.mjs");

function fetchModels(ids) {
  return async (url) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/models");
    return {
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    };
  };
}

test("install downloads only the nested 4-bit weights, loads, verifies, then publishes", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  };
  const modelDir = path.join(stateDir, "model-success");
  const result = await installLocalMlx({
    yes: true,
    lmsPath: "/fake/lms",
    uvxPath: "/fake/uvx",
    modelDir,
    downloadReady: () => true,
    run,
    fetchImpl: fetchModels([LOCAL_MLX_ID]),
    probeAttempts: 1,
  });

  assert.deepEqual(calls[0], {
    command: "/fake/lms",
    args: ["daemon", "up", "--json"],
  });
  assert.deepEqual(calls[1], {
    command: "/fake/uvx",
    args: [
      "--from",
      "huggingface-hub",
      "hf",
      "download",
      "orcarouter/Qwen3.8-27B-Uncensored-MLX",
      "--include",
      MLX_INCLUDE,
      "--local-dir",
      modelDir,
    ],
  });
  assert.deepEqual(calls[2], {
    command: "/fake/lms",
    args: [
      "load",
      path.join(modelDir, "4-bit"),
      "--identifier",
      LOCAL_MLX_ID,
      "--context-length",
      String(LOCAL_MLX_CONTEXT),
      "--gpu",
      "max",
      "-y",
    ],
  });
  assert.deepEqual(calls[3], {
    command: "/fake/lms",
    args: ["server", "start", "--port", "1234", "--bind", "127.0.0.1"],
  });
  assert.match(calls[4].command, /bin[/\\]control$/);
  assert.deepEqual(calls[4].args, ["local-models", "lmstudio-set", LOCAL_MLX_ID, "on"]);
  assert.equal(result.slug, `lmstudio/${LOCAL_MLX_ID}`);
  assert.equal(result.modelKey, path.join(modelDir, "4-bit"));
});

test("a custom Hugging Face URL becomes the hf repository argument without credentials", async () => {
  const calls = [];
  await installLocalMlx({
    reference: "https://huggingface.co/example/private-model",
    yes: true,
    lmsPath: "/fake/lms",
    uvxPath: "/fake/uvx",
    modelDir: path.join(stateDir, "custom-model"),
    downloadReady: () => true,
    run: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchImpl: fetchModels([LOCAL_MLX_ID]),
    probeAttempts: 1,
  });
  const download = calls.find((call) => call.command === "/fake/uvx");
  assert.equal(download.args[4], "example/private-model");
  assert.ok(!download.args.some((arg) => /token/i.test(arg)));
});

test("publication is fail-closed when the stable API id is absent", async () => {
  const calls = [];
  await assert.rejects(
    installLocalMlx({
      reference: DEFAULT_MLX_URL,
      yes: true,
      lmsPath: "/fake/lms",
      uvxPath: "/fake/uvx",
      modelDir: path.join(stateDir, "wrong-id"),
      downloadReady: () => true,
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
      fetchImpl: fetchModels(["some-other-id"]),
      sleep: async () => {},
      probeAttempts: 2,
    }),
    /does not serve the required id/,
  );
  assert.ok(!calls.some((call) => /bin[/\\]control$/.test(call.command)));
});

test("a failed or empty gated download cannot reach load or publication", async () => {
  const failedCalls = [];
  await assert.rejects(
    installLocalMlx({
      yes: true,
      lmsPath: "/fake/lms",
      uvxPath: "/fake/uvx",
      modelDir: path.join(stateDir, "gated"),
      run: async (command, args) => {
        failedCalls.push({ command, args });
        return command === "/fake/uvx"
          ? { code: 1, stdout: "", stderr: "auth needed" }
          : { code: 0, stdout: "", stderr: "" };
      },
    }),
    /official Hugging Face CLI used by this command/,
  );
  assert.equal(failedCalls.length, 2);

  const emptyCalls = [];
  await assert.rejects(
    installLocalMlx({
      yes: true,
      lmsPath: "/fake/lms",
      uvxPath: "/fake/uvx",
      modelDir: path.join(stateDir, "empty"),
      downloadReady: () => false,
      run: async (command, args) => {
        emptyCalls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    /without a usable 4-bit model directory/,
  );
  assert.equal(emptyCalls.length, 2);
});

test("download failures direct authentication to Hugging Face CLI, not LM Studio", async () => {
  let error;
  try {
    await installLocalMlx({
      yes: true,
      lmsPath: "/fake/lms",
      uvxPath: "/fake/uvx",
      modelDir: path.join(stateDir, "auth-guidance"),
      run: async (command) =>
        command === "/fake/uvx"
          ? { code: 1, stdout: "", stderr: "gated" }
          : { code: 0, stdout: "", stderr: "" },
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error?.message || "", /official Hugging Face CLI used by this command/);
  assert.doesNotMatch(error?.message || "", /authenticate.*LM Studio/i);
});

test("a nonzero server start is idempotent when the configured loopback is reachable", async () => {
  const calls = [];
  const result = await installLocalMlx({
    yes: true,
    lmsPath: "/fake/lms",
    uvxPath: "/fake/uvx",
    modelDir: path.join(stateDir, "server-already-running"),
    downloadReady: () => true,
    run: async (command, args) => {
      calls.push({ command, args });
      return args[0] === "server"
        ? { code: 1, stdout: "", stderr: "already running" }
        : { code: 0, stdout: "", stderr: "" };
    },
    fetchImpl: fetchModels([LOCAL_MLX_ID]),
    probeAttempts: 1,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => /bin[/\\]control$/.test(call.command)));
});

test("a nonzero server start fails closed when loopback is unreachable", async () => {
  const calls = [];
  await assert.rejects(
    installLocalMlx({
      yes: true,
      lmsPath: "/fake/lms",
      uvxPath: "/fake/uvx",
      modelDir: path.join(stateDir, "server-start-failed"),
      downloadReady: () => true,
      run: async (command, args) => {
        calls.push({ command, args });
        return args[0] === "server"
          ? { code: 1, stdout: "", stderr: "failed" }
          : { code: 0, stdout: "", stderr: "" };
      },
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      probeAttempts: 1,
    }),
    /Starting the LM Studio server failed \(exit 1\)/,
  );
  assert.ok(!calls.some((call) => /bin[/\\]control$/.test(call.command)));
});

test("install requires explicit consent and both official CLIs", async () => {
  await assert.rejects(installLocalMlx({ lmsPath: "/fake/lms", uvxPath: "/fake/uvx" }), /--yes/);
  await assert.rejects(installLocalMlx({ yes: true, lmsPath: null, uvxPath: "/fake/uvx" }), /llmster/);
  await assert.rejects(installLocalMlx({ yes: true, lmsPath: "/fake/lms", uvxPath: null }), /uvx/);
  assert.match(missingLmsMessage(), /does not download or execute that installer/);
});

test("CLI discovery checks PATH and standard per-user locations", () => {
  const home = path.join(path.sep, "fake-home");
  const executable = path.join(home, ".lmstudio", "bin", "lms");
  const uvx = path.join(home, ".local", "bin", "uvx");
  const accessSyncImpl = (candidate) => {
    if (candidate !== executable && candidate !== uvx) throw new Error("missing");
  };
  assert.equal(findLms({ home, env: { PATH: "" }, platform: "linux", accessSyncImpl }), executable);
  assert.equal(findUvx({ home, env: { PATH: "" }, platform: "linux", accessSyncImpl }), uvx);
});

test("status is read-only and reports CLI, loopback, served, and publication state", async () => {
  const status = await localMlxStatus({
    lmsPath: "/fake/lms",
    uvxPath: "/fake/uvx",
    fetchImpl: fetchModels([LOCAL_MLX_ID]),
    published: true,
  });
  assert.deepEqual(
    {
      lmsAvailable: status.lmsAvailable,
      uvxAvailable: status.uvxAvailable,
      loopbackReachable: status.loopbackReachable,
      served: status.served,
      published: status.published,
    },
    {
      lmsAvailable: true,
      uvxAvailable: true,
      loopbackReachable: true,
      served: true,
      published: true,
    },
  );
});

test("the target dispatcher and packaged help expose local-mlx", () => {
  const modelRouter = readFileSync(path.resolve("bin/model-router"), "utf8");
  const packaged = readFileSync(path.resolve("bin/codex-router"), "utf8");
  assert.match(modelRouter, /local-mlx/);
  assert.match(packaged, /local-mlx/);
});
