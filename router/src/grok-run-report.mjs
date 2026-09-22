import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sanitizeGrokStructuredPatch } from './request-diagnostics.mjs';

const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : count(value);
const total = (rows, key) => {
  const values = rows.map((row) => count(row[key]));
  return { value: values.some((v) => v !== undefined) ? values.reduce((sum, v) => sum + (v ?? 0), 0) : null,
    reported: values.filter((v) => v !== undefined).length, missing: values.filter((v) => v === undefined).length };
};
const completeValue = (aggregate) => aggregate.missing === 0 ? aggregate.value : null;
function testCommand(command) {
  if (typeof command !== 'string') return false;
  // Recognize direct commands conservatively, not filenames or quoted examples.
  // This is not a shell interpreter: heredocs and indirect wrappers are omitted.
  const source = command.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|#[^\r\n]*/gu, ' ');
  if (source.includes('<<')) return false;
  return /(?:^|&&|\|\||;|\n)\s*(?:(?:[^\s;|&]+\/)?(?:vitest|jest)(?=\s|$)|npm\s+(?:run\s+)?test(?=\s|:|$)|npx\s+(?:vitest|jest)(?=\s|$)|node\s+--test(?=\s|$))/u.test(source);
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);

function unionMs(intervals) {
  const merged = [];
  for (const [a, b] of intervals.filter(([a, b]) => a !== undefined && b >= a).sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  return merged.reduce((sum, [a, b]) => sum + b - a, 0);
}

function structuredPatchCounts(usage) {
  let reported = 0, enabled = 0, applied = 0, clientHook = 0;
  for (const row of usage) {
    const patch = sanitizeGrokStructuredPatch(row.grokStructuredPatch);
    if (!patch) continue;
    reported++;
    if (patch.enabled) enabled++;
    if (patch.applied) applied++;
    if (patch.mode === 'client_hook') clientHook++;
  }
  return {
    unit: 'usage_records', total: usage.length, reported, missing: usage.length - reported,
    enabled, applied, clientHook,
  };
}

// Explicit projection only: never copy prompts, tool arguments/results, reasoning,
// session titles, signatures, or arbitrary provider fields into an exported report.
export function buildGrokRunReport({ usageEvents = [], activityEvents = [], codexEvents = [],
  grokEvents = [], grokLog = [], grokSessionEvents = [], threadId, sessionId, startedAt, endedAt, outcome } = {}) {
  const start = timestamp(startedAt);
  const end = timestamp(endedAt);
  const within = (at) => {
    const t = timestamp(at);
    return t !== undefined && (start === undefined || t >= start) && (end === undefined || t <= end);
  };
  const activity = new Map();
  for (const snapshot of activityEvents) {
    for (const row of [...(snapshot.active ?? []), ...(snapshot.recent ?? [])]) {
      if (!threadId || row.threadId !== threadId || !within(row.startedAt) || typeof row.requestId !== 'string') continue;
      activity.set(row.requestId, row);
    }
  }
  const requests = [...activity.values()];
  const settled = requests.filter((row) => count(row.endedAt) !== undefined);
  // One client request may meter multiple charged provider attempts. Never
  // collapse those records merely because their requestId matches.
  const usage = usageEvents.filter((row) => typeof row.requestId === 'string' && activity.has(row.requestId));
  const nativeCounts = [];
  const toolCalls = new Map();
  const toolIntervals = [];
  let toolCount = 0, toolFailures = 0, patchFailures = 0, firstTestAt;
  let inferredOutcome = 'running';
  for (const event of codexEvents) {
    if (!within(event.timestamp)) continue;
    const p = event.payload ?? {};
    if (event.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage) {
      const n = p.info.last_token_usage;
      nativeCounts.push({ inputTokens: n.input_tokens, cachedInputTokens: n.cached_input_tokens,
        outputTokens: n.output_tokens, reasoningTokens: n.reasoning_output_tokens });
    }
    if (event.type === 'event_msg' && ['task_complete', 'task_completed'].includes(p.type)) inferredOutcome = 'completed';
    if (event.type === 'event_msg' && p.type === 'turn_aborted') inferredOutcome = 'cancelled';
    if (event.type !== 'response_item') continue;
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      let command;
      try { command = JSON.parse(p.arguments ?? '{}').cmd; } catch { /* only inspect valid command envelopes */ }
      toolCalls.set(p.call_id, { at: timestamp(event.timestamp), patch: p.name === 'apply_patch' });
      toolCount++;
      if (typeof command === 'string' && testCommand(command)) firstTestAt ??= timestamp(event.timestamp);
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && toolCalls.has(p.call_id)) {
      const call = toolCalls.get(p.call_id);
      toolCalls.delete(p.call_id);
      toolIntervals.push([call.at, timestamp(event.timestamp)]);
      const output = typeof p.output === 'string' ? p.output : '';
      const failedPatch = call.patch && /(?:verification failed|invalid patch)/iu.test(output);
      if (failedPatch) patchFailures++;
      if (failedPatch || /(?:Process exited with code|Exit code:)\s*[1-9]\d*/u.test(output)) toolFailures++;
    }
  }
  const cliRequestRows = grokLog.filter((row) => sessionId && row.sid === sessionId && within(row.ts) && row.msg === 'shell.turn.inference_done');
  const cliRequests = cliRequestRows.map((row) => row.ctx ?? {});
  const cliUsage = grokEvents.filter((row) => row.type === 'usage').map((row) => ({
    // CLI usage uses the Messages convention: input_tokens excludes cache.
    inputTokens: count(row.usage?.input_tokens) === undefined ? undefined : row.usage.input_tokens + (count(row.usage?.cache_read_input_tokens) ?? 0) + (count(row.usage?.cache_creation_input_tokens) ?? 0),
    cachedInputTokens: row.usage?.cache_read_input_tokens,
    outputTokens: row.usage?.output_tokens, reasoningTokens: row.usage?.reasoning_tokens,
  }));
  const cliEnd = grokEvents.findLast((row) => row.type === 'end');
  if (cliEnd) inferredOutcome = cliEnd.stopReason === 'end_turn' ? 'completed' : cliEnd.stopReason === 'cancelled' ? 'cancelled' : 'failed';
  const cliToolIds = new Set();
  const cliTestIds = new Set();
  const cliToolFailures = new Set();
  for (const row of grokEvents) {
    if (row.type === 'tool_call' && typeof row.toolCallId === 'string') {
      cliToolIds.add(row.toolCallId);
      if (testCommand(row.rawInput?.command)) cliTestIds.add(row.toolCallId);
    }
    if (row.type === 'tool_call_update' && typeof row.toolCallId === 'string') {
      const result = row.rawOutput;
      const shellFailed = row.status === 'completed' && result?.type === 'Bash' &&
        (Number.isInteger(result.exit_code) && result.exit_code !== 0 || result.timed_out === true ||
          typeof result.signal === 'string' && result.signal.length > 0);
      if (row.status === 'failed' || shellFailed) cliToolFailures.add(row.toolCallId);
    }
  }
  for (const row of grokSessionEvents) {
    if (!within(row.ts) || row.type !== 'tool_completed') continue;
    const finish = timestamp(row.ts), duration = count(row.duration_ms);
    if (finish !== undefined && duration !== undefined) {
      toolIntervals.push([finish - duration, finish]);
      if (cliTestIds.has(row.tool_call_id)) firstTestAt = Math.min(firstTestAt ?? Infinity, finish - duration);
    }
  }
  const cli = grokEvents.length > 0 || cliRequests.length > 0;
  const usageIds = new Set(usage.map((row) => row.requestId));
  const routerCountsComplete = settled.length > 0 && usageIds.size === settled.length &&
    settled.every((row) => usageIds.has(row.requestId)) && usage.every((row) => count(row.outputTokens) !== undefined);
  // A collapsed progress-only retry keeps the selected attempt in the ordinary
  // fields and the spend of both attempts in the billed fields.
  const billedUsage = usage.map((row) => ({ ...row,
    inputTokens: count(row.billedInputTokens) ?? row.inputTokens,
    outputTokens: count(row.billedOutputTokens) ?? row.outputTokens }));
  const counts = cli ? cliUsage : routerCountsComplete ? billedUsage : nativeCounts.length ? nativeCounts : billedUsage;
  const tokens = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'].map((key) => [key, total(counts, key)]));
  const durations = cli ? cliRequests.map((row) => count(row.model_elapsed_ms)).filter((v) => v !== undefined)
    : settled.map((row) => row.endedAt - row.startedAt).filter((v) => v >= 0);
  const requestMs = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
  const requestIntervals = cli ? cliRequestRows.flatMap((row) => {
    const duration = count(row.ctx?.model_elapsed_ms), finish = timestamp(row.ts);
    return duration === undefined ? [] : [[finish - duration, finish]];
  }) : settled.map((row) => [row.startedAt, row.endedAt]);
  const elapsedMs = start !== undefined && end !== undefined && end >= start ? end - start : null;
  const observedIntervals = [...requestIntervals, ...toolIntervals].map(([a, b]) => [Math.max(start ?? a, a), Math.min(end ?? b, b)]);
  const outputTokens = completeValue(tokens.outputTokens);
  const bytes = usage.filter((row) => row.contextBytes?.observationPoint === 'router_ingress').map((row) => {
    const result = { observationPoint: 'router_ingress' };
    for (const key of ['instructionsBytes', 'toolsBytes', 'historyBytes']) if (count(row.contextBytes[key]) !== undefined) result[key] = row.contextBytes[key];
    return result;
  });
  return {
    version: 1, harness: cli ? 'grok-cli' : 'codex', outcome: terminal.has(outcome) ? outcome : inferredOutcome,
    elapsedMs,
    unobservedMs: elapsedMs !== null && requestIntervals.length ? Math.max(0, elapsedMs - unionMs(observedIntervals)) : null,
    requests: { completed: durations.length, active: cli ? (cliEnd ? 0 : null) : requests.length - settled.length,
      durationMs: requestMs, correlation: usage.length ? 'request_id' : 'unavailable',
      correlatedUsageRecords: usage.length, statuses: settled.reduce((all, row) => { const key = Number.isInteger(row.status) ? String(row.status) : 'unknown'; all[key] = (all[key] ?? 0) + 1; return all; }, {}) },
    tokens, tokenSource: cli ? 'grok_usage_events' : routerCountsComplete ? 'router_usage' : nativeCounts.length ? 'codex_usage_events' : 'router_usage',
    outputTokensPerRequestSecond: requestMs > 0 && outputTokens !== null &&
      (routerCountsComplete && !cli || durations.length === counts.length) ? outputTokens / (requestMs / 1000) : null,
    // Timing is not interchangeable with reasoning-inclusive token counts. Do not
    // subtract text TTFT and present that quotient as decoding throughput.
    firstTokenMs: cli ? total(cliRequests, 'ttft_ms') : total(usage, 'firstTokenMs'),
    tools: { calls: cli ? cliToolIds.size : toolCount, failures: cli ? cliToolFailures.size : toolFailures,
      patchFailures: cli ? null : patchFailures, durationMs: toolIntervals.length ? unionMs(toolIntervals) : null,
      firstTestAfterMs: start !== undefined && firstTestAt !== undefined ? firstTestAt - start : null },
    contextBytes: { unit: 'utf8_json_bytes', first: bytes[0] ?? null, last: bytes.at(-1) ?? null },
    // Counts already-correlated usage records only. Never copy metadata, request IDs, or prompt/code.
    structuredPatch: cli ? null : structuredPatchCounts(usage),
    limitations: ['Completion is the worker status; test success and independent review must be recorded separately.',
      'Byte sizes are not token estimates. Partial or unmatched counters do not establish throughput.',
      'Unobserved time includes scheduling and uninstrumented work; it is not proven provider waiting time.',
      'Input totals include cache reads and writes; reasoning counts are never inferred from text or durations.',
      'Grok event inputs must contain one invocation; timestamped inputs are filtered to the selected run.'],
  };
}

