// U05: honour the approval window (not the MCP SDK's 60 s default), handle F7 reject cascades,
// never re-prompt an already-answered request, and fail fast (no 600 s stall) when no attached
// call could ever elicit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { Turn } from '../../src/core/turn.ts';
import { EventHub } from '../../src/core/hub.ts';
import { ConnectionHealth } from '../../src/core/connection-health.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import type { TrackedSession } from '../../src/core/registry.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = {
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1000,
  requestTimeoutMs: 30,
  turnTimeoutMs: 60000,
  maxTurnTimeoutMs: 60000,
  approvalTimeoutMs: 1000,
  heartbeatMs: 100,
  statusPollMs: 100,
  sseStallMs: 1000,
  cleanupTimeoutMs: 500,
  maxOutputChars: 2000,
  endAction: 'delete',
  onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const msg = (id: string, role: 'user' | 'assistant', parentID?: string, finish?: string): OcMessage => ({
  info: {
    id,
    sessionID: 'ses_1',
    role,
    parentID,
    finish,
    time: { created: Number(id.slice(1)), ...(finish ? { completed: Number(id.slice(1)) + 1 } : {}) },
  },
  parts: finish ? [{ id: `p${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text: 'done' }] : [],
});
const setup = () => {
  const connection = new FakeConnection(),
    clock = new FakeClock();
  const engine = createEngine({
    config,
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
};
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// (a) F7 reject cascade: a second concurrent ask is never elicited once the first is rejected.
// ---------------------------------------------------------------------------

test('U05a: an F7 reject cascade prevents a second concurrent ask from ever being elicited', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask1 = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo one'],
    metadata: {},
    always: ['*'],
  };
  const ask2 = { ...ask1, id: 'per_2', patterns: ['echo two'] };
  connection.api.permissions.set(ask1.id, ask1);
  connection.api.permissions.set(ask2.id, ask2);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask1 });
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask2 });
  let called = 0;
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => {
        called++;
        return { decision: 'reject', feedback: 'no' };
      },
    },
  );
  await flush();
  assert.equal(called, 1, 'the cascaded second ask must never be elicited');
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'reject',
    ),
  );
  assert.equal(
    connection.api.calls.some((x) => x.method === 'replyPermission' && x.args[1] === 'per_2'),
    false,
    'the cascaded second ask must never be replied to directly by this turn',
  );
  const snapshot = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(snapshot.status, 'running');
  assert.deepEqual(snapshot.pendingApprovals, []);
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (b) A failed post-elicit verification never re-elicits; the cached answer is still delivered.
// ---------------------------------------------------------------------------

test('U05b: a failed verification GET after an answer never re-elicits, and still delivers the cached decision', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  let called = 0;
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => {
        called++;
        // Fails only the upcoming post-elicit verification GET, not the earlier pre-elicit check.
        connection.api.listPermissionsFailure = 1;
        return { decision: 'allow' };
      },
    },
  );
  await flush();
  assert.equal(called, 1, 'no second elicit after a verification failure');
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'once',
    ),
  );
  // P3-6 (core review): without advancing the clock, the poll loop never gets a
  // chance to re-run scanPending/processApprovals, so `called` staying at 1 proved nothing about
  // "never re-elicits". Tick a full poll interval and confirm it still doesn't.
  clock.tick(config.statusPollMs);
  await flush();
  assert.equal(called, 1, 'no second elicit after a later poll cycle either');
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (b2) An 'allow' answered before the deadline must not survive a verification GET that only
// settles after the deadline has passed — approvals never upgrade to 'once' past the deadline.
// ---------------------------------------------------------------------------

test("U05b2: an allow answered before the deadline downgrades to reject when the verification GET only settles after it", async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  const original = connection.api.listPermissions.bind(connection.api);
  let listCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.api.listPermissions = async (directory: string) => {
    listCalls++;
    // Gate only the post-elicit verification GET (the second listPermissions call for this ask);
    // the pre-elicit check must go through so elicit is actually reached.
    if (listCalls === 2) await gate;
    return original(directory);
  };
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => ({ decision: 'allow' }),
    },
  );
  await flush();
  assert.equal(listCalls, 2, 'expected the verification GET to be in flight and gated');
  // The answer was obtained (and cached) well before the deadline; only the verification GET that
  // decides whether to honour it is still gated — advance past the deadline before it settles.
  clock.tick(config.approvalTimeoutMs + 1);
  await flush();
  assert.equal(
    connection.api.calls.some((x) => x.method === 'replyPermission'),
    false,
    'no reply may be sent while the verification GET is still gated',
  );
  release();
  await flush();
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'reject',
    ),
    'an allow answered before the deadline must downgrade to reject once verified after the deadline',
  );
  assert.equal(
    connection.api.calls.some((x) => x.method === 'replyPermission' && x.args[2] === 'once'),
    false,
    'the stale allow must never be honoured once the deadline has passed',
  );
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (c) scanPending never resurrects (or re-elicits) an already-answered permission from a stale list.
// ---------------------------------------------------------------------------

test('U05c: scanPending never re-adds or re-elicits an already-answered permission, even from a stale list', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  let called = 0;
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => {
        called++;
        return { decision: 'allow' };
      },
    },
  );
  await flush();
  assert.equal(called, 1);
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'once',
    ),
  );
  // A directory read captured before the reply landed upstream, but delivered after: simulate the
  // stale list still showing per_1 as pending, and let the poll's scanPending observe it.
  connection.api.permissions.set(ask.id, ask);
  clock.tick(config.statusPollMs);
  await flush();
  assert.equal(called, 1, 'an already-answered request must never be elicited again');
  assert.equal(
    connection.api.calls.filter((x) => x.method === 'replyPermission' && x.args[1] === 'per_1').length,
    1,
    'no second reply for an already-answered request',
  );
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (d) A connection with no elicitation capability rejects immediately, not after the full deadline.
// ---------------------------------------------------------------------------

test('U05d: an attached call flagged elicitationUnsupported rejects immediately without advancing the clock', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    { signal: abort.signal, elicitationUnsupported: true },
  );
  // No clock.tick anywhere in this test: the reject must not need to wait out approvalTimeoutMs.
  await flush();
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'reject',
    ),
  );
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (e) A hung elicitation is abandoned at the deadline, aborted, and rejected.
// ---------------------------------------------------------------------------

test('U05e: a hung elicitation is aborted at the approval deadline and rejected; a later stale allow is dropped', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  let signal: AbortSignal | undefined;
  let resolveElicit: (value: { decision: 'allow' }) => void = () => {};
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: (_req, given) => {
        signal = given;
        return new Promise((resolve) => {
          resolveElicit = resolve;
        });
      },
    },
  );
  await flush();
  assert.ok(signal, 'expected elicit to have been called');
  clock.tick(config.approvalTimeoutMs);
  await flush();
  assert.equal(signal!.aborted, true);
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_1' && x.args[2] === 'reject',
    ),
  );
  const repliesBefore = connection.api.calls.filter((x) => x.method === 'replyPermission').length;
  resolveElicit({ decision: 'allow' });
  await flush();
  assert.equal(
    connection.api.calls.filter((x) => x.method === 'replyPermission').length,
    repliesBefore,
    'a stale allow after the deadline must never send a second reply',
  );
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (f) waiting_for_approval / pendingApprovals are covered by status and list.
// ---------------------------------------------------------------------------

test('U05f: a pending ask with no observer reports waiting_for_approval and pendingApprovals in status and list', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo hi'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  await flush();
  const status = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.status, 'waiting_for_approval');
  assert.deepEqual(status.pendingApprovals, [
    { id: 'per_1', sessionId: started.sessionId, permission: 'bash', patterns: ['echo hi'] },
  ]);
  const list = await engine.list();
  assert.equal(list.sessions[0]?.status, 'waiting_for_approval');
});

// ---------------------------------------------------------------------------
// (g) never policy also clears its deadline bookkeeping (white-box: constructs a Turn directly).
// ---------------------------------------------------------------------------

test('U05g: a never-policy reject also releases its deadline bookkeeping, not only pending', async () => {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const hub = new EventHub(connection, clock, config);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const entry: TrackedSession = {
    id: 'ses_1',
    directory: '/repo',
    title: 'x',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    turns: 1,
    phase: 'admitting',
    generation: 1,
    updatedAt: 0,
  };
  const lease = await connection.acquire();
  const turn = new Turn(
    entry,
    1,
    lease,
    connection,
    hub,
    clock,
    config,
    logger,
    async () => {},
    new ConnectionHealth(lease, connection, clock, config),
    () => undefined,
    async <T>(work: Promise<T>): Promise<T> => work,
    () => {},
  );
  entry.current = turn;
  turn.start({ parts: [{ type: 'text', text: 'hi' }] }, config.turnTimeoutMs);
  await turn.ready;
  for (const id of ['per_1', 'per_2', 'per_3']) {
    const request = { id, sessionID: entry.id, permission: 'bash', patterns: ['*'], metadata: {}, always: [] };
    connection.api.permissions.set(id, request);
    connection.api.emit(entry.directory, { type: 'permission.asked', properties: request });
  }
  await flush();
  assert.equal(
    connection.api.calls.filter((x) => x.method === 'replyPermission' && x.args[2] === 'reject').length,
    3,
  );
  const deadlines = (turn as unknown as { deadlines: Map<string, number> }).deadlines;
  assert.equal(deadlines.size, 0, 'a never-policy reject must also clear its deadline entry');
});

// ---------------------------------------------------------------------------
// (i) P3-3 (core review): scanPending must only prune ids the fresh list could
// actually have reflected — one asked while a stale GET was already in flight must survive.
// ---------------------------------------------------------------------------

test('U05i: scanPending never prunes a request first asked after its list request was issued', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const original = connection.api.listPermissions.bind(connection.api);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gateNext = false;
  connection.api.listPermissions = async (directory: string) => {
    // Snapshot the authoritative list at issuance time; only delay delivery of that snapshot —
    // matching a real GET whose response reflects state as of when the server received it, not
    // as of when the client finally sees the response.
    const snapshot = await original(directory);
    if (gateNext) {
      gateNext = false;
      await gate;
    }
    return snapshot;
  };
  // Nothing is pending yet: this poll's scanPending issues a GET against an empty list.
  gateNext = true;
  clock.tick(config.statusPollMs);
  await flush();
  // per_new is asked only after that (now-gated, stale) GET was already issued.
  const ask = {
    id: 'per_new',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  await flush();
  // Deliver the stale (empty) response now.
  release();
  await flush();
  let called = 0;
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => {
        called++;
        return { decision: 'allow' };
      },
    },
  );
  await flush();
  assert.equal(called, 1, 'per_new must still be elicited, not silently tombstoned by the stale list');
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_new' && x.args[2] === 'once',
    ),
  );
  abort.abort();
  await observer;
});

// ---------------------------------------------------------------------------
// (j) P3-5 (core review): scanPending's prune must abort an in-flight elicitation
// for the id it prunes, the same way the permission.replied handler already does.
// ---------------------------------------------------------------------------

test('U05j: scanPending aborts an in-flight elicitation for a request it prunes', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  let signal: AbortSignal | undefined;
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: (_req, given) => {
        signal = given;
        return new Promise((resolve) => {
          given.addEventListener('abort', () => resolve(null));
        });
      },
    },
  );
  await flush();
  assert.ok(signal, 'expected elicit to have been called');
  assert.equal(signal!.aborted, false);
  // The authoritative directory list no longer carries per_1 (resolved out-of-band) without this
  // turn ever observing a permission.replied event for it.
  connection.api.permissions.delete(ask.id);
  clock.tick(config.statusPollMs);
  await flush();
  assert.equal(signal!.aborted, true, 'a pruned in-flight elicitation must be aborted');
  abort.abort();
  await observer;
});
