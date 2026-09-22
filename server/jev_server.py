#!/usr/bin/env python3
"""Jev Codex Router — local server on 127.0.0.1:4319 for the Codex Router.

Receives Responses requests destined for the "jev/auto" model (the Codex
Router's "jev" generic provider), asks Jev (TypeSafe System One) for a tier
and a thinking depth, applies the routing policy, then relays to the Codex
Router's local caller edge (native session sharing enabled) — with no format
conversion: Responses in, Responses out, SSE relayed verbatim.

Routing policy: Jev independently classifies the mandatory-Astra policy, chooses
one capability tier, one thinking depth and a bounded route lease in a single
typed request. Code combines those answers and forces Astra for pre-project
architecture, independent final code review or risk-focused review. Routine
quality checkpoints use ordinary capability routing. Every pair uses standard
speed. Confidence is logged without changing other valid choices. There are no
keyword overrides or production target proportions.
Technical Jev failures remain fail-open to astra @medium and are logged separately.

Measured routing (v11): every user turn, error, compaction and material tool-chain
transition is judged independently. A Jev-selected lease may reuse the exact
model/effort across clean continuations, avoiding a paid router call and cache
thrash without masking changed state. Jev sees bounded cache affinity for the
current private session: actual per-model cache-read evidence, its age and the
last measured context size. A successful call with no cache read is only
``warming``; it is never mislabeled as a hit. Capability remains primary, but a
sufficient hot model avoids a needless cold replay. Provider retries inside one
call retain its decision. The compact Jev projection is
judgment input only: the executing model always receives the caller's canonical
request in full, never that projection. Routing changes only transport controls
and may add Astra's documented configuration update. The prompt_cache_key
passes through untouched, allowing each selected model to reuse its own cache
for this session; caches are not assumed to be shared across different models.
Context continuity does not depend on those cache hits: every selected model
receives the full canonical request. Cache reuse only changes how much of that
identical prefix the provider must process and bill again.

Input handling (v8): Jev sees the current ask, never the thread — the task is
Codex's last user text, with Codex's own machine-generated envelopes stripped
(goal context, plugin catalog, environment, skills) and clipped head+tail.
Thread length never reaches the judge. A tool continuation adds a bounded
batch summary (errors first) and a short assistant-intent tail. The complete
history, instructions, tools, results and compaction handoff remain exclusively
in the canonical request sent to the executing model. A short context-dependent
ask such as "continue" also gets one bounded active-task summary: the goal
envelope when present, otherwise the preceding meaningful user ask; a short
confirmation also gets the last assistant proposal.
Live data (4 516 calls): 1 291 (29%) had sent Jev nothing but a
`<codex_internal_context source="goal">` block (~6.4k chars, p50) and 23 more
only a `<recommended_plugins>` catalog — the head-clip stopped inside the
envelope, so the user's actual request was never judged.

Fail-open: any Jev error → astra @medium. Kill switch: file
~/.codex/codex-router/jev-router.off → relay astra without a decision.
Shadow: file ~/.codex/codex-router/jev-router.shadow → decide and log the
route, but serve plain astra (quality-neutral data collection).
Debug: file ~/.codex/codex-router/jev-router.debug → dump request shapes
(jev-router-debug.jsonl) and transport counters (jev-router-debug-stream.log).
All POSTs require the parent's protected Jev provider credential. Diagnostic
logs are owner-only, bounded and contain no new prompt or generated-text excerpts.
Display: streamed reasoning summaries get the routed tag appended in place
( · 🧠sol:low · ) so the Codex thread shows the picked model per call.
The same rewriter keeps one response id across a relayed stream: a fallback stream
has already crossed the local edge once, so its terminal event carries a
re-encrypted id, and the Responses consumer in front of us refuses a completion
whose id differs from the one `response.created` announced.
Non-stream callers (auto-compaction checkpoints, litellm non-stream path)
receive the SSE stream reassembled into a single JSON response object.
Balance: sufficient capability and effort for the next decision, including
compaction. Capability profiles are priors; outcome quality requires evaluation.
Log: ~/.codex/codex-router/jev-router-live.jsonl

Codex-dry fallback: when native usage is exhausted — a manual flag file
(~/.codex/codex-router/jev-router.codex-dry) or an observed quota failure
(429 / usage-limit body) — the native model ladder is replaced until the window resets:
the embedded router discovers up to two compatible configured routes locally.
Jev never receives that inventory. Environment settings can still select
distinct standard/frontier targets explicitly. A quota failure flips the state
and retries the same canonical call; a successful native
call clears an auto state (never the manual flag). A fallback call that comes
back retryable (429/5xx) is tried once on a distinct configured candidate only,
before sending any error to the client. The decided depth travels with the call, mapped onto the Go
ladder (low/high/max): a low step stays low, medium and high become high, and
xhigh or above become max.
"""
import codecs
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from local_runtime import (
    STATE, LocalServer, append_private, authorized, local_secret, protect_logs,
)

from routing_policy import (ASTRA, EFFORTS, LUNA, POLICY_VERSION, QUESTIONS, SOL, TERRA,
                            TIERS, decision_from_answers, route)

HOME = os.path.expanduser("~")
ENV_PATH = os.path.join(HOME, ".hermes", ".env")
CALLER_SECRET_PATH = os.path.join(STATE, "caller-secret")
OFF_PATH = os.path.join(STATE, "jev-router.off")
SHADOW_PATH = os.path.join(STATE, "jev-router.shadow")
DEBUG_PATH = os.path.join(STATE, "jev-router.debug")
# Opt-in route header on each assistant text message. Presentation metadata is
# removed from replayed history, including legacy trailing signatures.
SIGNATURE_PATH = os.path.join(STATE, "jev-router.signature")
LOG_PATH = os.path.join(STATE, "jev-router-live.jsonl")

LISTEN = ("127.0.0.1", 4319)
ROUTER = ("127.0.0.1", 4202)

DISPLAY_NAME = "Jev Codex Router"
VERSION = "1.5"

API = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"


# Generic ask surface (POST /ask): a thin typed pass-through to System One for
# callers that own their question set — the in-app browser chooser is the first
# one. No routing policy, no logging of the caller's state.
ASK_PATHS = ("/ask", "/v1/ask")
ASK_MAX_BYTES = 256 * 1024
ASK_MAX_STATE_CHARS = 120_000
ASK_MAX_QUESTIONS = 40
ASK_TIMEOUT = 15.0
ASK_TYPES = ("noul", "choice", "score")
RESPONSE_MAX_BYTES = 64 * 1024 * 1024
READ_TIMEOUT = 15

# Codex-dry fallback: used ONLY while native (ChatGPT) usage is exhausted.
# These environment variables remain an operator override. Without either one,
# candidates are discovered from the embedded parent router only after native
# quota exhaustion; healthy OpenAI turns pay no provider-discovery cost.
FALLBACK_OVERRIDE = bool(
    os.environ.get("JEV_FALLBACK_STANDARD") or os.environ.get("JEV_FALLBACK_FRONTIER")
)
GO_STANDARD = os.environ.get("JEV_FALLBACK_STANDARD", "deepseek/deepseek-v4.1-flash")
GO_FRONTIER = os.environ.get("JEV_FALLBACK_FRONTIER", GO_STANDARD)
GO_TANDEM = tuple(dict.fromkeys((GO_STANDARD, GO_FRONTIER)))
ROUTER_CONTROL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "router", "src", "control.mjs",
)
FALLBACK_DISCOVERY_TIMEOUT = 6.0
FALLBACK_CACHE_TTL = 30.0
_fallback_cache = {}
_fallback_cache_lock = threading.Lock()
# The conservative fallback thinking ladder. Existing Go routes declare low/high/max where the
# native native model ladder exposes low/medium/high/xhigh/max, so a depth keeps its meaning
# by landing on the middle rung instead of collapsing onto the floor: Jev says
# "medium" about work it wants done carefully, and DeepSeek documents its `low`
# as "no deep reasoning needed". The API forwarder clamps the value a second time
# onto the route's declared ladder, so nothing off-ladder can reach a provider.
TANDEM_EFFORT = {
    "none": "low", "minimal": "low", "low": "low",
    "medium": "high", "high": "high",
    "xhigh": "max", "max": "max", "ultra": "max",
}
# A status another configured candidate might still answer. Gateways can report
# a spent allowance with the same 429/503 shape as a transient one, so one more
# bounded attempt is worth it before the turn is lost. Nothing has reached
# the client at this point: the forwarder only returns a retryable status before
# it writes anything.
RETRYABLE_TANDEM_STATUS = frozenset({402, 408, 425, 429, 500, 502, 503, 504})
DRY_MANUAL_PATH = os.path.join(STATE, "jev-router.codex-dry")
DRY_STATE_PATH = os.path.join(STATE, "jev-router.codex-dry.json")
DRY_COOLDOWN_S = 30 * 60
# The edge announces when the exhausted window reopens, so an automatic flip
# lasts until that instant (plus a small skew, so the re-probe cannot race the
# reset itself) instead of a flat cooldown that keeps the fallback serving a
# window which already came back. The horizon is the backstop: a bogus or
# hostile announcement still cannot pin the router to fallback for a week.
DRY_RESET_SKEW_S = 5
DRY_MAX_HORIZON_S = 7 * 24 * 3600
QUOTA_RX = re.compile(
    r"(?i)(rate[ _-]?limit|out_of_usage|usage limit|hit your usage|insufficient_quota|quota)")

# The events that close a Responses stream and repeat the response id it opened
# with. A relayed fallback stream is rewritten onto that opening id.
TERMINAL_EVENT_TYPES = ("response.completed", "response.incomplete", "response.failed")

ERROR_RX = re.compile(
    r"(?i)(traceback|error|failed|exit code [1-9]|assertion|exception|fatal|panic)")
DIGEST_CHARS = 280
INTENT_CHARS = 160

