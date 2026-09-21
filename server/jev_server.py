#!/usr/bin/env python3
"""Jev Codex Router — local server on 127.0.0.1:4319 for the Codex Router.

Receives Responses requests destined for the "jev/auto" model (the Codex
Router's "jev" generic provider), asks Jev (TypeSafe System One) for a tier
and a thinking depth, applies the routing policy, then relays to the Codex
Router's local caller edge (native session sharing enabled) — with no format
conversion: Responses in, Responses out, SSE relayed verbatim.

Routing policy: Jev chooses one (model, thinking effort) pair for every call.
Every pair uses standard speed. Confidence is logged without changing the chosen
model. There are no keyword/scenario overrides or target model proportions.
Technical Jev failures remain fail-open to astra @medium and are logged separately.

Per-call routing (v5): every model call is judged independently, so a tool loop
may move between Luna, Sol and Astra as the next sub-action changes. Provider
retries inside that call retain its decision. The compact Jev projection is
judgment input only: the executing model always receives the caller's canonical
request untouched, never that projection. The caller's prompt_cache_key also
passes through untouched, allowing each selected model to reuse its own cache
for this session; caches are not assumed to be shared across different models.

Input handling (v4): Jev sees the current ask, never the thread — the task is
Codex's last user text, with Codex's own machine-generated envelopes stripped
(goal context, plugin catalog, environment, skills) and clipped head+tail.
Thread length never reaches the judge. A tool continuation adds only its tool
name, a short output tail and a short assistant-intent tail. The complete
history, instructions, tools, results and compaction handoff remain exclusively
in the canonical request sent to the executing model.
Live data (4 516 calls): 1 291 (29%) had sent Jev nothing but a
`<codex_internal_context source="goal">` block (~6.4k chars, p50) and 23 more
only a `<recommended_plugins>` catalog — the head-clip stopped inside the
envelope, so the user's actual request was never judged.

Fail-open: any Jev error → astra @medium. Kill switch: file
~/.codex/codex-router/jev-router.off → relay astra without a decision.
Shadow: file ~/.codex/codex-router/jev-router.shadow → decide and log the
route, but serve plain astra (quality-neutral data collection).
Debug: file ~/.codex/codex-router/jev-router.debug → dump request shapes
(jev-router-debug.jsonl) and raw response streams (jev-router-debug-stream.log).
Display: streamed reasoning summaries get the routed tag appended in place
( · 🧠sol:low · ) so the Codex thread shows the picked model per call.
The same rewriter keeps one response id across a relayed stream: a tandem stream
has already crossed the local edge once, so its terminal event carries a
re-encrypted id, and the Responses consumer in front of us refuses a completion
whose id differs from the one `response.created` announced.
Non-stream callers (auto-compaction checkpoints, litellm non-stream path)
receive the SSE stream reassembled into a single JSON response object.
Balance: sufficient capability and effort for the next decision, including
compaction. Capability profiles are priors; outcome quality requires evaluation.
Log: ~/.codex/codex-router/jev-router-live.jsonl

Codex-dry tandem: when native usage is exhausted — a manual flag file
(~/.codex/codex-router/jev-router.codex-dry) or an observed quota failure
(429 / usage-limit body) — the triptych is replaced until the window resets:
frontier-tier (astra) calls go to GLM (opencode-go/glm-5.3-flash), every
other tier to deepseek (opencode-go/deepseek-v4.1-flash). A quota failure
flips the state and retries the same call on the tandem; a successful native
call clears an auto state (never the manual flag). A tandem call that comes
back retryable (429/5xx) is tried once on the sibling model, because the two Go
models are metered separately and a spent allowance is reported the same way a
transient outage is. The decided depth travels with the call, mapped onto the Go
ladder (low/high/max): a low step stays low, medium and high become high, and
xhigh or above become max.
"""
import codecs
import hashlib
import http.client
import json
import os
import re
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from routing_policy import (ASTRA, EFFORTS, LUNA, POLICY_VERSION, QUESTIONS, SOL,
                            TIERS, decision_from_answers, route)

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".codex", "codex-router")
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
VERSION = "1.3"

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

