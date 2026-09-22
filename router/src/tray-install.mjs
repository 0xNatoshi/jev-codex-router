import path from "node:path";

// Pure decision helpers for offering the desktop/menu-bar companion during
// guided setup. Kept free of process state so the flag/platform matrix is
// unit-testable; setup.mjs owns the actual build and launch.

const TRAY_PLATFORMS = new Set(["darwin", "linux", "win32"]);

export function trayDecision({ platform, withTray, noTray, guided, packageManager }) {
  if (noTray) return "skip";
  // Package-manager installs must stay inside the files their package manager
  // owns. The desktop companions are built from separate Swift/Electron trees,
  // so offering that build here would either mutate a Homebrew keg or download
  // an Electron toolchain during first-run setup. The source installer remains
  // the supported all-in-one desktop path.
  if (packageManager === "homebrew") return "skip";
  // Windows was excluded here while it had no tray build, which left the
  // installer silently skipping the one platform whose tray has to be built by
  // hand -- so nothing ever appeared and nothing said why.
  if (!TRAY_PLATFORMS.has(platform)) return "skip";
  if (withTray) return "install";
  return guided ? "ask" : "skip";
}

export function traySetupError({ packageManager, withTray, noTray }) {
  if (packageManager !== "homebrew" || !withTray || noTray) return undefined;
  return (
    "--with-tray is unavailable for Homebrew installations. Homebrew installs " +
    "the router and CLI only; use the recommended curl installer in the README " +
    "for the Electron Control Center, tray/menu-bar app, and macOS desktop widget."
  );
}

// Legacy Tauri release path retained only to recognize and migrate older
// installations. New installs never build or launch this binary.
export function desktopTrayBinary(platform, sourceRoot) {
  if (platform !== "win32" && platform !== "linux") return undefined;
  return path.join(
    sourceRoot,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    "release",
    platform === "win32" ? "codex-router-desktop.exe" : "codex-router-desktop",
  );
}

// Windows and Linux ship the full Control Center as the one desktop
// companion. It owns both the native Electron tray and the normal application
// window, so installers and supervisors must point at this packaged executable
// rather than at either of the older tray-only shells.
export function controlCenterBinary(platform, sourceRoot) {
  if (platform === "win32") {
    return path.join(
      sourceRoot,
      "apps",
      "control-center",
      "release",
      "win-unpacked",
      "Codex Router.exe",
    );
  }
  if (platform === "linux") {
    return path.join(
      sourceRoot,
      "apps",
      "control-center",
      "release",
      "linux-unpacked",
      "codex-router-control-center",
    );
  }
  return undefined;
}

export function controlCenterLaunch(platform, sourceRoot, { trayOnly = true } = {}) {
  const execute = controlCenterBinary(platform, sourceRoot);
  if (!execute) return undefined;
  return { execute, argument: trayOnly ? "--tray-only" : "" };
}

// Updates may run from a development/repair checkout while Task Scheduler
// still points at the stable installed checkout. Recognize that registered
// action by its exact canonical shape so it can drain mutations gracefully;
// do not require it to equal this process's checkout path.
export function isRecognizedControlCenterAction(action) {
  if (typeof action?.execute !== "string" || !action.execute.trim()) return false;
  if (String(action.argument || "").trim() !== "--tray-only") return false;
  const normalized = path.win32.normalize(action.execute.trim()).toLowerCase();
  const suffix = path.win32.join(
    "apps",
    "control-center",
    "release",
    "win-unpacked",
    "Codex Router.exe",
  ).toLowerCase();
  return path.win32.isAbsolute(normalized) && normalized.endsWith(`\\${suffix}`);
}

// Legacy tray-only Electron paths retained only to recognize and migrate older
// installations. The packaged Control Center above is the sole live shell.
export function electronAppDir(sourceRoot) {
  return path.join(sourceRoot, "apps", "electron");
}

