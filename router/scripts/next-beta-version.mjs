import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function nextBetaVersion(value) {
  const match = VERSION.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `Cannot automatically advance ${JSON.stringify(value)}; expected X.Y.Z or X.Y.Z-beta.N.`,
    );
  }

  const [, major, minor, patch, beta] = match;
  if (beta !== undefined) {
    return `${major}.${minor}.${patch}-beta.${Number(beta) + 1}`;
  }
  return `${major}.${minor}.${Number(patch) + 1}-beta.1`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const current = process.argv[2];
  if (!current) {
    process.stderr.write("Usage: next-beta-version.mjs <current-version>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${nextBetaVersion(current)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
