// FY-2: session capacity, ambiguous-create pinning, unified duplicate
// waits, compactResult identifier/surrogate safety, statusMany output refresh, and the
// delayed-abort quarantine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { compactResult, summarizeInterval } from '../../src/core/result.ts';
import { refreshOutputMeta } from '../../src/core/output-store.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, TurnResult } from '../../src/types.ts';

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
const count = (connection: FakeConnection, method: string) =>
  connection.api.calls.filter((c) => c.method === method).length;

// ---------------------------------------------------------------------------
// #1 OPENCODE_MCP_MAX_SESSIONS / SESSION_CAPACITY
// ---------------------------------------------------------------------------

test('FY-2 #1: SESSION_CAPACITY rejects a new start before any upstream mutation, never evicts tracked sessions, and frees the request key', async () => {
  const { engine, connection } = setup({ maxSessions: 2 });
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    history.push({ info: { id: `m${history.length + 1}`, sessionID: id, role: 'user', time: { created: history.length + 1 } }, parts: [] });
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const a = await engine.start({ prompt: 'a', waitSeconds: 0 }, ctx());
  const b = await engine.start({ prompt: 'b', waitSeconds: 0 }, ctx());
  const before = count(connection, 'createSession');
  await assert.rejects(engine.start({ prompt: 'c', requestId: 'cap-3', waitSeconds: 0 }, ctx()), {
    code: 'SESSION_CAPACITY',
  });
  assert.equal(count(connection, 'createSession'), before, 'no upstream mutation for a rejected-over-capacity start');
  const list = await engine.list();
  assert.deepEqual(
    list.sessions.map((s) => s.sessionId).sort(),
    [a.sessionId, b.sessionId].sort(),
    'neither active session was evicted to make room',
  );
  // Pure pre-POST validation failure: the request-id is freed, not pinned.
  await engine.end({ sessionId: a.sessionId }, ctx());
  const c = await engine.start({ prompt: 'c', requestId: 'cap-3', waitSeconds: 0 }, ctx());
  assert.equal(c.request?.replayed, false);
});

test('FY-2 #1: filesChanged is capped at 200 entries in the engine result', () => {
  const files = Array.from({ length: 250 }, (_, i) => `/repo/file${i}.ts`);
  const messages: OcMessage[] = [
    {
      info: { id: 'm1', sessionID: 'ses_1', role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' },
      parts: [
        { id: 'p1', sessionID: 'ses_1', messageID: 'm1', type: 'patch', files },
        { id: 'p2', sessionID: 'ses_1', messageID: 'm1', type: 'text', text: 'done' },
      ],
    },
  ];
  const result = summarizeInterval(messages, '/repo', 20000, { status: 'completed' });
  assert.equal(result.filesChanged.length, 200);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------
// #2 Ambiguous create pinning
// ---------------------------------------------------------------------------

test('FY-2 #2: only a confirmed 4xx frees the request key; status 0/5xx/2xx-malformed pin it', async () => {
  const { engine, connection } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const originalCreate = connection.api.createSession.bind(connection.api);

  // 400: a confirmed rejection frees the key for a corrected retry.
  connection.api.createSession = async () => {
    throw new OpencodeHttpError('bad request', 400, 'HttpError');
  };
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'amb-400' }, ctx()), { code: 'UPSTREAM_ERROR' });
  connection.api.createSession = originalCreate;
  const after400 = await engine.start({ prompt: 'x', requestId: 'amb-400', waitSeconds: 0 }, ctx());
  assert.equal(after400.request?.replayed, false, 'a fresh, non-replayed session was created by the retry');

  // 502: forwarded but the outcome upstream is unknown — pins the key; a duplicate never retries.
  let calls502 = 0;
  connection.api.createSession = async () => {
    calls502++;
    throw new OpencodeHttpError('bad gateway', 502, 'HttpError');
  };
  await assert.rejects(engine.start({ prompt: 'y', requestId: 'amb-502' }, ctx()), { code: 'UPSTREAM_ERROR' });
  await assert.rejects(engine.start({ prompt: 'y', requestId: 'amb-502' }, ctx()), { code: 'REQUEST_UNCONFIRMED' });
  assert.equal(calls502, 1);

  // 200 with a malformed/invalid body (ProtocolError): the POST plainly succeeded — pins the key.
  let calls200 = 0;
  connection.api.createSession = async () => {
    calls200++;
    throw new OpencodeHttpError('malformed session id', 200, 'ProtocolError');
  };
  await assert.rejects(engine.start({ prompt: 'z', requestId: 'amb-200' }, ctx()), { code: 'UPSTREAM_ERROR' });
  await assert.rejects(engine.start({ prompt: 'z', requestId: 'amb-200' }, ctx()), { code: 'REQUEST_UNCONFIRMED' });
  assert.equal(calls200, 1);
});

