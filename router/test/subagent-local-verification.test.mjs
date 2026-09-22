import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_CHECKS,
  applySubagentProofs,
  verifiedForRoute,
} from "../src/subagent-proofs.mjs";

const ROUTER_VERSION = "0.5.0";

function passingChecks(overrides = {}) {
  const checks = {};
  for (const name of VERIFICATION_CHECKS) {
    checks[name] = { outcome: "pass", status: 200, observedAt: "2026-08-25T00:00:00.000Z" };
  }
  return { ...checks, ...overrides };
}

function verifiedRecord(slug, overrides = {}) {
  return {
    status: "verified",
    slug,
    routerVersion: ROUTER_VERSION,
    verifiedAt: "2026-08-25T00:00:00.000Z",
    epoch: 1,
    checks: passingChecks(),
    ...overrides,
  };
}

test("a completed local verification promotes exactly its own route", () => {
  const proof = verifiedRecord("deepseek/deepseek-v4-flash");
  assert.equal(verifiedForRoute(proof, "deepseek/deepseek-v4-flash", { routerVersion: ROUTER_VERSION }), true);

  const models = [
    { slug: "deepseek/deepseek-v4-flash", multiAgentVersion: "v1" },
    { slug: "deepseek/deepseek-v4-pro", multiAgentVersion: "v1" },
  ];
  const applied = applySubagentProofs(
    models,
    { "deepseek/deepseek-v4-flash": proof },
    { routerVersion: ROUTER_VERSION },
  );
  assert.equal(applied[0].multiAgentVersion, "v2");
  assert.equal(applied[0].subagentVerifiedLocally, true);
  // A sibling route on the same credential is a separate application: its own
  // adapter and tool handling were never exercised.
  assert.equal(applied[1].multiAgentVersion, "v1");
  assert.equal(applied[1].subagentVerifiedLocally, undefined);
});

test("the cheap stream/tool probe can never stand in for native collaboration", () => {
  // The exact failure the promotion gate exists to prevent: checks 1-2 pass,
  // the delegation checks never ran, and the route is still v1.
  const partial = verifiedRecord("deepseek/deepseek-v4-flash", {
    checks: {
      streaming: { outcome: "pass" },
      toolCall: { outcome: "pass" },
      encryptedRelay: { outcome: "pending" },
      markerReturn: { outcome: "pending" },
      sameThreadFollowUp: { outcome: "pending" },
    },
  });
  assert.equal(verifiedForRoute(partial, "deepseek/deepseek-v4-flash", { routerVersion: ROUTER_VERSION }), false);

  for (const missing of VERIFICATION_CHECKS) {
    const record = verifiedRecord("a/b", {
      checks: passingChecks({ [missing]: { outcome: "fail" } }),
    });
    assert.equal(
      verifiedForRoute(record, "a/b", { routerVersion: ROUTER_VERSION }),
      false,
      `${missing} must be required`,
    );
  }
});

test("legacy diagnostic statuses still promote nothing", () => {
  for (const status of ["checking", "candidate", "experimental", "proven", "failed"]) {
    const record = verifiedRecord("a/b", { status });
    assert.equal(verifiedForRoute(record, "a/b", { routerVersion: ROUTER_VERSION }), false, status);
  }
  const applied = applySubagentProofs(
    [{ slug: "a/b", multiAgentVersion: "v1" }],
    { "a/b": verifiedRecord("a/b", { status: "proven" }) },
    { routerVersion: ROUTER_VERSION },
  );
  assert.equal(applied[0].multiAgentVersion, "v1");
});

test("a record cannot promote a route it was not produced for", () => {
  const proof = verifiedRecord("deepseek/deepseek-v4-flash");
  assert.equal(verifiedForRoute(proof, "openrouter/deepseek-v4-flash", { routerVersion: ROUTER_VERSION }), false);
  const applied = applySubagentProofs(
    [{ slug: "openrouter/deepseek-v4-flash", multiAgentVersion: "v1" }],
    { "openrouter/deepseek-v4-flash": proof },
    { routerVersion: ROUTER_VERSION },
  );
  assert.equal(applied[0].multiAgentVersion, "v1");
});

test("a verification survives a router upgrade but not an epoch change", () => {
  // What the checks measure is the provider route, which a router patch bump
  // does not change. Expiring every upgrade would charge the operator again to
  // re-learn the same answer.
  const proof = verifiedRecord("a/b", { routerVersion: "0.4.0-beta.3" });
  assert.equal(verifiedForRoute(proof, "a/b", { routerVersion: ROUTER_VERSION }), true);
  // Invalidation stays possible, but only as a deliberate, reviewable act.
  const stale = verifiedRecord("a/b", { epoch: 0 });
  assert.equal(verifiedForRoute(stale, "a/b", { routerVersion: ROUTER_VERSION }), false);
});

test("hidden and switched-off routes are never promoted", () => {
  const proofs = { "a/b": verifiedRecord("a/b") };
  const hidden = applySubagentProofs(
    [{ slug: "a/b", multiAgentVersion: "v1" }],
    proofs,
    { hidden: new Set(["a/b"]), routerVersion: ROUTER_VERSION },
  );
  assert.equal(hidden[0].multiAgentVersion, "v1");
  const disabled = applySubagentProofs(
    [{ slug: "a/b", multiAgentVersion: "v1" }],
    proofs,
    { disabled: ["a/b"], routerVersion: ROUTER_VERSION },
  );
  assert.equal(disabled[0].multiAgentVersion, "v1");
});

test("malformed records promote nothing", () => {
  for (const proof of [null, undefined, "verified", {}, { status: "verified" }]) {
    assert.equal(verifiedForRoute(proof, "a/b", { routerVersion: ROUTER_VERSION }), false);
  }
  assert.deepEqual(
    applySubagentProofs([{ slug: "a/b", multiAgentVersion: "v1" }], null, { routerVersion: ROUTER_VERSION })[0]
      .multiAgentVersion,
    "v1",
  );
});
