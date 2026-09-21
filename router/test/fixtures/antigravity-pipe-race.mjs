import { randomUUID } from "node:crypto";

import { startAntigravityOwnerServerForTests } from "../../src/antigravity-oauth-session.mjs";

const endpoint = `\\\\.\\pipe\\codex-router-antigravity-race-${randomUUID()}`;
process.env.NODE_PENDING_PIPE_INSTANCES = "32";

const owner = await startAntigravityOwnerServerForTests(endpoint);
owner.ref();
try {
  await (async () => {
    try {
      await startAntigravityOwnerServerForTests(endpoint);
      throw new Error("the losing named-pipe bind unexpectedly acquired ownership");
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  })();
  if (process.env.NODE_PENDING_PIPE_INSTANCES !== "32") {
    throw new Error("the named-pipe guard did not restore the inherited environment");
  }
  // nodejs/node#65057 crashes while the failed server handle is closed after
  // delivering EADDRINUSE, so surviving the error callback alone is not proof.
  await new Promise((resolve) => setTimeout(resolve, 750));
  process.stdout.write("survived\n");
} finally {
  await new Promise((resolve) => owner.close(resolve));
}
