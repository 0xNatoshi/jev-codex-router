import assert from "node:assert/strict";
import test from "node:test";

import {
  activateAntigravityProbe,
  antigravityProviderEnableCommand,
  attemptAntigravityProbePromotionAfterReadiness,
  promoteAntigravityProbeAfterReadiness,
  waitForExactActivation,
} from "../src/antigravity-probe-activation.mjs";

const ACTIVATION_GENERATION = "55555555-5555-4555-8555-555555555555";

test("withdraws before restart and publishes only after forwarder confirmation", async () => {
  const events = [];
  const controller = new AbortController();
  const deadline = Date.now() + 60_000;
  const activation = await activateAntigravityProbe({
    probeOptions: { live: true, confirmed: true },
    probe: async (options) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(options.deadline, deadline);
      events.push("proof-invalidated");
      await options.onProofInvalidated();
      events.push("probe-complete");
      return {
        verified: true,
        model: "gemini-3.1-pro",
        activationGeneration: ACTIVATION_GENERATION,
      };
    },
    withdraw: async () => { events.push("clients-withdrawn"); },
    restart: async (options) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(options.deadline, deadline);
      events.push("forwarder-confirmed");
      return true;
    },
    confirm: async (generation, options) => {
      assert.equal(generation, ACTIVATION_GENERATION);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.deadline, deadline);
      events.push("activation-confirmed");
      return true;
    },
    publish: async (options) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(options.deadline, deadline);
      events.push("clients-published");
      return true;
    },
    signal: controller.signal,
    deadline,
  });

  assert.deepEqual(events, [
    "proof-invalidated",
    "clients-withdrawn",
    "probe-complete",
    "forwarder-confirmed",
    "activation-confirmed",
    "clients-published",
  ]);
  assert.equal(activation.refreshed, true);
  assert.equal(activation.result.verified, true);
});

test("one abort signal covers the probe, restart, and publication boundary", async () => {
  const controller = new AbortController();
  const timeout = Object.assign(new Error("planned activation timeout"), {
    code: "antigravity_activation_timeout",
  });
  let restarted = false;
  let published = false;
  await assert.rejects(
    activateAntigravityProbe({
      signal: controller.signal,
      deadline: Date.now() + 1_000,
      probe: async (options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort(timeout);
        return { verified: true };
      },
      withdraw: async () => {},
      restart: async () => { restarted = true; return true; },
      publish: async () => { published = true; },
    }),
    (error) => error === timeout,
  );
  assert.equal(restarted, false);
  assert.equal(published, false);
});

test("an absolute deadline is enforced even while timer callbacks are blocked", async () => {
  let probed = false;
  await assert.rejects(
    activateAntigravityProbe({
      deadline: Date.now() - 1,
      probe: async () => { probed = true; },
      withdraw: async () => {},
      restart: async () => true,
      publish: async () => true,
    }),
    (error) => error?.code === "antigravity_activation_timeout",
  );
  assert.equal(probed, false);
});

test("confirmation polling shares context and clamps its sleep to the deadline", async () => {
  const controller = new AbortController();
  const deadline = 1_010;
  let nowMs = 1_000;
  const delays = [];
  let confirmations = 0;
  await assert.rejects(
    waitForExactActivation(ACTIVATION_GENERATION, {
      signal: controller.signal,
      deadline,
      timeoutMs: 100,
      pollMs: 25,
      now: () => nowMs,
      confirm: async (generation, options) => {
        assert.equal(generation, ACTIVATION_GENERATION);
        assert.equal(options.signal, controller.signal);
        assert.equal(options.deadline, deadline);
        confirmations += 1;
        return false;
      },
      delay: async (milliseconds, signal) => {
        assert.equal(signal, controller.signal);
        delays.push(milliseconds);
        nowMs += milliseconds;
      },
    }),
    { code: "antigravity_activation_timeout" },
  );
  assert.equal(confirmations, 1);
  assert.deepEqual(delays, [10]);
});

test("confirmation polling delay aborts promptly and never publishes", async () => {
  const controller = new AbortController();
  const aborted = new Error("planned confirmation abort");
  let published = false;
  let confirmations = 0;
  const startedAt = Date.now();
  await assert.rejects(
    activateAntigravityProbe({
      signal: controller.signal,
      deadline: Date.now() + 10_000,
      probe: async () => ({
        verified: true,
        activationGeneration: ACTIVATION_GENERATION,
      }),
      withdraw: async () => {},
      restart: async () => true,
      confirm: async () => {
        confirmations += 1;
        setTimeout(() => controller.abort(aborted), 10);
        return false;
      },
      confirmationTimeoutMs: 10_000,
      confirmationPollMs: 5_000,
      publish: async () => { published = true; },
    }),
    (error) => error === aborted,
  );
  assert.equal(confirmations, 1);
  assert.equal(published, false);
  assert.ok(Date.now() - startedAt < 2_000, "the abort must interrupt the polling delay");
});

test("an abort after readiness still prevents route publication", async () => {
  const controller = new AbortController();
  const timeout = new Error("planned post-readiness timeout");
  let published = false;
  await assert.rejects(
    activateAntigravityProbe({
      signal: controller.signal,
      probe: async () => ({ verified: true }),
      withdraw: async () => {},
      restart: async () => {
        controller.abort(timeout);
        return true;
      },
      publish: async () => { published = true; },
    }),
    (error) => error === timeout,
  );
  assert.equal(published, false);
});

