# AGENTS.md — autonomous install & operations playbook

This file lets a coding agent (Codex, Claude Code, Cursor, …) install, verify
and operate the **Jev Codex Router** on a user's machine without asking for
context it can discover itself. Follow it top to bottom. Do not skip the
verification step after each stage — they are what makes autonomy safe here.

## What you are installing

A local server plus a Codex Router extension that adds one model to the Codex
picker — **"Jev Codex Router v1"** (`jev/auto`). Every turn sent to it is classified by
[Jev](https://docs.typesafe.ai) (TypeSafe System One) and served by the
cheapest model that can handle it, at a thinking depth adapted to the task.
All traffic stays on loopback; the design is fail-open; there is a kill switch.

## Hard rules (never violate)

1. **Never print, log, commit, or transmit secrets** — the TypeSafe API key,
   the router `caller-secret`, or ChatGPT tokens. Reference them by file path.
2. **Never edit router-owned files**: `litellm.yaml` under the router's state
   directory, anything under `<router checkout>/src/`, or the
   `codex-router-managed` blocks of `~/.codex/config.toml`. The router
   regenerates or oversees them; edit only through its CLI and documented
   state files (`user-models.json`, `generic-providers.json` via CLI).
3. The server binds `127.0.0.1` only. Never expose it on another interface.
4. If `launchctl` is restricted in your environment (supervised agents often),
   skip the service install — use the watchdog pattern and let the user run
   `server/install-service.sh` from their own Terminal instead. Never fight
   the restriction.
5. Treat prompt excerpts in local logs (`jev-router-live.jsonl`,
   `shadow-log.jsonl`) as private user data: read locally, never republish.

## Prerequisites (check, and report what you found)

- **macOS** with **Codex** and a **Codex Router installation** (the local router
  that serves native GPT models to Codex on `127.0.0.1:4202`).
  Check: `<router checkout>/bin/codex-router status` → expect
  `{"state":"running"}`; `./bin/codex-router providers generic list` must exist.
- **Python ≥ 3.11** — `python3 -V`.
- A **TypeSafe API key** for Jev. The server looks for `TYPESAFE_API_KEY` in
  `~/.hermes/.env` first, then `~/.jev.env`, then the process environment.
  If none exists, **stop and ask the user where their key file is — never ask
  for the key value itself in chat.**

## Install, step by step

### 1 — Start the server

```bash
cd <repo>
python3 server/jev_server.py &            # long-lived; launchd service in step 6
curl -s http://127.0.0.1:4319/health      # expect: {"ok": true, "service": "jev-router"}
curl -s http://127.0.0.1:4319/v1/models   # expect: one model, id "auto"
```

### 2 — Declare the model

Create `~/.codex/codex-router/user-models.json` (hand-editable state file; if
it already has `models`, append to the array instead of overwriting):

```json
{
  "version": 1,
  "models": [
    {
      "slug": "jev/auto",
      "gatewayModel": "jev-auto",
      "compHash": "jev-auto-user-v1",
      "upstreamModel": "auto",
      "provider": "jev",
      "listed": true,
      "displayName": "Jev Codex Router v1",
      "description": "Auto-routing by Jev (TypeSafe): every turn is classified and served by luna, sol or astra at the thinking depth it needs.",
      "priority": 95,
      "defaultEffort": "medium",
      "reasoningLevels": [
        {"effort": "low", "description": "Quick reasoning"},
        {"effort": "medium", "description": "Balanced reasoning"},
        {"effort": "high", "description": "Deep reasoning"},
        {"effort": "xhigh", "description": "Extended reasoning"},
        {"effort": "max", "description": "Maximum reasoning"}
      ],
      "contextWindow": 258400,
      "autoCompact": 219640,
      "inputModalities": ["text", "image"]
    }
  ]
}
```

### 3 — Register the generic provider (router CLI)

```bash
cd <router checkout>
./bin/codex-router providers generic add jev --name "Jev Router" \
  --base-url http://127.0.0.1:4319/v1 --adapter openai-responses --allow-private
./bin/codex-router providers generic list
# expect:  SHOW jev   Jev Router (openai-responses)
```

### 4 — Share native ChatGPT access with local clients

```bash
./bin/codex-router chatgpt-session enable
# expect: "enabled for this user's local Codex Router clients (session valid
# for about NNNh)". Re-run this when native calls later return Unauthorized.
```

### 5 — Publish and show

```bash
./bin/codex-router refresh-catalog        # merged catalog must now contain "jev/auto"
./bin/control picker set jev/auto show    # returns the picker JSON with jev/auto visible
```

### 6 — Persistent service (optional)

Ask the user to run, in **their own Terminal**:

```bash
bash <repo>/server/install-service.sh     # launchd service, keep-alive, logs in ~/Library/Logs
```

Alternative (any scheduler, every 5 min): `<repo>/server/watchdog.sh` —
silent when healthy, restarts the server when down.

### 7 — Restart Codex

Fully quit and reopen the Codex app so it reloads the picker catalog, then the
user can select **Jev Codex Router v1**.

## End-to-end verification (must pass before declaring success)

```bash
SEC=$(cat ~/.codex/codex-router/caller-secret | tr -d '\n')
curl -s -N -m 120 -X POST "http://127.0.0.1:4202/_codex-router/$SEC/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"jev/auto","input":[{"role":"user","content":[{"type":"input_text","text":"Say OK"}]}],"stream":true}' | head -c 400
```

Expect an SSE stream: `data: {"type":"response.created",...,"model":"gpt-5.6-luna",…`
(a trivial prompt routes to luna) ending with `response.completed` and
`data: [DONE]`. Then:

```bash
tail -1 ~/.codex/codex-router/jev-router-live.jsonl
# expect one JSON line: gate=apply, tier, conf, depth, model, effort, speed,
# jev_ms, total_ms, status=200, out=sse
```

## Operations

- **Decision log**: `~/.codex/codex-router/jev-router-live.jsonl` — one line per
  routed turn.
- **Kill switch** (instant, no restart): `touch ~/.codex/codex-router/jev-router.off`
  → the server relays to astra without calling Jev. Remove the file to re-enable.
- **Codex-dry tandem** (only while native usage is exhausted):
  `touch ~/.codex/codex-router/jev-router.codex-dry` → frontier-tier calls go to
  `opencode-go/glm-5.3-flash`, every other tier to
  `opencode-go/deepseek-v4.1-flash`; remove the file to return to the
  luna/sol/astra triptych. An automatic flip (429 / usage-limit response) also
  retries the failed call on the tandem, expires after 30 minutes
  (`jev-router.codex-dry.json`) and is cleared by the next successful native
  call. Log fields to watch: `dry`, `native`, `retried`.
- **Thread display**: streamed reasoning summaries get the routed tag appended
  in place ( · 🧠sol:low · , separators on both sides so the next summary part
  never glues to the tag; one glyph per route — ⚡luna, 🧠sol, 🚀astra,
  🐳deepseek/✨glm in tandem) — the picked model shows inside each call's thinking
  block in the Codex thread.
- **Shadow mode**: `touch ~/.codex/codex-router/jev-router.shadow` → decisions
  are logged (`would` field) while every call is still served by astra.
- **Debug capture** (bounded): `touch ~/.codex/codex-router/jev-router.debug`
  → request shapes in `jev-router-debug.jsonl` and raw response streams in
  `jev-router-debug-stream.log`. Remove the file to stop.
- **Tune the policy**: constants at the top of `server/jev_server.py`
  (`CONF_GATE`, tiers). Restart the server after edits.
- **Backtest**: `python3 poc/backtest_savings.py --days 7` (see BACKTEST.md).
- **Disable**: `./bin/codex-router providers generic disable jev` (keeps state);
  full rollback: also `./bin/codex-router chatgpt-session disable` and stop the
  service (`launchctl bootout gui/$(id -u)/com.thibaultsaintjean.jev-router`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"detail":"Unauthorized"}` from the caller edge | native sharing off | `./bin/codex-router chatgpt-session enable` |
| `{"detail":"Stream must be set to true"}` | the caller edge streams only | send `"stream": true`; the bundled server forces it |
| HTTP 502 `provider_api_proxy_error` on jev-auto | server-side error | check the `status`/`out` fields in `jev-router-live.jsonl`, and the server's stderr log |
| "Jev Codex Router v1" absent from the picker | not published/visible, or Codex not restarted | `refresh-catalog`, `control picker set jev/auto show`, full Codex restart |
| Native 429 / "usage limit" while routing | ChatGPT usage window exhausted | expected: the Codex-dry tandem takes over (`jev-router.codex-dry.json`); delete the manual file to re-probe sooner |
| `Unknown API gateway model: jev-auto` | catalog not republished | `./bin/codex-router refresh-catalog` |
| Jev returns HTTP 422 | request body missing `"model"` | always send `"model": "jev-latest"` to the System One API |
| Native calls fail after a few days | shared session expired | re-run `chatgpt-session enable` |
| `launchctl` rejected inside a supervised agent | environment restriction | use the watchdog; let the user run `install-service.sh` |

## Latency & cost notes

- Each decision costs ≈ 0.6–0.9 s and ≈ $0.00003 (Jev input pricing).
- Any Jev failure is fail-open: the turn is served by astra @medium and the
  fallback is logged (`gate=jev_error:*`).
- Default routing policy: luna = always max thinking + fast mode; sol/astra =
  adaptive depth; low-confidence turns fall back to the **middle tier (sol)** —
  see BACKTEST.md for why that single choice is worth ~80% of the savings.
