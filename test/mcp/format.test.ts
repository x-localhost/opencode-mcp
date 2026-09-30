import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatResult } from '../../src/mcp/format.ts';
import type { EndResult, ErrorResult, ListResult, TurnResult } from '../../src/types.ts';

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
// Basic shape and ids
// ---------------------------------------------------------------------------

test('formatResult: keeps ids/status/truncated for a small TurnResult', () => {
  const result = baseTurn();
  const { structuredContent, text, truncated } = formatResult(result, { maxOutputChars: 20_000 });

  assert.equal(truncated, false);
  assert.equal(structuredContent.sessionId, 'ses_1');
  assert.equal(structuredContent.threadId, 'ses_1');
  assert.equal(structuredContent.turnId, 'ses_1#1');
  assert.equal(structuredContent.status, 'completed');
  assert.equal(structuredContent.content, 'done');
  assert.equal(structuredContent.truncated, false);
  assert.match(text, /^\[opencode\] turn ses_1 status=completed\n/);
  assert.match(text, /done/);
  assert.match(text, /hint: use opencode-reply to continue/);
});

test('formatResult: JSON length is always < 45000 chars', () => {
  const result = baseTurn({ content: 'x'.repeat(1000) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
});

// ---------------------------------------------------------------------------
// Per-field bounds
// ---------------------------------------------------------------------------

test('formatResult: content is head+tail truncated at maxOutputChars with a marker', () => {
  const content = 'A'.repeat(30_000) + 'B'.repeat(30_000);
  const result = baseTurn({ content });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 1000 });

  assert.equal(truncated, true);
  const out = structuredContent.content as string;
  assert.ok(out.length <= 1000);
  assert.ok(out.startsWith('A'));
  assert.ok(out.endsWith('B'));
  assert.ok(out.includes('truncated'));
});

test('formatResult: short content under the budget is left untouched', () => {
  const result = baseTurn({ content: 'short answer' });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.content, 'short answer');
  assert.equal(truncated, false);
});

test('formatResult: error message is bounded to 2000 chars', () => {
  const result = baseTurn({
    status: 'failed',
    error: { name: 'UPSTREAM_ERROR', message: 'E'.repeat(5000) },
  });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const error = structuredContent.error as { name: string; message: string };
  assert.equal(error.name, 'UPSTREAM_ERROR');
  assert.ok(error.message.length <= 2000);
  assert.equal(truncated, true);
});

test('formatResult: filesChanged over 200 short items is capped to the first 200', () => {
  const filesChanged = Array.from({ length: 250 }, (_, i) => `path/${i}`);
  const result = baseTurn({ filesChanged });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.filesChanged as string[];
  assert.equal(out.length, 200);
  assert.equal(out[0], 'path/0');
  assert.equal(out[199], 'path/199');
  assert.equal(truncated, true);
});

test('formatResult: a filesChanged path over 300 chars is truncated to 300', () => {
  const filesChanged = [`path/${'x'.repeat(400)}`];
  const result = baseTurn({ filesChanged });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.filesChanged as string[];
  assert.equal(out.length, 1);
  assert.ok((out[0] as string).length <= 300);
  assert.equal(truncated, true);
});

test('formatResult: a very large filesChanged array beyond the hard budget is halved from the tail', () => {
  const filesChanged = Array.from({ length: 200 }, (_, i) => `src/file-${i}/${'x'.repeat(280)}`);
  const result = baseTurn({ filesChanged });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.filesChanged as string[];
  // The 300-char-per-path cap alone still leaves ~200*300 bytes, over the 45000 hard budget,
  // so the deterministic reduction additionally halves the array from the tail.
  assert.ok(out.length < 200);
  assert.equal(out[0], filesChanged[0]);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
  assert.equal(truncated, true);
});

test('formatResult: toolCalls keeps the last 20 and bounds titles to 300 chars', () => {
  const toolCalls = Array.from({ length: 30 }, (_, i) => ({
    tool: `tool-${i}`,
    status: 'completed',
    title: 'T'.repeat(400),
  }));
  const result = baseTurn({ toolCalls, toolCallCount: 30 });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.toolCalls as Array<{ tool: string; title?: string }>;
  assert.equal(out.length, 20);
  assert.equal(out[0]?.tool, 'tool-10');
  assert.equal(out[19]?.tool, 'tool-29');
  for (const tc of out) assert.ok((tc.title ?? '').length <= 300);
  assert.equal(truncated, true);
});

