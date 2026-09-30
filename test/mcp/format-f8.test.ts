// v0.3 delegation features (F8): unit tests for the presentation/fitting functions in
// src/mcp/format.ts — `detail`/`max-output-chars` per-call presentation, and the three new result
// kinds (`output`, `info`, `batch`). Mirrors the existing test/mcp/format.test.ts pattern: no
// server spawn, formatResult called directly. See the v0.3 features contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatResult } from '../../src/mcp/format.ts';
import type { BatchResult, InfoResult, OutputResult, TurnResult } from '../../src/types.ts';

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

/** Runtime-only surrogate check, same helper as format.test.ts. */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

// ---------------------------------------------------------------------------
// detail:"compact" / max-output-chars (incl. 0)
// ---------------------------------------------------------------------------

test('formatResult: detail "compact" omits toolCalls/filesChanged, adds counts, keeps pendingApprovals', () => {
  const result = baseTurn({
    toolCalls: [{ tool: 'bash', status: 'completed', title: 'run tests' }],
    filesChanged: ['a.ts', 'b.ts', 'c.ts'],
    pendingApprovals: [{ id: 'perm_1', sessionId: 'ses_1', permission: 'bash', patterns: ['rm *'] }],
    status: 'waiting_for_approval',
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, detail: 'compact' });

  assert.equal(structuredContent.toolCalls, undefined);
  assert.equal(structuredContent.filesChanged, undefined);
  assert.equal(structuredContent.filesChangedCount, 3);
  assert.equal(structuredContent.pendingApprovalCount, 1);
  assert.ok(Array.isArray(structuredContent.pendingApprovals), 'pendingApprovals itself stays present');
  assert.equal((structuredContent.pendingApprovals as unknown[]).length, 1);
  assert.equal(structuredContent.toolCallCount, 0);
  assert.ok(Array.isArray(structuredContent.omittedFields));
  assert.deepEqual([...(structuredContent.omittedFields as string[])].sort(), ['filesChanged', 'toolCalls']);
});

test('formatResult: detail "standard" (default) keeps toolCalls/filesChanged, no omittedFields', () => {
  const result = baseTurn({
    toolCalls: [{ tool: 'bash', status: 'completed' }],
    filesChanged: ['a.ts'],
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal((structuredContent.toolCalls as unknown[]).length, 1);
  assert.equal((structuredContent.filesChanged as unknown[]).length, 1);
  assert.equal(structuredContent.omittedFields, undefined);
});

test('formatResult: max-output-chars 0 returns empty content and keeps everything else', () => {
  const result = baseTurn({ content: 'a real answer', filesChanged: ['a.ts'] });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 0 });
  assert.equal(structuredContent.content, '');
  assert.equal(truncated, true);
  assert.deepEqual(structuredContent.filesChanged, ['a.ts']);
});

test('formatResult: max-output-chars 0 on already-empty content is not marked truncated', () => {
  const result = baseTurn({ content: '' });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 0 });
  assert.equal(structuredContent.content, '');
  assert.equal(truncated, false);
});

test('formatResult: effective content cap is min(serverCap, max-output-chars)', () => {
  const result = baseTurn({ content: 'x'.repeat(1000) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 50, callMaxOutputChars: 20_000 });
  assert.ok((structuredContent.content as string).length <= 50, 'serverCap (50) wins over the larger call cap');
});

test('formatResult: standard default content cap is 44000, compact default is 2000 (both bounded by serverCap)', () => {
  const content = 'x'.repeat(50_000);
  const standard = formatResult(baseTurn({ content }), { maxOutputChars: 100_000 });
  const compact = formatResult(baseTurn({ content }), { maxOutputChars: 100_000, detail: 'compact' });
  assert.ok((standard.structuredContent.content as string).length <= 44_000);
  assert.ok((compact.structuredContent.content as string).length <= 2_000);
  assert.ok((compact.structuredContent.content as string).length < (standard.structuredContent.content as string).length);
});

// ---------------------------------------------------------------------------
// Two calls with different detail on the same result never affect each other
// ---------------------------------------------------------------------------

test('formatResult: two calls with different detail on the same TurnResult are independent and never mutate the input', () => {
  const toolCalls = [{ tool: 'bash', status: 'completed' }];
  const filesChanged = ['a.ts', 'b.ts'];
  const result = baseTurn({ toolCalls, filesChanged });

  const compact = formatResult(result, { maxOutputChars: 20_000, detail: 'compact' });
  const standard = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(compact.structuredContent.toolCalls, undefined);
  assert.equal((standard.structuredContent.toolCalls as unknown[]).length, 1);
  assert.equal((standard.structuredContent.filesChanged as unknown[]).length, 2);
  // The original TurnResult (and its nested arrays) passed to both calls must be untouched.
  assert.equal(result.toolCalls, toolCalls);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.filesChanged, filesChanged);
  assert.equal(result.filesChanged.length, 2);
});

// ---------------------------------------------------------------------------
// Heavy escaping stays under the 45000 hard budget, for every new kind too
// ---------------------------------------------------------------------------

