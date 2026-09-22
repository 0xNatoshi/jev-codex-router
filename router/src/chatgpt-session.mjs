import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  nativeSessionStatus,
  setNativeSessionSharingEnabled,
} from "./codex-native-session.mjs";
import { refreshTargetPickerIfInstalled } from "./target-integration.mjs";

function usage() {
  return "Usage: chatgpt-session enable|disable|status [--json]";
}

function safeStatus() {
  const status = nativeSessionStatus();
  return {
    sharing: status.sharingEnabled ? "enabled" : "disabled",
    session: status.usable ? "usable" : status.expired ? "expired" : "unavailable",
    present: status.present,
    expiresInHours: status.expiresInHours,
  };
}

export async function setChatGptSessionSharing(enabled) {
  setNativeSessionSharingEnabled(enabled);
  const refreshed = await refreshTargetPickerIfInstalled();
  return { ...safeStatus(), refreshed };
}

function printStatus(status, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (status.sharing === "enabled") {
    if (status.session !== "usable") {
      process.stdout.write(
        "ChatGPT session sharing is authorized, but no usable Codex login is available. Native GPT models are withheld from other local clients until you run `codex login`.\n",
      );
      return;
    }
    const expiry = status.expiresInHours === undefined
      ? ""
      : ` (session valid for about ${status.expiresInHours}h)`;
    process.stdout.write(
      `ChatGPT session sharing is enabled for this user's local Codex Router clients${expiry}.\n`,
    );
  } else {
    process.stdout.write(
      "ChatGPT session sharing is disabled. Native GPT models stay available to Codex itself, but are not exposed to other local clients.\n",
    );
  }
}

export async function runChatGptSessionCommand(args = process.argv.slice(2)) {
  const command = args[0] || "status";
  const json = args.includes("--json");
  const extras = args.slice(1).filter((argument) => argument !== "--json");
  if (!["enable", "disable", "status"].includes(command) || extras.length > 0) {
    throw Object.assign(new Error(usage()), { exitCode: 2 });
  }
  if (command === "status") {
    const status = safeStatus();
    printStatus(status, { json });
    return status;
  }
  const status = await setChatGptSessionSharing(command === "enable");
  printStatus(status, { json });
  if (!json && status.refreshed) {
    process.stdout.write("Installed client model catalogs were refreshed.\n");
  }
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runChatGptSessionCommand();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error?.exitCode || 1);
  }
}