test('formatResult: pendingApprovals is bounded to 10 items and 300 chars per pattern', () => {
  const pendingApprovals = Array.from({ length: 15 }, (_, i) => ({
    id: `perm_${i}`,
    sessionId: 'ses_1',
    permission: 'bash',
    patterns: ['p'.repeat(400)],
  }));
  const result = baseTurn({ status: 'waiting_for_approval', pendingApprovals });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.pendingApprovals as Array<{ patterns: string[] }>;
  assert.equal(out.length, 10);
  for (const pa of out) for (const p of pa.patterns) assert.ok(p.length <= 300);
  assert.equal(truncated, true);
});

test('formatResult: sessions is bounded to 100 items', () => {
  const sessions = Array.from({ length: 150 }, (_, i) => ({
    sessionId: `ses_${i}`,
    title: 't',
    directory: '/repo',
    status: 'idle' as const,
    turns: 1,
    updatedAt: 1,
  }));
  const result: ListResult = {
    kind: 'sessions',
    content: 'tracked sessions',
    sessions,
    opencodeVersion: '1.18.33',
    truncated: false,
  };
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal((structuredContent.sessions as unknown[]).length, 100);
  assert.equal(truncated, true);
});

// ---------------------------------------------------------------------------
// ListResult synthesizes a `status` for the shared outputSchema
// ---------------------------------------------------------------------------

test('formatResult: ListResult gets a synthesized status so kind/status/content are all present', () => {
  const result: ListResult = {
    kind: 'sessions',
    content: 'no sessions',
    sessions: [],
    truncated: false,
  };
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(typeof structuredContent.status, 'string');
  assert.match(text, /^\[opencode\] sessions status=/);
});

// ---------------------------------------------------------------------------
// EndResult / ErrorResult basics
// ---------------------------------------------------------------------------

test('formatResult: EndResult keeps its ids, status and action', () => {
  const result: EndResult = {
    kind: 'end',
    threadId: 'ses_2',
    sessionId: 'ses_2',
    status: 'ended',
    action: 'delete',
    abortedRunningTurn: true,
    cleanup: 'complete',
    content: 'session ended',
  };
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.status, 'ended');
  assert.equal(structuredContent.action, 'delete');
  assert.match(text, /^\[opencode\] end ses_2 status=ended\n/);
});

