#!/usr/bin/env python3
"""Backtest — estimate Jev routing savings on real Codex sessions.

Replays real turns from the last N days:
  - real tokens per turn   (token_usage_record → turn_token_usage)
  - real model per session (thread_settings_applied)
  - Jev route per turn     (tier + depth → luna/sol/astra policy)
and compares the "API-equivalent" cost of both scenarios at published prices
(short context, Sep 2026):

  astra $10/$50 · sol $4/$20 · terra $2/$12 · luna $0.20/$1.20 (standard speed)

Usage: python3 backtest_savings.py [--days 7] [--limit-unique 300]
"""
import argparse, datetime, glob, hashlib, importlib.util, json, os, re, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import jev_server as jev

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("poc", os.path.join(HERE, "route_poc.py"))
poc = importlib.util.module_from_spec(_spec)
sys.modules["poc"] = poc
_spec.loader.exec_module(poc)

SESS_ROOT = os.path.expanduser("~/.codex/sessions")
RESULT_PATH = os.path.expanduser("~/.codex/codex-router/jev-backtest.json")

# Prices per 1M tokens (short context, OpenAI API page, Sep 2026)
PRICES = {
    "gpt-6-astra":   (10.00, 50.00, 1.00, 12.50),   # (input, output, cached_in, cache_write)
    "gpt-5.6-sol":   (4.00, 20.00, 0.40, 5.00),
    "gpt-5.6-terra": (2.00, 12.00, 0.20, 2.50),
    "gpt-5.6-luna":  (0.20, 1.20, 0.02, 0.25),
    # off-peak, aligned with V4 Flash (cf. router docs)
    "deepseek/deepseek-v4.1-flash": (0.15, 0.60, 0.015, 0.15),
}
TAG_CLEAN = re.compile(r"<[^>]+>")


def turn_key(turn):
    # Identical short replies can refer to entirely different preceding work.
    return hashlib.sha256(json.dumps(turn.get("state") or {k: turn.get(k) for k in ("text", "prev", "cwd")},
                                     sort_keys=True).encode()).hexdigest()


def route_policy(tier, depth, conf=None):
    return poc.route_for(tier, depth)[0]


