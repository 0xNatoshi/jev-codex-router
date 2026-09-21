import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WAIT_MS = 25;
const MAX_WAIT_MS = 2_000;
const STALE_MS = 30_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockPath(target) {
  return `${target}.lock`;
}

function staleLock(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return Date.now() - stat.mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function lockOwnerPid(pathname) {
  try {
    const owner = `${pathname}/owner`;
    const stat = lstatSync(owner);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64) {
      return undefined;
    }
    const value = readFileSync(owner, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function abandonedLock(pathname) {
  const pid = lockOwnerPid(pathname);
  if (pid) return !processIsAlive(pid);
  return staleLock(pathname);
}

function acquire(target, { waitMs = MAX_WAIT_MS } = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new TypeError("State lock wait must be a non-negative number of milliseconds.");
  }
  const pathname = lockPath(target);
  mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(pathname, { recursive: false, mode: 0o700 });
      try {
        writeFileSync(`${pathname}/owner`, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch {
        rmSync(pathname, { recursive: true, force: true });
        throw new Error(`Could not initialize state lock: ${pathname}`);
      }
      return () => rmSync(pathname, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let link = false;
      try {
        link = lstatSync(pathname).isSymbolicLink();
      } catch {
        continue;
      }
      if (link) throw new Error(`Refusing to use a symbolic-link state lock: ${pathname}`);
      if (abandonedLock(pathname)) {
        rmSync(pathname, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= waitMs) {
        const owner = lockOwnerPid(pathname);
        throw new Error(`Timed out waiting for state lock${owner ? ` held by ${owner}` : ""}: ${pathname}`);
      }
      sleep(WAIT_MS);
    }
  }
}

export function withAtomicStateLock(target, operation, options) {
  if (typeof operation !== "function") throw new TypeError("State lock operation must be a function.");
  const release = acquire(target, options);
  try {
    return operation();
  } finally {
    release();
  }
}

export function atomicStateLockPath(target) {
  return lockPath(target);
}
