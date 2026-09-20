# Jev Codex Router

[![ci](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml)

**Per-turn model routing for Codex, driven by [Jev](https://docs.typesafe.ai) (TypeSafe System One).**

Jev chooses a model and thinking effort together for each model call, including
continuations after tools. Every route uses standard speed. The objective is
sufficient capability for the next decision with no unnecessary quota consumption.

**Historical simulation: ≈ −60 % vs full Astra** on 237 turns under the old
policy. This is not measured Codex quota saved, nor evidence for the current
policy — protocol and limitations in [BACKTEST.md](BACKTEST.md).
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
  retried on the tandem, at the thinking depth Jev decided, mapped onto the Go
  models' own ladder; a tandem call that comes back retryable is tried once on
  the sibling model before the turn is lost. The next successful native call
  clears an auto flip.
- **Decision log** — every routed turn is logged locally for calibration
  (`~/.codex/codex-router/jev-router-live.jsonl`), never published.

## Routing policy

The shared contract in `server/routing_policy.py` gives Jev 15 explicit pairs:
Luna, Sol or Astra × low, medium, high, xhigh or max thinking. Jev chooses the
pair in one Choice question, using capability profiles and the current request,
recent assistant intent, and the available tool result. Every pair uses standard
speed, overriding an incoming Fast setting, including retries and bypass modes.

There is no preferred model, target distribution, keyword-to-model rule,
low-confidence fallback to Sol, mechanical-step exception, or compaction pin.
A valid decision is applied unchanged even when several pairs are close. Jev's
confidence and full choice distribution are logged separately; neither is a
measured probability that the selected model will successfully finish the task.

The model descriptions are capability priors, not calibrated success rates.
The policy must be evaluated on completed tasks, corrections, tokens and quota,
not on a desired share of Luna calls or artificially high confidence. Schema
checks and synthetic routing samples establish wiring, not equal-quality savings.
A missing/invalid Jev response or a provider error still uses the separately
logged technical fail-open route (Astra at medium); the manual kill switch and
native-quota exhaustion are operational bypasses, not Jev decisions.

### Codex-dry tandem — only while native usage is exhausted

The triptych is the policy **unless** the ChatGPT usage window is exhausted
(manual sentinel file, or an automatic flip on a 429 / usage-limit response,
which also retries the failed call on the tandem). While dry:

| Native tier | Dry substitute |
|---|---|
| `gpt-6-astra` (frontier) | `opencode-go/glm-5.3-flash` |
| `gpt-5.6-sol` / `gpt-5.6-luna` | `opencode-go/deepseek-v4.1-flash` |

An automatic flip lasts until the instant the edge announced for the window
reset, so the first call after the quota returns is served by the triptych
again; when a refusal announces no instant it falls back to a 30-minute
re-probe, and a week is the ceiling on anything a refusal claims. It is cleared
by the first successful native call, and the manual sentinel file is never
auto-cleared.

Two details keep the substitute transparent. The decided depth travels with the
call, mapped onto the Go ladder — `low` stays `low`, `medium` and `high` become
`high`, `xhigh` or above become `max` — because those models declare three rungs
where the triptych exposes five, and the API forwarder clamps the value once more
onto the route's own ladder. And a tandem call that comes back retryable
(429/5xx) is tried once on the sibling model: opencode Go meters the two Go
models against separate allowances and reports a spent one the same way it
reports a transient outage. If both refuse, the caller receives that refusal
rather than a request nobody answers.

A third detail keeps the relay legal for the Responses consumer in front of it.
A dry turn crosses the local edge, which encodes response ids, so the terminal
event of the stream the relay receives repeats the id under a fresh encoding.
Read as-is, that is a completion that renamed its own response, and the consumer
replaces the finished turn with an `invalid_responses_stream` error; the relay
therefore rewrites the terminal id onto the one `response.created` announced.
Native turns are untouched — their ids already match.

## Measuring what it served

The router logs one JSON line per decision (`~/.codex/codex-router/jev-router-live.jsonl`).
`server/report_routing.py` turns that log into the routing/savings report — the
table a third party can reproduce on their own machine:

```bash
python3 server/report_routing.py --days 7          # text tables (default window)
python3 server/report_routing.py --days 30 --json  # machine-readable
```

It prints the served model distribution (luna/sol/astra, plus the Codex-dry
tandem when it took over: turns + %), the share of turns served by the cheapest
tier, the share of turns held below the confidence gate, the gates encountered,
median latency (end-to-end and Jev's own decision time), and an estimate of the
real cost against two counterfactuals — every turn on `gpt-6-astra`, and every
turn on `gpt-5.6-sol`.

New log entries record a versioned decision and each upstream attempt's model,
effort, standard speed, terminal event and token usage when the provider reports
it. Only numeric usage counters are retained. Unknown usage is not counted as
zero, retries are retained, and reasoning tokens are already included in output.
The report estimates standard ChatGPT credits from these observed tokens against
all-Sol and all-Astra counterfactuals. External fallback calls are excluded from
that comparison. These are published-rate estimates, not observed account debits;
counterfactual token volumes and task quality have not been experimentally measured.

Historical entries without usage keep a separate fixed-volume API-rate proxy.
Their logged Fast speed retains its surcharge instead of being repriced by the
new policy. The old backtest is clearly labelled as a simulation. Current replay
scripts share the live decision contract and reject a cache from another policy.

## Ask surface (`POST /ask`)

The server also answers typed questions directly, for local callers that bring
their own question set. The `jev-browser-choice` skill is the first one: it
turns an in-app-browser accessibility dump into one Jev `choice` question and
acts only on the validated element index, so the page never enters the model's
context.

```sh
curl -s http://127.0.0.1:4319/ask -X POST -H 'Content-Type: application/json' \
  -d '{"state":{"goal":"open the docs"},"questions":{"next":{"type":"choice","instructions":"Which element advances the goal?","criteria":{"e5":"link Documentation"}}}}'
# → {"model":"jev-1.13.0","answers":{"next":{...}},"usage":{...},"ms":612}
```

Validation is the whole contract: a JSON-serialisable `state` under 120k chars,
at most 40 questions, each a `noul`, `choice` or `score` with its instructions
and criteria. The caller's state is never logged. `502` surfaces an upstream Jev
failure — `402` means the TypeSafe account is out of credits — and `503` means
no key is configured.

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
      "displayName": "Jev Codex Router",
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

**4. Quit and reopen Codex**, then pick **“Jev Codex Router”** in the model picker.
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
| See the picked model in the thread | every reasoning summary part carries the routed tag, separators on both sides: ` · 🧠sol:low · ` — one glyph per route: ⚡ luna (economical) · 🧠 sol (workhorse) · 🚀 astra (frontier) · 🌍 terra; 🐳 deepseek / ✨ glm while the Codex-dry tandem is serving |
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

Early, but running in production on the author's setup. The joint routing policy needs outcome calibration on real usage; the local
decision and attempt logs provide observations, not quality labels.

## License

MIT
