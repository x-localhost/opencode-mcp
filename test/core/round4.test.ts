import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const defaults = {
  mode: 'managed',
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1_000,
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 1_200_000,
  approvalTimeoutMs: 500,
  heartbeatMs: 100,
  statusPollMs: 100,
  sseStallMs: 1_000,
  cleanupTimeoutMs: 500,
  maxOutputChars: 2_000,
  endAction: 'delete',
  onExit: 'abort',
} as Config;

function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({
    config: { ...defaults, ...overrides },
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
}

function context(): CallContext {
  return { signal: new AbortController().signal };
}

function message(id: string, role: 'user' | 'assistant', finish?: string): OcMessage {
  return {
    info: {
      id,
      sessionID: 'ses_1',
      role,
      ...(role === 'assistant' ? { parentID: 'm01' } : {}),
      ...(finish ? { finish } : {}),
      time: { created: Number(id.slice(-2)), ...(finish ? { completed: 2 } : {}) },
    },
    parts: finish ? [{ id: `p_${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text: 'done' }] : [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

test('R1: accepted 204 stays running past no-user grace and later runner completes', async () => {
  const { connection, clock, engine } = setup();
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  clock.tick(200);
  await flush();
  const waiting = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, context());
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.executionState, 'active');
  connection.api.histories
    .get(started.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await flush();
  assert.equal((await engine.status({ sessionId: started.sessionId }, context())).status, 'completed');
});

test('R1: accepted 204 with no user remains quarantined after timeout and cannot be deleted', async () => {
  const { connection, clock, engine } = setup({ turnTimeoutMs: 300 });
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  clock.tick(300);
  await flush();
  clock.tick(500);
  await flush();
  const stopped = await engine.status({ sessionId: started.sessionId }, context());
  assert.equal(stopped.executionState, 'unknown');
  assert.equal(stopped.cleanup, 'unconfirmed');
  const ending = engine.end({ sessionId: started.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  await assert.rejects(ending, { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(
    connection.api.calls.some((call) => call.method === 'deleteSession'),
    false,
  );
});

test('R1: a session.error before dispatch cannot certify this prompt failed', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.api.warmInstance = async () => gate;
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const starting = engine.start({ prompt: 'work' }, context());
  await flush();
  const id = [...connection.api.sessions.keys()][0]!;
  connection.api.emit('/repo', {
    type: 'session.error',
    properties: { sessionID: id, error: { name: 'APIError', data: { message: 'old error' } } },
  });
  await flush();
  release();
  assert.equal((await starting).status, 'completed');
});

test('R3: new directory admission waits for disposal and then warms again', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  connection.api.disposeInstance = async (directory, request) => {
    connection.api.calls.push({ method: 'disposeInstance', args: [directory, request] });
    return gate;
  };
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    if (id === 'ses_1') {
      const failed = message('m02', 'assistant');
      failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
      history.push(message('m01', 'user'), failed);
    } else history.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const first = engine.start({ prompt: 'poisoned' }, context());
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  const second = engine.start({ prompt: 'next', waitSeconds: 0 }, context());
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
  release();
  await first;
  await second;
  assert.equal(connection.api.calls.filter((call) => call.method === 'warmInstance').length, 2);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 2);
});

test('R3: idle quarantined sibling allows instance disposal but stays unknown', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = () => {};
  const uncertain = await engine.start({ prompt: 'uncertain', waitSeconds: 0 }, context());
  const cancelling = engine.cancel({ sessionId: uncertain.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  assert.equal((await cancelling).executionState, 'unknown');
  connection.api.onPrompt = (id) => {
    const failed = message('m02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message('m01', 'user'), failed);
  };
  const poisoned = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(poisoned.error?.name, 'UnknownError');
  assert.equal(
    connection.api.calls.some((call) => call.method === 'disposeInstance'),
    true,
  );
  assert.match(poisoned.hint, /instance was reset/i);
  assert.equal((await engine.status({ sessionId: uncertain.sessionId }, context())).executionState, 'unknown');
});

test('R4: quarantine recovery holds the session gate and returns the old turn', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new Error('response lost');
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, context());
  for (let i = 0; i < 5; i++) {
    clock.tick(100);
    await flush();
    if ((await engine.status({ sessionId: first.sessionId }, context())).executionState === 'unknown') break;
  }
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  connection.api.promptFailure = undefined;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalAbort = connection.api.abort.bind(connection.api);
  connection.api.abort = async (id) => {
    await gate;
    return originalAbort(id);
  };
  const cancelling = engine.cancel({ sessionId: first.sessionId }, context());
  await flush();
  connection.api.histories
    .get(first.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  const observing = engine.status({ sessionId: first.sessionId }, context());
  await flush();
  await assert.rejects(
    engine.reply({ sessionId: first.sessionId, prompt: 'second', waitSeconds: 0 }, context()),
    {
      code: 'SESSION_BUSY',
    },
  );
  release();
  const cancelled = await cancelling;
  assert.equal(cancelled.turnId, first.turnId);
  assert.equal((await observing).turnId, first.turnId);
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m03', 'user'), message('m04', 'assistant', 'stop'));
  };
  assert.equal(
    (await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context())).status,
    'completed',
  );
});

test('R7: start and reply clamp large waits, but status still rejects above 600', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const next = history.length + 1;
    history.push(message(`m0${next}`, 'user'), message(`m0${next + 1}`, 'assistant', 'stop'));
  };
  const started = await engine.start({ prompt: 'first', waitSeconds: 1201 }, context());
  assert.equal(started.status, 'completed');
  const replied = await engine.reply(
    { sessionId: started.sessionId, prompt: 'second', waitSeconds: 1201 },
    context(),
  );
  assert.equal(replied.status, 'completed');
  await assert.rejects(engine.status({ sessionId: started.sessionId, waitSeconds: 601 }, context()), {
    code: 'INVALID_ARGUMENT',
  });
});