const HEAVY = '"\\\n\t\r\u0000\u0001😀🚀'.repeat(4000);

test('formatResult: heavy-escaping content stays < 45000 serialized (turn)', () => {
  const { structuredContent } = formatResult(baseTurn({ content: HEAVY }), { maxOutputChars: 100_000 });
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult: heavy-escaping content stays < 45000 serialized (output)', () => {
  const result = baseOutput({ content: HEAVY, total: HEAVY.length });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult: heavy-escaping content stays < 45000 serialized (info)', () => {
  const models = Array.from({ length: 300 }, (_, i) => ({
    model: `${HEAVY.slice(0, 200)}-${i}`,
    providerId: 'p',
    modelId: `m${i}`,
    defaultForProvider: false,
  }));
  const result = baseInfo({ section: 'models', content: HEAVY, models });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult: heavy-escaping content stays < 45000 serialized (batch)', () => {
  const results = Array.from({ length: 16 }, (_, i) => ({
    sessionId: `ses_${i}`,
    status: 'completed' as const,
    content: HEAVY,
  }));
  const result = baseBatch({ results, readyIds: results.map((r) => r.sessionId) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

// ---------------------------------------------------------------------------
// structuredOutput: omitted WHOLE when it doesn't fit, never partially altered
// ---------------------------------------------------------------------------

test('formatResult: a huge valid structuredOutput is omitted whole, flagged in omittedFields, status stays "valid"', () => {
  const bigStructured: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) bigStructured[`key${i}`] = 'v'.repeat(50);
  const result = baseTurn({
    content: 'short answer',
    structuredOutputStatus: 'valid',
    structuredOutput: bigStructured,
  });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(structuredContent.structuredOutput, undefined);
  assert.equal(structuredContent.structuredOutputStatus, 'valid');
  assert.ok((structuredContent.omittedFields as string[]).includes('structuredOutput'));
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult: a small valid structuredOutput is kept as-is, unaltered', () => {
  const small = { answer: 42, ok: true };
  const result = baseTurn({ structuredOutputStatus: 'valid', structuredOutput: small });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.deepEqual(structuredContent.structuredOutput, small);
  assert.equal(structuredContent.omittedFields, undefined);
});

// ---------------------------------------------------------------------------
// output: page shrink recomputes nextOffset/hasMore, never splits a surrogate pair
// ---------------------------------------------------------------------------

test('formatResult (output): a huge text page shrinks to fit, recomputes nextOffset, and never splits a surrogate pair', () => {
  const emoji = '😀'; // one surrogate pair, 2 UTF-16 code units
  const content = emoji.repeat(30_000); // 60,000 code units — forces the envelope-fit loop.
  const result = baseOutput({ section: 'answer', content, offset: 0, total: content.length, hasMore: false });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 100_000 });

  const finalContent = structuredContent.content as string;
  assert.ok(finalContent.length < content.length, 'the page must have been shrunk');
  assert.ok(wellFormed(finalContent), 'no lone surrogate at the cut');
  assert.equal(structuredContent.nextOffset, finalContent.length, 'nextOffset = offset + emitted length');
  assert.equal(structuredContent.hasMore, true);
  assert.equal(structuredContent.truncated, true);
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

test('formatResult (output): a page that already fits is left alone — truncated/hasMore/nextOffset pass through unchanged', () => {
  const result = baseOutput({ content: 'short page', offset: 5, total: 100, hasMore: true, nextOffset: 15, truncated: false });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.content, 'short page');
  assert.equal(structuredContent.nextOffset, 15);
  assert.equal(structuredContent.hasMore, true);
  assert.equal(truncated, false);
});

test('formatResult (output): a huge tool-calls page shrinks by item count and recomputes nextOffset/hasMore', () => {
  const toolCalls = Array.from({ length: 3000 }, (_, i) => ({
    messageId: `msg_${i}`,
    callId: `call_${i}`,
    tool: `tool-${i}`,
    status: 'completed',
    title: 'x'.repeat(250),
  }));
  const result = baseOutput({ section: 'tool-calls', content: '3000 tool calls', offset: 0, total: toolCalls.length, toolCalls });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });

  const emitted = structuredContent.toolCalls as unknown[];
  assert.ok(emitted.length < toolCalls.length, 'the page must have been shrunk');
  assert.equal(structuredContent.nextOffset, emitted.length);
  assert.equal(structuredContent.hasMore, emitted.length < toolCalls.length);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

// ---------------------------------------------------------------------------
// batch: deterministic budget split, membership always preserved
// ---------------------------------------------------------------------------

test('formatResult (batch): splits the aggregate budget deterministically across items in input order', () => {
  const results = ['ses_a', 'ses_b', 'ses_c'].map((sessionId) => ({
    sessionId,
    status: 'completed' as const,
    content: 'Y'.repeat(1000),
  }));
  const result = baseBatch({ results, readyIds: results.map((r) => r.sessionId) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 300 });

  const out = structuredContent.results as Array<{ sessionId: string; content: string }>;
  assert.equal(out.length, 3, 'membership preserved: all 3 items stay present');
  assert.deepEqual(out.map((r) => r.sessionId), ['ses_a', 'ses_b', 'ses_c'], 'input order preserved');
  for (const item of out) assert.ok(item.content.length <= 100, `share should be ~100 chars, got ${item.content.length}`);
  const total = out.reduce((sum, r) => sum + r.content.length, 0);
  assert.ok(total <= 300);
});

test('formatResult (batch): remainder chars go to the first items, deterministically', () => {
  const results = ['a', 'b', 'c'].map((sessionId) => ({ sessionId, status: 'completed' as const, content: 'Z'.repeat(50) }));
  const result = baseBatch({ results });
  const { structuredContent: first } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 10 });
  const { structuredContent: second } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 10 });
  assert.deepEqual(first, second, 'deterministic: same input -> byte-identical output');
  const out = first.results as Array<{ content: string }>;
  const lengths = out.map((r) => r.content.length);
  // 10 chars / 3 items -> shares [4, 3, 3]
  assert.deepEqual(lengths, [4, 3, 3]);
});

