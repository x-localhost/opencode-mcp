// FZ (release fixes, 0.2.0): two P2 fixes.
// #1 — SESSION_CAPACITY: a concurrent burst of starts must not all observe the same
//      tracked-session count and exceed OPENCODE_MCP_MAX_SESSIONS; capacity is reserved
//      synchronously before the first await, transferred into the registry on success, and
//      released on every failure/abort path before registry.add.
// #2 — a 200 response with an unusable body (or any other unexpected error raised after the
//      create POST was dispatched) must not free the request-id: only a confirmed 4xx rejection
//      (or a pre-POST validation failure) proves the create never happened upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config } from '../../src/types.ts';

const baseConfig = {
  mode: 'attach',
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 1000,
  heartbeatMs: 100,
  statusPollMs: 100,
  sseStallMs: 1000,
  cleanupTimeoutMs: 500,
  maxOutputChars: 2000,
  maxSessions: 256,
  endAction: 'delete',
  onExit: 'abort',
} as Config;

const ctx = (): CallContext => ({ signal: new AbortController().signal });
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({
    config: { ...baseConfig, ...overrides } as Config,
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { engine, connection, clock };
}
// ---------------------------------------------------------------------------
// #1 concurrent starts vs OPENCODE_MCP_MAX_SESSIONS
// ---------------------------------------------------------------------------

test('FZ #1: a concurrent burst of starts cannot both observe room under the cap; a reservation from a failed create is released before registry.add', async () => {
  const { engine, connection } = setup({ maxSessions: 1 });
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const originalCreate = connection.api.createSession.bind(connection.api);
  // Only the FIRST createSession call is gated (and then fails, 502). A start wrongly admitted
  // past the cap would reach a SECOND, un-gated createSession call that succeeds immediately —
  // so a pre-fix bypass shows up as a fast, clean assertion failure instead of a real deadlock.
  let createCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  connection.api.createSession = async (directory, body) => {
    createCalls++;
    if (createCalls === 1) {
      await firstGate;
      throw new OpencodeHttpError('bad gateway', 502, 'HttpError');
    }
    return originalCreate(directory, body);
  };

  const first = engine.start({ prompt: 'a', waitSeconds: 0 }, ctx());
  void first.catch(() => {});
  await flush(); // first reaches acquire() + createSession, now gated: capacity is already reserved

  await assert.rejects(engine.start({ prompt: 'b', waitSeconds: 0 }, ctx()), { code: 'SESSION_CAPACITY' });
  assert.equal(createCalls, 1, 'a start rejected over capacity must never reach createSession');

  releaseFirst!(); // the FIRST start's create now fails (502), before registry.add
  await assert.rejects(first, { code: 'UPSTREAM_ERROR' });

  // The reservation held by the failed first start must be released: a fresh start now succeeds
  // without hitting the (still-empty) cap.
  const started = await engine.start({ prompt: 'c', waitSeconds: 0 }, ctx());
  assert.ok(started.sessionId);
});

// ---------------------------------------------------------------------------
// #2 an error after the create POST was dispatched must pin the request-id, not free it
// ---------------------------------------------------------------------------

test('FZ #2: a raw (non-HTTP) error from createSession after the POST dispatched still pins the request-id as unconfirmed', async () => {
  const { engine, connection } = setup();
  let calls = 0;
  connection.api.createSession = async () => {
    calls++;
    // Models exactly what an un-validated 200-with-unusable-body used to throw before the
    // adapter fix: a raw TypeError, not an OpencodeHttpError the engine could classify.
    throw new TypeError("Cannot read properties of null (reading 'id')");
  };
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'raw-error' }, ctx()), {
    code: 'OPENCODE_UNAVAILABLE',
  });
  // A retry with the same key must never dispatch a second createSession: the outcome upstream is
  // unknown (the create may have actually succeeded), so the key is pinned, not freed.
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'raw-error' }, ctx()), {
    code: 'REQUEST_UNCONFIRMED',
  });
  assert.equal(calls, 1, 'the duplicate retry must never dispatch a second createSession');
});

test('FZ #2: a 200 response whose body is unusable (adapter-mapped ProtocolError) pins the request-id; a retry never dispatches a second createSession', async () => {
  const { engine, connection } = setup();
  let calls = 0;
  connection.api.createSession = async () => {
    calls++;
    // Mirrors src/opencode/http.ts's createSession: a 2xx whose parsed body is null/non-object or
    // otherwise carries no valid id is normalized to an OpencodeHttpError('ProtocolError') instead
    // of throwing a raw TypeError. The POST plainly succeeded (status 200), so the outcome
    // upstream is ambiguous, not a confirmed rejection.
    throw new OpencodeHttpError(
      'OpenCode returned a session with a malformed id (empty, oversized, non-printable, or containing a path separator)',
      200,
      'ProtocolError',
    );
  };
  await assert.rejects(engine.start({ prompt: 'y', requestId: 'unusable-body' }, ctx()), {
    code: 'UPSTREAM_ERROR',
  });
  await assert.rejects(engine.start({ prompt: 'y', requestId: 'unusable-body' }, ctx()), {
    code: 'REQUEST_UNCONFIRMED',
  });
  assert.equal(calls, 1, 'the duplicate retry must never dispatch a second createSession');
});
