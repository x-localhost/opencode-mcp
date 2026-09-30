import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

// U03: stop confirmation must not be certified from wishful thinking. It covers four evidence
// gaps: (1) an abort landing during an OpenCode provider retry leaves an assistant with
// time.completed but no finish/error (submissionEvidence must still call that terminal); (2) a
// managed server exit while a stop is already in flight must commit 'stopped', not 'unknown'; (3)
// session.error emitted by our own abort must never race a cancelled/timed-out turn to 'failed';
// (4) admission-time leftover-permission rejection must be bounded and stop after a cancel.

const config = {
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 1_000,
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
    config: { ...config, ...overrides },
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
}

function context(): CallContext {
  return { signal: new AbortController().signal };
}

function message(id: string, role: 'user' | 'assistant', sessionID = 'ses_1'): OcMessage {
  return {
    info: {
      id,
      sessionID,
      role,
      ...(role === 'assistant' ? { parentID: 'm01' } : {}),
      time: { created: Number(id.slice(-2)) || 1 },
    },
    parts: [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}

// ---------------------------------------------------------------------------
// (a) Abort landing during a provider retry leaves the assistant with time.completed, no finish,
// no error. That shape confirms a directly acknowledged stop. A later ambiguous abort remains
// quarantined even if terminal history arrives, because its delayed effect is not fenced.
// ---------------------------------------------------------------------------

test('U03(a): acknowledged abort during retry confirms stop; an ambiguous abort retains quarantine', async () => {
  const { connection, clock, engine } = setup();
  connection.api.abortShape = 'retry-no-finish';
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };

  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  await advance(clock, 600); // lets the confirm loop's deadline elapse if evidence is never found
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.executionState, 'stopped');
  assert.equal(cancelled.cleanup, 'complete');
  const ended = await engine.end({ sessionId: started.sessionId }, context());
  assert.equal(ended.status, 'ended');

  // A second turn gets a 500 abort response. It may have been forwarded, so a later cancel must
  // observe without issuing another abort or releasing the uncertain mutation.
  const started2 = await engine.start({ prompt: 'work2', waitSeconds: 0 }, context());
  connection.api.abortFailure = new OpencodeHttpError('upstream error', 500, 'ServerError');
  const quarantining = engine.cancel({ sessionId: started2.sessionId }, context());
  await flush();
  await advance(clock, 600);
  const quarantined = await quarantining;
  assert.equal(quarantined.status, 'cancelled');
  assert.equal(quarantined.executionState, 'unknown');
  assert.equal(quarantined.cleanup, 'unconfirmed');

  connection.api.abortFailure = undefined;
  const releasing = engine.cancel({ sessionId: started2.sessionId }, context());
  await flush();
  await advance(clock, 600);
  const released = await releasing;
  // A 500 abort response may have been lost after forwarding. Terminal history does not fence
  // that delayed abort, so recovery retains quarantine and never issues another blind abort.
  assert.equal(released.executionState, 'unknown');
  assert.equal(released.cleanup, 'unconfirmed');
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 2);
});

// ---------------------------------------------------------------------------
// (b) A managed server exit while a stop's abort call is still pending must commit the stop
// reason with executionState 'stopped', not 'unknown' — the runner is provably gone.
// ---------------------------------------------------------------------------

test("U03(b): a managed server exit while a stop's abort is pending still commits stopped, not unknown", async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());

  let rejectAbort: ((error: unknown) => void) | undefined;
  connection.api.abort = () =>
    new Promise<boolean>((_resolve, reject) => {
      rejectAbort = reject;
    });

  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  assert.ok(rejectAbort, 'the abort call should be pending');
  connection.unavailable();
  await flush();
  rejectAbort!(new OpencodeHttpError('lost', 0, 'NetworkError'));

  const result = await cancelling;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');

  const ended = await engine.end({ sessionId: started.sessionId }, context());
  assert.equal(ended.status, 'ended');
});

// ---------------------------------------------------------------------------
// (c) OpenCode emits session.error for our own abort before idle. A single failed history read
// inside handleSessionError must never turn a cancelled turn into 'failed'.
// ---------------------------------------------------------------------------

