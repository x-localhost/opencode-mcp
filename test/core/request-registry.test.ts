import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../fakes/fake-clock.ts';
import {
  RequestRegistry,
  REQUEST_ID_PATTERN,
  requestFingerprint,
  type AdmissionOutcome,
  type RequestRecord,
} from '../../src/core/request-registry.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function registry(limits?: { maxRecords?: number; ttlMs?: number }) {
  const clock = new FakeClock();
  const reg = new RequestRegistry(clock, 'srv-1', limits);
  return { clock, reg };
}

/** Flush pending microtasks so `.then` callbacks scheduled elsewhere have run. */
async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// requestFingerprint canonicalisation
// ---------------------------------------------------------------------------

test('fingerprint: key order is irrelevant', () => {
  const a = requestFingerprint('opencode', { a: 1, b: 2, prompt: 'hi' });
  const b = requestFingerprint('opencode', { prompt: 'hi', b: 2, a: 1 });
  assert.equal(a, b);
});

test('fingerprint: undefined-valued keys are dropped', () => {
  const withUndefined = requestFingerprint('opencode', { a: 1, b: undefined });
  const withoutKey = requestFingerprint('opencode', { a: 1 });
  assert.equal(withUndefined, withoutKey);
});

test('fingerprint: null is kept and differs from an omitted/undefined key', () => {
  const withNull = requestFingerprint('opencode', { a: null });
  const omitted = requestFingerprint('opencode', {});
  const withUndefined = requestFingerprint('opencode', { a: undefined });
  assert.notEqual(withNull, omitted);
  assert.equal(omitted, withUndefined);
});

test('fingerprint: nested objects are canonicalised regardless of key order', () => {
  const a = requestFingerprint('opencode', { outer: { x: 1, y: { z: 2, w: 3 } } });
  const b = requestFingerprint('opencode', { outer: { y: { w: 3, z: 2 }, x: 1 } });
  assert.equal(a, b);
});

test('fingerprint: array order matters', () => {
  const a = requestFingerprint('opencode', { items: [1, 2, 3] });
  const b = requestFingerprint('opencode', { items: [3, 2, 1] });
  assert.notEqual(a, b);
  const c = requestFingerprint('opencode', { items: [1, 2, 3] });
  assert.equal(a, c);
});

test('fingerprint: arrays of objects are canonicalised per element', () => {
  const a = requestFingerprint('opencode', { items: [{ b: 2, a: 1 }] });
  const b = requestFingerprint('opencode', { items: [{ a: 1, b: 2 }] });
  assert.equal(a, b);
});

test('fingerprint: tool participates in the hash', () => {
  const a = requestFingerprint('opencode', { prompt: 'hi' });
  const b = requestFingerprint('opencode-reply', { prompt: 'hi' });
  assert.notEqual(a, b);
});

test('fingerprint: different prompt text produces a different hash', () => {
  const a = requestFingerprint('opencode', { prompt: 'hello' });
  const b = requestFingerprint('opencode', { prompt: 'goodbye' });
  assert.notEqual(a, b);
});

