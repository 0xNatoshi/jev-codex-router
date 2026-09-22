# Backtest: per-turn routing savings on real agentic sessions

**Historical simulated result: −60 % vs a full-frontier baseline** on a 7-day replay of 237
real Codex turns (list-price equivalent; protocol and limitations below).

The tables below describe the September 17 policy (Luna max + Fast, confidence
fallback to Sol), not the later routing contracts. The current policy uses
independent explicit model and effort judgments in one request, standard speed,
and no confidence fallback. Its quota savings and task quality still need
outcome measurements.

This document specifies exactly how the savings claim is measured, and publishes
the aggregate results. The replay is fully local: real turns and their own token
usage are read from Codex session logs, re-classified by [Jev](https://docs.typesafe.ai)
(TypeSafe System One), and re-priced at published API rates under different
routing policies.

## Protocol

1. **Data** — one week of a daily-driver Codex installation: 237 user turns.
   Per-turn token totals come from the session's own usage records
   (`turn_token_usage`: input, cached input, cache writes, output — cumulative
   across the turn's model calls).
2. **Classification** — each unique prompt (with the previous assistant message
   as context) is sent once to Jev; repeated prompts share the decision.
   Prompts are truncated before classification and are never published.
3. **Pricing** — published OpenAI rates, per 1M tokens (short context,
   Sep 17 2026; cached input at 10 % of input, cache writes at 1.25×):

   | Model | Input | Cached input | Output |
   |---|---|---|---|
   | gpt-6-astra | $10.00 | $1.00 | $50.00 |
   | gpt-5.6-sol | $4.00 | $0.40 | $20.00 |
   | gpt-5.6-luna | $0.20 | $0.02 | $1.20 |

   Luna is priced with Fast mode (×2) because the default policy always runs it
   at maximum thinking with the fast lane on. DeepSeek V4.1 Flash sessions are
   priced at $0.15/$0.60 (off-peak).
4. **Scenarios** — baseline: every turn on the frontier model (`gpt-6-astra`).
   Jev policy: luna for mechanical work (always max thinking + fast mode),
   sol/astra adaptive thinking depth, and turns where Jev's confidence is below
   0.5 fall back to the **middle tier** (sol) rather than the top.

## Results

7-day replay, 237 turns, 684M input tokens (98.3 % cached reads) · 1.6M output.

| Scenario | Cost | vs full-frontier |
|---|---|---|
| Full baseline (`gpt-6-astra` everywhere) | $871 | — |
| Jev routing (published policy) | **$349** | **−59.9 %** |

Tier distribution under the published policy: luna 61 turns · sol 165 turns ·
astra 11 turns. At list prices the saved ≈$522/week is on the order of
≈$2.2k/month for this workload (illustrative extrapolation).

## The calibration that mattered

The first policy shipped with a low-confidence fallback to the *frontier* model
(“when unsure, don't downgrade”). On real turns — mostly short, context-dependent
prompts — that fallback fired on ~⅔ of turns and ate almost all of the savings:

| Low-confidence fallback | Cost (7 days) | vs full-frontier |
|---|---|---|
| Frontier model (initial policy) | $766 | −11.9 % |
| Middle tier (Sol) — adopted | **$349** | **−59.9 %** |

Confidence-gate level itself (0.25 → 0.65) barely matters once the fallback is
the middle tier; the safety property (never trust an uncertain *cheap* vote)
is preserved in both.

## Limitations (read me)

- Token volumes are held constant across scenarios. Adaptive effort changes
  thinking/output volume by single digits; direction varies.
- Prompt-cache invalidation from switching models mid-thread is **not**
  modelled — each model caches separately, so real-world savings could be
  lower than measured. Sticky per-thread routing is the next optimisation.
- The classifier is stochastic: ~1–2 % of answers are near-ties and follow the
  fallback path.
- Single-operator workload; your mix will differ (heavy mechanical usage skews
  savings higher, all-hard workloads lower).
- Promotional pricing (Sol −20 % until Nov 2026, Luna −80 % since Jul 30 2026)
  is included as published.

## Reproducibility

```bash
python3 poc/backtest_savings.py --days 7          # classify current policy + reprice
python3 poc/backtest_savings.py --days 7 --from-cache   # re-price only
```

The current script uses the live split-decision contract, so these commands do
not reproduce the historical table above. A cache from an older policy is
rejected. The pre-change implementation is available in commit `bebb601`.

Aggregates are written locally (`~/.codex/codex-router/jev-backtest.json`).
A pre-redacted historical sample run is available at `poc/backtest-sample-results.json`.

## The live counterpart

The backtest answers "what would the policy cost on a week of real turns?".
`server/report_routing.py` answers the other half, straight from the router's own
decision log (`~/.codex/codex-router/jev-router-live.jsonl`), with no calls and no
replay:

```bash
python3 server/report_routing.py --days 7          # text tables
python3 server/report_routing.py --days 7 --json   # machine-readable
```

It reports the served distribution, gates and latency, along with per-attempt
usage for new entries. Observed tokens are repriced using standard ChatGPT credit
rates for native-only comparisons with Sol and Astra. Legacy records retain a
separate fixed-volume API proxy and their historical speed surcharge. These
comparisons hold token volumes constant and are not proof of equivalent quality
or observed account quota savings. The old USD backtest is labelled historical.

## Data handling

Only aggregate figures are published. No prompts, file paths, project names,
session identifiers, or per-turn routes appear in this document or the sample
results file. Classification calls send a truncated prompt excerpt to Jev —
the historical equivalent of the live router's smaller per-call decision
dossier. The current policy and its cache behavior must be measured from the
live report; this backtest remains a historical simulation.
