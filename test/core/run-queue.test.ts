import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, StartInput } from '../../src/types.ts';

const base = {
  mode: 'managed',
  defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1000, turnTimeoutMs: 60_000, maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 1000, heartbeatMs: 100, statusPollMs: 100,
  sseStallMs: 1000, cleanupTimeoutMs: 500, maxOutputChars: 2000,
  maxSessions: 20, maxRunningTurns: 1, maxQueuedTurns: 4, queueTimeoutMs: 0,
  modelProfiles: {}, contextGuard: 'reject', endAction: 'delete', onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function message(sessionID: string, id: string, role: 'user' | 'assistant', parentID?: string): OcMessage {
  return { info: { id, sessionID, role, ...(parentID ? { parentID, finish: 'stop' } : {}),
    time: { created: Number(id.slice(1)), ...(parentID ? { completed: Number(id.slice(1)) + 1 } : {}) } },
    parts: parentID ? [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text: 'done' }] : [] };
}
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const config = { ...base, ...overrides };
  const engine = createEngine({ config, connection, clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    history.push(message(id, `m${history.length + 1}`, 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const starts = (prompt: string, rest: Partial<StartInput> = {}) =>
    engine.start({ prompt, waitSeconds: 0, ...rest }, ctx());
  const prompts = () => connection.api.calls.filter((call) => call.method === 'promptAsync').length;
  const creates = () => connection.api.calls.filter((call) => call.method === 'createSession').length;
  const aborts = () => connection.api.calls.filter((call) => call.method === 'abort').length;
  const finish = async (id: string) => {
    const history = connection.api.histories.get(id)!;
    const user = [...history].reverse().find((item) => item.info.role === 'user')!;
    history.push(message(id, `m${history.length + 1}`, 'assistant', user.info.id));
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
    await flush();
  };
  return { engine, connection, clock, starts, prompts, creates, aborts, finish };
}

test('cap one queues starts, advertises queue in status/list/batch, and drains one at a time', async () => {
  const s = setup();
  const [a, b, c] = await Promise.all([s.starts('a'), s.starts('b'), s.starts('c')]);
  await flush();
  assert.equal(s.prompts(), 1);
  assert.equal(a.status, 'running');
  assert.deepEqual([b.queue?.position, c.queue?.position], [1, 2]);
  assert.equal(b.content, '');
  assert.equal(b.resendSafety, 'not_submitted');
  assert.equal((await s.engine.list()).sessions.find((item) => item.sessionId === b.sessionId)?.queue?.position, 1);
  const batch = await s.engine.statusMany({ ids: [a.sessionId, b.sessionId, c.sessionId], waitSeconds: 0 }, ctx());
  assert.deepEqual(batch.pendingIds, [a.sessionId, b.sessionId, c.sessionId]);
  assert.equal(batch.results[1]?.queue?.position, 1);
  await s.finish(a.sessionId);
  assert.equal(s.prompts(), 2);
  await s.finish(b.sessionId);
  assert.equal(s.prompts(), 3);
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.queued, 0);
});

test('full queue rejects before create, frees request id, and reply rejection preserves session settings', async () => {
  const s = setup({ maxQueuedTurns: 1 });
  const a = await s.starts('a', { model: 'p/one', agent: 'old' });
  const b = await s.starts('b');
  assert.equal(b.queue?.position, 1);
  const before = s.creates();
  await assert.rejects(s.starts('c', { requestId: 'full-start' }), { code: 'RUN_QUEUE_CAPACITY' });
  assert.equal(s.creates(), before);
  await s.engine.cancel({ sessionId: b.sessionId }, ctx());
  const retry = await s.starts('c', { requestId: 'full-start' });
  assert.equal(retry.queue?.position, 1);
  await flush();
  await s.finish(a.sessionId);
  await flush();
  await s.finish(retry.sessionId);
  const idle = await s.starts('idle', { model: 'p/one', agent: 'old' });
  await flush();
  await s.finish(idle.sessionId);
  const holder = await s.starts('holder');
  const queued = await s.starts('queued');
  assert.equal(queued.queue?.position, 1);
  await assert.rejects(s.engine.reply({ sessionId: idle.sessionId, prompt: 'reply', model: 'p/two',
    agent: 'new', developerInstructions: 'new', requestId: 'full-reply', waitSeconds: 0 }, ctx()),
  { code: 'RUN_QUEUE_CAPACITY' });
  await s.engine.cancel({ sessionId: queued.sessionId }, ctx());
  const reply = await s.engine.reply({ sessionId: idle.sessionId, prompt: 'reply', requestId: 'full-reply', waitSeconds: 0 }, ctx());
  assert.equal(reply.model, 'p/one');
  assert.equal(reply.agent, 'old');
  assert.equal(reply.turn, 2);
  assert.equal(holder.status, 'running');
});

test('queued cancel and end never abort and let the next ticket run', async () => {
  const s = setup();
  await s.starts('hold');
  const b = await s.starts('cancel');
  const c = await s.starts('end');
  const d = await s.starts('next');
  const before = s.aborts();
  const subscriptions = s.connection.api.subscribeCount;
  const cancelled = await s.engine.cancel({ sessionId: b.sessionId }, ctx());
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.executionState, 'stopped');
  assert.equal(cancelled.resendSafety, 'not_submitted');
  await s.engine.end({ sessionId: c.sessionId }, ctx());
  assert.equal(s.aborts(), before);
  assert.equal(s.connection.api.subscribeCount, subscriptions);
  assert.equal((await s.engine.status({ sessionId: d.sessionId }, ctx())).queue?.position, 1);
});

test('queue timeout and owner deadline return snapshots without submitting or stopping', async () => {
  const s = setup({ queueTimeoutMs: 2000 });
  await s.starts('hold');
  const owner = s.engine.start({ prompt: 'wait', waitSeconds: 1, requestId: 'timeout-key' }, ctx());
  await flush();
  s.clock.tick(1000); await flush();
  const snapshot = await owner;
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.queue?.queuedMs, 1000);
  s.clock.tick(1000); await flush();
  const terminal = await s.engine.status({ sessionId: snapshot.sessionId }, ctx());
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error?.name, 'QUEUE_TIMEOUT');
  assert.equal(terminal.error?.retryable, true);
  assert.equal(terminal.error?.message, 'Waited 2s for a run slot; nothing was submitted.');
  assert.equal(terminal.resendSafety, 'not_submitted');
  assert.equal(terminal.queuedMs, 2000);
  assert.equal(s.prompts(), 1);
  const replay = await s.starts('wait', { requestId: 'timeout-key' });
  assert.equal(replay.turnId, snapshot.turnId);
  assert.equal(replay.queuedMs, 2000);
  assert.equal(replay.request?.replayed, true);
});