def cost(model, tok):
    p_in, p_out, p_cached, p_write = PRICES[model]
    inp = tok.get("input_tokens", 0) or 0
    cached = min(tok.get("cached_input_tokens", 0) or 0, inp)
    write = tok.get("cache_write_input_tokens", 0) or 0
    out = tok.get("output_tokens", 0) or 0
    uncached = max(inp - cached - write, 0)
    return (uncached * p_in + cached * p_cached + write * p_write + out * p_out) / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--limit-unique", type=int, default=300)
    ap.add_argument("--from-cache", action="store_true",
                    help="reuse routes_detail from the last run (no Jev calls)")
    args = ap.parse_args()

    cut = time.time() - args.days * 86400
    files = [p for p in glob.glob(os.path.join(SESS_ROOT, "*", "*", "*", "*.jsonl"))
             if os.stat(p).st_mtime >= cut]
    files.sort()
    print(f"sessions ({args.days} d): {len(files)}")

    all_turns = []
    for path in files:
        # sequential parse: task_started → user text → cumulative turn tokens
        seq, cur, last_assist, model2, cwd2 = [], None, "", "unknown-model", ""
        history = []
        with open(path, encoding="utf-8") as session_file:
            for line in session_file:
                if '"session_meta"' not in line and '"response_item"' not in line and '"task_started"' not in line \
                   and '"token_usage_record"' not in line and '"thread_settings_applied"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get("type"); p = d.get("payload") or {}
                if t == "session_meta":
                    cwd2 = p.get("cwd") or cwd2; continue
                if t == "event_msg" and p.get("type") == "task_started":
                    cur = {"turn_id": p.get("turn_id"), "text": "", "prev": last_assist,
                           "tok": None, "model": model2, "cwd": cwd2}
                    seq.append(cur); continue
                if t == "event_msg" and p.get("type") == "thread_settings_applied":
                    th = p.get("thread_settings") or {}
                    if th.get("model"):
                        model2 = th["model"]
                    continue
                if t == "response_item" and isinstance(p, dict):
                    history.append(p)
                    if p.get("type") != "message":
                        continue
                    role = p.get("role")
                    text = jev._content_text(p.get("content")).strip()
                    if role == "user" and cur is not None and not cur["text"]:
                        if jev.task_for_jev(text):
                            cur["text"] = text
                            payload = {"input": history}
                            jev.strip_signatures(payload)
                            cur["state"] = jev.decision_dossier(payload)
                    elif role == "assistant" and text:
                        last_assist = text[-240:]
                    continue
                if t == "token_usage_record" and cur is not None and p.get("turn_id") == cur.get("turn_id"):
                    if cur["tok"] is None:
                        cur["model"] = model2
                    elif cur["model"] != model2:
                        cur["model"] = "mixed-model-turn"
                    cur["tok"] = p.get("turn_token_usage") or p.get("usage")
        for tk in seq:
            if tk["text"] and tk["tok"] and (tk["tok"].get("input_tokens") or 0) > 0:
                all_turns.append(tk)

    print(f"usable turns: {len(all_turns)}")
    if not all_turns:
        return 1

    # One key per Jev call (memoized); multiplicity = real turns
    unique = {}
    for tk in all_turns:
        key = turn_key(tk)
        unique.setdefault(key, {"n": 0, "state": tk["state"]})
        unique[key]["n"] += 1
    keys = list(unique)[: args.limit_unique]
    print(f"unique prompts to classify with Jev: {len(keys)}")

    routes = {}
    if args.from_cache:
        with open(RESULT_PATH, encoding="utf-8") as cache_file:
            cached = json.load(cache_file)
        if cached.get("policy_version") != poc.POLICY_VERSION:
            print("Cached decisions use another policy; reclassify before comparing costs.")
            return 2
        routes = cached.get("routes_detail") or {}
        print(f"routes from cache: {len(routes)}")
    key = None if args.from_cache else poc.load_key()
    if not args.from_cache and not key:
        print("!! TYPESAFE_API_KEY missing")
        return 2
    q = poc.questions() if not args.from_cache else None
    t0 = time.time()
    for i, k in enumerate([] if args.from_cache else keys, 1):
        u = unique[k]
        state = u["state"]
        try:
            resp = poc.post_json("https://api.typesafe.ai/v1/systemone", key,
                                 {"model": "jev-latest", "state": state, "questions": q})
            ans = resp.get("answers", {})
            decision = poc.decision_from_answers(ans)
            routes[k] = {"tier": decision["model"], "conf": decision["confidence"],
                         "depth": decision["effort"], "route": decision["model"]}
        except Exception as e:
            routes[k] = {"tier": None, "conf": None, "depth": None, "route": "gpt-6-astra"}
            print(f"  #{i}: Jev error → astra ({e})")
        if i % 25 == 0:
            print(f"  ...{i}/{len(keys)} ({time.time()-t0:.0f}s)")
    print(f"Jev classification: {len(keys)} prompts in {time.time()-t0:.0f}s")

    # Aggregate
    sum_actual = sum_jev = 0.0
    tok_volume = {"input": 0, "cached": 0, "output": 0}
    dist_counts, dist_weights, dist_costs = {}, {}, {}
    skipped, model_seen = 0, {}
    included_turns = []
    for tk in all_turns:
        tok = tk["tok"]
        try:
            ca = cost(tk["model"], tok)
            r_info = routes.get(turn_key(tk))
            if r_info is None:
                skipped += 1
                continue
            r = ("gpt-6-astra" if r_info.get("tier") is None
                 else route_policy(r_info["tier"], r_info.get("depth"), r_info.get("conf")))
            cj = cost(r, tok)
        except KeyError:
            skipped += 1
            continue
        included_turns.append(tk)
        model_seen[tk["model"]] = model_seen.get(tk["model"], 0) + 1
        tok_volume["input"] += tok.get("input_tokens") or 0
        tok_volume["cached"] += tok.get("cached_input_tokens") or 0
        tok_volume["output"] += tok.get("output_tokens") or 0
        sum_actual += ca
        sum_jev += cj
        dist_counts[r] = dist_counts.get(r, 0) + 1
        for k2 in [turn_key(tk)]:
            dist_weights[r] = dist_weights.get(r, 0) + unique[k2]["n"] if k2 in unique else 0
        dist_costs[r] = dist_costs.get(r, 0) + cj

    pct = (sum_actual - sum_jev) / sum_actual * 100 if sum_actual else 0
    scen = {name: sum(cost(name, tk["tok"]) for tk in included_turns) for name in PRICES}
    astra_all = scen["gpt-6-astra"]
    result = {
        "at": datetime.datetime.now().isoformat(timespec="seconds"),
        "policy_version": poc.POLICY_VERSION,
        "days": args.days, "turns": len(included_turns), "skipped_turns": skipped, "unique": len(keys),
        "tokens": tok_volume,
        "actual_usd": round(sum_actual, 2), "jev_usd": round(sum_jev, 2),
        "savings_pct": round(pct, 1),
        "scenarios_usd": {k: round(v, 2) for k, v in scen.items()},
        "full_astra_usd": round(astra_all, 2),
        "savings_vs_astra_pct": round((astra_all - sum_jev) / astra_all * 100, 1) if astra_all else None,
        "routes": {k: {"turns": dist_counts.get(k, 0), "cost_usd": round(dist_costs.get(k, 0), 2)}
                   for k in PRICES},
        "routes_detail": routes,
        "actual_models": model_seen,
    }
    os.makedirs(os.path.dirname(RESULT_PATH), exist_ok=True)
    with open(RESULT_PATH, "w", encoding="utf-8") as result_file:
        json.dump(result, result_file, indent=2)

    print("\n" + "=" * 72)
    print(f"BACKTEST — {len(all_turns)} real turns / {args.days} days")
    print(f"tokens: input {tok_volume['input']/1e6:.1f}M (cached {tok_volume['cached']/1e6:.1f}M) · output {tok_volume['output']/1e6:.3f}M")
    print(f"actual scenario  (session mix, published prices): ${sum_actual:.2f}")
    print(f"Jev scenario     : ${sum_jev:.2f}")
    print(f"→ ESTIMATED SAVINGS: {pct:.1f} %")
    print(f"actual models: {model_seen} · skipped: {skipped}")
    print("100% scenarios: " + " · ".join(
        f"{k.split('/')[-1]} ${v:.0f}" for k, v in sorted(scen.items(), key=lambda x: x[1])))
    print(f"full-Astra baseline: ${astra_all:.0f} (fixed token volume; not measured quota)")
    print("-" * 72)
    for k in ("gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"):
        print(f"  {k:<14} {dist_counts.get(k,0):>4} turns · ${dist_costs.get(k,0):.2f}")
    print(f"result: {RESULT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
