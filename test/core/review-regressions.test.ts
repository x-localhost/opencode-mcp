import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { classifyOutcome, extractInterval } from '../../src/core/result.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, TurnResult } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = {
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  turnTimeoutMs: 120_000,
  maxTurnTimeoutMs: 120_000,
  approvalTimeoutMs: 1_000,
  heartbeatMs: 1_000,
  statusPollMs: 30_000,
  sseStallMs: 35_000,
  cleanupTimeoutMs: 500,
  maxOutputChars: 2_000,
  endAction: 'delete',
  onExit: 'abort',
} as Config;

function context(): CallContext {
  return { signal: new AbortController().signal };
}

function message(id: string, role: 'user' | 'assistant', text?: string): OcMessage {
  return {
    info: {
      id,
      sessionID: 'ses_1',
      role,
      time: { created: Number(id.slice(-2)) || 1 },
      ...(role === 'assistant' ? { parentID: 'm01', finish: 'stop' } : {}),
      ...(text ? { time: { created: Number(id.slice(-2)) || 1, completed: 2 } } : {}),
    },
    parts: text ? [{ id: `p_${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text }] : [],
  };
}

function setup() {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug(message: string, fields?: Record<string, unknown>) {
      logs.push({ level: 'debug', message, fields });
    },
    info(message: string, fields?: Record<string, unknown>) {
      logs.push({ level: 'info', message, fields });
    },
    warn(message: string, fields?: Record<string, unknown>) {
      logs.push({ level: 'warn', message, fields });
    },
    error(message: string, fields?: Record<string, unknown>) {
      logs.push({ level: 'error', message, fields });
    },
  };
  const engine = createEngine({ config, connection, clock, logger });
  return { connection, clock, engine, logs };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('a user message created 10 seconds after 204 still completes', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    clock.schedule(10_000, () => {
      connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'done'));
      connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
    });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  clock.tick(1_000);
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'running');
  for (let elapsed = 0; elapsed < 9_000; elapsed += 100) { clock.tick(100); await flush(); }
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'completed');
});

test('accepted prompt stays active after a full status poll without a user', async () => {
  const { clock, engine } = setup();
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  clock.tick(29_999);
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'running');
  clock.tick(1);
  await flush();
  const result = await engine.status({ sessionId: started.sessionId }, context());
  assert.equal(result.status, 'running');
  assert.equal(result.executionState, 'active');
});

test('ambiguous POST waits for a delayed user before quarantining', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost response', 0, 'NetworkError');
  connection.api.onPrompt = (id) => {
    clock.schedule(10_000, () => {
      connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'done'));
      connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
    });
  };
  let early: TurnResult | undefined;
  const pending = engine.start({ prompt: 'work', waitSeconds: 0 }, context()).then((result) => {
    early = result;
    return result;
  });
  await flush();
  clock.tick(1_000);
  await flush();
  assert.notEqual(early?.status, 'failed');
  for (let elapsed = 0; elapsed < 9_000; elapsed += 100) { clock.tick(100); await flush(); }
  const admitted = await pending;
  for (let i = 0; i < 20 && !connection.api.histories.get(admitted.sessionId)?.length; i++) {
    clock.tick(100);
    await flush();
  }
  for (let i = 0; i < 5; i++) { clock.tick(100); await flush(); }
  const final = await engine.status({ sessionId: admitted.sessionId }, context());
  assert.equal(final.status, 'completed');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('busy activity defers no-user grace until the turn can finish', async () => {
  const { connection, clock, engine } = setup();
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  clock.tick(1_000);
  await flush();
  connection.api.statuses.set(started.sessionId, { type: 'busy' });
  connection.api.emit('/repo', {
    type: 'session.status',
    properties: { sessionID: started.sessionId, status: { type: 'busy' } },
  });
  await flush();
  clock.tick(30_000);
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'running');
  connection.api.histories
    .get(started.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'done'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'completed');
});

test('last non-summary assistant determines outcome after compaction', () => {
  const user = message('m01', 'user');
  const earlier = message('m02', 'assistant');
  earlier.info.error = { name: 'ContextOverflowError', data: { message: 'overflow' } };
  earlier.parts = [
    {
      id: 'tool_old',
      sessionID: 'ses_1',
      messageID: earlier.info.id,
      type: 'tool',
      tool: 'read',
      state: { status: 'running' },
    },
  ];
  const summary = message('m03', 'assistant', 'compaction summary');
  summary.info.summary = true;
  const final = message('m04', 'assistant', 'answer');
  assert.equal(classifyOutcome([user, earlier, summary, final], true).status, 'completed');
  final.info.error = { name: 'APIError', data: { message: 'final failed' } };
  assert.equal(classifyOutcome([user, earlier, summary, final], true).error?.name, 'APIError');
});

test('generation loss fails the old turn with partial text and no new stream', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'partial'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.unavailable();
  await flush();
  const result = await engine.status({ sessionId: started.sessionId }, context());
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, {
    name: 'OPENCODE_UNAVAILABLE',
    message: 'OpenCode server stopped during the turn',
  });
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.content, 'partial');
  assert.equal(connection.api.subscribeCount, 1);
});

test('reconnect lease on a new generation also fails the old turn', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.generation++;
  connection.api.disconnect('/repo');
  await flush();
  clock.tick(600);
  await flush();
  // R10: the recovery refresh (which detects the generation mismatch via connection.acquire())
  // is jittered by up to 2000ms after the reconnect above completes.
  clock.tick(2_100);
  await flush();
  const result = await engine.status({ sessionId: started.sessionId }, context());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'OPENCODE_UNAVAILABLE');
  assert.equal(result.executionState, 'stopped');
  // R11/R10: the hub now only notifies listeners after a *real* server.connected, so detecting the
  // stale generation via connection.acquire() in refreshAfterReconnect necessarily happens one
  // subscribe() attempt later than before (was 1: the old pre-backoff emission let the turn tear
  // down the stream before the hub ever retried subscribe()). The turn still fails exactly once,
  // with no further live stream after that.
  assert.equal(connection.api.subscribeCount, 2);
});

test('interval sorts ordinally and the later fetched page replaces a duplicate wholly', () => {
  const first = message('msg_a', 'assistant', 'first');
  first.info.finish = 'stop';
  const later = message('msg_a', 'assistant', 'later');
  later.info.finish = 'tool-calls';
  const upper = message('msg_Z', 'assistant');
  const interval = extractInterval([[first, upper], [later]], undefined);
  assert.deepEqual(
    interval.map((item) => item.info.id),
    ['msg_Z', 'msg_a'],
  );
  assert.equal(interval[1]?.info.finish, 'tool-calls');
  assert.deepEqual(
    interval[1]?.parts.map((part) => part.text),
    ['later'],
  );
});

test('turn lifecycle and approval logs contain safe identifiers only', async () => {
  const { connection, engine, logs } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    {
      prompt: 'prompt-secret',
      baseInstructions: 'instruction-secret',
      waitSeconds: 0,
    },
    context(),
  );
  const request = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['pattern-secret'],
    metadata: { token: 'metadata-secret' },
    always: ['*'],
  };
  connection.api.permissions.set(request.id, request);
  connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush();
  connection.api.histories.get(started.sessionId)!.push(message('m02', 'assistant', 'done'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'completed');
  const messages = logs.map((log) => log.message);
  assert.ok(messages.some((message) => message.includes('admitted')));
  assert.ok(messages.some((message) => message.includes('submitted')));
  assert.ok(messages.some((message) => message.includes('reconcile')));
  assert.ok(messages.some((message) => message.includes('approval')));
  const serialized = JSON.stringify(logs);
  for (const secret of ['prompt-secret', 'instruction-secret', 'pattern-secret', 'metadata-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('stop logs its reason and confirmed result without the prompt', async () => {
  const { connection, engine, logs } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'stop-secret', waitSeconds: 0 }, context());
  const result = await engine.cancel({ sessionId: started.sessionId }, context());
  assert.equal(result.status, 'cancelled');
  const stop = logs.find((log) => log.message === 'Turn stop result');
  assert.equal(stop?.fields?.reason, 'cancelled');
  assert.equal(stop?.fields?.executionState, 'stopped');
  assert.equal(JSON.stringify(logs).includes('stop-secret'), false);
});
