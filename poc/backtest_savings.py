#!/usr/bin/env python3
"""Backtest — estimate Jev routing savings on real Codex sessions.

Replays real turns from the last N days:
  - real tokens per turn   (token_usage_record → turn_token_usage)
  - real model per session (thread_settings_applied)
  - Jev route per turn     (tier + depth → luna/sol/astra policy)
and compares the "API-equivalent" cost of both scenarios at published prices
(short context, Sep 2026):

  astra $10/$50 · sol $4/$20 · terra $2/$12 · luna $0.20/$1.20 (+fast mode x2)

Usage: python3 backtest_savings.py [--days 7] [--limit-unique 300]
"""
import argparse, datetime, glob, importlib.util, json, os, re, sys, time

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
LUNA_FAST_X = 2.0            # fast mode = 2x rates (policy: luna always runs priority)
CONF_GATE = 0.5

TAG_CLEAN = re.compile(r"<[^>]+>")


def route_policy(tier, depth, conf, gate=CONF_GATE):
    """Production policy: luna max+fast, sol/astra adaptive, confidence gate → middle tier."""
    if gate is not None and conf is not None and conf < gate:
        # recalibrated fallback: the middle tier, not the top (see BACKTEST.md)
        return "gpt-5.6-sol"
    if tier == "gpt-5.6-luna":
        return "gpt-5.6-luna"
    if tier == "gpt-5.6-sol":
        return "gpt-5.6-sol"
    return "gpt-6-astra"


