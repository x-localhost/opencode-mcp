// Unit tests for src/opencode/retry.ts: Retry-After parsing, transient-failure classification,
// the bounded read-retry loop (attempt counts, backoff/Retry-After timing, cancellation,
// deadline-sharing), and the UpstreamErrorDetail normalizer.
//
// These tests use the real clock (src/opencode/retry.ts's `createRealClock`) with an injected
// `random` source pinned to make jittered delays deterministic (usually 0ms) rather than a fake
// clock: withReadRetry's sleeps are short enough (<=250ms per retry with random=>0, or a
// precisely-chosen Retry-After value) that real timers keep these tests both fast and simple.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AUTOMATIC_WAIT_MS,
  classifyHttpFailure,
  createRealClock,
  isRetryableReadError,
  parseRetryAfterSeconds,
  toUpstreamErrorDetail,
  withReadRetry,
} from '../../src/opencode/retry.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

// ---------------------------------------------------------------------------
// parseRetryAfterSeconds
// ---------------------------------------------------------------------------

test('parseRetryAfterSeconds: parses delta-seconds', () => {
  assert.equal(parseRetryAfterSeconds('120', 0), 120);
  assert.equal(parseRetryAfterSeconds('0', 0), 0);
  assert.equal(parseRetryAfterSeconds(' 42 ', 0), 42);
});

test('parseRetryAfterSeconds: parses an HTTP-date relative to the injected wall clock', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const future = new Date(now + 42_000).toUTCString();
  assert.equal(parseRetryAfterSeconds(future, now), 42);
});

test('parseRetryAfterSeconds: a past HTTP-date clamps to 0 rather than going negative', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const past = new Date(now - 5_000).toUTCString();
  assert.equal(parseRetryAfterSeconds(past, now), 0);
});

test('parseRetryAfterSeconds: absent/empty/invalid/negative values return undefined (never throw)', () => {
  assert.equal(parseRetryAfterSeconds(null, 0), undefined);
  assert.equal(parseRetryAfterSeconds(undefined, 0), undefined);
  assert.equal(parseRetryAfterSeconds('', 0), undefined);
  assert.equal(parseRetryAfterSeconds('   ', 0), undefined);
  assert.equal(parseRetryAfterSeconds('not-a-number-or-date', 0), undefined);
  assert.equal(parseRetryAfterSeconds('-5', 0), undefined);
  assert.equal(parseRetryAfterSeconds('1.5', 0), undefined); // not delta-seconds (not all-digits) and not a valid date
});

test('parseRetryAfterSeconds: an oversized-but-finite delta-seconds value is returned as-is, never overflowed', () => {
  // ~3.17 years: "recognizable" per design §C, large enough that the retry loop must suppress
  // automatic retry (MAX_AUTOMATIC_WAIT_MS) rather than this function rejecting it outright.
  assert.equal(parseRetryAfterSeconds('99999999', 0), 99999999);
});

// ---------------------------------------------------------------------------
// isRetryableReadError / classifyHttpFailure
// ---------------------------------------------------------------------------

test('isRetryableReadError: transient statuses and ProtocolError are retryable', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryableReadError(new OpencodeHttpError('x', status, 'HttpError')), true, `status ${status}`);
  }
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 200, 'ProtocolError')), true);
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 0, 'TimeoutError')), true);
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 0, 'NetworkError')), true);
});

test('isRetryableReadError: cancellation, redirects, auth failures, ordinary 4xx, and oversized-at-same-size are never retried', () => {
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 0, 'AbortError')), false);
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 0, 'RedirectError')), false);
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 401, 'HttpError')), false);
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 403, 'HttpError')), false);
  for (const status of [400, 404, 409, 422]) {
    assert.equal(isRetryableReadError(new OpencodeHttpError('x', status, 'BadRequest')), false, `status ${status}`);
  }
  assert.equal(isRetryableReadError(new OpencodeHttpError('x', 200, 'ResponseTooLarge')), false);
  assert.equal(isRetryableReadError(new Error('not an OpencodeHttpError')), false);
});

test('classifyHttpFailure / OpencodeHttpError.classification: overloaded/degraded/protocol buckets', () => {
  for (const status of [429, 503, 529]) {
    assert.equal(classifyHttpFailure(status, 'HttpError'), 'overloaded');
    assert.equal(new OpencodeHttpError('x', status, 'HttpError').classification, 'overloaded');
  }
  for (const status of [408, 500, 502, 504]) {
    assert.equal(classifyHttpFailure(status, 'HttpError'), 'degraded');
  }
  assert.equal(classifyHttpFailure(0, 'TimeoutError'), 'degraded');
  assert.equal(classifyHttpFailure(0, 'NetworkError'), 'degraded');
  assert.equal(classifyHttpFailure(200, 'ProtocolError'), 'protocol');
  assert.equal(classifyHttpFailure(404, 'NotFoundError'), undefined);
  assert.equal(classifyHttpFailure(0, 'AbortError'), undefined);
});

