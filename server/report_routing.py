#!/usr/bin/env python3
"""Routing report — what the router actually served, and what it saved.

Reads the live decision log written by `server/jev_server.py`
(`~/.codex/codex-router/jev-router-live.jsonl`: one JSON line per decision, with
`at`, `gate`, `tier`, `conf`, `depth`, `model`, `effort`, `speed`, `jev_ms`,
`total_ms`, ...) and prints, over a window of N days:

  - the distribution of the models/tiers served (luna / sol / astra, plus the
    Codex-dry tandem when it took over);
  - the share of turns served by the cheapest tier (luna);
  - the gates the policy went through (`apply`, `hold(sol)`, `hold(luna_step)`,
    `codex_dry(...)`, ...);
  - the median latency (end-to-end and Jev's own decision time);
  - an estimate of the real cost against two counterfactual baselines — every
    turn on astra, every turn on sol — in documented relative units.

It also reads the backtest aggregate (`~/.codex/codex-router/jev-backtest.json`,
written by `poc/backtest_savings.py --days N`, see BACKTEST.md) when present and
echoes its measured USD figures, which come from real per-turn token usage.

Usage:
    python3 server/report_routing.py                  # last 7 days, text table
    python3 server/report_routing.py --days 30
    python3 server/report_routing.py --days 7 --json  # machine-readable

Cost hypothesis (relative units, luna = 1)
-------------------------------------------
The live log carries no token counts, so a per-turn cost cannot be recomputed
from it the way `poc/backtest_savings.py` does from Codex session logs. The cost
block therefore estimates every served turn with the *published list rates*
(short context, Sep 2026 — the same table as `poc/backtest_savings.py`, itself
matching BACKTEST.md) applied to a fixed token mix per turn, the mix measured in
BACKTEST.md's 7-day replay (237 turns: 684M input, 98.3 % of it cached reads,
1.6M output, i.e. ≈2.89M input / 6.8k output per turn, cached reads priced at
10 % of input and cache writes at 1.25x):

    astra $10.00/$50.00 · sol $4.00/$20.00 · luna $0.20/$1.20 (+fast mode x2)

Luna is priced in Fast mode (x2) because the default policy always runs it at
maximum thinking on the priority lane. One unit = one luna turn: the units are
printed by the report, so the estimate is readable as a ratio whatever the
rates are, and the mix is a constant a third party can change in one place.

Assumptions worth reading before quoting a number:
  - token volume per turn is held constant across scenarios (adaptive effort
    moves thinking/output volume by single digits, direction varies);
  - prompt-cache invalidation from switching models mid-thread is not modelled
    (per-model caches), so real-world savings can be lower;
  - the baselines are API-equivalent counterfactuals, not invoices: no turn is
    re-served, and Codex-dry turns (served by the Go tandem, off-peak rates) are
    compared against native tiers they did not consume.
"""
import argparse
import datetime
import json
import os
import statistics
import sys

LIVE_LOG = os.path.expanduser("~/.codex/codex-router/jev-router-live.jsonl")
BACKTEST_STATE = os.path.expanduser("~/.codex/codex-router/jev-backtest.json")

LUNA, SOL, ASTRA = "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"

# Prices per 1M tokens (input, output, cached input, cache write), short context,
# Sep 2026 — kept identical to poc/backtest_savings.py so the two tools agree.
PRICES = {
    ASTRA: (10.00, 50.00, 1.00, 12.50),
    SOL: (4.00, 20.00, 0.40, 5.00),
    "gpt-5.6-terra": (2.00, 12.00, 0.20, 2.50),
    LUNA: (0.20, 1.20, 0.02, 0.25),
    # Codex-dry tandem (Go allowance), off-peak.
    "deepseek/deepseek-v4.1-flash": (0.15, 0.60, 0.015, 0.15),
}
LUNA_FAST_X = 2.0

# Token mix per turn, from the measurement published in BACKTEST.md: 237 turns,
# 684,114,844 input tokens of which 672,275,840 cached reads (98.3 %), and
# 1,616,250 output tokens.
MIX = {"input": 2_886_560, "cached": 2_836_607, "output": 6_819}

# Short names of the native triptych, then the tandem family. Anything else is
# reported under its own leaf name.
SHORT = {
    LUNA: "luna",
    SOL: "sol",
    ASTRA: "astra",
    "opencode-go/deepseek-v4.1-flash": "tandem",
    "deepseek/deepseek-v4.1-flash": "tandem",
    "opencode-go/glm-5.3-flash": "tandem",
}
CHEAPEST = LUNA
# Same gate as server/jev_server.py (CONF_GATE): a verdict below it is held.
CONF_GATE = 0.5


