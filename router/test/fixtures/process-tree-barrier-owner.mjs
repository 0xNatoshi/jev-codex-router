import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runProcessTree,
  runDuringOwnerSignalCleanup,
  withOwnerSignalExitBarrier,
} from "../../src/process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const depth = Number.parseInt(process.argv[2], 10);
const mode = process.argv[3];
const readyPath = path.resolve(process.argv[4]);
const completedPath = path.resolve(process.argv[5]);
const rollbackMs = Number.parseInt(process.argv[6], 10);
const barrierMs = Number.parseInt(process.argv[7], 10);

if (
  !Number.isSafeInteger(depth)
  || depth < 0
  || depth > 8
  || !["complete", "stuck"].includes(mode)
  || !Number.isSafeInteger(rollbackMs)
  || rollbackMs < 0
  || !Number.isSafeInteger(barrierMs)
  || barrierMs <= 0
) throw new Error("A valid process-tree barrier fixture configuration is required.");

if (depth > 0) {
  await runProcessTree(process.execPath, [
    SELF,
    String(depth - 1),
    mode,
    readyPath,
    completedPath,
    String(rollbackMs),
    String(barrierMs),
  ], {
    childMayOwnProcessTrees: true,
    deadline: Date.now() + 10_000,
    env: { ...process.env, CODEX_ROUTER_OPERATION_CHILD: "1" },
  });
  process.exit(0);
}

await withOwnerSignalExitBarrier(async (ownerSignal) => {
  writeFileSync(readyPath, String(process.pid));
  await new Promise((resolve) => {
    const hold = setInterval(() => {}, 1_000);
    const finish = () => {
      clearInterval(hold);
      resolve();
    };
    ownerSignal.addEventListener("abort", finish, { once: true });
    if (ownerSignal.aborted) finish();
  });
  await runDuringOwnerSignalCleanup(async () => {
    if (mode === "stuck") await new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, rollbackMs));
    writeFileSync(completedPath, "restored");
  });
}, { timeoutMs: barrierMs });
