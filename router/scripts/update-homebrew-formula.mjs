// Points the Homebrew formula at a released tarball. The release workflow runs
// this against a checkout of the tap repository, so the version a formula pins
// comes from the tag that was actually published rather than from a hand edit.
//
// Kept deliberately strict: every anchor it rewrites is asserted first, so a
// formula that has been restructured fails loudly instead of being published
// unchanged with a stale checksum -- the one failure mode that produces a
// formula which installs the wrong code and still verifies.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "duolahypercho/codex-router";

// The release workflow builds `codex-router-<version>.tar.gz` with `git archive`
// and uploads it to the tag's release; this has to name the same asset.
export function releaseUrl(version, repository = REPOSITORY) {
  return `https://github.com/${repository}/releases/download/v${version}/codex-router-${version}.tar.gz`;
}

// npm's own range, minus the build-metadata form, which npm allows and a
// Homebrew version string does not survive intact.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function updateFormula(source, { version, sha256, repository = REPOSITORY }) {
  if (!VERSION.test(version)) {
    throw new Error(`Not a release version: ${version}`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Not a sha256 digest: ${sha256}`);
  }
  const urlPattern = /^(\s*)url "[^"]*"$/m;
  const shaPattern = /^(\s*)sha256 "[^"]*"$/m;
  if (!urlPattern.test(source)) throw new Error("The formula has no url line to update.");
  if (!shaPattern.test(source)) throw new Error("The formula has no sha256 line to update.");
  return source
    .replace(urlPattern, `$1url "${releaseUrl(version, repository)}"`)
    .replace(shaPattern, `$1sha256 "${sha256}"`);
}

// The release job has SHA256SUMS in hand already, so the digest is read from the
// file the release publishes rather than recomputed from a second download.
export function digestFor(sums, version) {
  const asset = `codex-router-${version}.tar.gz`;
  for (const line of String(sums).split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (match && path.basename(match[2]) === asset) return match[1];
  }
  throw new Error(`SHA256SUMS has no entry for ${asset}`);
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function main(args) {
  const version = option(args, "version")?.replace(/^v/, "");
  const formula = option(args, "formula");
  const sums = option(args, "sums");
  let sha256 = option(args, "sha256");
  if (!version || !formula || (!sha256 && !sums)) {
    console.error(
      "Usage: update-homebrew-formula.mjs --version <version> --formula <path> " +
        "(--sha256 <digest> | --sums <SHA256SUMS path>) [--repository owner/name]",
    );
    return 2;
  }
  if (!sha256) sha256 = digestFor(readFileSync(sums, "utf8"), version);
  const before = readFileSync(formula, "utf8");
  const after = updateFormula(before, {
    version,
    sha256,
    repository: option(args, "repository") || REPOSITORY,
  });
  writeFileSync(formula, after);
  // Reported so the workflow log shows whether a re-run changed anything; the
  // rewrite is idempotent, and a no-op on a retag is not an error.
  process.stdout.write(
    `${after === before ? "unchanged" : "updated"} ${formula} -> ${version} ${sha256}\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