def price_key(model):
    """The price row a served model is costed with, or None when unpriced.

    The Go tandem appears under two prefixes for the same model, so a leaf
    containing "deepseek" falls back to the tandem row rather than being
    dropped.
    """
    if model in PRICES:
        return model
    leaf = (model or "").split("/")[-1]
    for known in PRICES:
        if known.split("/")[-1] == leaf:
            return known
    # Same model under the tandem's other prefix; GLM is left unpriced.
    if "deepseek" in leaf:
        return "deepseek/deepseek-v4.1-flash"
    return None


def turn_cost(model, mix=None):
    """Cost of one turn on `model` at the documented mix (luna priced x2 for Fast)."""
    key = price_key(model)
    if key is None:
        return None
    mix = mix or MIX
    p_in, p_out, p_cached, p_write = PRICES[key]
    if key == LUNA:
        p_in, p_out, p_cached, p_write = (p_in * LUNA_FAST_X, p_out * LUNA_FAST_X,
                                          p_cached * LUNA_FAST_X, p_write * LUNA_FAST_X)
    cached = min(mix["cached"], mix["input"])
    uncached = max(mix["input"] - cached, 0)
    return (uncached * p_in + cached * p_cached + mix["output"] * p_out) / 1e6


def unit_costs():
    """Relative per-turn cost of every priced model, anchored on luna = 1."""
    base = turn_cost(LUNA) or 1.0
    units = {}
    for model in PRICES:
        cost = turn_cost(model)
        if cost is not None:
            units[model] = cost / base
    return units


def parse_at(value):
    try:
        return datetime.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def load_entries(path, days, now=None):
    """(entries in window, stats) from the live decision log."""
    now = now or datetime.datetime.now()
    cut = now - datetime.timedelta(days=days)
    entries, stats = [], {"lines": 0, "unparsable": 0, "undated": 0, "out_of_window": 0}
    try:
        handle = open(path, encoding="utf-8", errors="replace")
    except OSError as exc:
        raise SystemExit(f"cannot read the live log {path}: {exc}")
    with handle as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            stats["lines"] += 1
            try:
                entry = json.loads(line)
            except ValueError:
                stats["unparsable"] += 1
                continue
            at = parse_at(entry.get("at"))
            if at is None:
                stats["undated"] += 1
                continue
            if at < cut:
                stats["out_of_window"] += 1
                continue
            entry["_at"] = at
            entries.append(entry)
    entries.sort(key=lambda e: e["_at"])
    return entries, stats


def median(values):
    values = [v for v in values if isinstance(v, (int, float))]
    if not values:
        return None
    m = statistics.median(values)
    return int(round(m)) if float(m).is_integer() else m


def percentile(values, pct):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    if not values:
        return None
    idx = min(len(values) - 1, max(0, int(round(pct / 100.0 * (len(values) - 1)))))
    return values[idx]