// ---------------------------------------------------------------------------
// #3 Duplicate waits: one monotonic deadline for the whole call
// ---------------------------------------------------------------------------

test('FY-2 #3: a duplicate call\'s wait-seconds bounds the WHOLE call, not each phase separately (FakeClock)', async () => {
  const { engine, connection, clock } = setup({ startupTimeoutMs: 10_000 });
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const originalCreate = connection.api.createSession.bind(connection.api);
  let releaseCreate: () => void = () => {};
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  connection.api.createSession = async (directory, body) => {
    await createGate;
    return originalCreate(directory, body);
  };

  const owner = engine.start({ prompt: 'p', requestId: 'dup-wait', waitSeconds: 0 }, ctx());
  await flush(); // owner reaches reserveKey + acquire + createSession, now gated

  const duplicate = engine.start({ prompt: 'p', requestId: 'dup-wait', waitSeconds: 5 }, ctx());
  await flush();
  clock.tick(3000); // 3 of the 5 promised seconds elapse while the ORIGINAL admission is gated
  await flush();

  releaseCreate(); // original admission proceeds; the reservation settles at fake t=3000
  await flush();

  let resolved = false;
  void duplicate.then(() => {
    resolved = true;
  });
  await flush();
  clock.tick(1999); // total elapsed 4999ms of the original 5000ms budget
  await flush();
  assert.equal(resolved, false, 'must not resolve before the ORIGINAL 5s deadline');

  clock.tick(1); // total elapsed exactly 5000ms
  await flush();
  assert.equal(
    resolved,
    true,
    'must resolve once the ORIGINAL 5s deadline is reached — not 5s after admission separately finished (the restart bug)',
  );

  const result = await duplicate;
  assert.equal(result.status, 'running');
  await owner;
});

// ---------------------------------------------------------------------------
// #4 compactResult: never shorten identifiers; every slice is surrogate-safe
// ---------------------------------------------------------------------------

function baseTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    kind: 'turn',
    threadId: 'ses_1',
    sessionId: 'ses_1',
    turnId: 'ses_1#1',
    turn: 1,
    status: 'completed',
    executionState: 'stopped',
    cleanup: 'complete',
    content: 'hello',
    directory: '/repo',
    filesChanged: [],
    toolCalls: [],
    toolCallCount: 0,
    pendingApprovals: [],
    elapsedMs: 10,
    truncated: false,
    hint: 'Use opencode-reply to continue or opencode-end to finish.',
    ...overrides,
  };
}

/** A lone surrogate half has no valid UTF-8 encoding; WHATWG TextEncoder replaces it with U+FFFD,
 * so a round trip through it changes the string. A well-formed string round-trips exactly. */
function hasDanglingSurrogate(value: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(value)) !== value;
}

test('FY-2 #4: compactResult omits (never truncates) an over-long approval id or session id', () => {
  const longId = 'p'.repeat(250);
  const result = baseTurnResult({
    pendingApprovals: [
      { id: longId, sessionId: 'ses_1', permission: 'bash', patterns: ['echo'] },
      { id: 'per_short', sessionId: longId, permission: 'bash', patterns: ['echo'] },
      { id: 'per_ok', sessionId: 'ses_1', permission: 'bash', patterns: ['echo'] },
    ],
  });
  const compacted = compactResult(result);
  assert.deepEqual(compacted.pendingApprovals.map((a) => a.id), ['per_ok']);
  assert.equal(compacted.truncated, true);
});

