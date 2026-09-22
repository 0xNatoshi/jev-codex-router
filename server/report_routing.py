#!/usr/bin/env python3
"""Routing report — what the router actually served, and what it saved.

Reads the live decision log written by `server/jev_server.py`
(`~/.codex/codex-router/jev-router-live.jsonl`: one JSON line per decision, with
`at`, `gate`, `tier`, `conf`, `depth`, `model`, `effort`, `speed`, `jev_ms`,
`total_ms`, ...) and prints, over a window of N days:

  - the distribution of the models/tiers served (luna / terra / sol / astra, plus the
    Codex-dry tandem when it took over);
  - the share of turns served by the cheapest tier (luna);
  - the gates the policy went through (`apply`, `hold(sol)`, `hold(luna_step)`,
    `codex_dry(...)`, ...);
  - the median latency (end-to-end and Jev's own decision time);
  - an estimate of the real cost against two counterfactual baselines — every
    turn on astra, every turn on sol — in documented relative units.

It also reads the backtest aggregate (`~/.codex/codex-router/jev-backtest.json`,
written by `poc/backtest_savings.py --days N`, see BACKTEST.md) when present and
echoes its simulated API-equivalent USD figures, based on recorded token usage.

Usage:
    python3 server/report_routing.py                  # last 7 days, text table
    python3 server/report_routing.py --days 30
    python3 server/report_routing.py --days 7 --json  # machine-readable

Cost hypothesis (relative units, luna = 1)
-------------------------------------------
Legacy log entries carry no token counts. Alongside the observed-token
credit estimates for new entries, the historical cost block estimates every served call with the *published list rates*
(short context, Sep 2026 — the same table as `poc/backtest_savings.py`, itself
matching BACKTEST.md) applied to a fixed token mix per turn, the mix measured in
BACKTEST.md's 7-day replay (237 turns: 684M input, 98.3 % of it cached reads,
1.6M output, i.e. ≈2.89M input / 6.8k output per turn, cached reads priced at
10 % of input and cache writes at 1.25x):

    astra $10.00/$50.00 · sol $4.00/$20.00 · luna $0.20/$1.20 (standard)

One unit = one standard-speed luna turn. Historical Fast calls retain their
API x2 multiplier according to the logged speed; changing the current policy
must not re-price the past as standard. Legacy luna entries without a speed
are assumed Fast, as required by the policy that wrote them.
The native-only comparison excludes external fallback calls.

Assumptions worth reading before quoting a number:
  - token volume per call is held constant across scenarios; changes in effort,
    retries, success rate, and Jev cost are not modelled;
  - prompt-cache invalidation from switching models mid-thread is not modelled
    (per-model caches), so real-world savings can be lower;
  - the baselines are API-equivalent counterfactuals, not invoices: no turn is
    re-served, and Codex-dry turns (served by the Go tandem, off-peak rates) are
    compared against native tiers they did not consume in the mixed report.
  - ChatGPT quota/credit accounting is not API USD billing; neither comparison
    measures actual Codex quota saved.
"""
import argparse
import datetime
import json
import os
import statistics
import sys
from contextlib import ExitStack
from itertools import chain
from local_runtime import STATE
from routing_policy import POLICY_VERSION

LIVE_LOG = os.path.join(STATE, "jev-router-live.jsonl")
BACKTEST_STATE = os.path.join(STATE, "jev-backtest.json")

LUNA, SOL, ASTRA = "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"
TERRA = "gpt-5.6-terra"
NATIVE_TIERS = (LUNA, TERRA, SOL, ASTRA)

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
API_FAST_X = 2.0

# Token mix per turn, from the measurement published in BACKTEST.md: 237 turns,
# 684,114,844 input tokens of which 672,275,840 cached reads (98.3 %), and
# 1,616,250 output tokens.
MIX = {"input": 2_886_560, "cached": 2_836_607, "output": 6_819}