test('fingerprint: is a lowercase hex sha-256 digest', () => {
  const h = requestFingerprint('opencode', { prompt: 'hi' });
  assert.match(h, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// REQUEST_ID_PATTERN / invalid ids
// ---------------------------------------------------------------------------

test('REQUEST_ID_PATTERN rejects empty, overlong, leading-dash, spaced and unicode ids', () => {
  const invalid = ['', 'a'.repeat(129), '-abc', 'ab cd', 'café', '한글', '😀abc'];
  for (const id of invalid) assert.equal(REQUEST_ID_PATTERN.test(id), false, `expected invalid: ${id}`);
});

test('REQUEST_ID_PATTERN accepts a single character and a 128-char id', () => {
  assert.equal(REQUEST_ID_PATTERN.test('a'), true);
  assert.equal(REQUEST_ID_PATTERN.test('a'.repeat(128)), true);
  assert.equal(REQUEST_ID_PATTERN.test('req-1.client:2_3'), true);
});

test('reserve() returns kind "invalid" for a malformed id, with no state change', () => {
  const { reg } = registry();
  const res = reg.reserve('-bad', 'opencode', requestFingerprint('opencode', { prompt: 'hi' }));
  assert.equal(res.kind, 'invalid');
  if (res.kind === 'invalid') assert.equal(typeof res.message, 'string');
  assert.equal(reg.size(), 0);
});

// ---------------------------------------------------------------------------
// new -> duplicate (same fingerprint) -> conflict (different fingerprint)
// ---------------------------------------------------------------------------

test('reserve(): new key, then duplicate (same fingerprint), then conflict (different fingerprint)', () => {
  const { reg } = registry();
  const fp1 = requestFingerprint('opencode', { prompt: 'hello' });
  const fp2 = requestFingerprint('opencode', { prompt: 'different' });

  const first = reg.reserve('req-1', 'opencode', fp1);
  assert.equal(first.kind, 'new');
  if (first.kind === 'new') {
    assert.equal(first.record.id, 'req-1');
    assert.equal(first.record.tool, 'opencode');
    assert.equal(first.record.state, 'reserved');
    assert.equal(first.record.outcome, undefined);
  }

  const dup = reg.reserve('req-1', 'opencode', fp1);
  assert.equal(dup.kind, 'duplicate');
  if (dup.kind === 'duplicate') assert.equal(dup.record.id, 'req-1');

  const conflict = reg.reserve('req-1', 'opencode', fp2);
  assert.equal(conflict.kind, 'conflict');

  assert.equal(reg.size(), 1);
});

// ---------------------------------------------------------------------------
// Duplicate-while-reserved: settled resolves on admitted / failed / unconfirmed
// ---------------------------------------------------------------------------

test('duplicate while reserved: settled resolves when the original is admitted()', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  assert.equal(original.kind, 'new');
  if (original.kind !== 'new') throw new Error('unreachable');

  const dup = reg.reserve('req-1', 'opencode', fp);
  assert.equal(dup.kind, 'duplicate');
  if (dup.kind !== 'duplicate') throw new Error('unreachable');

  let resolved: AdmissionOutcome | undefined;
  dup.settled.then((o) => {
    resolved = o;
  });
  await flush();
  assert.equal(resolved, undefined, 'must not resolve before admitted()');

  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  await flush();
  assert.deepEqual(resolved, { kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
});

test('duplicate outcome mutation cannot affect stored or replayed outcomes', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  const pending = reg.reserve('req-1', 'opencode', fp);
  if (pending.kind !== 'duplicate') throw new Error('unreachable');

  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  const settled = await pending.settled;
  try {
    (settled as { sessionId: string }).sessionId = 'mutated';
  } catch { /* Frozen in strict mode. */ }
  const later = reg.reserve('req-1', 'opencode', fp);
  if (later.kind !== 'duplicate') throw new Error('expected replay');
  try {
    (later.record.outcome as { sessionId: string }).sessionId = 'mutated-again';
  } catch { /* Frozen in strict mode. */ }
  assert.deepEqual(later.record.outcome, {
    kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1,
  });
  const replay = reg.reserve('req-1', 'opencode', fp);
  if (replay.kind !== 'duplicate') throw new Error('expected replay');
  assert.deepEqual(await replay.settled, {
    kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1,
  });
});

test('duplicate while reserved: settled resolves on failed(), and the key frees up', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');

  const dup = reg.reserve('req-1', 'opencode', fp);
  if (dup.kind !== 'duplicate') throw new Error('unreachable');

  let resolved: AdmissionOutcome | undefined;
  dup.settled.then((o) => {
    resolved = o;
  });
  await flush();
  assert.equal(resolved, undefined);

  reg.failed(original.record, { code: 'UPSTREAM_ERROR', message: 'boom' });
  await flush();
  assert.deepEqual(resolved, { kind: 'failed', error: { code: 'UPSTREAM_ERROR', message: 'boom' } });

  // The key is free again: a corrected retry with the same id can start fresh.
  const retry = reg.reserve('req-1', 'opencode', fp);
  assert.equal(retry.kind, 'new');
  assert.equal(reg.size(), 1);
});

test('duplicate while reserved: settled resolves when the original is unconfirmed()', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');

  const dup = reg.reserve('req-1', 'opencode', fp);
  if (dup.kind !== 'duplicate') throw new Error('unreachable');

  let resolved: AdmissionOutcome | undefined;
  dup.settled.then((o) => {
    resolved = o;
  });
  await flush();
  assert.equal(resolved, undefined);

  reg.unconfirmed(original.record, { sessionId: 'ses_1', message: 'create response lost' });
  await flush();
  assert.deepEqual(resolved, { kind: 'unconfirmed', sessionId: 'ses_1', message: 'create response lost' });

  // Ambiguous stays pinned: same fingerprint still joins as a duplicate, not a fresh reservation.
  const again = reg.reserve('req-1', 'opencode', fp);
  assert.equal(again.kind, 'duplicate');
  if (again.kind === 'duplicate') assert.equal(again.record.state, 'ambiguous');
});

test('unconfirmed() without a sessionId omits it from the outcome', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.unconfirmed(original.record, { message: 'ambiguous create' });

  const again = reg.reserve('req-1', 'opencode', fp);
  assert.equal(again.kind, 'duplicate');
  if (again.kind === 'duplicate') {
    assert.deepEqual(again.record.outcome, { kind: 'unconfirmed', message: 'ambiguous create' });
    assert.equal('sessionId' in (again.record.outcome as object), false);
  }
});

