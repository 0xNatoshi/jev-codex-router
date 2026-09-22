# OrcaRouter free catalog — 2026-08-21

This note preserves the evidence behind the OrcaRouter free-model proposal so
future catalog work starts from the measured contract rather than from memory.

## Product decision

- Register one keyed, catalog-only provider: `orca`.
- Curate concrete free model IDs under that provider and mark them `isFree`.
- Treat `isFree` as catalog/display metadata, not automatic failover priority:
  OrcaRouter drops `-free` IDs used as fallback targets.
- Do not curate `orcarouter/free`. It is a moving meta-router, so it hides the
  model identity that served the request and cannot carry stable per-model
  context or capability metadata.
- Never check the changing concrete list into `config/`; `--free-only` reads it
  from the live account-visible `/v1/models` response.

## Live concrete free models

The public catalog returned these concrete free chat deployments on
2026-08-21:

1. `deepseek/deepseek-v4-flash-free`
2. `deepseek/deepseek-v4-pro-free`
3. `qwen/qwen3.8-27b-free`
4. `tencent/hy3-free`

The same catalog also returned `orcarouter/free`; it is recorded here for
completeness but intentionally excluded from curation.

## Detection and refresh contract

`freeModelIds()` first applies the OrcaRouter OpenAI chat compatibility filter,
then recognizes a concrete model as free when one of these provider-owned
signals is present:

- its ID ends in `-free`;
- `pricing.request` is numeric zero; or
- both `pricing.prompt` and `pricing.completion` are numeric zero.

Some concrete `-free` records omit `supported_endpoint_types`; OrcaRouter's
free-model contract says these are chat replicas of the paid model, so the
suffix is the narrow compatibility fallback. A record that explicitly lists a
non-chat surface is still excluded.

Refresh without spending inference quota:

```sh
curl -fsS https://api.orcarouter.ai/v1/models -o /tmp/orcarouter-models.json
node src/model-discovery.mjs orca \
  --fixture /tmp/orcarouter-models.json --json
```

Primary sources:

- [Models and `/v1/models`](https://docs.orcarouter.ai/getting-started/models)
- [OpenAI-compatible HTTP](https://docs.orcarouter.ai/native-formats/openai-compat)
- [Free models](https://docs.orcarouter.ai/routing/free-models)
- [Billing and usage](https://docs.orcarouter.ai/operations/billing-and-usage)

Free inference still requires an OrcaRouter key. Free packs are separately
rate-limited, do not silently fall back to paid service, and the limits can
change; the live catalog and a non-billable discovery run remain authoritative.