# A compact task budget spent as a head+tail window
# so the tail survives: Codex puts its own blocks around the user's text, and the
# ask itself can be the last thing in a long paste. 250 + marker + 141 <= 400.
TASK_CHARS = 400
TASK_HEAD_CHARS = 250
TASK_TAIL_CHARS = TASK_CHARS - TASK_HEAD_CHARS - 9
TASK_CLIP_MARK = "\n[...]\n"
CONTEXT_TASK_CHARS = 320
CACHE_DEFAULT_TTL_S = 30 * 60
CACHE_MAX_TTL_S = 24 * 60 * 60
CACHE_TTL_RX = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$", re.I)
_cache_affinity_lock = threading.Lock()
_cache_affinity = {}
_route_lease_lock = threading.Lock()
_route_leases = {}

# Codex wraps every turn in machine-generated blocks (goal context, plugin
# catalog, environment, skills, mode notices). They are the longest part of a
# turn and they describe the harness, not the work, so they are removed before
# the clip instead of eating the budget. A block that is never closed simply
# does not match and is left to the clip.
ENVELOPE_TAGS = (
    "codex_internal_context", "recommended_plugins", "environment_context",
    "skills_instructions", "plugins_instructions", "apps_instructions",
    "app-context", "collaboration_mode", "model_switch", "multi_agent_mode",
    "permissions instructions", "memory_instructions",
)
ENVELOPE_RX = re.compile(
    r"<(%s)(?:\s[^<>]*)?>.*?</\1\s*>" % "|".join(re.escape(t) for t in ENVELOPE_TAGS),
    re.S)
# `<codex_internal_context source="goal">` is the one envelope whose body is a
# work objective ("Continue working toward the active thread goal. / The
# objective below is ..."), so it is what an envelope-only turn falls back to.
GOAL_BODY_RX = re.compile(
    r'<codex_internal_context(?=[^<>]*\bsource=["\']goal["\'])'
    r'(?:\s[^<>]*)?>(.*?)</codex_internal_context\s*>',
    re.S,
)
# A single envelope has been seen at 950k chars. Past this size only the two ends
# are scanned, which is where the user's text sits anyway.
ENVELOPE_SCAN_CHARS = 200_000

def load_key():
    """TYPESAFE_API_KEY: env files win (the process environment can be stale)."""
    override = os.environ.get("JEV_ENV_FILE", "").strip()
    paths = (override, ENV_PATH, os.path.join(HOME, ".jev.env"))
    seen = set()
    for path in paths:
        if not path or path in seen:
            continue
        seen.add(path)
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("TYPESAFE_API_KEY="):
                        value = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if value:
                            return value
        except OSError:
            continue
    return os.environ.get("TYPESAFE_API_KEY", "").strip()


def warn_if_key_missing():
    """Make intentional fail-open routing visible without exposing key material."""
    if load_key():
        return False
    print(
        "[jev-router] warning: TYPESAFE_API_KEY is not configured; "
        "Jev decisions will fail open to astra",
        file=sys.stderr,
        flush=True,
    )
    return True


def caller_secret():
    with open(CALLER_SECRET_PATH, encoding="utf-8") as fh:
        return fh.read().strip()


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _positive_seconds(value):
    """A positive number of seconds, or None for anything unusable."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def quota_reset_at(headers, body):
    """When the exhausted usage window reopens, or None if it is not announced.

    The local edge answers an exhausted quota with the reset instant in its
    headers (`x-codex-primary-reset-at`, and its `-after-seconds` twin); the JSON
    body repeats it as `resets_at` / `resets_in_seconds`. The relative header is
    preferred because it needs no clock agreement. When nothing usable comes
    back, the flip falls back to the bounded cooldown.
    """
    now = time.time()
    after = _positive_seconds(headers.get("x-codex-primary-reset-after-seconds"))
    if after:
        return now + after
    at = _positive_seconds(headers.get("x-codex-primary-reset-at"))
    if at and at > now:
        return at
    if not body:
        return None
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    fields = error if isinstance(error, dict) else payload
    after = _positive_seconds(fields.get("resets_in_seconds"))
    if after:
        return now + after
    at = _positive_seconds(fields.get("resets_at"))
    return at if at and at > now else None


def native_dry():
    """Reason native usage is considered exhausted, or None while it is fine.

    The manual flag wins; the auto state carries an expiry so a stale flip
    can never pin the router to fallback forever.
    """
    if os.path.exists(DRY_MANUAL_PATH):
        return "manual"
    state = _read_json(DRY_STATE_PATH)
    if isinstance(state, dict) and float(state.get("until") or 0) > time.time():
        return str(state.get("reason") or "quota")
    return None


def mark_native_dry(reason, resets_at=None):
    """Flip to external fallback, for as long as the exhausted window stays shut.

    `resets_at` is the instant the edge said the window reopens. Ending the
    state just after it is what sends the next call back to the native native model ladder
    as soon as the quota returns; without that announcement the flip keeps the
    bounded cooldown instead.
    """
    now = time.time()
    until = now + DRY_COOLDOWN_S
    if resets_at and resets_at > now:
        until = min(resets_at + DRY_RESET_SKEW_S, now + DRY_MAX_HORIZON_S)
    try:
        tmp = DRY_STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({
                "reason": reason,
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "until": until,
                "until_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(until)),
            }, fh)
        os.replace(tmp, DRY_STATE_PATH)
    except OSError:
        pass


def clear_native_dry():
    try:
        os.remove(DRY_STATE_PATH)
    except OSError:
        pass


def tandem_effort(effort, native_model=None):
    """Map a decided depth onto the rungs the Go tandem accepts."""
    if effort in TANDEM_EFFORT:
        return TANDEM_EFFORT[effort]
    # An absent or unknown depth keeps the tier's own habit: the frontier goes as
    # deep as it can, everything else starts at the middle rung.
    return "max" if native_model == ASTRA else "high"


def other_tandem(target):
    """The sibling Go model, for one bounded fallback attempt."""
    return next((model for model in GO_TANDEM if model != target), None)


def dry_target(native_model, effort):
    """Codex-dry tandem: frontier-tier steps -> GLM, everything else -> deepseek."""
    target = GO_FRONTIER if native_model == ASTRA else GO_STANDARD
    return target, tandem_effort(effort, native_model)


def _node_binary():
    configured = os.environ.get("JEV_NODE")
    candidates = (
        configured,
        shutil.which("node"),
        os.path.join(HOME, ".local", "bin", "node"),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    )
    return next((candidate for candidate in candidates
                 if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK)), None)


def _fallback_constraints(payload):
    """Small local capability hints; none of this state is sent to Jev."""
    try:
        encoded = json.dumps(payload, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = ""

    body = payload if isinstance(payload, dict) else {}
    tools = body.get("tools")
    tools = tools if isinstance(tools, list) else []
    inp = body.get("input")

    def has_typed_part(value, part_types):
        if isinstance(value, list):
            return any(has_typed_part(item, part_types) for item in value)
        if not isinstance(value, dict):
            return False
        if value.get("type") in part_types:
            return True
        return any(
            has_typed_part(value.get(key), part_types)
            for key in ("content", "output")
            if isinstance(value.get(key), (dict, list))
        )

    hosted_search_types = {"web_search", "web_search_preview"}
    hosted_search = any(
        isinstance(tool, dict) and tool.get("type") in hosted_search_types
        for tool in tools
    )
    if isinstance(body.get("tool_choice"), dict):
        hosted_search = (
            body["tool_choice"].get("type") in hosted_search_types or hosted_search
        )
    include = body.get("include")
    hosted_search = hosted_search or "web_search_options" in body or any(
        isinstance(item, str) and item.startswith("web_search_call.")
        for item in (include if isinstance(include, list) else [])
    )

    has_search_history = isinstance(inp, list) and any(
        isinstance(item, dict) and item.get("type") == "web_search_call"
        for item in inp
    )

    multi_agent_names = {
        "spawn_agent",
        "create_subagent",
        "collaboration.spawn_agent",
        "collaboration__spawn_agent",
        "multi_agent_v1__spawn_agent",
        "multi_agent_v2__spawn_agent",
    }
    has_multi_agent = any(
        isinstance(tool, dict)
        and (
            tool.get("name") in multi_agent_names
            or (
                tool.get("namespace") == "collaboration"
                and tool.get("name") == "spawn_agent"
            )
        )
        for tool in tools
    )
    return {
        # Same conservative direction as the parent router: reject a fallback
        # that obviously cannot hold the canonical replay.
        "estimated_tokens": max(1, (len(encoded.encode("utf-8")) + 2) // 3),
        "image": has_typed_part(inp, {"input_image", "image_url"}),
        "multi_agent_v2": has_multi_agent,
        "search_mode": "hosted" if hosted_search else None,
        "search_history": has_search_history,
    }


def fallback_candidates(native_model, payload):
    """Ordered exact routes after native exhaustion, never including jev/auto."""
    if FALLBACK_OVERRIDE:
        primary = GO_FRONTIER if native_model == ASTRA else GO_STANDARD
        return [
            model for model in (primary, *(item for item in GO_TANDEM if item != primary))
            if model != "jev/auto" and model not in TIERS
        ]

    constraints = _fallback_constraints(payload)
    estimated_bucket = (
        (constraints["estimated_tokens"] + 8191) // 8192
    ) * 8192
    cache_key = (
        estimated_bucket,
        constraints["image"],
        constraints["multi_agent_v2"],
        constraints["search_mode"],
        constraints["search_history"],
    )
    now = time.monotonic()
    with _fallback_cache_lock:
        cached = _fallback_cache.get(cache_key)
        if cached and now - cached[0] < FALLBACK_CACHE_TTL:
            return list(cached[1])

    node = _node_binary()
    if not node:
        return []
    command = [
        node, ROUTER_CONTROL, "failover", "candidates",
        "--estimated-tokens", str(estimated_bucket),
        "--limit", "2",
    ]
    if constraints["image"]:
        command.append("--image")
    if constraints["multi_agent_v2"]:
        command.append("--multi-agent-v2")
    if constraints["search_mode"]:
        command.extend(("--search-mode", constraints["search_mode"]))
    if constraints["search_history"]:
        command.append("--search-history")
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=FALLBACK_DISCOVERY_TIMEOUT,
            check=False,
        )
        parsed = json.loads(result.stdout) if result.returncode == 0 else {}
        candidates = []
        seen_slugs = set()
        seen_providers = set()
        for entry in parsed.get("candidates") or []:
            if not isinstance(entry, dict):
                continue
            slug = entry.get("slug")
            provider = entry.get("provider")
            if not isinstance(slug, str) or slug == "jev/auto" or slug in seen_slugs:
                continue
            # Current embedded routers already collapse canonical quota
            # families. Keep this executor-side guard for stale/mixed installs:
            # repeated rows from one provider must not consume both attempts.
            provider = provider.strip() if isinstance(provider, str) else ""
            if provider and provider in seen_providers:
                continue
            seen_slugs.add(slug)
            if provider:
                seen_providers.add(provider)
            candidates.append(slug)
            if len(candidates) >= 2:
                break
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        candidates = []
    with _fallback_cache_lock:
        _fallback_cache[cache_key] = (now, tuple(candidates))
    return candidates


def call_jev(key, state, questions=None, timeout=4.0):
    body = json.dumps({"model": MODEL, "state": state,
                       "questions": QUESTIONS if questions is None else questions}).encode()
    req = urllib.request.Request(
        API,
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_jev_routed(key, state, questions=None, timeout=4.0):
    """One System One call, on the direct TypeSafe API."""
    return call_jev(key, state, questions, timeout=timeout)


def validate_ask(body):
    """Check a POST /ask body. Returns (state, questions, error) — error is None when valid.

    Bounds are the whole point: the endpoint spends TypeSafe credits on loopback,
    so it accepts only a JSON-serialisable state under the size cap and a small
    set of well-formed typed questions.
    """
    if not isinstance(body, dict):
        return None, None, "json object expected"
    state = body.get("state")
    if not isinstance(state, (str, dict, list)):
        return None, None, "state must be a string, object or array"
    try:
        size = len(json.dumps(state, ensure_ascii=False))
    except (TypeError, ValueError):
        return None, None, "state is not JSON-serialisable"
    if size > ASK_MAX_STATE_CHARS:
        return None, None, f"state too large ({size} > {ASK_MAX_STATE_CHARS} chars)"
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        return None, None, "questions must be a non-empty object"
    if len(questions) > ASK_MAX_QUESTIONS:
        return None, None, f"too many questions ({len(questions)} > {ASK_MAX_QUESTIONS})"
    for name, question in questions.items():
        if not isinstance(name, str) or not name:
            return None, None, "question names must be non-empty strings"
        if not isinstance(question, dict):
            return None, None, f"question {name} must be an object"
        qtype = question.get("type")
        if qtype not in ASK_TYPES:
            return None, None, f"question {name} has unsupported type {qtype!r}"
        if not isinstance(question.get("instructions"), (str, dict, list)):
            return None, None, f"question {name} needs instructions"
        criteria = question.get("criteria")
        if qtype == "choice" and (not isinstance(criteria, dict) or not criteria):
            return None, None, f"question {name} needs a non-empty criteria map"
        if qtype == "score" and not isinstance(criteria, list):
            return None, None, f"question {name} needs a criteria list"
    return state, questions, None


def _content_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if isinstance(item, dict) and item.get("type") in ("input_text", "output_text", "text"):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def strip_envelopes(text):
    """Codex's own wrapper blocks, out of the text the judge reads.

    Whole blocks go: their bodies describe the harness, not the work, and they
    are by far the longest part of a turn. When a turn holds nothing else, the
    goal block's body is salvaged -- it carries the thread objective, and an
    empty task would push the call onto the caller's fail-open path. A catalog-
    or environment-only turn holds no request at all, so it keeps nothing.
    """
    if text.startswith("# AGENTS.md instructions for ") and "</INSTRUCTIONS>" in text:
        text = text.split("</INSTRUCTIONS>", 1)[1]
    if len(text) <= ENVELOPE_SCAN_CHARS:
        scanned = text
    else:
        scanned = text[:ENVELOPE_SCAN_CHARS] + "\n" + text[-ENVELOPE_SCAN_CHARS:]
    stripped = ENVELOPE_RX.sub("\n", scanned).strip()
    if stripped:
        return stripped
    goal = GOAL_BODY_RX.search(scanned)
    return goal.group(1).strip() if goal else ""


def clip_task(text):
    """Bound the task to Jev's calibrated budget, keeping head and tail."""
    text = text.strip()
    if len(text) <= TASK_CHARS:
        return text
    return text[:TASK_HEAD_CHARS] + TASK_CLIP_MARK + text[-TASK_TAIL_CHARS:]


