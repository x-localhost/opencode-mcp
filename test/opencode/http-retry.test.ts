// Integration tests for the design §C bounded read-retry surface exposed by
// createOpencodeApiWithRetry: exact GET attempt counts per status, zero retries for every
// mutation, and deadline-sharing across the message-page fallback ladder and the outer retry.
//
// Uses a small local queued `fetch` (one Response per call, in order) rather than the shared
// fake-opencode-server: these tests need precise control over a SEQUENCE of statuses per call,
// which the shared fake server does not script.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpencodeApi, createOpencodeApiWithRetry } from '../../src/opencode/http.ts';
import { createRealClock } from '../../src/opencode/retry.ts';
import { OpencodeHttpError } from '../../src/types.ts';

import type { Logger } from '../../src/types.ts';
import type { OpencodeApiRetryable } from '../../src/opencode/http.ts';

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// `deadlineAt` is a MONOTONIC deadline (design §C), not an epoch timestamp — every test below
// must compute it from this SAME clock instance (also injected into `makeApi`), never
// `Date.now()`, or the deadline silently stops binding (createOpencodeApiWithRetry's own default
// clock uses `performance.now()`, which starts near 0, not near `Date.now()`'s epoch value).
const clock = createRealClock();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface QueuedFetch {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string }>;
}

/** Returns each queued Response in order; throws (a plain Error, surfacing as a real fetch-layer
 * failure) once the queue is exhausted, so an unexpected extra attempt fails the test loudly. */
function queueFetch(responses: Response[]): QueuedFetch {
  const calls: Array<{ method: string; url: string }> = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: String(init?.method ?? 'GET'), url: String(input) });
    const res = responses[i];
    i += 1;
    if (!res) throw new Error(`queueFetch: no more queued responses (call #${calls.length})`);
    return res;
  };
  return { fetch: fetchImpl, calls };
}

function makeApi(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof createOpencodeApiWithRetry>[0]> = {}): OpencodeApiRetryable {
  return createOpencodeApiWithRetry({
    baseUrl: 'http://127.0.0.1:1/',
    username: 'opencode',
    requestTimeoutMs: 2000,
    logger: nullLogger(),
    fetch: fetchImpl,
    clock,
    random: () => 0, // deterministic, ~instant jittered backoff for attempt-count tests
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// exact GET attempt counts per status
// ---------------------------------------------------------------------------

for (const status of [408, 429, 500, 502, 503, 504, 529]) {
  test(`sessionStatusWithRetry: a persistent HTTP ${status} is retried up to maxAttempts, then rethrown`, async () => {
    const { fetch: fetchImpl, calls } = queueFetch([
      jsonResponse(status, { name: 'UnknownError', data: { message: 'busy' } }),
      jsonResponse(status, { name: 'UnknownError', data: { message: 'busy' } }),
      jsonResponse(status, { name: 'UnknownError', data: { message: 'busy' } }),
    ]);
    const api = makeApi(fetchImpl);
    await assert.rejects(
      api.sessionStatusWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 3 }),
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.status, status);
        return true;
      },
    );
    assert.equal(calls.length, 3, `expected exactly 3 attempts for status ${status}`);
  });
}

test('sessionStatusWithRetry: succeeds on the 2nd attempt out of a 3-attempt budget (exactly 2 requests)', async () => {
  const { fetch: fetchImpl, calls } = queueFetch([
    jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }),
    jsonResponse(200, { ses_1: { type: 'busy' } }),
  ]);
  const api = makeApi(fetchImpl);
  const result = await api.sessionStatusWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 3 });
  assert.deepEqual(result, { ses_1: { type: 'busy' } });
  assert.equal(calls.length, 2);
});

for (const [name, status, errorName] of [
  ['401 (auth failure)', 401, 'HttpError'],
  ['403 (auth failure)', 403, 'HttpError'],
  ['400 (ordinary 4xx)', 400, 'BadRequest'],
  ['409 (ordinary 4xx)', 409, 'ConflictError'],
] as const) {
  test(`sessionStatusWithRetry: ${name} is never retried, even with attempts remaining`, async () => {
    const { fetch: fetchImpl, calls } = queueFetch([jsonResponse(status, { name: errorName, data: { message: 'no' } })]);
    const api = makeApi(fetchImpl);
    await assert.rejects(
      api.sessionStatusWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 3 }),
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.status, status);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
}

test('healthWithRetry/listPermissionsWithRetry/listQuestionsWithRetry/warmInstanceWithRetry all retry a persistent 503 up to maxAttempts', async () => {
  const scenarios: Array<[string, (api: OpencodeApiRetryable) => Promise<unknown>]> = [
    ['health', (api) => api.healthWithRetry({ deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 2 })],
    ['listPermissions', (api) => api.listPermissionsWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 2 })],
    ['listQuestions', (api) => api.listQuestionsWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 2 })],
  ];
  for (const [name, call] of scenarios) {
    const { fetch: fetchImpl, calls } = queueFetch([
      jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }),
      jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }),
    ]);
    const api = makeApi(fetchImpl);
    await assert.rejects(call(api), OpencodeHttpError, name);
    assert.equal(calls.length, 2, name);
  }
  // warmInstance makes two GETs (provider, then agent) per attempt — assert both attempts retried.
  {
    const { fetch: fetchImpl, calls } = queueFetch([
      jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }), // attempt 1: /provider fails
      jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }), // attempt 2: /provider fails again
    ]);
    const api = makeApi(fetchImpl);
    await assert.rejects(api.warmInstanceWithRetry('/work', { deadlineAt: clock.monotonicNow() + 5000, maxAttempts: 2 }), OpencodeHttpError);
    assert.equal(calls.length, 2);
  }
});

