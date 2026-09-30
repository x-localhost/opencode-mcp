import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { EngineError, OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

// U01: start calls report their session id; failed pre-Turn admissions reset cleanly.

const base = {
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

function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const logger = { debug() {}, info() {}, error() {}, warn() {} };
  const config = { ...base, ...overrides };
  const engine = createEngine({ config, connection, clock, logger });
  return { connection, clock, engine, config };
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

function replyOnPrompt(connection: FakeConnection): void {
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const next = history.length + 1;
    history.push(message(`m0${next}`, 'user'), message(`m0${next + 1}`, 'assistant', 'stop'));
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test('U01(a): cancel racing a failed reply admission leaves the session idle and reusable', async () => {
  const { connection, engine } = setup();
  replyOnPrompt(connection);
  const first = await engine.start({ prompt: 'one' }, context());

  const original = connection.acquire.bind(connection);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.acquire = async () => {
    await gate;
    throw new OpencodeHttpError('offline', 0, 'NetworkError');
  };

  const replying = engine.reply({ sessionId: first.sessionId, prompt: 'two' }, context());
  // The reply's createTurn is now gated inside acquire(); cancel must race it there.
  const cancelling = engine.cancel({ sessionId: first.sessionId }, context());
  release();

  await assert.rejects(replying, { code: 'OPENCODE_UNAVAILABLE' });
  const cancelled = await cancelling;
  assert.equal(cancelled.sessionId, first.sessionId);
  connection.acquire = original;

  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'three' }, context());
  assert.equal(second.status, 'completed');
});

test('U01(b): start whose warm-up fails carries the created sessionId on the rejected EngineError', async () => {
  const { connection, engine } = setup();
  connection.api.warmInstance = async () => {
    throw new OpencodeHttpError('service unavailable', 503, 'ServiceUnavailable');
  };
  await assert.rejects(engine.start({ prompt: 'work' }, context()), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    const sessionId = connection.api.sessions.keys().next().value as string;
    assert.ok(sessionId, 'the session must have been created upstream before warm-up ran');
    assert.equal(error.sessionId, sessionId);
    return true;
  });
});

test('U01(c): start whose createTurn acquire fails after createSession commits a synthetic failed TurnResult', async () => {
  const { connection, engine } = setup();
  const original = connection.acquire.bind(connection);
  let calls = 0;
  connection.acquire = async (request) => {
    if (++calls === 2) throw new OpencodeHttpError('offline', 0, 'NetworkError');
    return original(request);
  };
  await assert.rejects(engine.start({ prompt: 'first' }, context()), { code: 'OPENCODE_UNAVAILABLE' });
  connection.acquire = original;

  const sessionId = connection.api.sessions.keys().next().value as string;

  const status = await engine.status({ sessionId }, context());
  assert.equal(status.status, 'failed');
  assert.equal(status.executionState, 'stopped');

  const cancelled = await engine.cancel({ sessionId }, context());
  assert.equal(cancelled.status, 'failed');

  const list = await engine.list();
  assert.equal(list.sessions.find((s) => s.sessionId === sessionId)?.status, 'failed');

  replyOnPrompt(connection);
  const reply = await engine.reply({ sessionId, prompt: 'retry' }, context());
  assert.equal(reply.status, 'completed');
});

test('U01(d): engine.start calls ctx.setSessionId with the created session id before resolving', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.api.warmInstance = async () => {
    await gate;
  };
  replyOnPrompt(connection);
  const seen: string[] = [];
  const ctx: CallContext = {
    signal: new AbortController().signal,
    setSessionId: (id: string) => {
      seen.push(id);
    },
  };
  const starting = engine.start({ prompt: 'work' }, ctx);
  await flush();
  assert.equal(seen.length, 1, 'setSessionId must be called while the start call is still pending');
  release();
  const result = await starting;
  assert.equal(seen[0], result.sessionId);
});