def task_for_jev(text):
    """The current ask, out of Codex's envelopes, in <= TASK_CHARS characters.

    Empty means the turn carried no request (a catalog- or environment-only
    turn), which the caller reads as "no judgement to make here".
    """
    return clip_task(strip_envelopes(text))


def context_dependent(task):
    """Give short asks bounded context; don't guess intent from keyword lists."""
    return bool(task) and len(task) <= 120


def goal_for_jev(text):
    """Bounded active objective from Codex's goal envelope, when it exists."""
    match = GOAL_BODY_RX.search(text[:ENVELOPE_SCAN_CHARS])
    return clip_task(match.group(1))[:CONTEXT_TASK_CHARS] if match else ""


def extract(payload):
    """Current ask, assistant tail and only the task context needed to judge it."""
    inp = payload.get("input")
    last_user = last_assistant = ""
    prior_task = ""
    n_items = 0
    has_image = False
    tool_tail = False
    if isinstance(inp, str):
        last_user = inp
        n_items = 1
    elif isinstance(inp, list):
        n_items = len(inp)
        tail = inp[-6:]
        for item in tail:
            if isinstance(item, dict) and item.get("type") == "function_call_output":
                tool_tail = True
            if isinstance(item, dict) and isinstance(item.get("content"), list):
                for part in item["content"]:
                    if isinstance(part, dict) and part.get("type") in ("input_image", "image_url"):
                        has_image = True
        for item in reversed(inp):
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if role == "user":
                text = _content_text(item.get("content"))
                if not task_for_jev(text):
                    continue
                if not last_user:
                    last_user = text
                elif not prior_task:
                    prior_task = task_for_jev(text)
            elif role == "assistant" and not last_assistant:
                last_assistant = _content_text(item.get("content"))
            if last_user and prior_task and last_assistant:
                break
    task = task_for_jev(last_user)
    signals = {
        "n_items": n_items,
        "has_image": has_image,
        "tool_history": tool_tail,
    }
    if context_dependent(task):
        context_task = goal_for_jev(last_user) or prior_task
        if context_task:
            signals["context_task"] = context_task[:CONTEXT_TASK_CHARS]
    return task, last_assistant.strip(), signals


def _output_text(output):
    """Best-effort text of a tool output item (str, list of parts, or dict)."""
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        parts = []
        for item in output:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                for key in ("text", "output", "content"):
                    value = item.get(key)
                    if isinstance(value, str):
                        parts.append(value)
                        break
        return "\n".join(parts)
    if isinstance(output, dict):
        for key in ("text", "output", "content"):
            value = output.get(key)
            if isinstance(value, str):
                return value
        return json.dumps(output)[:4000]
    return ""


def classify(payload):
    """What this model call is for, read off the input tail: user turn / tool step."""
    inp = payload.get("input")
    detail = {"step_type": "other", "digest": "", "errored": False, "n_items": 0}
    if isinstance(inp, str):
        detail["step_type"] = "user_turn"
        return detail
    if not isinstance(inp, list):
        return detail
    detail["n_items"] = len(inp)
    last = inp[-1] if inp else None
    if isinstance(last, dict):
        ltype = last.get("type")
        if ltype in ("function_call_output", "custom_tool_call_output"):
            text = _output_text(last.get("output"))
            detail["step_type"] = "tool_step"
            detail["digest"] = text.strip()[-DIGEST_CHARS:] if text else ""
            detail["errored"] = bool(ERROR_RX.search(text[-4000:]))
            call_id = last.get("call_id")
            if call_id:
                for item in reversed(inp[:-1]):
                    if (isinstance(item, dict) and item.get("call_id") == call_id
                            and item.get("type") in ("function_call", "custom_tool_call")):
                        detail["tool_call"] = {"name": str(item.get("name") or "")[:160]}
                        break
            # Preserve a bounded view of the entire contiguous tool-result batch.
            # Error counts cover all results, excerpts only the first 3 errors or
            # (when clean) the last 3 results. Arguments never enter the dossier.
            batch = []
            for item in reversed(inp):
                if not isinstance(item, dict) or item.get("type") not in (
                    "function_call_output", "custom_tool_call_output"
                ):
                    break
                batch.append(item)
            if len(batch) > 1:
                batch.reverse()
                calls = {item.get("call_id"): str(item.get("name") or "")[:80]
                         for item in inp if isinstance(item, dict)
                         and item.get("type") in ("function_call", "custom_tool_call")}
                rows, errors = [], []
                for item in batch:
                    text = _output_text(item.get("output")).strip()
                    error = ERROR_RX.search(text[-4000:])
                    excerpt = (text[-4000:][max(0, error.start() - 30):][:120]
                               if error else text[-120:])
                    row = {"tool": calls.get(item.get("call_id"), ""),
                           "error": bool(error), "result": excerpt}
                    rows.append(row)
                    if error:
                        errors.append(row)
                detail["tool_batch"] = {
                    "count": len(batch), "errors": len(errors),
                    "results": errors[:3] if errors else rows[-3:],
                }
                detail["errored"] = bool(errors)
        elif last.get("role") == "user":
            detail["step_type"] = "user_turn"
    return detail


