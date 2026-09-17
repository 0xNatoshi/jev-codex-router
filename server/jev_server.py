#!/usr/bin/env python3
"""Jev Router — local server on 127.0.0.1:4319 for the Codex Router.

Receives Responses requests destined for the "jev/auto" model (the Codex
Router's "jev" generic provider), asks Jev (TypeSafe System One) for a tier
and a thinking depth, applies the routing policy, then relays to the Codex
Router's local caller edge (native session sharing enabled) — with no format
conversion: Responses in, Responses out, SSE relayed verbatim.

Default routing policy:
  luna  → always max thinking + priority speed (the 2x cost is negligible)
  sol   → adaptive thinking depth (Jev) + standard speed
  astra → adaptive thinking depth (Jev) + standard speed
  conf < 0.5 → HOLD: fall back to the middle tier (sol) — anti-downgrade
  without burning the frontier (backtest-calibrated: −12% → −60% vs full-Astra).

Per-call awareness (v2): every request is classified as a fresh user turn, a
tool-step continuation, or other. Tool-steps carry a digest of the last tool
output plus an error flag into the Jev state, so Jev routes THIS step
(mechanical continuation, standard next action, or frontier-worthy) instead
of re-judging the session's original prompt. On live sessions (7 days):
~92% of model calls are tool-steps — ~74% of the money weight.

Fail-open: any Jev error → astra @medium. Kill switch: file
~/.codex/codex-router/jev-router.off → relay astra without a decision.
Shadow: file ~/.codex/codex-router/jev-router.shadow → decide and log the
route, but serve plain astra (quality-neutral data collection).
Debug: file ~/.codex/codex-router/jev-router.debug → dump request shapes
(jev-router-debug.jsonl) and raw response streams (jev-router-debug-stream.log).
Display: streamed reasoning summaries get the routed tag appended in place
( · ⚡sol:low) so the Codex thread shows the picked model per call.
Non-stream callers (auto-compaction checkpoints, litellm non-stream path)
receive the SSE stream reassembled into a single JSON response object.
Balance: quality-first. sol is the default workhorse, astra is reserved for
genuinely hard steps, luna only fires on confident mechanical calls, and
compaction checkpoints are pinned to sol @ high.
Log: ~/.codex/codex-router/jev-router-live.jsonl

Codex-dry tandem: when native usage is exhausted — a manual flag file
(~/.codex/codex-router/jev-router.codex-dry) or an observed quota failure
(429 / usage-limit body) — the triptych is replaced until the window resets:
frontier-tier (astra) calls go to GLM (opencode-go/glm-5.3-flash), every
other tier to deepseek (opencode-go/deepseek-v4.1-flash). A quota failure
flips the state and retries the same call on the tandem; a successful native
call clears an auto state (never the manual flag).
"""
import codecs
import http.client
import json
import os
import re
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".codex", "codex-router")
ENV_PATH = os.path.join(HOME, ".hermes", ".env")
CALLER_SECRET_PATH = os.path.join(STATE, "caller-secret")
OFF_PATH = os.path.join(STATE, "jev-router.off")
SHADOW_PATH = os.path.join(STATE, "jev-router.shadow")
DEBUG_PATH = os.path.join(STATE, "jev-router.debug")
LOG_PATH = os.path.join(STATE, "jev-router-live.jsonl")

LISTEN = ("127.0.0.1", 4319)
ROUTER = ("127.0.0.1", 4202)

API = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

LUNA, SOL, ASTRA = "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"
TIERS = (LUNA, SOL, ASTRA)
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CONF_GATE = 0.5

# Codex-dry tandem: used ONLY while native (ChatGPT) usage is exhausted.
GO_STANDARD = "opencode-go/deepseek-v4.1-flash"
GO_FRONTIER = "opencode-go/glm-5.3-flash"
DRY_MANUAL_PATH = os.path.join(STATE, "jev-router.codex-dry")
DRY_STATE_PATH = os.path.join(STATE, "jev-router.codex-dry.json")
DRY_COOLDOWN_S = 30 * 60
QUOTA_RX = re.compile(
    r"(?i)(rate[ _-]?limit|out_of_usage|usage limit|hit your usage|insufficient_quota|quota)")

ERROR_RX = re.compile(
    r"(?i)(traceback|error|failed|exit code [1-9]|assertion|exception|fatal|panic)")
DIGEST_CHARS = 520

