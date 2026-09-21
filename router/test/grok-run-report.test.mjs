import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGrokRunReport, readJsonLines } from '../src/grok-run-report.mjs';

const at = (s) => new Date(Date.UTC(2026, 8, 9) + s * 1000).toISOString();
const event = (s, type, payload) => ({ timestamp: at(s), type, payload });
const usage = (input, output, reasoning) => ({ type: 'token_count', info: { last_token_usage: {
  input_tokens: input, output_tokens: output, ...(reasoning === undefined ? {} : { reasoning_output_tokens: reasoning }),
} } });

test('joins only exact request IDs; token rate includes complete request time', () => {
  const a = { requestId: 'instance:1', threadId: 'worker', startedAt: Date.parse(at(0)), endedAt: Date.parse(at(10)), status: 200 };
  const report = buildGrokRunReport({ startedAt: at(0), endedAt: at(12), threadId: 'worker',
    activityEvents: [{ active: [a], recent: [] }, { active: [], recent: [a] }],
    usageEvents: [{ requestId: 'instance:1', firstTokenMs: 9000 }, { requestId: 'foreign', outputTokens: 999999 }],
    codexEvents: [event(10, 'event_msg', usage(200, 100, 90))] });
  assert.equal(report.requests.completed, 1);
  assert.equal(report.requests.correlatedUsageRecords, 1);
  assert.equal(report.outputTokensPerRequestSecond, 10);
  assert.equal(report.firstTokenMs.value, 9000);
  assert.equal(report.tokens.reasoningTokens.value, 90);
});

test('missing reasoning stays missing while explicit zero is counted', () => {
  const report = buildGrokRunReport({ codexEvents: [event(1, 'event_msg', usage(20, 3)), event(2, 'event_msg', usage(30, 4, 0))] });
  assert.deepEqual(report.tokens.reasoningTokens, { value: 0, reported: 1, missing: 1 });
  assert.equal(report.requests.correlation, 'unavailable');
  assert.equal(report.outputTokensPerRequestSecond, null);
});

test('first test timing ignores filenames, quoted examples and shell comments', () => {
  const reads = [
    'cat frontend/vitest.config.ts',
    'rg vitest package.json',
    'echo "vitest run; npm test"',
    "printf '%s\\n' 'jest run'",
    'cat package.json # ; npm test',
    'node -e "console.log(\'vitest run\')"',
    "cat <<'EOF'\nvitest run\nEOF",
  ];
  const commands = [...reads, 'cd frontend && ./node_modules/.bin/vitest run src/example.spec.ts'];
  const report = buildGrokRunReport({ startedAt: at(0), codexEvents: commands.map((cmd, i) =>
    event(i + 1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: String(i), arguments: JSON.stringify({ cmd }) })) });
  assert.equal(report.tools.firstTestAfterMs, commands.length * 1000);
  for (const cmd of ['npm test', 'npm run test:unit', 'npx vitest run', 'node --test test/example.mjs', 'jest', 'cd frontend\n./node_modules/.bin/vitest run']) {
    const direct = buildGrokRunReport({ startedAt: at(0), codexEvents: [event(2, 'response_item', {
      type: 'function_call', name: 'exec_command', call_id: 'test', arguments: JSON.stringify({ cmd }),
    })] });
    assert.equal(direct.tools.firstTestAfterMs, 2000, cmd);
  }
});

