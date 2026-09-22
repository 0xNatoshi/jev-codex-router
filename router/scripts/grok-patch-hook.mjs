#!/usr/bin/env node
import { adaptHookInput, readHookInput } from "../src/grok-patch-hook.mjs";

try {
  const output = adaptHookInput(await readHookInput(process.stdin));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch {
  // Do not disguise runtime/input failures as a native permission refusal or
  // expose JSON.parse diagnostics containing source text.
  process.stderr.write("Structured patch hook failed to process its input.\n");
  process.exitCode = 1;
}
