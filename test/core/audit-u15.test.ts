// U15: closes untested-contract gaps found by the r1/r2/r3 audits: promptAsync 4xx-vs-5xx
// classification, a 4xx racing a cancel,
// onExit=abort/end shutdown wiring for both a completed and a still-running turn, reply-time
// overrides, sandbox -> createSession permission wiring, an owner controller aborted after a
// wait-zero snapshot has already returned, and question.asked handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { sessionRulesFor } from '../../src/core/policy.ts';
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
const setup = (overrides: Partial<Config> = {}) => {
  const connection = new FakeConnection(),
    clock = new FakeClock();
  const engine = createEngine({
    config: { ...config, ...overrides } as Config,
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
};
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// r3-r-tests-2: promptAsync 4xx-vs-5xx classification (turn.ts ~193-201)
// ---------------------------------------------------------------------------

test('promptAsync 400 is a definitive rejection; the session stays reusable', async () => {
  const { connection, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('bad request', 400, 'BadRequest');
  const result = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'UPSTREAM_ERROR');
  assert.equal(result.executionState, 'stopped');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
  // The failure was definitive (not ambiguous), so the session is left idle and reusable — a
  // regression that widened the 4xx branch to quarantine instead would make this reply throw
  // SESSION_BUSY instead of completing.
  connection.api.promptFailure = undefined;
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const reply = await engine.reply({ sessionId: result.sessionId, prompt: 'again' }, ctx());
  assert.equal(reply.status, 'completed');
});

test('promptAsync 500 is ambiguous and quarantines exactly like a lost response', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('server error', 500, 'ServerError');
  const pending = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  clock.tick(500);
  await flush();
  clock.tick(500);
  const result = await pending;
  // A regression that inverted/widened the 4xx range to swallow 500 would report UPSTREAM_ERROR
  // here instead, and the reply below would complete instead of being rejected as SESSION_BUSY.
  assert.equal(result.error?.name, 'SUBMISSION_UNCONFIRMED');
  assert.equal(result.executionState, 'unknown');
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
  await assert.rejects(engine.reply({ sessionId: result.sessionId, prompt: 'again' }, ctx()), {
    code: 'SESSION_BUSY',
  });
});

test('a 4xx that lands while a cancel is already in flight skips the abort and finishes cancelled', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  connection.api.onPrompt = async () => {
    await gate;
  };
  connection.api.promptFailure = new OpencodeHttpError('bad request', 400, 'BadRequest');
  const controller = new AbortController();
  const started = engine.start({ prompt: 'hello' }, { signal: controller.signal });
  await flush();
  // The POST is dispatched and stuck awaiting the gate: abort now, while promptAsync is still
  // pending, so performStop must observe submissionRejected before the abort loop ever runs.
  controller.abort();
  await flush();
  release();
  const result = await started;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  // Regressing turn.ts's `this.submissionRejected = true` (or performStop's check of it) would
  // make performStop fall into its normal abort-and-poll loop instead of skipping straight to
  // finish(), producing an 'abort' call here.
  assert.equal(connection.api.calls.filter((x) => x.method === 'abort').length, 0);
  assert.equal(connection.api.calls.filter((x) => x.method === 'promptAsync').length, 1);
});

// ---------------------------------------------------------------------------
// r3-r-tests-4: onExit wiring on shutdown (engine.ts ~968)
// ---------------------------------------------------------------------------

test('shutdown with the default onExit=abort leaves a completed session upstream, untouched', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const started = await engine.start({ prompt: 'hello' }, ctx());
  await engine.shutdown('test');
  // A regression that dropped the `config.onExit === 'end'` guard would delete every tracked
  // session on every exit under the default configuration.
  assert.equal(connection.api.calls.some((x) => x.method === 'deleteSession'), false);
  assert.equal(connection.api.calls.some((x) => x.method === 'archiveSession'), false);
  assert.ok(connection.api.sessions.has(started.sessionId));
});

