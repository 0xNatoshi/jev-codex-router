import { lstat, readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const PHASES = new Set([
  "staging",
  "staged",
  "draining",
  "drained",
  "supervision-stopping",
  "supervision-stopped",
  "previous-moving",
  "previous-moved",
  "replacement-moving",
  "replacement-installed",
  "replacement-starting",
  "replacement-ready",
  "embedded-ready",
  "restoring-previous",
  "previous-restored",
  "committed",
]);
const PRE_SWAP_PHASES = new Set([
  "staging",
  "staged",
  "draining",
  "drained",
  "supervision-stopping",
  "supervision-stopped",
  "previous-moving",
]);
const REPLACEMENT_PHASES = new Set([
  "replacement-moving",
  "replacement-installed",
  "replacement-starting",
  "replacement-ready",
  "embedded-ready",
]);
const ALLOWED_ENTRIES = new Set([
  "phase",
  "phase.next",
  "had-previous",
  "target-name",
  "artifact-set",
  "staged",
  "previous",
  "failed",
]);

function refusal(message) {
  return new Error(`refusing ambiguous macOS Codex Router transaction: ${message}`);
}

async function statOrNull(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireOwner(stats, uid, label) {
  if (!Number.isInteger(uid) || stats.uid !== uid) {
    throw refusal(`${label} is not owned by the current user`);
  }
}

function requireDirectory(stats, uid, label, { privateRoot = false } = {}) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw refusal(`${label} is not a real directory`);
  }
  requireOwner(stats, uid, label);
  const permissions = stats.mode & 0o777;
  if (privateRoot ? permissions !== 0o700 : (permissions & 0o022) !== 0) {
    throw refusal(`${label} has unsafe permissions ${permissions.toString(8)}`);
  }
}

function requireNonemptyRegularFile(stats, uid, label, { executable = false } = {}) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw refusal(`${label} is not a regular file`);
  }
  requireOwner(stats, uid, label);
  const permissions = stats.mode & 0o777;
  if ((permissions & 0o022) !== 0) {
    throw refusal(`${label} has unsafe permissions ${permissions.toString(8)}`);
  }
  if (executable && (permissions & 0o100) === 0) {
    throw refusal(`${label} is not executable by its owner`);
  }
  if (stats.size < 1) throw refusal(`${label} is empty`);
}

async function readJournalValue(candidate, uid, label, allowed) {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw refusal(`${label} is not a regular file`);
  }
  requireOwner(stats, uid, label);
  if ((stats.mode & 0o777) !== 0o600 || stats.size < 2 || stats.size > 128) {
    throw refusal(`${label} has an unsafe mode or size`);
  }
  const value = await readFile(candidate, "utf8");
  if (!/^\S+\n$/.test(value)) throw refusal(`${label} is not one complete line`);
  const trimmed = value.slice(0, -1);
  if (!allowed.has(trimmed)) throw refusal(`${label} contains an unknown value`);
  return trimmed;
}

