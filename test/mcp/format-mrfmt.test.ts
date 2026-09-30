// mid-point review fixes (findings 2, 3, 4, 7, 8, 9, 10) — unit tests for
// src/mcp/format.ts, same no-server-spawn pattern as
// test/mcp/format.test.ts / test/mcp/format-f8.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatResult } from '../../src/mcp/format.ts';
import type { BatchResult, InfoResult, ListResult, OutputResult, TurnResult } from '../../src/types.ts';

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

function baseOutput(overrides: Partial<OutputResult> = {}): OutputResult {
  return {
    kind: 'output',
    status: 'ok',
    content: 'the answer',
    sessionId: 'ses_1',
    threadId: 'ses_1',
    turnId: 'ses_1#1',
    turn: 1,
    section: 'answer',
    offset: 0,
    nextOffset: null,
    total: 10,
    hasMore: false,
    partial: false,
    truncated: false,
    ...overrides,
  };
}

function buildServer(defaultsOverrides: Record<string, unknown> = {}): NonNullable<InfoResult['server']> {
  return {
    mcpVersion: '0.1.0',
    serverInstanceId: 'inst_1',
    mode: 'managed',
    remotePaths: false,
    connectionState: 'connected',
    opencodeVersion: '1.18.33',
    defaults: {
      cwd: '/work',
      model: null,
      agent: null,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      turnTimeoutSeconds: 600,
      maxTurnTimeoutSeconds: 3600,
      ...defaultsOverrides,
    },
    limits: {
      maxOutputChars: 20000,
      structuredContentBudget: 45000,
      maxWaitSeconds: 600,
      maxBatchIds: 16,
      outputRetention: { ttlSeconds: 3600, maxTurns: 128, maxBytes: 33554432 },
      requestIds: { maxRecords: 4096, ttlSeconds: 86400 },
    },
    capabilities: [],
    sandboxEnforcement: 'permission-profile',
  };
}

function baseInfo(overrides: Partial<InfoResult> = {}): InfoResult {
  return {
    kind: 'info',
    status: 'ok',
    content: 'info',
    section: 'server',
    truncated: false,
    ...overrides,
  };
}

function baseBatch(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    kind: 'batch',
    status: 'ready',
    content: 'batch summary',
    waitFor: 'any',
    reason: 'condition',
    results: [],
    readyIds: [],
    pendingIds: [],
    truncated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Finding 9: content caps below the truncateMiddle marker length (15 chars) must never exceed
// the cap. Test every cap 0..marker length.
// ---------------------------------------------------------------------------

test('formatResult: every content cap 0..15 (the truncateMiddle marker length) is honoured exactly, never exceeded', () => {
  const content = 'X'.repeat(1000);
  for (let cap = 0; cap <= 15; cap++) {
    const { structuredContent } = formatResult(baseTurn({ content }), { maxOutputChars: 100_000, callMaxOutputChars: cap });
    const out = structuredContent.content as string;
    assert.ok(out.length <= cap, `cap=${cap} produced content.length=${out.length}`);
  }
});

test('formatResult: a cap of exactly 15 still fits the full marker (boundary case)', () => {
  const content = 'X'.repeat(1000);
  const { structuredContent } = formatResult(baseTurn({ content }), { maxOutputChars: 100_000, callMaxOutputChars: 15 });
  assert.ok((structuredContent.content as string).length <= 15);
});

test('formatResult: a cap above the marker length still produces a marker-bearing truncation and respects the cap', () => {
  const content = 'X'.repeat(1000);
  const { structuredContent } = formatResult(baseTurn({ content }), { maxOutputChars: 100_000, callMaxOutputChars: 100 });
  const out = structuredContent.content as string;
  assert.ok(out.length <= 100);
  assert.ok(out.includes('truncated'));
});

test('formatResult (batch): per-item content caps 0..15 are honoured exactly (cutNoMarker has no marker to violate)', () => {
  for (let cap = 0; cap <= 15; cap++) {
    const results = [{ sessionId: 's', status: 'completed' as const, content: 'Y'.repeat(1000) }];
    const { structuredContent } = formatResult(baseBatch({ results }), { maxOutputChars: 20_000, callMaxOutputChars: cap });
    const out = (structuredContent.results as Array<{ content: string }>)[0]!.content;
    assert.ok(out.length <= cap, `cap=${cap} produced content.length=${out.length}`);
  }
});

// ---------------------------------------------------------------------------
// Finding 10: standard-mode (non-compact) array reductions must also record the original count
// and the omitted field name, not just under detail:"compact".
// ---------------------------------------------------------------------------

test('formatResult: standard mode records filesChangedCount and omittedFields when filesChanged is capped', () => {
  const filesChanged = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
  const result = baseTurn({ filesChanged });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.filesChangedCount, 250, 'the true original count, not the capped array length');
  assert.ok((structuredContent.omittedFields as string[]).includes('filesChanged'));
  assert.ok((structuredContent.filesChanged as unknown[]).length < 250, 'the array itself stays present, just capped');
});

