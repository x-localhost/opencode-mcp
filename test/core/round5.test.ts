import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, OcPermissionRequest } from '../../src/types.ts';
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
  maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 500,
  heartbeatMs: 100,
  statusPollMs: 100,
  sseStallMs: 1_000,
  cleanupTimeoutMs: 500,
  maxOutputChars: 2_000,
  endAction: 'delete',
  onExit: 'abort',
} as Config;

function setup() {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({
    config: defaults,
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

test('F2: timed-out disposal quarantines directory and bounded retry cannot overlap a prompt', async () => {
  const { connection, clock, engine } = setup();
  let disposeCalls = 0;
  connection.api.disposeInstance = async () => {
    disposeCalls++;
    return new Promise<boolean>(() => {});
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
  clock.tick(500);
  await flush();
  assert.equal((await first).error?.name, 'UnknownError');
  const second = engine.start({ prompt: 'next', waitSeconds: 0 }, context());
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
  assert.equal(disposeCalls, 2);
  const third = engine.start({ prompt: 'concurrent', waitSeconds: 0 }, context());
  await flush();
  await assert.rejects(third, {
    code: 'OPENCODE_UNAVAILABLE',
    message: /directory instance.*being recovered/i,
  });
  clock.tick(500);
  await flush();
  await assert.rejects(second, {
    code: 'OPENCODE_UNAVAILABLE',
    message: /directory instance.*being recovered/i,
  });
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('F2: next admission retries failed disposal, then re-warms before POST', async () => {
  const { connection, engine } = setup();
  let disposeCalls = 0;
  connection.api.disposeInstance = async () => {
    disposeCalls++;
    if (disposeCalls === 1) throw new OpencodeHttpError('lost response', 0, 'NetworkError');
    return true;
  };
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    if (id === 'ses_1') {
      const failed = message('m02', 'assistant');
      failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
      history.push(message('m01', 'user'), failed);
    } else history.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const first = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(first.error?.name, 'UnknownError');
  const second = await engine.start({ prompt: 'retry' }, context());
  assert.equal(second.status, 'completed');
  assert.equal(disposeCalls, 2);
  assert.equal(connection.api.calls.filter((call) => call.method === 'warmInstance').length, 2);
});

test('F2: successful retry does not admit a prompt while an older disposal is still pending', async () => {
  const { connection, clock, engine } = setup();
  let release = () => {};
  const firstDispose = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  let calls = 0;
  connection.api.disposeInstance = async () => (++calls === 1 ? firstDispose : true);
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    if (id === 'ses_1') {
      const failed = message('m02', 'assistant');
      failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
      history.push(message('m01', 'user'), failed);
    } else history.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const poisoned = engine.start({ prompt: 'poisoned' }, context());
  await flush();
  clock.tick(500);
  await flush();
  await poisoned;
  await assert.rejects(engine.start({ prompt: 'retry' }, context()), {
    code: 'OPENCODE_UNAVAILABLE',
  });
  assert.equal(calls, 2);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
  release();
  await flush();
  assert.equal((await engine.start({ prompt: 'safe' }, context())).status, 'completed');
});

test('F2: managed generation loss releases a quarantined directory without retrying disposal', async () => {
  const { connection, engine } = setup();
  let disposeCalls = 0;
  connection.api.disposeInstance = async () => {
    disposeCalls++;
    throw new OpencodeHttpError('lost response', 0, 'NetworkError');
  };
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    if (id === 'ses_1') {
      const failed = message('m02', 'assistant');
      failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
      history.push(message('m01', 'user'), failed);
    } else history.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  await engine.start({ prompt: 'poisoned' }, context());
  connection.unavailable();
  assert.equal((await engine.start({ prompt: 'after restart' }, context())).status, 'completed');
  assert.equal(disposeCalls, 1);
  assert.equal(connection.api.calls.filter((call) => call.method === 'warmInstance').length, 2);
});

test('F3: timed-out abort keeps quarantine until its original request settles', async () => {
  const { connection, clock, engine } = setup();
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, context());
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abort = connection.api.abort.bind(connection.api);
  connection.api.abort = async (id) => {
    await gate;
    return abort(id);
  };
  const cancelling = engine.cancel({ sessionId: first.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  assert.equal((await cancelling).executionState, 'unknown');
  connection.api.histories
    .get(first.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context()), {
    code: 'SESSION_BUSY',
    message: /pending upstream recovery/i,
  });
  release();
  await flush();
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'stopped');
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m03', 'user'), message('m04', 'assistant', 'stop'));
  };
  assert.equal(
    (await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context())).status,
    'completed',
  );
});

test('F3: a later quarantine-cancel tracks its abort beyond the recovery deadline', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('response lost', 0, 'NetworkError');
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
  const abort = connection.api.abort.bind(connection.api);
  connection.api.abort = async (id) => {
    await gate;
    return abort(id);
  };
  const cancelling = engine.cancel({ sessionId: first.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  assert.equal((await cancelling).executionState, 'unknown');
  connection.api.histories
    .get(first.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context()), {
    code: 'SESSION_BUSY',
  });
  release();
  await flush();
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'stopped');
});

test('F3: a settled network-ambiguous abort remains quarantined without a blind retry', async () => {
  const { connection, engine } = setup();
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, context());
  const originalAbort = connection.api.abort.bind(connection.api);
  connection.api.abort = async () => {
    throw new OpencodeHttpError('lost response', 0, 'NetworkError');
  };
  assert.equal((await engine.cancel({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  connection.api.histories
    .get(first.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'next' }, context()), {
    code: 'SESSION_BUSY',
  });
  connection.api.abort = originalAbort;
  const checking = engine.cancel({ sessionId: first.sessionId }, context());
  // The recovery inspection can observe history but cannot fence a delayed abort.
  assert.equal((await checking).executionState, 'unknown');
  assert.equal(connection.generation, 1);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
});

test('F3: a definitive HTTP abort error clears the mutation marker before evidence recovery', async () => {
  const { connection, engine } = setup();
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, context());
  connection.api.abort = async () => {
    throw new OpencodeHttpError('missing', 404, 'NotFoundError');
  };
  assert.equal((await engine.cancel({ sessionId: first.sessionId }, context())).executionState, 'unknown');
  connection.api.histories
    .get(first.sessionId)!
    .push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  assert.equal((await engine.status({ sessionId: first.sessionId }, context())).executionState, 'stopped');
});

test('F3: timed-out permission reject also blocks quarantine release', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, context());
  const permission = {
    id: 'per_1',
    sessionID: first.sessionId,
    permission: 'bash',
    patterns: ['*'],
    metadata: {},
  } as OcPermissionRequest;
  connection.api.permissions.set(permission.id, permission);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reply = connection.api.replyPermission.bind(connection.api);
  connection.api.replyPermission = async (directory, id, decision, messageText) => {
    await gate;
    return reply(directory, id, decision, messageText);
  };
  const cancelling = engine.cancel({ sessionId: first.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  // FakeApi acknowledges abort with a terminal MessageAbortedError assistant and idle status.
  // Execution is stopped; the hanging permission reject leaves cleanup unconfirmed.
  const stopped = await cancelling;
  const abortAssistant = connection.api.histories.get(first.sessionId)!
    .find((item) => item.info.role === 'assistant' && item.info.error?.name === 'MessageAbortedError');
  assert.equal(typeof abortAssistant?.info.time.completed, 'number');
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'unconfirmed');
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'next' }, context()),
    { code: 'SESSION_BUSY' });
  release();
  await flush();
  const recovered = await engine.status({ sessionId: first.sessionId }, context());
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.cleanup, 'complete');
});

test('F3: an unresolved end deletion cannot later remove a newly admitted reply', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const first = await engine.start({ prompt: 'first' }, context());
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deletion = connection.api.deleteSession.bind(connection.api);
  connection.api.deleteSession = async (id) => {
    await gate;
    return deletion(id);
  };
  const ending = engine.end({ sessionId: first.sessionId }, context());
  let settled = false;
  void ending.catch(() => {
    settled = true;
  });
  try {
    await flush();
    clock.tick(500);
    await flush();
    assert.equal(settled, true);
    await assert.rejects(ending, { code: 'CLEANUP_UNCONFIRMED' });
    // P2-1 (core review): a bare in-flight delete/archive marker must not downgrade
    // the turn's own executionState — reserveReply already blocks on the unresolved delete marker
    // below regardless of settlement or executionState, so a reply is still refused.
    await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context()), {
      code: 'SESSION_BUSY',
    });
  } finally {
    release();
  }
});
