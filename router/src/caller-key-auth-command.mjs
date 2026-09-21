import { readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";

const secretPath = process.argv[2];
if (!secretPath) {
  process.stderr.write("Caller key path is required.\n");
  process.exit(2);
}

try {
  const secret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
  process.stdout.write(secret);
} catch {
  process.stderr.write("The local router caller key is unavailable.\n");
  process.exit(1);
}