test('formatResult: standard mode records pendingApprovalCount and omittedFields when pendingApprovals is capped', () => {
  const pendingApprovals = Array.from({ length: 11 }, (_, i) => ({
    id: `p${i}`,
    sessionId: 'ses_1',
    permission: 'bash',
    patterns: ['x'],
  }));
  const result = baseTurn({ status: 'waiting_for_approval', pendingApprovals });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.pendingApprovalCount, 11);
  assert.ok((structuredContent.omittedFields as string[]).includes('pendingApprovals'));
  assert.equal((structuredContent.pendingApprovals as unknown[]).length, 10);
});

test('formatResult: standard mode records omittedFields when toolCalls is capped to the last 20 (toolCallCount was already a real field)', () => {
  const toolCalls = Array.from({ length: 30 }, (_, i) => ({ tool: `t${i}`, status: 'completed' }));
  const result = baseTurn({ toolCalls, toolCallCount: 30 });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.ok((structuredContent.omittedFields as string[]).includes('toolCalls'));
  assert.equal(structuredContent.toolCallCount, 30);
});

test('formatResult (sessions): a capped session list records the true original count and omittedFields', () => {
  const sessions = Array.from({ length: 150 }, (_, i) => ({
    sessionId: `s${i}`,
    title: 't',
    directory: '/repo',
    status: 'idle' as const,
    turns: 1,
    updatedAt: 1,
  }));
  const result: ListResult = { kind: 'sessions', content: 'x', sessions, truncated: false };
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.sessionsCount, 150);
  assert.ok((structuredContent.omittedFields as string[]).includes('sessions'));
  assert.equal((structuredContent.sessions as unknown[]).length, 100);
});

test('formatResult: a TurnResult with nothing oversized gets no omittedFields at all', () => {
  const result = baseTurn({ toolCalls: [{ tool: 'bash', status: 'completed' }], filesChanged: ['a.ts'] });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.omittedFields, undefined);
});

// ---------------------------------------------------------------------------
// Finding 3 / 8: `info` result fitting must recompute nextOffset/hasMore from what was actually
// emitted (never leave a stale/null cursor that causes callers to skip entries), and
// server.defaults.cwd (a usable path) must never be shortened — preserved exactly or omitted.
// ---------------------------------------------------------------------------