test('FY-2 #4: compactResult never leaves a dangling surrogate half after truncating content/hint', () => {
  const longContent = 'a'.repeat(4095) + '\u{20000}'; // cut at 4096 lands mid-pair
  const longHint = 'b'.repeat(399) + '\u{20000}';
  const result = baseTurnResult({ content: longContent, hint: longHint });
  const compacted = compactResult(result);
  assert.equal(compacted.content.length, 4095);
  assert.equal(hasDanglingSurrogate(compacted.content), false);
  assert.equal(hasDanglingSurrogate(compacted.hint), false);
});

test('FY-2 #4: an over-long approval id survives the live result and is omitted (not truncated) only in the compacted replay', async () => {
  const { engine, connection } = setup();
  const longId = 'p'.repeat(250);
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
    const request = { id: longId, sessionID: id, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
    connection.api.permissions.set(longId, request);
    connection.api.emit(connection.api.sessions.get(id)!.directory, { type: 'permission.asked', properties: request });
  };
  const started = await engine.start(
    { prompt: 'p', requestId: 'compact-approve', approvalPolicy: 'on-request', waitSeconds: 0 },
    ctx(),
  );
  await flush();
  // An unsolicited abort (item #6) ends the turn WITHOUT opencode-cancel's own leftover-rejection,
  // so the still-pending approval survives into the committed (compacted) result.
  const directory = connection.api.sessions.get(started.sessionId)!.directory;
  connection.api.histories.get(started.sessionId)!.push(
    { info: { id: 'm001', sessionID: started.sessionId, role: 'user', time: { created: 1 } }, parts: [] },
    {
      info: {
        id: 'm002',
        sessionID: started.sessionId,
        role: 'assistant',
        parentID: 'm001',
        time: { created: 2, completed: 2 },
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [],
    },
  );
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit(directory, { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await flush();
  const status = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(status.status, 'cancelled');
  assert.equal(status.pendingApprovals.length, 1);
  assert.equal(status.pendingApprovals[0]?.id, longId, 'the live result never shortens an id');

  const replay = await engine.start(
    { prompt: 'p', requestId: 'compact-approve', approvalPolicy: 'on-request', waitSeconds: 0 },
    ctx(),
  );
  assert.equal(replay.request?.replayed, true);
  assert.equal(replay.pendingApprovals.length, 0, 'an over-long id is omitted, never truncated into an invented id');
  assert.equal(replay.truncated, true);
});

// ---------------------------------------------------------------------------
// #5 statusMany applies refreshOutput() to historical results
// ---------------------------------------------------------------------------

test('FY-2 #5: refreshOutputMeta downgrades a stale cached "retained" once the store has forgotten the turn (artifact AND tombstone both gone)', () => {
  const retained = {
    state: 'retained' as const,
    partial: false,
    answerChars: 12,
    toolCallCount: 0,
    expiresAt: 10_000,
  };
  // fresh === undefined models a tombstone-capacity eviction (output-store.ts's maxTombstones):
  // the store no longer has EITHER the artifact or a tombstone for this turn.
  const refreshedBeforeExpiry = refreshOutputMeta(retained, undefined, 5_000);
  assert.equal(refreshedBeforeExpiry.state, 'unavailable');
  assert.equal(refreshedBeforeExpiry.reason, 'evicted');
  const refreshedAfterExpiry = refreshOutputMeta(retained, undefined, 20_000);
  assert.equal(refreshedAfterExpiry.reason, 'expired');
  // A fresh tombstone/artifact meta always wins outright.
  const fresh = { state: 'unavailable' as const, reason: 'too_large' as const, partial: false, toolCallCount: 0 };
  assert.equal(refreshOutputMeta(retained, fresh, 5_000), fresh);
  // A non-'retained' cached state is already accurate; never reinterpreted.
  const pending = { state: 'pending' as const, partial: true, toolCallCount: 0 };
  assert.equal(refreshOutputMeta(pending, undefined, 5_000), pending);
});

test('FY-2 #5: statusMany reflects the CURRENT output state (evicted, via a live tombstone) instead of a resurrected stale "retained"', async () => {
  const { engine, connection } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const n = history.length + 1;
    const user = `m${String(n).padStart(4, '0')}`;
    const answer = `m${String(n + 1).padStart(4, '0')}`;
    history.push(
      { info: { id: user, sessionID: id, role: 'user', time: { created: n } }, parts: [] },
      {
        info: { id: answer, sessionID: id, role: 'assistant', parentID: user, finish: 'stop', time: { created: n + 1, completed: n + 2 } },
        parts: [{ id: `p${answer}`, sessionID: id, messageID: answer, type: 'text', text: 'done' }],
      },
    );
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
  const target = await engine.start({ prompt: 'target' }, ctx());
  const initial = await engine.statusMany({ ids: [target.sessionId] }, ctx());
  assert.equal(initial.results[0]?.output?.state, 'retained');
  // The output store's default cap is 128 turns GLOBALLY; 128 more turns from other sessions evict
  // (with a tombstone) the target's single retained artifact.
  for (let i = 0; i < 128; i++) await engine.start({ prompt: `filler ${i}` }, ctx());
  const after = await engine.statusMany({ ids: [target.sessionId] }, ctx());
  assert.equal(after.results[0]?.output?.state, 'unavailable');
  assert.equal(after.results[0]?.output?.reason, 'evicted');
});

// ---------------------------------------------------------------------------
// #6 Ambiguous aborts remain quarantined
// ---------------------------------------------------------------------------

test('FY-2 #6: a lost abort response keeps the original turn quarantined and blocks a later reply', async () => {
  const { engine, connection } = setup({ cleanupTimeoutMs: 15 });
  let n = 0;
  connection.api.onPrompt = (id) => {
    n++;
    const user = `m${String(n).padStart(3, '0')}`;
    connection.api.histories.get(id)!.push({ info: { id: user, sessionID: id, role: 'user', time: { created: n } }, parts: [] });
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'first', waitSeconds: 0 }, ctx());

  // opencode-cancel's own abort times out client-side (matching a genuinely unresponsive upstream
  // request), but the real abort is still in flight and will land later, on whatever turn happens
  // to be running then.
  connection.api.lateAbortDelayMs = 80;
  const firstCancel = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(firstCancel.executionState, 'unknown');

  // The original abort may still land. No observation can make a second blind abort safe.
  await assert.rejects(engine.reply({ sessionId: started.sessionId, prompt: 'second' }, ctx()), { code: 'SESSION_BUSY' });
  assert.equal(count(connection, 'abort'), 1);
});

// ---------------------------------------------------------------------------
// #7 ERROR_HINTS wiring sanity (the dedicated MCP hint test lives in test/mcp/fy2-hints.test.ts)
// ---------------------------------------------------------------------------

test('FY-2 #7: REQUEST_PENDING is thrown by a wait-bounded duplicate whose original admission never lands', async () => {
  const { engine, connection, clock } = setup();
  const originalCreate = connection.api.createSession.bind(connection.api);
  connection.api.createSession = async (directory, body) => {
    await new Promise<void>(() => {}); // never resolves
    return originalCreate(directory, body);
  };
  const owner = engine.start({ prompt: 'p', requestId: 'pending-forever' }, ctx());
  void owner.catch(() => {});
  await flush();
  const duplicate = engine.start({ prompt: 'p', requestId: 'pending-forever', waitSeconds: 2 }, ctx());
  await flush();
  clock.tick(2000);
  await assert.rejects(duplicate, { code: 'REQUEST_PENDING' });
});
