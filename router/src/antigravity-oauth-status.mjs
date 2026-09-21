import { lstatSync } from "node:fs";

import { privateFileIsProtected } from "./file-security.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  antigravityProbeActivationState,
  antigravityProbeIsVerified,
  antigravityProbeStartupState,
  antigravityRefreshJournalStatus,
  antigravityTokenFileIsRegular,
  antigravityTokenPath,
  antigravityTokenPathEntryExists,
  protectAntigravityToken,
  readAntigravityOAuthClient,
  readAntigravityRecordForStatus,
  validateAntigravityToken,
} from "./antigravity-oauth-session.mjs";
import { routerServiceRestartCommand } from "./router-restart.mjs";

let permissionCache;

function unsafeCredentialRecovery(target) {
  try {
    const metadata = lstatSync(target);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      return {
        detail: "Antigravity credential path is a directory, not a credential file",
        instruction:
          `Run ${disconnectCommand()} to remove it only when it is empty. ` +
          "If it is nonempty, review and remove its contents and the directory manually, then disconnect again",
      };
    }
    if (metadata.isSymbolicLink()) {
      return {
        detail: "Antigravity credential path is a symlink, not a credential file",
        instruction: `Run ${disconnectCommand()} to remove the symlink without touching its target`,
      };
    }
  } catch {}
  return {
    detail: "Antigravity credential path is a non-file record",
    instruction: `Inspect the exact path, then run ${disconnectCommand()} to remove it safely`,
  };
}

function credentialIsProtected(target) {
  if (process.platform !== "win32") return privateFileIsProtected(target);
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch {
    return false;
  }
  const fingerprint = [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mode,
    metadata.ctimeMs,
    metadata.mtimeMs,
  ].join(":");
  if (permissionCache?.target === target && permissionCache.fingerprint === fingerprint) {
    return permissionCache.protected;
  }
  const protectedCredential = privateFileIsProtected(target);
  permissionCache = { target, fingerprint, protected: protectedCredential };
  return protectedCredential;
}

function probeCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers probe antigravity-oauth --live --yes"
    : "./bin/providers probe antigravity-oauth --live --yes";
}

function loginCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers login antigravity-oauth"
    : "./bin/providers login antigravity-oauth";
}

function disconnectCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers disconnect antigravity-oauth"
    : "./bin/providers disconnect antigravity-oauth";
}

function activationSetup() {
  return `run \`${routerServiceRestartCommand()}\` to health-check and activate the pending live proof`;
}

function revokedRecord(value) {
  return (
    Number(value?.version) === 3 &&
    value?.managed_by === "codex-router" &&
    value?.access_token === "" &&
    value?.refresh_token === "" &&
    Number(value?.expires_at) === 0 &&
    Number(value?.expires_in) === 0
  );
}

function rejectedClientRecord(value) {
  return revokedRecord(value) && value?.rejection_reason === "invalid_client";
}

function uncertainRefreshRecord(value) {
  return revokedRecord(value) && value?.rejection_reason === "refresh_outcome_unknown";
}

function unresolvedRefreshStatus(tokenPath, protectedCredential) {
  return {
    configured: false,
    signedIn: false,
    verified: false,
    clientReady: true,
    refreshOutcomeUnknown: true,
    credentialPresent: true,
    tokenPath,
    source: "router-managed operator OAuth client and session",
    setup: protectedCredential
      ? `Allow an in-flight refresh to finish; if this state remains, run \`${loginCommand()}\` again`
      : "Run the doctor with --fix to restore owner-only credential permissions, then sign in again",
  };
}

export function antigravityOAuthStatus() {
  if (discoveryDisabled()) {
    return {
      configured: false,
      signedIn: false,
      verified: false,
      credentialPresent: false,
      discoveryDisabled: true,
      setup: "Provider discovery is disabled",
    };
  }
  const tokenPath = antigravityTokenPath();
  if (!antigravityTokenPathEntryExists()) {
    return {
      configured: false,
      signedIn: false,
      verified: false,
      credentialPresent: false,
      tokenPath,
      setup: `run \`${loginCommand()}\``,
    };
  }
  if (!antigravityTokenFileIsRegular()) {
    const recovery = unsafeCredentialRecovery(tokenPath);
    return {
      configured: false,
      signedIn: false,
      verified: false,
      credentialPresent: true,
      clientReady: false,
      tokenPath,
      recoveryNote: `${recovery.detail}. ${recovery.instruction}.`,
      setup: `${recovery.instruction}, then run ${loginCommand()}`,
    };
  }
  let value;
  try {
    value = readAntigravityRecordForStatus();
    const token = validateAntigravityToken(value);
    const activation = antigravityProbeActivationState(token);
    const verified = antigravityProbeIsVerified(token);
    const protectedCredential = credentialIsProtected(tokenPath);
    if (antigravityRefreshJournalStatus(token).outcomeUnknown) {
      return unresolvedRefreshStatus(tokenPath, protectedCredential);
    }
    return {
      configured: verified && protectedCredential,
      signedIn: true,
      verified,
      ...(activation.state === "pending_activation" ? { activationPending: true } : {}),
      credentialPresent: true,
      tokenPath,
      source: "router-managed operator OAuth client and session",
      projectId: token.project_id || undefined,
      ...(!protectedCredential
        ? { setup: "Run the doctor with --fix to restore owner-only credential permissions" }
        : verified
        ? { probeVerifiedAt: token.probe_verified_at, probeModel: token.probe_model }
        : {
          setup: activation.state === "pending_activation"
            ? activationSetup()
            : `Run the explicit live compatibility test: ${probeCommand()}`,
        }),
    };
  } catch {
    const reconnectRequired = rejectedClientRecord(value);
    const refreshOutcomeUnknown = uncertainRefreshRecord(value);
    let clientReady = false;
    if (!reconnectRequired) {
      try {
        readAntigravityOAuthClient();
        clientReady = true;
      } catch {
        // Preserve incompatible records for an explicit disconnect.
      }
    }
    return {
      configured: false,
      signedIn: false,
      verified: false,
      clientReady,
      ...(reconnectRequired ? { reconnectRequired: true } : {}),
      ...(refreshOutcomeUnknown ? { refreshOutcomeUnknown: true } : {}),
      credentialPresent: true,
      tokenPath,
      setup: reconnectRequired
        ? `run \`${disconnectCommand()}\`, then run \`${loginCommand()}\` with a valid operator-owned Google Desktop app client`
        : clientReady
          ? `run \`${loginCommand()}\` again`
          : `run \`${disconnectCommand()}\` to remove the incompatible router record, ` +
            `then run \`${loginCommand()}\``,
    };
  }
}