export async function inspectMacosTrayTransaction(
  transactionDirectory,
  { uid = process.getuid?.() } = {},
) {
  const transactionStats = await statOrNull(transactionDirectory);
  if (!transactionStats) return null;
  requireDirectory(transactionStats, uid, "transaction directory", { privateRoot: true });

  const names = await readdir(transactionDirectory);
  for (const name of names) {
    if (!ALLOWED_ENTRIES.has(name)) throw refusal(`unexpected entry ${name}`);
  }

  const entries = Object.fromEntries(await Promise.all(
    [
      "staged",
      "previous",
      "failed",
      "phase",
      "phase.next",
      "had-previous",
      "target-name",
      "artifact-set",
    ].map(
      async (name) => [name, await statOrNull(path.join(transactionDirectory, name))],
    ),
  ));
  for (const name of ["staged", "previous", "failed"]) {
    if (entries[name]) requireDirectory(entries[name], uid, name);
  }

  const phase = entries.phase
    ? await readJournalValue(path.join(transactionDirectory, "phase"), uid, "phase", PHASES)
    : null;
  const nextPhase = entries["phase.next"]
    ? await readJournalValue(path.join(transactionDirectory, "phase.next"), uid, "phase.next", PHASES)
    : null;
  const effectivePhase = phase ?? nextPhase;
  const hadPreviousValue = entries["had-previous"]
    ? await readJournalValue(
      path.join(transactionDirectory, "had-previous"),
      uid,
      "had-previous",
      new Set(["0", "1"]),
    )
    : null;
  const targetName = entries["target-name"]
    ? await readJournalValue(
      path.join(transactionDirectory, "target-name"),
      uid,
      "target-name",
      new Set(["codex-router"]),
    )
    : null;
  const artifactSet = entries["artifact-set"]
    ? await readJournalValue(
      path.join(transactionDirectory, "artifact-set"),
      uid,
      "artifact-set",
      new Set(["widget-v1"]),
    )
    : null;
  if (effectivePhase && hadPreviousValue === null) {
    throw refusal("a phase exists without the had-previous marker");
  }

  return {
    phase: effectivePhase,
    hadPrevious: hadPreviousValue === null ? null : hadPreviousValue === "1",
    staged: Boolean(entries.staged),
    previous: Boolean(entries.previous),
    failed: Boolean(entries.failed),
    nextAction: nextPhase === null ? "none" : phase === null ? "promote" : "discard",
    targetName,
    artifactSet,
  };
}

export async function inspectMacosTrayLiveBundle(
  bundleDirectory,
  { uid = process.getuid?.() } = {},
) {
  const stats = await statOrNull(bundleDirectory);
  if (!stats) return false;
  requireDirectory(stats, uid, "live bundle");
  return true;
}

// A committed journal is the last copy of the rollback bundle. Do not remove
// it merely because the live top-level directory exists: a killed copy or an
// interrupted package assembly can leave a plausible .app whose native host,
// embedded host, or renderer archive is absent. Walk every fixed parent with
// lstat so a symlink in the middle cannot make a file outside the bundle count.
export async function inspectMacosTrayCommittedBundle(
  bundleDirectory,
  { uid = process.getuid?.(), requireWidget = true } = {},
) {
  if (!await inspectMacosTrayLiveBundle(bundleDirectory, { uid })) return false;
  const requiredDirectories = [
    "Contents",
    "Contents/MacOS",
    "Contents/Resources",
    "Contents/Resources/Control Center.app",
    "Contents/Resources/Control Center.app/Contents",
    "Contents/Resources/Control Center.app/Contents/MacOS",
    "Contents/Resources/Control Center.app/Contents/Resources",
  ];
  if (requireWidget) {
    requiredDirectories.splice(2, 0,
      "Contents/PlugIns",
      "Contents/PlugIns/RouterUsageWidget.appex",
      "Contents/PlugIns/RouterUsageWidget.appex/Contents",
      "Contents/PlugIns/RouterUsageWidget.appex/Contents/MacOS",
    );
  }
  for (const relative of requiredDirectories) {
    const stats = await statOrNull(path.join(bundleDirectory, relative));
    if (!stats) return false;
    requireDirectory(stats, uid, `live bundle ${relative}`);
  }
  const requiredFiles = [
    ["Contents/Info.plist", false],
    ["Contents/MacOS/ModelRouterTray", true],
    ["Contents/Resources/Control Center.app/Contents/MacOS/Codex Router", true],
    ["Contents/Resources/Control Center.app/Contents/Resources/app.asar", false],
  ];
  if (requireWidget) {
    requiredFiles.splice(2, 0,
      ["Contents/PlugIns/RouterUsageWidget.appex/Contents/Info.plist", false],
      [
        "Contents/PlugIns/RouterUsageWidget.appex/Contents/MacOS/RouterUsageWidget",
        true,
      ],
    );
  }
  for (const [relative, executable] of requiredFiles) {
    const stats = await statOrNull(path.join(bundleDirectory, relative));
    if (!stats) return false;
    requireNonemptyRegularFile(stats, uid, `live bundle ${relative}`, { executable });
  }
  return true;
}

