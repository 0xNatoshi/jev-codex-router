import {
  routerServiceRestartCommand,
} from "./router-restart.mjs";
import {
  deactivateAntigravityProbeActivation,
  promoteAntigravityProbeActivation,
  storedAntigravityProbeActivationIsActive,
} from "./antigravity-oauth-session.mjs";

// The credential lock can legitimately wait 30 seconds behind another token
// mutation. Service health may become externally visible while startup is
// waiting for that lock, so confirmation must outlast the lock budget rather
// than report a false failure five seconds into a safe activation.
const ACTIVATION_CONFIRM_TIMEOUT_MS = 35_000;
const ACTIVATION_CONFIRM_POLL_MS = 25;

export function antigravityProviderEnableCommand(platform = process.platform) {
  return platform === "win32"
    ? ".\\codex-router.ps1 providers enable antigravity-oauth"
    : "./bin/providers enable antigravity-oauth";
}

function recoveryInstructions(platform) {
  return (
    `For a managed installation, run \`${routerServiceRestartCommand(platform)}\`. ` +
    "Once the router is running with a healthy Antigravity OAuth forwarder, " +
    `run \`${antigravityProviderEnableCommand(platform)}\` to republish the verified route.`
  );
}

function forwarderUnavailable(message, { cause, platform = process.platform } = {}) {
  const error = new Error(
    `${message} Installed clients remain withdrawn. ${recoveryInstructions(platform)}`,
    cause === undefined ? undefined : { cause },
  );
  error.code = "antigravity_forwarder_not_confirmed";
  return error;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Antigravity activation aborted.");
}

