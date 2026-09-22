import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

// macOS supervises the tray through launchd and Windows through Task
// Scheduler. Linux is launched directly by bin/model-router-tray: its normal
// Electron tray/window works, but there is no portable graphical-session
// supervisor contract to mutate here.
const SUPERVISORS = {
  darwin: "tray-service-macos.mjs",
  win32: "tray-service-windows.mjs",
};

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;

const command = process.argv[2] || "status";

const supervisor = SUPERVISORS[platform];
if (!supervisor) {
  const why =
    `Tray supervision is unavailable on ${platform}; ` +
    "launch or rebuild the Control Center with ./bin/model-router-tray.";
  // Status remains a successful machine-readable capability probe. A
  // mutation is different: exit non-zero so CLI and Electron callers cannot
  // turn an unsupported enable/disable/restart into a false success toast.
  if (command !== "status") {
    process.stderr.write(`${why}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({ installed: false, supported: false, state: "unsupported", why })}\n`,
  );
  process.exit(command === "status" ? 0 : 1);
}

const result = spawnSync(
  process.execPath,
  [path.join(SOURCE_ROOT, "src", supervisor), ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
