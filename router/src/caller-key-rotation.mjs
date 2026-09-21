import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { protectPrivateFile } from "./file-security.mjs";

function assertOperationId(operationId) {
  const value = String(operationId || "");
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("Caller capability rotation requires a valid operation id.");
  }
  return value;
}

export function callerCapabilityBackupPath(secretPath, operationId) {
  return `${secretPath}.rotate-rollback.${assertOperationId(operationId)}`;
}

function callerCapabilityTemporaryPath(secretPath, operationId) {
  return `${secretPath}.rotate-new.${assertOperationId(operationId)}`;
}

function callerCapabilityDisplacedPath(secretPath, operationId) {
  return `${secretPath}.rotate-displaced.${assertOperationId(operationId)}`;
}

function removeIfPresent(target) {
  if (existsSync(target)) unlinkSync(target);
}

function combinedFailure(error, rollbackError) {
  if (!rollbackError) return error;
  return new Error(
    `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    { cause: error },
  );
}

export function swapCallerCapability({
  secretPath,
  operationId,
  generateSecret = () => randomBytes(48).toString("base64url"),
  protect = protectPrivateFile,
} = {}) {
  const previousSecret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
  const currentSecret = assertCallerSecret(String(generateSecret()).trim());
  if (currentSecret === previousSecret) throw new Error("Caller capability rotation generated the existing key.");

  const temporary = callerCapabilityTemporaryPath(secretPath, operationId);
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (existsSync(temporary) || existsSync(backup)) throw new Error("Caller capability rotation generation already exists; recover it before retrying.");
  writeFileSync(temporary, `${currentSecret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    protect(temporary);
  } catch (error) {
    removeIfPresent(temporary);
    throw error;
  }

  let backupPresent = false;
  let newSecretLive = false;
  try {
    renameSync(secretPath, backup);
    backupPresent = true;
    protect(backup);
    renameSync(temporary, secretPath);
    newSecretLive = true;
    protect(secretPath);
    return { previousSecret, currentSecret, backupPath: backup };
  } catch (error) {
    let rollbackError;
    try {
      if (newSecretLive) removeIfPresent(secretPath);
      if (backupPresent && existsSync(backup)) {
        renameSync(backup, secretPath);
        backupPresent = false;
        protect(secretPath);
      }
    } catch (caught) {
      rollbackError = caught;
    }
    removeIfPresent(temporary);
    throw combinedFailure(error, rollbackError);
  } finally {
    removeIfPresent(temporary);
  }
}

export function restoreCallerCapability({ secretPath, operationId, protect = protectPrivateFile } = {}) {
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (!existsSync(backup)) return { restored: false };
  const displaced = callerCapabilityDisplacedPath(secretPath, operationId);
  if (existsSync(displaced)) {
    throw new Error("Caller capability rollback has a displaced generation already; recover it before retrying.");
  }
  const displacedSecret = existsSync(secretPath)
    ? assertCallerSecret(readFileSync(secretPath, "utf8").trim())
    : undefined;
  let displacedPresent = false;
  let backupMoved = false;
  try {
    if (existsSync(secretPath)) {
      renameSync(secretPath, displaced);
      displacedPresent = true;
      protect(displaced);
    }
    renameSync(backup, secretPath);
    backupMoved = true;
    protect(secretPath);
    const currentSecret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
    if (displacedPresent) {
      unlinkSync(displaced);
      displacedPresent = false;
    }
    return { restored: true, currentSecret, displacedSecret };
  } catch (error) {
    let rollbackError;
    try {
      if (backupMoved && existsSync(secretPath)) {
        renameSync(secretPath, backup);
        backupMoved = false;
        protect(backup);
      }
      if (displacedPresent && existsSync(displaced)) {
        renameSync(displaced, secretPath);
        displacedPresent = false;
        protect(secretPath);
      }
    } catch (caught) {
      rollbackError = caught;
    }
    throw combinedFailure(error, rollbackError);
  }
}

export function discardCallerCapabilityBackup({ secretPath, operationId } = {}) {
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (!existsSync(backup)) return false;
  unlinkSync(backup);
  return true;
}