test("an unavailable service leaves clients withdrawn and names exact recovery commands", async () => {
  const events = [];
  await assert.rejects(
    activateAntigravityProbe({
      platform: "linux",
      probe: async ({ onProofInvalidated }) => {
        await onProofInvalidated();
        events.push("probe-complete");
        return { verified: true, activationGeneration: ACTIVATION_GENERATION };
      },
      withdraw: async () => { events.push("withdraw"); },
      restart: async () => { events.push("restart-unavailable"); return false; },
      publish: async () => { events.push("publish"); },
    }),
    (error) => {
      assert.equal(error.code, "antigravity_forwarder_not_confirmed");
      assert.match(error.message, /Installed clients remain withdrawn/);
      assert.match(error.message, /\.\/bin\/control service restart/);
      assert.match(error.message, /\.\/bin\/providers enable antigravity-oauth/);
      return true;
    },
  );
  assert.deepEqual(events, ["withdraw", "probe-complete", "restart-unavailable"]);
});

test("a failed restart cannot publish and preserves the failure as its cause", async () => {
  const restartFailure = new Error("service failed");
  let published = false;
  await assert.rejects(
    activateAntigravityProbe({
      platform: "win32",
      probe: async ({ onProofInvalidated }) => {
        await onProofInvalidated();
        return { verified: true, activationGeneration: ACTIVATION_GENERATION };
      },
      withdraw: async () => {},
      restart: async () => { throw restartFailure; },
      publish: async () => { published = true; },
    }),
    (error) => {
      assert.equal(error.code, "antigravity_forwarder_not_confirmed");
      assert.equal(error.cause, restartFailure);
      assert.match(error.message, /node \.\\src\\control\.mjs service restart/);
      assert.match(error.message, /\.\\codex-router\.ps1 providers enable antigravity-oauth/);
      return true;
    },
  );
  assert.equal(published, false);
  assert.equal(
    antigravityProviderEnableCommand("win32"),
    ".\\codex-router.ps1 providers enable antigravity-oauth",
  );
});

test("health success for a different generation cannot publish the pending proof", async () => {
  const events = [];
  await assert.rejects(
    activateAntigravityProbe({
      platform: "linux",
      probe: async ({ onProofInvalidated }) => {
        await onProofInvalidated();
        return { verified: true, activationGeneration: ACTIVATION_GENERATION };
      },
      withdraw: async () => { events.push("withdraw"); },
      restart: async () => { events.push("restart-ready"); return true; },
      confirm: async () => { events.push("stale-generation"); return false; },
      confirmationTimeoutMs: 0,
      publish: async () => { events.push("publish"); },
    }),
    (error) => {
      assert.equal(error.code, "antigravity_forwarder_not_confirmed");
      assert.match(error.message, /without activating this exact .*generation/i);
      return true;
    },
  );
  assert.deepEqual(events, ["withdraw", "restart-ready", "stale-generation"]);
});

test("a child process death prevents startup from promoting a pending generation", async () => {
  let promotions = 0;
  const promoted = await promoteAntigravityProbeAfterReadiness({
    generation: ACTIVATION_GENERATION,
    children: [
      { exitCode: null, signalCode: null },
      { exitCode: 1, signalCode: null },
    ],
    promote: async () => {
      promotions += 1;
      return true;
    },
  });
  assert.equal(promoted, false);
  assert.equal(promotions, 0);
});

test("a child death during the asynchronous CAS rolls the exact generation back", async () => {
  const child = { exitCode: null, signalCode: null };
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const events = [];
  const activation = promoteAntigravityProbeAfterReadiness({
    generation: ACTIVATION_GENERATION,
    children: [child],
    promote: async (generation) => {
      assert.equal(generation, ACTIVATION_GENERATION);
      events.push("promotion-started");
      startedResolve();
      await release;
      events.push("active-written");
      return true;
    },
    rollback: async (generation) => {
      assert.equal(generation, ACTIVATION_GENERATION);
      events.push("exact-generation-rolled-back");
      return true;
    },
  });

  await started;
  child.exitCode = 1;
  releaseResolve();
  assert.equal(await activation, false);
  assert.deepEqual(events, [
    "promotion-started",
    "active-written",
    "exact-generation-rolled-back",
  ]);
});

test("a transient promotion lock error stays nonfatal with the proof pending", async () => {
  const transient = new Error("credential lock unavailable");
  transient.code = "oauth_transient";
  const events = [];
  const promoted = await attemptAntigravityProbePromotionAfterReadiness({
    generation: ACTIVATION_GENERATION,
    children: [{ exitCode: null, signalCode: null }],
    promote: async () => {
      events.push("promotion-attempted");
      throw transient;
    },
    rollback: async () => { events.push("unexpected-rollback"); return true; },
  });
  assert.equal(promoted, false);
  assert.deepEqual(events, ["promotion-attempted"]);
});

test("startup retries a failed post-promotion rollback before continuing", async () => {
  const child = { exitCode: null, signalCode: null };
  let rollbacks = 0;
  const promoted = await attemptAntigravityProbePromotionAfterReadiness({
    generation: ACTIVATION_GENERATION,
    children: [child],
    promote: async () => {
      child.exitCode = 1;
      return true;
    },
    rollback: async (generation) => {
      assert.equal(generation, ACTIVATION_GENERATION);
      rollbacks += 1;
      if (rollbacks === 1) throw new Error("temporary rollback failure");
      return true;
    },
  });
  assert.equal(promoted, false);
  assert.equal(rollbacks, 2);
});

test("startup fails closed when an active generation cannot be rolled back", async () => {
  const child = { exitCode: null, signalCode: null };
  let rollbacks = 0;
  await assert.rejects(
    attemptAntigravityProbePromotionAfterReadiness({
      generation: ACTIVATION_GENERATION,
      children: [child],
      promote: async () => {
        child.exitCode = 1;
        return true;
      },
      rollback: async () => {
        rollbacks += 1;
        throw new Error("persistent rollback failure");
      },
    }),
    { code: "antigravity_activation_rollback_failed" },
  );
  assert.equal(rollbacks, 2);
});