test('a session can opencode-reply normally after its queued start times out (QUEUE_TIMEOUT)', async () => {
  const s = setup({ queueTimeoutMs: 2000 });
  const holder = await s.starts('hold');
  const queued = await s.starts('wait');
  assert.equal(queued.queue?.position, 1);
  // Move monotonic time to the deadline without running its scheduled callback first (matches
  // "grant at the exact queue deadline..." above), then free the holder's slot: the grant race
  // re-checks the deadline and still times the queued ticket out instead of letting it submit —
  // and releases both tickets, so the session is idle and its one run slot is free afterward.
  s.clock.now = 2000;
  await s.finish(holder.sessionId);
  const timedOut = await s.engine.status({ sessionId: queued.sessionId }, ctx());
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.error?.name, 'QUEUE_TIMEOUT');
  assert.equal(timedOut.resendSafety, 'not_submitted');
  assert.equal(s.prompts(), 1, 'the timed-out turn itself must never have been submitted');

  // The QUEUE_TIMEOUT error is a turn-level outcome, not an admission failure that quarantines the
  // session: a normal reply on it works.
  const reply = await s.engine.reply({ sessionId: queued.sessionId, prompt: 'next', waitSeconds: 0 }, ctx());
  assert.equal(reply.status, 'running');
  assert.equal(reply.queue, undefined);
  await s.finish(queued.sessionId);
  const final = await s.engine.status({ sessionId: queued.sessionId }, ctx());
  assert.equal(final.status, 'completed');
  assert.equal(s.prompts(), 2, 'the reply must actually have been submitted this time');
});

test('server info is local and shutdown cancels queued turns', async () => {
  const s = setup();
  const info = (await s.engine.info({ section: 'server' }, ctx())).server!;
  assert.equal(s.connection.api.calls.length, 0);
  assert.equal(info.limits.maxRunningTurns, 1);
  assert.equal(info.limits.queueTimeoutSeconds, null);
  assert.equal(info.defaults.contextGuard, 'reject');
  assert.equal(info.concurrency?.running, 0);
  assert.ok(info.capabilities.includes('run-queue'));
  await s.starts('hold');
  const queued = await s.starts('queued');
  await flush();
  const observed = s.engine.statusMany({ ids: [queued.sessionId], waitFor: 'all', waitSeconds: 10 }, ctx());
  const done = s.engine.shutdown('test');
  const item = (await observed).results[0]!;
  assert.equal(item.status, 'cancelled');
  assert.equal(item.executionState, 'stopped');
  assert.equal(item.resendSafety, 'not_submitted');
  await done;
  assert.equal(s.prompts(), 1);
});