test('duplicate after admitted() resolves immediately without any further call', async () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });

  const dup = reg.reserve('req-1', 'opencode', fp);
  assert.equal(dup.kind, 'duplicate');
  if (dup.kind !== 'duplicate') throw new Error('unreachable');
  const outcome = await dup.settled;
  assert.deepEqual(outcome, { kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  assert.equal(dup.record.state, 'active');
});

// ---------------------------------------------------------------------------
// settleTurn / expiry
// ---------------------------------------------------------------------------

test('settleTurn() moves the bound record to terminal with a wall-clock expiresAt', () => {
  const { clock, reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });

  clock.tick(1000);
  reg.settleTurn('ses_1', 'ses_1#1');

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'duplicate');
  if (view.kind === 'duplicate') {
    assert.equal(view.record.state, 'terminal');
    assert.equal(view.record.expiresAt, 1000 + DAY_MS);
    assert.deepEqual(view.record.outcome, { kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  }
});

test('settleTurn() ignores a (sessionId, turnId) that does not match the record', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });

  reg.settleTurn('ses_1', 'ses_1#2');
  reg.settleTurn('ses_other', 'ses_1#1');

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'duplicate');
  if (view.kind === 'duplicate') assert.equal(view.record.state, 'active');
});

test('a terminal record expires after ttl and frees its id', () => {
  const { clock, reg } = registry({ ttlMs: 1000 });
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  reg.settleTurn('ses_1', 'ses_1#1');
  assert.equal(reg.size(), 1);

  clock.tick(999);
  const stillThere = reg.reserve('req-1', 'opencode', fp);
  assert.equal(stillThere.kind, 'duplicate');

  clock.tick(1);
  const freed = reg.reserve('req-1', 'opencode', fp);
  assert.equal(freed.kind, 'new');
  assert.equal(reg.size(), 1);
});

// ---------------------------------------------------------------------------
// sessionEnded
// ---------------------------------------------------------------------------

test('sessionEnded() moves bound records to ended; reserve() then reports kind "ended"', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });

  reg.sessionEnded('ses_1');

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'ended');
  if (view.kind === 'ended') assert.equal(view.record.state, 'ended');
});

test('sessionEnded() binds ambiguous records that recorded that sessionId', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.unconfirmed(original.record, { sessionId: 'ses_1', message: 'ambiguous create' });

  reg.sessionEnded('ses_1');

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'ended');
});