// ---------------------------------------------------------------------------
// zero retries for every mutation
// ---------------------------------------------------------------------------

test('mutations have no *WithRetry variant at all', () => {
  const api = makeApi(queueFetch([]).fetch) as unknown as Record<string, unknown>;
  for (const name of [
    'createSessionWithRetry',
    'promptAsyncWithRetry',
    'abortWithRetry',
    'deleteSessionWithRetry',
    'archiveSessionWithRetry',
    'replyPermissionWithRetry',
    'rejectQuestionWithRetry',
    'disposeInstanceWithRetry',
  ]) {
    assert.equal(api[name], undefined, `${name} must not exist`);
  }
});

test('mutations are never retried on a transient 503: each makes exactly one HTTP request', async () => {
  const scenarios: Array<[string, (api: OpencodeApiRetryable) => Promise<unknown>]> = [
    ['createSession', (api) => api.createSession('/work', { title: 't' })],
    ['promptAsync', (api) => api.promptAsync('ses_1', { parts: [{ type: 'text', text: 'hi' }] })],
    ['abort', (api) => api.abort('ses_1')],
    ['deleteSession', (api) => api.deleteSession('ses_1')],
    ['archiveSession', (api) => api.archiveSession('ses_1', 1)],
    ['replyPermission', (api) => api.replyPermission('/work', 'per_1', 'reject')],
    ['rejectQuestion', (api) => api.rejectQuestion('/work', 'que_1')],
    ['disposeInstance', (api) => api.disposeInstance('/work')],
  ];
  for (const [name, call] of scenarios) {
    const { fetch: fetchImpl, calls } = queueFetch([jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } })]);
    const api = makeApi(fetchImpl);
    await assert.rejects(call(api), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError, name);
      return true;
    });
    assert.equal(calls.length, 1, `${name}: mutations must never be retried, even on a transient 503`);
  }
});

// ---------------------------------------------------------------------------
// deadline sharing across page-size fallback and the outer retry
// ---------------------------------------------------------------------------

function oversizedMessagePageResponse(): Response {
  const bytes = new Uint8Array(33 * 1024 * 1024); // > the 32 MiB message-page cap
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('messagesWithRetry: the page-size fallback ladder and the outer transient retry share ONE operation deadline', async () => {
  // Attempt 1 (one withReadRetry "attempt"): limit=100 overflows -> falls back to limit=25 inside
  // the SAME messages() call -> that second request comes back 503. Two raw HTTP requests, but
  // only ONE outer retry attempt. With almost no deadline budget left afterwards, the outer retry
  // (attempt 2) must never happen: exactly 2 total requests.
  const { fetch: fetchImpl, calls } = queueFetch([
    oversizedMessagePageResponse(),
    jsonResponse(503, { name: 'UnknownError', data: { message: 'busy' } }),
  ]);
  const api = makeApi(fetchImpl, { random: () => 1 }); // maximize jitter (250ms cap for r=1) so any retry delay overshoots the tiny remaining budget
  await assert.rejects(
    api.messagesWithRetry('ses_1', { limit: 100 }, { deadlineAt: clock.monotonicNow() + 150, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(calls.length, 2, 'the ladder fallback and the failed retry must share one deadline (no extra outer attempt)');
});

test('sequential warm GETs and page fallback cannot complete beyond one deadline', async () => {
  for (const [name, responses, call] of [
    ['warm', [jsonResponse(200, {}), jsonResponse(200, {})],
      (api: OpencodeApiRetryable, deadlineAt: number) => api.warmInstanceWithRetry!('/work', { deadlineAt, maxAttempts: 1 })],
    ['fallback', [oversizedMessagePageResponse(), jsonResponse(200, [])],
      (api: OpencodeApiRetryable, deadlineAt: number) => api.messagesWithRetry!('ses_1', { limit: 100 }, { deadlineAt, maxAttempts: 1 })],
  ] as const) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      const response = responses[calls++];
      await new Promise((resolve) => setTimeout(resolve, 85));
      if (!response) throw new Error('unexpected extra GET');
      return response;
    };
    const api = makeApi(fetchImpl);
    await assert.rejects(call(api, clock.monotonicNow() + 130), (error: unknown) => {
      assert.ok(error instanceof OpencodeHttpError, name);
      assert.equal(error.errorName, 'TimeoutError', name);
      return true;
    });
    assert.equal(calls, 2, name);
  }
});

test('a body reset after response headers records its transport phase', async () => {
  const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull() { throw new Error('read ECONNRESET'); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const api = makeApi(fetchImpl);
  await assert.rejects(api.health(), (error: unknown) => {
    assert.ok(error instanceof OpencodeHttpError);
    assert.equal(error.status, 0);
    assert.equal(error.responseReceived, true);
    return true;
  });
});

// ---------------------------------------------------------------------------
// createOpencodeApi (plain) is unchanged for existing callers (src/opencode/connection.ts)
// ---------------------------------------------------------------------------

test('createOpencodeApi (plain) behaves identically to before: ordinary calls still work', async () => {
  const { fetch: fetchImpl } = queueFetch([jsonResponse(200, { healthy: true, version: 'v' })]);
  const api = createOpencodeApi({ baseUrl: 'http://x/', username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger(), fetch: fetchImpl });
  assert.deepEqual(await api.health(), { healthy: true, version: 'v' });
});
