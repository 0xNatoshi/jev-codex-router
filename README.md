# Jev Codex Router

[![ci](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml)

**Per-turn model routing for Codex, driven by [Jev](https://docs.typesafe.ai) (TypeSafe System One).**

Every turn is classified by Jev and served by the cheapest model that can handle
it, at a thinking depth adapted to the task — instead of running everything on
the frontier model. The decision costs ≈ $0.00003 and ≈ 0.6 s per turn.

**Measured savings: ≈ −60 % vs a full-frontier baseline** on a 7-day replay of
237 real turns — protocol, tables and limitations in [BACKTEST.md](BACKTEST.md).
Installing with an AI agent? Hand it [AGENTS.md](AGENTS.md).

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
- **Codex-dry tandem** — when native (ChatGPT) usage is exhausted (sentinel
  file, or an observed 429 / usage-limit response), the triptych is replaced:
  GLM (`opencode-go/glm-5.3-flash`) for frontier-tier steps, deepseek
  (`opencode-go/deepseek-v4.1-flash`) for everything else. The failed call is
  retried on the tandem; the next successful native call clears an auto flip.
- **Decision log** — every routed turn is logged locally for calibration
  (`~/.codex/codex-router/jev-router-live.jsonl`), never published.

## Routing policy

| Tier | Model | Thinking | Speed |
|---|---|---|---|
| Mechanical / clearly scoped | `gpt-5.6-luna` | **always max** | `priority` (fast lane; cheap enough that 2× is negligible) |
| Standard implementation | `gpt-5.6-sol` | adaptive (Jev depth) | standard |
| Hard / ambiguous | `gpt-6-astra` | adaptive (Jev depth) | standard |

When Jev's confidence is below the gate (`0.5`, tunable), the router **does not
downgrade**: the turn falls back to the **middle tier** (Sol) and the decision
is logged — a backtest over real sessions showed that falling back to the
frontier model instead eats ~80% of the savings (see `poc/BACKTEST.md`).

One measured exception: a **clean mechanical continuation** (tool step, no
error, low/medium depth) that Jev wanted on **Luna** keeps Luna on the priority
lane. Live data (1 day, 1 065 calls) showed 59% of calls were otherwise held to
Sol, including ~173/day of Luna-on-mechanics picks (~10× cheaper on Luna) —
those now log as `hold(luna_step)`.

### Codex-dry tandem — only while native usage is exhausted

The triptych is the policy **unless** the ChatGPT usage window is exhausted
(manual sentinel file, or an automatic flip on a 429 / usage-limit response,
which also retries the failed call on the tandem). While dry:

| Native tier | Dry substitute |
|---|---|
| `gpt-6-astra` (frontier) | `opencode-go/glm-5.3-flash` |
| `gpt-5.6-sol` / `gpt-5.6-luna` | `opencode-go/deepseek-v4.1-flash` |

An automatic flip expires after 30 minutes (re-probe) and is cleared by the
first successful native call; the manual sentinel file is never auto-cleared.

## Repository layout

```
BACKTEST.md  Savings backtest — protocol, tables, limitations (the "proof")
AGENTS.md    Autonomous install & operations playbook (for AI agents)
poc/         Tiering POC, shadow replay, and the backtest tool
server/      The live server + service install (this is what runs)
hook/        Explored alternative (LiteLLM callback tap) — kept for reference
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
| See the picked model in the thread | reasoning summaries carry ` · ⚡sol:low` appended per call |
| Shadow mode (decide + log, serve astra) | `touch ~/.codex/codex-router/jev-router.shadow` |
| Debug capture (shapes + raw streams) | `touch ~/.codex/codex-router/jev-router.debug` |
| Kill switch (no Jev → frontier) | `touch ~/.codex/codex-router/jev-router.off` (delete the file to re-enable) |
| Force the Codex-dry tandem | `touch ~/.codex/codex-router/jev-router.codex-dry` (delete the file to return to luna/sol/astra) |
| Inspect the dry auto state | `cat ~/.codex/codex-router/jev-router.codex-dry.json` (reason + expiry; auto-cleared by the next successful native call) |
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
