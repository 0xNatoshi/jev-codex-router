import { existsSync, writeFileSync } from "node:fs";

import { ensureAntigravityProject } from "../../src/antigravity-project.mjs";
import {
  readAntigravityToken,
  setAntigravityTokenPathForTests,
} from "../../src/antigravity-oauth-session.mjs";

const [tokenPath, startedPath, releasePath] = process.argv.slice(2);

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
  await ensureAntigravityProject(readAntigravityToken(), {
    attempts: 1,
    now: () => 20_000,
    fetchImpl: async () => {
      writeFileSync(startedPath, "ready");
      await waitForFile(releasePath);
      return new Response(JSON.stringify({
        cloudaicompanionProject: "stale-project",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  process.stdout.write(`${JSON.stringify({ code: "unexpected_success" })}\n`);
  process.exitCode = 1;
} catch (error) {
  if (error?.code !== "project_context_changed") {
    console.error(error instanceof Error ? `${error.code || "error"}: ${error.message}` : String(error));
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ code: error.code })}\n`);
  }
} finally {
  setAntigravityTokenPathForTests(undefined);
}