test('confirmed create failure releases slot and request id', async () => {
  const s = setup();
  const create = s.connection.api.createSession.bind(s.connection.api);
  let fail = true;
  s.connection.api.createSession = async (directory, body) => {
    if (fail) { fail = false; throw new OpencodeHttpError('rejected', 400, 'BadRequest'); }
    return create(directory, body);
  };
  await assert.rejects(s.starts('x', { requestId: 'create-failed' }), { code: 'UPSTREAM_ERROR' });
  const info = (await s.engine.info({ section: 'server' }, ctx())).server!;
  assert.equal(info.concurrency?.running, 0);
  assert.equal(info.concurrency?.queued, 0);
  assert.equal((await s.starts('x', { requestId: 'create-failed' })).request?.replayed, false);
});

test('duplicate request id joins a queued turn without taking a second slot', async () => {
  const s = setup();
  await s.starts('hold');
  const original = await s.starts('queued', { requestId: 'same' });
  const duplicate = await s.starts('queued', { requestId: 'same' });
  assert.equal(duplicate.turnId, original.turnId);
  assert.equal(duplicate.request?.replayed, true);
  assert.equal(duplicate.queue?.position, 1);
  assert.equal(s.creates(), 2);
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.queued, 1);
});

test('per-model saturation skips ahead through the engine and preserves model order', async () => {
  const s = setup({ maxRunningTurns: 2, modelProfiles: { 'p/a': { maxRunning: 1 } } });
  const a = await s.starts('a1', { model: 'p/a' });
  const a2 = await s.starts('a2', { model: 'p/a' });
  const b = await s.starts('b', { model: 'p/b' });
  await flush();
  assert.equal(a2.queue?.blockedBy, 'model');
  assert.equal(a2.queue?.modelMaxRunning, 1);
  assert.equal(b.queue, undefined);
  assert.equal(s.prompts(), 2);
  await s.finish(a.sessionId);
  assert.equal(s.prompts(), 3);
  assert.equal((await s.engine.status({ sessionId: a2.sessionId }, ctx())).queuedMs, 0);
  const batch = await s.engine.statusMany({ ids: [a2.sessionId], waitSeconds: 0 }, ctx());
  assert.equal(batch.results[0]?.model, 'p/a');
  assert.equal(batch.results[0]?.queuedMs, 0);
});

test('batch any/all keeps queued items pending until their turns finish', async () => {
  const s = setup();
  const a = await s.starts('a');
  const b = await s.starts('b');
  const any = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'any', waitSeconds: 10 }, ctx());
  await flush();
  await s.finish(a.sessionId);
  const first = await any;
  assert.deepEqual(first.readyIds, [a.sessionId]);
  assert.deepEqual(first.pendingIds, [b.sessionId]);
  const all = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'all', waitSeconds: 10 }, ctx());
  await flush();
  await s.finish(b.sessionId);
  assert.deepEqual((await all).readyIds, [a.sessionId, b.sessionId]);
});

test('long queue wait gives activated turn a fresh admission deadline', async () => {
  const s = setup({ startupTimeoutMs: 500 });
  const a = await s.starts('a');
  const b = await s.starts('b');
  await flush();
  s.clock.tick(3000);
  await s.finish(a.sessionId);
  assert.equal(s.prompts(), 2);
  assert.equal((await s.engine.status({ sessionId: b.sessionId }, ctx())).status, 'running');
  assert.equal((await s.engine.status({ sessionId: b.sessionId }, ctx())).queuedMs, 3000);
});

test('queued lease loss fails before dispatch with a stopped, not-submitted result', async () => {
  const s = setup({ maxRunningTurns: 1 });
  await s.starts('hold');
  const queued = await s.starts('queued');
  await flush();
  s.connection.unavailable('exited');
  await flush();
  const result = await s.engine.status({ sessionId: queued.sessionId }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'OPENCODE_UNAVAILABLE');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.resendSafety, 'not_submitted');
  assert.equal(s.prompts(), 1);
});

