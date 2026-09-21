# Jev Codex Router

[![ci](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/0xNatoshi/jev-codex-router/actions/workflows/ci.yml)

**Per-call model routing for Codex, driven by [Jev](https://docs.typesafe.ai) (TypeSafe System One).**

Jev chooses a model and thinking effort together for each model call, including
continuations after tools. Every route uses standard speed. The objective is
sufficient capability for the next decision with no unnecessary quota consumption.

**Historical simulation: ≈ −60 % vs full Astra** on 237 turns under the old
policy. This is not measured Codex quota saved, nor evidence for the current
policy — protocol and limitations in [BACKTEST.md](BACKTEST.md).
Installing with an AI agent? Hand it [AGENTS.md](AGENTS.md).

This repository is a self-contained monorepo. It embeds the maintained
**Codex Router fork** under `router/` and connects Jev through its generic-provider
and curated-model extension points. No second Git checkout, submodule, or hidden
source clone is required. The imported fork and its provenance are documented in
[ROUTER_FORK.md](ROUTER_FORK.md).

## How it works

```
Codex ──▶ Codex Router (:4202)
            ├─ native models ──────────────▶ ChatGPT backend (your plan)
            └─ "jev/auto" ─▶ LiteLLM ─▶ API forwarder
                                     │
                                     ▼
                          jev_server.py (127.0.0.1:4319)
                            ├─ compact decision state ─▶ Jev
                            │                           └─ model + effort
                            │
                            └─ canonical Codex replay + decision
                               └─▶ local caller edge (shared native session)
                                    └─▶ luna / terra / sol / astra
```

- **Responses in, Responses out** — no format conversion; the SSE stream is
  relayed verbatim, so tool calls, reasoning and compaction behave natively.
- **Two independent projections** — Jev sees only the bounded decision state.
  The executing model receives the complete canonical replay held by Codex:
  instructions, history or compaction handoff, tool calls and tool results.
  The embedded router exempts the exact `jev/auto` route
  from conversation windowing and tool-result aging; those optimizations would
  otherwise destroy context before this server could relay it.
- **Fail-open** — any Jev error keeps the turn alive (safe fallback route).
- **Kill switch** — a sentinel file routes without Jev, instantly.
- **Quota fallback** — native quota exhaustion switches to the configured
  fallback. The default is one `deepseek/deepseek-v4.1-flash` target, not a
  two-model tandem. A second attempt is made only when a distinct target is
  configured, and before emitting any retryable error to the client.
- **Decision log** — every routed turn is logged locally for calibration
  (`~/.codex/codex-router/jev-router-live.jsonl`), never published.

## Routing policy

The shared contract in `server/routing_policy.py` gives Jev four independent
Choice questions in one request: whether the next call falls under the mandatory
Astra policy, the least expensive sufficient capability tier (Luna, Terra, Sol or
Astra), the minimum sufficient thinking depth (low through max), and a bounded
route lease (`one_call`, `tool_chain` or `user_turn`). The first
choice covers project architecture, independent final code review and risk-focused
review (security, auth/permissions, concurrency, migrations, public API compatibility
or material performance risks). Routine in-progress quality checkpoints, comparing
scores and fixing established findings use ordinary capability routing; the word
"review" alone does not force Astra. Code forces Astra when that policy choice is positive,
regardless of the ordinary tier choice; the independently selected effort is
preserved. Every pair uses standard speed, overriding an incoming Fast setting,
including retries and bypass modes.

There is no target distribution, keyword-to-model rule, low-confidence fallback
to Sol, mechanical-step exception, or compaction pin. Outside the explicit
mandatory-Astra policy, a valid pair of tier and effort decisions is applied
unchanged even when options are close. Jev's conservative combined confidence
and all four choice distributions are logged separately; neither is a measured
probability that the selected model will successfully finish the task.

The native ladder is Luna → Terra → Sol → Astra. Terra covers routine bounded
implementation with clear requirements, small local features, known-cause fixes
and straightforward tests; Sol covers complex implementation and cross-file
reasoning. These profiles are routing priors, not measured capability guarantees.
Terra attempts are counted as native in reports; its ChatGPT credit estimate
remains unknown until a verified credit rate is configured.

Policy `split-v10-measured-cache` judges remaining work rather than inheriting a
completed review's category. Explicit mechanical follow-through can use Luna;
implied intent, underspecified goals and autonomous investigation favor Sol.
The objective includes correction and clarification costs. There is no
keyword-based override or automatic model floor on conversation openings.
Short asks receive a bounded preceding task and assistant proposal without a
language-specific intent regex. Separate instruction/environment messages are
skipped. A tool-result batch carries total/error counts and at most three short
excerpts, prioritizing errors. The canonical executor replay is unchanged.

Continuous quality signals and independent reviews are complementary. A favorable
Jev quality score never cancels a required final/risk review; routing confidence
is not a code-quality score. This router classifies the next model call: it does
not install or invoke `jev-review`, run a scoring loop, or create a separate
reviewer. For a workflow using that tool, bound score-driven corrections to one
justified iteration (a second only with new evidence), keep tests authoritative,
and give the independent Astra reviewer the task and code before comparing its
findings with Jev's scores. Review isolation belongs to that workflow; the router
still forwards the full canonical conversation and does not strip scores from it.

The model descriptions are capability priors, not calibrated success rates.
The policy must be evaluated on completed tasks, corrections, tokens and quota,
not on a desired share of Luna calls or artificially high confidence. Schema
checks and synthetic routing samples establish wiring, not equal-quality savings.
A missing/invalid Jev response or a provider error still uses the separately
logged technical fail-open route (Astra at medium); the manual kill switch and
native-quota exhaustion are operational bypasses, not Jev decisions.

This shape follows the useful parts of the surrounding router ecosystem:
TypeSafe recommends small named state fields containing only relevant evidence
and warns that irrelevant state reduces accuracy
([State](https://docs.typesafe.ai/concepts/state),
[Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).
[ReflexRoute](https://github.com/AIGNLAI/ReflexRoute) similarly supplies explicit
candidate priors plus a few retrieved task examples, while
[LiteLLM's Jev classifier](https://github.com/BerriAI/litellm/blob/main/litellm/router_strategy/complexity_router/jev_classifier.py)
uses explicit tier criteria and treats short replies using their conversation
context. By contrast, [RouteLLM](https://github.com/lm-sys/RouteLLM) is a useful
benchmarking reference but its published router path is primarily trained and
calibrated around the current user prompt. The local policy therefore keeps a
small adaptive task summary instead of either the whole thread or a blind
last-message-only view.

### Quota fallback — only while native usage is exhausted

The native model ladder is the policy **unless** the ChatGPT usage window is exhausted
(manual sentinel file, or an automatic flip on a 429 / usage-limit response,
which also retries the failed call on the tandem). While dry:

The default for every native tier is `deepseek/deepseek-v4.1-flash`.
`JEV_FALLBACK_STANDARD` and `JEV_FALLBACK_FRONTIER` may select existing configured
routes at service startup. The frontier defaults to the standard target; a
duplicate target is never retried as its own sibling.

An automatic flip lasts until the instant the edge announced for the window
reset, so the first call after the quota returns is served by the native model ladder
again; when a refusal announces no instant it falls back to a 30-minute
re-probe, and a week is the ceiling on anything a refusal claims. It is cleared
by the first successful native call, and the manual sentinel file is never
auto-cleared.

Two details keep the substitute transparent. The decided depth travels with the
call, mapped onto the Go ladder — `low` stays `low`, `medium` and `high` become
`high`, `xhigh` or above become `max` — because those models declare three rungs
where the native model ladder exposes five, and the API forwarder clamps the value once more
onto the route's own ladder. When two distinct fallback targets exist, a
retryable failure is retained until one sibling attempt completes. Otherwise
the original refusal is returned once.

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
python3 server/report_routing.py --days 7 --policy current  # current policy only
python3 server/report_routing.py --days 30 --json            # all versions, JSON
```

It prints the served model distribution (luna/terra/sol/astra, plus the Codex-dry
tandem when it took over: turns + %), the share of turns served by the cheapest
tier, the share of turns held below the confidence gate, the gates encountered,
median latency (end-to-end and Jev's own decision time), observed prompt-cache
reads by model and hashed session, and an estimate of the real cost against two
counterfactuals — every turn on `gpt-6-astra`, and every turn on `gpt-5.6-sol`.

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

Routing is phase-scoped. Jev can keep the exact route for one call, clean
continuations of the same tool, or clean tool continuations within the current
user turn. A new user turn, error, compaction, changed tool chain or expired cache
TTL ends the lease and forces a fresh decision. Provider retries inside one call
retain that call's decision. Jev sees measured per-model cache evidence:
`hot` only after a real cache read, `warming` after a successful zero-read call,
and `unknown` when usage is absent, plus read percentage, age and measured or
estimated context size. This is a cost tie-breaker, not a capability ceiling.
Jev receives only a bounded decision dossier:
active task, step type, and—when
relevant—a short assistant-intent tail, tool name, tool-output tail or image
flag. Short context-dependent asks such as `continue` also receive one bounded
active-task summary from Codex's goal envelope or the preceding meaningful user
ask. The executing model receives the caller's canonical request in full, with
only the selected model, reasoning effort, standard service tier and required
streaming flag changed. For eligible Astra Responses requests, the selected
effort is inserted as a `configuration_update` immediately before the latest
user message; this preserves the stable request-level prefix. Requests using
automatic truncation/context management, compaction items, or an incompatible
shape fall back to the request-level effort.

Context continuity is unconditional: every selected model receives the complete
canonical request, so a cache miss can increase processed input but can never
remove conversation facts. Cache controls (`prompt_cache_key` and
`prompt_cache_options`) are forwarded unchanged. GPT-5.6+ automatically caches
the stable rendered prefix separately for each model: the first arrival on a
model may be cold, while a later return can reuse that model's earlier prefix.
There is no cross-model KV-cache handoff, because those tensors belong to the
weights of the model that produced them
([OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)).
The report hashes session ids before logging them and shows actual
cache reads and writes. An optional state file
`~/.codex/codex-router/jev-router.sol-baseline.json` can assign a stable
percentage of hashed sessions to an all-Sol baseline. Mandatory-Astra decisions
still win. Use
`python3 server/report_routing.py --days 7 --policy current` to compare observed
routed and all-Sol cohorts, Jev input, leases, swaps, cache reuse and rate-card
credit estimates. The comparison is observational until both cohorts have enough
completed tasks and quality outcomes.

Each model still owns an independent cache. Returning to a previously used model
can reuse its prefix, but observed switches on 21 September 2026 reused only
about one fifth of their input as cached tokens. The affinity signal makes that
measured reprocessing cost part of Jev's next typed choice while preserving the
complete canonical replay.

## Ask surface (`POST /ask`)

The server also answers typed questions directly, for local callers that bring
their own question set. The `jev-browser-choice` skill is the first one: it
turns an in-app-browser accessibility dump into one Jev `choice` question and
acts only on the validated element index, so the page never enters the model's
context.

All POST endpoints now require `Authorization: Bearer <local Jev credential>`.
Read that credential in memory from
`~/.codex/codex-router/generic-provider-credentials/jev.key`; never paste it into
shell arguments, logs or a URL. Existing `/ask` callers must add this header.
Browser-origin requests are rejected. Direct TypeSafe clients are unaffected.

Provision the local credential using the embedded router's protected credential
transaction, without entering or displaying it:

```sh
node server/configure-auth.mjs
```

Do this after registering the `jev` provider and before restarting Jev. Missing
credentials fail closed (503); invalid credentials return 401. The health and
model-list GET endpoints remain public on loopback.

Validation is the whole contract: a JSON-serialisable `state` under 120k chars,
at most 40 questions, each a `noul`, `choice` or `score` with its instructions
and criteria. The caller's state is never logged. `502` surfaces an upstream Jev
failure — `402` means the TypeSafe account is out of credits — and `503` means
no key is configured.

## Repository layout

```
install.sh       One-command installer for the complete stack
bin/             Unified Jev/router CLI
router/          Embedded Codex Router fork and its own tests
server/          Jev policy, relay, service, reports and tests
poc/             Tiering POC, shadow replay and backtest tooling
hook/            Explored callback alternative, kept for reference
ROUTER_FORK.md   Fork provenance and ownership boundary
AGENTS.md        Autonomous install and operations playbook
```

## Quickstart

Prerequisites: macOS with Codex desktop, Node.js 22.19+, Python 3.11+, and a
TypeSafe API key for Jev. No separate Codex Router checkout is needed.

**1. Give the server your TypeSafe key** — either
`export TYPESAFE_API_KEY=...` in the service environment, or:

```bash
echo 'TYPESAFE_API_KEY=your-key' >> ~/.hermes/.env   # default env file
```

**2. Install the complete stack from this checkout** in your Terminal:

```bash
./install.sh
```

The installer uses `router/` as the service source, preserves configured
providers, idempotently adds `jev/auto`, provisions the protected loopback
credential, enables native ChatGPT sharing, installs both launchd services, and
runs `server/smoke.py`. It never clones or updates another repository.

**3. Quit and reopen Codex**, then pick **“Jev Codex Router”** in the model picker.
Check the transport as well as the picker: `jev/auto` must reach the local
router, not OpenAI's native endpoint. A catalog entry or a
`[model_providers.jev]` declaration alone does not select that transport.
See [transport troubleshooting](server/INSTALL.md#model-visible-but-rejected-by-chatgpt)
if Codex reports that `jev/auto` is unsupported with a ChatGPT account.

For dependency preparation without touching services or local state:

```bash
./install.sh --prepare-only
```

The unified CLI exposes the embedded runtime without changing directory:

```bash
bin/jev-codex-router router status
bin/jev-codex-router update
bin/jev-codex-router smoke
bin/jev-codex-router report --days 7
```

## Operations

Requests are capped at 64 MiB for Responses and 256 KiB for `/ask`, with a
15-second body-read deadline and at most 32 simultaneous connections. Large
canonical requests are rejected explicitly rather than silently truncated.
Logs are created as `0600`, rotate at 8 MiB, and keep one backup per file.
New debug captures contain only shapes/counters, not prompts or raw output.
Existing historical captures are protected but not erased automatically.
Display signatures are disabled for JSON-constrained responses.

Validation from the Jev checkout:

```sh
python3 -m unittest discover -s server -p 'test_*.py'
(cd router && npm run check && npm test)
python3 poc/eval_routing.py            # offline fixture/dossier validation
python3 poc/eval_routing.py --live     # optional paid Jev-only calibration
python3 server/smoke.py               # small end-to-end model call; checks running policy
```

Replay tools share the live dossier builder but remain user-turn simulations,
not a reconstruction of every internal model call or a quality-equivalent
savings benchmark. Short confirmations are retained; mixed-model turns without
per-call attribution are excluded from the historical cost baseline.

| Action | Command |
|---|---|
| Watch decisions | `tail -f ~/.codex/codex-router/jev-router-live.jsonl` |
| See the picked model in the thread | every reasoning summary part carries the routed tag, separators on both sides: ` · 🧠sol:low · ` — one glyph per route: ⚡ luna (economical) · 🧠 sol (workhorse) · 🚀 astra (frontier) · 🌍 terra; 🐳 deepseek / ✨ glm while the Codex-dry tandem is serving |
| Show the model and thinking above every assistant message | `touch ~/.codex/codex-router/jev-router.signature` — a leading `**🧠 sol · thinking: high**` appears from the first text fragment, including commentary and unphased replies; remove the file to disable |
| Shadow mode (decide + log, serve astra) | `touch ~/.codex/codex-router/jev-router.shadow` |
| 10% stable all-Sol measurement cohort | create `~/.codex/codex-router/jev-router.sol-baseline.json` with `{"percent":10,"until":"<ISO-8601>"}`; remove it to stop |
| Debug counters (no raw content) | `touch ~/.codex/codex-router/jev-router.debug` |
| Kill switch (no Jev → frontier) | `touch ~/.codex/codex-router/jev-router.off` (delete the file to re-enable) |
| Force the Codex-dry tandem | `touch ~/.codex/codex-router/jev-router.codex-dry` (delete the file to return to luna/terra/sol/astra) |
| Inspect the dry auto state | `cat ~/.codex/codex-router/jev-router.codex-dry.json` (reason + expiry; auto-cleared by the next successful native call) |
| Update the complete monorepo | `bin/jev-codex-router update` |
| Hide the model | `router/bin/control picker set jev/auto hide` |
| Disable the provider | `bin/jev-codex-router router providers generic disable jev` |
| Revoke native sharing | `bin/jev-codex-router router chatgpt-session disable` |
| Service status | `launchctl print gui/$(id -u)/com.thibaultsaintjean.jev-router` |

`bin/jev-codex-router update` fetches this repository's `origin/main`, updates
the complete checkout, then runs the root installer. It never updates the
embedded fork from a separate upstream checkout.

**After an update**, verify nothing was lost:

```bash
bin/jev-codex-router router providers generic list  # shows: SHOW jev
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

Early, but running in production on the author's setup. The split routing policy
needs outcome calibration on real usage; the local decision and attempt logs
provide observations, not quality labels.

## License

MIT
