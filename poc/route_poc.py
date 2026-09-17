#!/usr/bin/env python3
"""Jev Codex Router — POC (default routing policy).

Default routing policy:
  luna  -> ALWAYS max thinking + priority speed (2x cost is negligible)
  sol   -> adaptive thinking (per task) + default speed
  astra -> adaptive thinking (per task) + default speed

Usage: python3 route_poc.py [--dry] [--tasks tasks.json] [--model jev-latest]
Key lookup: $TYPESAFE_API_KEY, then ~/.hermes/.env, then ~/.jev.env.
"""
import argparse, json, math, os, sys, time, urllib.error, urllib.request

API = "https://api.typesafe.ai/v1/systemone"

CANDIDATES = {
    "gpt-5.6-luna": "Cheap quick tier. Always runs at MAXIMUM thinking with fast mode (priority). Use for mechanical or clearly scoped tasks: renames, formatting, small edits, lookups, simple explanations.",
    "gpt-5.6-sol": "Workhorse. Standard implementation, tests, refactors, multi-file changes with clear requirements. Thinking depth adapts to the task.",
    "gpt-6-astra": "Frontier reasoning. Hard debugging, race conditions, architecture, security review, ambiguous failures. Thinking depth adapts to the task.",
}

DEPTH_LEVELS = ["low", "medium", "high", "xhigh", "max"]

# --- default routing policy ---
SPEED_TIER_MODEL = "gpt-5.6-luna"          # speed=priority is reserved for Luna
LUNA_EFFORT = "max"                        # Luna always runs max thinking
SOL_LEVELS = ["low", "medium", "high", "xhigh", "max"]
ASTRA_LEVELS = ["medium", "high", "xhigh", "max"]

def clamp(level, allowed):
    if level in allowed:
        return level
    if level is None:
        level = "medium"
    target = DEPTH_LEVELS.index(level) if level in DEPTH_LEVELS else 1
    return min(allowed, key=lambda l: abs(DEPTH_LEVELS.index(l) - target))

def route_for(tier, depth):
    """(model, effort, speed) per the routing policy."""
    if tier == SPEED_TIER_MODEL:
        return tier, LUNA_EFFORT, "priority"
    if tier == "gpt-5.6-sol":
        return tier, clamp(depth, SOL_LEVELS), "default"
    return tier, clamp(depth, ASTRA_LEVELS), "default"

def questions():
    return {
        "tier": {
            "type": "choice",
            "instructions": {
                "question": "Which model tier should handle this coding task?",
                "goal": "Route a Codex coding task to the cheapest model that can reliably complete it in one or two attempts.",
                "inputs": "`task` is the user's request. `signals` are computed features.",
                "rules": "Prefer luna for mechanical or clearly scoped tasks. Use sol for standard implementation work. Reserve astra for deep reasoning, hard debugging, architecture, or security judgment. When unsure, prefer the stronger tier.",
            },
            "criteria": CANDIDATES,
        },
        "depth": {
            "type": "choice",
            "instructions": "What thinking depth does this task require? For trivially mechanical tasks choose the lowest level; hardest problems need the maximum.",
            "criteria": {
                "low": "No deep reasoning needed.",
                "medium": "Some careful thought.",
                "high": "Substantial reasoning required.",
                "xhigh": "Very deep reasoning.",
                "max": "Maximum reasoning depth for the hardest problems.",
            },
        },
    }

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

def validate_choice(answer, ids):
    probs = answer.get("probabilities") or {}
    conf = answer.get("confidence")
    ok = (answer.get("choice") in ids
          and set(probs) == set(ids)
          and all(isinstance(n, (int, float)) and math.isfinite(n) and 0 <= n <= 1 for n in [*probs.values(), conf if conf is not None else 0])
          and abs(sum(probs.values()) - 1) < 0.02
          and probs[answer["choice"]] >= max(probs.values()) - 1e-6)
    if not ok:
        raise ValueError(f"invalid choice answer: {answer!r}")
    return answer

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
            tier = validate_choice(ans.get("tier", {}), set(CANDIDATES))
            d = ans.get("depth", {}) or {}
            depth_level = d.get("score") or d.get("choice") or "medium"
            model, effort, speed = route_for(tier["choice"], depth_level)
            ms = round((time.perf_counter() - started) * 1000)
            usage = resp.get("usage", {}) or {}
            results.append({"id": t["id"], "tier": tier["choice"], "conf": tier["confidence"],
                            "depth": depth_level, "model": model, "effort": effort, "speed": speed,
                            "expect": str(t.get("expect")), "ms": ms,
                            "in_tok": usage.get("input_tokens") or usage.get("inputTokens")})
            flag = "" if str(t.get("expect")) == tier["choice"] else f"  (expected: {t.get('expect')})"
            print(f"#{t['id']:>3}  {tier['choice']:<14} conf={tier['confidence']:.2f}  depth={str(depth_level):<6} -> {model} @{effort} [{speed}]  {ms} ms{flag}")
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