# Short names of the native native model ladder, then the tandem family. Anything else is
# reported under its own leaf name.
SHORT = {
    LUNA: "luna",
    TERRA: "terra",
    SOL: "sol",
    ASTRA: "astra",
    "opencode-go/deepseek-v4.1-flash": "tandem",
    "deepseek/deepseek-v4.1-flash": "tandem",
    "opencode-go/glm-5.3-flash": "tandem",
}
CHEAPEST = LUNA
# Threshold used by historical tier policies, not by current joint decisions.
CONF_GATE = 0.5  # historical diagnostics only; joint routing has no confidence gate

# Standard ChatGPT credit rates, 2026-09-20:
# https://learn.chatgpt.com/docs/pricing
# (input, cached input, output) per million tokens. Reasoning is part of output.
CREDIT_RATES = {LUNA: (5.0, 0.5, 30.0), SOL: (100.0, 10.0, 500.0),
                ASTRA: (250.0, 25.0, 1250.0)}


def token_credits(model, usage):
    """Rate-card estimate, not an observed account-quota debit."""
    if model not in CREDIT_RATES or not isinstance(usage, dict):
        return None
    values = [usage.get(k) for k in ("input_tokens", "cached_input_tokens", "output_tokens")]
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in values):
        return None
    inp, cached, out = values
    if cached > inp or usage.get("cache_write_input_tokens"):
        return None  # no published native-credit cache-write rate in this table
    p_in, p_cached, p_out = CREDIT_RATES[model]
    return ((inp - cached) * p_in + cached * p_cached + out * p_out) / 1e6


def measured_usage(entries):
    """Count every recorded native attempt, including failures with known usage."""
    report = {"native_attempts": 0, "priced_attempts": 0, "unknown_attempts": 0,
              "legacy_calls_without_attempts": 0, "routed_credits": 0.0,
              "all_sol_credits": 0.0, "all_astra_credits": 0.0}
    for entry in entries:
        attempts = entry.get("attempts")
        if not isinstance(attempts, list):
            report["legacy_calls_without_attempts"] += 1
            continue
        for attempt in attempts:
            model = attempt.get("model")
            if model not in NATIVE_TIERS:
                continue
            report["native_attempts"] += 1
            usage = attempt.get("usage")
            cost = token_credits(model, usage) if attempt.get("speed") == "default" else None
            if cost is None:
                report["unknown_attempts"] += 1
                continue
            report["priced_attempts"] += 1
            report["routed_credits"] += cost
            report["all_sol_credits"] += token_credits(SOL, usage)
            report["all_astra_credits"] += token_credits(ASTRA, usage)
    for key in ("routed_credits", "all_sol_credits", "all_astra_credits"):
        report[key] = round(report[key], 6)
    return report