export function antigravityOAuthStartupState() {
  if (
    discoveryDisabled() ||
    !antigravityTokenPathEntryExists() ||
    !antigravityTokenFileIsRegular() ||
    !credentialIsProtected(antigravityTokenPath())
  ) {
    return { startForwarder: false };
  }
  try {
    const value = readAntigravityRecordForStatus();
    const token = validateAntigravityToken(value);
    if (antigravityRefreshJournalStatus(token).outcomeUnknown) {
      return { startForwarder: false };
    }
    return antigravityProbeStartupState(token);
  } catch {
    return { startForwarder: false };
  }
}

export function antigravityOAuthHealth() {
  if (discoveryDisabled()) {
    return {
      status: "disabled",
      detail: "provider credential discovery is disabled",
      fix: "Rerun setup without --no-discovery to use providers",
    };
  }
  const tokenPath = antigravityTokenPath();
  if (!antigravityTokenPathEntryExists()) {
    return {
      status: "missing",
      detail: "no Antigravity credential file",
      fix: `Run ${loginCommand()}`,
    };
  }
  if (!antigravityTokenFileIsRegular()) {
    const recovery = unsafeCredentialRecovery(tokenPath);
    return {
      status: "invalid",
      detail: recovery.detail,
      fix: `${recovery.instruction}, then run ${loginCommand()}`,
    };
  }
  let value;
  try {
    value = readAntigravityRecordForStatus();
  } catch {
    return {
      status: "invalid",
      detail: "Antigravity credential file is not valid JSON",
      fix: `Run ${loginCommand()} again`,
    };
  }
  if (revokedRecord(value)) {
    if (rejectedClientRecord(value)) {
      return {
        status: "revoked",
        detail: "Antigravity operator OAuth client was rejected by Google",
        fix: `Run ${disconnectCommand()}, then ${loginCommand()} with a valid operator-owned Google Desktop app client`,
      };
    }
    if (uncertainRefreshRecord(value)) {
      return {
        status: "revoked",
        detail: "Antigravity OAuth refresh outcome is unknown because no complete provider result was durably committed",
        fix: `Run ${loginCommand()} again`,
      };
    }
    return {
      status: "revoked",
      detail: "Antigravity OAuth session was rejected by Google",
      fix: `Run ${loginCommand()} again`,
    };
  }
  try {
    const token = validateAntigravityToken(value);
    if (antigravityRefreshJournalStatus(token).outcomeUnknown) {
      return {
        status: "blocked",
        detail:
          "Antigravity OAuth refresh has no durably committed provider outcome, so the credential is withheld",
        fix: `Allow an in-flight refresh to finish; if this state remains, run ${loginCommand()} again`,
      };
    }
    if (!credentialIsProtected(tokenPath)) {
      return {
        status: "insecure",
        detail: "Antigravity credential file permissions allow access beyond the current user",
        fix: "Run the doctor with --fix to restore owner-only permissions",
        projectId: token.project_id || undefined,
      };
    }
    const stale = Math.floor(Date.now() / 1_000) >= token.expires_at;
    const activation = antigravityProbeActivationState(token);
    const verified = antigravityProbeIsVerified(token);
    if (!verified) {
      if (activation.state === "pending_activation") {
        return {
          status: "pending",
          detail: "live compatibility proof is pending router health activation",
          fix: activationSetup(),
        };
      }
      return {
        status: "unverified",
        detail: "signed in with an operator-owned OAuth client; live compatibility is not verified",
        fix: `Run ${probeCommand()} (this sends a small prompt and uses provider quota)`,
      };
    }
    return {
      status: stale ? "stale" : "ok",
      detail: stale
        ? "access token expired; it refreshes automatically on the next request"
        : "credential present",
      fix: stale ? "No action needed; the session refreshes before forwarding." : undefined,
      projectId: token.project_id || undefined,
    };
  } catch {
    let clientReady = false;
    try {
      readAntigravityOAuthClient();
      clientReady = true;
    } catch {
      // The fix below must not imply that an incompatible record is reusable.
    }
    return {
      status: "incomplete",
      detail: "Antigravity credential is missing a usable token",
      fix: clientReady
        ? `Run ${loginCommand()} again`
        : `Run ${disconnectCommand()}, then ${loginCommand()}`,
    };
  }
}

export function repairAntigravityOAuthPermissions() {
  return protectAntigravityToken();
}