def summarize(entries, days, stats, log_path, backtest_path=None):
    total = len(entries)
    units = unit_costs()
    models, gates, tiers, steps = {}, {}, {}, {}
    total_ms, jev_ms, unpriced_turns, unpriced_models = [], [], 0, {}
    real_units = 0.0
    natives = dry = 0

    for entry in entries:
        model = entry.get("model") or "(none)"
        conf = entry.get("conf")
        served = entry.get("tier")
        if model in (LUNA, SOL, ASTRA):
            natives += 1
        elif SHORT.get(model) == "tandem":
            dry += 1
        row = models.setdefault(model, {"turns": 0, "total_ms": [], "cost_units": 0.0,
                                        "priced": price_key(model) is not None})
        row["turns"] += 1
        row["total_ms"].append(entry.get("total_ms"))
        unit = units.get(price_key(model) or "", None)
        if unit is None:
            unpriced_turns += 1
            unpriced_models[model] = unpriced_models.get(model, 0) + 1
        else:
            row["cost_units"] += unit
            real_units += unit
        gates[entry.get("gate") or "(none)"] = gates.get(entry.get("gate") or "(none)", 0) + 1
        tier_key = served if served is not None else "(none)"
        tiers[tier_key] = tiers.get(tier_key, 0) + 1
        if entry.get("step"):
            steps[entry["step"]] = steps.get(entry["step"], 0) + 1
        total_ms.append(entry.get("total_ms"))
        jev_ms.append(entry.get("jev_ms"))

    for row in models.values():
        row["share_pct"] = round(100.0 * row["turns"] / total, 1) if total else 0.0
        row["median_ms"] = median(row["total_ms"])
        row["cost_units"] = round(row["cost_units"], 1)
        del row["total_ms"]

    priced_turns = total - unpriced_turns
    luna_turns = models.get(LUNA, {}).get("turns", 0)
    gated = sum(1 for e in entries
                if isinstance(e.get("conf"), (int, float)) and e["conf"] < CONF_GATE)

    cost = {
        "units_per_turn": {m: round(u, 4) for m, u in units.items()},
        "anchor": f"{LUNA} = {1.0} unit (max thinking, fast lane, x2 rates)",
        "real_units": round(real_units, 1),
        "baseline_all_astra_units": round(priced_turns * units[ASTRA], 1),
        "baseline_all_sol_units": round(priced_turns * units[SOL], 1),
        "priced_turns": priced_turns,
        "unpriced_turns": unpriced_turns,
        "unpriced_models": unpriced_models,
    }
    for label, key in (("vs_astra", "baseline_all_astra_units"),
                       ("vs_sol", "baseline_all_sol_units")):
        base = cost[key]
        cost[f"savings_{label}_pct"] = (round(100.0 * (base - cost["real_units"]) / base, 1)
                                        if base else None)

    return {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "log": log_path,
        "window": {
            "days": days,
            "from": entries[0]["_at"].isoformat(timespec="seconds") if entries else None,
            "to": entries[-1]["_at"].isoformat(timespec="seconds") if entries else None,
            "turns": total,
            "log_lines": stats["lines"],
            "skipped": {"out_of_window": stats["out_of_window"],
                        "undated": stats["undated"],
                        "unparsable": stats["unparsable"]},
        },
        "served": {
            "models": models,
            "native_turns": natives,
            "tandem_turns": dry,
            "tandem_share_pct": round(100.0 * dry / total, 1) if total else 0.0,
            "cheapest_tier": CHEAPEST,
            "cheapest_turns": luna_turns,
            "cheapest_share_pct": round(100.0 * luna_turns / total, 1) if total else 0.0,
            "cheapest_share_of_native_pct": (round(100.0 * luna_turns / natives, 1)
                                             if natives else 0.0),
        },
        "judged_tiers": tiers,
        "gates": dict(sorted(gates.items(), key=lambda kv: -kv[1])),
        "below_gate": {
            "gate": CONF_GATE,
            "turns": gated,
            "share_pct": round(100.0 * gated / total, 1) if total else 0.0,
            "luna_exception_turns": gates.get("hold(luna_step)", 0),
        },
        "steps": steps,
        "latency_ms": {
            "total_median": median(total_ms),
            "total_p90": percentile(total_ms, 90),
            "jev_median": median(jev_ms),
            "jev_p90": percentile(jev_ms, 90),
        },
        "cost": cost,
        "backtest": read_backtest(backtest_path or BACKTEST_STATE),
    }


def read_backtest(path):
    """The last backtest aggregate, which is measured in real USD from tokens."""
    try:
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return None
    routes = state.get("routes") or {}
    return {
        "path": path,
        "at": state.get("at"),
        "days": state.get("days"),
        "turns": state.get("turns"),
        "actual_usd": state.get("actual_usd"),
        "jev_usd": state.get("jev_usd"),
        "savings_vs_astra_pct": state.get("savings_vs_astra_pct"),
        "scenarios_usd": state.get("scenarios_usd"),
        "tier_turns": {m: (routes.get(m) or {}).get("turns") for m in routes},
    }


def fmt(value, dash="—"):
    return dash if value is None else f"{value:,}".replace(",", " ")


def table(headers, rows):
    widths = [max(len(str(r[i])) for r in [headers] + rows) for i in range(len(headers))]
    out = ["  ".join(str(h).ljust(widths[i]) for i, h in enumerate(headers)).rstrip()]
    out.append("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        out.append("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)).rstrip())
    return "\n".join(out)