test("U03(c): our own abort's session.error plus a failed history read cannot turn a cancelled turn into failed", async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    // Delayed so the turn's own initial reconcile observes no user yet (submittedUser stays
    // unset) before the user message and abort race handleSessionError's read.
    clock.schedule(50, () => {
      connection.api.histories.get(id)!.push(message('m01', 'user', id));
      connection.api.statuses.set(id, { type: 'busy' });
    });
  };
  connection.api.abortEmitsSessionError = true;

  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  await flush();
  clock.tick(50);
  await flush();

  // Gate the abort so its side effects (writing the aborted assistant, emitting session.error
  // then session.idle) happen immediately, but performStop does not observe completion until
  // released — guaranteeing handleSessionError's read is the one messagesFailure consumes.
  let releaseAbort: (() => void) | undefined;
  const originalAbort = connection.api.abort.bind(connection.api);
  connection.api.abort = (id: string) =>
    new Promise<boolean>((resolve) => {
      void originalAbort(id).then((result) => {
        releaseAbort = () => resolve(result);
      });
    });
  connection.api.messagesFailure = 1;

  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  assert.ok(releaseAbort, "the abort's side effects (including session.error) should already have run");
  connection.api.messagesFailure = 0; // let performStop's own reads succeed once released
  releaseAbort!();

  const result = await cancelling;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
});

// ---------------------------------------------------------------------------
// (d) A turn timeout during a provider retry must also be confirmed stopped, not left unknown —
// the confirmation loop is shared with cancel, but only a timeout-specific regression would slip
// past assertions that only check `status`.
// ---------------------------------------------------------------------------

test('U03(d): a turn timeout during a provider retry is confirmed stopped, not left unknown', async () => {
  const { connection, clock, engine } = setup();
  connection.api.abortShape = 'retry-no-finish';
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', timeoutSeconds: 1, waitSeconds: 0 }, context());
  clock.tick(1000);
  await flush();
  await advance(clock, 600); // lets the confirm loop's deadline elapse if evidence is never found
  const result = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, context());
  assert.equal(result.status, 'timeout');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
});

// ---------------------------------------------------------------------------
// (e) Admission-time leftover-permission rejection (before a runner exists) must be bounded and
// must stop issuing new replies once a concurrent cancel resolves.
// ---------------------------------------------------------------------------

test('U03(e): admission-time leftover rejection is bounded and stops issuing replies after cancel', async () => {
  const { connection, engine } = setup();
  const total = 500;
  for (let i = 0; i < total; i++) {
    const id = `per_${i}`;
    connection.api.permissions.set(id, {
      id,
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['*'],
      metadata: {},
      always: [],
    });
  }

  // Count *dispatched* calls (not just completed ones): a call that is issued but stays gated
  // never reaches record(), so a completed-call count alone cannot tell "no new call was issued"
  // apart from "a new call was issued but has not resolved yet".
  let dispatched = 0;
  let releaseNext: (() => void) | undefined;
  const originalReply = connection.api.replyPermission.bind(connection.api);
  connection.api.replyPermission = (directory: string, id: string, reply: 'once' | 'reject', msg?: string) => {
    dispatched++;
    return new Promise<boolean>((resolve) => {
      releaseNext = () => {
        void originalReply(directory, id, reply, msg).then(resolve);
      };
    });
  };

  const starting = engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  await flush();
  assert.ok(releaseNext, 'the first leftover permission reply should be gated');
  assert.equal(dispatched, 1);

  const cancelled = await engine.cancel({ sessionId: 'ses_1' }, context());
  assert.equal(cancelled.status, 'cancelled');

  const dispatchedAtCancel = dispatched;
  releaseNext!();
  await flush();
  // The already-dispatched call is allowed to complete, but no *new* one may be issued once the
  // loop observes the stop: the dispatched count must not grow past what cancel already saw.
  assert.equal(dispatched, dispatchedAtCancel);
  assert.equal(connection.api.calls.filter((c) => c.method === 'replyPermission').length, 1);
  assert.ok(dispatched < total, `admission must not attempt all ${total} leftover permissions after cancel`);

  const startResult = await starting;
  assert.equal(startResult.status, 'cancelled');
});