def jev_state(task, prev_assistant, signals, step, cache_state=None):
    """Strictly bounded decision dossier; never reused as execution context."""
    state = {"task": task, "step": step["step_type"]}
    if cache_state:
        state["cache_state"] = cache_state
    if signals.get("context_task"):
        state["active_task"] = signals["context_task"]
    if signals.get("has_image"):
        state["image"] = True
    if step["step_type"] != "user_turn" and prev_assistant:
        state["intent_tail"] = prev_assistant[-INTENT_CHARS:]
    elif context_dependent(task) and prev_assistant:
        state["previous_proposal"] = prev_assistant[-INTENT_CHARS:]
    if step["step_type"] == "tool_step":
        if step.get("tool_batch"):
            state["tool_batch"] = step["tool_batch"]
        elif step["digest"]:
            state["tool_result_tail"] = step["digest"]
        if step.get("errored"):
            state["tool_error"] = True
        if step.get("tool_call", {}).get("name"):
            state["tool"] = step["tool_call"]["name"]
    return state


def decision_dossier(payload, cache_state=None):
    """Shared projection for live traffic, replay and calibration."""
    task, previous, signals = extract(payload)
    return jev_state(task, previous, signals, classify(payload), cache_state)


def _debug_shape(payload):
    """Bounded request shape for wire debugging (jev-router.debug flag)."""
    inp = payload.get("input")
    items = inp if isinstance(inp, list) else []
    tail = []
    for item in items[-8:]:
        if isinstance(item, dict):
            tail.append(item.get("type") or item.get("role"))
    names = []
    for tool in (payload.get("tools") or [])[:10]:
        if isinstance(tool, dict):
            names.append(tool.get("name") or (tool.get("function") or {}).get("name"))
    return {
        "keys": sorted(payload.keys()),
        "model": payload.get("model"),
        "reasoning": payload.get("reasoning"),
        "include": payload.get("include"),
        "stream": payload.get("stream"),
        "store": payload.get("store"),
        "tool_choice": payload.get("tool_choice"),
        "parallel_tool_calls": payload.get("parallel_tool_calls"),
        "instructions_chars": len(payload.get("instructions") or ""),
        "n_input": len(items),
        "tail": tail,
        "tools": names,
    }


ROUTE_GLYPHS = {
    "gpt-5.6-luna": ("luna", "⚡"),      # cheap tier, adaptive thinking
    "gpt-5.6-sol": ("sol", "🧠"),        # reasoning workhorse
    "gpt-6-astra": ("astra", "🚀"),      # frontier
    "gpt-5.6-terra": ("terra", "🌍"),
}
TANDEM_GLYPHS = {
    "deepseek-v4.1-flash": ("deepseek", "🐳"),  # Go standard (native dry)
    "glm-5.3-flash": ("glm", "✨"),             # Go frontier (native dry)
}


def cache_scope(payload, task):
    """Non-reversible session id for cache telemetry; raw cache keys never log."""
    raw = payload.get("prompt_cache_key")
    if isinstance(raw, str) and raw.strip():
        source = "prompt:" + raw.strip()
    else:
        source = "task:" + (task or "")
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def _cache_ttl_seconds(payload):
    """Caller cache TTL, bounded to the lifetime useful for in-memory affinity."""
    options = payload.get("prompt_cache_options")
    raw = options.get("ttl") if isinstance(options, dict) else None
    if not isinstance(raw, str):
        return CACHE_DEFAULT_TTL_S
    match = CACHE_TTL_RX.match(raw)
    if not match:
        return CACHE_DEFAULT_TTL_S
    scale = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2).lower()]
    return min(max(float(match.group(1)) * scale, 1), CACHE_MAX_TTL_S)


