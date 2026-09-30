import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = {
  mode: 'managed',
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1_000,
  turnTimeoutMs: 300,
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
    config,
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
}

function context(): CallContext {
  return { signal: new AbortController().signal };
}

function message(sessionID: string, id: string, role: 'user' | 'assistant', finish?: string): OcMessage {
  return {
    info: {
      id,
      sessionID,
      role,
      ...(role === 'assistant' ? { parentID: 'm01' } : {}),
      ...(finish ? { finish } : {}),
      time: { created: Number(id.slice(-2)), ...(finish ? { completed: 2 } : {}) },
    },
    parts: finish ? [{ id: `p_${id}`, sessionID, messageID: id, type: 'text', text: 'done' }] : [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

test('U07(a): idle quarantined sibling does not block poison disposal or gain false terminal evidence', async () => {
  const { connection, clock, engine } = setup();
  const sibling = await engine.start({ prompt: 'uncertain', waitSeconds: 0 }, context());
  clock.tick(300);
  await flush();
  clock.tick(500);
  await flush();
  assert.equal((await engine.status({ sessionId: sibling.sessionId }, context())).executionState, 'unknown');
  connection.api.onPrompt = (id) => {
    const failed = message(id, 'm02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message(id, 'm01', 'user'), failed);
  };
  const poisoned = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(poisoned.error?.name, 'UnknownError');
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  assert.match(poisoned.hint, /instance was reset/i);
  assert.equal((await engine.status({ sessionId: sibling.sessionId }, context())).executionState, 'unknown');
  assert.equal((await engine.list()).sessions.find((session) => session.sessionId === sibling.sessionId)?.status, 'quarantined');
});

test('U07(b): a blocking turn finishing starts deferred recovery before the next POST', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message(id, 'm01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const long = await engine.start({ prompt: 'long', waitSeconds: 0 }, context());
  connection.api.onPrompt = (id) => {
    const failed = message(id, 'm02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message(id, 'm01', 'user'), failed);
  };
  const poisoned = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(poisoned.error?.name, 'UnknownError');
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 0);
  connection.api.histories.get(long.sessionId)!.push(message(long.sessionId, 'm02', 'assistant', 'stop'));
  connection.api.statuses.delete(long.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: long.sessionId } });
  await flush();
  assert.equal((await engine.status({ sessionId: long.sessionId }, context())).status, 'completed');
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message(id, 'm03', 'user'), message(id, 'm04', 'assistant', 'stop'));
  };
  assert.equal((await engine.reply({ sessionId: poisoned.sessionId, prompt: 'retry' }, context())).status, 'completed');
  const calls = connection.api.calls.map((call) => call.method);
  assert.ok(calls.lastIndexOf('warmInstance') > calls.lastIndexOf('disposeInstance'));
  assert.ok(calls.lastIndexOf('warmInstance') < calls.lastIndexOf('promptAsync'));
});

test('U07(b): a settled sibling abort marker also re-arms deferred recovery', async () => {
  const { connection, clock, engine } = setup();
  const sibling = await engine.start({ prompt: 'uncertain', waitSeconds: 0 }, context());
  clock.tick(300);
  await flush();
  clock.tick(500);
  await flush();
  assert.equal((await engine.status({ sessionId: sibling.sessionId }, context())).executionState, 'unknown');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalAbort = connection.api.abort.bind(connection.api);
  connection.api.abort = async (id, request) => {
    await gate;
    return originalAbort(id, request);
  };
  const cancelling = engine.cancel({ sessionId: sibling.sessionId }, context());
  await flush();
  connection.api.onPrompt = (id) => {
    const failed = message(id, 'm02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message(id, 'm01', 'user'), failed);
  };
  const poisoned = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(poisoned.error?.name, 'UnknownError');
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 0);
  release();
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  clock.tick(500);
  await flush();
  assert.equal((await cancelling).executionState, 'unknown');
});

test('U07(c): a turn after an external instance disposal warms before dispatch', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const next = history.length + 1;
    history.push(message(id, `m0${next}`, 'user'), message(id, `m0${next + 1}`, 'assistant', 'stop'));
  };
  const first = await engine.start({ prompt: 'first' }, context());
  assert.equal(first.status, 'completed');
  await connection.api.disposeInstance('/repo');
  assert.equal((await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, context())).status, 'completed');
  const calls = connection.api.calls.map((call) => call.method);
  assert.equal(calls.filter((method) => method === 'warmInstance').length, 2);
  assert.ok(calls.lastIndexOf('warmInstance') > calls.lastIndexOf('disposeInstance'));
  assert.ok(calls.lastIndexOf('warmInstance') < calls.lastIndexOf('promptAsync'));
});

test('U07(d): list keeps the newest running session ahead of 104 old idle sessions', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    if (id === 'ses_105') {
      connection.api.histories.get(id)!.push(message(id, 'm01', 'user'));
      connection.api.statuses.set(id, { type: 'busy' });
    } else connection.api.histories.get(id)!.push(message(id, 'm01', 'user'), message(id, 'm02', 'assistant', 'stop'));
  };
  for (let i = 0; i < 104; i++) {
    assert.equal((await engine.start({ prompt: `old ${i}` }, context())).status, 'completed');
    clock.tick(1);
  }
  const newest = await engine.start({ prompt: 'running', waitSeconds: 0 }, context());
  assert.equal(newest.status, 'running');
  const listed = await engine.list();
  assert.equal(listed.truncated, true);
  assert.equal(listed.sessions.length, 100);
  assert.equal(listed.sessions[0]?.sessionId, newest.sessionId);
  assert.equal(listed.sessions[0]?.status, 'running');
  assert.equal(listed.sessions.some((session) => session.sessionId === 'ses_1'), false);
});
