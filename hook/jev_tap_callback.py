"""Jev tap — callback LiteLLM (BROUILLON, pas encore installé).

Tap fail-open : chaque requête passant par le gateway est journalisée en local (JSONL).
AUCUN appel réseau ici — l'analyse Jev se fait hors-bande (voir poc/shadow_replay.py).

Installation (exploration — approche non retenue) :
  1. copier ce fichier dans ~/.codex/codex-router/jev_tap_callback.py
  2. ajouter "jev_tap_callback.jev_tap_callback" à callbacks: dans litellm.yaml
  3. redémarrer le service router
"""
import json
import os
import time

TAP_PATH = os.path.expanduser("~/.codex/codex-router/jev-tap.jsonl")
MAX_TEXT = 600


def _last_user_text(data):
    msgs = data.get("messages") or data.get("input") or []
    if isinstance(msgs, str):
        return msgs[:MAX_TEXT]
    if isinstance(msgs, list):
        for m in reversed(msgs):
            if isinstance(m, dict) and m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, str):
                    return c[:MAX_TEXT]
                if isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict) and part.get("type") in ("text", "input_text"):
                            return (part.get("text") or "")[:MAX_TEXT]
        # Responses API: input list of items
        for m in reversed(msgs):
            if isinstance(m, dict) and m.get("type") == "message" and m.get("role") == "user":
                for part in m.get("content") or []:
                    if isinstance(part, dict) and part.get("type") == "input_text":
                        return (part.get("text") or "")[:MAX_TEXT]
    return ""


class jev_tap_callback:
    """LiteLLM CustomLogger — journalise le dernier message user, rien d'autre."""

    def __init__(self):
        self.tap_path = TAP_PATH

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            rec = {
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "model": data.get("model"),
                "call_type": str(call_type),
                "stream": bool(data.get("stream")),
                "n_messages": len(data.get("messages") or data.get("input") or []),
                "last_user": _last_user_text(data),
                "source": "jev-tap",
            }
            with open(self.tap_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass  # fail-open : jamais d'exception dans le chemin requête
        return data
