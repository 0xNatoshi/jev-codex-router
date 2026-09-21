# AGENTS.md — autonomous install & operations playbook

This file lets a coding agent (Codex, Claude Code, Cursor, …) install, verify
and operate the **Jev Codex Router** on a user's machine without asking for
context it can discover itself. Follow it top to bottom. Do not skip the
verification step after each stage — they are what makes autonomy safe here.

## What you are installing

A local server plus a Codex Router extension that adds one model to the Codex
picker — **"Jev Codex Router"** (`jev/auto`). Every turn sent to it is classified by
[Jev](https://docs.typesafe.ai) (TypeSafe System One) and served by the
cheapest model that can handle it, at a thinking depth adapted to the task.
Local hops stay on loopback; Jev calls go to TypeSafe. Authenticated model
requests are fail-open on Jev classification errors; there is a kill switch.

## Hard rules (never violate)

1. **Never print, log, commit, or transmit secrets** — the TypeSafe API key,
   the router `caller-secret`, or ChatGPT tokens. Reference them by file path.
2. **Edit the source, never the artifact.** `<router checkout>/src/` is the
   router's own source and is meant to be edited: a behaviour bug is fixed
   there, committed on the checkout's branch, with the tests that cover it.
   What is off limits is the *generated and managed* output — `litellm.yaml`
   under the router's state directory is rendered from `src/litellm-config.mjs`
   whenever the catalog changes, and the `codex-router-managed` blocks of
   `~/.codex/config.toml` are written by the CLI, so a hand edit there is
   overwritten rather than applied. Change the generator, or drive the CLI and
   the documented state files (`user-models.json`, `generic-providers.json`),
   and leave the artifacts to be regenerated.
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
      "displayName": "Jev Codex Router",
      "description": "Auto-routing by Jev (TypeSafe): every turn is classified and served by luna, terra, sol or astra at the thinking depth it needs.",
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
      "searchTool": {"mode": "hosted"},
      "supportsSearchHistory": true,
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

Provision its local transport credential via the parent's protected transaction:

```bash
node <jev checkout>/server/configure-auth.mjs <router checkout>
```

All POST requests require this credential, loaded from
`~/.codex/codex-router/generic-provider-credentials/jev.key` (0600).
The parent attaches it automatically; custom `/ask` clients must load it in
memory and send a Bearer header. Never put it in a URL or command argument.

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
user can select **Jev Codex Router**.

## End-to-end verification (must pass before declaring success)

```bash
python3 server/smoke.py
```

Expect HTTP 200 and status `completed`, with a selected native model. The
script refuses a stale running policy and never prints credentials. Then:

```bash
tail -1 ~/.codex/codex-router/jev-router-live.jsonl
# expect one JSON line: gate=apply, tier, conf, depth, model, effort, speed,
# jev_ms, total_ms, status=200, out=sse
```

## Operations

- **Decision log**: `~/.codex/codex-router/jev-router-live.jsonl` — one line per
  routed turn.
- **Ask surface**: `POST /ask` (also `/v1/ask`) — typed pass-through to System
  One for local callers with their own question set (state ≤ 120k chars, ≤ 40
  questions, caller state never logged). `502 jev: HTTP Error 402` means the
  TypeSafe account is out of credits; `503` means no key was found.
- **Kill switch** (instant, no restart): `touch ~/.codex/codex-router/jev-router.off`
  → the server relays to astra without calling Jev. Remove the file to re-enable.
- **Codex-dry tandem** (only while native usage is exhausted):
  `touch ~/.codex/codex-router/jev-router.codex-dry` → calls go to the configured
  fallback (default `deepseek/deepseek-v4.1-flash` for all tiers). Set
  `JEV_FALLBACK_STANDARD` / `JEV_FALLBACK_FRONTIER` to existing configured routes
  at service startup for distinct targets; retries never repeat an identical target.
  Remove the file to return to the
  luna/terra/sol/astra native model ladder. An automatic flip (429 / usage-limit response) also
  retries the failed call on the tandem, then lasts until the instant the edge
  announced for the window reset (30 minutes when the refusal announces none,
  one week at most) — `cat ~/.codex/codex-router/jev-router.codex-dry.json`
  reads the reason and `until_iso` — and is cleared by the next successful
  native call. Log fields to watch: `dry`, `native`, `retried`.
- **Thread display**: streamed reasoning summaries get the routed tag appended
  in place ( · 🧠sol:low · , separators on both sides so the next summary part
  never glues to the tag; one glyph per route — ⚡luna, 🧠sol, 🚀astra,
  🐳deepseek/✨glm in tandem) — the picked model shows inside each call's thinking
  block in the Codex thread.
- **Shadow mode**: `touch ~/.codex/codex-router/jev-router.shadow` → decisions
  are logged (`would` field) while every call is still served by astra.
- **Debug capture** (bounded): `touch ~/.codex/codex-router/jev-router.debug`
  → request shapes in `jev-router-debug.jsonl` and transport counters in
  `jev-router-debug-stream.log`. Remove the file to stop.
  Logs are 0600, rotate at 8 MiB and retain one backup. No new prompt excerpts
  or raw model streams are recorded; old captures are protected, not deleted.
- **Tune the policy**: the shared contract in `server/routing_policy.py`. Keep decisions
  joint and evidence-based; restart the server after edits. Cache affinity
  (`last_model`, warm models within the caller TTL, coarse context size) is a
  cost signal inside Jev's typed model choice, never a code-side model override.
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
| "Jev Codex Router" absent from the picker | not published/visible, or Codex not restarted | `refresh-catalog`, `control picker set jev/auto show`, full Codex restart |
| Native 429 / "usage limit" while routing | ChatGPT usage window exhausted | expected: the Codex-dry tandem takes over (`jev-router.codex-dry.json`); delete the manual file to re-probe sooner |
| Jev calls fail with `402 Payment Required` (`gate=codex_dry(fallback)`, `tier` null in the log) | the TypeSafe account is out of credits | expected: the router keeps serving through the tandem; add credits at console.typesafe.ai to restore classification |
| `Unknown API gateway model: jev-auto` | catalog not republished | `./bin/codex-router refresh-catalog` |
| Jev returns HTTP 422 | request body missing `"model"` | always send `"model": "jev-latest"` to the System One API |
| Native calls fail after a few days | shared session expired | re-run `chatgpt-session enable` |
| `launchctl` rejected inside a supervised agent | environment restriction | use the watchdog; let the user run `install-service.sh` |

## Latency & cost notes

- The current policy is `split-v9-cache-aware`: one System One request asks
  three independent Choice questions with explicit criteria — mandatory Astra
  policy, capability tier and reasoning effort — for every model call, including
  tool continuations and post-compaction calls. Pre-project software/project
  architecture, independent final code review and risk-focused review force Astra while
  preserving Jev's independently selected effort. The model question also gets
  bounded cache affinity for the private prompt-cache scope so a sufficient warm
  model can beat a cold switch without blocking a materially required tier.
  Provider retries inside one
  call keep that decision.
  Routine in-progress quality checkpoints, score comparisons and fixes to established
  findings use normal routing. Good scores never waive a required final/risk review.
  The router does not run `jev-review` or create an independent reviewer; quality
  scoring and blind reviewer context must be handled by the calling workflow.
  The selected model always receives the complete canonical request and the
  original cache controls; Jev receives only the bounded decision dossier. A
  context-dependent short ask also gets one bounded active-task summary. Cache
  hits are a cost optimization, never the carrier of conversation continuity:
  reuse is measured per `(hashed session, model)`, while every model swap still
  gets the full replay. All tiers use adaptive effort and standard speed; never
  force Luna to max or enable Fast mode.
- Apart from the explicit mandatory-Astra policy, no scenario override, target
  model share, or confidence threshold may replace a valid Jev choice. Confidence
  is diagnostic. The native ladder is Luna → Terra → Sol → Astra. Terra covers
  routine bounded implementation with clear requirements; Sol covers complex
  implementation and cross-file reasoning. Mandatory Astra categories still win.
  Judge remaining work, not completed phases: administrative follow-through is
  not review. Luna needs explicit mechanical work; implied intent and autonomous
  investigation belong to Sol. Optimize total task cost including clarification
  and correction turns, without scenario regexes or automatic opening floors.
  Every short ask receives one bounded preceding task and assistant proposal.
  The latest tool batch contributes counts and at most three excerpts, errors
  first. Replay and live routing share the same dossier builder.
- Provider/schema failures remain distinct: Astra at medium, logged as a
  technical fallback. Kill switch and exhausted-native-quota handling still apply.
- Jev usage and upstream per-attempt tokens are logged when available. Run
  `python3 server/report_routing.py --days 7` for native-only credit estimates
  and observed prompt-cache reads by model/session; unknown usage remains
  unknown and reasoning tokens are not counted twice.
- `BACKTEST.md` documents the old policy's fixed-token simulation. It is not a
  measurement of current quota savings or result quality.
