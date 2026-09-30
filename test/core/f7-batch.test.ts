import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { captureTarget, observeTarget } from '../../src/core/observe-many.ts';
import type { TrackedSession } from '../../src/core/registry.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { OpencodeHttpError } from '../../src/types.ts';

const config = {
  defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000, approvalTimeoutMs: 1000,
  heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000, cleanupTimeoutMs: 500,
  maxOutputChars: 2000, endAction: 'delete', onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function setup() {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({ config, connection, clock, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    history.push(message(id, `m${history.length + 1}`, 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  return { engine, connection, clock };
}
function message(sessionID: string, id: string, role: 'user' | 'assistant', parentID?: string): OcMessage {
  return { info: { id, sessionID, role, ...(parentID ? { parentID, finish: 'stop' } : {}),
    time: { created: Number(id.slice(1)), ...(parentID ? { completed: Number(id.slice(1)) + 1 } : {}) } },
    parts: parentID ? [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text: `${sessionID} done` }] : [] };
}
type Setup = ReturnType<typeof setup>;
async function start(env: Setup, prompt = 'work') {
  return env.engine.start({ prompt, waitSeconds: 0 }, ctx());
}
async function finish(env: Setup, id: string) {
  const history = env.connection.api.histories.get(id)!;
  const user = [...history].reverse().find((m) => m.info.role === 'user')!;
  history.push(message(id, `m${history.length + 1}`, 'assistant', user.info.id));
  env.connection.api.statuses.delete(id);
  env.connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  await flush();
}

test('validation rejects malformed batch inputs before observation', async () => {
  const s = setup();
  for (const input of [
    { ids: [] }, { ids: ['a', 'a'] }, { ids: [''] }, { ids: ['   '] }, { ids: ['x'.repeat(201)] },
    { ids: Array.from({ length: 17 }, (_, i) => String(i)) },
    { ids: ['x'], waitFor: 'none' }, { ids: ['x'], waitSeconds: -1 },
    { ids: ['x'], waitSeconds: 601 }, { ids: ['x'], waitSeconds: 0.5 },
  ]) await assert.rejects(s.engine.statusMany(input as Parameters<typeof s.engine.statusMany>[0], ctx()), { code: 'INVALID_ARGUMENT' });
  assert.equal(s.connection.api.calls.length, 0);
});

test('mixed terminal, running, missing and quarantined results preserve input order without inspection', async () => {
  const s = setup();
  const terminal = await start(s); await finish(s, terminal.sessionId);
  const running = await start(s);
  const before = s.connection.api.calls.length;
  const result = await s.engine.statusMany({ ids: [running.sessionId, 'missing', terminal.sessionId], waitSeconds: 10 }, ctx());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.readyIds, ['missing', terminal.sessionId]);
  assert.deepEqual(result.pendingIds, [running.sessionId]);
  assert.deepEqual(result.results.map((item) => item.status), ['running', 'error', 'completed']);
  assert.equal(result.results[1]?.error?.name, 'SESSION_NOT_FOUND');
  assert.equal(result.results[2]?.content, `${terminal.sessionId} done`);
  assert.equal(s.connection.api.calls.length, before);
});

test('any waits for first completion, all waits for every completion, and deadline partitions ids', async () => {
  const s = setup();
  const a = await start(s), b = await start(s);
  const any = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'any', waitSeconds: 5 }, ctx());
  let anyDone = false; void any.then(() => { anyDone = true; });
  await flush(); assert.equal(anyDone, false);
  await finish(s, b.sessionId);
  const first = await any;
  assert.deepEqual(first.readyIds, [b.sessionId]);
  assert.deepEqual(first.pendingIds, [a.sessionId]);
  const all = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'all', waitSeconds: 5 }, ctx());
  let allDone = false; void all.then(() => { allDone = true; });
  await flush(); assert.equal(allDone, false);
  s.clock.tick(5000);
  const deadline = await all;
  assert.equal(deadline.status, 'waiting'); assert.equal(deadline.reason, 'deadline');
  assert.deepEqual(deadline.readyIds, [b.sessionId]);
  assert.deepEqual(deadline.pendingIds, [a.sessionId]);
  await finish(s, a.sessionId);
  const ready = await s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'all' }, ctx());
  assert.equal(ready.status, 'ready'); assert.deepEqual(ready.readyIds, [a.sessionId, b.sessionId]);
});

test('capture stays on its turn when a later reply begins', async () => {
  const s = setup(); const first = await start(s);
  const pending = s.engine.statusMany({ ids: [first.sessionId], waitFor: 'all', waitSeconds: 10 }, ctx());
  await finish(s, first.sessionId);
  const reply = s.engine.reply({ sessionId: first.sessionId, prompt: 'next', waitSeconds: 0 }, ctx());
  const observed = await pending;
  assert.equal(observed.results[0]?.turn, 1);
  assert.equal(observed.results[0]?.status, 'completed');
  await reply;
});