export function planMacosTrayRecovery(
  transaction,
  { liveExists, liveComplete = false, legacyLiveExists = false },
) {
  if (!transaction) return "none";
  const { phase, hadPrevious, previous, failed } = transaction;
  if (!phase) {
    if (previous || failed) throw refusal("recovery bundles exist without a phase");
    return "discard";
  }
  if (phase === "committed") {
    if (!liveExists) throw refusal("the committed live bundle is missing");
    if (!liveComplete) throw refusal("the committed live bundle is incomplete");
    return "finalize";
  }

  if (previous) {
    if (hadPrevious !== true) throw refusal("a previous bundle contradicts had-previous=0");
    if (!liveExists) {
      if (
        !PRE_SWAP_PHASES.has(phase)
        && phase !== "previous-moved"
        && phase !== "restoring-previous"
        && !REPLACEMENT_PHASES.has(phase)
      ) {
        throw refusal(`the previous bundle is impossible in phase ${phase}`);
      }
      return "restore-previous";
    }
    if (!REPLACEMENT_PHASES.has(phase)) {
      throw refusal(`both previous and live bundles exist in phase ${phase}`);
    }
    if (failed) throw refusal("three bundle candidates exist");
    return "replace-live-with-previous";
  }

  if (hadPrevious === true) {
    if (liveExists && (phase === "restoring-previous" || phase === "previous-restored")) {
      return "finish-restored";
    }
    if (failed && liveExists) return "finish-restored";
    if (failed || (!liveExists && !legacyLiveExists)) {
      throw refusal("the previous bundle backup is missing");
    }
    if (phase === "staging" || phase === "staged") return "keep-live-intact";
    if (PRE_SWAP_PHASES.has(phase)) return "keep-live";
    throw refusal(`the previous bundle backup is missing in phase ${phase}`);
  }

  if (hadPrevious !== false) throw refusal("had-previous is missing");
  if (failed) {
    if (liveExists) throw refusal("a failed replacement and an unexpected live bundle both exist");
    return "finish-removed";
  }
  if (liveExists) {
    if (REPLACEMENT_PHASES.has(phase)) return "remove-live";
    throw refusal(`an unexpected live bundle exists in phase ${phase}`);
  }
  return "discard";
}

async function main() {
  if (process.argv[2] === "validate-legacy-bundle" && process.argv.length === 4) {
    if (!await inspectMacosTrayCommittedBundle(process.argv[3], { requireWidget: false })) {
      throw refusal("the legacy candidate bundle is incomplete");
    }
    process.stdout.write("complete\n");
    return;
  }
  if (process.argv[2] === "validate-bundle" && process.argv.length === 4) {
    if (!await inspectMacosTrayCommittedBundle(process.argv[3])) {
      throw refusal("the candidate bundle is incomplete");
    }
    process.stdout.write("complete\n");
    return;
  }
  if (
    process.argv[2] !== "plan"
    || ![5, 6].includes(process.argv.length)
  ) {
    process.stderr.write(
      "Usage: node src/macos-tray-transaction.mjs plan TRANSACTION_DIR LIVE_BUNDLE [LEGACY_LIVE_BUNDLE]\n"
      + "   or: node src/macos-tray-transaction.mjs validate-bundle BUNDLE\n"
      + "   or: node src/macos-tray-transaction.mjs validate-legacy-bundle BUNDLE\n",
    );
    process.exitCode = 2;
    return;
  }
  const transaction = await inspectMacosTrayTransaction(process.argv[3]);
  if (!transaction) {
    process.stdout.write("none none\n");
    return;
  }
  const liveExists = await inspectMacosTrayLiveBundle(process.argv[4]);
  const liveComplete = transaction.phase === "committed"
    ? await inspectMacosTrayCommittedBundle(process.argv[4], {
      requireWidget: transaction.artifactSet === "widget-v1",
    })
    : false;
  const legacyLiveExists = process.argv[5]
    ? await inspectMacosTrayCommittedBundle(process.argv[5], { requireWidget: false })
    : false;
  const action = planMacosTrayRecovery(transaction, {
    liveExists,
    liveComplete,
    legacyLiveExists,
  });
  process.stdout.write(`${action} ${transaction.nextAction}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
