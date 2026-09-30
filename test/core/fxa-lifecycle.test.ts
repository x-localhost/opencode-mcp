import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { extractOutputArtifacts, summarizeInterval } from '../../src/core/result.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = { defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  mode: 'attach', defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000, approvalTimeoutMs: 1000,
  heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000, cleanupTimeoutMs: 500,
  maxOutputChars: 300, endAction: 'delete', onExit: 'abort' } as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const message = (id: string, role: 'user' | 'assistant', text?: string, sessionId = 'ses_1'): OcMessage => ({
  info: { id, sessionID: sessionId, role,
    ...(role === 'assistant' ? { parentID: 'm001', finish: 'stop' } : {}),
    time: { created: Number(id.slice(1)), ...(role === 'assistant' ? { completed: Number(id.slice(1)) + 1 } : {}) } },
  parts: text ? [{ id: `p${id}`, sessionID: sessionId, messageID: id, type: 'text', text }] : [],
});
function setup(mode: Config['mode'] = 'attach') {
  const connection = new FakeConnection(); const clock = new FakeClock();
  const engine = createEngine({ config: { ...config, mode }, connection, clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { engine, connection, clock };
}
function complete(connection: FakeConnection, answer: string) {
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const n = history.length + 1;
    history.push(message(`m${String(n).padStart(3, '0')}`, 'user', undefined, id),
      message(`m${String(n + 1).padStart(3, '0')}`, 'assistant', answer, id));
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
}

test('A1: loss during second admission cannot classify the first turn as the second', async () => {
  const { engine, connection } = setup();
  complete(connection, 'FIRST ANSWER');
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.status, 'completed');
  const messages = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id, page) => {
    if (page?.limit === 1 && connection.api.histories.get(id)!.length > 0)
      connection.unavailable('unreachable');
    return messages(id, page);
  };
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  assert.equal(second.turn, 2);
  assert.equal(second.executionState, 'stopped');
  await connection.acquire(); // Attach lease comes back while the old history is still available.
  const observed = await engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(observed.turnId, second.turnId);
  assert.notEqual(observed.status, 'completed');
  assert.doesNotMatch(observed.content, /FIRST ANSWER/);
});

test('A1: an exited server before second dispatch cannot copy the first answer', async () => {
  const { engine, connection } = setup('managed');
  complete(connection, 'FIRST ANSWER');
  const first = await engine.start({ prompt: 'first' }, ctx());
  const messages = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id, page) => {
    if (page?.limit === 1 && connection.api.histories.get(id)!.length > 0)
      connection.unavailable('exited');
    return messages(id, page);
  };
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  assert.equal(second.status, 'failed');
  assert.equal(second.executionState, 'stopped');
  assert.doesNotMatch(second.content, /FIRST ANSWER/);
});

test('A5 and F-P3-1: exited fence repairs markerless unknown and its keyed replay', async () => {
  const { engine, connection, clock } = setup('managed');
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'ambiguous', requestId: 'fence' }, ctx());
  await flush(); clock.tick(500); await flush(); clock.tick(500); await flush();
  const unknown = await pending;
  assert.equal(unknown.executionState, 'unknown');
  connection.unavailable('exited');
  const stopped = await engine.status({ sessionId: unknown.sessionId }, ctx());
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'complete');
  const replay = await engine.start({ prompt: 'ambiguous', requestId: 'fence' }, ctx());
  assert.equal(replay.executionState, 'stopped');
  assert.equal(replay.turnId, unknown.turnId);
  assert.ok(replay.request?.expiresAt !== undefined);
});

test('A5: unreachable never acts as an execution fence', async () => {
  const { engine, connection, clock } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'ambiguous' }, ctx());
  await flush(); clock.tick(500); await flush(); clock.tick(500); await flush();
  const unknown = await pending;
  assert.equal(unknown.executionState, 'unknown');
  connection.unavailable('unreachable');
  assert.equal((await engine.status({ sessionId: unknown.sessionId }, ctx())).executionState, 'unknown');
});

test('F-P3-1: terminal evidence settles a keyed unknown and refreshes its replay', async () => {
  const { engine, connection, clock } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const input = { prompt: 'ambiguous', requestId: 'evidence' };
  const pending = engine.start(input, ctx());
  await flush(); clock.tick(500); await flush(); clock.tick(500); await flush();
  const unknown = await pending;
  assert.equal(unknown.executionState, 'unknown');
  connection.api.histories.get(unknown.sessionId)!.push(message('m001', 'user'),
    message('m002', 'assistant', 'own answer'));
  const recovered = await engine.status({ sessionId: unknown.sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.content, 'own answer');
  const replay = await engine.start(input, ctx());
  assert.equal(replay.executionState, 'stopped');
  assert.equal(replay.content, 'own answer');
  assert.ok(replay.request?.expiresAt !== undefined);
});

test('A12: expired output is unavailable on status and keyed replay', async () => {
  const { engine, connection, clock } = setup();
  complete(connection, 'answer');
  const first = await engine.start({ prompt: 'first', requestId: 'expiry' }, ctx());
  assert.equal(first.output?.state, 'retained');
  clock.tick(60 * 60_000 + 1);
  const status = await engine.status({ sessionId: first.sessionId }, ctx());
  const replay = await engine.start({ prompt: 'first', requestId: 'expiry' }, ctx());
  assert.deepEqual([status.output?.state, status.output?.reason], ['unavailable', 'expired']);
  assert.deepEqual([replay.output?.state, replay.output?.reason], ['unavailable', 'expired']);
});

test('A12: evicted output is unavailable on status and keyed replay', async () => {
  const { engine, connection } = setup();
  complete(connection, 'answer');
  const first = await engine.start({ prompt: 'first', requestId: 'eviction' }, ctx());
  for (let i = 0; i < 128; i++)
    await engine.start({ prompt: `other ${i}` }, ctx());
  const status = await engine.status({ sessionId: first.sessionId }, ctx());
  const replay = await engine.start({ prompt: 'first', requestId: 'eviction' }, ctx());
  assert.deepEqual([status.output?.state, status.output?.reason], ['unavailable', 'evicted']);
  assert.deepEqual([replay.output?.state, replay.output?.reason], ['unavailable', 'evicted']);
});

test('F-P3-3: displayed content and retained answer use the final assistant', () => {
  const history = [message('m001', 'user'), message('m002', 'assistant', 'earlier'),
    message('m003', 'assistant')];
  assert.equal(extractOutputArtifacts(history).answer, '');
  assert.doesNotMatch(summarizeInterval(history, '/repo', 300).content, /earlier/);
});

test('F-P3-4: duplicate of a failed admission receives the owner EngineError', async () => {
  const { engine, connection } = setup();
  connection.api.sessionStatus = async () => { throw new OpencodeHttpError('admission failed', 503, 'UpstreamError'); };
  const input = { prompt: 'admission', requestId: 'admission-error' };
  await assert.rejects(engine.start(input, ctx()), { code: 'OPENCODE_OVERLOADED' });
  await assert.rejects(engine.start(input, ctx()), { code: 'OPENCODE_OVERLOADED' });
});
