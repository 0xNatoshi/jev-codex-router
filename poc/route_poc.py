#!/usr/bin/env python3
"""Jev Codex Router — POC (default routing policy).

Default routing policy:
  luna  -> adaptive thinking (per task) + default speed
  sol   -> adaptive thinking (per task) + default speed
  astra -> adaptive thinking (per task) + default speed

Usage: python3 route_poc.py [--dry] [--tasks tasks.json] [--model jev-latest]
Key lookup: $TYPESAFE_API_KEY, then ~/.hermes/.env, then ~/.jev.env.
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

API = "https://api.typesafe.ai/v1/systemone"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from routing_policy import (MODEL_PROFILES, POLICY_VERSION, QUESTIONS,
                            decision_from_answers, route)

CANDIDATES = MODEL_PROFILES


def route_for(tier, depth):
    return route(tier, depth)[:3]


def questions():
    return QUESTIONS


def load_key():
    """The file wins (the environment can be polluted); env as a last resort."""
    for path in ("~/.hermes/.env", "~/.jev.env"):
        p = os.path.expanduser(path)
        if os.path.exists(p):
            found = ""
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if line.startswith("TYPESAFE_API_KEY="):
                    v = line.split("=", 1)[1].strip().strip("'\"")
                    if v:
                        found = v
            if found:
                return found
    return os.environ.get("TYPESAFE_API_KEY", "").strip().strip("'\"")

def post_json(url, key, body, attempts=3):
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                         headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 503) and i < attempts - 1:
                time.sleep(0.5 * 2 ** i)
                continue
            raise RuntimeError(f"HTTP {e.code}; no routing decision.")
        except Exception as e:
            if i < attempts - 1:
                time.sleep(0.5 * 2 ** i)
                continue
            raise RuntimeError(f"connection failed: {e!r}")

def run(args):
    tasks = json.load(open(args.tasks, encoding="utf-8"))
    key = load_key()
    if not args.dry and not key:
        print("!! TYPESAFE_API_KEY not found (env, ~/.hermes/.env, ~/.jev.env). Use --dry to validate payloads.")
        return 2
    q = questions()
    results = []
    for t in tasks:
        state = {"task": t["text"], "signals": t.get("signals", {})}
        body = {"model": args.model, "state": state, "questions": q}
        if args.dry:
            print(f"[dry] #{t['id']}: {t['text'][:70]}…")
            continue
        started = time.perf_counter()
        try:
            resp = post_json(API, key, body)
            ans = resp.get("answers", {})
            decision = decision_from_answers(ans)
            model, effort, speed = (decision["model"], decision["effort"], decision["speed"])
            confidence = decision["confidence"]
            ms = round((time.perf_counter() - started) * 1000)
            usage = resp.get("usage", {}) or {}
            results.append({"id": t["id"], "tier": model, "conf": confidence, "policy_version": POLICY_VERSION,
                            "depth": effort, "model": model, "effort": effort, "speed": speed,
                            "expect": str(t.get("expect")), "ms": ms,
                            "in_tok": usage.get("input_tokens") or usage.get("inputTokens")})
            flag = "" if str(t.get("expect")) == model else f"  (expected: {t.get('expect')})"
            print(f"#{t['id']:>3}  {model:<14} conf={confidence} -> @{effort} [{speed}]  {ms} ms{flag}")
        except Exception as e:
            print(f"#{t['id']:>3}  ERROR: {e}")
    if results:
        import statistics
        total_tok = sum((r["in_tok"] or 0) for r in results)
        lat = [r["ms"] for r in results]
        agree = sum(1 for r in results if r.get("expect") == r["tier"])
        print("-" * 78)
        print(f"{len(results)} tasks · median latency {statistics.median(lat):.0f} ms · {total_tok} tokens in (≈ ${total_tok/1e6*0.042:.5f}) · tier agreement {agree}/{len(results)}")
    return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--tasks", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json"))
    ap.add_argument("--model", default="jev-latest")
    return run(ap.parse_args())

if __name__ == "__main__":
    sys.exit(main())
