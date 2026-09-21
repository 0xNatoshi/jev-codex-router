import { existsSync, writeFileSync } from "node:fs";

import {
  ensureFreshAntigravitySession,
  setAntigravityTokenPathForTests,
} from "../../src/antigravity-oauth-session.mjs";

const [tokenPath, mode, startedPath, releasePath, invokedPath, fetchPath] =
  process.argv.slice(2);

async function waitForFile(target, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target}`);
}

setAntigravityTokenPathForTests(tokenPath);
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";

try {
  const controller = new AbortController();
  const operation = ensureFreshAntigravitySession({
    force: true,
    signal: controller.signal,
    now: () => 1_999_999_999_000,
    ...(mode === "predispatch-valid"
      ? {
        _beforeRefreshDispatch: async () => {
          writeFileSync(startedPath, "ready");
          await waitForFile(releasePath, 60_000);
        },
      }
      : {}),
    ...(mode === "commit-paused-valid"
      ? {
        _beforeRefreshCommit: async () => {
          writeFileSync(startedPath, "ready");
          await waitForFile(releasePath, 60_000);
        },
      }
      : {}),
    fetchImpl: async () => {
      writeFileSync(fetchPath, mode);
      if (mode === "valid") {
        writeFileSync(startedPath, "ready");
        await waitForFile(releasePath);
      }
      if (["valid", "predispatch-valid", "commit-paused-valid"].includes(mode)) {
        return new Response(JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  writeFileSync(invokedPath, "invoked");
  const session = await operation;
  process.stdout.write(`${JSON.stringify({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  })}\n`);
} catch (error) {
  console.error(error instanceof Error ? `${error.code || "error"}: ${error.message}` : String(error));
  process.exitCode = 1;
} finally {
  setAntigravityTokenPathForTests(undefined);
}
