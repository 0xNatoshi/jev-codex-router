# Tool-result aging benchmark

This report separates provider-reported evidence from replay estimates.

## Live provider A/B

Run on 2026-08-12 from commit `60100aa835fe3a0d6856b0b414223c84db672efa`
against `grok-oauth/grok-4.6`.

The benchmark sent the same 69,701-byte request twice. Its SHA-256 was
`da75bf4e6d90d8537084f8db160805f7e2f64d72bc11f75303aea2e90f6008e3`.
The request contained one 66,621-byte consumed tool result plus four newer tool
results that the aging frontier protects.

| Run | Setting | Provider input tokens | Response |
| ---: | --- | ---: | --- |
| 1 | Off | 22,071 | `OK` |
| 1 | On | 2,991 | `OK` |
| 2 | Off | 22,071 | `OK` |
| 2 | On | 2,991 | `OK` |

Both runs produced the same provider-reported input counts: 19,080 fewer input
tokens with aging on, an 86.45% reduction for this deliberately
tool-result-heavy request. The raw captured results are in
[`tool-result-aging-benchmark-results.json`](tool-result-aging-benchmark-results.json).

This is a controlled demonstration, not an expected average. Real savings are
zero when a request has no eligible old result and vary with result size,
history shape, tokenizer, and provider.

Reproduce it on an installed router with a quota-bearing model that reports
input tokens:

```bash
node scripts/live-test-tool-result-aging.mjs --yes --model grok-oauth/grok-4.6
```

The script requires `--yes` because it makes two live requests. It prints the
request hash and both provider-reported usage envelopes, but never prints or
copies router or provider credentials.

## Private workload replay

A separate replay used one active open-world game rollout. The rollout is not
published because it contains private prompts and tool output. At the captured
point it was 970,465,147 bytes with SHA-256
`1a9f9414abbaeca68c1192629c16faaa49b756f49c8168777a080e0d30a343ad`.

The deterministic replay sampled 96 histories around 95 compactions. Sixty-four
had at least one eligible old result. Across those sampled request snapshots,
the algorithm removed 5,735,259 serialized bytes. The byte-to-token conversion
estimated 1,737,926 input tokens, but that figure is not a provider-reported or
billed token count and must be labelled as an estimate.

The private replay demonstrates workload frequency. The public live A/B above
is the proof that removing those bytes reduced provider-reported input tokens.