test('cancelling a batch detaches without aborting its turn or leaving batch timers', async () => {
  const s = setup(); const first = await start(s);
  const controller = new AbortController();
  const priorJobs = s.clock.pendingJobs();
  const batch = s.engine.statusMany({ ids: [first.sessionId], waitSeconds: 10 }, { signal: controller.signal, progress() {} });
  await flush(); controller.abort();
  const result = await batch;
  assert.equal(result.status, 'waiting');
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'abort').length, 0);
  assert.equal(s.clock.pendingJobs(), priorJobs);
  await finish(s, first.sessionId);
  assert.equal((await s.engine.statusMany({ ids: [first.sessionId] }, ctx())).results[0]?.status, 'completed');
});

test('pending admission selects its own turn, even while the previous result exists', async () => {
  const s = setup(); const first = await start(s); await finish(s, first.sessionId);
  const originalAcquire = s.connection.acquire.bind(s.connection);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.acquire = async (req) => { await gate; return originalAcquire(req); };
  const reply = s.engine.reply({ sessionId: first.sessionId, prompt: 'second', waitSeconds: 0 }, ctx());
  const batch = s.engine.statusMany({ ids: [first.sessionId], waitFor: 'all', waitSeconds: 10 }, ctx());
  let done = false; void batch.then(() => { done = true; });
  await flush(); assert.equal(done, false);
  release(); await reply; await flush();
  await finish(s, first.sessionId);
  const result = await batch;
  assert.equal(result.results[0]?.turn, 2);
  assert.equal(result.results[0]?.status, 'completed');
});

test('idle target and unknown terminal turn are ready without quarantine inspection', async () => {
  const idle = captureTarget('idle', { id: 'idle' } as TrackedSession);
  const handle = observeTarget(idle, ctx());
  assert.equal(handle.snapshot().status, 'idle');
  assert.equal((await handle.settled).status, 'idle');
  handle.dispose();

  const s = setup();
  s.connection.api.onPrompt = undefined;
  s.connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = s.engine.start({ prompt: 'ambiguous' }, ctx());
  await flush(); s.clock.tick(500); await flush(); s.clock.tick(500);
  const unknown = await pending;
  assert.equal(unknown.executionState, 'unknown');
  const before = s.connection.api.calls.length;
  const result = await s.engine.statusMany({ ids: [unknown.sessionId, 'missing'] }, ctx());
  assert.deepEqual(result.readyIds, [unknown.sessionId, 'missing']);
  assert.equal(result.results[0]?.executionState, 'unknown');
  assert.equal(s.connection.api.calls.length, before);
});

test('one batch serializes approval dialogs across sessions', async () => {
  const s = setup();
  const a = await s.engine.start({ prompt: 'a', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const b = await s.engine.start({ prompt: 'b', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  let active = 0; let maximum = 0;
  const releases: Array<() => void> = [];
  const controller = new AbortController();
  const batch = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'all', waitSeconds: 10 }, {
    signal: controller.signal,
    elicit: async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active--;
      return { decision: 'allow' };
    },
  });
  for (const [index, sessionId] of [a.sessionId, b.sessionId].entries()) {
    const request = { id: `per_${index}`, sessionID: sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
    s.connection.api.permissions.set(request.id, request);
    s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  }
  await flush();
  assert.equal(releases.length, 1);
  assert.equal(maximum, 1);
  releases.shift()!(); await flush();
  assert.equal(releases.length, 1);
  assert.equal(maximum, 1);
  releases.shift()!(); await flush();
  assert.equal(maximum, 1);
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission' && c.args[2] === 'once').length, 2);
  controller.abort(); await batch;
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'abort').length, 0);
});

test('completion during admission observer registration is not missed', async () => {
  const s = setup(); const first = await start(s); await finish(s, first.sessionId);
  const originalAcquire = s.connection.acquire.bind(s.connection);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.connection.acquire = async (req) => { await gate; return originalAcquire(req); };
  s.connection.api.onPrompt = (id) => {
    const history = s.connection.api.histories.get(id)!;
    const user = `m${history.length + 1}`;
    history.push(message(id, user, 'user'), message(id, `m${history.length + 2}`, 'assistant', user));
    s.connection.api.statuses.delete(id);
    s.connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
  const reply = s.engine.reply({ sessionId: first.sessionId, prompt: 'fast', waitSeconds: 0 }, ctx());
  const batch = s.engine.statusMany({ ids: [first.sessionId], waitFor: 'all', waitSeconds: 10 }, ctx());
  release();
  await reply;
  const result = await batch;
  assert.equal(result.reason, 'condition');
  assert.equal(result.results[0]?.turn, 2);
  assert.equal(result.results[0]?.status, 'completed');
});

test('one progress heartbeat serves the whole batch', async () => {
  const s = setup(); const a = await start(s), b = await start(s);
  const controller = new AbortController();
  const messages: string[] = [];
  const batch = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitSeconds: 10 },
    { signal: controller.signal, progress: (message) => { messages.push(message); } });
  await flush();
  assert.deepEqual(messages, ['0/2 ready']);
  s.clock.tick(100); await flush();
  assert.deepEqual(messages, ['0/2 ready', '0/2 ready']);
  controller.abort(); await batch;
});