def prompt_cache_usage(entries):
    """Observed cache reads plus model switching, grouped by private session hash."""
    total_input = total_cached = observed = unknown = hits = 0
    total_written = write_observed = 0
    rows = {}
    scopes = set()
    last_model = {}
    seen_models = {}
    switches = revisits = 0
    switch_observed = switch_unknown = switch_hits = 0
    switch_input = switch_cached = 0
    revisit_observed = revisit_unknown = revisit_hits = 0
    revisit_input = revisit_cached = 0

    for entry in entries:
        scope = (
            entry.get("cache_scope")
            if entry.get("cache_key_present") is not False
            else None
        )
        selected = entry.get("native")
        switched = revisited = False
        if isinstance(scope, str) and scope:
            scopes.add(scope)
            if selected in NATIVE_TIERS:
                previous = last_model.get(scope)
                seen = seen_models.setdefault(scope, set())
                if previous is not None and selected != previous:
                    switched = True
                    switches += 1
                    if selected in seen:
                        revisited = True
                        revisits += 1
                seen.add(selected)
                last_model[scope] = selected

        attempts = entry.get("attempts")
        if not isinstance(attempts, list):
            if switched:
                switch_unknown += 1
                if revisited:
                    revisit_unknown += 1
            continue
        for attempt in attempts:
            model = attempt.get("model")
            if model not in NATIVE_TIERS:
                continue
            row = rows.setdefault(model, {
                "observed_attempts": 0, "unknown_attempts": 0, "hit_attempts": 0,
                "input_tokens": 0, "cached_input_tokens": 0,
                "cache_write_input_tokens": 0, "write_observed_attempts": 0,
                "sessions": set(),
            })
            usage = attempt.get("usage")
            inp = usage.get("input_tokens") if isinstance(usage, dict) else None
            cached = usage.get("cached_input_tokens") if isinstance(usage, dict) else None
            if (isinstance(inp, bool) or not isinstance(inp, int) or inp < 0
                    or isinstance(cached, bool) or not isinstance(cached, int)
                    or cached < 0 or cached > inp):
                unknown += 1
                row["unknown_attempts"] += 1
                continue
            observed += 1
            total_input += inp
            total_cached += cached
            row["observed_attempts"] += 1
            row["input_tokens"] += inp
            row["cached_input_tokens"] += cached
            written = usage.get("cache_write_input_tokens")
            if isinstance(written, int) and not isinstance(written, bool) and written >= 0:
                total_written += written
                write_observed += 1
                row["cache_write_input_tokens"] += written
                row["write_observed_attempts"] += 1
            if cached:
                hits += 1
                row["hit_attempts"] += 1
            if isinstance(scope, str) and scope:
                row["sessions"].add(scope)

        if switched:
            selected_attempt = next(
                (attempt for attempt in attempts if attempt.get("model") == selected),
                None,
            )
            usage = selected_attempt.get("usage") if isinstance(selected_attempt, dict) else None
            inp = usage.get("input_tokens") if isinstance(usage, dict) else None
            cached = usage.get("cached_input_tokens") if isinstance(usage, dict) else None
            valid = (
                not isinstance(inp, bool)
                and isinstance(inp, int)
                and inp >= 0
                and not isinstance(cached, bool)
                and isinstance(cached, int)
                and 0 <= cached <= inp
            )
            if valid:
                switch_observed += 1
                switch_input += inp
                switch_cached += cached
                switch_hits += int(cached > 0)
                if revisited:
                    revisit_observed += 1
                    revisit_input += inp
                    revisit_cached += cached
                    revisit_hits += int(cached > 0)
            else:
                switch_unknown += 1
                if revisited:
                    revisit_unknown += 1

    for row in rows.values():
        row["sessions"] = len(row["sessions"])
        row["hit_rate_pct"] = (
            round(100.0 * row["hit_attempts"] / row["observed_attempts"], 1)
            if row["observed_attempts"] else None
        )
        row["cached_share_pct"] = (
            round(100.0 * row["cached_input_tokens"] / row["input_tokens"], 1)
            if row["input_tokens"] else None
        )

    return {
        "tracked_sessions": len(scopes),
        "route_switches": switches,
        "model_revisits": revisits,
        "switch_cache": {
            "observed": switch_observed,
            "unknown": switch_unknown,
            "hit_attempts": switch_hits,
            "input_tokens": switch_input,
            "cached_input_tokens": switch_cached,
            "hit_rate_pct": (
                round(100.0 * switch_hits / switch_observed, 1)
                if switch_observed else None
            ),
            "cached_share_pct": (
                round(100.0 * switch_cached / switch_input, 1)
                if switch_input else None
            ),
        },
        "revisit_cache": {
            "observed": revisit_observed,
            "unknown": revisit_unknown,
            "hit_attempts": revisit_hits,
            "input_tokens": revisit_input,
            "cached_input_tokens": revisit_cached,
            "hit_rate_pct": (
                round(100.0 * revisit_hits / revisit_observed, 1)
                if revisit_observed else None
            ),
            "cached_share_pct": (
                round(100.0 * revisit_cached / revisit_input, 1)
                if revisit_input else None
            ),
        },
        "observed_attempts": observed,
        "unknown_attempts": unknown,
        "hit_attempts": hits,
        "hit_rate_pct": round(100.0 * hits / observed, 1) if observed else None,
        "input_tokens": total_input,
        "cached_input_tokens": total_cached,
        "cache_write_input_tokens": total_written,
        "write_observed_attempts": write_observed,
        "cached_share_pct": (
            round(100.0 * total_cached / total_input, 1) if total_input else None
        ),
        "by_model": rows,
    }