test('unknown execution retains a slot after an attach disconnect', async () => {
  const s = setup({ mode: 'attach', maxQueuedTurns: 0 });
  await s.starts('uncertain');
  await flush();
  s.connection.unavailable('unreachable');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  await assert.rejects(s.starts('blocked'), { code: 'RUN_QUEUE_CAPACITY' });
  await s.engine.end({ sessionId: 'ses_1' }, ctx());
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 0);
});

test('managed generation exit releases a held unknown slot', async () => {
  const s = setup({ maxQueuedTurns: 0 });
  await s.starts('uncertain');
  await flush();
  // First mark the in-flight execution unknown, then report a managed exit for its generation.
  s.connection.unavailable('unreachable');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  s.connection.generation = 1;
  s.connection.live = true;
  s.connection.unavailable('exited');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 0);
});

test('shutdown releases a ticket while createSession is still pending', async () => {
  const s = setup();
  const original = s.connection.api.createSession.bind(s.connection.api);
  let release = () => {};
  let entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.api.createSession = async (directory, body) => { entered = true; await gate; return original(directory, body); };
  const start = s.starts('late');
  await flush();
  assert.equal(entered, true);
  await s.engine.shutdown('test');
  release();
  const result = await start;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.resendSafety, 'not_submitted');
  assert.equal(s.prompts(), 0);
});

test('info bounds per-model entries to 32 while preserving the total', async () => {
  const profiles = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`p/m${n}`, { maxRunning: 1 }]));
  const s = setup({ modelProfiles: profiles });
  const concurrency = (await s.engine.info({ section: 'server' }, ctx())).server?.concurrency;
  assert.equal(concurrency?.perModel.length, 32);
  assert.equal(concurrency?.perModelTotal, 40);
  assert.equal(concurrency?.perModelTruncated, true);
  assert.equal(s.connection.api.calls.length, 0);
});

test('queued heartbeats report current position and running counts', async () => {
  const s = setup();
  await s.starts('holder');
  const lines: string[] = [];
  const waiting = s.engine.start({ prompt: 'waiting', waitSeconds: 1 },
    { signal: new AbortController().signal, progress: (message) => { lines.push(message); } });
  await flush();
  s.clock.tick(100);
  await flush();
  assert.ok(lines.includes('Queued for an OpenCode run slot (position 1; 1/1 running).'));
  assert.ok(lines.every((line) => line.length <= 200));
  s.clock.tick(900);
  assert.equal((await waiting).queue?.position, 1);
});

test('owner deadline spans admission and later admission failure remains observable', async () => {
  const s = setup({ startupTimeoutMs: 2000 });
  s.connection.api.autoConnected = false;
  const owner = s.engine.start({ prompt: 'slow', waitSeconds: 1, requestId: 'slow-key' }, ctx());
  await flush();
  s.clock.tick(1000);
  const snapshot = await owner;
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.resendSafety, 'not_submitted');
  s.clock.tick(1000);
  await flush();
  const result = await s.engine.status({ sessionId: snapshot.sessionId }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'OPENCODE_UNAVAILABLE');
  await assert.rejects(s.starts('slow', { requestId: 'slow-key' }), { code: 'OPENCODE_UNAVAILABLE' });
});

test('a grant before queue expiry remains valid when session creation completes later', async () => {
  const s = setup({ startupTimeoutMs: 5000, queueTimeoutMs: 2000 });
  const holder = await s.starts('holder');
  await flush();
  const create = s.connection.api.createSession.bind(s.connection.api);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.api.createSession = async (directory, body) => { await gate; return create(directory, body); };
  const delayed = s.starts('delayed');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.queued, 1);
  s.clock.tick(500);
  await s.finish(holder.sessionId);
  s.clock.tick(2000);
  release();
  const result = await delayed;
  await flush();
  assert.equal(result.queuedMs, 500);
  assert.equal(result.status, 'running');
  assert.equal(s.prompts(), 2);
  assert.notEqual((await s.engine.status({ sessionId: result.sessionId }, ctx())).error?.name, 'QUEUE_TIMEOUT');
});