// Legacy npm layout retained only for exact migration detection. The old shell
// ran Electron's downloaded runtime directly and therefore has no separate
// compiled executable to identify.
export function electronBinary(platform, sourceRoot) {
  if (platform !== "win32" && platform !== "linux") return undefined;
  return path.join(
    electronAppDir(sourceRoot),
    "node_modules",
    "electron",
    "dist",
    platform === "win32" ? "electron.exe" : "electron",
  );
}

// Presence of the downloaded runtime distinguishes a complete legacy action
// from a stale app-directory argument that never could have launched.
export function electronInstallIsComplete(platform, sourceRoot, exists) {
  const binary = electronBinary(platform, sourceRoot);
  return Boolean(binary) && exists(binary);
}

// The legacy Electron runtime needed an app-directory argument. Keep that
// shape available for migration tests, never for automatic selection.
export function electronLaunch(platform, sourceRoot) {
  const execute = electronBinary(platform, sourceRoot);
  if (!execute) return undefined;
  return { execute, argument: `"${electronAppDir(sourceRoot)}"` };
}

// Exact executable/argument identities retained for migration only. Installers
// use these pairs to drain a repository-known older shell before the unified
// Control Center takes ownership. An upgraded checkout may still carry the old
// downloaded Electron runtime for rollback, so only the superseded standalone
// Tauri executable may be deleted after replacement readiness is published.
export function legacyCompanionActions(platform, sourceRoot) {
  const tauri = desktopTrayBinary(platform, sourceRoot);
  const electron = electronBinary(platform, sourceRoot);
  if (!tauri || !electron) return [];
  return [
    { kind: "tauri", execute: tauri, argument: "" },
    { kind: "electron", execute: electron, argument: electronAppDir(sourceRoot) },
  ];
}

// Task Scheduler can still point at a legacy action in a different stable
// checkout than the command performing the update. Resolve only the two exact
// repository layouts and, for Electron, require its sole app-directory argv to
// belong to that same checkout.
export function recognizedLegacyCompanionAction(action) {
  if (typeof action?.execute !== "string" || !action.execute.trim()) return undefined;
  const execute = path.win32.normalize(action.execute.trim());
  const argument = String(action.argument || "").trim();
  const tauriSuffix = path.win32.join(
    "apps", "desktop", "src-tauri", "target", "release", "codex-router-desktop.exe",
  );
  if (
    execute.toLowerCase().endsWith(`\\${tauriSuffix.toLowerCase()}`)
    && argument === ""
  ) return { kind: "tauri", execute, argument: "" };

  const electronSuffix = path.win32.join(
    "apps", "electron", "node_modules", "electron", "dist", "electron.exe",
  );
  if (!execute.toLowerCase().endsWith(`\\${electronSuffix.toLowerCase()}`)) return undefined;
  const root = execute.slice(0, -(electronSuffix.length + 1));
  const expectedApp = path.win32.join(root, "apps", "electron");
  const unquoted = argument.startsWith('"') && argument.endsWith('"')
    ? argument.slice(1, -1)
    : argument;
  if (path.win32.normalize(unquoted).toLowerCase() !== expectedApp.toLowerCase()) return undefined;
  return { kind: "electron", execute, argument: expectedApp };
}

// Which companion a machine will run. This deliberately has no legacy
// fallback: automatic selection between multiple shells is what produced
// duplicate apps and inconsistent tray/window behavior.
export function preferredCompanionBinary(platform, sourceRoot, exists) {
  const controlCenter = controlCenterBinary(platform, sourceRoot);
  if (controlCenter && exists(controlCenter)) return controlCenter;
  // Returning the canonical path even before it is built keeps status and
  // remediation guidance deterministic. Legacy binaries are migration
  // evidence only and must never be selected automatically again.
  return controlCenter;
}

export function trayBundleDir(platform, home) {
  if (platform !== "darwin") return undefined;
  // Always a macOS path, so use POSIX joins — path.join would emit backslashes
  // when this code runs on a Windows host (e.g. CI), producing a wrong bundle
  // path and breaking the test cross-platform.
  return path.posix.join(home, "Applications", "Codex Router.app");
}