def cost(model, tok):
    p_in, p_out, p_cached, p_write = PRICES[model]
    if model == "gpt-5.6-luna":
        p_in, p_out, p_cached, p_write = (p_in * LUNA_FAST_X, p_out * LUNA_FAST_X,
                                          p_cached * LUNA_FAST_X, p_write * LUNA_FAST_X)
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
        seq, cur, last_assist, model2, cwd2 = [], None, "", "gpt-6-astra", ""
        for line in open(path, encoding="utf-8"):
            if '"session_meta"' not in line and '"role"' not in line and '"task_started"' not in line \
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
                cur = {"turn_id": p.get("turn_id"), "text": "", "prev": last_assist, "tok": None}
                seq.append(cur); continue
            if t == "event_msg" and p.get("type") == "thread_settings_applied":
                th = p.get("thread_settings") or {}
                if th.get("model"): model2 = th["model"]
                continue
            if t == "response_item" and isinstance(p, dict) and p.get("type") == "message":
                role = p.get("role")
                text = " ".join((c.get("text") or "") for c in (p.get("content") or [])
                                if isinstance(c, dict) and c.get("type") in ("input_text", "output_text", "text"))
                text = re.sub(r"\s+", " ", TAG_CLEAN.sub(" ", text)).strip()
                if role == "user" and cur is not None and not cur["text"]:
                    if len(text) >= 12 and not text.startswith("## ") and "plugins that are available" not in text[:80]:
                        cur["text"] = text
                elif role == "assistant" and text:
                    last_assist = text[-240:]
                continue
            if t == "token_usage_record" and cur is not None and p.get("turn_id") == cur.get("turn_id"):
                cur["tok"] = p.get("turn_token_usage") or p.get("usage")
        for tk in seq:
            if tk["text"] and tk["tok"] and (tk["tok"].get("input_tokens") or 0) > 0:
                tk["model"] = model2
                tk["cwd"] = cwd2
                all_turns.append(tk)

    print(f"usable turns: {len(all_turns)}")
    if not all_turns:
        return 1

    # One key per Jev call (memoized); multiplicity = real turns
    unique = {}
    for tk in all_turns:
        key = tk["text"][:80].lower()
        unique.setdefault(key, {"n": 0, "text": tk["text"], "prev": tk["prev"], "cwd": tk["cwd"]})
        unique[key]["n"] += 1
    keys = list(unique)[: args.limit_unique]
    print(f"unique prompts to classify with Jev: {len(keys)}")

    routes = {}
    if args.from_cache:
        routes = (json.load(open(RESULT_PATH)).get("routes_detail") or {})
        print(f"routes from cache: {len(routes)}")
    key = None if args.from_cache else poc.load_key()
    if not args.from_cache and not key:
        print("!! TYPESAFE_API_KEY missing")
        return 2
    q = poc.questions() if not args.from_cache else None
    t0 = time.time()
    for i, k in enumerate([] if args.from_cache else keys, 1):
        u = unique[k]
        state = {"task": u["text"][:500], "signals": {"source": "backtest",
                 "project": os.path.basename((u.get("cwd") or "").rstrip("/")) or None}}
        if u.get("prev"):
            state["previous_assistant"] = u["prev"]
        try:
            resp = poc.post_json("https://api.typesafe.ai/v1/systemone", key,
                                 {"model": "jev-latest", "state": state, "questions": q})
            ans = resp.get("answers", {})
            tier = poc.validate_choice(ans.get("tier", {}), set(poc.CANDIDATES))
            depth = ((ans.get("depth") or {}).get("choice")) or "medium"
            routes[k] = {"tier": tier["choice"], "conf": tier.get("confidence"), "depth": depth,
                         "route": route_policy(tier["choice"], depth, tier.get("confidence"))}
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
    skipped, model_seen, gated = 0, {}, 0
    for tk in all_turns:
        tok = tk["tok"]
        try:
            ca = cost(tk["model"], tok)
            r_info = routes.get(tk["text"][:80].lower()) or {"tier": None, "conf": None, "depth": None}
            r = ("gpt-6-astra" if r_info.get("tier") is None
                 else route_policy(r_info["tier"], r_info.get("depth"), r_info.get("conf")))
            cj = cost(r, tok)
        except KeyError:
            skipped += 1
            continue
        if r_info.get("conf") is not None and r_info["conf"] < CONF_GATE:
            gated += 1
        model_seen[tk["model"]] = model_seen.get(tk["model"], 0) + 1
        tok_volume["input"] += tok.get("input_tokens") or 0
        tok_volume["cached"] += tok.get("cached_input_tokens") or 0
        tok_volume["output"] += tok.get("output_tokens") or 0
        sum_actual += ca
        sum_jev += cj
        dist_counts[r] = dist_counts.get(r, 0) + 1
        for k2 in [tk["text"][:80].lower()]:
            dist_weights[r] = dist_weights.get(r, 0) + unique[k2]["n"] if k2 in unique else 0
        dist_costs[r] = dist_costs.get(r, 0) + cj

    pct = (sum_actual - sum_jev) / sum_actual * 100 if sum_actual else 0
    scen = {name: sum(cost(name, tk["tok"]) for tk in all_turns) for name in PRICES}
    astra_all = scen["gpt-6-astra"]
    policies = [("gate_off", None, None), ("g0.25", 0.25, None), ("g0.35", 0.35, None),
                ("g0.5", 0.5, None), ("g0.65", 0.65, None),
                ("g0.5→sol", 0.5, "gpt-5.6-sol"), ("g0.35→sol", 0.35, "gpt-5.6-sol"),
                ("g0.25→sol", 0.25, "gpt-5.6-sol")]
    gate_scen = {}
    for label, g, hold in policies:
        s = 0.0
        for tk in all_turns:
            if tk["model"] not in PRICES:
                continue
            r_info = routes.get(tk["text"][:80].lower()) or {"tier": None, "conf": None, "depth": None}
            if r_info.get("tier") is None:
                r = "gpt-6-astra"
            elif hold and g is not None and r_info.get("conf") is not None and r_info["conf"] < g:
                r = hold
            else:
                r = route_policy(r_info["tier"], r_info.get("depth"), r_info.get("conf"), g)
            s += cost(r, tk["tok"])
        gate_scen[label] = round(s, 2)
    result = {
        "at": datetime.datetime.now().isoformat(timespec="seconds"),
        "days": args.days, "turns": len(all_turns), "unique": len(keys),
        "tokens": tok_volume,
        "actual_usd": round(sum_actual, 2), "jev_usd": round(sum_jev, 2),
        "savings_pct": round(pct, 1),
        "scenarios_usd": {k: round(v, 2) for k, v in scen.items()},
        "gate_scenarios_usd": gate_scen,
        "full_astra_usd": round(astra_all, 2),
        "savings_vs_astra_pct": round((astra_all - sum_jev) / astra_all * 100, 1),
        "gated_turns": gated,
        "routes": {k: {"turns": dist_counts.get(k, 0), "cost_usd": round(dist_costs.get(k, 0), 2)}
                   for k in PRICES},
        "routes_detail": routes,
        "actual_models": model_seen,
    }
    os.makedirs(os.path.dirname(RESULT_PATH), exist_ok=True)
    json.dump(result, open(RESULT_PATH, "w"), indent=2)

    print("\n" + "=" * 72)
    print(f"BACKTEST — {len(all_turns)} real turns / {args.days} days")
    print(f"tokens: input {tok_volume['input']/1e6:.1f}M (cached {tok_volume['cached']/1e6:.1f}M) · output {tok_volume['output']/1e6:.3f}M")
    print(f"actual scenario  (session mix, published prices): ${sum_actual:.2f}")
    print(f"Jev scenario     : ${sum_jev:.2f}")
    print(f"→ ESTIMATED SAVINGS: {pct:.1f} %")
    print(f"actual models: {model_seen} · gated: {gated} · skipped: {skipped}")
    print("100% scenarios: " + " · ".join(
        f"{k.split('/')[-1]} ${v:.0f}" for k, v in sorted(scen.items(), key=lambda x: x[1])))
    print(f"full-Astra baseline: ${astra_all:.0f} · gates: " + " · ".join(
        f"{g}: −{(astra_all-s)/astra_all*100:.1f}%" for g, s in gate_scen.items()))
    print("-" * 72)
    for k in ("gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"):
        print(f"  {k:<14} {dist_counts.get(k,0):>4} turns · ${dist_costs.get(k,0):.2f}")
    print(f"result: {RESULT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