test('a late confirmed prompt rejection repairs a held unknown turn and drains its queue', async () => {
  const s = setup({ cleanupTimeoutMs: 500, queueTimeoutMs: 0 });
  const normalPrompt = s.connection.api.onPrompt;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.api.onPrompt = async (id, body) => {
    if (id === 'ses_1') {
      await gate;
      throw new OpencodeHttpError('rejected', 400, 'BadRequest');
    }
    await normalPrompt?.(id, body);
  };
  let sessionId = '';
  const owner = s.engine.start({ prompt: 'late', requestId: 'late-key', waitSeconds: 1 },
    { signal: new AbortController().signal, setSessionId: (id) => { sessionId = id; } });
  await flush();
  assert.equal(s.prompts(), 1);
  const stop = s.engine.cancel({ sessionId }, ctx());
  await flush();
  s.clock.tick(500);
  const uncertain = await stop;
  assert.equal(uncertain.executionState, 'unknown');
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  const waiting = await s.starts('next');
  assert.equal(waiting.queue?.position, 1);
  release();
  await flush();
  const recovered = await s.engine.status({ sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.cleanup, 'complete');
  assert.equal(recovered.resendSafety, 'not_submitted');
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 0);
  assert.equal(s.prompts(), 2);
  const replay = await s.starts('late', { requestId: 'late-key' });
  assert.equal(replay.executionState, 'stopped');
  assert.equal(replay.resendSafety, 'not_submitted');
  await owner;
});

test('cancel and grant in the same tick never submit the cancelled queued turn', async () => {
  const s = setup();
  const holder = await s.starts('holder');
  const cancelled = await s.starts('cancelled');
  const next = await s.starts('next');
  await flush();
  const completing = s.finish(holder.sessionId);
  const stopping = s.engine.cancel({ sessionId: cancelled.sessionId }, ctx());
  const result = await stopping;
  await completing;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.resendSafety, 'not_submitted');
  assert.equal(s.connection.api.calls.filter((call) =>
    call.method === 'promptAsync' && call.args[0] === cancelled.sessionId).length, 0);
  assert.equal((await s.engine.status({ sessionId: next.sessionId }, ctx())).queue, undefined);
  assert.equal(s.prompts(), 2);
});

test('grant at the exact queue deadline times out before submission', async () => {
  const s = setup({ queueTimeoutMs: 2000 });
  const holder = await s.starts('holder');
  const waiting = await s.starts('waiting');
  await flush();
  // Move monotonic time to the deadline without running its scheduled callback first.
  s.clock.now = 2000;
  await s.finish(holder.sessionId);
  const result = await s.engine.status({ sessionId: waiting.sessionId }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'QUEUE_TIMEOUT');
  assert.equal(result.queuedMs, 2000);
  assert.equal(s.prompts(), 1);
});

test('queued owner abort stops the turn; observer and duplicate abort only detach', async () => {
  const s = setup();
  await s.starts('holder');
  const ownerController = new AbortController();
  let sessionId = '';
  const owner = s.engine.start({ prompt: 'queued', requestId: 'join-key', waitSeconds: 10 },
    { signal: ownerController.signal, setSessionId: (id) => { sessionId = id; } });
  await flush();
  const observerController = new AbortController();
  const duplicateController = new AbortController();
  const observer = s.engine.status({ sessionId, waitSeconds: 10 }, { signal: observerController.signal });
  const duplicate = s.engine.start({ prompt: 'queued', requestId: 'join-key', waitSeconds: 10 },
    { signal: duplicateController.signal });
  await flush();
  observerController.abort();
  duplicateController.abort();
  await Promise.all([observer, duplicate]);
  assert.equal((await s.engine.status({ sessionId }, ctx())).status, 'running');
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.queued, 1);
  ownerController.abort();
  const stopped = await owner;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.resendSafety, 'not_submitted');
  assert.equal(s.aborts(), 0);
});

test('poison recovery defers commit, releases the slot, and gates the next dispatch', async () => {
  const s = setup({ startupTimeoutMs: 5000 });
  const dispose = s.connection.api.disposeInstance.bind(s.connection.api);
  const normalPrompt = s.connection.api.onPrompt;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.api.disposeInstance = async (directory, req) => { await gate; return dispose(directory, req); };
  s.connection.api.onPrompt = (id) => {
    const failed = message(id, 'm2', 'assistant', 'm1');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    s.connection.api.histories.get(id)!.push(message(id, 'm1', 'user'), failed);
    s.connection.api.emit('/repo', { type: 'session.error', properties: { sessionID: id, error: failed.info.error! } });
  };
  let firstDone = false;
  const first = s.engine.start({ prompt: 'poison' }, ctx());
  void first.then(() => { firstDone = true; });
  await flush();
  assert.equal(firstDone, false);
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.running, 0);
  s.connection.api.onPrompt = normalPrompt;
  const second = s.starts('next');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.running, 1);
  assert.equal(s.prompts(), 1);
  release();
  const poisoned = await first;
  assert.equal(poisoned.error?.name, 'UnknownError');
  await second;
  await flush();
  assert.equal(s.connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  assert.equal(s.prompts(), 2);
});