export async function readJsonLines(file) {
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  const rows = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw new Error('Invalid JSONL record.');
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected a JSONL object.');
    rows.push(row);
  }
  return rows;
}

async function main(args) {
  if (args.includes('--help')) {
    process.stdout.write('Usage: node src/grok-run-report.mjs --codex-rollout FILE --activity FILE --usage FILE --thread-id ID --started-at ISO --ended-at ISO [--out FILE]\nGrok: --grok-events FILE --grok-log FILE --grok-session-events FILE --session-id ID\nOptional: --outcome completed|failed|cancelled|timeout. Inputs are local JSONL; output contains metrics only.\n');
    return;
  }
  const allowed = new Set(['usage', 'activity', 'codex-rollout', 'grok-events', 'grok-log', 'grok-session-events', 'thread-id', 'session-id', 'started-at', 'ended-at', 'out', 'outcome']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/u, '');
    if (!args[i]?.startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid report arguments. Use --help.');
    options[key] = args[i + 1];
  }
  if (!options['codex-rollout'] && !options['grok-events']) throw new Error('A run event input is required.');
  for (const key of ['started-at', 'ended-at']) if (options[key] && timestamp(options[key]) === undefined) throw new Error('Invalid run timestamp.');
  if (options.outcome && !terminal.has(options.outcome)) throw new Error('Invalid terminal outcome.');
  const [usageEvents, activityEvents, codexEvents, grokEvents, grokLog, grokSessionEvents] = await Promise.all(
    ['usage', 'activity', 'codex-rollout', 'grok-events', 'grok-log', 'grok-session-events'].map((key) => readJsonLines(options[key])));
  const report = buildGrokRunReport({ usageEvents, activityEvents, codexEvents, grokEvents, grokLog, grokSessionEvents,
    threadId: options['thread-id'], sessionId: options['session-id'], startedAt: options['started-at'], endedAt: options['ended-at'], outcome: options.outcome });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(options.out, output, { mode: 0o600 });
  else process.stdout.write(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('Could not create run report. Check arguments and readable JSONL inputs; use --help.\n'); process.exitCode = 1; });
}
