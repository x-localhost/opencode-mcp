import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, PromptBody } from '../../src/types.ts';
const config = {
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
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
test('wait zero, status wait, reply re-sends instructions, end deletes', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    { prompt: 'hello', waitSeconds: 0, baseInstructions: 'base', developerInstructions: 'dev', model: 'p/m' },
    ctx(),
  );
  assert.equal(started.status, 'running');
  assert.equal(started.sessionId, 'ses_1');
  const body = connection.api.calls.find((x) => x.method === 'promptAsync')!.args[1] as PromptBody;
  assert.equal(body.system, 'base\n\ndev');
  assert.deepEqual(body.model, { providerID: 'p', modelID: 'm' });
  assert.equal('tools' in body, false);
  connection.api.histories.get('ses_1')!.push(msg('m2', 'assistant', 'm1', 'stop'));
  connection.api.statuses.delete('ses_1');
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: 'ses_1' } });
  await flush();
  const result = await engine.status({ sessionId: 'ses_1', waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.content, 'done');
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m3', 'user'), msg('m4', 'assistant', 'm3', 'stop'));
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
  const reply = await engine.reply({ sessionId: 'ses_1', prompt: 'again' }, ctx());
  assert.equal(reply.status, 'completed');
  const body2 = connection.api.calls.filter((x) => x.method === 'promptAsync')[1]!.args[1] as PromptBody;
  assert.equal(body2.system, 'base\n\ndev');
  const ended = await engine.end({ sessionId: 'ses_1' }, ctx());
  assert.equal(ended.status, 'ended');
  assert.ok(connection.api.calls.some((x) => x.method === 'deleteSession'));
});
test('status with positive wait observes terminal evidence after wait-zero start', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  const waiting = engine.status({ sessionId: started.sessionId, waitSeconds: 10 }, ctx());
  await flush();
  connection.api.histories.get(started.sessionId)!.push(msg('m2', 'assistant', 'm1', 'stop'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  assert.equal((await waiting).status, 'completed');
});
test('lost submission response never retries and quarantine blocks reply', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  clock.tick(500);
  await flush();
  clock.tick(500);
  const result = await pending;
  assert.equal(result.error?.name, 'SUBMISSION_UNCONFIRMED');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
  await assert.rejects(engine.reply({ sessionId: result.sessionId, prompt: 'again' }, ctx()), {
    code: 'SESSION_BUSY',
  });
});
test('later status requires submitted terminal evidence before releasing quarantine', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  clock.tick(500);
  await flush();
  clock.tick(500);
  const result = await pending;
  assert.equal(result.executionState, 'unknown');
  const checked = await engine.status({ sessionId: result.sessionId }, ctx());
  assert.equal(checked.executionState, 'unknown');
  await assert.rejects(engine.reply({ sessionId: result.sessionId, prompt: 'too early' }, ctx()), {
    code: 'SESSION_BUSY',
  });
  connection.api.histories
    .get(result.sessionId)!
    .push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  assert.equal((await engine.status({ sessionId: result.sessionId }, ctx())).executionState, 'stopped');
  connection.api.promptFailure = undefined;
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  assert.equal(
    (await engine.reply({ sessionId: result.sessionId, prompt: 'again' }, ctx())).status,
    'completed',
  );
});
test('startup session.error without user remains a candidate until execution evidence', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.emit('/repo', {
      type: 'session.error',
      properties: { sessionID: id, error: { name: 'APIError', data: { message: 'bad agent' } } },
    });
  };
  const r = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  assert.equal(r.status, 'running');
  assert.equal(r.executionState, 'active');
});
test('network failure during admission becomes OPENCODE_UNAVAILABLE error', async () => {
  const { connection, engine } = setup();
  connection.api.statusFailure = new OpencodeHttpError('status unavailable', 0, 'NetworkError');
  await assert.rejects(engine.start({ prompt: 'hello' }, ctx()), { code: 'OPENCODE_UNAVAILABLE' });
});
test('SSE admission is bounded when server.connected never arrives', async () => {
  const { connection, clock, engine } = setup();
  connection.api.autoConnected = false;
  const pending = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  clock.tick(2000);
  await assert.rejects(pending, { code: 'OPENCODE_UNAVAILABLE' });
});
test('session.error after a user message preserves partial assistant text', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const partial = msg('m2', 'assistant', 'm1');
    partial.info.error = { name: 'APIError', data: { message: 'provider failed' } };
    partial.parts = [{ id: 'p2', sessionID: id, messageID: 'm2', type: 'text', text: 'partial answer' }];
    connection.api.histories.get(id)!.push(msg('m1', 'user'), partial);
    connection.api.emit('/repo', {
      type: 'session.error',
      properties: { sessionID: id, error: { name: 'APIError', data: { message: 'provider failed' } } },
    });
  };
  const result = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.content, 'partial answer');
});
test('permission never rejects exactly; on-request wakes when observer attaches and replies once', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  const request = {
    id: 'per_1',
    sessionID: first.sessionId,
    permission: 'bash',
    patterns: ['echo hi'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(request.id, request);
  connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush();
  assert.ok(
    connection.api.calls.some(
      (x) =>
        x.method === 'replyPermission' &&
        x.args[2] === 'reject' &&
        x.args[3] === 'Denied by opencode-mcp: approval-policy=never (no interactive approval available)',
    ),
  );
  const second = await engine.start({ prompt: 'other', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = { ...request, id: 'per_2', sessionID: second.sessionId };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  await flush();
  let called = 0;
  const controller = new AbortController();
  const observing = engine.status(
    { sessionId: second.sessionId, waitSeconds: 10 },
    {
      signal: controller.signal,
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
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_2' && x.args[2] === 'once',
    ),
  );
  controller.abort();
  await observing;
});
test('end aborts before permission cleanup before delete, archive keeps upstream session', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  connection.api.permissions.set('per_1', {
    id: 'per_1',
    sessionID: first.sessionId,
    permission: 'edit',
    patterns: ['a'],
    metadata: {},
    always: [],
  });
  const result = await engine.end({ sessionId: first.sessionId }, ctx());
  assert.equal(result.status, 'ended');
  const methods = connection.api.calls.map((x) => x.method);
  assert.ok(methods.indexOf('abort') < methods.lastIndexOf('replyPermission'));
  assert.ok(methods.lastIndexOf('replyPermission') < methods.indexOf('deleteSession'));
  const missing = await engine.end({ sessionId: 'missing' }, ctx());
  assert.equal(missing.status, 'not_found');
  const second = await engine.start({ prompt: 'new', waitSeconds: 0 }, ctx());
  const archived = await engine.end({ sessionId: second.sessionId, action: 'archive' }, ctx());
  assert.equal(archived.action, 'archive');
  assert.ok(connection.api.sessions.get(second.sessionId)?.time.archived !== undefined);
});
test('unconfirmed stop keeps entry and blocks delete', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  connection.api.abortFailure = new Error('lost');
  await assert.rejects(engine.end({ sessionId: started.sessionId }, ctx()), { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(connection.api.calls.filter((x) => x.method === 'deleteSession').length, 0);
  assert.equal((await engine.list()).sessions.length, 1);
});
test('end bounds a prompt submission that never resolves and never deletes', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = () => new Promise<void>(() => {});
  const started = engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  await flush();
  const ending = engine.end({ sessionId: 'ses_1' }, ctx());
  await flush();
  clock.tick(500);
  await assert.rejects(ending, { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(connection.api.calls.filter((x) => x.method === 'deleteSession').length, 0);
  void started;
});
test('end keeps a busy session when abort returns but idle is never confirmed', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  connection.api.abortKeepsBusy = true;
  const ending = engine.end({ sessionId: started.sessionId }, ctx());
  for (let i = 0; i < 7; i++) {
    await flush();
    clock.tick(100);
  }
  await assert.rejects(ending, { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(connection.api.calls.filter((x) => x.method === 'deleteSession').length, 0);
});
test('accepted prompt with lost HTTP response completes without duplicate submission', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const result = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
});
test('ambiguous prompt failure allows delayed user message during grace without retry', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    clock.schedule(50, () => {
      connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
      connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
    });
  };
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const running = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  assert.ok(connection.api.calls.some((call) => call.method === 'promptAsync'));
  clock.tick(500);
  await flush();
  clock.tick(500);
  const result = await running;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
});
test('owning cancellation stops, observer cancellation detaches, and both observers get heartbeats', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  const one = new AbortController(),
    two = new AbortController(),
    a: string[] = [],
    b: string[] = [];
  const p1 = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    { signal: one.signal, progress: (x) => a.push(x) },
  );
  const p2 = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    { signal: two.signal, progress: (x) => b.push(x) },
  );
  await flush();
  clock.tick(100);
  await flush();
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  one.abort();
  await p1;
  assert.equal(connection.api.calls.filter((x) => x.method === 'abort').length, 0);
  two.abort();
  await p2;
  const controller = new AbortController();
  const own = engine.reply({ sessionId: started.sessionId, prompt: 'again' }, { signal: controller.signal });
  await assert.rejects(own, { code: 'SESSION_BUSY' });
  const cancelled = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(cancelled.status, 'cancelled');
});
test('owning abort while attached returns cancelled after confirmed stop', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  connection.api.onPrompt = async (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
    await gate;
  };
  const controller = new AbortController();
  const running = engine.start({ prompt: 'hello' }, { signal: controller.signal });
  await flush();
  release();
  await flush();
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  assert.ok(connection.api.calls.some((x) => x.method === 'abort'));
});
test('delayed prompt submission and idle before busy do not complete early; owning abort stops after submission', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  connection.api.onPrompt = async (id) => {
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
    await gate;
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const controller = new AbortController();
  const started = engine.start({ prompt: 'hello' }, { signal: controller.signal });
  await flush();
  controller.abort();
  await flush();
  assert.equal(connection.api.calls.filter((x) => x.method === 'abort').length, 0);
  release();
  const result = await started;
  assert.equal(result.status, 'cancelled');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
});
test('tool-calls finish at idle becomes TURN_INCOMPLETE and keeps partial text', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'tool-calls'));
  };
  const pending = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  for (let elapsed = 0; elapsed < 5_200; elapsed += 100) { clock.tick(100); await flush(); }
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'TURN_INCOMPLETE');
  assert.equal(result.content, 'done');
});
test('idle with no user after an accepted prompt remains active past grace', async () => {
  const { clock, engine } = setup();
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  await flush();
  clock.tick(500);
  await flush();
  clock.tick(500);
  await flush();
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(result.status, 'running');
  assert.equal(result.executionState, 'active');
});
test('reply reservations serialize and end suppresses a late admission POST', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const first = await engine.start({ prompt: 'hello' }, ctx());
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m3', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const reply = engine.reply({ sessionId: first.sessionId, prompt: 'again', waitSeconds: 0 }, ctx());
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'racing' }, ctx()), {
    code: 'SESSION_BUSY',
  });
  const ended = engine.end({ sessionId: first.sessionId }, ctx());
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'too late' }, ctx()), {
    code: 'SESSION_BUSY',
  });
  await reply;
  assert.equal((await ended).status, 'ended');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
});
test('concurrent cancel and end share one stop operation', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  const cancelled = engine.cancel({ sessionId: started.sessionId }, ctx());
  const ended = engine.end({ sessionId: started.sessionId }, ctx());
  assert.equal((await cancelled).status, 'cancelled');
  assert.equal((await ended).status, 'ended');
  assert.equal(connection.api.calls.filter((x) => x.method === 'abort').length, 1);
});
test('late approval after cancel never sends once and stale requests reject before next prompt', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 }, ctx());
  const ask = {
    id: 'per_late',
    sessionID: first.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  let answer: (x: { decision: 'allow' }) => void = () => {};
  const elicitation = new Promise<{ decision: 'allow' }>((resolve) => {
    answer = resolve;
  });
  const observerAbort = new AbortController();
  const observer = engine.status(
    { sessionId: first.sessionId, waitSeconds: 10 },
    { signal: observerAbort.signal, elicit: () => elicitation },
  );
  await flush();
  await engine.cancel({ sessionId: first.sessionId }, ctx());
  answer({ decision: 'allow' });
  observerAbort.abort();
  await observer;
  await flush();
  assert.equal(
    connection.api.calls.filter((x) => x.method === 'replyPermission' && x.args[2] === 'once').length,
    0,
  );
  connection.api.permissions.set('per_stale', { ...ask, id: 'per_stale' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m3', 'user'), msg('m4', 'assistant', 'm3', 'stop'));
  };
  const reply = await engine.reply({ sessionId: first.sessionId, prompt: 'again' }, ctx());
  assert.equal(reply.status, 'completed');
  const calls = connection.api.calls;
  const staleRejectIdx = calls.findIndex(
    (x) => x.method === 'replyPermission' && x.args[1] === 'per_stale',
  );
  assert.ok(staleRejectIdx >= 0, 'expected per_stale to be rejected before the next prompt');
  assert.equal(calls[staleRejectIdx]!.args[2], 'reject');
  assert.ok(staleRejectIdx < [...calls].map((x) => x.method).lastIndexOf('promptAsync'));
  assert.equal(connection.api.permissions.has('per_stale'), false);
});
test('shutdown with onExit=end rejects new calls, ends tracked sessions, closes connection', async () => {
  const connection = new FakeConnection(),
    clock = new FakeClock();
  const engine = createEngine({
    config: { ...config, onExit: 'end' },
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  await engine.start({ prompt: 'hello' }, ctx());
  await engine.shutdown('test');
  await engine.shutdown('again');
  assert.equal(connection.closed, true);
  assert.equal(connection.api.calls.filter((x) => x.method === 'deleteSession').length, 1);
  await assert.rejects(engine.start({ prompt: 'new' }, ctx()), { code: 'SHUTTING_DOWN' });
});
test('shutdown rejects leftover permissions and questions even on idle tracked sessions', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const started = await engine.start({ prompt: 'hello' }, ctx());
  connection.api.permissions.set('per_idle', {
    id: 'per_idle',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['*'],
    metadata: {},
    always: [],
  });
  connection.api.questions.set('q_idle', { id: 'q_idle', sessionID: started.sessionId, questions: [] });
  await engine.shutdown('test');
  assert.equal(connection.api.permissions.size, 0);
  assert.equal(connection.api.questions.size, 0);
});
test('approval reject, null, deadline, and stale verification all avoid once', async () => {
  for (const decision of [{ decision: 'reject' as const, feedback: 'no' }, null]) {
    const { connection, engine } = setup();
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(msg('m1', 'user'));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    const started = await engine.start(
      { prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 },
      ctx(),
    );
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
      { signal: abort.signal, elicit: async () => decision },
    );
    await flush();
    assert.ok(connection.api.calls.some((x) => x.method === 'replyPermission' && x.args[2] === 'reject'));
    assert.equal(
      connection.api.calls.filter((x) => x.method === 'replyPermission' && x.args[2] === 'once').length,
      0,
    );
    abort.abort();
    await observer;
  }
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    { prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 },
    ctx(),
  );
  const ask = {
    id: 'per_2',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.emit('/repo', { type: 'permission.asked', properties: ask });
  await flush();
  clock.tick(1000);
  await flush();
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'replyPermission' && x.args[1] === 'per_2' && x.args[2] === 'reject',
    ),
  );
  const stale = { ...ask, id: 'per_stale' };
  connection.api.permissions.set(stale.id, stale);
  connection.api.emit('/repo', { type: 'permission.asked', properties: stale });
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: abort.signal,
      elicit: async () => {
        connection.api.permissions.delete(stale.id);
        return { decision: 'allow' };
      },
    },
  );
  await flush();
  assert.equal(
    connection.api.calls.filter((x) => x.method === 'replyPermission' && x.args[1] === 'per_stale').length,
    0,
  );
  abort.abort();
  await observer;
});
test('SSE reconnect during permission wait keeps observation alive until generation loss', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    { prompt: 'hello', approvalPolicy: 'on-request', waitSeconds: 0 },
    ctx(),
  );
  const ask = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(ask.id, ask);
  connection.api.disconnect('/repo');
  await flush();
  clock.tick(600);
  await flush();
  const abort = new AbortController();
  const observer = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    { signal: abort.signal, elicit: async () => ({ decision: 'allow' }) },
  );
  await flush();
  assert.ok(connection.api.calls.some((x) => x.method === 'replyPermission' && x.args[2] === 'once'));
  connection.unavailable();
  await flush();
  assert.equal(connection.api.subscribeCount, 2);
  assert.equal(
    (await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).error?.name,
    'OPENCODE_UNAVAILABLE',
  );
  abort.abort();
  await observer;
});
test('unexpected connection generation loss mid-turn fails without reattaching', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  connection.unavailable();
  await flush();
  assert.equal(connection.api.subscribeCount, 1);
  connection.api.histories.get(started.sessionId)!.push(msg('m2', 'assistant', 'm1', 'stop'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await flush();
  const result = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'OPENCODE_UNAVAILABLE');
});
test('engine reads more than 100 messages including compaction and selects final answer', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    history.push(msg('m001', 'user'));
    for (let i = 2; i <= 125; i++)
      history.push({
        ...msg(`m${String(i).padStart(3, '0')}`, 'assistant', 'm001', 'tool-calls'),
        parts: [],
      });
    const summary = msg('m126', 'assistant', 'm001', 'stop');
    summary.info.summary = true;
    summary.parts[0]!.text = 'old summary';
    history.push(summary);
    const final = msg('m127', 'assistant', 'm001', 'stop');
    final.parts[0]!.text = 'final';
    history.push(final);
  };
  const result = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'final');
  assert.ok(connection.api.calls.filter((x) => x.method === 'messages').length >= 2);
});
test('turn timeout stops through abort and returns timeout', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', timeoutSeconds: 1, waitSeconds: 0 }, ctx());
  clock.tick(1000);
  await flush();
  await flush();
  const result = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'timeout');
  assert.ok(connection.api.calls.some((x) => x.method === 'abort'));
});