test('sessionEnded() does not touch an ambiguous record with no recorded sessionId', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  reg.unconfirmed(original.record, { message: 'ambiguous create, no id' });

  reg.sessionEnded('ses_1');

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'duplicate');
  if (view.kind === 'duplicate') assert.equal(view.record.state, 'ambiguous');
});

test('two different sessions are independent under settleTurn and sessionEnded', () => {
  const { reg } = registry();
  const fpA = requestFingerprint('opencode', { prompt: 'a' });
  const fpB = requestFingerprint('opencode', { prompt: 'b' });
  const a = reg.reserve('req-a', 'opencode', fpA);
  const b = reg.reserve('req-b', 'opencode', fpB);
  if (a.kind !== 'new' || b.kind !== 'new') throw new Error('unreachable');
  reg.admitted(a.record, { sessionId: 'ses_a', turnId: 'ses_a#1', turn: 1 });
  reg.admitted(b.record, { sessionId: 'ses_b', turnId: 'ses_b#1', turn: 1 });

  reg.settleTurn('ses_a', 'ses_a#1');
  const viewA = reg.reserve('req-a', 'opencode', fpA);
  const viewB = reg.reserve('req-b', 'opencode', fpB);
  assert.equal(viewA.kind, 'duplicate');
  assert.equal(viewB.kind, 'duplicate');
  if (viewA.kind === 'duplicate') assert.equal(viewA.record.state, 'terminal');
  if (viewB.kind === 'duplicate') assert.equal(viewB.record.state, 'active');

  reg.sessionEnded('ses_b');
  const viewA2 = reg.reserve('req-a', 'opencode', fpA);
  const viewB2 = reg.reserve('req-b', 'opencode', fpB);
  assert.equal(viewA2.kind, 'duplicate');
  if (viewA2.kind === 'duplicate') assert.equal(viewA2.record.state, 'terminal');
  assert.equal(viewB2.kind, 'ended');
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

test('capacity: pinned records (reserved/active/ambiguous) are never evicted for a new key', () => {
  const { reg } = registry({ maxRecords: 3 });
  const fp1 = requestFingerprint('opencode', { prompt: '1' });
  const fp2 = requestFingerprint('opencode', { prompt: '2' });
  const fp3 = requestFingerprint('opencode', { prompt: '3' });

  const r1 = reg.reserve('req-1', 'opencode', fp1); // reserved
  const r2 = reg.reserve('req-2', 'opencode', fp2); // -> active
  const r3 = reg.reserve('req-3', 'opencode', fp3); // -> ambiguous
  assert.equal(r1.kind, 'new');
  assert.equal(r2.kind, 'new');
  assert.equal(r3.kind, 'new');
  if (r2.kind === 'new') reg.admitted(r2.record, { sessionId: 'ses_2', turnId: 'ses_2#1', turn: 1 });
  if (r3.kind === 'new') reg.unconfirmed(r3.record, { message: 'ambiguous' });

  const overflow = reg.reserve('req-4', 'opencode', requestFingerprint('opencode', { prompt: '4' }));
  assert.equal(overflow.kind, 'capacity');

  // None of the three pinned records were evicted to make room.
  assert.equal(reg.reserve('req-1', 'opencode', fp1).kind, 'duplicate');
  assert.equal(reg.reserve('req-2', 'opencode', fp2).kind, 'duplicate');
  assert.equal(reg.reserve('req-3', 'opencode', fp3).kind, 'duplicate');
  assert.equal(reg.size(), 3);
});

test('capacity: expiry of a terminal/ended record frees space for a new key', () => {
  const { clock, reg } = registry({ maxRecords: 1, ttlMs: 1000 });
  const fp1 = requestFingerprint('opencode', { prompt: '1' });
  const r1 = reg.reserve('req-1', 'opencode', fp1);
  if (r1.kind !== 'new') throw new Error('unreachable');
  reg.admitted(r1.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  reg.settleTurn('ses_1', 'ses_1#1');

  const blocked = reg.reserve('req-2', 'opencode', requestFingerprint('opencode', { prompt: '2' }));
  assert.equal(blocked.kind, 'capacity');

  clock.tick(1000);
  const freed = reg.reserve('req-2', 'opencode', requestFingerprint('opencode', { prompt: '2' }));
  assert.equal(freed.kind, 'new');
  assert.equal(reg.size(), 1);
});

// ---------------------------------------------------------------------------
// receipt()
// ---------------------------------------------------------------------------

test('receipt() reports id/serverInstanceId/replayed/scope and expiresAt when present', () => {
  const { clock, reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');

  const r1 = reg.receipt(original.record, false);
  assert.deepEqual(r1, { id: 'req-1', serverInstanceId: 'srv-1', replayed: false, scope: 'process' });

  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  clock.tick(5);
  reg.settleTurn('ses_1', 'ses_1#1');
  const view = reg.reserve('req-1', 'opencode', fp);
  if (view.kind !== 'duplicate') throw new Error('unreachable');
  const r2 = reg.receipt(view.record, true);
  assert.deepEqual(r2, {
    id: 'req-1',
    serverInstanceId: 'srv-1',
    replayed: true,
    scope: 'process',
    expiresAt: view.record.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test('returned RequestRecord objects are frozen read-only views', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const original = reg.reserve('req-1', 'opencode', fp);
  if (original.kind !== 'new') throw new Error('unreachable');
  assert.equal(Object.isFrozen(original.record), true);
  assert.throws(() => {
    (original.record as { state: string }).state = 'active';
  }, TypeError);

  reg.admitted(original.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  const dup = reg.reserve('req-1', 'opencode', fp);
  if (dup.kind !== 'duplicate') throw new Error('unreachable');
  assert.equal(Object.isFrozen(dup.record.outcome), true);
  assert.throws(() => {
    (dup.record.outcome as { turn: number }).turn = 99;
  }, TypeError);

  // Mutating the returned view never affects registry state.
  const again = reg.reserve('req-1', 'opencode', fp);
  assert.equal(again.kind, 'duplicate');
  if (again.kind === 'duplicate') assert.equal(again.record.state, 'active');
});

// ---------------------------------------------------------------------------
// size()
// ---------------------------------------------------------------------------

test('size() reflects live records and drops expired ones lazily', () => {
  const { clock, reg } = registry({ ttlMs: 100 });
  assert.equal(reg.size(), 0);
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const r = reg.reserve('req-1', 'opencode', fp);
  if (r.kind !== 'new') throw new Error('unreachable');
  reg.admitted(r.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  reg.settleTurn('ses_1', 'ses_1#1');
  assert.equal(reg.size(), 1);
  clock.tick(100);
  assert.equal(reg.size(), 0);
});

// ---------------------------------------------------------------------------
// Idempotency of transition methods
// ---------------------------------------------------------------------------

test('admitted() after failed() is a no-op (idempotent)', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const r = reg.reserve('req-1', 'opencode', fp);
  if (r.kind !== 'new') throw new Error('unreachable');
  reg.failed(r.record, { code: 'UPSTREAM_ERROR', message: 'boom' });
  assert.equal(reg.size(), 0);
  // admitted() on the now-vanished record must not resurrect it or throw.
  assert.doesNotThrow(() => reg.admitted(r.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 }));
  assert.equal(reg.size(), 0);
});

test('unconfirmed() after admitted() is a no-op (idempotent)', () => {
  const { reg } = registry();
  const fp = requestFingerprint('opencode', { prompt: 'hi' });
  const r = reg.reserve('req-1', 'opencode', fp);
  if (r.kind !== 'new') throw new Error('unreachable');
  reg.admitted(r.record, { sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  reg.unconfirmed(r.record, { message: 'too late' });

  const view = reg.reserve('req-1', 'opencode', fp);
  assert.equal(view.kind, 'duplicate');
  if (view.kind === 'duplicate') {
    assert.equal(view.record.state, 'active');
    assert.deepEqual(view.record.outcome, { kind: 'turn', sessionId: 'ses_1', turnId: 'ses_1#1', turn: 1 });
  }
});