test('formatResult: ErrorResult never fabricates a sessionId when none is known', () => {
  const result: ErrorResult = {
    kind: 'error',
    status: 'failed',
    content: 'bad input',
    error: { name: 'INVALID_ARGUMENT', message: 'bad input' },
  };
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  assert.equal(structuredContent.sessionId, undefined);
  assert.equal(structuredContent.threadId, undefined);
  assert.equal((structuredContent.error as { name: string }).name, 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------
// Deterministic reduction order under the hard 45000 budget
// ---------------------------------------------------------------------------

test('formatResult: huge content + many files + many tools + a long error stays under budget deterministically', () => {
  const filesChanged = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
  const toolCalls = Array.from({ length: 20 }, (_, i) => ({
    tool: `tool-${i}`,
    status: 'completed',
    title: 'x'.repeat(300),
  }));
  const result = baseTurn({
    content: 'C'.repeat(200_000),
    filesChanged,
    toolCalls,
    toolCallCount: 20,
    error: { name: 'UPSTREAM_ERROR', message: 'E'.repeat(2000) },
    status: 'failed',
  });

  const first = formatResult(result, { maxOutputChars: 20_000 });
  const second = formatResult(result, { maxOutputChars: 20_000 });

  const size = JSON.stringify(first.structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(first.truncated, true);
  // ids/status/error code survive every reduction step
  assert.equal(first.structuredContent.sessionId, 'ses_1');
  assert.equal(first.structuredContent.status, 'failed');
  assert.equal((first.structuredContent.error as { name: string }).name, 'UPSTREAM_ERROR');
  assert.equal(first.structuredContent.truncated, true);
  // deterministic: same input -> byte-identical output
  assert.deepEqual(first.structuredContent, second.structuredContent);
  assert.equal(first.text, second.text);
});

// ---------------------------------------------------------------------------
// Output budget enforcement for sessions/pendingApprovals (review finding: unbounded per-session
// fields and unbounded patterns-per-approval reproduced 78,074 and 60,773 chars respectively).
// ---------------------------------------------------------------------------

test('formatResult: a session list with unbounded per-session title/directory/status stays under 45000 chars', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({
    sessionId: `ses_${i}`,
    title: 'T'.repeat(5000),
    directory: '/very/'.repeat(1000),
    // Deliberately not a real TurnStatus literal: adversarial/buggy upstream data.
    status: 'S'.repeat(5000) as unknown as 'idle',
    turns: 1,
    updatedAt: 1,
  }));
  const result: ListResult = {
    kind: 'sessions',
    content: 'tracked sessions',
    sessions,
    opencodeVersion: '1.18.33',
    truncated: false,
  };
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
  const out = structuredContent.sessions as Array<{ sessionId: string; title: string; directory: string; status: string }>;
  for (const s of out) {
    assert.ok(s.title.length <= 300);
    assert.ok(s.directory.length <= 300);
    assert.ok(s.status.length <= 300);
  }
});

test('formatResult: a single pendingApproval with thousands of patterns stays under 45000 chars', () => {
  const pendingApprovals = [
    {
      id: 'perm_1',
      sessionId: 'ses_1',
      permission: 'bash',
      patterns: Array.from({ length: 20_000 }, (_, i) => `p${i}`),
    },
  ];
  const result = baseTurn({ status: 'waiting_for_approval', pendingApprovals });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
  const out = structuredContent.pendingApprovals as Array<{ patterns: string[] }>;
  assert.ok(out[0]!.patterns.length <= 20);
});

test('formatResult: many approvals each with many oversized patterns stays under 45000 chars (the reported 60,773-char repro)', () => {
  const pendingApprovals = Array.from({ length: 50 }, (_, i) => ({
    id: `perm_${i}`,
    sessionId: 'ses_1',
    permission: 'bash '.repeat(200),
    patterns: Array.from({ length: 500 }, (_, j) => `pattern-${i}-${j}-`.repeat(20)),
  }));
  const result = baseTurn({ status: 'waiting_for_approval', pendingApprovals });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
});

// ---------------------------------------------------------------------------
// Property-style test: many random adversarial inputs of every kind, deterministic seed.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so failures reproduce byte-for-byte across runs/machines. */
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
  // Single repeated char is enough to blow up JSON size without needing per-char randomness.
  const ch = String.fromCharCode(33 + Math.floor(rand() * 90));
  return ch.repeat(len);
}

function randomAdversarialArray<T>(rand: () => number, maxLen: number, make: () => T): T[] {
  const len = Math.floor(rand() * maxLen);
  return Array.from({ length: len }, make);
}

const ADVERSARIAL_VARIANTS = ['turn', 'sessions', 'end', 'error'] as const;

function buildAdversarialResult(
  rand: () => number,
  variant: (typeof ADVERSARIAL_VARIANTS)[number],
): TurnResult | ListResult | EndResult | ErrorResult {
  // Ids are deliberately kept short/realistic: callers must be able to echo them back verbatim,
  // so formatResult never truncates them — randomizing them huge would test an intentional
  // non-goal, not a bug.
  const sessionId = `ses_${Math.floor(rand() * 1_000_000)}`;

  if (variant === 'sessions') {
    // Array/field bounds below are chosen to comfortably exceed every cap this module enforces
    // (100 sessions, 300 chars/field) while keeping total generated data small enough for the
    // property test to run in well under a second per iteration.
    const sessions = randomAdversarialArray(rand, 150, () => ({
      sessionId: `ses_${Math.floor(rand() * 1_000_000)}`,
      title: randomAdversarialString(rand, 2000),
      directory: randomAdversarialString(rand, 2000),
      status: randomAdversarialString(rand, 2000) as unknown as 'idle',
      turns: Math.floor(rand() * 1000),
      updatedAt: Math.floor(rand() * 1_000_000_000),
    }));
    return {
      kind: 'sessions',
      content: randomAdversarialString(rand, 50_000),
      sessions,
      opencodeVersion: randomAdversarialString(rand, 2000),
      truncated: false,
    };
  }

  if (variant === 'end') {
    return {
      kind: 'end',
      threadId: sessionId,
      sessionId,
      status: rand() > 0.5 ? 'ended' : 'not_found',
      // Adversarial/buggy upstream data: an oversized non-enum string, not a real EndAction.
      action: randomAdversarialString(rand, 2000) as unknown as EndResult['action'],
      abortedRunningTurn: rand() > 0.5,
      cleanup: 'complete',
      content: randomAdversarialString(rand, 50_000),
    };
  }

  if (variant === 'error') {
    return {
      kind: 'error',
      status: 'failed',
      sessionId,
      threadId: sessionId,
      content: randomAdversarialString(rand, 50_000),
      error: { name: 'UPSTREAM_ERROR', message: randomAdversarialString(rand, 50_000) },
    };
  }

  // 'turn'
  return baseTurn({
    sessionId,
    threadId: sessionId,
    turnId: `${sessionId}#1`,
    content: randomAdversarialString(rand, 50_000),
    directory: randomAdversarialString(rand, 2000),
    agent: randomAdversarialString(rand, 2000),
    model: randomAdversarialString(rand, 2000),
    hint: randomAdversarialString(rand, 2000),
    filesChanged: randomAdversarialArray(rand, 500, () => randomAdversarialString(rand, 500)),
    toolCalls: randomAdversarialArray(rand, 100, () => ({
      tool: randomAdversarialString(rand, 500),
      status: randomAdversarialString(rand, 500),
      title: randomAdversarialString(rand, 500),
    })),
    toolCallCount: Math.floor(rand() * 100_000),
    pendingApprovals: randomAdversarialArray(rand, 15, () => ({
      id: `perm_${Math.floor(rand() * 1_000_000)}`,
      sessionId,
      permission: randomAdversarialString(rand, 500),
      patterns: randomAdversarialArray(rand, 50, () => randomAdversarialString(rand, 500)),
    })),
    error:
      rand() > 0.5
        ? { name: 'UPSTREAM_ERROR', message: randomAdversarialString(rand, 50_000) }
        : undefined,
    status: rand() > 0.5 ? 'failed' : 'completed',
  });
}

test('formatResult: property test — 60 random adversarial inputs of every kind stay under 45000 chars (seed 42)', () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 60; i++) {
    const variant = ADVERSARIAL_VARIANTS[i % ADVERSARIAL_VARIANTS.length]!;
    const result = buildAdversarialResult(rand, variant);
    const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
    const size = JSON.stringify(structuredContent).length;
    assert.ok(size < 45_000, `variant=${variant} iteration=${i} size was ${size}`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(structuredContent)), `variant=${variant} iteration=${i}: invalid JSON`);
    assert.equal(typeof text, 'string');
  }
});

