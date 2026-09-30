import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';

const config = { defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  mode: 'attach', defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000, approvalTimeoutMs: 1000,
  heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000, cleanupTimeoutMs: 500,
  maxOutputChars: 300, endAction: 'delete', onExit: 'abort' } as Config;
const ctx = (controller = new AbortController()): CallContext => ({ signal: controller.signal });
function setup() {
  const connection = new FakeConnection(); const clock = new FakeClock();
  const engine = createEngine({ config, connection, clock, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { engine, connection, clock };
}
function complete(connection: FakeConnection, answer = 'done') {
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const n = history.length + 1;
    const user = `m${String(n).padStart(3, '0')}`;
    const assistant = `m${String(n + 1).padStart(3, '0')}`;
    history.push({ info: { id: user, sessionID: id, role: 'user', time: { created: n } }, parts: [] } as OcMessage,
      { info: { id: assistant, sessionID: id, role: 'assistant', parentID: user,
        finish: 'stop', time: { created: n + 1, completed: n + 2 } },
        parts: [{ id: `p${assistant}`, sessionID: id, messageID: assistant, type: 'text', text: answer }] } as OcMessage);
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
}
const count = (connection: FakeConnection, method: string) => connection.api.calls.filter((c) => c.method === method).length;

test('concurrent identical starts join one creation and replay their original turn after a reply', async () => {
  const { engine, connection } = setup(); complete(connection, 'first');
  const firstCall = engine.start({ prompt: 'one', requestId: 'same' }, ctx());
  const duplicateCall = engine.start({ prompt: 'one', requestId: 'same' }, ctx());
  const [first, duplicate] = await Promise.all([firstCall, duplicateCall]);
  assert.equal(count(connection, 'createSession'), 1);
  assert.equal(count(connection, 'promptAsync'), 1);
  assert.equal(first.request?.replayed, false);
  assert.equal(duplicate.request?.replayed, true);
  assert.equal(duplicate.turnId, first.turnId);
  complete(connection, 'second');
  await engine.reply({ sessionId: first.sessionId, prompt: 'two' }, ctx());
  const replay = await engine.start({ prompt: 'one', requestId: 'same' }, ctx());
  assert.equal(replay.turnId, first.turnId);
  assert.equal(replay.content, first.content);
  assert.equal(replay.request?.replayed, true);
  await assert.rejects(engine.start({ prompt: 'different', requestId: 'same' }, ctx()), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(count(connection, 'createSession'), 1);
  await engine.end({ sessionId: first.sessionId }, ctx());
  await assert.rejects(engine.start({ prompt: 'one', requestId: 'same' }, ctx()), { code: 'REQUEST_ENDED' });
});

test('reply key includes session and output schema; duplicate never admits another turn', async () => {
  const { engine, connection } = setup(); complete(connection);
  const a = await engine.start({ prompt: 'a' }, ctx());
  const b = await engine.start({ prompt: 'b' }, ctx());
  const first = await engine.reply({ sessionId: a.sessionId, prompt: 'reply', requestId: 'reply-key' }, ctx());
  const replay = await engine.reply({ sessionId: a.sessionId, prompt: 'reply', requestId: 'reply-key' }, ctx());
  assert.equal(replay.turnId, first.turnId);
  assert.equal(replay.request?.replayed, true);
  await assert.rejects(engine.reply({ sessionId: b.sessionId, prompt: 'reply', requestId: 'reply-key' }, ctx()), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(engine.reply({ sessionId: a.sessionId, prompt: 'reply', requestId: 'reply-key',
    outputSchema: { type: 'object', properties: {}, additionalProperties: false } }, ctx()), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(count(connection, 'promptAsync'), 3);
});

test('ambiguous create binds the key; original error and duplicate unconfirmed', async () => {
  const { engine, connection } = setup();
  connection.api.createSession = async () => { throw new OpencodeHttpError('lost', 0, 'NetworkError'); };
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'ambiguous-create' }, ctx()), { code: 'OPENCODE_UNAVAILABLE' });
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'ambiguous-create' }, ctx()), { code: 'REQUEST_UNCONFIRMED' });
});

