// Overload unit 4 (MCP presentation and recovery guidance): the overload design §B and
// response-loop watchdog design's "MCP presentation" sections are the spec.
//
// Covers: isError for a single-turn failed/timeout result (and the pre-existing kind:"error"
// envelope), NOT for completed-with-warnings/cancelled/running/waiting_for_approval; a batch
// envelope stays non-error with per-item failure info intact; the new TurnResult fields (finish,
// warnings, resendSafety, upstreamRetry, upstreamRead, responseLoop, error.statusCode/retryable/
// retryAfterSeconds/condition) appear in structuredContent at standard and compact detail levels
// and validate against outputSchema; every upstream-derived string is bounded and stripped of
// control characters; the OPENCODE_OVERLOADED hint with and without retryAfterSeconds/a session
// id; the UnknownError "JSON parsing failed:" sanitization never leaks the embedded chunk; and
// SERVER_INSTRUCTIONS carries the required error.retryable/resendSafety sentence.
//
// Direct formatResult tests need no server (same pattern as test/mcp/format.test.ts); isError,
// batch and OPENCODE_OVERLOADED wiring tests spawn the real stub server (same pattern as
// test/mcp/audit-u13.test.ts / test/mcp/server.test.ts) to exercise the real tools.ts call path.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import { buildErrorResult, outputSchema, SERVER_INSTRUCTIONS } from '../../src/mcp/tools.ts';
import { formatResult } from '../../src/mcp/format.ts';
import type { BatchResult, TurnResult } from '../../src/types.ts';