test('formatResult (info): an oversized models page recomputes nextOffset/hasMore from what was actually emitted', () => {
  const models = Array.from({ length: 80 }, (_, i) => ({
    model: `provider/model-${'x'.repeat(1200)}-${i}`,
    providerId: 'provider',
    modelId: `model-${i}`,
    defaultForProvider: false,
  }));
  const result = baseInfo({
    section: 'models',
    models,
    offset: 20,
    total: 500,
    nextOffset: 100, // what the engine claimed, as if all 80 were kept — must not survive as-is
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.models as unknown[];
  assert.ok(out.length < 80, 'the oversized page must have been reduced');
  assert.equal(structuredContent.nextOffset, 20 + out.length, 'nextOffset must reflect what was actually emitted');
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult (info): dropping items on what the engine called the LAST page still advances the cursor instead of claiming completeness', () => {
  const models = Array.from({ length: 80 }, (_, i) => ({
    model: `m-${'y'.repeat(1200)}-${i}`,
    providerId: 'p',
    modelId: `m${i}`,
    defaultForProvider: false,
  }));
  const result = baseInfo({ section: 'models', models, offset: 0, total: 80, nextOffset: null });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.models as unknown[];
  assert.ok(out.length < 80);
  assert.equal(
    structuredContent.nextOffset,
    out.length,
    'items were dropped, so nextOffset must advance to a real continuation point instead of staying null (claiming completeness it cannot back up)',
  );
});

test('formatResult (info): server.defaults.cwd is preserved byte-for-byte when it fits, never truncated to a shorter fake path', () => {
  const cwd = '/workspace/' + 'a'.repeat(4000);
  const result = baseInfo({ section: 'server', server: buildServer({ cwd }) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  const server = structuredContent.server as Record<string, unknown>;
  const defaults = server.defaults as Record<string, unknown>;
  assert.equal(defaults.cwd, cwd);
});

test('formatResult (info): an unfittable server.defaults.cwd is omitted whole, never a shortened path', () => {
  const cwd = '/workspace/' + 'a'.repeat(60_000);
  const result = baseInfo({ section: 'server', server: buildServer({ cwd }) });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const server = structuredContent.server as Record<string, unknown>;
  const defaults = server.defaults as Record<string, unknown>;
  assert.equal(defaults.cwd, undefined, 'omitted entirely, never a shortened fake path');
  assert.ok((structuredContent.omittedFields as string[]).includes('server.defaults.cwd'));
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult (info): roots are only ever dropped whole, individual paths are never shortened', () => {
  const roots = Array.from({ length: 300 }, (_, i) => `/very/long/root/path/${'z'.repeat(300)}/${i}`);
  const result = baseInfo({ section: 'roots', roots, total: roots.length });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.roots as string[];
  assert.ok(out.length < roots.length);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], roots[i], 'every kept root path is byte-identical');
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

// ---------------------------------------------------------------------------
// Finding 4: list/diff/tool-call pages must make positive progress; a single item that cannot
// fit returns a bounded error instead of a non-advancing empty page with the same cursor.
// ---------------------------------------------------------------------------

test('formatResult (output): a single diff-stat item too large to fit returns a bounded error, not a non-advancing empty page', () => {
  const files = [{ fileIndex: 0, file: '/' + 'f'.repeat(60_000), status: 'modified', additions: 1, deletions: 0 }];
  const result = baseOutput({
    section: 'diff',
    offset: 0,
    total: 1,
    hasMore: false,
    nextOffset: null,
    diff: {
      source: 'opencode-snapshot',
      scope: 'user-message',
      sourceMessageId: 'm1',
      snapshotId: 's1',
      observedAt: 0,
      completeness: 'not-guaranteed',
      compacted: false,
      view: 'stat',
      files,
    },
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.kind, 'error', 'a single item that cannot fit must be a bounded error, never an empty page claiming hasMore/status ok');
  assert.notEqual(structuredContent.status, 'ok');
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult (output): a single tool-call too large to fit (via an oversized, never-truncated identifier) returns a bounded error', () => {
  const toolCalls = [{ messageId: 'm'.repeat(60_000), tool: 'bash', status: 'completed' }];
  const result = baseOutput({ section: 'tool-calls', offset: 0, total: 1, hasMore: false, nextOffset: null, toolCalls });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.kind, 'error');
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult (output): a multi-item tool-calls page that still has room to shrink is NOT an error (no regression)', () => {
  const toolCalls = Array.from({ length: 3000 }, (_, i) => ({
    messageId: `msg_${i}`,
    callId: `call_${i}`,
    tool: `tool-${i}`,
    status: 'completed',
    title: 'x'.repeat(250),
  }));
  const result = baseOutput({ section: 'tool-calls', content: '3000 tool calls', offset: 0, total: toolCalls.length, toolCalls });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
  assert.equal(structuredContent.kind, 'output');
  const emitted = structuredContent.toolCalls as unknown[];
  assert.ok(emitted.length > 0);
});

// ---------------------------------------------------------------------------
// Finding 2: batch fitting must preserve every requested id/item (shrinking display fields,
// error messages and content first); if even the membership cannot fit, a bounded ErrorResult
// replaces the batch, never a "ready" success silently missing items.
// ---------------------------------------------------------------------------

test('formatResult (batch): 16 control-char-heavy ids never produce a "ready" success with missing membership', () => {
  const CONTROL = Array.from({ length: 199 }, (_, i) => String.fromCharCode(i % 9)).join('');
  const ids = Array.from({ length: 16 }, (_, i) => `${CONTROL}${i}`); // 200 chars each, schema-valid
  const results = ids.map((sessionId) => ({
    sessionId,
    status: 'error' as const,
    content: '',
    error: { name: 'UPSTREAM_ERROR', message: CONTROL.repeat(25) },
  }));
  const result = baseBatch({ results, readyIds: [], pendingIds: ids });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 0 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  if (structuredContent.kind === 'batch') {
    const out = structuredContent.results as Array<{ sessionId: string }>;
    assert.equal(out.length, 16, 'every requested id must stay present in a "batch" success');
    assert.deepEqual(out.map((r) => r.sessionId).sort(), [...ids].sort());
  } else {
    assert.equal(structuredContent.kind, 'error', 'if membership truly cannot fit, this must be a bounded error, not a batch missing items');
    assert.equal(typeof (structuredContent.error as { name: string } | undefined)?.name, 'string');
  }
});

test('formatResult (batch): a batch that DOES fit is never downgraded to an error (no regression)', () => {
  const results = ['a', 'b', 'c'].map((sessionId) => ({ sessionId, status: 'completed' as const, content: 'hi' }));
  const result = baseBatch({ results, readyIds: ['a', 'b', 'c'] });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.kind, 'batch');
  assert.equal((structuredContent.results as unknown[]).length, 3);
});

test('formatResult (batch): oversized per-item error messages shrink further than the initial 2000-char cap when membership must be preserved', () => {
  const CONTROL = Array.from({ length: 190 }, (_, i) => String.fromCharCode(i % 9)).join('');
  const ids = Array.from({ length: 16 }, (_, i) => `id_${i}_${CONTROL}`);
  const results = ids.map((sessionId) => ({
    sessionId,
    status: 'error' as const,
    content: '',
    error: { name: 'UPSTREAM_ERROR', message: CONTROL.repeat(30) },
  }));
  const result = baseBatch({ results, pendingIds: ids });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 100 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  if (structuredContent.kind === 'batch') {
    assert.equal((structuredContent.results as unknown[]).length, 16);
  }
});

// ---------------------------------------------------------------------------
// Finding 7: the text mirror of output/info/batch results must carry the actionable data
// (entries, item answers/errors, nextOffset, snapshotId), not just counts.
// ---------------------------------------------------------------------------

test('formatResult (info): the text mirror lists actual model names, not just a count', () => {
  const models = [
    { model: 'anthropic/opus', providerId: 'anthropic', modelId: 'opus', defaultForProvider: true },
    { model: 'openai/gpt', providerId: 'openai', modelId: 'gpt', defaultForProvider: false },
  ];
  const result = baseInfo({ section: 'models', models });
  const { text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /anthropic\/opus/);
  assert.match(text, /openai\/gpt/);
});

test("formatResult (batch): the text mirror includes each item's answer or error", () => {
  const results = [
    { sessionId: 'ses_a', status: 'completed' as const, content: 'the answer is 42' },
    { sessionId: 'ses_b', status: 'error' as const, content: '', error: { name: 'SESSION_NOT_FOUND', message: 'gone' } },
  ];
  const result = baseBatch({ results, readyIds: ['ses_a'], pendingIds: [] });
  const { text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /the answer is 42/);
  assert.match(text, /SESSION_NOT_FOUND/);
  assert.match(text, /gone/);
});

test('formatResult (output): the text mirror includes nextOffset and, for a diff read, the snapshotId and file entries', () => {
  const result = baseOutput({
    section: 'diff',
    offset: 0,
    total: 1,
    nextOffset: 1,
    hasMore: true,
    diff: {
      source: 'opencode-snapshot',
      scope: 'user-message',
      sourceMessageId: 'm1',
      snapshotId: 'snap_xyz',
      observedAt: 0,
      completeness: 'not-guaranteed',
      compacted: false,
      view: 'stat',
      files: [{ fileIndex: 0, file: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
    },
  });
  const { text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /snap_xyz/);
  assert.match(text, /nextOffset/);
  assert.match(text, /a\.ts/);
});