# Codex-dry tandem: used ONLY while native (ChatGPT) usage is exhausted.
GO_STANDARD = "deepseek/deepseek-v4.1-flash"
GO_FRONTIER = "deepseek/deepseek-v4.1-flash"
GO_TANDEM = (GO_STANDARD, GO_FRONTIER)
# The tandem's own thinking ladder. Both Go models declare low/high/max where the
# native triptych exposes low/medium/high/xhigh/max, so a depth keeps its meaning
# by landing on the middle rung instead of collapsing onto the floor: Jev says
# "medium" about work it wants done carefully, and DeepSeek documents its `low`
# as "no deep reasoning needed". The API forwarder clamps the value a second time
# onto the route's declared ladder, so nothing off-ladder can reach a provider.
TANDEM_EFFORT = {
    "none": "low", "minimal": "low", "low": "low",
    "medium": "high", "high": "high",
    "xhigh": "max", "max": "max", "ultra": "max",
}
# A status the *other* half of the tandem might still answer. opencode Go meters
# the two Go models against separate allowances, and its gateway reports a spent
# allowance with the same 429/503 shape as a transient one, so one more attempt
# on the sibling model is worth it before the turn is lost. Nothing has reached
# the client at this point: the forwarder only returns a retryable status before
# it writes anything.
RETRYABLE_TANDEM_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
DRY_MANUAL_PATH = os.path.join(STATE, "jev-router.codex-dry")
DRY_STATE_PATH = os.path.join(STATE, "jev-router.codex-dry.json")
DRY_COOLDOWN_S = 30 * 60
# The edge announces when the exhausted window reopens, so an automatic flip
# lasts until that instant (plus a small skew, so the re-probe cannot race the
# reset itself) instead of a flat cooldown that keeps the tandem serving a
# window which already came back. The horizon is the backstop: a bogus or
# hostile announcement still cannot pin the router to the tandem for a week.
DRY_RESET_SKEW_S = 5
DRY_MAX_HORIZON_S = 7 * 24 * 3600
QUOTA_RX = re.compile(
    r"(?i)(rate[ _-]?limit|out_of_usage|usage limit|hit your usage|insufficient_quota|quota)")

# The events that close a Responses stream and repeat the response id it opened
# with. A relayed (tandem) stream is rewritten onto that opening id.
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
    r'<codex_internal_context(?:\s[^<>]*)?>(.*?)</codex_internal_context\s*>', re.S)
# A single envelope has been seen at 950k chars. Past this size only the two ends
# are scanned, which is where the user's text sits anyway.
ENVELOPE_SCAN_CHARS = 200_000

_log_lock = threading.Lock()


def load_key():
    """TYPESAFE_API_KEY: env files win (the process environment can be stale)."""
    for path in (ENV_PATH, os.path.join(HOME, ".jev.env")):
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
    can never pin the router to the tandem forever.
    """
    if os.path.exists(DRY_MANUAL_PATH):
        return "manual"
    state = _read_json(DRY_STATE_PATH)
    if isinstance(state, dict) and float(state.get("until") or 0) > time.time():
        return str(state.get("reason") or "quota")
    return None


def mark_native_dry(reason, resets_at=None):
    """Flip to the Go tandem, for as long as the exhausted window stays shut.

    `resets_at` is the instant the edge said the window reopens. Ending the
    state just after it is what sends the next call back to the native triptych
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
    return GO_FRONTIER if target == GO_STANDARD else GO_STANDARD


def dry_target(native_model, effort):
    """Codex-dry tandem: frontier-tier steps -> GLM, everything else -> deepseek."""
    target = GO_FRONTIER if native_model == ASTRA else GO_STANDARD
    return target, tandem_effort(effort, native_model)


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


