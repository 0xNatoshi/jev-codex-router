import { randomUUID } from "node:crypto";

import {
  ANTIGRAVITY_PROBE_MODEL,
  ANTIGRAVITY_PROBE_VERSION,
} from "./antigravity-oauth-constants.mjs";
import {
  consumeAntigravitySseStream,
  requestAntigravityUpstream,
} from "./antigravity-oauth-forwarder.mjs";
import {
  applyAntigravitySsePayload,
  createAntigravityTurnState,
  finalizeAntigravityTurn,
  toAntigravityRequest,
} from "./antigravity-oauth-shape.mjs";
import {
  assertAntigravityProjectRevisionCurrent,
  claimAntigravityProjectRevision,
  discoverAntigravityProject,
} from "./antigravity-project.mjs";
import {
  antigravityProbeActivationState,
  ensureFreshAntigravitySession,
  invalidateAntigravityProbeProof,
  pendingAntigravityProbeActivation,
  readAntigravityToken,
  updateAntigravityToken,
} from "./antigravity-oauth-session.mjs";

export { ANTIGRAVITY_PROBE_MODEL };

function liveProbeRequired() {
  const error = new Error(
    "Antigravity compatibility testing sends a real provider request and uses quota. " +
      "Run it only with both --live and --yes after reviewing that cost.",
  );
  error.code = "live_probe_consent_required";
  return error;
}

const PROBE_RESPONSE_FIELDS = Object.freeze([
  "candidates",
  "usageMetadata",
  "promptFeedback",
  "error",
]);

// The ordinary response translator deliberately maps unrecognized terminal
// reasons to OpenAI's `stop`. That compatibility fallback is not evidence for
// enabling a credentialed route: proof needs one unambiguous raw candidate
// whose own terminal reason is exactly Google's `STOP`.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProbeResponseField(value) {
  return PROBE_RESPONSE_FIELDS.some((key) => Object.hasOwn(value, key));
}

function observeRawProbeCandidate(state, payload) {
  if (!state.valid || !isPlainObject(payload)) {
    state.valid = false;
    return;
  }
  const hasTopLevelResponse = hasProbeResponseField(payload);
  const hasWrappedResponse = Object.hasOwn(payload, "response");
  let response = payload;
  if (hasWrappedResponse) {
    if (
      hasTopLevelResponse ||
      !isPlainObject(payload.response) ||
      !hasProbeResponseField(payload.response)
    ) {
      state.valid = false;
      return;
    }
    response = payload.response;
  }
  if (!Object.hasOwn(response, "candidates")) return;
  if (!Array.isArray(response.candidates) || response.candidates.length > 1) {
    state.valid = false;
    return;
  }
  if (response.candidates.length === 0) return;
  if (state.sawStop) {
    state.valid = false;
    return;
  }
  const candidate = response.candidates[0];
  if (
    !isPlainObject(candidate) ||
    (Object.hasOwn(candidate, "index") && candidate.index !== 0)
  ) {
    state.valid = false;
    return;
  }
  state.sawCandidate = true;
  if (!Object.hasOwn(candidate, "finishReason")) return;
  if (candidate.finishReason !== "STOP") {
    state.valid = false;
    return;
  }
  state.sawStop = true;
}

function rawProbeCompletedExactly(state) {
  return state.valid && state.sawCandidate && state.sawStop;
}