test('measures overlapping tool intervals once and counts patch failure without exporting text', () => {
  const secret = 'PRIVATE_USER_CONTENT_CANARY';
  const report = buildGrokRunReport({ startedAt: at(0), endedAt: at(10), codexEvents: [
    event(1, 'response_item', { type: 'function_call', call_id: 'test', name: 'exec_command', arguments: JSON.stringify({ cmd: `vitest run ${secret}` }) }),
    event(2, 'response_item', { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: secret }),
    event(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'patch', output: `apply_patch verification failed: ${secret}` }),
    event(4, 'response_item', { type: 'function_call_output', call_id: 'test', output: `Process exited with code 1\n${secret}` }),
    event(5, 'response_item', { type: 'reasoning', text: secret }),
    event(6, 'event_msg', { type: 'task_complete', last_agent_message: secret }),
  ] });
  assert.deepEqual(report.tools, { calls: 2, failures: 2, patchFailures: 1, durationMs: 3000, firstTestAfterMs: 1000 });
  assert.equal(report.outcome, 'completed');
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('separates invocation timings and byte metadata without admitting arbitrary content', () => {
  const report = buildGrokRunReport({ threadId: 'worker', startedAt: at(5), endedAt: at(15),
    activityEvents: [{ recent: [
      { requestId: 'old', threadId: 'worker', startedAt: Date.parse(at(1)), endedAt: Date.parse(at(4)) },
      { requestId: 'new', threadId: 'worker', startedAt: Date.parse(at(6)), endedAt: Date.parse(at(8)), status: 'SECRET' },
    ] }], usageEvents: [{ requestId: 'new', contextBytes: { observationPoint: 'router_ingress', instructionsBytes: 0, toolsBytes: 24, historyBytes: 99, secret: 'SECRET' } }] });
  assert.equal(report.requests.completed, 1);
  assert.deepEqual(report.requests.statuses, { unknown: 1 });
  assert.equal(report.contextBytes.unit, 'utf8_json_bytes');
  assert.equal(report.contextBytes.first.instructionsBytes, 0);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
});

test('Grok completion is not a test-success claim and cancelled runs stay cancelled', () => {
  const report = buildGrokRunReport({ sessionId: 'cli', startedAt: at(0), endedAt: at(10),
    grokEvents: [{ type: 'usage', usage: { output_tokens: 100, reasoning_tokens: 80 }, signature: 'SECRET' },
      { type: 'thought', data: 'SECRET' }, { type: 'tool_call', toolCallId: 't', rawInput: { command: 'vitest run' } },
      { type: 'end', stopReason: 'cancelled', usage: { output_tokens: 100 } }],
    grokLog: [{ sid: 'cli', ts: at(9), msg: 'shell.turn.inference_done', ctx: { model_elapsed_ms: 9000, ttft_ms: 8000 } },
      { sid: 'other', ts: at(9), msg: 'shell.turn.inference_done', ctx: { model_elapsed_ms: 999999 } }],
    grokSessionEvents: [{ ts: at(10), type: 'tool_completed', duration_ms: 1000, tool_call_id: 't' }] });
  assert.equal(report.outcome, 'cancelled');
  assert.equal(report.tokens.outputTokens.value, 100);
  assert.equal(report.outputTokensPerRequestSecond, 100 / 9);
  assert.equal(report.tools.firstTestAfterMs, 9000);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
});

test('partial usage coverage cannot produce an inflated throughput', () => {
  const report = buildGrokRunReport({ sessionId: 'cli', startedAt: at(0), endedAt: at(10),
    grokEvents: [{ type: 'usage', usage: { output_tokens: 100 } }],
    grokLog: [1, 2].map((s) => ({ sid: 'cli', ts: at(s), msg: 'shell.turn.inference_done', ctx: { model_elapsed_ms: 1000 } })) });
  assert.equal(report.outputTokensPerRequestSecond, null);
  assert.equal(report.outcome, 'running');
});

test('CLI counts terminal shell failures once even when the tool completed', () => {
  const report = buildGrokRunReport({ grokEvents: [
    { type: 'tool_call_update', toolCallId: 'bash', status: 'in_progress', rawOutput: { type: 'Bash', exit_code: 1 } },
    { type: 'tool_call_update', toolCallId: 'bash', status: 'completed', rawOutput: { type: 'Bash', exit_code: 127, command: 'PRIVATE', output_for_prompt: 'PRIVATE' } },
    { type: 'tool_call_update', toolCallId: 'bash', status: 'completed', rawOutput: { type: 'Bash', exit_code: 127 } },
    { type: 'tool_call_update', toolCallId: 'timeout', status: 'completed', rawOutput: { type: 'Bash', exit_code: 0, timed_out: true } },
    { type: 'tool_call_update', toolCallId: 'signal', status: 'completed', rawOutput: { type: 'Bash', exit_code: 0, signal: 'SIGTERM' } },
    { type: 'tool_call_update', toolCallId: 'tool', status: 'failed' },
    { type: 'tool_call_update', toolCallId: 'tool', status: 'failed' },
    { type: 'tool_call_update', toolCallId: 'success', status: 'completed', rawOutput: { type: 'Bash', exit_code: 0 } },
    { type: 'tool_call_update', toolCallId: 'unknown', status: 'completed', rawOutput: { type: 'Bash', exit_code: '1' } },
  ] });
  assert.equal(report.tools.failures, 4);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('CLI input totals include separately reported cached tokens', () => {
  const report = buildGrokRunReport({ grokEvents: [{ type: 'usage', usage: {
    input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 7,
  } }] });
  assert.equal(report.tokens.inputTokens.value, 95);
  assert.equal(report.tokens.cachedInputTokens.value, 80);
  assert.equal(report.tokens.reasoningTokens.value, null);
});

test('collapsed retry rows count billed spend, not only the selected attempt', () => {
  const row = { requestId: 'r1', inputTokens: 100, outputTokens: 10, billedInputTokens: 190, billedOutputTokens: 25 };
  const plain = { requestId: 'r2', inputTokens: 40, outputTokens: 5 };
  const report = buildGrokRunReport({ threadId: 'worker', startedAt: at(0), endedAt: at(20),
    activityEvents: [{ recent: [
      { requestId: 'r1', threadId: 'worker', startedAt: Date.parse(at(1)), endedAt: Date.parse(at(5)) },
      { requestId: 'r2', threadId: 'worker', startedAt: Date.parse(at(6)), endedAt: Date.parse(at(11)) },
    ] }],
    usageEvents: [row, plain] });
  assert.equal(report.tokenSource, 'router_usage');
  assert.equal(report.tokens.inputTokens.value, 230);
  assert.equal(report.tokens.outputTokens.value, 30);
  assert.equal(report.outputTokensPerRequestSecond, 30 / 9);
});

test('authoritative usage wins over client counters and retains multiple charged attempts', () => {
  const row = { requestId: 'r1', inputTokens: 20, outputTokens: 30 };
  const report = buildGrokRunReport({ threadId: 'worker', startedAt: at(0), endedAt: at(10),
    activityEvents: [{ recent: [{ requestId: 'r1', threadId: 'worker', startedAt: Date.parse(at(1)), endedAt: Date.parse(at(5)) }] }],
    usageEvents: [row, row], codexEvents: [event(5, 'event_msg', usage(20, 30, 0))] });
  assert.equal(report.requests.correlatedUsageRecords, 2);
  assert.equal(report.tokens.outputTokens.value, 60);
  assert.equal(report.tokens.reasoningTokens.value, null);
  assert.equal(report.tokenSource, 'router_usage');
  assert.equal(report.unobservedMs, 6000);
  assert.equal(report.outputTokensPerRequestSecond, 15);
});

test('JSONL rejects corrupt completed records while allowing an unfinished tail', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'router-report-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  await writeFile(file, '{"type":"usage"}\n{"partial":');
  assert.deepEqual(await readJsonLines(file), [{ type: 'usage' }]);
  for (const invalid of ['not-json\n{}\n', 'null\n', '[]\n', '{"partial":\n']) {
    await writeFile(file, invalid);
    await assert.rejects(readJsonLines(file), /JSONL/u);
  }
});

test('CLI exports metrics without input contents and creates an owner-only report', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'router-report-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl'), out = join(dir, 'report.json');
  const script = fileURLToPath(new URL('../src/grok-run-report.mjs', import.meta.url));
  await writeFile(file, `${JSON.stringify(event(2, 'event_msg', { type: 'task_complete', last_agent_message: 'CANARY_PRIVATE_TEXT' }))}\n`);
  const result = spawnSync(process.execPath, [script, '--codex-rollout', file, '--started-at', at(0), '--ended-at', at(3), '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(out, 'utf8');
  assert.ok(!text.includes('CANARY'));
  assert.equal(JSON.parse(text).outcome, 'completed');
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  const invalid = spawnSync(process.execPath, [script, '--codex-rollout', join(dir, 'CANARY_MISSING')], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes('CANARY'));
});

const activity = (requestId, threadId = 'worker') => ({
  requestId, threadId, startedAt: Date.parse(at(1)), endedAt: Date.parse(at(5)),
});

test('structuredPatch counts correlated usage records, not unique request IDs', () => {
  const secret = 'PRIVATE_STRUCTURED_PATCH_CANARY';
  const report = buildGrokRunReport({ threadId: 'worker', startedAt: at(0), endedAt: at(10),
    activityEvents: [{ recent: [activity('r1'), activity('other', 'foreign')] }],
    usageEvents: [
      { requestId: 'r1', grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1 } },
      { requestId: 'r1', grokStructuredPatch: { enabled: true, applied: false, schemaVersion: 1, mode: 'client_hook' } },
      { requestId: 'r1', grokStructuredPatch: { enabled: false, applied: false, schemaVersion: 1 } },
      { requestId: 'r1' },
      { requestId: 'r1', grokStructuredPatch: { enabled: false, applied: true, schemaVersion: 1 } },
      { requestId: 'r1', grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1, mode: 'private prompt' } },
      { requestId: 'r1', grokStructuredPatch: {
        enabled: true, applied: true, schemaVersion: 1, prompt: secret, command: secret, path: secret, requestId: 'r1',
      } },
      { requestId: 'unmatched', grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1, mode: 'client_hook' } },
      { requestId: 'other', grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1 } },
    ] });
  assert.deepEqual(report.structuredPatch, {
    unit: 'usage_records', total: 7, reported: 4, missing: 3, enabled: 3, applied: 2, clientHook: 1,
  });
  assert.equal(report.requests.correlatedUsageRecords, 7);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report.structuredPatch).includes('r1'));
});

test('Grok CLI reports no Router structuredPatch evidence', () => {
  const report = buildGrokRunReport({ sessionId: 'cli', threadId: 'worker', startedAt: at(0), endedAt: at(10),
    grokEvents: [{ type: 'usage', usage: { output_tokens: 4 } }],
    activityEvents: [{ recent: [activity('r1')] }],
    usageEvents: [{ requestId: 'r1', grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1, mode: 'client_hook' } }],
  });
  assert.equal(report.harness, 'grok-cli');
  assert.equal(report.requests.correlatedUsageRecords, 1);
  assert.equal(report.structuredPatch, null);
});