QUESTIONS = {
    "tier": {
        "type": "choice",
        "instructions": (
            "Which model tier should serve this model call? This is one call inside an ongoing "
            "coding-agent session. When the call directly follows a tool result, route THIS next "
            "step only: mechanical continuations (running or re-running commands, applying a "
            "prepared edit, checking output, routine file reads) are fine on gpt-5.6-luna; "
            "standard next actions belong to gpt-5.6-sol; reserve gpt-6-astra for steps that need "
            "frontier reasoning (complex debugging after failures, architecture, ambiguous or "
            "risky changes). When the call starts a fresh user turn, route the task itself."
        ),
        "criteria": {
            LUNA: "Fast and cheap; mechanical or clearly scoped tasks.",
            SOL: "Workhorse; standard implementation work.",
            ASTRA: "Frontier; hard, ambiguous, or risky problems.",
        },
    },
    "depth": {
        "type": "choice",
        "instructions": (
            "What thinking depth does the next step require (for a fresh user turn, the task "
            "itself)? Set the thinking effort level: low = "
            "straightforward, no deep reasoning; medium = some careful thought; high = substantial "
            "reasoning; xhigh = very deep reasoning; max = maximum depth for the hardest problems."
        ),
        "criteria": {
            "low": "No deep reasoning needed.",
            "medium": "Some careful thought.",
            "high": "Substantial reasoning required.",
            "xhigh": "Very deep reasoning.",
            "max": "Maximum reasoning depth, hardest problems.",
        },
    },
}

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
    until = resets_at if (resets_at and resets_at > time.time() + 60) else time.time() + DRY_COOLDOWN_S
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


def dry_target(native_model, effort):
    """Codex-dry tandem: frontier-tier steps -> GLM, everything else -> deepseek."""
    if native_model == ASTRA:
        return GO_FRONTIER, effort or "high"
    return GO_STANDARD, effort or "medium"