test('already-ready batch avoids attaching an approval observer', async () => {
  const s = setup();
  const running = await s.engine.start({ prompt: 'work', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const request = { id: 'per_ready', sessionID: running.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(request.id, request);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush();
  const before = s.connection.api.calls.length;
  let elicited = 0;
  const result = await s.engine.statusMany({ ids: [running.sessionId, 'missing'], waitSeconds: 10 }, {
    signal: new AbortController().signal,
    elicit: async () => { elicited++; return { decision: 'allow' }; },
  });
  assert.equal(result.reason, 'condition');
  assert.equal(elicited, 0);
  assert.equal(s.connection.api.calls.length, before);
});

test('queued approvals retain their original deadlines', async () => {
  const s = setup();
  const a = await s.engine.start({ prompt: 'a', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const b = await s.engine.start({ prompt: 'b', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  let calls = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const batch = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitSeconds: 10, waitFor: 'all' }, {
    signal: controller.signal,
    elicit: async () => { calls++; await held; return { decision: 'allow' }; },
  });
  for (const [index, id] of [a.sessionId, b.sessionId].entries()) {
    const request = { id: `per_deadline_${index}`, sessionID: id, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
    s.connection.api.permissions.set(request.id, request);
    s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  }
  await flush(); assert.equal(calls, 1);
  s.clock.tick(1000); await flush();
  release(); await flush();
  assert.equal(calls, 1);
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission' && c.args[2] === 'once').length, 0);
  controller.abort(); await batch;
});

test('cancelling an active batch elicitation aborts its dialog without aborting the turn', async () => {
  const s = setup();
  const running = await s.engine.start({ prompt: 'work', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const controller = new AbortController();
  let dialogSignal: AbortSignal | undefined;
  const batch = s.engine.statusMany({ ids: [running.sessionId], waitSeconds: 10 }, {
    signal: controller.signal,
    elicit: async (_request, signal) => {
      dialogSignal = signal;
      return new Promise<null>(() => {});
    },
  });
  const request = { id: 'per_cancel', sessionID: running.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(request.id, request);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush(); assert.ok(dialogSignal);
  controller.abort();
  const result = await batch;
  assert.equal(result.status, 'waiting');
  assert.equal(dialogSignal.aborted, true);
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'abort').length, 0);
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission').length, 0);
  assert.equal(s.connection.api.permissions.has(request.id), true);
  const resumed = s.engine.status({ sessionId: running.sessionId, waitSeconds: 10 }, {
    signal: new AbortController().signal,
    elicit: async () => ({ decision: 'allow' }),
  });
  await flush();
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission' && c.args[2] === 'once').length, 1);
  await finish(s, running.sessionId);
  await resumed;
  assert.equal((await s.engine.statusMany({ ids: [running.sessionId] }, ctx())).results[0]?.status, 'completed');
});

test('any-condition detaches an open dialog without deciding its permission', async () => {
  const s = setup();
  const a = await s.engine.start({ prompt: 'approval', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const b = await start(s, 'completes');
  let dialogSignal: AbortSignal | undefined;
  const batch = s.engine.statusMany({ ids: [a.sessionId, b.sessionId], waitFor: 'any', waitSeconds: 10 }, {
    signal: new AbortController().signal,
    elicit: async (_request, signal) => { dialogSignal = signal; return new Promise<null>(() => {}); },
  });
  const request = { id: 'per_any', sessionID: a.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(request.id, request);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush(); assert.ok(dialogSignal);
  await finish(s, b.sessionId);
  assert.equal((await batch).reason, 'condition');
  await flush();
  assert.equal(dialogSignal.aborted, true);
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission').length, 0);
  assert.equal(s.connection.api.permissions.has(request.id), true);
});

test('batch deadline detaches dialog and preserves the permission deadline', async () => {
  const s = setup();
  const a = await s.engine.start({ prompt: 'approval', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const batch = s.engine.statusMany({ ids: [a.sessionId], waitSeconds: 1 }, {
    signal: new AbortController().signal,
    elicit: async () => new Promise<null>(() => {}),
  });
  await flush(); s.clock.tick(500);
  const request = { id: 'per_deadline', sessionID: a.sessionId, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] };
  s.connection.api.permissions.set(request.id, request);
  s.connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush(); s.clock.tick(500);
  assert.equal((await batch).reason, 'deadline');
  await flush();
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission').length, 0);
  assert.equal(s.connection.api.permissions.has(request.id), true);
  s.clock.tick(500);
  await flush();
  assert.equal(s.connection.api.calls.filter((c) => c.method === 'replyPermission' && c.args[2] === 'reject').length, 1);
});