// ---------------------------------------------------------------------------
// R6 (review round 2): the hard budget must hold for the FINAL object (including the
// `truncated` field itself), and an id long enough to blow the budget on its own (bypassing the
// input schema's max(200), or from any other source) must fall back to a minimal bounded object
// rather than ever emitting >= 45000 chars.
// ---------------------------------------------------------------------------

test('formatResult: an id long enough to blow the budget on its own falls back to a minimal bounded object, omitting (never truncating) the oversized id (A11/F-P3-5)', () => {
  const oversizedId = 'x'.repeat(50_000);
  const result: ErrorResult = {
    kind: 'error',
    status: 'failed',
    sessionId: oversizedId,
    threadId: oversizedId,
    content: 'no such session',
    error: { name: 'SESSION_NOT_FOUND', message: `no such session: ${oversizedId}` },
  };
  const { structuredContent, truncated, text } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
  assert.equal(structuredContent.kind, 'error');
  assert.equal(structuredContent.status, 'failed');
  assert.equal((structuredContent.error as { name: string }).name, 'SESSION_NOT_FOUND');
  // A11/F-P3-5: this module must never invent a shortened id — a truncated id is not a real,
  // usable identifier (it cannot be echoed back to continue anything) and is strictly worse than
  // plainly saying the field was omitted. The field is dropped entirely, recorded in
  // omittedFields, rather than capped to FALLBACK_ID_MAX like every other bounded field.
  assert.equal(structuredContent.sessionId, undefined);
  assert.equal(structuredContent.threadId, undefined);
  assert.deepEqual(structuredContent.omittedFields, ['sessionId', 'threadId']);
  assert.equal(typeof text, 'string');
});