test('definite create failure releases the request key', async () => {
  const { engine, connection } = setup();
  const create = connection.api.createSession.bind(connection.api);
  let fail = true;
  connection.api.createSession = async (directory, body) => {
    if (fail) { fail = false; throw new OpencodeHttpError('bad request', 400, 'HttpError'); }
    return create(directory, body);
  };
  await assert.rejects(engine.start({ prompt: 'retry', requestId: 'create-400' }, ctx()), { code: 'UPSTREAM_ERROR' });
  complete(connection);
  const result = await engine.start({ prompt: 'retry', requestId: 'create-400' }, ctx());
  assert.equal(result.request?.replayed, false);
});

test('duplicate waiting for creation can cancel without affecting owner', async () => {
  const { engine, connection } = setup(); complete(connection);
  const create = connection.api.createSession.bind(connection.api);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  connection.api.createSession = async (directory, body) => { await gate; return create(directory, body); };
  const owner = engine.start({ prompt: 'pending', requestId: 'pending-key' }, ctx());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const controller = new AbortController();
  const duplicate = engine.start({ prompt: 'pending', requestId: 'pending-key' }, ctx(controller));
  controller.abort();
  await assert.rejects(duplicate, { code: 'REQUEST_PENDING' });
  release();
  assert.equal((await owner).request?.replayed, false);
});

test('duplicate admission wait zero returns promptly and waiting emits heartbeats', async () => {
  const { engine, connection, clock } = setup(); complete(connection);
  const create = connection.api.createSession.bind(connection.api);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  connection.api.createSession = async (directory, body) => { await gate; return create(directory, body); };
  const owner = engine.start({ prompt: 'pending', requestId: 'wait-key' }, ctx());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await assert.rejects(engine.start({ prompt: 'pending', requestId: 'wait-key', waitSeconds: 0 }, ctx()),
    { code: 'REQUEST_PENDING' });
  const progress: string[] = [];
  const duplicate = engine.start({ prompt: 'pending', requestId: 'wait-key', waitSeconds: 1 },
    { ...ctx(), progress: (message) => { progress.push(message); } });
  await Promise.resolve();
  clock.tick(100);
  assert.ok(progress.length > 0);
  clock.tick(900);
  await assert.rejects(duplicate, { code: 'REQUEST_PENDING' });
  release(); await owner;
  assert.equal(count(connection, 'createSession'), 1);
});

test('created but unadmitted request carries its session id and ends cleanly', async () => {
  const { engine, connection } = setup();
  const acquire = connection.acquire.bind(connection);
  let calls = 0;
  connection.acquire = async (req) => { if (++calls === 2) throw new Error('admission offline'); return acquire(req); };
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'created-key' }, ctx()), { code: 'OPENCODE_UNAVAILABLE' });
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'created-key' }, ctx()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'REQUEST_UNCONFIRMED');
    assert.equal((error as { sessionId?: string }).sessionId, 'ses_1');
    return true;
  });
  await engine.end({ sessionId: 'ses_1' }, ctx());
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'created-key' }, ctx()), { code: 'REQUEST_ENDED' });
});

test('global replay bound preserves the original identity through small receipts', async () => {
  const { engine, connection } = setup(); complete(connection);
  let first: Awaited<ReturnType<typeof engine.start>> | undefined;
  for (let i = 0; i < 257; i++) {
    const result = await engine.start({ prompt: `turn ${i}`, requestId: `global-${i}` }, ctx());
    if (i === 0) first = result;
  }
  await engine.reply({ sessionId: first!.sessionId, prompt: 'later' }, ctx());
  const replay = await engine.start({ prompt: 'turn 0', requestId: 'global-0' }, ctx());
  assert.equal(replay.turnId, first?.turnId);
  assert.equal(replay.status, first?.status);
  assert.equal(replay.truncated, true);
  assert.equal(replay.structuredOutput, undefined);
  assert.equal(replay.request?.replayed, true);
});