def routing_efficiency(entries):
    """Paid router decisions avoided by leases, using observed Jev usage only."""
    jev_decisions = lease_hits = jev_input = 0
    sources = {}
    leases = {}
    for entry in entries:
        source = entry.get("decision_source") or "legacy"
        sources[source] = sources.get(source, 0) + 1
        lease = entry.get("lease")
        if lease:
            leases[lease] = leases.get(lease, 0) + 1
        if source == "jev":
            jev_decisions += 1
        if source == "lease" or entry.get("lease_hit") is True:
            lease_hits += 1
        usage = entry.get("jev_usage")
        if isinstance(usage, dict):
            value = usage.get("input_tokens", usage.get("inputTokens"))
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                jev_input += value
    judged = jev_decisions + lease_hits
    return {
        "jev_decisions": jev_decisions,
        "lease_hits": lease_hits,
        "decision_calls_avoided_pct": (
            round(100.0 * lease_hits / judged, 1) if judged else None
        ),
        "observed_jev_input_tokens": jev_input,
        "sources": sources,
        "leases": leases,
    }


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


def turn_cost(model, mix=None, speed="default"):
    """API-equivalent cost at the fixed mix and the served speed."""
    key = price_key(model)
    if key is None:
        return None
    mix = mix or MIX
    p_in, p_out, p_cached, p_write = PRICES[key]
    if key in (LUNA, SOL, ASTRA, "gpt-5.6-terra") and speed in ("priority", "fast"):
        p_in, p_out, p_cached, p_write = (p_in * API_FAST_X, p_out * API_FAST_X,
                                        p_cached * API_FAST_X, p_write * API_FAST_X)
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
    with ExitStack() as stack:
        handles = []
        for candidate in (str(path) + ".1", path):
            try:
                handles.append(stack.enter_context(open(candidate, encoding="utf-8", errors="replace")))
            except FileNotFoundError:
                continue
        if not handles:
            raise SystemExit(f"cannot read the live log {path}")
        for line in chain.from_iterable(handles):
            line = line.strip()
            if not line:
                continue
            stats["lines"] += 1
            try:
                entry = json.loads(line)
            except ValueError:
                stats["unparsable"] += 1
                continue
            if not isinstance(entry, dict):
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


