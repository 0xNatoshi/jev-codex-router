import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const { validateV2AgentApplications } = await import("../scripts/check-v2-agent-applications.mjs");

const fixtureRoots = new Set();

function temporaryRoot(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return root;
}

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

const ACCEPTED_MODELS = Object.freeze([{
  slug: "example/alpha",
  provider: "example",
  upstreamModel: "alpha",
  multiAgentVersion: "v2",
}]);

function application(root, proof, markdown = "# Proof\n\n## Evidence\n\nSummary only.\n") {
  const routeName = String(proof.slug || "").split("/")[1] || proof.model;
  const folder = path.join(root, proof.provider, routeName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "proof.md"), markdown);
  writeFileSync(path.join(folder, "proof.json"), JSON.stringify(proof, null, 2));
}

function acceptedProof() {
  const now = "2026-08-22T00:00:00.000Z";
  return {
    version: 1,
    provider: "example",
    model: "alpha",
    slug: "example/alpha",
    status: "accepted",
    officialSources: ["https://api-docs.deepseek.com/models/alpha"],
    testedAt: now,
    routerVersion: "0.5.0",
    checks: Object.fromEntries(
      ["streaming", "toolCall", "encryptedRelay", "markerReturn", "sameThreadFollowUp"]
        .map((name) => [name, { outcome: "pass", status: 200, observedAt: now }]),
    ),
  };
}

test("an accepted application requires all native collaboration evidence", () => {
  const root = temporaryRoot("v2-agent-application-test-");
  application(root, acceptedProof());
  assert.deepEqual(validateV2AgentApplications(root, { models: ACCEPTED_MODELS }), [{
    provider: "example", model: "alpha", slug: "example/alpha", status: "accepted",
  }]);
});

test("a draft may be submitted before live evidence exists", () => {
  const root = temporaryRoot("v2-agent-draft-test-");
  application(root, {
    version: 1,
    provider: "example",
    model: "beta",
    slug: "example/beta",
    status: "draft",
  });
  assert.equal(validateV2AgentApplications(root, { models: [] })[0].status, "draft");
});

test("proofs fail closed on missing checks, identity drift, and credential-shaped content", () => {
  const missing = temporaryRoot("v2-agent-missing-test-");
  const incomplete = acceptedProof();
  delete incomplete.checks.markerReturn;
  application(missing, incomplete);
  assert.throws(
    () => validateV2AgentApplications(missing, { models: ACCEPTED_MODELS }),
    /markerReturn/,
  );

  const secret = temporaryRoot("v2-agent-secret-test-");
  application(secret, acceptedProof(), "# Proof\n\n## Evidence\n\nBearer token_abcdefghijklmnop\n");
  assert.throws(
    () => validateV2AgentApplications(secret, { models: ACCEPTED_MODELS }),
    /credentials or bearer/,
  );
});

test("accepted proof identity must match one exact v2 registry route", () => {
  const absent = temporaryRoot("v2-agent-route-absent-test-");
  application(absent, acceptedProof());
  assert.throws(
    () => validateV2AgentApplications(absent, {
      models: [{
        slug: "other/alpha",
        provider: "other",
        upstreamModel: "alpha",
        multiAgentVersion: "v2",
      }],
    }),
    /does not match an exact registry route/,
  );

  const unproven = temporaryRoot("v2-agent-route-v1-test-");
  application(unproven, acceptedProof());
  assert.throws(
    () => validateV2AgentApplications(unproven, {
      models: [{
        slug: "example/alpha",
        provider: "example",
        upstreamModel: "alpha",
      }],
    }),
    /requires the exact registry route to declare multiAgentVersion v2/,
  );

  const upstreamDrift = temporaryRoot("v2-agent-route-upstream-test-");
  application(upstreamDrift, acceptedProof());
  assert.throws(
    () => validateV2AgentApplications(upstreamDrift, {
      models: [{
        slug: "example/alpha",
        provider: "example",
        upstreamModel: "different-alpha",
        multiAgentVersion: "v2",
      }],
    }),
    /does not match an exact registry route/,
  );
});

