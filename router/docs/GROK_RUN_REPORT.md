# Local Grok run reports

`src/grok-run-report.mjs` creates a metrics-only JSON report from existing local
event files. It makes no network requests and does not change model behavior.
Keep source logs private: they may contain prompts, tool contents and credentials.
The exported report explicitly projects counters and timings; it never copies
prompts, instructions, tool arguments or results, session titles or reasoning text.

For Codex, collect `/activity` snapshots throughout the run using the authenticated
local control interface, save those JSON objects as JSONL, and retain the run's
rollout and Router usage events. Activity is bounded in memory: a snapshot only
after a long run can miss early requests.

```sh
node src/grok-run-report.mjs \
  --codex-rollout generated/run/rollout.jsonl \
  --activity generated/run/activity.jsonl \
  --usage generated/run/usage-events.jsonl \
  --thread-id WORKER_THREAD_ID \
  --started-at 2026-09-09T09:00:00Z \
  --ended-at 2026-09-09T09:10:00Z \
  --out generated/run/report.json
```

Usage joins activity by exact `requestId`. Old records remain usable, but cannot
be correlated by guessing from timestamps or token totals. Complete correlated
Router counters take priority; otherwise the report can use Codex usage events.
Missing reasoning counters stay missing, and explicitly reported zero stays zero.

For Grok CLI, supply one invocation's `--output-format streaming-json` output,
the local unified log, and the session events. Select its session ID and exact
time window; logs from other sessions are excluded.

```sh
node src/grok-run-report.mjs \
  --grok-events generated/run/cli-events.jsonl \
  --grok-log generated/run/unified.jsonl \
  --grok-session-events generated/run/session-events.jsonl \
  --session-id GROK_SESSION_ID \
  --started-at 2026-09-09T09:00:00Z \
  --ended-at 2026-09-09T09:10:00Z \
  --outcome completed \
  --out generated/run/report.json
```

The output parent directory must already exist. New output files use mode 0600
on POSIX. A terminal outcome can be `completed`, `failed`, `cancelled` or
`timeout`; a quiet stream alone does not justify a terminal outcome. Malformed
complete JSONL records fail the report; an incomplete final line is ignored so
live files can be inspected. Prefer complete files for final comparisons.

Interpretation:

- Token fields include `reported` and `missing` coverage. Input totals include
  cache reads and writes for both harnesses. Reasoning is part of output tokens,
  not an extra amount to add to the output total.
- Router token totals use a usage row's billed counters when present. A Grok
  progress-only retry keeps the selected attempt in `inputTokens` and
  `outputTokens` and the spend of both attempts in `billedInputTokens` and
  `billedOutputTokens`; the report counts the spend.
- Request throughput divides output tokens by full request duration only when
  request/count coverage matches. It is not a decoding-speed estimate. Text
  time-to-first-token is never subtracted from reasoning-inclusive token timing.
- Tool duration is the union of observed tool intervals, avoiding double counting
  parallel tools. `firstTestAfterMs` recognizes `npm test`, `npm run test`,
  `vitest`, `jest`, `npx vitest`, `npx jest`, and `node --test` in direct
  command positions of a Codex tool call's `cmd`. This measures the first
  attempt, which may fail before the test runner starts. Quoted examples,
  filenames and comments do not count; heredocs and indirect wrapper scripts are
  omitted, and so are single-`|` pipelines, environment prefixes such as
  `CI=1 npm test`, `pnpm`/`yarn`, `timeout` wrappers, and tools that carry the
  command in a `command` field instead of `cmd`.
- CLI tool failures include terminal shell exit codes, signals and timeouts,
  even when the surrounding tool reports `completed`. Repeated updates for one
  tool call are counted once; interim shell output is not a terminal result.
- `unobservedMs` is wall time outside observed requests/tools, including scheduling
  and uninstrumented work. It cannot establish a specific cause of delay.
- `contextBytes` separates UTF-8 JSON sizes of Router ingress instructions, tool
  definitions and input history. These are bytes, not exact token counts.
- Worker completion does not prove code correctness. Record external test exit
  statuses, independent review, source SHA, environment, deadline and any
  interruption separately. Keep failed and interrupted runs in comparisons.

This report does not instrument arbitrary tool wrappers or capture internal
reasoning. Grok CLI events must come from a single invocation; concatenating
multiple resumed invocations would defeat the timestamp-free usage boundary.