def extract(payload):
    """Last user message (envelope-free, clipped) + last assistant message + small stats."""
    inp = payload.get("input")
    last_user = last_assistant = ""
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
            if role == "user" and not last_user:
                last_user = _content_text(item.get("content"))
            elif role == "assistant" and not last_assistant:
                last_assistant = _content_text(item.get("content"))
            if last_user and last_assistant:
                break
    return task_for_jev(last_user), last_assistant.strip(), {
        "n_items": n_items,
        "has_image": has_image,
        "tool_history": tool_tail,
    }


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
        elif last.get("role") == "user":
            detail["step_type"] = "user_turn"
    return detail


def jev_state(task, prev_assistant, signals, step):
    """Strictly bounded decision dossier; never reused as execution context."""
    state = {"task": task, "step": step["step_type"]}
    if signals.get("has_image"):
        state["image"] = True
    if step["step_type"] != "user_turn" and prev_assistant:
        state["intent_tail"] = prev_assistant[-INTENT_CHARS:]
    if step["step_type"] == "tool_step":
        if step["digest"]:
            state["tool_result_tail"] = step["digest"]
        if step.get("tool_call", {}).get("name"):
            state["tool"] = step["tool_call"]["name"]
    return state


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
        "instructions_head": (payload.get("instructions") or "")[:200],
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
                 "cache_write_input_tokens"):
        value = usage.get(name)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            out[name] = value
    for group, name in (("input_tokens_details", "cached_tokens"),
                        ("output_tokens_details", "reasoning_tokens")):
        details = usage.get(group)
        value = details.get(name) if isinstance(details, dict) else None
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            out["cached_input_tokens" if name == "cached_tokens" else name] = value
    return out or None


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
        if dtype == "response.created":
            response = data.get("response")
            if isinstance(response, dict) and isinstance(response.get("id"), str):
                self._response_id = response["id"]
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
        elif etype == "response.completed":
            final = event.get("response")
        elif isinstance(etype, str) and etype in ("response.failed", "error"):
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
        with _log_lock:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jev-router/1.2"

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
        length = int(self.headers.get("Content-Length") or 0)
        if length > ASK_MAX_BYTES:
            # Do not drain an oversized body: answer and close so a wrong or
            # hostile Content-Length cannot make the server buffer it.
            self.close_connection = True
            return self._json(413, {"error": {"message": f"body too large ({length} bytes)"}})
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": {"message": "invalid json"}})
        state, questions, error = validate_ask(body)
        if error:
            return self._json(400, {"error": {"message": error}})
        key = load_key()
        if not key:
            return self._json(503, {"error": {"message": "TYPESAFE_API_KEY is not configured"}})
        t0 = time.time()
        try:
            answer = call_jev_routed(key, state, questions, timeout=ASK_TIMEOUT)
        except Exception as exc:
            return self._json(502, {"error": {"message": f"jev: {exc}"[:300]}})
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
                             "policy_version": POLICY_VERSION})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        try:
            self._post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # fail-open at the response level only
            try:
                self._json(502, {"error": {"message": f"jev-router: {exc}"}})
            except Exception:
                pass

    def _post(self):
        path = self.path.split("?", 1)[0]
        if path.rstrip("/") in ASK_PATHS:
            return self._ask()
        if "/responses" not in path:
            return self._json(404, {"error": {"message": f"unsupported path {path}"}})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": {"message": "invalid json"}})
        if not isinstance(payload, dict):
            return self._json(400, {"error": {"message": "json object expected"}})
        # Our own answer signatures never travel back upstream (see
        # strip_signatures): the model must not read its own route tag.
        stripped = strip_signatures(payload)

        t0 = time.time()
        debug = os.path.exists(DEBUG_PATH)
        if debug:
            try:
                with open(os.path.join(STATE, "jev-router-debug.jsonl"), "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(
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
        scope = cache_scope(payload, task)
        if os.path.exists(OFF_PATH):
            model, effort, speed, gate = ASTRA, None, "default", "off"
        else:
            key = load_key()
            if key and (task or step.get("digest") or signals.get("has_image")):
                jt0 = time.time()
                state = jev_state(task, prev_assistant, signals, step)
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
                    model, effort, speed, gate = route(tier, depth)
                except Exception as exc:
                    model, effort, speed, gate = ASTRA, "medium", "default", f"jev_error:{type(exc).__name__}"
                jev_ms = int((time.time() - jt0) * 1000)
            else:
                model, effort, speed, gate = ASTRA, "medium", "default", "no_key_or_task"

        would = None
        if os.path.exists(SHADOW_PATH):
            would = {"model": model, "effort": effort, "speed": speed, "gate": gate}
            model, effort, speed, gate = ASTRA, None, "default", "shadow(astra)"

        # Codex-dry tandem: ONLY while native usage is exhausted (manual flag or
        # observed quota failure) the triptych is replaced — GLM for frontier
        # steps, deepseek for the rest. Otherwise luna/sol/astra run untouched.
        dry_reason = native_dry()
        native_model = model
        if dry_reason and model in TIERS:
            model, effort = dry_target(native_model, effort)
            speed = "default"
            gate = f"codex_dry({dry_reason}):{native_model}"

        # Display the model actually serving the request, including shadow and
        # operational fallbacks, rather than a hypothetical classification.
        shown = {"model": model, "effort": effort or (payload.get("reasoning") or {}).get("effort")}
        marker = route_marker(shown["model"], shown["effort"])
        signature = answer_signature(shown)

        def apply_route(payload, model, effort):
            payload["model"] = model
            if effort:
                reasoning = payload.get("reasoning")
                reasoning = dict(reasoning) if isinstance(reasoning, dict) else {}
                reasoning["effort"] = effort
                payload["reasoning"] = reasoning
            # Explicitly override any Fast preference inherited from the client,
            # including kill-switch, shadow, and retried fallback requests.
            payload["service_tier"] = "default"
            payload["stream"] = True  # the local caller edge requires streaming
            return payload

        apply_route(payload, model, effort)

        out_path = path if path.startswith("/v1") else "/v1" + path
        self._attempts = []
        status, out_kind, ctype, quota_hit, unwritten, resets_at = self._forward(
            payload, out_path, stream_requested, debug, marker, model, signature)
        retried = False
        fallback = None
        if quota_hit and not dry_reason:
            # Native usage is exhausted: flip to the Go tandem and retry this very
            # call so the turn does not fail (nothing reached the client yet). The
            # flip lasts until the edge says the window reopens, so the first call
            # after the reset is served by the native triptych again.
            mark_native_dry("quota", resets_at=resets_at)
            model, effort = dry_target(native_model, effort)
            apply_route(payload, model, effort)
            retried = True
            # The log records the state this call entered, not the one it started
            # in: reading `dry: None` next to `codex_dry(retry)` is how a flip
            # looks like it never happened when calibrating from the log.
            dry_reason = "quota"
            gate = f"codex_dry(retry):{native_model}"
            marker = route_marker(model, effort)
            signature = answer_signature({"model": model, "effort": effort})
            status, out_kind, ctype, quota_hit, unwritten, _resets_at = self._forward(
                payload, out_path, stream_requested, debug, marker, model, signature)
        elif status == 200 and not dry_reason and model in TIERS and os.path.exists(DRY_STATE_PATH):
            # Native answered again: drop the stale auto state (never the flag).
            clear_native_dry()
            dry_reason = "cleared"
        if model in GO_TANDEM and status in RETRYABLE_TANDEM_STATUS:
            # Half of the tandem refused this call, so try the sibling model
            # before the turn is lost. The two Go models are metered against
            # separate allowances, and a spent allowance arrives as the same
            # 429/503 a transient outage does -- which is exactly what killed a
            # live session on 18 September 2026 after the handoff.
            fallback = other_tandem(model)
            model, effort = fallback, tandem_effort(effort, native_model)
            apply_route(payload, model, effort)
            gate = f"codex_dry(fallback):{native_model}"
            marker = route_marker(model, effort)
            signature = answer_signature({"model": model, "effort": effort})
            status, out_kind, ctype, quota_hit, unwritten, _resets_at = self._forward(
                payload, out_path, stream_requested, debug, marker, model, signature)
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

        log_line({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "policy_version": POLICY_VERSION,
            "route_probabilities": decision["probabilities"] if decision else None,
            "chosen_probability": decision["chosen_probability"] if decision else None,
            "jev_usage": jev_usage,
            "attempts": self._attempts,
            "gate": gate,
            "tier": tier,
            "conf": conf,
            "depth": depth,
            "model": model,
            "effort": effort,
            "speed": speed,
            "native": native_model,
            "dry": dry_reason,
            "routing_scope": "call",
            "cache_scope": scope,
            "cache_key_present": isinstance(payload.get("prompt_cache_key"), str)
                                 and bool(payload["prompt_cache_key"].strip()),
            "retried": retried,
            "fallback": fallback,
            "jev_ms": jev_ms,
            "total_ms": int((time.time() - t0) * 1000),
            "status": status,
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
            "task": task[:110],
        })

    def _forward(self, payload, out_path, stream_requested, debug, marker, model, signature=None):
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
        attempt = {"model": model, "effort": (payload.get("reasoning") or {}).get("effort"),
                   "speed": payload.get("service_tier"), "status": None,
                   "terminal_type": None, "usage": None}
        self._attempts.append(attempt)
        markerer = None
        try:
            conn.request(
                "POST",
                f"/_codex-router/{caller_secret()}{out_path}",
                body=body,
                headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
            )
            resp = conn.getresponse()
            status = resp.status
            ctype = (resp.getheader("Content-Type") or "").strip()
            # The local caller edge sets NO Content-Type on SSE streams. For a
            # streaming request, a 200 response IS an SSE stream: force the
            # outgoing header, because the forwarder picks its parser from it
            # (text/event-stream → SSE relay, application/json → JSON parse).
            is_sse = ("text/event-stream" in ctype) or (status == 200 and stream_requested)
            out_kind = ""

            if is_sse and stream_requested:
                out_kind = "sse"
                cap = None
                if debug:
                    try:
                        cap = open(os.path.join(STATE, "jev-router-debug-stream.log"), "a", encoding="utf-8")
                        cap.write(f"\n===== {time.strftime('%H:%M:%S')} model={model} =====\n")
                    except OSError:
                        cap = None
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                markerer = SummaryMarker(marker, signature)
                while True:
                    chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                    if not chunk:
                        break
                    if cap is not None:
                        try:
                            cap.write(chunk.decode("utf-8", "replace"))
                            cap.flush()
                        except OSError:
                            cap = None
                    piece = markerer.feed(chunk).encode("utf-8")
                    if piece:
                        self.wfile.write(f"{len(piece):X}\r\n".encode("ascii") + piece + b"\r\n")
                        self.wfile.flush()
                piece = markerer.flush().encode("utf-8")
                if piece:
                    self.wfile.write(f"{len(piece):X}\r\n".encode("ascii") + piece + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                if cap is not None:
                    cap.close()
            else:
                out_kind = "json"
                data = resp.read()
                out_ctype = ctype or "application/json"
                head = data[:64].lstrip()
                if status >= 400 and (status == 429 or QUOTA_RX.search(data.decode("utf-8", "replace"))):
                    # Held back, not written: the caller decides whether another
                    # model gets this call first. The refusal also carries the
                    # instant the window reopens, which is how long the flip lasts.
                    return status, out_kind, ctype, True, data, quota_reset_at(resp.headers, data)
                # The caller edge always streams; rebuild a proper single JSON
                # object for non-stream callers (compactions, litellm's
                # non-stream provider path) instead of forwarding raw SSE bytes.
                if status == 200 and (head.startswith(b"event:") or head.startswith(b"data:")):
                    assembled = assemble_sse(data)
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
        finally:
            attempt["status"] = status
            if markerer is not None:
                attempt["usage"] = markerer.usage
                attempt["terminal_type"] = markerer.terminal_type
            conn.close()


def main():
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    try:
        os.chmod(LOG_PATH, 0o600)
    except OSError:
        pass
    print(f"[jev-router] ready on {LISTEN[0]}:{LISTEN[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