// ---------------------------------------------------------------------------
// withReadRetry
// ---------------------------------------------------------------------------

const clock = createRealClock();

test('withReadRetry: succeeds on the first attempt without any retry bookkeeping', async () => {
  let calls = 0;
  const result = await withReadRetry(
    async () => {
      calls += 1;
      return 'ok';
    },
    { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withReadRetry: retries a transient failure up to maxAttempts, then rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('overloaded', 503, 'HttpError');
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('withReadRetry: maxAttempts=1 (config minimum) never retries', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('overloaded', 503, 'HttpError');
      },
      { maxAttempts: 1, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
    ),
  );
  assert.equal(calls, 1);
});

test('withReadRetry: maxAttempts is clamped to at most 3 even if a caller passes more', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('overloaded', 503, 'HttpError');
      },
      { maxAttempts: 10, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
    ),
  );
  assert.equal(calls, 3);
});

test('withReadRetry: succeeds after a transient failure within the attempt budget', async () => {
  let calls = 0;
  const result = await withReadRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new OpencodeHttpError('overloaded', 503, 'HttpError');
      return 'recovered';
    },
    { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('withReadRetry: a non-retryable failure is rethrown after exactly one attempt', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('nope', 404, 'NotFoundError');
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 404);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('withReadRetry: a caller cancellation (AbortError) is never retried', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('cancelled', 0, 'AbortError');
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000 },
    ),
  );
  assert.equal(calls, 1);
});

test('withReadRetry: mutations must never be wrapped — a non-idempotent caller opts out entirely by not using this helper', () => {
  // withReadRetry has no notion of "mutation" — it retries ANY retryable failure its `attempt`
  // callback raises. Design §C's "mutations are never retried" is enforced by never calling this
  // helper (or *WithRetry on the OpencodeApi) for createSession/promptAsync/abort/deleteSession/
  // archiveSession/replyPermission/rejectQuestion/disposeInstance — see http-retry.test.ts's
  // "zero retries for every mutation" coverage of the actual OpencodeApi surface.
  assert.equal(typeof withReadRetry, 'function');
});

