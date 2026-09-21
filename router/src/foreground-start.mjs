import { withServiceOperationLock } from "./service-operation-lock.mjs";

try {
  // Importing start.mjs does not resolve until its top-level supervisor finishes,
  // so lifecycle ownership covers preflight, child startup, serving, and drain.
  await withServiceOperationLock(() => import("./start.mjs"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