test('on-request approval waiting retains the slot through an answer and timeout', async () => {
  const s = setup({ approvalTimeoutMs: 1000 });
  const first = await s.starts('approval', { approvalPolicy: 'on-request' });
  await flush();
  const ask = { id: 'per_1', sessionID: first.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(ask.id, ask);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  await flush();
  const second = await s.starts('second', { approvalPolicy: 'on-request' });
  assert.equal(second.queue?.position, 1);
  assert.equal((await s.engine.status({ sessionId: first.sessionId }, ctx())).status, 'waiting_for_approval');
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.running, 1);
  const observer = s.engine.status({ sessionId: first.sessionId, waitSeconds: 10 },
    { signal: new AbortController().signal, elicit: async () => ({ decision: 'allow' }) });
  await flush();
  assert.equal(s.connection.api.calls.filter((call) => call.method === 'replyPermission' && call.args[2] === 'once').length, 1);
  assert.equal(s.prompts(), 1);
  await s.finish(first.sessionId);
  await observer;
  assert.equal(s.prompts(), 2);
  const nextAsk = { id: 'per_2', sessionID: second.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(nextAsk.id, nextAsk);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: nextAsk });
  await flush();
  const third = await s.starts('third');
  assert.equal(third.queue?.position, 1);
  s.clock.tick(1000);
  await flush();
  assert.equal(s.connection.api.calls.filter((call) => call.method === 'replyPermission' &&
    call.args[1] === nextAsk.id && call.args[2] === 'reject').length, 1);
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.running, 1);
  assert.equal(s.prompts(), 2);
  await s.engine.cancel({ sessionId: second.sessionId }, ctx());
  await flush();
  assert.equal(s.prompts(), 3);
});

test('recovered unknown releases once and wakes exactly one queued turn', async () => {
  const s = setup({ mode: 'attach' });
  const uncertain = await s.starts('uncertain');
  await flush();
  s.connection.unavailable('unreachable');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  const next = await s.starts('next');
  const after = await s.starts('after');
  assert.deepEqual([next.queue?.position, after.queue?.position], [1, 2]);
  const recovered = await s.engine.cancel({ sessionId: uncertain.sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  await flush();
  const counts = (await s.engine.info({ section: 'server' }, ctx())).server?.concurrency;
  assert.equal(counts?.heldUnknown, 0);
  assert.equal(counts?.running, 1);
  assert.equal(counts?.queued, 1);
  assert.equal(s.prompts(), 2);
  await s.engine.status({ sessionId: uncertain.sessionId }, ctx());
  assert.equal(s.prompts(), 2);
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.queued, 1);
  await s.finish(next.sessionId);
  assert.equal(s.prompts(), 3);
});

test('a late rejection for an older turn does not release a newer held turn', async () => {
  const s = setup({ cleanupTimeoutMs: 500 });
  const normalPrompt = s.connection.api.onPrompt;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  s.connection.api.onPrompt = async (id, body) => {
    if (++calls === 1) { await gate; throw new OpencodeHttpError('rejected', 400, 'BadRequest'); }
    await normalPrompt?.(id, body);
  };
  let sessionId = '';
  const first = s.engine.start({ prompt: 'first', requestId: 'old-key', waitSeconds: 1 },
    { signal: new AbortController().signal, setSessionId: (id) => { sessionId = id; } });
  await flush();
  const stopping = s.engine.cancel({ sessionId }, ctx());
  await flush();
  s.clock.tick(500);
  assert.equal((await stopping).executionState, 'unknown');
  await first;
  s.connection.unavailable('exited');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 0);
  const second = await s.engine.reply({ sessionId, prompt: 'second', waitSeconds: 0 }, ctx());
  await flush();
  assert.equal(second.status, 'running');
  s.connection.unavailable('unreachable');
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  release();
  await flush();
  assert.equal((await s.engine.info({ section: 'server' }, ctx())).server?.concurrency?.heldUnknown, 1);
  const oldReplay = await s.starts('first', { requestId: 'old-key' });
  assert.equal(oldReplay.executionState, 'stopped');
  assert.equal(oldReplay.resendSafety, 'not_submitted');
});