function throwIfAborted(signal, deadline, now = Date.now) {
  if (signal?.aborted) throw abortReason(signal);
  // Synchronous service/publication children briefly prevent the controller's
  // timer callback from running. The absolute deadline is the same contract
  // across those process boundaries, so enforce it directly on return too.
  if (Number.isSafeInteger(deadline) && now() >= deadline) {
    const error = new Error(
      "Antigravity probe activation timed out before every phase completed.",
    );
    error.code = "antigravity_activation_timeout";
    throw error;
  }
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  const waitMs = Math.max(0, Math.floor(milliseconds));
  if (waitMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(finish, waitMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function processExited(child) {
  return Boolean(child) && (
    (child.exitCode !== undefined && child.exitCode !== null) ||
    (child.signalCode !== undefined && child.signalCode !== null)
  );
}

export async function promoteAntigravityProbeAfterReadiness({
  generation,
  sessionGeneration,
  children = [],
  promote = promoteAntigravityProbeActivation,
  rollback = deactivateAntigravityProbeActivation,
}) {
  if (!generation || children.some(processExited)) return false;
  const promoted = await promote(generation, sessionGeneration);
  if (!promoted) return false;
  if (!children.some(processExited)) return true;

  // Promotion can wait asynchronously on the credential lock. A child that
  // dies during that wait invalidates the readiness observation that admitted
  // this generation. Compare-and-set the exact generation back to pending so
  // no stale startup leaves an active proof behind.
  let rolledBack;
  try {
    rolledBack = await rollback(generation, sessionGeneration);
  } catch (cause) {
    const error = new Error("Antigravity live-proof activation rollback was not confirmed.");
    error.code = "antigravity_activation_rollback_failed";
    error.cause = cause;
    throw error;
  }
  if (!rolledBack) {
    const error = new Error("Antigravity live-proof activation rollback was not confirmed.");
    error.code = "antigravity_activation_rollback_failed";
    throw error;
  }
  return false;
}

export async function attemptAntigravityProbePromotionAfterReadiness(options) {
  try {
    return await promoteAntigravityProbeAfterReadiness(options);
  } catch (error) {
    // Startup must keep the already-healthy unrelated provider stack alive
    // when the credential lock is transiently unavailable. withTokenLock
    // raises oauth_transient before running the activation transform, so the
    // on-disk proof is still pending and no compensating write is necessary.
    if (error?.code === "oauth_transient") return false;

    // A post-promotion child death is different: the active write is known to
    // have happened. Retry its exact-generation rollback once, then fail the
    // service rather than hide an activation whose rollback is still unknown.
    if (error?.code === "antigravity_activation_rollback_failed") {
      try {
        if (
          await (options.rollback || deactivateAntigravityProbeActivation)(
            options.generation,
            options.sessionGeneration,
          )
        ) {
          return false;
        }
      } catch {}
    }
    throw error;
  }
}

export async function waitForExactActivation(
  generation,
  {
    confirm,
    timeoutMs = ACTIVATION_CONFIRM_TIMEOUT_MS,
    pollMs = ACTIVATION_CONFIRM_POLL_MS,
    signal,
    deadline,
    now = Date.now,
    delay = abortableDelay,
  },
) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(0, Math.floor(timeoutMs))
    : ACTIVATION_CONFIRM_TIMEOUT_MS;
  const boundedPollMs = Number.isFinite(pollMs)
    ? Math.max(1, Math.floor(pollMs))
    : ACTIVATION_CONFIRM_POLL_MS;
  const confirmationDeadline = now() + boundedTimeoutMs;
  do {
    throwIfAborted(signal, deadline, now);
    const confirmed = await confirm(generation, { signal, deadline });
    throwIfAborted(signal, deadline, now);
    if (confirmed) return true;
    const nowMs = now();
    const globalRemainingMs = Number.isSafeInteger(deadline)
      ? deadline - nowMs
      : Number.POSITIVE_INFINITY;
    const remainingMs = Math.min(confirmationDeadline - nowMs, globalRemainingMs);
    if (remainingMs <= 0) return false;
    await delay(Math.min(boundedPollMs, remainingMs), signal);
  } while (true);
}

// The proof transition and route transition form one fail-closed sequence:
// withdraw while proof is invalid, write a generation-bound pending proof,
// restart/health-gate the conditional forwarder, confirm that startup promoted
// that exact generation, and only then let a caller republish installed clients.
export async function activateAntigravityProbe({
  probe,
  probeOptions,
  withdraw,
  restart,
  publish,
  confirm = storedAntigravityProbeActivationIsActive,
  confirmationTimeoutMs = ACTIVATION_CONFIRM_TIMEOUT_MS,
  confirmationPollMs = ACTIVATION_CONFIRM_POLL_MS,
  signal,
  deadline,
  platform = process.platform,
}) {
  throwIfAborted(signal, deadline);
  const result = await probe({
    ...probeOptions,
    onProofInvalidated: withdraw,
    ...(signal ? { signal } : {}),
    ...(Number.isSafeInteger(deadline) ? { deadline } : {}),
  });

  throwIfAborted(signal, deadline);
  let restarted;
  try {
    restarted = await restart({ signal, deadline });
  } catch (error) {
    const deadlineExpired = [
      "antigravity_activation_timeout",
      "router_operation_timeout",
    ].includes(error?.code);
    throw forwarderUnavailable(
      deadlineExpired
        ? "The live Antigravity proof remains pending because the activation deadline expired before the router restart confirmed its forwarder."
        : "The live Antigravity proof remains pending because the router restart did not confirm its forwarder.",
      { cause: error, platform },
    );
  }
  throwIfAborted(signal, deadline);
  if (!restarted) {
    throw forwarderUnavailable(
      "The live Antigravity proof remains pending because no managed router service was available to start and confirm its forwarder.",
      { platform },
    );
  }
  const activated = await waitForExactActivation(result.activationGeneration, {
    confirm: confirm === storedAntigravityProbeActivationIsActive
      ? (generation, options) => confirm(generation, result.sessionGeneration, options)
      : confirm,
    timeoutMs: confirmationTimeoutMs,
    pollMs: confirmationPollMs,
    signal,
    deadline,
  });
  if (!activated) {
    throw forwarderUnavailable(
      "The router became reachable without activating this exact Antigravity live-proof generation.",
      { platform },
    );
  }

  throwIfAborted(signal, deadline);
  const refreshed = publish ? await publish({ signal, deadline }) : undefined;
  throwIfAborted(signal, deadline);
  return {
    result,
    refreshed,
  };
}
