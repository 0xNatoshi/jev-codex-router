// A test that runs the real service installer rewrites the developer's own
// machine. The LaunchAgent gets repointed at the checkout under test, the
// router then refuses to start against state owned by another checkout
// (`foreign_state_owner`), and an uninstall in the same test can delete the
// definition outright. None of that is visible in the suite's output: the
// damage surfaces later as a dead router, with nothing tying it back to a test
// run, and the obvious next step -- run the tests again -- reproduces it.
//
// So under the Node test runner a service definition may only be written to a
// location the test explicitly redirected. NODE_TEST_CONTEXT is set by the
// runner in each test file's process and inherited by the processes those
// tests spawn, which is the same path the damage travels, so it marks exactly
// the calls that have to be isolated and nothing else.
//
// This is a backstop, not the mechanism: tests are expected to redirect these
// paths themselves. It exists because the failure is silent and lands on the
// machine rather than in the run.
export function assertServiceWriteIsolated(
  target,
  { redirected, env = process.env, label = "service definition", override } = {},
) {
  if (!env.NODE_TEST_CONTEXT) return;
  if (redirected) return;
  throw new Error(
    `Refusing to write the ${label} to ${target} from a test run.\n`
      + "This is the machine's own installed service, not a fixture. Point "
      + `${override || "the path override for this platform (see src/paths.mjs)"} `
      + "at a temporary directory in the test.",
  );
}

// The other half of the same failure. A test can redirect where the service
// definition is written, but it cannot redirect the service manager: launchctl,
// systemctl and schtasks all address the machine's own domain by label. So an
// isolated install wrote its plist to a fixture and then booted the developer's
// live router out of launchd and registered that fixture in its place -- and
// when the test deleted its temporary directory, launchd was left pointing at
// a definition that no longer existed. The router stayed dead until someone
// reinstalled it by hand, with nothing tying it back to a test run.
//
// So under the test runner a call that would change the machine's own service
// registration is skipped rather than made.
// Refusing loudly was the first attempt and it was wrong: the damaging call is
// indistinguishable from a legitimate one at the call site, so every existing
// test would have had to opt out of a thing it never asked for, and the ones
// that did not would fail for reasons unrelated to what they test. There is
// nothing to remember this way.
//
// Reads stay live. A status/query call must still answer whether the service
// exists. Callers that poll a read after a skipped mutation bail out before
// the loop instead, because there was no host operation whose completion they
// could be waiting for.
//
// The platform modules apply this at their service-manager call sites. The
// Windows module uses it for Task Scheduler mutations while deliberately
// leaving query/read paths live, so status cannot claim a missing task is
// installed.
export function serviceManagerDisabled(env = process.env) {
  return env.CODEX_ROUTER_SKIP_LAUNCHCTL === "1"
    || env.MODEL_ROUTER_SKIP_SERVICE_MANAGER === "1";
}

// True when a mutating caller should skip the invocation entirely. Read/query
// callers intentionally do not consult this helper.
//
// `hostManaged` is false when a platform module is being exercised away from
// its own platform -- src/service-render.test.mjs drives the Windows and Linux
// modules on macOS against executable stubs first on PATH. Those calls reach no
// real scheduler, and the stubs are the point of the test, so they are left
// alone.
export function skipServiceManagerCall({ hostManaged = true, env = process.env } = {}) {
  if (serviceManagerDisabled(env)) return true;
  return Boolean(env.NODE_TEST_CONTEXT) && hostManaged;
}
