# Jev Codex Router

**Per-turn model routing for Codex, driven by [Jev](https://docs.typesafe.ai) (TypeSafe System One).**

Every turn is classified by Jev and served by the cheapest model that can handle
it, at a thinking depth adapted to the task — instead of running everything on
the frontier model. The decision costs ≈ $0.00003 and ≈ 0.6 s per turn.

This is not a fork of any router: it plugs into an existing local
**Codex Router** installation through its official extension points
(a *generic provider* + a *curated model*), so router updates never overwrite it.

## How it works

```
Codex ──▶ Codex Router (:4202)
            ├─ native models ──────────────▶ ChatGPT backend (your plan)
            └─ "jev/auto" ─▶ LiteLLM ─▶ API forwarder
                                     │
                                     ▼
                          jev_server.py (127.0.0.1:4319)
                            │ 1. classify the turn with Jev
                            │ 2. apply the routing policy
                            │    (model, reasoning.effort, service_tier)
                            ▼
                          local caller edge (shared native session)
                            └──▶ luna / sol / astra on the ChatGPT backend
```

- **Responses in, Responses out** — no format conversion; the SSE stream is
  relayed verbatim, so tool calls, reasoning and compaction behave natively.
- **Fail-open** — any Jev error keeps the turn alive (safe fallback route).
- **Kill switch** — a sentinel file routes without Jev, instantly.
- **Decision log** — every routed turn is logged locally for calibration
  (`~/.codex/codex-router/jev-router-live.jsonl`), never published.

## Routing policy

| Tier | Model | Thinking | Speed |
|---|---|---|---|
| Mechanical / clearly scoped | `gpt-5.6-luna` | **always max** | `priority` (fast lane; cheap enough that 2× is negligible) |
| Standard implementation | `gpt-5.6-sol` | adaptive (Jev depth) | standard |
| Hard / ambiguous | `gpt-6-astra` | adaptive (Jev depth) | standard |

When Jev's confidence is below the gate (`0.5`, tunable), the router **does not
downgrade**: the turn goes to the frontier model and the decision is logged for
calibration.

## Repository layout

```
poc/       Step 1 — tiering proof-of-concept (route tasks, measure decisions)
poc/       Step 2a — shadow replay: route your real Codex sessions offline
server/    Step 2b — the live server + service install (this is what runs)
hook/      Explored alternative (LiteLLM callback tap) — kept for reference
```

## Quickstart

Prerequisites: macOS, a Codex desktop install wired to a **Codex Router**
(checkout with `bin/codex-router`), Python 3.11+, and a TypeSafe API key (Jev).

**1. Give the server your TypeSafe key** — either
`export TYPESAFE_API_KEY=...` in the service environment, or:

```bash
echo 'TYPESAFE_API_KEY=your-key' >> ~/.hermes/.env   # default env file
# (override the path with JEV_ENV_FILE=/path/to/env)
```

**2. Start the server** (foreground test):

```bash
python3 server/jev_server.py
curl -s http://127.0.0.1:4319/health
```

**3. Register with the Codex Router:**

```bash
cd <codex-router checkout>

# share the native ChatGPT session with local clients (revisit if it expires)
./bin/codex-router chatgpt-session enable

# declare the generic provider (our local server, native Responses format)
./bin/codex-router providers generic add jev \
  --name "Jev Router" --base-url http://127.0.0.1:4319/v1 \
  --adapter openai-responses --allow-private

# declare the model: ~/.codex/codex-router/user-models.json
# (this file is local state — router updates won't touch it)
```

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
      "displayName": "Jev Auto",
      "description": "Auto-routing by Jev: every turn is classified and served by luna, sol or astra at the thinking depth it needs.",
      "priority": 95,
      "defaultEffort": "medium",
      "reasoningLevels": [
        { "effort": "low", "description": "Quick reasoning" },
        { "effort": "medium", "description": "Balanced reasoning" },
        { "effort": "high", "description": "Deep reasoning" },
        { "effort": "xhigh", "description": "Extended reasoning" },
        { "effort": "max", "description": "Maximum reasoning" }
      ],
      "contextWindow": 258400,
      "autoCompact": 219640,
      "inputModalities": ["text", "image"]
    }
  ]
}
```

```bash
# publish the catalog and make the model visible in the picker
./bin/codex-router refresh-catalog
./bin/control picker set jev/auto show
```

**4. Quit and reopen Codex**, then pick **“Jev Auto”** in the model picker.
Every turn now gets its own route.

**5. Make it permanent** (optional but recommended): run the service installer
in your own Terminal (launchd management is intentionally restricted inside
supervised agents):

```bash
bash server/install-service.sh
```

Without it, `server/watchdog.sh` (cron every 5 min) restarts the server if it
stops answering.

## Operations

| Action | Command |
|---|---|
| Watch decisions | `tail -f ~/.codex/codex-router/jev-router-live.jsonl` |
| Kill switch (no Jev → frontier) | `touch ~/.codex/codex-router/jev-router.off` (delete the file to re-enable) |
| Hide the model | `./bin/control picker set jev/auto hide` |
| Disable the provider | `./bin/codex-router providers generic disable jev` |
| Revoke native sharing | `./bin/codex-router chatgpt-session disable` |
| Service status | `launchctl print gui/$(id -u)/com.thibaultsaintjean.jev-router` |

**After a Codex Router update**, verify nothing was lost:

```bash
./bin/codex-router providers generic list        # shows: SHOW jev
cat ~/.codex/codex-router/model-picker.json      # jev/auto in "visible"
curl -s http://127.0.0.1:4319/health
```

## Notes & quirks

- The router's local edge requires `stream: true` — the server always forces it.
- The edge returns SSE with **no Content-Type header**; the server re-emits
  `text/event-stream` because the API forwarder picks its parser from it
  (otherwise it tries to JSON-parse the stream and fails with
  `invalid_responses_response`).
- The shared ChatGPT session authorization has a validity window; re-run
  `chatgpt-session enable` if native routing stops after a while.
- Code comments are in French for now (author's working language) — PRs welcome.

## Security

- **No secrets in this repository.** The server reads `TYPESAFE_API_KEY` from an
  env file or the process environment; everything else stays on your machine.
- The server binds `127.0.0.1` only, talks to your local Codex Router only, and
  never logs prompt content beyond a short task excerpt used for calibration.
- Local decision logs and replay data are git-ignored by default.

## Status

Early, but running in production on the author's setup. The routing policy and
the confidence gate are expected to be calibrated with real usage — the local
decision log is the calibration source.

## License

MIT
