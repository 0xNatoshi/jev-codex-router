# Grok OAuth Fast

`grok-oauth/grok-4.6` advertises the optional `priority` service tier as **Fast**.
The normal tier remains the default. This does not change reasoning effort.
Other Grok models and providers retain their existing catalog and request behavior.

After updating Router and republishing its catalog, reopen Codex Desktop if its
model controls are cached. Select Grok 4.6 and use the native Fast control where
the client supports service tiers. Router does not enable Fast globally.
Desktop versions may use generic speed multipliers in their tooltip; those are
not a measurement of Grok throughput. See xAI's [Priority Processing contract](https://docs.x.ai/developers/advanced-api-usage/priority-processing)
for requested versus granted tiers. API-key pricing is not proof of OAuth
subscription billing or account entitlement.

## Transport and measurements

LiteLLM 1.96.0 drops the normal Responses `service_tier` argument on the Chat
bridge, so Router copies known values into `extra_body` on this exact route.
The Grok forwarder copies the value only for upstream model `grok-4.6`. A
routed body keeps `service_tier` only when the route serving it advertises that
tier (checked-in or curated `serviceTiers`): a turn that fails over from Grok
4.6 to another model, or a compaction for another route, is never sent a
priority request that route did not offer.

The actual tier is taken only from the upstream terminal response. Streaming
Chat responses carry a bounded `provider_specific_fields.grok_service_tier`
marker on their finish chunk; a usage-only chunk does not survive the bridge.
Non-streaming responses also carry a private service-tier header. The configured
LiteLLM callback restores metadata from that header for this model group only.
The callback is published privately beside the generated gateway YAML.

Usage rows distinguish `requestedServiceTier`, `serviceTier`, and an optional
`serviceTierUnknown` flag. Missing provider data remains missing. Unknown raw
values are not logged. A provider returning `default` after a `priority` request
is recorded as default. Retry billing is never assigned one attempt's tier;
aggregated attempts omit the actual tier, including a turn the router retried
after an empty completion or a pre-content limit when only one attempt reported
usage. No tier-based cost is calculated here.

## Verification

The local protocol fixture runs an isolated Router, the locked LiteLLM gateway,
the production Grok forwarder, and a synthetic loopback xAI server. No account
credentials or live generation are used:

```sh
node scripts/verify-grok-service-tier.mjs .venv/bin/python
```

On Windows pass `.venv/Scripts/python.exe`. The protocol workflow runs this on
Linux, macOS, and Windows. Cases cover HTTP streaming, HTTP JSON and WebSocket,
grant/fallback/missing/unknown tiers, omitted/default requests, Grok 4.5 as a
negative control, usage privacy, and exact preservation of 1000 text fragments.
This is protocol correctness evidence, not a comparative speed benchmark.
