import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, OcPermissionRequest } from '../../src/types.ts';
import { FakeConnection, FakeOpencodeApi } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const defaults = {
  mode: 'attach', defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never', startupTimeoutMs: 1000,
  requestTimeoutMs: 30, turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000,
  approvalTimeoutMs: 500, heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000,
  cleanupTimeoutMs: 500, maxOutputChars: 2000, endAction: 'delete', onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const timeout = () => new OpencodeHttpError('Timed out', 0, 'TimeoutError');
const message = (id: string, role: 'user' | 'assistant', text?: string): OcMessage => ({
  info: { id, sessionID: 'ses_1', role, ...(role === 'assistant' ? { parentID: 'm01', finish: 'stop' } : {}),
    time: { created: Number(id.slice(1)), ...(role === 'assistant' ? { completed: Number(id.slice(1)) + 1 } : {}) } },
  parts: text ? [{ id: `p_${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text }] : [],
});
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function advance(clock: FakeClock, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection(), clock = new FakeClock();
  const warnings: string[] = [];
  const engine = createEngine({ config: { ...defaults, ...overrides }, connection, clock,
    logger: { debug() {}, info() {}, warn(message) { warnings.push(message); }, error() {} } });
  return { connection, clock, engine, warnings };
}
async function completedStart(connection: FakeConnection, engine: ReturnType<typeof createEngine>) {
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'first'));
  };
  return engine.start({ prompt: 'first' }, ctx());
}

test('U04a: an ambiguous attach abort is not reissued from quarantine', async () => {
  const { connection, clock, engine } = setup({ cleanupTimeoutMs: 500 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, ctx());
  connection.api.onAbort = () => new Promise<void>(() => {});
  assert.equal((await engine.cancel({ sessionId: first.sessionId }, ctx())).executionState, 'unknown');
  connection.api.onAbort = undefined;
  const recovery = engine.cancel({ sessionId: first.sessionId }, ctx());
  await flush();
  await advance(clock, 550);
  const recovered = await recovery;
  assert.equal(recovered.executionState, 'unknown');
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal(connection.generation, 1);
});

test('U04b: timed-out never-policy reject does not downgrade a completed turn or block reply', async () => {
  const { connection, engine } = setup({ requestTimeoutMs: 10 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, ctx());
  const permission: OcPermissionRequest = { id: 'per_1', sessionID: first.sessionId, permission: 'bash', patterns: ['*'], metadata: {}, always: [] };
  connection.api.permissions.set(permission.id, permission);
  connection.api.onReplyPermission = () => new Promise<void>(() => {});
  connection.api.emit('/repo', { type: 'permission.asked', properties: { ...permission } });
  await flush();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.api.calls.filter((call) => call.method === 'replyPermission').length > 0, true);
  connection.api.histories.get(first.sessionId)!.push(message('m02', 'assistant', 'done'));
  connection.api.statuses.delete(first.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: first.sessionId } });
  await flush();
  const result = await engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
  connection.api.onReplyPermission = undefined;
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m03', 'user'), message('m04', 'assistant', 'again'));
  };
  assert.equal((await engine.reply({ sessionId: first.sessionId, prompt: 'again' }, ctx())).status, 'completed');
});

test('U04c: a timed-out delete can be retried and removes the entry', async () => {
  const { connection, engine } = setup({ cleanupTimeoutMs: 20 });
  const first = await completedStart(connection, engine);
  connection.api.onDeleteSession = () => new Promise<void>(() => {});
  await assert.rejects(engine.end({ sessionId: first.sessionId }, ctx()), { code: 'CLEANUP_UNCONFIRMED' });
  connection.api.onDeleteSession = undefined;
  assert.equal((await engine.end({ sessionId: first.sessionId }, ctx())).status, 'ended');
  assert.equal((await engine.end({ sessionId: first.sessionId }, ctx())).status, 'not_found');
});

test('U04c2: withinCleanup racing ahead of a still-gated delete does not downgrade the turn, and a retry after the late delete lands succeeds', async () => {
  // P2-1/P3-6 (core review): unlike U04c (the fetch's own timeout settles the
  // mutation before the outer catch runs), here withinCleanup's own deadline fires first — the
  // delete request is genuinely still in flight (unsettled) at the moment endInternal's catch
  // decides whether to downgrade entry.last to 'unknown'.
  const { connection, clock, engine } = setup({ cleanupTimeoutMs: 20 });
  const first = await completedStart(connection, engine);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = connection.api.deleteSession.bind(connection.api);
  connection.api.deleteSession = async (id: string) => {
    await gate;
    return original(id);
  };
  const ending = engine.end({ sessionId: first.sessionId }, ctx());
  await flush();
  clock.tick(20);
  await assert.rejects(ending, { code: 'CLEANUP_UNCONFIRMED' });
  const callsBefore = connection.api.calls.length;
  const status = await engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(status.executionState, 'stopped');
  assert.equal(
    connection.api.calls.length,
    callsBefore,
    'a bare in-flight delete must not trigger quiescence recovery (no downgrade to unknown)',
  );
  release();
  await flush();
  connection.api.deleteSession = original;
  const retried = await engine.end({ sessionId: first.sessionId }, ctx());
  assert.equal(retried.status, 'ended');
  assert.match(retried.content, /no longer existed/i);
});

test('U04d: generation loss clears the newer lease mutation, not the entry generation', async () => {
  const { connection, engine } = setup({ mode: 'managed', cleanupTimeoutMs: 20 });
  const first = await completedStart(connection, engine);
  connection.unavailable(); // Entry's last turn was on generation 1.
  connection.api.onDeleteSession = () => new Promise<void>(() => {});
  await assert.rejects(engine.end({ sessionId: first.sessionId }, ctx()), { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(connection.generation, 2);
  connection.unavailable();
  connection.api.onDeleteSession = undefined;
  assert.equal((await engine.end({ sessionId: first.sessionId, action: 'archive' }, ctx())).status, 'ended');
  assert.equal(connection.api.sessions.get(first.sessionId)?.time.archived !== undefined, true);
});

test('U04e: terminal evidence replaces an unconfirmed placeholder with the actual answer', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost response', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'first' }, ctx());
  await flush(); await advance(clock, 1_000);
  const first = await pending;
  assert.equal(first.error?.name, 'SUBMISSION_UNCONFIRMED');
  const answer = message('m02', 'assistant', 'second');
  answer.parts.push(
    { id: 'patch', sessionID: first.sessionId, messageID: 'm02', type: 'patch', files: ['/repo/changed.ts'] },
    { id: 'tool', sessionID: first.sessionId, messageID: 'm02', type: 'tool', tool: 'edit', state: { status: 'completed' } },
  );
  connection.api.histories.get(first.sessionId)!.push(message('m01', 'user'), answer);
  const result = await engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'second');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.filesChanged, ['changed.ts']);
  assert.equal(result.toolCalls[0]?.tool, 'edit');
  assert.match(result.hint, /did run; do not resend/i);
});

test('U04e2: a rebuilt cancelled outcome never claims "the prompt did run; do not resend"', async () => {
  // P3-7 (core review): releaseHint must follow the freshly rebuilt outcome, not
  // the stale SUBMISSION_UNCONFIRMED error that recovery is resolving — a turn discovered to have
  // been cancelled (e.g. killed by disposal or this recovery's own re-abort) gets the same generic
  // hint Turn.finish() gives every other cancelled/failed/completed turn.
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost response', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'first' }, ctx());
  await flush();
  await advance(clock, 1_000);
  const first = await pending;
  assert.equal(first.error?.name, 'SUBMISSION_UNCONFIRMED');
  const aborted = message('m02', 'assistant');
  aborted.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
  connection.api.histories.get(first.sessionId)!.push(message('m01', 'user'), aborted);
  const result = await engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(result.status, 'cancelled');
  assert.equal(result.executionState, 'stopped');
  assert.doesNotMatch(result.hint, /do not resend/i);
  assert.match(result.hint, /opencode-reply to continue or opencode-end to finish/i);
});

test('U04f: a known submitted user does not trigger a second quarantine abort', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'first', waitSeconds: 0 }, ctx());
  connection.api.abort = async () => { throw timeout(); };
  assert.equal((await engine.cancel({ sessionId: first.sessionId }, ctx())).executionState, 'unknown');
  let calls = 0;
  connection.api.abort = async (id) => { calls++; connection.api.statuses.delete(id); return true; };
  const recovering = engine.cancel({ sessionId: first.sessionId }, ctx());
  await advance(clock, 600);
  assert.equal((await recovering).executionState, 'unknown');
  assert.equal(calls, 0);
});

test('U04g: failed end is visible and onExit=end retries it', async () => {
  const { connection, engine } = setup({ onExit: 'end' });
  const first = await completedStart(connection, engine);
  connection.api.deleteSession = async () => { throw new OpencodeHttpError('upstream failed', 503, 'UnknownError'); };
  await assert.rejects(engine.end({ sessionId: first.sessionId }, ctx()), { code: 'CLEANUP_UNCONFIRMED' });
  assert.match((await engine.status({ sessionId: first.sessionId }, ctx())).hint, /opencode-end failed.*retry opencode-end/i);
  assert.match((await engine.cancel({ sessionId: first.sessionId }, ctx())).hint, /retry opencode-end/i);
  assert.equal((await engine.list()).sessions[0]?.status, 'quarantined');
  connection.api.deleteSession = async (id) => connection.api.sessions.delete(id);
  await engine.shutdown('test');
  assert.equal(connection.api.sessions.has(first.sessionId), false);
});

test('U04 fake: gated mutations time out without applying a later side effect', async () => {
  const api = new FakeOpencodeApi();
  const session = await api.createSession('/repo', { title: 'one' });
  api.statuses.set(session.id, { type: 'busy' });
  api.permissions.set('per_1', { id: 'per_1', sessionID: session.id, permission: 'bash', patterns: ['*'], metadata: {}, always: [] });
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = () => resolve(); });
  const gate = () => pending;
  api.onAbort = gate;
  api.onDeleteSession = gate;
  api.onArchiveSession = gate;
  api.onReplyPermission = gate;
  const timedOut = (error: unknown) =>
    error instanceof OpencodeHttpError && error.status === 0 && error.errorName === 'TimeoutError';
  await Promise.all([
    assert.rejects(api.abort(session.id, { timeoutMs: 5 }), timedOut),
    assert.rejects(api.deleteSession(session.id, { timeoutMs: 5 }), timedOut),
    assert.rejects(api.archiveSession(session.id, 1, { timeoutMs: 5 }), timedOut),
    assert.rejects(api.replyPermission('/repo', 'per_1', 'reject', undefined, { timeoutMs: 5 }), timedOut),
  ]);
  release();
  await flush();
  assert.equal(api.sessions.has(session.id), true);
  assert.equal(api.sessions.get(session.id)?.time.archived, undefined);
  assert.equal(api.permissions.has('per_1'), true);
  assert.equal(api.statuses.has(session.id), true);
});