test('formatResult: an oversized turnId is omitted (never truncated into a different turn\'s id), even when sessionId/threadId are already within the cap (A11/F-P3-5)', () => {
  // F-P3-5: "sessionId <=200 + '#' + turn" can exceed FALLBACK_ID_MAX even when sessionId itself
  // does not — the previous bug capped turnId to FALLBACK_ID_MAX regardless, silently producing a
  // turnId that (once sliced) belonged to no real turn. Modelled here with an independently huge
  // turnId (format.ts treats sessionId/threadId/turnId as three separate fields; it never derives
  // one from another) so this exercises format.ts's own per-field handling in isolation.
  const oversizedTurnId = 'x'.repeat(50_000);
  const result = baseTurn({ turnId: oversizedTurnId });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
  // sessionId/threadId were never oversized and must survive verbatim...
  assert.equal(structuredContent.sessionId, 'ses_1');
  assert.equal(structuredContent.threadId, 'ses_1');
  // ...but the oversized turnId must be omitted — never silently truncated into a wrong turn id a
  // caller could mistake for a real (and different) turn.
  assert.equal(structuredContent.turnId, undefined);
  assert.ok(
    Array.isArray(structuredContent.omittedFields) && (structuredContent.omittedFields as string[]).includes('turnId'),
    JSON.stringify(structuredContent.omittedFields),
  );
});

test('formatResult: the minimal fallback itself is bounded in every field, not just ids (F4) — an oversized error.name alone must not leak through', () => {
  // Reproduces the exact review finding: error.name (never touched by the normal per-field bounds
  // or by shrinkToBudget, same as an id) copied unchanged into the fallback produced 50,328 chars
  // despite truncated=true. This case uses an oversized error.name specifically (not an oversized
  // id) so it exercises that exact path, plus oversized ids/content/message on top for good
  // measure — every field of the fallback must come out bounded regardless of which one(s) were
  // the actual cause of exceeding the budget.
  const oversizedId = 'x'.repeat(50_000);
  // Adversarial/buggy upstream data: not a real EngineErrorCode.
  const oversizedName = 'E'.repeat(50_000) as unknown as ErrorResult['error']['name'];
  const result: ErrorResult = {
    kind: 'error',
    status: 'failed',
    sessionId: oversizedId,
    threadId: oversizedId,
    content: 'C'.repeat(50_000),
    error: { name: oversizedName, message: 'M'.repeat(50_000) },
  };
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < 45_000, `size was ${size}`);
  assert.equal(truncated, true);
  const err = structuredContent.error as { name: string; message: string };
  assert.ok(err.name.length <= 100, `error.name length was ${err.name.length}`);
  assert.ok(err.message.length <= 500, `error.message length was ${err.message.length}`);
  // A11/F-P3-5: an oversized id is omitted, never truncated into a wrong id.
  assert.equal(structuredContent.sessionId, undefined);
  assert.equal(structuredContent.threadId, undefined);
  assert.ok((structuredContent.content as string).length <= 1000);
});

