#!/usr/bin/env python3
"""Jev Router — serveur local 127.0.0.1:4319 pour le Codex Router.

Reçoit les requêtes Responses destinées au modèle « jev/auto » (generic provider
« jev » du Codex Router), demande à Jev (TypeSafe System One) le tier et la
profondeur de réflexion, applique la politique de route, puis relaie vers
l'edge local du Codex Router (partage de session native activé) — sans aucune
conversion de format : Responses in, Responses out, SSE relayé tel quel.

Politique de route par défaut :
  luna  → thinking max systématique + speed priority (le 2x ne coûte rien)
  sol   → thinking adaptatif selon la tâche (depth Jev) + speed standard
  astra → thinking adaptatif selon la tâche (depth Jev) + speed standard
  conf < 0.5 → HOLD : on ne dégrade pas (astra), loggé pour calibration.

Fail-open : toute erreur Jev → astra @medium. Kill switch : créer le fichier
~/.codex/codex-router/jev-router.off → relais astra sans décision.
Journal : ~/.codex/codex-router/jev-router-live.jsonl
"""
import http.client
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".codex", "codex-router")
ENV_PATH = os.path.join(HOME, ".hermes", ".env")
CALLER_SECRET_PATH = os.path.join(STATE, "caller-secret")
OFF_PATH = os.path.join(STATE, "jev-router.off")
LOG_PATH = os.path.join(STATE, "jev-router-live.jsonl")

LISTEN = ("127.0.0.1", 4319)
ROUTER = ("127.0.0.1", 4202)

API = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

LUNA, SOL, ASTRA = "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"
TIERS = (LUNA, SOL, ASTRA)
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CONF_GATE = 0.5

QUESTIONS = {
    "tier": {
        "type": "choice",
        "instructions": (
            "Which model tier should serve this coding task? "
            "gpt-5.6-luna: fast and cheap, for mechanical or clearly scoped tasks (rename, format, "
            "simple edits, explanations). "
            "gpt-5.6-sol: workhorse for standard implementation work (features, multi-step edits, "
            "refactors with clear scope). "
            "gpt-6-astra: frontier model for hard problems (architecture, complex debugging, "
            "ambiguous or risky changes)."
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
            "What thinking depth does this task require? Set the thinking effort level: low = "
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
    """TYPESAFE_API_KEY : le fichier ~/.hermes/.env est prioritaire (env parfois périmé)."""
    try:
        with open(ENV_PATH, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("TYPESAFE_API_KEY="):
                    value = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if value:
                        return value
    except OSError:
        pass
    return os.environ.get("TYPESAFE_API_KEY", "").strip()


def caller_secret():
    with open(CALLER_SECRET_PATH, encoding="utf-8") as fh:
        return fh.read().strip()


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
    """Applique la politique de route. Retourne (model, effort, speed, gate)."""
    if conf is not None and conf < CONF_GATE:
        return ASTRA, clamp_effort(depth), "default", "hold(astra)"
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
    """Dernier message user + dernier assistant + petites stats."""
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


def assemble_sse(raw):
    """Reconstruit l'objet réponse final depuis un flux SSE (requêtes non-stream)."""
    final = None
    error = None
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
        if etype == "response.completed":
            final = event.get("response")
        elif isinstance(etype, str) and etype in ("response.failed", "error"):
            error = event
    if final is not None:
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
        except Exception as exc:  # fail-open au niveau réponse uniquement
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
        task, prev_assistant, signals = extract(payload)
        stream_requested = payload.get("stream") is True

        tier = depth = conf = None
        jev_ms = None
        if os.path.exists(OFF_PATH):
            model, effort, speed, gate = ASTRA, None, None, "off"
        else:
            key = load_key()
            if key and task:
                jt0 = time.time()
                state = {"task": task[:500], "signals": signals}
                if prev_assistant:
                    state["previous_assistant"] = prev_assistant[-240:]
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

        payload["model"] = model
        if effort:
            reasoning = payload.get("reasoning")
            reasoning = dict(reasoning) if isinstance(reasoning, dict) else {}
            reasoning["effort"] = effort
            payload["reasoning"] = reasoning
        if speed:
            payload["service_tier"] = speed
        payload["stream"] = True  # l'edge local exige le streaming

        out_path = path if path.startswith("/v1") else "/v1" + path
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
            # L'edge local ne pose AUCUN Content-Type sur les flux SSE. Pour une
            # requête stream, une réponse 200 EST un flux SSE : on force
            # l'en-tête de sortie, car le forwarder choisit son parseur dessus
            # (text/event-stream → relais SSE, application/json → parse JSON).
            is_sse = ("text/event-stream" in ctype) or (status == 200 and stream_requested)
            out_kind = ""

            if is_sse and stream_requested:
                out_kind = "sse"
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                out_kind = "json"
                data = resp.read()
                out_ctype = ctype or "application/json"
                if status == 200 and is_sse and not stream_requested:
                    assembled = assemble_sse(data)
                    if assembled is not None:
                        data = json.dumps(assembled).encode("utf-8")
                        out_ctype = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", out_ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        finally:
            conn.close()
            log_line({
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "gate": gate,
                "tier": tier,
                "conf": conf,
                "depth": depth,
                "model": model,
                "effort": effort,
                "speed": speed,
                "jev_ms": jev_ms,
                "total_ms": int((time.time() - t0) * 1000),
                "status": status,
                "stream": stream_requested,
                "out": out_kind,
                "uctype": ctype,
                "n_items": signals.get("n_items"),
                "img": signals.get("has_image"),
                "task": task[:110],
            })


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