test('duplicate cancellation detaches without aborting owner', async () => {
  const { engine, connection } = setup();
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const owner = await engine.start({ prompt: 'long', requestId: 'observe', waitSeconds: 0 }, ctx());
  const controller = new AbortController();
  const observing = engine.start({ prompt: 'long', requestId: 'observe' }, ctx(controller));
  controller.abort();
  const duplicate = await observing;
  assert.equal(duplicate.turnId, owner.turnId);
  assert.equal(duplicate.request?.replayed, true);
  assert.equal(count(connection, 'abort'), 0);
  assert.equal(count(connection, 'promptAsync'), 1);
});

test('acquire failure before create frees the key for a corrected retry', async () => {
  const { engine, connection } = setup(); complete(connection);
  const acquire = connection.acquire.bind(connection);
  let fail = true;
  connection.acquire = async (req) => {
    if (fail) { fail = false; throw new Error('offline'); }
    return acquire(req);
  };
  await assert.rejects(engine.start({ prompt: 'retry', requestId: 'retryable' }, ctx()), { code: 'OPENCODE_UNAVAILABLE' });
  const result = await engine.start({ prompt: 'retry', requestId: 'retryable' }, ctx());
  assert.equal(result.request?.replayed, false);
  assert.equal(count(connection, 'createSession'), 1);
});

test('ambiguous prompt stays bound to its quarantined turn', async () => {
  const { engine, connection, clock } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'uncertain', requestId: 'prompt-uncertain' }, ctx());
  for (let i = 0; i < 40; i++) await Promise.resolve();
  clock.tick(500);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  clock.tick(500);
  const original = await pending;
  const duplicate = await engine.start({ prompt: 'uncertain', requestId: 'prompt-uncertain' }, ctx());
  assert.equal(original.executionState, 'unknown');
  assert.equal(duplicate.turnId, original.turnId);
  assert.equal(duplicate.request?.replayed, true);
  assert.equal(count(connection, 'promptAsync'), 1);
});

test('active ambiguous records count against bounded capacity', async () => {
  const { engine, connection } = setup();
  connection.api.createSession = async () => { throw new OpencodeHttpError('lost', 0, 'NetworkError'); };
  for (let i = 0; i < 4096; i++)
    await assert.rejects(engine.start({ prompt: 'x', requestId: `cap-${i}` }, ctx()), { code: 'OPENCODE_UNAVAILABLE' });
  await assert.rejects(engine.start({ prompt: 'x', requestId: 'overflow' }, ctx()), { code: 'REQUEST_CAPACITY' });
});

test('duplicate arriving during create joins the reserved original', async () => {
  const { engine, connection } = setup(); complete(connection);
  const create = connection.api.createSession.bind(connection.api);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let invocations = 0;
  connection.api.createSession = async (directory, body) => {
    invocations++;
    await gate;
    return create(directory, body);
  };
  const owner = engine.start({ prompt: 'pending', requestId: 'during-create' }, ctx());
  for (let i = 0; i < 10 && invocations === 0; i++) await Promise.resolve();
  assert.equal(invocations, 1);
  const observer = engine.start({ prompt: 'pending', requestId: 'during-create' }, ctx());
  await Promise.resolve();
  assert.equal(invocations, 1);
  release();
  const [first, duplicate] = await Promise.all([owner, observer]);
  assert.equal(first.turnId, duplicate.turnId);
  assert.equal(duplicate.request?.replayed, true);
  assert.equal(count(connection, 'promptAsync'), 1);
});

test('evicted committed result replays an honest bounded summary', async () => {
  const { engine, connection } = setup(); complete(connection, 'first answer');
  const first = await engine.start({ prompt: 'first', requestId: 'old-turn' }, ctx());
  complete(connection, 'later answer');
  for (let i = 0; i < 65; i++)
    await engine.reply({ sessionId: first.sessionId, prompt: `next ${i}` }, ctx());
  const replay = await engine.start({ prompt: 'first', requestId: 'old-turn' }, ctx());
  assert.equal(replay.turnId, first.turnId);
  assert.equal(replay.status, first.status);
  assert.equal(replay.request?.replayed, true);
  assert.equal(replay.truncated, true);
  assert.match(replay.content, /summary was evicted/);
});
