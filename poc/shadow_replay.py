#!/usr/bin/env python3
"""Étape 2 — SHADOW MODE v2 (replay hors-ligne sur de vraies requêtes Codex).

- État enrichi : projet (cwd), continuité (dernier message assistant), signaux
  (pièces jointes, fragment court), en plus du texte de la requête.
- Déduplique via shadow-log.jsonl → les runs quotidiens n'ajoutent que du nouveau.
- --quiet : une seule ligne de résumé (pour le cron).
- Gate de confiance : conf < 0.5 → "hold" (ne pas dégrader), sinon "apply".

AUCUN impact sur le router : lecture seule + appels Jev. Le routage réel n'est pas touché.

Usage: python3 shadow_replay.py [--limit 40] [--days 3] [--dry] [--quiet] [--log PATH] [--ignore-seen]
"""
import argparse, datetime, glob, importlib.util, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("poc", os.path.join(HERE, "route_poc.py"))
poc = importlib.util.module_from_spec(_spec)
sys.modules["poc"] = poc
_spec.loader.exec_module(poc)

SESS_ROOT = os.path.expanduser("~/.codex/sessions")
DEFAULT_LOG = os.path.join(HERE, "..", "shadow-log.jsonl")
TAG_CLEAN = re.compile(r"<[^>]+>")
CONF_GATE = 0.5


def recent_session_files(days):
    cut = time.time() - days * 86400
    files = []
    for p in glob.glob(os.path.join(SESS_ROOT, "*", "*", "*", "*.jsonl")):
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_mtime >= cut:
            files.append((st.st_mtime, p))
    files.sort(reverse=True)
    return [p for _, p in files]


def _message_text(p):
    parts = []
    for c in p.get("content") or []:
        if isinstance(c, dict) and c.get("type") in ("input_text", "text", "output_text"):
            parts.append(c.get("text") or "")
    return "\n".join(parts)


def extract_user_turns(path, cap=6):
    """[{text, cwd, prev}] — tours utilisateur + contexte (cwd de session, dernier assistant)."""
    out, cwd, prev = [], "", ""
    try:
        for line in open(path, encoding="utf-8"):
            if len(out) >= cap:
                break
            if '"session_meta"' not in line and '"role"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            p = d.get("payload") or {}
            if t == "session_meta":
                cwd = p.get("cwd") or cwd
                continue
            if t != "response_item" or not isinstance(p, dict) or p.get("type") != "message":
                continue
            role = p.get("role")
            if role == "assistant":
                txt = re.sub(r"\s+", " ", TAG_CLEAN.sub(" ", _message_text(p))).strip()
                if txt:
                    prev = txt[-240:]
            elif role == "user":
                text = re.sub(r"\s+", " ", TAG_CLEAN.sub(" ", _message_text(p))).strip()
                if len(text) < 12 or text.startswith("## "):
                    continue
                out.append({"text": text, "cwd": cwd, "prev": prev})
    except Exception as e:
        print(f"  !! {os.path.basename(path)}: {e!r}", file=sys.stderr)
    return out


def build_state(turn):
    text = turn["text"]
    cwd = turn.get("cwd") or ""
    signals = {
        "source": "codex-session",
        "project": os.path.basename(cwd.rstrip("/")) if cwd else None,
        "has_files": bool(re.search(r"# Files (mentioned|pasted) by the user", text)),
        "short_followup": len(text) < 60,
    }
    state = {"task": text[:500], "signals": signals}
    if turn.get("prev"):
        state["previous_assistant"] = turn["prev"]
    return state


def load_seen(log_path):
    seen = set()
    if os.path.exists(log_path):
        for line in open(log_path, encoding="utf-8"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            k = (d.get("task") or "")[:80].lower()
            if k:
                seen.add(k)
    return seen


def summarize_actual(days):
    from collections import Counter
    p = os.path.expanduser("~/.codex/codex-router/usage-events.jsonl")
    if not os.path.exists(p):
        return Counter()
    cut = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    c = Counter()
    for line in open(p, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("status") != 200:
            continue
        at = (d.get("at") or "").replace("Z", "+00:00")
        try:
            if datetime.datetime.fromisoformat(at) < cut:
                continue
        except Exception:
            pass
        c[d.get("model") or "?"] += 1
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--ignore-seen", action="store_true")
    args = ap.parse_args()

    files = recent_session_files(args.days)
    seen = set() if args.ignore_seen else load_seen(args.log)
    tasks, skipped = [], 0
    for path in files:
        for turn in extract_user_turns(path):
            k = turn["text"][:80].lower()
            if k in seen:
                skipped += 1
                continue
            seen.add(k)
            tasks.append((path, turn))
    tasks = tasks[: args.limit]
    if not args.quiet:
        print(f"sessions récentes ({args.days} j): {len(files)} | nouveaux tours: {len(tasks)} (skipped {skipped})")
    if args.dry:
        for p, t in tasks[:12]:
            print(f"- [{os.path.basename(p)[:34]}] {t['text'][:95]}")
        return 0

    key = poc.load_key()
    if not key:
        print("!! clé absente (~/.hermes/.env)", file=sys.stderr)
        return 2

    q = poc.questions()
    dist, holds, errors, n_tok = {}, 0, 0, 0
    ts = datetime.datetime.now().isoformat(timespec="seconds")
    with open(args.log, "a", encoding="utf-8") as logf:
        for i, (path, turn) in enumerate(tasks, 1):
            state = build_state(turn)
            t0 = time.perf_counter()
            try:
                resp = poc.post_json("https://api.typesafe.ai/v1/systemone", key,
                                     {"model": "jev-latest", "state": state, "questions": q})
                ans = resp.get("answers", {})
                tier = poc.validate_choice(ans.get("tier", {}), set(poc.CANDIDATES))
                d = (ans.get("depth") or {}).get("choice") or "medium"
                model, effort, speed = poc.route_for(tier["choice"], d)
                gate = "apply" if tier["confidence"] >= CONF_GATE else "hold"
                if gate == "hold":
                    holds += 1
                n_tok += (resp.get("usage", {}) or {}).get("input_tokens", 0) or 0
                rec = {"at": ts, "state_v": 2, "session": os.path.basename(path),
                       "task": turn["text"][:140], "project": state["signals"].get("project"),
                       "tier": tier["choice"], "tier_conf": round(tier["confidence"], 3),
                       "depth": d, "gate": gate,
                       "route": {"model": model, "effort": effort, "speed": speed},
                       "decide_ms": round((time.perf_counter() - t0) * 1000)}
                logf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                logf.flush()
                dist[model] = dist.get(model, 0) + 1
                if not args.quiet:
                    print(f"#{i:>2}  {tier['choice']:<14} conf={tier['confidence']:.2f} [{gate}] depth={d:<7} -> @{effort} [{speed}]  |  {turn['text'][:52]}…")
            except Exception as e:
                errors += 1
                if not args.quiet:
                    print(f"#{i:>2}  ERREUR: {e}")
                else:
                    print(f"[jev-shadow] ERREUR tache {i}: {e}", file=sys.stderr)

    print(f"[jev-shadow] +{len(tasks)} routes | luna {dist.get('gpt-5.6-luna', 0)} · sol {dist.get('gpt-5.6-sol', 0)} · astra {dist.get('gpt-6-astra', 0)} | holds {holds} | err {errors} | {n_tok} tok | {ts}")
    if not args.quiet:
        actual = summarize_actual(args.days)
        if actual:
            print(f"usage réel ({args.days} j, 200): {dict(actual.most_common(8))}")
        print(f"log: {os.path.abspath(args.log)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
