import assert from "node:assert/strict";
import test from "node:test";

import {
  bypassesLoopback,
  loopbackProxyBypassProblem,
  parseScutilProxy,
  readSessionNoProxy,
  readSystemProxy,
} from "../src/loopback-proxy-bypass.mjs";

// Verbatim `scutil --proxy` output from the Mac this check was written for:
// Astrill in OpenWeb mode, whose bypass list omits loopback entirely.
const BROKEN = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3213
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 3213
  HTTPSProxy : 127.0.0.1
}`;

const FIXED = BROKEN.replace(
  "    1 : 169.254/16\n",
  "    1 : 169.254/16\n    2 : 127.0.0.1\n    3 : localhost\n    4 : ::1\n",
);

const DISABLED = BROKEN.replace("HTTPEnable : 1", "HTTPEnable : 0")
  .replace("HTTPSEnable : 1", "HTTPSEnable : 0");

test("the proxy dictionary is parsed into settings and exceptions", () => {
  const parsed = parseScutilProxy(BROKEN);
  assert.equal(parsed.httpEnabled, true);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 3213);
  assert.deepEqual(parsed.exceptions, ["*.local", "169.254/16"]);
});

// The state that made this undiagnosable: a non-empty exception list reads as
// "exceptions are configured" at a glance while matching nothing on loopback.
test("a wildcard exception list does not count as bypassing loopback", () => {
  assert.equal(bypassesLoopback(["*.local", "169.254/16"]), false);
  assert.equal(bypassesLoopback(["127.0.0.1", "localhost"]), false);
  assert.equal(bypassesLoopback(["127.0.0.1", "localhost", "::1"]), true);
  assert.equal(bypassesLoopback(["*.local", "LOCALHOST", "127.0.0.1", "[::1]"]), true);
  assert.equal(bypassesLoopback(undefined), false);
});

test("an enabled proxy without a loopback bypass is reported with its address", () => {
  const problem = loopbackProxyBypassProblem({
    platform: "darwin",
    systemProxy: parseScutilProxy(BROKEN),
  });
  assert.match(problem.detail, /127\.0\.0\.1:3213/);
  assert.match(problem.detail, /Codex Desktop/);
  assert.match(problem.remedy, /launchctl setenv NO_PROXY/);
});

test("a complete exception list clears the warning", () => {
  assert.equal(
    loopbackProxyBypassProblem({ platform: "darwin", systemProxy: parseScutilProxy(FIXED) }),
    undefined,
  );
});

// The session variable is what launchd hands a bundled app, so it overrides an
// incomplete exception list for every app launched after it is set.
test("a session NO_PROXY covering loopback clears the warning", () => {
  assert.equal(
    loopbackProxyBypassProblem({
      platform: "darwin",
      systemProxy: parseScutilProxy(BROKEN),
      sessionNoProxy: "localhost,127.0.0.1,::1",
    }),
    undefined,
  );
  // A partial one does not: a client still proxies whatever it omits.
  assert.ok(
    loopbackProxyBypassProblem({
      platform: "darwin",
      systemProxy: parseScutilProxy(BROKEN),
      sessionNoProxy: "localhost",
    }),
  );
});

// Nothing to bypass, nothing to warn about.
test("a disabled system proxy is not a problem", () => {
  assert.equal(
    loopbackProxyBypassProblem({ platform: "darwin", systemProxy: parseScutilProxy(DISABLED) }),
    undefined,
  );
  assert.equal(loopbackProxyBypassProblem({ platform: "darwin" }), undefined);
});

// A warning an operator cannot act on is worse than silence.
test("a platform this cannot inspect stays silent", () => {
  assert.equal(
    loopbackProxyBypassProblem({ platform: "linux", systemProxy: parseScutilProxy(BROKEN) }),
    undefined,
  );
  assert.equal(readSystemProxy("linux", () => { throw new Error("must not run"); }), undefined);
  assert.equal(readSessionNoProxy("win32", () => { throw new Error("must not run"); }), undefined);
});

test("an unreadable or failing probe reports nothing rather than guessing", () => {
  assert.equal(parseScutilProxy(""), undefined);
  assert.equal(readSystemProxy("darwin", () => ({ status: 1, stdout: "" })), undefined);
  assert.equal(readSystemProxy("darwin", () => ({ error: new Error("ENOENT") })), undefined);
  assert.equal(readSessionNoProxy("darwin", () => ({ status: 1 })), undefined);
});

test("the session probe reads launchctl and trims its output", () => {
  const calls = [];
  const value = readSessionNoProxy("darwin", (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: "localhost,127.0.0.1,::1\n" };
  });
  assert.deepEqual(calls[0], ["launchctl", "getenv", "NO_PROXY"]);
  assert.equal(value, "localhost,127.0.0.1,::1");
});