test('formatResult: the final size (after the truncated field is added) is always < 45000, swept across the size boundary', () => {
  // EndResult/ErrorResult have no `truncated` field of their own, so setting it adds a brand-new
  // key — checking the budget before that addition let a borderline object tip over the limit
  // once the field was appended (the review's reported 44,999 -> 45,017 repro). Sweep a
  // fine-grained window of content lengths straddling the exact narrow boundary where the bug
  // lived: the object's size *without* `truncated` is just under 45000 (so the old
  // before-adding-the-field check saw "fine, skip shrinking"), but adding the ~17-18 byte
  // `truncated` key tips the *final* size over 45000.
  for (let contentLen = 44_800; contentLen <= 44_900; contentLen += 1) {
    const result: ErrorResult = {
      kind: 'error',
      status: 'failed',
      sessionId: 'ses_1',
      threadId: 'ses_1',
      content: 'C'.repeat(contentLen),
      error: { name: 'UPSTREAM_ERROR', message: 'short' },
    };
    const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
    const size = JSON.stringify(structuredContent).length;
    assert.ok(size < 45_000, `contentLen=${contentLen} final size was ${size}`);
  }

  // Same sweep for EndResult, which also has no pre-existing `truncated` key.
  for (let contentLen = 44_800; contentLen <= 44_900; contentLen += 1) {
    const result: EndResult = {
      kind: 'end',
      threadId: 'ses_1',
      sessionId: 'ses_1',
      status: 'ended',
      action: 'delete',
      abortedRunningTurn: false,
      cleanup: 'complete',
      content: 'C'.repeat(contentLen),
    };
    const { structuredContent } = formatResult(result, { maxOutputChars: 100_000 });
    const size = JSON.stringify(structuredContent).length;
    assert.ok(size < 45_000, `contentLen=${contentLen} final size was ${size}`);
  }
});

// ---------------------------------------------------------------------------
// U02: truncation must never split a surrogate pair (truncateMiddle for content, truncateEnd for
// short fields), and the text mirror must carry the error for a failed turn.
// ---------------------------------------------------------------------------

/** Runtime-only check (the project's ES2022 tsconfig target has no typed `isWellFormed`, but
 * Node >=20 has it at runtime): true iff `s` has no lone (unpaired) UTF-16 surrogate. */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

test('formatResult: truncateMiddle (content) never splits a surrogate pair at the head or tail cut', () => {
  const emoji = '😀';
  // truncateMiddle's own marker ('\n…[truncated]…\n', 15 chars) gives head=9993/tail=9992 for
  // maxOutputChars=20000 (different from summarizeInterval's ASCII marker in result.ts) — these
  // offsets straddle *this* function's cut, not the other one's.
  const cases = [
    'a'.repeat(9992) + emoji + 'b'.repeat(10007), // straddles the head cut
    'a'.repeat(10008) + emoji + 'b'.repeat(9991), // straddles the tail cut
  ];
  for (const content of cases) {
    assert.equal(content.length, 20001);
    const result = baseTurn({ content });
    const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
    assert.equal(truncated, true);
    assert.ok(wellFormed(structuredContent.content as string));
  }
});

test('formatResult: truncateEnd (a short field) never splits a surrogate pair at the cut', () => {
  const emoji = '😀';
  // truncateEnd cuts at max - marker.length (300 - 1 = 299); position 298/299 straddles that cut.
  const path = 'x'.repeat(298) + emoji + 'y'.repeat(10);
  const result = baseTurn({ filesChanged: [path] });
  const { structuredContent, truncated } = formatResult(result, { maxOutputChars: 20_000 });
  const out = structuredContent.filesChanged as string[];
  assert.equal(out.length, 1);
  assert.ok((out[0] as string).length <= 300);
  assert.equal(truncated, true);
  assert.ok(wellFormed(out[0] as string));
});

test('formatResult: the text mirror of a failed TurnResult contains the error name and message', () => {
  const result = baseTurn({
    status: 'failed',
    error: { name: 'APIError', message: 'rate limited' },
  });
  const { text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /error: APIError: rate limited/);
});

test('formatResult: never slices the serialized JSON (only rebuilds field values)', () => {
  const result = baseTurn({ content: 'Z'.repeat(500_000) });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000 });
  const json = JSON.stringify(structuredContent);
  // A naive "slice the final JSON string" bug would corrupt the trailing structure
  // (e.g. an unterminated string or a missing closing brace). Confirm it still parses.
  assert.doesNotThrow(() => JSON.parse(json));
});