interface CallToolResultShape {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function baseTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    kind: 'turn',
    threadId: 'ses_1',
    sessionId: 'ses_1',
    turnId: 'ses_1#1',
    turn: 1,
    status: 'completed',
    executionState: 'stopped',
    cleanup: 'complete',
    content: 'done',
    directory: '/repo',
    filesChanged: [],
    toolCalls: [],
    toolCallCount: 0,
    pendingApprovals: [],
    elapsedMs: 100,
    truncated: false,
    hint: 'use opencode-reply to continue',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (A) Direct formatResult tests: new fields in structuredContent, schema validation, bounding.
// ---------------------------------------------------------------------------

test('formatResult: new overload fields appear in structuredContent (standard detail) and validate against outputSchema', () => {
  const result = baseTurn({
    status: 'failed',
    finish: 'stop',
    warnings: [{ code: 'TRUNCATED', message: 'answer truncated' }],
    resendSafety: 'inspect_effects',
    upstreamRetry: { attempt: 3, message: 'retrying model provider', nextAt: 10_000, observedAt: 2_000 },
    upstreamRead: { state: 'degraded', reason: 'overloaded', statusCode: 503, since: 1_000, nextAt: 43_000 },
    error: {
      name: 'MyProviderError',
      message: 'boom',
      statusCode: 503,
      retryable: true,
      retryAfterSeconds: 8,
      condition: 'MODEL_OVERLOADED',
    },
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(structuredContent.finish, 'stop');
  assert.deepEqual(structuredContent.warnings, [{ code: 'TRUNCATED', message: 'answer truncated' }]);
  assert.equal(structuredContent.resendSafety, 'inspect_effects');
  assert.deepEqual(structuredContent.upstreamRetry, {
    attempt: 3,
    message: 'retrying model provider',
    nextAt: 10_000,
    observedAt: 2_000,
  });
  assert.deepEqual(structuredContent.upstreamRead, {
    state: 'degraded',
    reason: 'overloaded',
    statusCode: 503,
    since: 1_000,
    nextAt: 43_000,
  });
  const err = structuredContent.error as Record<string, unknown>;
  assert.equal(err.statusCode, 503);
  assert.equal(err.retryable, true);
  assert.equal(err.retryAfterSeconds, 8);
  assert.equal(err.condition, 'MODEL_OVERLOADED');

  assert.match(text, /finish: stop/);
  assert.match(text, /warning: TRUNCATED — answer truncated/);
  assert.match(text, /resend-safety: inspect_effects/);
  assert.match(text, /upstream: retrying model provider \(attempt 3\), next retry in 8s/);
  assert.match(text, /reads: delayed \(HTTP 503\), next check at 1970-01-01T00:00:43.000Z/);

  const parsed = outputSchema.safeParse(structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('formatResult: responseLoop renders as a short summary line and validates against outputSchema', () => {
  const result = baseTurn({
    status: 'failed',
    error: { name: 'UPSTREAM_RESPONSE_LOOP', message: 'OpenCode repeatedly produced unusable model responses.' },
    responseLoop: { count: 6, windowMs: 10_000, pattern: 'empty' },
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });

  assert.deepEqual(structuredContent.responseLoop, { count: 6, windowMs: 10_000, pattern: 'empty' });
  assert.match(text, /response-loop: 6 unusable responses in 10s \(empty\)/);
  assert.equal(outputSchema.safeParse(structuredContent).success, true);
});

test('formatResult: new overload fields survive detail:"compact" (only toolCalls/filesChanged are dropped)', () => {
  const result = baseTurn({
    finish: 'stop',
    warnings: [{ code: 'EMPTY_RESPONSE', message: 'no answer text' }],
    resendSafety: 'unknown',
    toolCalls: [{ tool: 'bash', status: 'completed' }],
    filesChanged: ['a.txt'],
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, detail: 'compact' });

  assert.equal(structuredContent.finish, 'stop');
  assert.deepEqual(structuredContent.warnings, [{ code: 'EMPTY_RESPONSE', message: 'no answer text' }]);
  assert.equal(structuredContent.resendSafety, 'unknown');
  assert.equal('toolCalls' in structuredContent, false);
  assert.equal('filesChanged' in structuredContent, false);
  assert.equal(outputSchema.safeParse(structuredContent).success, true);
});

test('formatResult: bounds and sanitizes upstream-derived strings (finish/warnings/upstreamRetry), stripping control characters', () => {
  const longFinish = 'x'.repeat(500) + '\nnewline\tcontrol\x01chars';
  const longWarningMessage = 'y'.repeat(500) + '\r\nmore\x00control';
  const longRetryMessage = 'z'.repeat(500) + '\ncontrol\x1bchars';
  const result = baseTurn({
    finish: longFinish,
    warnings: [
      { code: 'TRUNCATED', message: longWarningMessage },
      { code: 'EMPTY_RESPONSE', message: 'b' },
      { code: 'NONSTANDARD_FINISH', message: 'c' },
      { code: 'TRUNCATED', message: 'd (a 4th entry; must be dropped, at most 3 survive)' },
    ],
    upstreamRetry: { attempt: 1, message: longRetryMessage, observedAt: 0 },
  });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  const finish = structuredContent.finish as string;
  assert.ok(finish.length <= 64, `finish too long: ${finish.length}`);
  assert.doesNotMatch(finish, /[\n\r\t\x00-\x1f\x7f]/);

  const warnings = structuredContent.warnings as Array<{ code: string; message: string }>;
  assert.equal(warnings.length, 3);
  const firstMessage = warnings[0]?.message ?? '';
  assert.ok(firstMessage.length <= 200, `warning message too long: ${firstMessage.length}`);
  assert.doesNotMatch(firstMessage, /[\n\r\t\x00-\x1f\x7f]/);

  const retry = structuredContent.upstreamRetry as { message: string };
  assert.ok(retry.message.length <= 200, `retry message too long: ${retry.message.length}`);
  assert.doesNotMatch(retry.message, /[\n\r\t\x00-\x1f\x7f]/);

  assert.equal(truncated, true);
  assert.equal(outputSchema.safeParse(structuredContent).success, true);
});

test('formatResult: sanitizes an UnknownError "JSON parsing failed:" message and appends the design-2 hint, never leaking the embedded chunk', () => {
  const sentinel = '::SENTINEL_CHUNK_MARKER_9f3a::';
  const result = baseTurn({
    status: 'failed',
    error: { name: 'UnknownError', message: `JSON parsing failed: Unexpected token in chunk "${sentinel}"` },
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });

  const serialized = JSON.stringify(structuredContent);
  assert.ok(!serialized.includes(sentinel), 'structuredContent must not leak the embedded chunk');
  assert.ok(!text.includes(sentinel), 'text must not leak the embedded chunk');

  const err = structuredContent.error as { message: string };
  assert.equal(err.message, 'The model provider returned a malformed streaming response.');
  assert.match(structuredContent.hint as string, /could not parse a response/i);
  assert.match(text, /could not parse a response/i);
});

test('formatResult: JSON-parsing sanitization is a harmless no-op once the engine already sanitized the message', () => {
  const result = baseTurn({
    status: 'failed',
    error: { name: 'UnknownError', message: 'The model provider returned a malformed streaming response.' },
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  const err = structuredContent.error as { message: string };
  assert.equal(err.message, 'The model provider returned a malformed streaming response.');
});

test('formatResult (batch): sanitizes an UnknownError JSON-parsing item error message without leaking the chunk', () => {
  const sentinel = '::SENTINEL_BATCH_CHUNK::';
  const batch: BatchResult = {
    kind: 'batch',
    status: 'ready',
    content: '',
    waitFor: 'any',
    reason: 'condition',
    results: [
      {
        sessionId: 'ses_1',
        status: 'error',
        content: '',
        error: { name: 'UnknownError', message: `JSON parsing failed: garbage ${sentinel}` },
      },
    ],
    readyIds: ['ses_1'],
    pendingIds: [],
    truncated: false,
  };
  const { structuredContent, text } = formatResult(batch, { maxOutputChars: 20_000 });

  const serialized = JSON.stringify(structuredContent);
  assert.ok(!serialized.includes(sentinel));
  assert.ok(!text.includes(sentinel));
  const items = structuredContent.results as Array<{ error?: { message: string } }>;
  assert.equal(items[0]?.error?.message, 'The model provider returned a malformed streaming response.');
});

test('formatResult: small overload metadata survives shrinkToBudget while a large toolCalls array is dropped', () => {
  const bigToolCalls = Array.from({ length: 500 }, (_, i) => ({
    tool: 'bash',
    status: 'completed',
    title: `t${i}-${'x'.repeat(400)}`,
  }));
  const result = baseTurn({
    toolCalls: bigToolCalls,
    toolCallCount: bigToolCalls.length,
    finish: 'stop',
    warnings: [{ code: 'TRUNCATED', message: 'kept' }],
    resendSafety: 'inspect_effects',
  });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(truncated, true);
  // Proves this stayed inside the ordinary shrinkToBudget reduction (large arrays dropped first),
  // never falling all the way to buildMinimalFallback (which would also drop kind/ids semantics).
  assert.equal(structuredContent.kind, 'turn');
  assert.equal(structuredContent.sessionId, 'ses_1');
  assert.equal(structuredContent.finish, 'stop');
  assert.deepEqual(structuredContent.warnings, [{ code: 'TRUNCATED', message: 'kept' }]);
  assert.equal(structuredContent.resendSafety, 'inspect_effects');
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult: overload metadata is dropped only in the last-resort minimal fallback, never leaked oversized', () => {
  const result = baseTurn({
    sessionId: 'S'.repeat(44_000),
    threadId: 'S'.repeat(44_000),
    finish: 'stop',
    warnings: [{ code: 'TRUNCATED', message: 'kept' }],
  });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(truncated, true);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
  assert.equal('finish' in structuredContent, false);
  assert.equal('warnings' in structuredContent, false);
});

// ---------------------------------------------------------------------------
// (B) buildErrorResult: OPENCODE_OVERLOADED hint, with/without retryAfterSeconds/sessionId.
// ---------------------------------------------------------------------------

test('buildErrorResult: OPENCODE_OVERLOADED without retryAfterSeconds or a session id uses the number-less wording', () => {
  const result = buildErrorResult('OPENCODE_OVERLOADED', 'overloaded');
  assert.match(result.hint ?? '', /OpenCode is temporarily busy or unavailable\. No prompt was submitted\./);
  assert.match(result.hint ?? '', /Wait a short while before retrying once\./);
  assert.doesNotMatch(result.hint ?? '', /opencode-reply/);
});

test('buildErrorResult: OPENCODE_OVERLOADED with retryAfterSeconds quotes the exact wait', () => {
  const result = buildErrorResult('OPENCODE_OVERLOADED', 'overloaded', undefined, 30);
  assert.match(result.hint ?? '', /Wait 30s before retrying once\./);
});

test('buildErrorResult: OPENCODE_OVERLOADED with a session id directs the caller to opencode-reply instead of another start', () => {
  const result = buildErrorResult('OPENCODE_OVERLOADED', 'overloaded', 'ses_1', 5);
  assert.equal(result.sessionId, 'ses_1');
  assert.match(result.hint ?? '', /Wait 5s before retrying once\./);
  assert.match(result.hint ?? '', /opencode-reply/);
});

// ---------------------------------------------------------------------------
// (C) SERVER_INSTRUCTIONS: the required error.retryable/resendSafety sentence.
// ---------------------------------------------------------------------------

test('SERVER_INSTRUCTIONS carries the required error.retryable/resendSafety sentence, within the length bound', () => {
  assert.match(
    SERVER_INSTRUCTIONS,
    /error\.retryable describes a transient fault, not permission to repeat a prompt\./,
  );
  assert.match(SERVER_INSTRUCTIONS, /Check executionState, cleanup, and resendSafety first\./);
  assert.ok(SERVER_INSTRUCTIONS.length < 2048);
});

// ---------------------------------------------------------------------------
// (D) Wire tests (real stub server): isError wiring, batch envelope, OPENCODE_OVERLOADED end-to-end.
// ---------------------------------------------------------------------------

let spawned: SpawnedServer;
let client: JsonRpcClient;

before(async () => {
  spawned = spawnStubServer();
  client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
});

after(async () => {
  spawned.child.kill('SIGKILL');
});

async function startWithOverrides(overrides: Partial<TurnResult>, args: Record<string, unknown> = {}): Promise<CallToolResultShape> {
  return (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', overrides }),
    ...args,
  })) as CallToolResultShape;
}

test('wire isError: true for a single-turn "failed" status, identity/content preserved', async () => {
  const result = await startWithOverrides({
    status: 'failed',
    content: '',
    error: { name: 'EMPTY_RESPONSE', message: 'no answer text' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'turn');
  assert.equal(result.structuredContent?.status, 'failed');
  assert.equal(typeof result.structuredContent?.sessionId, 'string');
  assert.equal(result.structuredContent?.threadId, result.structuredContent?.sessionId);
});

test('wire isError: true for a single-turn "timeout" status, partial output preserved', async () => {
  const result = await startWithOverrides({ status: 'timeout', content: 'partial work done so far' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.status, 'timeout');
  assert.equal(result.structuredContent?.content, 'partial work done so far');
});

test('wire isError: true for the pre-existing kind:"error" envelope (an EngineError throw)', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'throw-engine-error', code: 'UPSTREAM_ERROR', message: 'boom' }),
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'error');
});

test('wire isError: false for "completed" with warnings', async () => {
  const result = await startWithOverrides({
    status: 'completed',
    warnings: [{ code: 'TRUNCATED', message: 'answer truncated' }],
  });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'completed');
  assert.deepEqual(result.structuredContent?.warnings, [{ code: 'TRUNCATED', message: 'answer truncated' }]);
});

test('wire isError: false for "cancelled"', async () => {
  const result = await startWithOverrides({ status: 'cancelled' });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'cancelled');
});

test('wire isError: false for "running"', async () => {
  const result = await startWithOverrides({ status: 'running' });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'running');
});

test('wire isError: false for "waiting_for_approval"', async () => {
  const result = await startWithOverrides({ status: 'waiting_for_approval' });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'waiting_for_approval');
});

test('wire batch: envelope stays non-error while a per-item failure is intact', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'healthy answer' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;
  assert.equal(typeof sessionId, 'string');

  const batch = (await client.callTool('opencode-status', {
    ids: [sessionId, 'ses_never_existed'],
  })) as CallToolResultShape;

  assert.notEqual(batch.isError, true);
  assert.equal(batch.structuredContent?.kind, 'batch');
  const results = batch.structuredContent?.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 2);
  const failedItem = results.find((r) => r.sessionId === 'ses_never_existed');
  assert.equal((failedItem?.error as { name: string } | undefined)?.name, 'SESSION_NOT_FOUND');
  const healthyItem = results.find((r) => r.sessionId === sessionId);
  assert.equal(healthyItem?.content, 'healthy answer');
});

test('wire OPENCODE_OVERLOADED: retryAfterSeconds attached to the thrown error flows into the hint, and the session directs to opencode-reply', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({
      mode: 'throw-engine-error',
      code: 'OPENCODE_OVERLOADED',
      message: 'overloaded',
      retryAfterSeconds: 12,
    }),
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'error');
  assert.equal((result.structuredContent?.error as { name: string }).name, 'OPENCODE_OVERLOADED');
  assert.equal(typeof result.structuredContent?.sessionId, 'string');
  assert.match((result.structuredContent?.hint as string | undefined) ?? '', /Wait 12s before retrying once\./);
  assert.match((result.structuredContent?.hint as string | undefined) ?? '', /opencode-reply/);
});

test('wire OPENCODE_OVERLOADED: without retryAfterSeconds uses the number-less wording', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'throw-engine-error', code: 'OPENCODE_OVERLOADED', message: 'overloaded' }),
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.match(
    (result.structuredContent?.hint as string | undefined) ?? '',
    /Wait a short while before retrying once\./,
  );
});