test('withReadRetry: a valid Retry-After is honoured as a lower bound (plus jitter) before the next attempt', async () => {
  let calls = 0;
  const startedAt = Date.now();
  const result = await withReadRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new OpencodeHttpError('overloaded', 503, 'HttpError', undefined, 1); // retryAfterSeconds=1
      return 'ok';
    },
    { maxAttempts: 2, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.ok(elapsedMs >= 990, `expected to honour the 1s Retry-After lower bound, took ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2000, `expected close to the 1s lower bound (jitter capped at 250ms), took ${elapsedMs}ms`);
});

test('withReadRetry: a Retry-After exceeding MAX_AUTOMATIC_WAIT_MS (3600s) returns the error without retrying early', async () => {
  let calls = 0;
  const secondsOver = Math.ceil(MAX_AUTOMATIC_WAIT_MS / 1000) + 1;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('overloaded', 503, 'HttpError', undefined, secondsOver);
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 60_000, clock, requestTimeoutMs: 2000 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.retryAfterSeconds, secondsOver);
      return true;
    },
  );
  assert.equal(calls, 1);
});

// P3-6: this file's own MAX_AUTOMATIC_WAIT_MS is 3600s, not the 120s an earlier (lower) ceiling
// used — this proves a Retry-After comfortably past a former 120s cutoff, but still within the
// current 3600s one, is honoured (retried, not returned early) when the deadline allows it. Real
// timers would make waiting out 200s far too slow, so this uses a FakeClock instead of the real
// one the rest of this file deliberately prefers (see the file header comment).
test('withReadRetry: a Retry-After longer than 120s but within MAX_AUTOMATIC_WAIT_MS (3600s) is honoured when the deadline allows', async () => {
  const fake = new FakeClock();
  let calls = 0;
  const retryAfterSeconds = 200; // > 120s (a former, lower ceiling), well within today's 3600s one
  const promise = withReadRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new OpencodeHttpError('overloaded', 503, 'HttpError', undefined, retryAfterSeconds);
      return 'ok';
    },
    { maxAttempts: 2, deadlineAt: fake.monotonicNow() + 3_600_000, clock: fake, requestTimeoutMs: 2000, random: () => 0 },
  );
  // Flush microtasks so the first attempt's rejection is handled and the Retry-After sleep is
  // actually scheduled against the fake clock before advancing it.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(fake.pendingJobs(), 1, 'the Retry-After sleep must already be scheduled');
  fake.tick(retryAfterSeconds * 1000 + 250);
  const result = await promise;
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withReadRetry: an invalid/absent Retry-After falls back to the default jittered backoff (still retries)', async () => {
  let calls = 0;
  const result = await withReadRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new OpencodeHttpError('overloaded', 503, 'HttpError'); // no retryAfterSeconds
      return 'ok';
    },
    { maxAttempts: 2, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, random: () => 0 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withReadRetry: does not retry when the computed delay would exceed the remaining operation deadline', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        throw new OpencodeHttpError('overloaded', 503, 'HttpError');
      },
      // random() => 1 makes the r=1 jittered delay ~250ms, comfortably more than the 10ms deadline
      // budget below — the retry loop must return the error immediately, not truncate the wait.
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 10, clock, requestTimeoutMs: 2000, random: () => 1 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('withReadRetry: a deadline already exhausted before the first attempt throws without calling attempt', async () => {
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        return 'unreachable';
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() - 1, clock, requestTimeoutMs: 2000 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('withReadRetry: each attempt timeoutMs is capped by the remaining shared operation deadline', async () => {
  const seenTimeouts: number[] = [];
  await withReadRetry(
    async ({ timeoutMs }) => {
      seenTimeouts.push(timeoutMs);
      return 'ok';
    },
    { maxAttempts: 1, deadlineAt: clock.monotonicNow() + 40, clock, requestTimeoutMs: 5000 },
  );
  assert.equal(seenTimeouts.length, 1);
  assert.ok(seenTimeouts[0]! <= 40, `expected timeoutMs capped near the 40ms deadline budget, got ${seenTimeouts[0]}`);
  assert.ok(seenTimeouts[0]! > 0);
});

test('withReadRetry: cancellation during the backoff sleep rejects immediately with AbortError, without waiting out the delay', async () => {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();
  const promise = withReadRetry(
    async () => {
      calls += 1;
      throw new OpencodeHttpError('overloaded', 503, 'HttpError');
    },
    {
      maxAttempts: 3,
      deadlineAt: clock.monotonicNow() + 5000,
      clock,
      requestTimeoutMs: 2000,
      signal: controller.signal,
      random: () => 1, // r=1 jittered delay ~250ms; we abort at ~10ms, well before it would fire.
    },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof OpencodeHttpError);
    assert.equal(err.errorName, 'AbortError');
    return true;
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(calls, 1, 'must not have started a second attempt after cancellation');
  assert.ok(elapsedMs < 200, `expected the sleep to be cut short by cancellation, took ${elapsedMs}ms`);
});

test('withReadRetry: an already-aborted signal fails fast without calling attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    withReadRetry(
      async () => {
        calls += 1;
        return 'unreachable';
      },
      { maxAttempts: 3, deadlineAt: clock.monotonicNow() + 5000, clock, requestTimeoutMs: 2000, signal: controller.signal },
    ),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'AbortError');
      return true;
    },
  );
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// toUpstreamErrorDetail
// ---------------------------------------------------------------------------

test('toUpstreamErrorDetail: bounds name/message and derives retryable/condition/statusCode', () => {
  const detail = toUpstreamErrorDetail(new OpencodeHttpError('busy', 503, 'HttpError', undefined, 5));
  assert.equal(detail.name, 'HttpError');
  assert.equal(detail.message, 'busy');
  assert.equal(detail.statusCode, 503);
  assert.equal(detail.retryable, true);
  assert.equal(detail.retryAfterSeconds, 5);
  assert.equal(detail.condition, 'MODEL_OVERLOADED');
});

test('toUpstreamErrorDetail: 502/504 are transient but never MODEL_OVERLOADED', () => {
  for (const status of [502, 504]) {
    const detail = toUpstreamErrorDetail(new OpencodeHttpError('x', status, 'HttpError'));
    assert.equal(detail.retryable, true);
    assert.equal(detail.condition, undefined, `status ${status}`);
  }
});

test('toUpstreamErrorDetail: an ordinary 4xx has no statusCode-derived retryable and no condition', () => {
  const detail = toUpstreamErrorDetail(new OpencodeHttpError('bad', 400, 'BadRequest'));
  assert.equal(detail.statusCode, 400);
  assert.equal(detail.retryable, undefined);
  assert.equal(detail.condition, undefined);
});

test('toUpstreamErrorDetail: status 0 (network/timeout/abort) omits statusCode', () => {
  const detail = toUpstreamErrorDetail(new OpencodeHttpError('x', 0, 'NetworkError'));
  assert.equal(detail.statusCode, undefined);
  assert.equal(detail.retryable, true);
});

test('toUpstreamErrorDetail: never exposes the response body, and bounds oversized name/message', () => {
  const longName = 'x'.repeat(500);
  const longMessage = 'y'.repeat(1000);
  const error = new OpencodeHttpError(longMessage, 500, longName, { secret: 'should never appear' });
  const detail = toUpstreamErrorDetail(error);
  assert.equal(detail.name.length, 200);
  assert.equal(detail.message.length, 500);
  assert.ok(!('body' in detail));
  assert.ok(!JSON.stringify(detail).includes('secret'));
});
