# Operations runbook

`jev_server.py` listens on `127.0.0.1:4319` and receives Responses requests for
the `jev/auto` model from the router fork embedded at `../router`. For each turn it asks Jev for a route
(tier + thinking depth), applies the routing policy, and relays the request to
the Codex Router's local caller edge, which serves native GPT models from the
shared ChatGPT session.

## Local authentication

After registering `jev`, run from the repository root:

```sh
node server/configure-auth.mjs
```

This uses the embedded router's credential transaction, retains an existing credential,
and prints metadata only. The Jev server reads the protected `jev.key` in the
router's `generic-provider-credentials` directory. All POSTs require a Bearer
header; the parent adds it automatically. Direct `/ask` clients must add it.
No OpenAI Platform API key is needed for this local ChatGPT-session relay.

## Lifecycle

| Action | Command |
|---|---|
| Decision log | `tail -f ~/.codex/codex-router/jev-router-live.jsonl` |
| Kill switch (no Jev → frontier) | `touch ~/.codex/codex-router/jev-router.off` / `rm` to re-enable |
| Install the launchd service | `bash server/install-service.sh` (in your own Terminal) |
| Service status | `launchctl print gui/$(id -u)/com.thibaultsaintjean.jev-router` |
| Service restart | `launchctl kickstart -k gui/$(id -u)/com.thibaultsaintjean.jev-router` |
| Watchdog (no launchd) | `server/watchdog.sh`, e.g. cron every 5 min |
| Router status | `bin/jev-codex-router router status` |
| Update the monorepo | `bin/jev-codex-router update` |
| Hide the model | `router/bin/control picker set jev/auto hide` |
| Disable the provider | `bin/jev-codex-router router providers generic disable jev` |
| Revoke native sharing | `bin/jev-codex-router router chatgpt-session disable` |

## After an embedded router update

`bin/jev-codex-router update` fetches this repository's `origin/main`, updates
the complete monorepo and invokes the root installer. It never pulls the
embedded router from a second checkout. Provider and model state live outside
the source tree, so updates should not touch them. Verify anyway:

1. `bin/jev-codex-router router providers generic list` → should show `SHOW jev`.
2. `cat ~/.codex/codex-router/model-picker.json` → `jev/auto` under `visible`.
3. `curl -s http://127.0.0.1:4319/health` → `{"ok": true...}`.
4. If needed: `bin/jev-codex-router router refresh-catalog`, then restart Codex.

## Troubleshooting

- **`invalid_responses_response` in router logs / “unavailable right now” in
  Codex**: the API forwarder parsed our reply as JSON instead of SSE. The server
  forces `Content-Type: text/event-stream` on streamed replies for exactly this
  reason; make sure you run the current `jev_server.py`.
- **401 / route refused by the edge**: the shared ChatGPT session expired —
  re-run `bin/jev-codex-router router chatgpt-session enable`.
- **Every turn routes to astra**: check the decision log (`gate` field) — the
  kill switch may be on, or the TypeSafe key is unreadable (look for
  `jev_error` / `no_key_or_task` gates).
- **Model missing from the picker**: re-run `refresh-catalog` and
  `picker set jev/auto show`, then fully restart Codex.

### Model visible but rejected by ChatGPT

`The 'jev/auto' model is not supported when using Codex with a ChatGPT account`
can mean the model is selected while the OpenAI provider still points directly
at OpenAI. Listing a model in a catalog, or declaring `[model_providers.jev]`,
does not associate an existing task with that provider.

1. Inspect `bin/jev-codex-router router status`: check `model_provider` and the redacted
   `openai_base_url`, not just whether the service is running.
2. Verify the main router has the enabled `jev` generic provider and the
   `jev/auto` entry in `user-models.json`. A direct Codex provider declaration
   is a separate configuration. Reload the router after restoring its routes;
   its startup regenerates the gateway configuration from source.
3. Preserve a user-owned `model_catalog_json`. With the built-in `openai`
   provider, Codex supports a user-level `openai_base_url` pointing to the
   router's authenticated loopback Responses entry. Use Codex's
   `config/value/write` API for this setting; resolve the caller capability
   locally from its protected file, never print it or put it in command
   arguments. Leave other provider definitions and model defaults intact.
4. Verify a small request through **4202 → Jev 4319 → native 4202**, then through
   an ephemeral Codex invocation reading the saved configuration. Checking
   Jev's health alone does not exercise the client transport.
5. Quit and reopen Codex on the host Mac to reload the configuration before
   retrying the existing task from desktop or mobile.

The built-in OpenAI transport override was verified with Codex
`0.155.0-alpha.9.2`; no switch to a different provider or catalog was needed.
See the [official configuration documentation](https://learn.chatgpt.com/docs/config-file/config-advanced)
for the distinction between the built-in endpoint override and custom providers.

## Design notes

- The edge emits SSE with no Content-Type; we always re-emit
  `text/event-stream; charset=utf-8` on stream relays.
- `stream: true` is forced upstream (the edge requires it); non-stream callers
  get the final response object assembled from the SSE stream.
- One compact Jev decision per request (included in total latency). Tool-loop
  continuations are re-classified from the active task and latest bounded step
  evidence, so the model may change between sub-actions. The canonical request
  and `prompt_cache_key` remain unchanged for the selected model.