test('shutdown with onExit=end and endAction=archive archives instead of deleting', async () => {
  const { connection, engine } = setup({ onExit: 'end', endAction: 'archive' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const started = await engine.start({ prompt: 'hello' }, ctx());
  await engine.shutdown('test');
  assert.ok(connection.api.calls.some((x) => x.method === 'archiveSession'));
  assert.equal(connection.api.calls.some((x) => x.method === 'deleteSession'), false);
  assert.ok(connection.api.sessions.get(started.sessionId)?.time.archived !== undefined);
});

// ---------------------------------------------------------------------------
// r2-r-tests-2: shutdown while a turn is actually running/busy (engine.ts ~799 / turn.ts)
// ---------------------------------------------------------------------------

test('shutdown stops a busy turn via abort, and onExit=end deletes only after the stop is confirmed', async () => {
  const { connection, engine } = setup({ onExit: 'end' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  await engine.shutdown('test');
  const result = await started;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  assert.ok(connection.api.calls.some((x) => x.method === 'abort'));
  const methods = connection.api.calls.map((x) => x.method);
  // A regression that skipped `entry.current.stop('cancelled')` for a still-running turn during
  // shutdown would leave the turn (and its upstream runner) untouched, and no abort/deleteSession
  // ordering would exist to check at all.
  assert.ok(methods.indexOf('abort') < methods.lastIndexOf('deleteSession'));
});

test('shutdown with onExit=end never deletes a session whose stop could not be confirmed', async () => {
  const { connection, clock, engine } = setup({ onExit: 'end' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.abortKeepsBusy = true;
  const started = engine.start({ prompt: 'hello' }, ctx());
  await flush();
  const shutdown = engine.shutdown('test');
  for (let i = 0; i < 20; i++) {
    await flush();
    clock.tick(100);
  }
  await shutdown;
  await flush();
  // The stop can never be confirmed while abortKeepsBusy holds the session busy forever, so
  // onExit=end must never delete or archive it — a regression that ended unconfirmed sessions
  // anyway would cause user data loss.
  assert.equal(connection.api.calls.some((x) => x.method === 'deleteSession'), false);
  assert.equal(connection.api.calls.some((x) => x.method === 'archiveSession'), false);
  void started;
});

// ---------------------------------------------------------------------------
// r3-r-tests-7: reply-time overrides (engine.ts reply(), ~848-851)
// ---------------------------------------------------------------------------

test('reply-time overrides for model, agent, and developer instructions reach the PromptBody', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  const started = await engine.start(
    { prompt: 'hello', baseInstructions: 'base', developerInstructions: 'dev1', model: 'p/m1' },
    ctx(),
  );
  assert.equal(started.status, 'completed');
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m3', 'user'), msg('m4', 'assistant', 'm3', 'stop'));
  };
  const reply = await engine.reply(
    {
      sessionId: started.sessionId,
      prompt: 'again',
      model: 'p/m2',
      agent: 'plan',
      developerInstructions: 'dev2',
    },
    ctx(),
  );
  assert.equal(reply.status, 'completed');
  const body2 = connection.api.calls.filter((x) => x.method === 'promptAsync')[1]!.args[1] as PromptBody;
  // A regression that removed/misordered engine.reply's override assignments would still send the
  // first turn's model/system here.
  assert.deepEqual(body2.model, { providerID: 'p', modelID: 'm2' });
  assert.equal(body2.agent, 'plan');
  assert.equal(body2.system, 'base\n\ndev2');
});

// ---------------------------------------------------------------------------
// r2-r-tests-1: sandbox -> createSession permission wiring (engine.ts start(), ~817)
// ---------------------------------------------------------------------------

test('start with sandbox read-only forwards the matching permission rules to createSession', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop'));
  };
  await engine.start({ prompt: 'hello', sandbox: 'read-only' }, ctx());
  const call = connection.api.calls.find((x) => x.method === 'createSession')!;
  const body = call.args[1] as { permission?: unknown };
  // A regression that dropped the `permission:` key (or used the wrong sandbox default) would
  // leave this undefined, silently making every sandbox danger-full-access upstream.
  assert.deepEqual(body.permission, sessionRulesFor('read-only'));
});

// ---------------------------------------------------------------------------
// r2-r-tests-3: an owner controller aborted after a wait-zero snapshot has already returned
// (turn.ts attach(): the abort listener must already be detached by then)
// ---------------------------------------------------------------------------

test('an owner controller aborted after a wait-zero snapshot no longer stops the turn', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const controller = new AbortController();
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, { signal: controller.signal });
  assert.equal(started.status, 'running');
  // The wait-zero call has already returned, so its onAbort listener should already be detached.
  controller.abort();
  await flush();
  // A regression that stopped removing the listener in attach()'s finally would call abort() here
  // and turn the still-running turn cancelled.
  assert.equal(connection.api.calls.filter((x) => x.method === 'abort').length, 0);
  const status = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.status, 'running');
});

// ---------------------------------------------------------------------------
// r1-tests-quality-7: question.asked handling (turn.ts onEvent, ~332-339)
// ---------------------------------------------------------------------------

test('a question.asked event immediately rejects the question', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  connection.api.emit('/repo', {
    type: 'question.asked',
    properties: { id: 'que_1', sessionID: started.sessionId },
  });
  await flush();
  // A regression that dropped or broke this branch would never call rejectQuestion at all.
  assert.ok(
    connection.api.calls.some(
      (x) => x.method === 'rejectQuestion' && x.args[0] === '/repo' && x.args[1] === 'que_1',
    ),
  );
});