test('formatResult (batch): items stay present with empty content when the aggregate budget is 0', () => {
  const results = ['a', 'b'].map((sessionId) => ({ sessionId, status: 'completed' as const, content: 'hello' }));
  const result = baseBatch({ results });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, callMaxOutputChars: 0 });
  const out = structuredContent.results as Array<{ sessionId: string; content: string }>;
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.sessionId), ['a', 'b']);
  for (const item of out) assert.equal(item.content, '');
});

test('formatResult (batch): default aggregate budget is min(serverCap, 8000)', () => {
  const results = Array.from({ length: 4 }, (_, i) => ({ sessionId: `s${i}`, status: 'completed' as const, content: 'Q'.repeat(5000) }));
  const result = baseBatch({ results });
  const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
  const out = structuredContent.results as Array<{ content: string }>;
  const total = out.reduce((sum, r) => sum + r.content.length, 0);
  assert.ok(total <= 8000, `expected the default 8000-char aggregate, got ${total}`);
});

test('formatResult (batch): a per-item error message is bounded, and the item is never dropped', () => {
  const results = [
    { sessionId: 'ses_ok', status: 'completed' as const, content: 'fine' },
    {
      sessionId: 'ses_missing',
      status: 'error' as const,
      content: '',
      error: { name: 'SESSION_NOT_FOUND', message: 'E'.repeat(5000) },
    },
  ];
  const result = baseBatch({ results, readyIds: ['ses_ok'], pendingIds: [] });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.results as Array<{ sessionId: string; error?: { message: string } }>;
  assert.equal(out.length, 2);
  assert.ok((out[1]!.error!.message as string).length <= 2000);
  assert.equal(truncated, true);
});

// ---------------------------------------------------------------------------
// info: identifiers (model/agent names, root paths) are never truncated — only whole items drop
// ---------------------------------------------------------------------------

test('formatResult (info): an oversized models page drops whole items but never shortens a kept identifier', () => {
  const models = Array.from({ length: 500 }, (_, i) => ({
    model: `provider/model-${'x'.repeat(300)}-${i}`,
    providerId: 'provider',
    modelId: `model-${i}`,
    defaultForProvider: false,
  }));
  const result = baseInfo({ section: 'models', models, total: models.length });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  const out = structuredContent.models as Array<{ model: string }>;
  assert.ok(out.length < models.length, 'oversized page must have dropped whole items');
  assert.equal(truncated, true);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i]!.model, models[i]!.model, 'every kept identifier is byte-identical to the original, never shortened');
  }
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

// ---------------------------------------------------------------------------
// Property-style: never throws, always parses, always < 45000, across every new kind.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAdversarialString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  const ch = String.fromCharCode(33 + Math.floor(rand() * 90));
  return ch.repeat(len);
}

test('formatResult: property test — adversarial output/info/batch inputs stay < 45000 and always parse (seed 7)', () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 30; i++) {
    const variant = i % 3;
    let result: OutputResult | InfoResult | BatchResult;
    if (variant === 0) {
      const content = randomAdversarialString(rand, 80_000);
      result = baseOutput({ content, total: content.length, section: rand() > 0.5 ? 'answer' : 'structured-output' });
    } else if (variant === 1) {
      const models = Array.from({ length: Math.floor(rand() * 300) }, (_, j) => ({
        model: randomAdversarialString(rand, 500) || `m${j}`,
        providerId: 'p',
        modelId: `m${j}`,
        defaultForProvider: false,
      }));
      result = baseInfo({ section: 'models', content: randomAdversarialString(rand, 5000), models });
    } else {
      const n = 1 + Math.floor(rand() * 16);
      const results = Array.from({ length: n }, (_, j) => ({
        sessionId: `ses_${j}`,
        status: 'completed' as const,
        content: randomAdversarialString(rand, 20_000),
      }));
      result = baseBatch({ results, readyIds: results.map((r) => r.sessionId) });
    }
    const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
    const size = JSON.stringify(structuredContent).length;
    assert.ok(size < 45_000, `variant=${variant} iteration=${i} size was ${size}`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(structuredContent)));
  }
});