def summarize(entries, days, stats, log_path, backtest_path=None, policy=None):
    total = len(entries)
    units = unit_costs()
    models, gates, tiers, steps = {}, {}, {}, {}
    total_ms, jev_ms, unpriced_turns, unpriced_models = [], [], 0, {}
    real_units = 0.0
    native_units = 0.0
    legacy_speed_assumptions = 0
    natives = dry = 0

    for entry in entries:
        model = entry.get("model") or "(none)"
        conf = entry.get("conf")
        served = entry.get("tier")
        if model in NATIVE_TIERS:
            natives += 1
        elif SHORT.get(model) == "tandem":
            dry += 1
        row = models.setdefault(model, {"turns": 0, "total_ms": [], "cost_units": 0.0,
                                        "priced": price_key(model) is not None})
        row["turns"] += 1
        row["total_ms"].append(entry.get("total_ms"))
        speed = entry.get("speed")
        if model == LUNA and not speed:
            speed = "priority"
            legacy_speed_assumptions += 1
        estimate = turn_cost(model, speed=speed)
        unit = estimate / turn_cost(LUNA) if estimate is not None else None
        if unit is None:
            unpriced_turns += 1
            unpriced_models[model] = unpriced_models.get(model, 0) + 1
        else:
            row["cost_units"] += unit
            real_units += unit
            if model in NATIVE_TIERS:
                native_units += unit
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
    legacy = [e for e in entries if not e.get("policy_version")]
    gated = sum(1 for e in legacy
                if isinstance(e.get("conf"), (int, float)) and e["conf"] < CONF_GATE)

    cost = {
        "units_per_turn": {m: round(u, 4) for m, u in units.items()},
        "anchor": f"{LUNA} = {1.0} unit (standard speed; historical Fast uses x2 API rates)",
        "real_units": round(real_units, 1),
        "baseline_all_astra_units": round(priced_turns * units[ASTRA], 1),
        "baseline_all_sol_units": round(priced_turns * units[SOL], 1),
        "priced_turns": priced_turns,
        "unpriced_turns": unpriced_turns,
        "unpriced_models": unpriced_models,
        "legacy_speed_assumptions": legacy_speed_assumptions,
    }
    for label, key in (("vs_astra", "baseline_all_astra_units"),
                       ("vs_sol", "baseline_all_sol_units")):
        base = cost[key]
        cost[f"savings_{label}_pct"] = (round(100.0 * (base - cost["real_units"]) / base, 1)
                                        if base else None)

    native_cost = {
        "turns": natives,
        "routed_units": round(native_units, 1),
        "basis": "fixed token mix, API-equivalent rates; not measured Codex quota",
    }
    for label, model in (("astra", ASTRA), ("sol", SOL)):
        baseline = natives * units[model]
        native_cost[f"baseline_all_{label}_units"] = round(baseline, 1)
        native_cost[f"savings_vs_{label}_pct"] = (
            round(100 * (1 - native_units / baseline), 1) if baseline else None)

    return {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "log": log_path,
        "window": {
            "days": days,
            "from": entries[0]["_at"].isoformat(timespec="seconds") if entries else None,
            "to": entries[-1]["_at"].isoformat(timespec="seconds") if entries else None,
            "turns": total,
            "policy": policy,
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
            "share_pct": round(100.0 * gated / len(legacy), 1) if legacy else 0.0,
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
        "native_cost": native_cost,
        "measured_usage": measured_usage(entries),
        "prompt_cache": prompt_cache_usage(entries),
        "routing_efficiency": routing_efficiency(entries),
        "policy_versions": {
            version: sum(1 for entry in entries if entry.get("policy_version") == version)
            for version in sorted({
                entry.get("policy_version") for entry in entries if entry.get("policy_version")
            })
        },
        "backtest": read_backtest(backtest_path or BACKTEST_STATE),
    }


def read_backtest(path):
    """The last backtest simulation, repriced from recorded token counts."""
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
    if rep["window"].get("policy"):
        lines[-1] += f" · policy {rep['window']['policy']}"
    if not total:
        lines.append("no turn in this window — nothing to report")
        return "\n".join(lines)

    rows = []
    for model, row in sorted(rep["served"]["models"].items(),
                             key=lambda kv: -kv[1]["turns"]):
        unit = row["cost_units"] / row["turns"] if row["priced"] else None
        rows.append([model, SHORT.get(model, model.split("/")[-1]), fmt(row["turns"]),
                     f"{row['share_pct']}%", "—" if unit is None else f"{unit:.2f}",
                     fmt(row["cost_units"]) if unit is not None else "—",
                     fmt(row["median_ms"])])
    rows.append(["TOTAL", "", fmt(total), "100%", "", fmt(rep["cost"]["real_units"]),
                 fmt(rep["latency_ms"]["total_median"])])
    lines += ["", "Served models (cost in luna-turn units, see below)",
              table(["model", "as", "turns", "share", "avg unit", "cost u", "med ms"], rows)]

    served = rep["served"]
    lines += ["",
              f"Cheapest tier ({SHORT[CHEAPEST]}): {served['cheapest_turns']} turns — "
              f"{served['cheapest_share_pct']}% of the window, "
              f"{served['cheapest_share_of_native_pct']}% of the "
              f"{served['native_turns']} turns served by a native model"]
    if served["tandem_turns"]:
        lines += [f"Codex-dry tandem served {fmt(served['tandem_turns'])} turns "
                  f"({served['tandem_share_pct']}%) — native usage exhausted, "
                  f"the native model ladder was replaced (see the gates below)"]

    lines += ["", "Gates",
              table(["gate", "turns", "share"],
                    [[g, fmt(n), f"{round(100.0 * n / total, 1)}%"]
                     for g, n in rep["gates"].items()])]
    bg = rep["below_gate"]
    lines += [f"legacy calls below the old confidence gate (conf < {bg['gate']}): "
              f"{fmt(bg['turns'])} turns — {bg['share_pct']}%, "
              f"of which {fmt(bg['luna_exception_turns'])} kept luna "
              f"(clean shallow tool step)"]
    lines += ["Joint decisions retain their chosen model/effort at every confidence."]

    if rep["steps"]:
        lines += ["", "Tool steps seen: "
                  + " · ".join(f"{k} {fmt(v)}" for k, v in
                               sorted(rep["steps"].items(), key=lambda kv: -kv[1]))]

    lat = rep["latency_ms"]
    lines += ["", "Latency (median)",
              f"  end-to-end {fmt(lat['total_median'])} ms (p90 {fmt(lat['total_p90'])}) · "
              f"Jev decision {fmt(lat['jev_median'])} ms (p90 {fmt(lat['jev_p90'])})"]

    cost = rep["cost"]
    measured = rep["measured_usage"]
    lines += ["", "Observed tokens — standard ChatGPT credit-rate estimates",
              f"  {measured['priced_attempts']}/{measured['native_attempts']} native attempts priced; "
              f"{measured['unknown_attempts']} unknown; "
              f"{measured['legacy_calls_without_attempts']} legacy calls without attempt usage."]
    if measured["priced_attempts"]:
        lines += [f"  routed {measured['routed_credits']} credits · "
                  f"all-sol {measured['all_sol_credits']} · all-astra {measured['all_astra_credits']}",
                  "  Counterfactuals keep observed tokens fixed; reasoning is already in output. "
                  "These are rate-card estimates, not account debits or equal-quality proof."]
    cache = rep["prompt_cache"]
    lines += ["", "Prompt cache — observed native attempts",
              f"  {cache['tracked_sessions']} hashed sessions · "
              f"{cache['route_switches']} model switches · "
              f"{cache['model_revisits']} returns to a previously used model",
              f"  {cache['hit_attempts']}/{cache['observed_attempts']} attempts with cache reads "
              f"({fmt(cache['hit_rate_pct'])}%) · "
              f"{fmt(cache['cached_input_tokens'])}/{fmt(cache['input_tokens'])} input tokens cached "
              f"({fmt(cache['cached_share_pct'])}%) · {cache['unknown_attempts']} unknown"]
    if cache["route_switches"]:
        switch_cache = cache["switch_cache"]
        revisit_cache = cache["revisit_cache"]
        lines += [
            f"  after switches: {switch_cache['hit_attempts']}/{switch_cache['observed']} cache hits "
            f"({fmt(switch_cache['cached_share_pct'])}% of input cached; "
            f"{switch_cache['unknown']} unknown)",
            f"  on model returns: {revisit_cache['hit_attempts']}/{revisit_cache['observed']} cache hits "
            f"({fmt(revisit_cache['cached_share_pct'])}% of input cached; "
            f"{revisit_cache['unknown']} unknown)",
        ]
    if cache["by_model"]:
        cache_rows = []
        for model, row in sorted(cache["by_model"].items()):
            cache_rows.append([
                SHORT.get(model, model),
                row["sessions"],
                f"{row['hit_attempts']}/{row['observed_attempts']}",
                f"{fmt(row['hit_rate_pct'])}%",
                f"{fmt(row['cached_share_pct'])}%",
                row["unknown_attempts"],
            ])
        lines += [table(
            ["model", "sessions", "hits/seen", "hit rate", "cached input", "unknown"],
            cache_rows,
        )]
    efficiency = rep["routing_efficiency"]
    lines += ["", "Router input — observed decisions",
              f"  Jev calls {efficiency['jev_decisions']} · lease hits "
              f"{efficiency['lease_hits']} · avoided "
              f"{fmt(efficiency['decision_calls_avoided_pct'])}% of eligible decisions · "
              f"{fmt(efficiency['observed_jev_input_tokens'])} observed Jev input tokens"]
    native = rep["native_cost"]
    lines += ["", "Native Codex calls only — fixed-volume API-rate proxy, not measured quota",
              f"  {native['turns']} calls · {fmt(native['routed_units'])} units · "
              f"{native['savings_vs_sol_pct']}% vs all-sol · "
              f"{native['savings_vs_astra_pct']}% vs all-astra",
              "  External fallback calls excluded; actual tokens, cache changes, "
              "reasoning and retries must be measured before claiming quota savings."]
    lines += ["", "Cost estimate — relative units, one unit = one luna turn",
              table(["scenario", "units", "vs real"],
                    [["estimate (as routed, including external fallback)", fmt(cost["real_units"]), "—"],
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
              "  this legacy proxy holds per-call volume constant "
              "across scenarios."]
    if cost["legacy_speed_assumptions"]:
        lines += [f"  {cost['legacy_speed_assumptions']} legacy luna calls without speed "
                  "assumed Fast (historical policy)."]
    if cost["unpriced_turns"]:
        lines += [f"  unpriced (excluded from the cost total): {fmt(cost['unpriced_turns'])} turns "
                  + ", ".join(f"{m} {fmt(n)}" for m, n in cost["unpriced_models"].items())]

    bt = rep["backtest"]
    if bt and bt.get("jev_usd") is not None:
        lines += ["", f"Simulated API-equivalent USD (backtest, {bt.get('at')}, {bt.get('days')} days, "
                      f"{fmt(bt.get('turns'))} turns with real token usage)",
                  f"  actual {bt.get('actual_usd')} $ · routed {bt.get('jev_usd')} $ · "
                  f"saved {bt.get('savings_vs_astra_pct')}% vs all-astra"]
        if bt.get("scenarios_usd"):
            lines += ["  baselines: " + " · ".join(f"{SHORT.get(m, m)} {v} $"
                                                  for m, v in bt["scenarios_usd"].items()
                                                  if m in NATIVE_TIERS)]
    else:
        lines += ["", "Simulated API-equivalent USD: no backtest aggregate yet — "
                  "run `python3 poc/backtest_savings.py --days 7` for a simulation using recorded tokens."]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Routing and savings report from the live decision log.")
    ap.add_argument("--days", type=int, default=7, help="window in days (default 7)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text tables")
    ap.add_argument("--log", default=LIVE_LOG, help=f"live decision log (default {LIVE_LOG})")
    ap.add_argument("--backtest", default=BACKTEST_STATE,
                    help=f"backtest aggregate (default {BACKTEST_STATE})")
    ap.add_argument(
        "--policy",
        help="only one policy version; use 'current' for the installed V10 policy",
    )
    args = ap.parse_args(argv)
    if args.days < 0:
        ap.error("--days must be >= 0")

    entries, stats = load_entries(args.log, args.days)
    policy = POLICY_VERSION if args.policy == "current" else args.policy
    if policy:
        entries = [entry for entry in entries if entry.get("policy_version") == policy]
    rep = summarize(entries, args.days, stats, args.log, args.backtest, policy)
    if args.json:
        json.dump(rep, sys.stdout, indent=2, ensure_ascii=False)
        print()
    else:
        print(render_text(rep))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