test("accepted applications fail closed on legacy versions, v1 routes, and unknown checks", () => {
  const roots = [];
  const fixture = (suffix) => {
    const root = temporaryRoot(`v2-agent-contract-${suffix}-`);
    roots.push(root);
    return root;
  };
  try {
    const legacy = acceptedProof();
    legacy.version = 0;
    const legacyRoot = fixture("version");
    application(legacyRoot, legacy);
    assert.throws(
      () => validateV2AgentApplications(legacyRoot, { models: ACCEPTED_MODELS }),
      /proof\.json version must be 1/,
    );

    const v1Root = fixture("v1");
    application(v1Root, acceptedProof());
    assert.throws(
      () => validateV2AgentApplications(v1Root, {
        models: [{
          slug: "example/alpha",
          provider: "example",
          upstreamModel: "alpha",
          multiAgentVersion: "v1",
        }],
      }),
      /requires the exact registry route to declare multiAgentVersion v2/,
    );

    const unknownCheckRoot = fixture("check");
    const unknownCheck = acceptedProof();
    delete unknownCheck.checks.toolCall;
    unknownCheck.checks.tools = {
      outcome: "pass",
      status: 200,
      observedAt: unknownCheck.testedAt,
    };
    application(unknownCheckRoot, unknownCheck);
    assert.throws(
      () => validateV2AgentApplications(unknownCheckRoot, { models: ACCEPTED_MODELS }),
      /checks\.toolCall must record outcome: "pass"/,
    );
  } finally {
    for (const root of roots) fixtureRoots.delete(root);
  }
});

test("accepted proofs reject placeholder sources and loose timestamps", () => {
  for (const source of [
    "https://docs.example.test/models/alpha",
    "https://docs.example.com/models/alpha",
    "https://localhost./models/alpha",
    "https://[::1]/models/alpha",
  ]) {
    const placeholder = temporaryRoot("v2-agent-source-test-");
    const placeholderProof = acceptedProof();
    placeholderProof.officialSources = [source];
    application(placeholder, placeholderProof);
    assert.throws(
      () => validateV2AgentApplications(placeholder, { models: ACCEPTED_MODELS }),
      /HTTPS officialSources/,
      source,
    );
  }

  const timestamp = temporaryRoot("v2-agent-timestamp-test-");
  const timestampProof = acceptedProof();
  timestampProof.testedAt = "August 22, 2026 UTC";
  application(timestamp, timestampProof);
  assert.throws(
    () => validateV2AgentApplications(timestamp, { models: ACCEPTED_MODELS }),
    /ISO testedAt timestamp/,
  );
});

test("proof artifacts reject common credential shapes", () => {
  // Compose these at runtime so the repository tests the scanner without
  // teaching GitHub push protection that the fixture itself is a credential.
  for (const credential of [
    ["gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AI", "zaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"],
    ["AS", "IAABCDEFGHIJKLMNOP"],
    ["h", "f_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["xo", "xb-123456789012-123456789012-abcdefghijklmnopqrstuvwx"],
    ["gl", "pat-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["np", "m_abcdefghijklmnopqrstuvwxyz0123456789"],
  ].map((parts) => parts.join(""))) {
    const root = temporaryRoot("v2-agent-secret-shape-test-");
    application(
      root,
      acceptedProof(),
      `# Proof\n\n## Evidence\n\n${credential}\n`,
    );
    assert.throws(
      () => validateV2AgentApplications(root, { models: ACCEPTED_MODELS }),
      /credentials or bearer/,
      credential,
    );
  }
});

test("proof slugs contain exactly two safe path segments", () => {
  const root = temporaryRoot("v2-agent-slug-test-");
  const proof = acceptedProof();
  proof.slug = "example/alpha/extra";
  application(root, proof);
  assert.throws(() => validateV2AgentApplications(root), /slug must match/);
});

test("the route directory is independent of slash-bearing upstream model ids", () => {
  const root = temporaryRoot("v2-agent-upstream-id-test-");
  application(root, {
    version: 1,
    provider: "example",
    model: "accounts/vendor/models/alpha:v2",
    slug: "example/alpha-v2",
    status: "draft",
  });
  assert.deepEqual(validateV2AgentApplications(root, { models: [] })[0], {
    provider: "example",
    model: "accounts/vendor/models/alpha:v2",
    slug: "example/alpha-v2",
    status: "draft",
  });
});

test("a new registry v2 declaration requires an accepted exact-route application", () => {
  const root = temporaryRoot("v2-agent-reverse-gate-test-");
  assert.throws(
    () => validateV2AgentApplications(root, {
      models: [{
        slug: "new-provider/new-model",
        provider: "new-provider",
        upstreamModel: "vendor/new-model",
        multiAgentVersion: "v2",
      }],
    }),
    /registry v2 route needs an accepted application/,
  );
});

test(
  "proof artifacts must be regular files rather than symlinks",
  { skip: process.platform === "win32" },
  () => {
    const root = temporaryRoot("v2-agent-symlink-test-");
    const proof = acceptedProof();
    application(root, proof);
    const markdown = path.join(root, proof.provider, "alpha", "proof.md");
    const outside = path.join(root, "outside-proof.md");
    writeFileSync(outside, "# Proof\n\n## Evidence\n\nOutside the artifact directory.\n");
    unlinkSync(markdown);
    symlinkSync(outside, markdown);
    assert.throws(
      () => validateV2AgentApplications(root, { models: ACCEPTED_MODELS }),
      /missing proof.md/,
    );
  },
);