export async function probeAntigravity({
  live = false,
  confirmed = false,
  allowOnboard = false,
  fetchImpl = fetch,
  now = Date.now,
  signal,
  endpoints,
  projectAttempts,
  projectRetryDelayMs,
  delayImpl,
  onProofInvalidated,
  activationGeneration,
} = {}) {
  if (live !== true || confirmed !== true) throw liveProbeRequired();

  // An explicit re-probe is a new assertion, not a background refresh of the
  // old one. Revoke the previous proof before refresh or any provider/project
  // request so every definitive failure below leaves status and installed
  // clients closed.
  const proofOwner = readAntigravityToken();
  await invalidateAntigravityProbeProof(proofOwner);
  if (onProofInvalidated) await onProofInvalidated();
  const session = await ensureFreshAntigravitySession({
    fetchImpl,
    now,
    signal,
    expectedGeneration: proofOwner.session_generation,
    ...(delayImpl ? { delayImpl } : {}),
  });
  const projectSession = await claimAntigravityProjectRevision(session);
  const project = await discoverAntigravityProject(projectSession.access_token, {
    fetchImpl,
    now,
    signal,
    allowOnboard,
    assertCurrent: () => assertAntigravityProjectRevisionCurrent(projectSession),
    ...(projectAttempts === undefined ? {} : { attempts: projectAttempts }),
    ...(projectRetryDelayMs === undefined ? {} : { retryDelayMs: projectRetryDelayMs }),
    ...(delayImpl ? { delayImpl } : {}),
  });
  const requestId = `codex-router-probe-${randomUUID()}`;
  assertAntigravityProjectRevisionCurrent(projectSession);
  const payload = toAntigravityRequest({
    model: ANTIGRAVITY_PROBE_MODEL,
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    max_tokens: 8,
    stream: true,
  }, {
    projectId: project.projectId,
    requestId,
  });

  const upstream = await requestAntigravityUpstream({
    accessToken: projectSession.access_token,
    serializedBody: JSON.stringify(payload),
    signal,
    fetchImpl,
    beforeAttempt: () =>
      assertAntigravityProjectRevisionCurrent(projectSession).access_token,
    ...(endpoints ? { endpoints } : {}),
  });
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    const error = new Error(
      `Google did not accept the truthful Codex Router compatibility probe (HTTP ${upstream.status}).`,
    );
    error.code = "antigravity_probe_failed";
    error.status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    throw error;
  }

  const state = createAntigravityTurnState();
  const rawCompletion = { valid: true, sawCandidate: false, sawStop: false };
  await consumeAntigravitySseStream(upstream.body, (event) => {
    observeRawProbeCandidate(rawCompletion, event);
    applyAntigravitySsePayload(state, event);
  }, {
    isTerminal: () => state.sawTerminal,
    signal,
  });
  const turn = finalizeAntigravityTurn(state);
  if (
    !rawProbeCompletedExactly(rawCompletion) ||
    turn.finishReason !== "stop" ||
    turn.toolCalls.length !== 0 ||
    turn.contentText.trim() !== "OK"
  ) {
    const error = new Error(
      "Google completed the truthful Codex Router compatibility probe without the exact safe `OK` result.",
    );
    error.code = "antigravity_probe_result_mismatch";
    error.status = 502;
    throw error;
  }

  let recorded = false;
  const verifiedAt = now();
  const pendingActivation = pendingAntigravityProbeActivation(
    activationGeneration ?? randomUUID(),
  );
  const committedProjectRevision = randomUUID();
  const saved = await updateAntigravityToken((latest) => {
    if (
      latest.session_generation !== projectSession.session_generation ||
      latest.project_revision !== projectSession.project_revision
    ) {
      return undefined;
    }
    recorded = true;
    return {
      ...latest,
      project_revision: committedProjectRevision,
      project_id: project.projectId,
      project_source: project.source,
      project_checked_at: project.checkedAt,
      tier_id: project.tierId,
      probe_version: ANTIGRAVITY_PROBE_VERSION,
      probe_verified_at: verifiedAt,
      probe_model: ANTIGRAVITY_PROBE_MODEL,
      probe_activation: pendingActivation,
    };
  });
  const savedActivation = antigravityProbeActivationState(saved);
  if (
    !recorded ||
    saved.project_revision !== committedProjectRevision ||
    savedActivation.state !== "pending_activation" ||
    savedActivation.generation !== pendingActivation.generation
  ) {
    throw new Error("The Antigravity OAuth credential changed while the live probe was running; retry it.");
  }

  return {
    verified: true,
    identity: "codex-router",
    model: ANTIGRAVITY_PROBE_MODEL,
    verifiedAt,
    sessionGeneration: session.session_generation,
    activationGeneration: pendingActivation.generation,
    activationPending: true,
    projectAvailable: true,
    projectProvisioningAllowed: allowOnboard,
  };
}
