# Savings backtest

`backtest_savings.py` replays real Codex sessions and prices every turn at
published OpenAI rates, comparing Jev routing against baselines.

## Method

- Per-turn token volume: `turn_token_usage` from `~/.codex/sessions` (input,
  cached, output — cumulative across the turn's model calls).
- Actual model per session: last `thread_settings_applied`.
- Jev classifies each unique prompt once (repeated prompts share the route);
  low-confidence answers follow the routing policy under test.
- Prices (per 1M tokens, short context, Sep 2026): Astra $10/$50 · Sol $4/$20 ·
  Terra $2/$12 · Luna $0.20/$1.20 · DeepSeek V4.1 Flash $0.15/$0.60 (off-peak).
  Cached input at 10% of input, cache writes at 1.25%. Luna always priced with
  fast mode (2×), per the default policy.

## Results (author's setup, 7 days, 236 turns — 98% of tokens are cached reads)

| Scenario vs **full-Astra** baseline | Cost | Savings |
|---|---|---|
| full Astra | $869 | — |
| Jev, gate 0.5 → fallback **Astra** | $766 | −11.9% |
| Jev, gate 0.35 → fallback Astra | $446 | −48.7% |
| Jev, no gate | $339 | −61.0% |
| **Jev, gate 0.5 → fallback Sol** | **$348** | **−59.9%** |

## Findings

1. The low-confidence fallback dominated the outcome: jumping uncertain turns
   to the top tier eats ~80% of the savings. Falling back to the **middle
   tier** keeps the anti-downgrade guarantee while recovering nearly all of it.
2. Routing value is concentrated in cached history: at 98% cached reads, the
   per-token gap between tiers (up to 50× between Luna and Astra) multiplies
   through long agentic turns.
3. Not modelled yet: changing models mid-thread may invalidate the prompt
   cache (each model caches separately, and effort changes can void the
   prefix). Sticky per-thread routing is the next optimisation.

Run it yourself: `python3 backtest_savings.py --days 7` (add `--from-cache` to
re-price without any new Jev calls).
