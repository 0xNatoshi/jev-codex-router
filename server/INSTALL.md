# Operations runbook

`jev_server.py` listens on `127.0.0.1:4319` and receives Responses requests for
the `jev/auto` model. For each turn it asks Jev for a route
(tier + thinking depth), applies the routing policy, and relays the request to
the Codex Router's local caller edge, which serves native GPT models from the
shared ChatGPT session.

## Lifecycle

| Action | Command |
|---|---|
| Decision log | `tail -f ~/.codex/codex-router/jev-router-live.jsonl` |
| Kill switch (no Jev → frontier) | `touch ~/.codex/codex-router/jev-router.off` / `rm` to re-enable |
| Install the launchd service | `bash server/install-service.sh` (in your own Terminal) |
| Service status | `launchctl print gui/$(id -u)/com.thibaultsaintjean.jev-router` |
| Service restart | `launchctl kickstart -k gui/$(id -u)/com.thibaultsaintjean.jev-router` |
| Watchdog (no launchd) | `server/watchdog.sh`, e.g. cron every 5 min |
| Hide the model | `./bin/control picker set jev/auto hide` (router checkout) |
| Disable the provider | `./bin/codex-router providers generic disable jev` |
| Revoke native sharing | `./bin/codex-router chatgpt-session disable` |

## After a Codex Router update

Provider and model state live outside the router checkout, so updates should not
touch them. Verify anyway:

1. `./bin/codex-router providers generic list` → should show `SHOW jev`.
2. `cat ~/.codex/codex-router/model-picker.json` → `jev/auto` under `visible`.
3. `curl -s http://127.0.0.1:4319/health` → `{"ok": true...}`.
4. If needed: `./bin/codex-router refresh-catalog`, then restart Codex.

## Troubleshooting

- **`invalid_responses_response` in router logs / “unavailable right now” in
  Codex**: the API forwarder parsed our reply as JSON instead of SSE. The server
  forces `Content-Type: text/event-stream` on streamed replies for exactly this
  reason; make sure you run the current `jev_server.py`.
- **401 / route refused by the edge**: the shared ChatGPT session expired —
  re-run `./bin/codex-router chatgpt-session enable`.
- **Every turn routes to astra**: check the decision log (`gate` field) — the
  kill switch may be on, or the TypeSafe key is unreadable (look for
  `jev_error` / `no_key_or_task` gates).
- **Model missing from the picker**: re-run `refresh-catalog` and
  `picker set jev/auto show`, then fully restart Codex.

## Design notes

- The edge emits SSE with no Content-Type; we always re-emit
  `text/event-stream; charset=utf-8` on stream relays.
- `stream: true` is forced upstream (the edge requires it); non-stream callers
  get the final response object assembled from the SSE stream.
- One Jev decision per request (≈0.6 s, included in total latency). Tool-loop
  continuations are re-classified on the same last-user text; they land on the
  same tier in practice, and everything is logged for tuning.