def render_text(rep):
    total = rep["window"]["turns"]
    lines = ["Jev Codex Router — routing report",
             f"window: last {rep['window']['days']} day(s)"
             + (f" ({rep['window']['from']} → {rep['window']['to']})" if total else "")
             + f" · {total} turns of {rep['window']['log_lines']} log lines"]
    if not total:
        lines.append("no turn in this window — nothing to report")
        return "\n".join(lines)

    units = unit_costs()
    rows = []
    for model, row in sorted(rep["served"]["models"].items(),
                             key=lambda kv: -kv[1]["turns"]):
        unit = units.get(price_key(model) or "")
        rows.append([model, SHORT.get(model, model.split("/")[-1]), fmt(row["turns"]),
                     f"{row['share_pct']}%", "—" if unit is None else f"{unit:.2f}",
                     fmt(row["cost_units"]) if unit is not None else "—",
                     fmt(row["median_ms"])])
    rows.append(["TOTAL", "", fmt(total), "100%", "", fmt(rep["cost"]["real_units"]),
                 fmt(rep["latency_ms"]["total_median"])])
    lines += ["", "Served models (cost in luna-turn units, see below)",
              table(["model", "as", "turns", "share", "unit", "cost u", "med ms"], rows)]

    served = rep["served"]
    lines += ["",
              f"Cheapest tier ({SHORT[CHEAPEST]}): {served['cheapest_turns']} turns — "
              f"{served['cheapest_share_pct']}% of the window, "
              f"{served['cheapest_share_of_native_pct']}% of the "
              f"{served['native_turns']} turns served by a native model"]
    if served["tandem_turns"]:
        lines += [f"Codex-dry tandem served {fmt(served['tandem_turns'])} turns "
                  f"({served['tandem_share_pct']}%) — native usage exhausted, "
                  f"the triptych was replaced (see the gates below)"]

    lines += ["", "Gates",
              table(["gate", "turns", "share"],
                    [[g, fmt(n), f"{round(100.0 * n / total, 1)}%"]
                     for g, n in rep["gates"].items()])]
    bg = rep["below_gate"]
    lines += [f"held below the confidence gate (conf < {bg['gate']}): "
              f"{fmt(bg['turns'])} turns — {bg['share_pct']}%, "
              f"of which {fmt(bg['luna_exception_turns'])} kept luna "
              f"(clean shallow tool step)"]

    if rep["steps"]:
        lines += ["", "Tool steps seen: "
                  + " · ".join(f"{k} {fmt(v)}" for k, v in
                               sorted(rep["steps"].items(), key=lambda kv: -kv[1]))]

    lat = rep["latency_ms"]
    lines += ["", "Latency (median)",
              f"  end-to-end {fmt(lat['total_median'])} ms (p90 {fmt(lat['total_p90'])}) · "
              f"Jev decision {fmt(lat['jev_median'])} ms (p90 {fmt(lat['jev_p90'])})"]

    cost = rep["cost"]
    lines += ["", "Cost estimate — relative units, one unit = one luna turn",
              table(["scenario", "units", "vs real"],
                    [["real (as routed)", fmt(cost["real_units"]), "—"],
                     [f"baseline all astra ({cost['priced_turns']} priced turns)",
                      fmt(cost["baseline_all_astra_units"]),
                      f"{cost['savings_vs_astra_pct']}% saved"],
                     [f"baseline all sol ({cost['priced_turns']} priced turns)",
                      fmt(cost["baseline_all_sol_units"]),
                      f"{cost['savings_vs_sol_pct']}% saved"]])]
    unit_line = " · ".join(f"{SHORT.get(m, m)} {u:.2f}"
                           for m, u in sorted(cost["units_per_turn"].items(),
                                              key=lambda kv: kv[1]))
    lines += [f"  units/turn: {unit_line}",
              f"  anchor: {cost['anchor']}",
              "  rates: published list prices (short context) applied to the token mix "
              "measured in BACKTEST.md;",
              "  the live log carries no token counts, so per-turn volume is held constant "
              "across scenarios."]
    if cost["unpriced_turns"]:
        lines += [f"  unpriced (excluded from the cost total): {fmt(cost['unpriced_turns'])} turns "
                  + ", ".join(f"{m} {fmt(n)}" for m, n in cost["unpriced_models"].items())]

    bt = rep["backtest"]
    if bt and bt.get("jev_usd") is not None:
        lines += ["", f"Measured USD (backtest, {bt.get('at')}, {bt.get('days')} days, "
                      f"{fmt(bt.get('turns'))} turns with real token usage)",
                  f"  actual {bt.get('actual_usd')} $ · routed {bt.get('jev_usd')} $ · "
                  f"saved {bt.get('savings_vs_astra_pct')}% vs all-astra"]
        if bt.get("scenarios_usd"):
            lines += ["  baselines: " + " · ".join(f"{SHORT.get(m, m)} {v} $"
                                                  for m, v in bt["scenarios_usd"].items()
                                                  if SHORT.get(m, m) in ("luna", "sol", "astra"))]
    else:
        lines += ["", "Measured USD: no backtest aggregate yet — "
                  "run `python3 poc/backtest_savings.py --days 7` for real token-based figures."]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Routing and savings report from the live decision log.")
    ap.add_argument("--days", type=int, default=7, help="window in days (default 7)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text tables")
    ap.add_argument("--log", default=LIVE_LOG, help=f"live decision log (default {LIVE_LOG})")
    ap.add_argument("--backtest", default=BACKTEST_STATE,
                    help=f"backtest aggregate (default {BACKTEST_STATE})")
    args = ap.parse_args(argv)
    if args.days < 0:
        ap.error("--days must be >= 0")

    entries, stats = load_entries(args.log, args.days)
    rep = summarize(entries, args.days, stats, args.log, args.backtest)
    if args.json:
        json.dump(rep, sys.stdout, indent=2, ensure_ascii=False)
        print()
    else:
        print(render_text(rep))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
