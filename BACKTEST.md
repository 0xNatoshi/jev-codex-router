# Backtest: per-turn routing savings on real agentic sessions

**Measured result: −60 % vs a full-frontier baseline** on a 7-day replay of 237
real Codex turns (list-price equivalent; protocol and limitations below).

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
python3 poc/backtest_savings.py --days 7          # classify + price (local)
python3 poc/backtest_savings.py --days 7 --from-cache   # re-price only
```

Aggregates are written locally (`~/.codex/codex-router/jev-backtest.json`).
A pre-redacted sample run is available at `poc/backtest-sample-results.json`.

## Data handling

Only aggregate figures are published. No prompts, file paths, project names,
session identifiers, or per-turn routes appear in this document or the sample
results file. Classification calls send a truncated prompt excerpt to Jev —
the same thing the live router does per turn.