def _estimated_context_k(payload):
    """Approximate canonical input tokens in thousands without exposing prompt text."""
    try:
        size = len(json.dumps(
            payload.get("input"), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8"))
    except (TypeError, ValueError):
        return None
    return max(1, int(round(size / 4000.0)))


def cache_affinity(scope, payload, now=None):
    """Bounded measured cache evidence for one prompt-cache scope.

    Only a real prompt_cache_key is safe for continuity. The task-derived scope
    remains useful for aggregate telemetry but may repeat across unrelated calls.
    """
    raw_key = payload.get("prompt_cache_key")
    if not isinstance(raw_key, str) or not raw_key.strip():
        return None
    now = time.time() if now is None else now
    ttl = _cache_ttl_seconds(payload)
    with _cache_affinity_lock:
        entry = _cache_affinity.get(scope)
        if not isinstance(entry, dict):
            return None
        models = {}
        for model, evidence in entry.get("models", {}).items():
            if model not in TIERS or not isinstance(evidence, dict):
                continue
            seen_at = evidence.get("seen_at")
            if not isinstance(seen_at, (int, float)) or now - seen_at > ttl:
                continue
            models[model] = evidence
        if not models:
            _cache_affinity.pop(scope, None)
            return None
        entry["models"] = models
        last_model = entry.get("last_model")
        if last_model not in models:
            last_model = max(models, key=lambda model: models[model]["seen_at"])
            entry["last_model"] = last_model
        result = {
            "last_model": route_label(last_model)[0],
            "context_k": (
                (models[last_model].get("input_tokens") or 0) // 1000
                or _estimated_context_k(payload)
            ),
            "models": {},
        }
        for model in TIERS:
            evidence = models.get(model)
            if not evidence:
                continue
            result["models"][route_label(model)[0]] = {
                "state": evidence.get("state", "unknown"),
                "read_pct": evidence.get("read_pct"),
                "age_s": max(0, int(now - evidence["seen_at"])),
                "effort": evidence.get("effort"),
            }
        return result


def remember_cache_model(scope, payload, model, status, usage=None, effort=None, now=None):
    """Remember measured native cache evidence; HTTP success alone is not a hit."""
    raw_key = payload.get("prompt_cache_key")
    if (
        status != 200
        or model not in TIERS
        or not isinstance(raw_key, str)
        or not raw_key.strip()
    ):
        return
    now = time.time() if now is None else now
    ttl = _cache_ttl_seconds(payload)
    counts = usage_counts(usage)
    inp = counts.get("input_tokens") if counts else None
    cached = counts.get("cached_input_tokens") if counts else None
    if isinstance(inp, int) and isinstance(cached, int) and 0 <= cached <= inp:
        state = "hot" if cached > 0 else "warming"
        read_pct = round(100.0 * cached / inp, 1) if inp else 0.0
    else:
        state, read_pct = "unknown", None
    with _cache_affinity_lock:
        entry = _cache_affinity.setdefault(scope, {"models": {}})
        entry["models"] = {
            known_model: evidence
            for known_model, evidence in entry.get("models", {}).items()
            if known_model in TIERS and isinstance(evidence, dict)
            and isinstance(evidence.get("seen_at"), (int, float))
            and now - evidence["seen_at"] <= ttl
        }
        entry["models"][model] = {
            "seen_at": now,
            "state": state,
            "input_tokens": inp,
            "cached_input_tokens": cached,
            "cache_write_input_tokens": (
                counts.get("cache_write_input_tokens") if counts else None
            ),
            "read_pct": read_pct,
            "effort": effort if effort in EFFORTS else None,
        }
        entry["last_model"] = model


def _turn_fingerprint(payload):
    """Stable private identity of the latest user turn, never persisted or logged."""
    inp = payload.get("input")
    text = inp if isinstance(inp, str) else ""
    user_count = 1 if isinstance(inp, str) else 0
    if isinstance(inp, list):
        user_count = sum(
            1 for item in inp
            if isinstance(item, dict) and item.get("role") == "user"
        )
        for index in range(len(inp) - 1, -1, -1):
            item = inp[index]
            if isinstance(item, dict) and item.get("role") == "user":
                text = _content_text(item.get("content"))
                break
    if not text:
        return None
    return hashlib.sha256(f"{user_count}:{text}".encode("utf-8")).hexdigest()[:20]


def _lease_contract_fingerprint(payload):
    """Private identity of request semantics that must invalidate a lease."""
    inp = payload.get("input")
    checkpoints = []
    if isinstance(inp, list):
        checkpoints = [
            item for item in inp
            if isinstance(item, dict)
            and (item.get("type") in ("compaction", "compaction_summary")
                 or item.get("role") in ("system", "developer"))
        ]
    contract = {
        "instructions": payload.get("instructions"),
        "tools": payload.get("tools"),
        "tool_choice": payload.get("tool_choice"),
        "truncation": payload.get("truncation"),
        "context_management": payload.get("context_management"),
        "checkpoints": checkpoints,
    }
    try:
        encoded = json.dumps(
            contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:20]


def _latest_tool_batch_names(payload):
    """Resolve every tool name in the latest contiguous result batch."""
    inp = payload.get("input")
    if not isinstance(inp, list):
        return ()
    results = []
    for item in reversed(inp):
        if not isinstance(item, dict) or item.get("type") not in (
            "function_call_output", "custom_tool_call_output"
        ):
            break
        results.append(item)
    if not results:
        return ()
    call_ids = {item.get("call_id") for item in results if item.get("call_id")}
    calls = {
        item.get("call_id"): str(item.get("name") or "")
        for item in inp
        if isinstance(item, dict)
        and item.get("type") in ("function_call", "custom_tool_call")
        and item.get("call_id") in call_ids
    }
    return tuple(calls.get(item.get("call_id"), "") for item in reversed(results))


def route_lease(scope, payload, step, now=None):
    """Reuse a prior semantic route only for an unchanged, clean continuation."""
    now = time.time() if now is None else now
    fingerprint = _turn_fingerprint(payload)
    contract = _lease_contract_fingerprint(payload)
    with _route_lease_lock:
        entry = _route_leases.get(scope)
        if not isinstance(entry, dict):
            return None
        if (
            step.get("step_type") != "tool_step"
            or step.get("errored")
            or not fingerprint
            or entry.get("turn") != fingerprint
            or not contract
            or entry.get("contract") != contract
            or now - entry.get("seen_at", 0) > _cache_ttl_seconds(payload)
        ):
            _route_leases.pop(scope, None)
            return None
        horizon = entry.get("lease")
        if horizon == "one_call":
            _route_leases.pop(scope, None)
            return None
        if horizon == "tool_chain":
            tools = _latest_tool_batch_names(payload)
            previous_tool = entry.get("tool")
            if not tools or any(not tool for tool in tools):
                _route_leases.pop(scope, None)
                return None
            if previous_tool and any(tool != previous_tool for tool in tools):
                _route_leases.pop(scope, None)
                return None
            if len(set(tools)) != 1:
                _route_leases.pop(scope, None)
                return None
            entry["tool"] = tools[-1]
        entry["seen_at"] = now
        return dict(entry["decision"])


def remember_route_lease(scope, payload, step, decision, status, now=None):
    """Persist only successful, explicitly scoped Jev decisions in memory."""
    raw_key = payload.get("prompt_cache_key")
    if (
        status != 200
        or not isinstance(raw_key, str)
        or not raw_key.strip()
        or not isinstance(decision, dict)
        or decision.get("lease") == "one_call"
    ):
        with _route_lease_lock:
            _route_leases.pop(scope, None)
        return
    fingerprint = _turn_fingerprint(payload)
    contract = _lease_contract_fingerprint(payload)
    if not fingerprint or not contract:
        return
    now = time.time() if now is None else now
    preserved = {
        key: decision.get(key)
        for key in (
            "model", "base_model", "astra_policy", "effort", "lease", "speed",
            "gate", "confidence", "probabilities", "chosen_probability",
            "policy_version",
        )
    }
    with _route_lease_lock:
        _route_leases[scope] = {
            "turn": fingerprint,
            "contract": contract,
            "lease": decision["lease"],
            "tool": (
                step.get("tool_call", {}).get("name")
                if step.get("step_type") == "tool_step"
                else None
            ),
            "seen_at": now,
            "decision": preserved,
        }


def route_label(model):
    """(short name, glyph) of a routed call — the vocabulary of both tags."""
    short, glyph = ROUTE_GLYPHS.get(model, (None, None))
    if not short:
        leaf = (model or "?").split("/")[-1]
        short, glyph = TANDEM_GLYPHS.get(leaf, (leaf, "⚡"))
    return short, glyph


def route_marker(model, effort):
    """Visible tag for a routed call, separators on both sides: ' · 🧠sol:low · '.

    The client concatenates reasoning summary parts with no separator, so the
    tag has to carry its own trailing one (" · ") or it glues to the next part.
    """
    short, glyph = route_label(model)
    return f" · {glyph} {short}" + (f":{effort}" if effort else "") + " · "


def answer_signature(shown):
    """Leading model/thinking label for each assistant message, when enabled."""
    if not os.path.exists(SIGNATURE_PATH):
        return None
    short, glyph = route_label(shown.get("model"))
    effort = shown.get("effort") or "non spécifié"
    return f"**{glyph} {short} · thinking: {effort}**\n\n"


def presentation_signature(payload, shown):
    """Never prefix data constrained by a JSON response format."""
    text = payload.get("text")
    fmt = text.get("format") if isinstance(text, dict) else None
    legacy = payload.get("response_format")
    if any(isinstance(value, dict) and value.get("type") not in (None, "text")
           for value in (fmt, legacy)):
        return None
    return answer_signature(shown)


# Only our exact presentation forms, at the boundaries of assistant text.
# Retain the trailing form solely for old transcripts.
HEADER_RX = re.compile(
    r"\A\*\*(?:⚡|🧠|🚀|🌍|🐳|✨) [A-Za-z0-9._/-]+ · thinking: "
    r"(?:low|medium|high|xhigh|max|non spécifié)\*\*\r?\n\r?\n")
SIGNATURE_RX = re.compile(
    r"\s*\n*—\s+(?:⚡|🧠|🚀|🌍|🐳|✨)\s+[A-Za-z0-9._/-]+"
    r"(?:\s+·\s+(?:low|medium|high|xhigh|max))?\s*$")


def strip_signatures(payload):
    """Remove route annotations before classification and forwarding, even if disabled."""
    items = payload.get("input")
    if not isinstance(items, list):
        return 0
    removed = 0
    for item in items:
        if not isinstance(item, dict) or item.get("role") != "assistant":
            continue
        content = item.get("content")
        if isinstance(content, str):
            cleaned = SIGNATURE_RX.sub("", HEADER_RX.sub("", content))
            if cleaned != content:
                item["content"] = cleaned
                removed += 1
            continue
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            text = block.get("text")
            if not isinstance(text, str) or not text:
                continue
            cleaned = SIGNATURE_RX.sub("", HEADER_RX.sub("", text))
            if cleaned != text:
                block["text"] = cleaned
                removed += 1
    return removed


def usage_counts(usage):
    """Allowlist token counters; absent usage stays unknown, never zero."""
    if not isinstance(usage, dict):
        return None
    out = {}
    for name in ("input_tokens", "output_tokens", "total_tokens",
                 "cached_input_tokens", "cache_write_input_tokens"):
        value = usage.get(name)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            out[name] = value
    for group, name in (("input_tokens_details", "cached_tokens"),
                        ("input_tokens_details", "cache_write_tokens"),
                        ("output_tokens_details", "reasoning_tokens")):
        details = usage.get(group)
        value = details.get(name) if isinstance(details, dict) else None
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            if name == "cached_tokens":
                out["cached_input_tokens"] = value
            elif name == "cache_write_tokens":
                out["cache_write_input_tokens"] = value
            else:
                out[name] = value
    return out or None


def _astra_configuration_eligible(payload):
    """Whether this Responses request can safely carry an Astra config update."""
    items = payload.get("input")
    if not isinstance(items, list) or not items:
        return False
    if payload.get("truncation") == "auto" or payload.get("context_management"):
        return False
    if any(
        isinstance(item, dict)
        and item.get("type") in ("configuration_update", "compaction", "compaction_summary")
        for item in items
    ):
        return False
    return any(isinstance(item, dict) and item.get("role") == "user" for item in items)


def apply_route_payload(payload, model, effort, original_reasoning, injected_update=None):
    """Apply one attempt's route while preserving the stable request prefix.

    Astra can change reasoning for the next user message through a
    configuration_update, leaving the request-level reasoning prefix unchanged.
    Retries remove the update by object identity before targeting another model.
    """
    items = payload.get("input")
    if injected_update is not None and isinstance(items, list):
        payload["input"] = [item for item in items if item is not injected_update]
        items = payload["input"]
    if original_reasoning is None:
        payload.pop("reasoning", None)
    else:
        payload["reasoning"] = dict(original_reasoning)

    payload["model"] = model
    transport = "request"
    next_update = None
    base_effort = (
        original_reasoning.get("effort")
        if isinstance(original_reasoning, dict)
        else None
    )
    if (
        model == ASTRA
        and effort in EFFORTS
        and base_effort in EFFORTS
        and effort != base_effort
        and _astra_configuration_eligible(payload)
    ):
        next_update = {"type": "configuration_update", "reasoning": {"effort": effort}}
        insert_at = max(
            index for index, item in enumerate(payload["input"])
            if isinstance(item, dict) and item.get("role") == "user"
        )
        payload["input"].insert(insert_at, next_update)
        transport = "configuration_update"
    elif effort:
        reasoning = dict(original_reasoning) if isinstance(original_reasoning, dict) else {}
        reasoning["effort"] = effort
        payload["reasoning"] = reasoning
    payload["service_tier"] = "default"
    payload["stream"] = True
    return next_update, transport


class SummaryMarker:
    """Append the routed tag to reasoning summaries (the thread's thinking blocks).

    The last delta of each summary part is held back by one event so the tag can
    be appended in place to it and to the matching done events: no fabricated
    events, no sequence-number surgery, byte-exact pass-through everywhere else.

    A ``signature`` now means a leading route header on every assistant text
    message, including commentary and messages without a phase. The first text
    delta receives it immediately; done events and full items carry the same
    prefix. Tool arguments and reasoning content never receive this header.

    The same pass keeps a relayed stream's response id consistent. A Codex-dry
    call crosses the local edge, which encrypts response ids, so the terminal
    event of the stream we receive carries a freshly encoded id; the Responses
    transform in front of the router reads that as a completion that renamed
    itself and replaces the whole turn with an error event. The id announced by
    `response.created` is the one that travels, so a terminal event is rewritten
    onto it before the block leaves.
    """

    def __init__(self, marker, signature=None):
        self.marker = marker
        self.signature = signature or None
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buf = ""
        self._block = []
        self._held = None  # (key, block_lines)
        self._headed = set()  # messages whose streamed text already received a header
        self._header_parts = {}  # first nonempty text part of each message
        self._response_id = None  # the id this stream's completion must repeat
        self._response = None  # response.created snapshot for a synthetic failure terminal
        self._sequence_number = -1
        self.exposed = False
        self.transport_error = None
        self.usage = None
        self.terminal_type = None

    @staticmethod
    def _emit(lines):
        return "".join(line + "\n" for line in lines) + "\n"

    @staticmethod
    def _event_type(block):
        for line in block:
            if line.startswith("event: "):
                return line[7:].strip()
        return ""

    @staticmethod
    def _data(block):
        for line in block:
            if line.startswith("data: "):
                try:
                    return json.loads(line[6:])
                except ValueError:
                    return None
        return None

    @staticmethod
    def _rebuild(block, data):
        return [
            f"data: {json.dumps(data, ensure_ascii=False)}" if line.startswith("data: ") else line
            for line in block
        ]

    def _tag(self, value):
        if not isinstance(value, str) or not value or self.marker in value:
            return value
        return value + self.marker

    def _sign(self, value):
        """Prefix a full text representation once, preserving an empty output."""
        if not self.signature or not isinstance(value, str) or not value:
            return value
        return value if value.startswith(self.signature) else self.signature + value

    @staticmethod
    def _message_key(data):
        return data.get("item_id") or ("output", data.get("output_index", 0))

    def _sign_done_block(self, block):
        data = self._data(block)
        if not isinstance(data, dict):
            return block
        target = data.get("part") if isinstance(data.get("part"), dict) else data
        text = target.get("text")
        if isinstance(text, str) and text:
            key = self._message_key(data)
            index = data.get("content_index", 0)
            if self._header_parts.setdefault(key, index) == index:
                target["text"] = self._sign(text)
        return self._rebuild(block, data)

    def _sign_message_item(self, item):
        """One header on the first nonempty text part of an assistant message."""
        if (not self.signature or not isinstance(item, dict)
                or item.get("type") != "message" or item.get("role") not in (None, "assistant")):
            return
        for index, part in enumerate(item.get("content") or []):
            if (isinstance(part, dict) and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str) and part["text"]):
                part["text"] = self._sign(part["text"])
                self._header_parts.setdefault(item.get("id"), index)
                return

    def _flush_held(self, out):
        if self._held is not None:
            out.append(self._emit(self._held[1]))
            self._held = None

    def _tag_delta_block(self, block):
        data = self._data(block)
        if not isinstance(data, dict):
            return block
        data["delta"] = self._tag(data.get("delta"))
        return self._rebuild(block, data)

    def _tag_done_block(self, block):
        data = self._data(block)
        if not isinstance(data, dict):
            return block
        if "text" in data:
            data["text"] = self._tag(data.get("text"))
        part = data.get("part")
        if isinstance(part, dict) and "text" in part:
            part["text"] = self._tag(part.get("text"))
        return self._rebuild(block, data)

    def _tag_item_block(self, block):
        data = self._data(block)
        if not isinstance(data, dict):
            return block
        item = data.get("item")
        if isinstance(item, dict) and item.get("type") == "reasoning":
            for part in item.get("summary") or []:
                if isinstance(part, dict) and "text" in part:
                    part["text"] = self._tag(part.get("text"))
        self._sign_message_item(item)
        response = data.get("response")
        if isinstance(response, dict):
            for item in response.get("output") or []:
                if isinstance(item, dict) and item.get("type") == "reasoning":
                    for part in item.get("summary") or []:
                        if isinstance(part, dict) and "text" in part:
                            part["text"] = self._tag(part.get("text"))
                self._sign_message_item(item)
        return self._rebuild(block, data)

    def _process_block(self, block):
        out = []
        data = self._data(block)
        if not isinstance(data, dict):
            self._flush_held(out)
            out.append(self._emit(block))
            return out
        dtype = data.get("type")
        sequence_number = data.get("sequence_number")
        if isinstance(sequence_number, int) and not isinstance(sequence_number, bool):
            self._sequence_number = max(self._sequence_number, sequence_number)
        if dtype == "response.created":
            response = data.get("response")
            if isinstance(response, dict) and isinstance(response.get("id"), str):
                self._response_id = response["id"]
                self._response = json.loads(json.dumps(response))
        elif (
            isinstance(dtype, str)
            and dtype.startswith("response.")
            and dtype not in (
                "response.queued",
                "response.in_progress",
                *TERMINAL_EVENT_TYPES,
            )
        ):
            # Once any model/tool/reasoning event is exposed, replaying the
            # canonical request on another model could duplicate visible text
            # or a side effect. Lifecycle-only prologues remain retryable.
            self.exposed = True
        if self.signature and dtype == "response.output_item.added":
            item = data.get("item")
            if isinstance(item, dict) and item.get("type") == "message":
                self._sign_message_item(item)
                if item.get("id") in self._header_parts:
                    self._headed.add(item["id"])
                self._flush_held(out)
                out.append(self._emit(self._rebuild(block, data)))
                return out
        if self.signature and dtype == "response.output_text.delta":
            key = self._message_key(data)
            delta = data.get("delta")
            if isinstance(delta, str) and delta and key not in self._headed:
                self._header_parts.setdefault(key, data.get("content_index", 0))
                data["delta"] = self._sign(delta)
                self._headed.add(key)
                block = self._rebuild(block, data)
            self._flush_held(out)
            out.append(self._emit(block))
            return out
        if self.signature and dtype in ("response.output_text.done", "response.content_part.done"):
            self._flush_held(out)
            out.append(self._emit(self._sign_done_block(block)))
            return out
        if self.signature and dtype == "response.content_part.added":
            part = data.get("part") or {}
            if part.get("type") == "output_text" and part.get("text"):
                block = self._sign_done_block(block)
                self._headed.add(self._message_key(data))
            self._flush_held(out)
            out.append(self._emit(block))
            return out
        if dtype == "response.reasoning_summary_text.delta":
            if self._held is not None:
                out.append(self._emit(self._held[1]))
            key = (data.get("item_id"), data.get("summary_index"))
            self._held = (key, block)
            return out
        if dtype == "response.reasoning_summary_text.done":
            if self._held is not None:
                key = (data.get("item_id"), data.get("summary_index"))
                held_block = self._held[1]
                if self._held[0] == key:
                    held_block = self._tag_delta_block(held_block)
                out.append(self._emit(held_block))
                self._held = None
            out.append(self._emit(self._tag_done_block(block)))
            return out
        if dtype == "response.reasoning_summary_part.done":
            if self._held is not None:
                key = (data.get("item_id"), data.get("summary_index"))
                held_block = self._held[1]
                if self._held[0] == key:
                    held_block = self._tag_delta_block(held_block)
                out.append(self._emit(held_block))
                self._held = None
            out.append(self._emit(self._tag_done_block(block)))
            return out
        if dtype == "response.output_item.done":
            item = data.get("item") or {}
            if item.get("type") == "reasoning":
                if self._held is not None:
                    held_block = self._held[1]
                    if self._held[0][0] == item.get("id"):
                        held_block = self._tag_delta_block(held_block)
                    out.append(self._emit(held_block))
                    self._held = None
                out.append(self._emit(self._tag_item_block(block)))
                return out
            if self.signature and item.get("type") == "message":
                self._flush_held(out)
                out.append(self._emit(self._tag_item_block(block)))
                return out
        if dtype in TERMINAL_EVENT_TYPES:
            self._flush_held(out)
            response = data.get("response")
            self.terminal_type = dtype
            self.usage = usage_counts(response.get("usage")) if isinstance(response, dict) else None
            if (
                self._response_id
                and isinstance(response, dict)
                and response.get("id") != self._response_id
            ):
                # Two encodings of one response id, not two responses: the
                # consumer in front of us only accepts a completion that repeats
                # the id it already saw.
                response["id"] = self._response_id
                block = self._rebuild(block, data)
            out.append(self._emit(self._tag_item_block(block)))
            return out
        self._flush_held(out)
        out.append(self._emit(block))
        return out

    def fail_transport(self, message):
        """Close an already-exposed stream with a valid Responses terminal."""
        out = []
        self._flush_held(out)
        response = (
            json.loads(json.dumps(self._response))
            if isinstance(self._response, dict)
            else {}
        )
        response.setdefault("id", self._response_id or "resp_jev_transport_failure")
        response.setdefault("object", "response")
        response.setdefault("output", [])
        response["status"] = "failed"
        response["error"] = {"code": "server_error", "message": message}
        if self.usage is not None:
            response["usage"] = self.usage
        event = {
            "type": "response.failed",
            "sequence_number": self._sequence_number + 1,
            "response": response,
        }
        self.transport_error = message
        self.terminal_type = "response.failed"
        out.append(
            "event: response.failed\n"
            f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        )
        out.append("data: [DONE]\n\n")
        return "".join(out)

    def feed(self, raw):
        self._buf += self._decoder.decode(raw)
        out = []
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.endswith("\r"):
                line = line[:-1]
            if line == "":
                if self._block:
                    out.extend(self._process_block(self._block))
                    self._block = []
                out.append("\n")
            else:
                self._block.append(line)
        return "".join(out)

    def flush(self):
        out = []
        self._flush_held(out)
        if self._block:
            out.append(self._emit(self._block))
            self._block = []
        out.append(self._buf)
        self._buf = ""
        return "".join(out)


def assemble_sse(raw):
    """Rebuild the final response object from an SSE stream (non-stream requests)."""
    final = None
    error = None
    items = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            event = json.loads(chunk)
        except ValueError:
            continue
        etype = event.get("type") if isinstance(event, dict) else None
        if etype == "response.output_item.done" and isinstance(event.get("item"), dict):
            items[event.get("output_index") or 0] = event["item"]
        elif etype in TERMINAL_EVENT_TYPES:
            final = event.get("response")
        elif etype == "error":
            error = event
    if final is not None:
        if not final.get("output") and items:
            final["output"] = [items[i] for i in sorted(items)]
        return final
    if error is not None:
        return {"error": error}
    return None


def log_line(record):
    try:
        append_private(LOG_PATH, json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jev-router/1.5"

    def setup(self):
        super().setup()
        self.connection.settimeout(READ_TIMEOUT)
        self._response_started = False

    def send_response(self, code, message=None):
        self._response_started = True
        super().send_response(code, message)

    def _body(self, limit):
        """Validate framing and read a bounded JSON object within a deadline."""
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
            self._json(400, {"error": {"message": "one Content-Length required"}})
            return None
        try:
            length = int(lengths[0])
        except ValueError:
            length = -1
        if length <= 0:
            self._json(400, {"error": {"message": "invalid Content-Length"}})
            return None
        if length > limit:
            self._json(413, {"error": {"message": "body too large"}})
            return None
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": {"message": "application/json required"}})
            return None
        deadline = time.monotonic() + READ_TIMEOUT
        pieces, remaining = [], length
        while remaining:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("request body deadline")
            self.connection.settimeout(left)
            chunk = self.rfile.read1(min(65536, remaining))
            if not chunk:
                self._json(400, {"error": {"message": "incomplete request body"}})
                return None
            pieces.append(chunk)
            remaining -= len(chunk)
        self.connection.settimeout(READ_TIMEOUT)
        try:
            body = json.loads(b"".join(pieces))
        except (ValueError, UnicodeError):
            self._json(400, {"error": {"message": "invalid json"}})
            return None
        if not isinstance(body, dict):
            self._json(400, {"error": {"message": "json object expected"}})
            return None
        return body

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _ask(self):
        """Typed pass-through to System One for local callers (:4319, loopback only).

        No policy, no logging of the caller's state: the body is validated,
        forwarded as-is and only the typed answers come back.
        """
        body = self._body(ASK_MAX_BYTES)
        if body is None:
            return
        state, questions, error = validate_ask(body)
        if error:
            return self._json(400, {"error": {"message": error}})
        key = load_key()
        if not key:
            return self._json(503, {"error": {"message": "TYPESAFE_API_KEY is not configured"}})
        t0 = time.time()
        try:
            answer = call_jev_routed(key, state, questions, timeout=ASK_TIMEOUT)
        except Exception:
            return self._json(502, {"error": {"message": "Jev provider unavailable"}})
        return self._json(200, {
            "model": answer.get("model"),
            "answers": answer.get("answers") or {},
            "usage": answer.get("usage") or {},
            "ms": int((time.time() - t0) * 1000),
        })

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in ("/v1/models", "/models"):
            self._json(200, {
                "object": "list",
                "data": [{
                    "id": "auto",
                    "object": "model",
                    "created": 1758000000,
                    "owned_by": "jev",
                    "name": DISPLAY_NAME,
                }],
            })
        elif path in ("/health", ""):
            self._json(200, {"ok": True, "service": "jev-router", "version": VERSION,
                             "policy_version": POLICY_VERSION,
                             "auth_configured": bool(local_secret())})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        self.close_connection = True
        self._response_started = False
        try:
            secret = local_secret()
            if not secret:
                return self._json(503, {"error": {"message": "local credential not configured"}})
            if not authorized(self.headers.get("Authorization"), secret):
                return self._json(401, {"error": {"message": "Unauthorized"}})
            # Browsers are not clients of this local server.
            if self.headers.get("Origin"):
                return self._json(403, {"error": {"message": "browser origin not supported"}})
            self._post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            try:
                if not self._response_started:
                    self._json(502, {"error": {"message": "local router request failed"}})
            except Exception:
                pass

    def _post(self):
        path = self.path.split("?", 1)[0]
        if path.rstrip("/") in ASK_PATHS:
            return self._ask()
        if path.rstrip("/") not in ("/responses", "/v1/responses"):
            return self._json(404, {"error": {"message": "unsupported path"}})
        payload = self._body(RESPONSE_MAX_BYTES)
        if payload is None:
            return
        # Our own answer signatures never travel back upstream (see
        # strip_signatures): the model must not read its own route tag.
        stripped = strip_signatures(payload)

        t0 = time.time()
        debug = os.path.exists(DEBUG_PATH)
        if debug:
            try:
                append_private(os.path.join(STATE, "jev-router-debug.jsonl"), json.dumps(
                    {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "shape": _debug_shape(payload)},
                    ensure_ascii=False) + "\n")
            except OSError:
                pass
        task, prev_assistant, signals = extract(payload)
        step = classify(payload)
        stream_requested = payload.get("stream") is True

        tier = depth = conf = None
        jev_ms = None
        decision = None
        jev_usage = None
        decision_source = None
        scope = cache_scope(payload, task)
        affinity = cache_affinity(scope, payload)
        leased = route_lease(scope, payload, step)
        if os.path.exists(OFF_PATH):
            model, effort, speed, gate = ASTRA, None, "default", "off"
        else:
            key = load_key()
            if leased is not None:
                decision = leased
                tier, depth, conf = (
                    decision["model"], decision["effort"], decision["confidence"]
                )
                model, effort, speed, _ = route(tier, depth)
                gate = decision["gate"]
                decision_source = "lease"
            elif key and (task or step.get("digest") or signals.get("has_image")):
                jt0 = time.time()
                state = jev_state(task, prev_assistant, signals, step, affinity)
                try:
                    result = call_jev_routed(key, state)
                    decision = decision_from_answers(result.get("answers"))
                    raw_usage = result.get("usage") or {}
                    if not isinstance(raw_usage, dict):
                        raw_usage = {}
                    jev_usage = {k: v for k, v in raw_usage.items()
                                 if k in ("input_tokens", "output_tokens", "inputTokens", "outputTokens")
                                 and isinstance(v, int) and not isinstance(v, bool) and v >= 0}
                    tier, depth, conf = (decision["model"], decision["effort"],
                                         decision["confidence"])
                    model, effort, speed, _ = route(tier, depth)
                    gate = decision["gate"]
                    decision_source = "jev"
                except Exception as exc:
                    model, effort, speed, gate = ASTRA, "medium", "default", f"jev_error:{type(exc).__name__}"
                    decision_source = "technical_fallback"
                jev_ms = int((time.time() - jt0) * 1000)
            else:
                model, effort, speed, gate = ASTRA, "medium", "default", "no_key_or_task"
                decision_source = "technical_fallback"

        shadow_enabled = os.path.exists(SHADOW_PATH)

        would = None
        if shadow_enabled:
            would = {"model": model, "effort": effort, "speed": speed, "gate": gate}
            model, effort, speed, gate = ASTRA, None, "default", "shadow(astra)"

        # ONLY while native usage is exhausted (manual flag or observed quota
        # failure), replace the OpenAI ladder with locally discovered configured
        # routes. Healthy native turns never enumerate providers.
        dry_reason = native_dry()
        native_model = model
        fallback_plan = []
        no_fallback = False
        if dry_reason and model in TIERS:
            fallback_plan = fallback_candidates(native_model, payload)
            if fallback_plan:
                model = fallback_plan.pop(0)
                effort = tandem_effort(effort, native_model)
                speed = "default"
                gate = f"codex_dry({dry_reason}):{native_model}"
            else:
                no_fallback = True
                gate = f"codex_dry(no_candidate):{native_model}"

        # Display the model actually serving the request, including shadow and
        # operational fallbacks, rather than a hypothetical classification.
        shown = {"model": model, "effort": effort or (payload.get("reasoning") or {}).get("effort")}
        marker = route_marker(shown["model"], shown["effort"])
        signature = presentation_signature(payload, shown)

        original_reasoning = (
            dict(payload["reasoning"]) if isinstance(payload.get("reasoning"), dict) else None
        )
        injected_update = None
        effort_transport = None

        def apply_route(model, effort):
            nonlocal injected_update, effort_transport
            injected_update, effort_transport = apply_route_payload(
                payload, model, effort, original_reasoning, injected_update
            )

        if not no_fallback:
            apply_route(model, effort)

        out_path = "/v1/responses"
        self._attempts = []
        if no_fallback:
            status, out_kind, ctype, quota_hit, resets_at = (
                503, "json", "application/json", False, None
            )
            unwritten = json.dumps({
                "error": {
                    "message": "native Codex usage is exhausted and no compatible configured fallback is available"
                }
            }).encode("utf-8")
        else:
            status, out_kind, ctype, quota_hit, unwritten, resets_at = self._forward(
                payload, out_path, stream_requested, debug, marker, model, signature, effort,
                exact_route=bool(dry_reason and model not in TIERS))
        retried = False
        fallback = None
        if quota_hit and not dry_reason:
            # Native usage is exhausted: discover fallback routes now, then
            # retry this exact canonical call before anything reaches the client.
            mark_native_dry("quota", resets_at=resets_at)
            dry_reason = "quota"
            fallback_plan = fallback_candidates(native_model, payload)
            if fallback_plan:
                model = fallback_plan.pop(0)
                effort = tandem_effort(effort, native_model)
                apply_route(model, effort)
                retried = True
                gate = f"codex_dry(retry):{native_model}"
                marker = route_marker(model, effort)
                signature = presentation_signature(payload, {"model": model, "effort": effort})
                status, out_kind, ctype, quota_hit, unwritten, _resets_at = self._forward(
                    payload, out_path, stream_requested, debug, marker, model, signature, effort,
                    exact_route=True)
            else:
                gate = f"codex_dry(no_candidate):{native_model}"
        elif status == 200 and not dry_reason and model in TIERS and os.path.exists(DRY_STATE_PATH):
            # Native answered again: drop the stale auto state (never the flag).
            clear_native_dry()
            dry_reason = "cleared"
        if (model not in TIERS and status in RETRYABLE_TANDEM_STATUS
                and unwritten is not None and fallback_plan):
            # One bounded sibling attempt. The candidate resolver already
            # removed jev/auto and incompatible/offline local routes.
            fallback = fallback_plan.pop(0)
            model, effort = fallback, tandem_effort(effort, native_model)
            apply_route(model, effort)
            gate = f"codex_dry(fallback):{native_model}"
            marker = route_marker(model, effort)
            signature = presentation_signature(payload, {"model": model, "effort": effort})
            status, out_kind, ctype, quota_hit, unwritten, _resets_at = self._forward(
                payload, out_path, stream_requested, debug, marker, model, signature, effort,
                exact_route=True)
        if unwritten is not None:
            # Every model that could have served this turn refused it, and the
            # refusal was held back only because another attempt might have
            # followed. None did, so the caller gets the refusal instead of a
            # request nobody ever answers.
            self.send_response(status)
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(unwritten)))
            self.end_headers()
            self.wfile.write(unwritten)

        final_attempt = None
        observed_attempt = None
        for attempt in reversed(self._attempts):
            if attempt.get("model") != model:
                continue
            if observed_attempt is None:
                observed_attempt = attempt
            if attempt.get("status") == 200:
                final_attempt = attempt
                break
        completed_status = (
            200 if final_attempt
            and final_attempt.get("terminal_type") == "response.completed"
            else status if status != 200 else 502
        )
        remember_cache_model(
            scope, payload, model, completed_status,
            usage=final_attempt.get("usage") if final_attempt else None,
            effort=effort,
        )
        remember_route_lease(scope, payload, step, decision, completed_status)
        log_line({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "policy_version": POLICY_VERSION,
            "route_probabilities": decision["probabilities"] if decision else None,
            "chosen_probability": decision["chosen_probability"] if decision else None,
            "astra_policy": decision["astra_policy"] if decision else None,
            "base_tier": decision["base_model"] if decision else None,
            "jev_usage": jev_usage,
            "attempts": self._attempts,
            "decision_source": decision_source,
            "lease": decision.get("lease") if decision else None,
            "lease_hit": decision_source == "lease",
            "gate": gate,
            "tier": tier,
            "conf": conf,
            "depth": depth,
            "model": model,
            "effort": effort,
            "speed": speed,
            "native": native_model,
            "dry": dry_reason,
            "routing_scope": decision.get("lease") if decision else "call",
            "effort_transport": effort_transport,
            "cache_scope": scope,
            "cache_state": affinity,
            "cache_key_present": isinstance(payload.get("prompt_cache_key"), str)
                                 and bool(payload["prompt_cache_key"].strip()),
            "retried": retried,
            "fallback": fallback,
            "fallback_candidates": [attempt["model"] for attempt in self._attempts
                                    if attempt["model"] not in TIERS],
            "jev_ms": jev_ms,
            "total_ms": int((time.time() - t0) * 1000),
            "status": status,
            "completion_status": (
                observed_attempt.get("completion") if observed_attempt else None
            ),
            "stream": stream_requested,
            "out": out_kind,
            "uctype": ctype,
            "n_items": signals.get("n_items"),
            "img": signals.get("has_image"),
            "step": step["step_type"],
            "errored": step["errored"],
            "digest_len": len(step["digest"]),
            "stripped": stripped,
            "would": would,
            "task_chars": len(task),
        })

    def _forward(
        self, payload, out_path, stream_requested, debug, marker, model,
        signature=None, effective_effort=None, exact_route=False,
    ):
        """One relay attempt to the local caller edge, streamed straight back.

        Returns (status, out_kind, ctype, quota_hit, unwritten, resets_at).
        ``quota_hit`` is True only for a >=400 response whose body looks like
        exhausted usage; in that case nothing has been written to the client
        yet, so the caller can retry the same payload on another model.
        ``unwritten`` carries that response's body for the caller to relay if no
        retry follows, and is None whenever the response already reached the
        client. ``resets_at`` is the instant that refusal said the window
        reopens, when it announced one.
        """
        body = json.dumps(payload).encode("utf-8")
        conn = http.client.HTTPConnection(*ROUTER, timeout=900)
        status = 0
        out_kind = ""
        ctype = ""
        attempt = {"model": model, "effort": effective_effort,
                   "speed": payload.get("service_tier"), "status": None,
                   "http_status": None, "completion": None,
                   "terminal_type": None, "transport_error": None, "usage": None}
        self._attempts.append(attempt)
        markerer = None
        try:
            headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
            # The selected model must receive this exact canonical replay even
            # when the parent router's global aging/windowing knobs are enabled.
            # The local caller capability authenticates this internal contract;
            # the parent consumes the marker and never forwards it upstream.
            headers["x-codex-router-canonical-replay"] = "1"
            if exact_route:
                # This request is already one hop of Jev's bounded recovery
                # plan. Disable the parent router's own cross-model failover so
                # it cannot recurse through jev/auto or duplicate candidates.
                headers["x-codex-router-exact-route"] = "1"
            conn.request(
                "POST",
                f"/_codex-router/{caller_secret()}{out_path}",
                body=body,
                headers=headers,
            )
            resp = conn.getresponse()
            status = resp.status
            attempt["http_status"] = status
            ctype = (resp.getheader("Content-Type") or "").strip()
            # The local caller edge sets NO Content-Type on SSE streams. For a
            # streaming request, a 200 response IS an SSE stream: force the
            # outgoing header, because the forwarder picks its parser from it
            # (text/event-stream → SSE relay, application/json → JSON parse).
            is_sse = status == 200 and (
                "text/event-stream" in ctype or (not ctype and stream_requested))
            out_kind = ""

            if is_sse and stream_requested:
                out_kind = "sse"
                markerer = SummaryMarker(marker, signature)
                pending = bytearray()
                stream_started = False
                client_connected = True
                transport_error = None

                def write_piece(piece):
                    nonlocal stream_started, client_connected
                    if not piece or not client_connected:
                        return client_connected
                    try:
                        if not stream_started:
                            self.send_response(status)
                            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                            self.send_header("Transfer-Encoding", "chunked")
                            self.end_headers()
                            stream_started = True
                        self.wfile.write(
                            f"{len(piece):X}\r\n".encode("ascii") + piece + b"\r\n"
                        )
                        self.wfile.flush()
                        return True
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        client_connected = False
                        return False

                try:
                    while True:
                        chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                        if not chunk:
                            break
                        if debug:
                            try:
                                # Capture only transport counters, never generated text,
                                # tool arguments or raw streams which may contain secrets.
                                append_private(
                                    os.path.join(STATE, "jev-router-debug-stream.log"),
                                    json.dumps({"model": model, "bytes": len(chunk)}) + "\n",
                                )
                            except OSError:
                                pass
                        piece = markerer.feed(chunk).encode("utf-8")
                        if piece:
                            pending.extend(piece)
                        if markerer.exposed or markerer.terminal_type:
                            connected = write_piece(bytes(pending))
                            pending.clear()
                            if not connected:
                                break
                except (OSError, http.client.HTTPException) as exc:
                    transport_error = f"{type(exc).__name__}: upstream stream interrupted"

                if not client_connected:
                    attempt["completion"] = "client_disconnected"
                    attempt["transport_error"] = "downstream_client_disconnected"
                    return status, out_kind, ctype, False, None, None

                piece = markerer.flush().encode("utf-8")
                if piece:
                    pending.extend(piece)
                if markerer.terminal_type:
                    write_piece(bytes(pending))
                    pending.clear()
                elif not markerer.exposed:
                    # No user-visible output or tool call crossed the relay, so
                    # the caller can safely retry this exact canonical request.
                    status = 502
                    attempt["completion"] = "interrupted_precontent"
                    attempt["transport_error"] = transport_error or "upstream_eof"
                    data = b'{"error":{"message":"upstream stream ended before a terminal event"}}'
                    return status, "json", "application/json", False, data, None
                else:
                    write_piece(bytes(pending))
                    pending.clear()
                    attempt["transport_error"] = transport_error or "upstream_eof"
                    failure = markerer.fail_transport(
                        "upstream stream ended before a terminal event"
                    ).encode("utf-8")
                    write_piece(failure)

                if stream_started and client_connected:
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        client_connected = False
                if not client_connected:
                    attempt["completion"] = "client_disconnected"
                    attempt["transport_error"] = "downstream_client_disconnected"
            else:
                out_kind = "json"
                data = resp.read()
                out_ctype = ctype or "application/json"
                head = data[:64].lstrip()
                if status >= 400:
                    # Held back, not written: the caller decides whether another
                    # model gets this call first. The refusal also carries the
                    # instant the window reopens, which is how long the flip lasts.
                    quota = bool(status == 429 or QUOTA_RX.search(data.decode("utf-8", "replace")))
                    attempt["completion"] = "http_error"
                    return status, out_kind, ctype, quota, data, quota_reset_at(resp.headers, data)
                # The caller edge always streams; rebuild a proper single JSON
                # object for non-stream callers (compactions, litellm's
                # non-stream provider path) instead of forwarding raw SSE bytes.
                if status == 200 and (head.startswith(b"event:") or head.startswith(b"data:")):
                    assembled = assemble_sse(data)
                    if assembled is None:
                        status = 502
                        assembled = {"error": {"message": "upstream stream ended before a terminal event"}}
                        attempt["completion"] = "interrupted_precontent"
                        attempt["transport_error"] = "upstream_eof"
                    if assembled is not None:
                        attempt["usage"] = usage_counts(assembled.get("usage"))
                        response_status = assembled.get("status")
                        if response_status in ("completed", "incomplete", "failed"):
                            attempt["terminal_type"] = f"response.{response_status}"
                        headerer = SummaryMarker("", signature)
                        for item in assembled.get("output") or []:
                            headerer._sign_message_item(item)
                        data = json.dumps(assembled).encode("utf-8")
                        out_ctype = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", out_ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            return status, out_kind, ctype, False, None, None
        except (OSError, http.client.HTTPException):
            if self._response_started:
                attempt["completion"] = "transport_failed"
                attempt["transport_error"] = "upstream_transport_unavailable"
                return status or 502, out_kind or "sse", ctype, False, None, None
            status = 502
            data = b'{"error":{"message":"upstream transport unavailable"}}'
            attempt["completion"] = "transport_unavailable"
            attempt["transport_error"] = "upstream_transport_unavailable"
            return status, "json", "application/json", False, data, None
        finally:
            attempt["status"] = status
            if markerer is not None:
                attempt["usage"] = markerer.usage
                attempt["terminal_type"] = markerer.terminal_type
                attempt["transport_error"] = (
                    attempt["transport_error"] or markerer.transport_error
                )
            if attempt["completion"] is None:
                attempt["completion"] = attempt["terminal_type"] or "no_terminal"
            conn.close()


def main():
    server = LocalServer(LISTEN, Handler)
    protect_logs([LOG_PATH, os.path.join(STATE, "jev-router-debug.jsonl"),
                  os.path.join(STATE, "jev-router-debug-stream.log")])
    warn_if_key_missing()
    print(f"[jev-router] ready on {LISTEN[0]}:{LISTEN[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