def call_jev(key, state, timeout=4.0):
    body = json.dumps({"model": MODEL, "state": state, "questions": QUESTIONS}).encode()
    req = urllib.request.Request(
        API,
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def clamp_effort(depth):
    return depth if depth in EFFORTS else "medium"


def route(tier, depth, conf):
    """Apply the routing policy. Returns (model, effort, speed, gate)."""
    if conf is not None and conf < CONF_GATE:
        # Backtest finding: falling back to astra ate ~80% of the savings;
        # the middle tier keeps the anti-downgrade property without burning the frontier.
        return SOL, clamp_effort(depth), "default", "hold(sol)"
    if tier == LUNA:
        return LUNA, "max", "priority", "apply"
    if tier == SOL:
        return SOL, clamp_effort(depth), "default", "apply"
    return ASTRA, clamp_effort(depth), "default", "apply"


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


def extract(payload):
    """Last user message + last assistant message + small stats."""
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
    return last_user.strip(), last_assistant.strip(), {
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
        elif last.get("role") == "user":
            detail["step_type"] = "user_turn"
    return detail


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


def route_marker(model, effort):
    """Short visible tag for the routed call, e.g. ' · ⚡sol:low'."""
    short = {
        "gpt-5.6-luna": "luna",
        "gpt-5.6-sol": "sol",
        "gpt-6-astra": "astra",
        "gpt-5.6-terra": "terra",
    }.get(model)
    if not short:
        short = (model or "?").split("/")[-1]
    return f" · ⚡{short}" + (f":{effort}" if effort else "")


class SummaryMarker:
    """Append the routed tag to reasoning summaries (the thread's thinking blocks).

    The last delta of each summary part is held back by one event so the tag can
    be appended in place to it and to the matching done events: no fabricated
    events, no sequence-number surgery, byte-exact pass-through everywhere else.
    Only active for streamed responses.
    """

    def __init__(self, marker):
        self.marker = marker
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buf = ""
        self._block = []
        self._held = None  # (key, block_lines)

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
        response = data.get("response")
        if isinstance(response, dict):
            for item in response.get("output") or []:
                if isinstance(item, dict) and item.get("type") == "reasoning":
                    for part in item.get("summary") or []:
                        if isinstance(part, dict) and "text" in part:
                            part["text"] = self._tag(part.get("text"))
        return self._rebuild(block, data)

    def _process_block(self, block):
        out = []
        data = self._data(block)
        if not isinstance(data, dict):
            if self._held is not None:
                out.append(self._emit(self._held[1]))
                self._held = None
            out.append(self._emit(block))
            return out
        dtype = data.get("type")
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
        if dtype == "response.completed":
            out.append(self._emit(self._tag_item_block(block)))
            return out
        if self._held is not None:
            out.append(self._emit(self._held[1]))
            self._held = None
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
        if self._held is not None:
            out.append(self._emit(self._held[1]))
            self._held = None
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
    server_version = "jev-router/1.0"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
                    "name": "Jev Auto",
                }],
            })
        elif path in ("/health", ""):
            self._json(200, {"ok": True, "service": "jev-router"})
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
        if os.path.exists(OFF_PATH):
            model, effort, speed, gate = ASTRA, None, None, "off"
        elif task.lstrip().startswith("You are creating a lossy continuation checkpoint"):
            # Quality first: the checkpoint defines the continuation context, so
            # compaction calls are pinned instead of left to the per-call judge.
            model, effort, speed, gate = SOL, "high", "default", "compaction"
        else:
            key = load_key()
            if key and task:
                jt0 = time.time()
                state = {"task": task[:500], "signals": signals,
                         "step": {"type": step["step_type"]}}
                if prev_assistant:
                    state["previous_assistant"] = prev_assistant[-240:]
                if step["step_type"] == "tool_step":
                    state["step"]["last_tool_output_tail"] = step["digest"]
                    state["step"]["contains_error"] = step["errored"]
                try:
                    answer = (call_jev(key, state).get("answers") or {})
                    tier_ans = answer.get("tier") or {}
                    tier = tier_ans.get("choice") if tier_ans.get("choice") in TIERS else None
                    conf = tier_ans.get("confidence")
                    if not isinstance(conf, (int, float)):
                        conf = None
                    depth_ans = answer.get("depth") or {}
                    depth = depth_ans.get("choice")
                    model, effort, speed, gate = route(tier, depth, conf)
                except Exception as exc:
                    model, effort, speed, gate = ASTRA, "medium", "default", f"jev_error:{type(exc).__name__}"
                jev_ms = int((time.time() - jt0) * 1000)
            else:
                model, effort, speed, gate = ASTRA, "medium", "default", "no_key_or_task"

        would = None
        if os.path.exists(SHADOW_PATH):
            would = {"model": model, "effort": effort, "speed": speed, "gate": gate}
            model, effort, speed, gate = ASTRA, None, None, "shadow(astra)"

        # Codex-dry tandem: ONLY while native usage is exhausted (manual flag or
        # observed quota failure) the triptych is replaced — GLM for frontier
        # steps, deepseek for the rest. Otherwise luna/sol/astra run untouched.
        dry_reason = native_dry()
        native_model = model
        if dry_reason and model in TIERS:
            model, effort = dry_target(native_model, effort)
            speed = None
            gate = f"codex_dry({dry_reason}):{native_model}"

        shown = would if would else {"model": model, "effort": effort}
        marker = route_marker(shown["model"], shown["effort"])

        def apply_route(payload, model, effort, speed):
            payload["model"] = model
            if effort:
                reasoning = payload.get("reasoning")
                reasoning = dict(reasoning) if isinstance(reasoning, dict) else {}
                reasoning["effort"] = effort
                payload["reasoning"] = reasoning
            if speed:
                payload["service_tier"] = speed
            else:
                payload.pop("service_tier", None)
            payload["stream"] = True  # the local caller edge requires streaming
            return payload

        apply_route(payload, model, effort, speed)

        out_path = path if path.startswith("/v1") else "/v1" + path
        status, out_kind, ctype, quota_hit = self._forward(
            payload, out_path, stream_requested, debug, marker, model)
        retried = False
        if quota_hit and not dry_reason:
            # Native usage is exhausted: flip to the Go tandem and retry this very
            # call so the turn does not fail (nothing reached the client yet).
            mark_native_dry("quota")
            model, effort = dry_target(native_model, effort)
            apply_route(payload, model, effort, None)
            retried = True
            gate = f"codex_dry(retry):{native_model}"
            marker = route_marker(model, effort)
            status, out_kind, ctype, _ = self._forward(
                payload, out_path, stream_requested, debug, marker, model)
        elif status == 200 and not dry_reason and model in TIERS and os.path.exists(DRY_STATE_PATH):
            # Native answered again: drop the stale auto state (never the flag).
            clear_native_dry()
            dry_reason = "cleared"

        log_line({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "gate": gate,
            "tier": tier,
            "conf": conf,
            "depth": depth,
            "model": model,
            "effort": effort,
            "speed": speed,
            "native": native_model,
            "dry": dry_reason,
            "retried": retried,
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
            "would": would,
            "task": task[:110],
        })

    def _forward(self, payload, out_path, stream_requested, debug, marker, model):
        """One relay attempt to the local caller edge, streamed straight back.

        Returns (status, out_kind, ctype, quota_hit). ``quota_hit`` is True only
        for a >=400 response whose body looks like exhausted native usage; in
        that case nothing has been written to the client yet, so the caller can
        retry the same payload on another model.
        """
        body = json.dumps(payload).encode("utf-8")
        conn = http.client.HTTPConnection(*ROUTER, timeout=900)
        status = 0
        out_kind = ""
        ctype = ""
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
                markerer = SummaryMarker(marker)
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
                    return status, out_kind, ctype, True
                # The caller edge always streams; rebuild a proper single JSON
                # object for non-stream callers (compactions, litellm's
                # non-stream provider path) instead of forwarding raw SSE bytes.
                if status == 200 and (head.startswith(b"event:") or head.startswith(b"data:")):
                    assembled = assemble_sse(data)
                    if assembled is not None:
                        data = json.dumps(assembled).encode("utf-8")
                        out_ctype = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", out_ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            return status, out_kind, ctype, False
        finally:
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
