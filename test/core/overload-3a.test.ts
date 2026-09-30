import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, OcPermissionRequest } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const ctx = (): CallContext => ({ signal: new AbortController().signal });
const config = {
  mode: 'attach', defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  startupTimeoutMs: 2_000, requestTimeoutMs: 100, readRetryAttempts: 3,
  turnTimeoutMs: 60_000, maxTurnTimeoutMs: 60_000, approvalTimeoutMs: 500,
  heartbeatMs: 50, statusPollMs: 100, sseStallMs: 1_000, cleanupTimeoutMs: 8_000,
  maxOutputChars: 2_000, endAction: 'delete', onExit: 'abort',
} as Config;
const user = (id: string, sessionID: string): OcMessage => ({
  info: { id, sessionID, role: 'user', time: { created: 1 } }, parts: [],
});
const assistant = (id: string, sessionID: string, parentID: string): OcMessage => ({
  info: { id, sessionID, parentID, role: 'assistant', finish: 'stop', time: { created: 2, completed: 3 } },
  parts: [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text: 'done' }],
});
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
async function advance(clock: FakeClock, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({
    config: { ...config, ...overrides }, connection, clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
}

test('a user-only idle interval stays running beyond grace; later busy and terminal history complete it', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.histories.get(id)!.push(user('m1', id)); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await advance(clock, 6_000);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
  connection.api.statuses.set(started.sessionId, { type: 'busy' });
  connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId, status: { type: 'busy' } } });
  await advance(clock, 100);
  connection.api.histories.get(started.sessionId)!.push(assistant('m2', started.sessionId, 'm1'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await advance(clock, 150);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'completed');
});

test('no-user session.error fails after two idle observations without resending', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 30_000 });
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.emit('/repo', { type: 'session.error', properties: {
    sessionID: started.sessionId, error: { name: 'GatewayError', data: { message: 'gateway failed' } },
  } });
  await flush();
  await advance(clock, 4_900);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
  await advance(clock, 300);
  const result = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'GatewayError');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('root user and session.error with no busy observation fails with the event error', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => { connection.api.histories.get(id)!.push(user('m1', id)); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.emit('/repo', { type: 'session.error', properties: {
    sessionID: started.sessionId, error: { name: 'RunnerError', data: { message: 'runner failed' } },
  } });
  await flush();
  await advance(clock, 5_200);
  const result = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'RunnerError');
  assert.equal(result.executionState, 'stopped');
});

test('failed history read resets session.error idle confirmation', async () => {
  const { connection, clock, engine } = setup();
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.emit('/repo', { type: 'session.error', properties: {
    sessionID: started.sessionId, error: { name: 'RunnerError', data: { message: 'runner failed' } },
  } });
  await flush();
  const original = connection.api.messages.bind(connection.api);
  let failed = false;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (!failed) { failed = true; throw new OpencodeHttpError('busy', 503, 'HttpError'); }
    return original(id, opts);
  };
  await advance(clock, 5_100);
  assert.equal(failed, true);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
  await advance(clock, 5_300);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).error?.name, 'RunnerError');
});

test('known upstream history disappearing at admission retries and blocks prompt dispatch', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id), assistant('m2', id, 'm1'));
  };
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.status, 'completed');
  const original = connection.api.messages.bind(connection.api);
  let boundaryReads = 0;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => opts?.limit === 1
    ? (boundaryReads++, { items: [] as OcMessage[] }) : original(id, opts);
  const reply = engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  await flush();
  await advance(clock, 1_000);
  await assert.rejects(reply);
  assert.equal(boundaryReads, 3);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('admission retries transient status reads inside one startup deadline', async () => {
  const { connection, clock, engine } = setup();
  const original = connection.api.sessionStatus.bind(connection.api);
  let count = 0;
  let admissionCount = 0;
  connection.api.sessionStatus = async (directory: string) => {
    count++;
    if (!connection.api.calls.some((call) => call.method === 'promptAsync')) admissionCount++;
    if (count < 3) throw new OpencodeHttpError('busy', 503, 'HttpError');
    return original(directory);
  };
  const started = engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await flush();
  await advance(clock, 1_000);
  assert.equal((await started).status, 'running');
  assert.equal(admissionCount, 3);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('transient stop history and status failures are retried within cleanup deadline', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const messages = connection.api.messages.bind(connection.api);
  const status = connection.api.sessionStatus.bind(connection.api);
  let messageFailures = 2;
  let statusFailures = 1;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (messageFailures-- > 0) throw new OpencodeHttpError('busy', 503, 'HttpError');
    return messages(id, opts);
  };
  connection.api.sessionStatus = async (directory: string) => {
    if (statusFailures-- > 0) throw new OpencodeHttpError('busy', 503, 'HttpError');
    return status(directory);
  };
  const cancelling = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 2_000);
  const result = await cancelling;
  assert.equal(result.executionState, 'stopped');
  assert.ok(messageFailures < 0 && statusFailures < 0);
});

test('stop confirmation retries transient permission and question list failures', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const permissions = connection.api.listPermissions.bind(connection.api);
  const questions = connection.api.listQuestions.bind(connection.api);
  let failedPermissions = false;
  let failedQuestions = false;
  connection.api.listPermissions = async (directory: string) => {
    if (!failedPermissions) { failedPermissions = true; throw new OpencodeHttpError('busy', 503, 'HttpError'); }
    return permissions(directory);
  };
  connection.api.listQuestions = async (directory: string) => {
    if (!failedQuestions) { failedQuestions = true; throw new OpencodeHttpError('busy', 503, 'HttpError'); }
    return questions(directory);
  };
  const cancelling = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 1_000);
  assert.equal((await cancelling).executionState, 'stopped');
  assert.ok(failedPermissions && failedQuestions);
});

test('a no-assistant stop needs execution evidence, an acknowledged abort, and idle samples five seconds apart', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = () => {}; // suppress the fake's terminal assistant
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const cancelling = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 4_900);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).executionState, 'active');
  await advance(clock, 300);
  assert.equal((await cancelling).executionState, 'stopped');
});

test('a queued user with no execution evidence stays unconfirmed after abort acknowledgement', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.histories.get(id)!.push(user('m1', id)); };
  connection.api.onAbort = () => {};
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const cancelling = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 8_000);
  assert.equal((await cancelling).executionState, 'unknown');
});

test('a 503 abort remains ambiguous and is never blindly sent again', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.abortFailure = new OpencodeHttpError('proxy failed', 503, 'HttpError');
  const stopped = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.executionState, 'unknown');
  const again = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 8_000);
  await again;
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
});

test('malformed 200, 408 and 429 abort responses remain ambiguous', async () => {
  for (const [status, errorName] of [[200, 'ProtocolError'], [200, 'ResponseTooLarge'],
    [408, 'HttpError'], [429, 'HttpError']] as const) {
    const { connection, engine, clock } = setup();
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(user('m1', id));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
    connection.api.abortFailure = new OpencodeHttpError('ambiguous abort', status, errorName);
    assert.equal((await engine.cancel({ sessionId: started.sessionId }, ctx())).executionState, 'unknown');
    const again = engine.cancel({ sessionId: started.sessionId }, ctx());
    await advance(clock, 8_000);
    await again;
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1, `${status}/${errorName}`);
  }
});

test('confirmed execution stop keeps stopped state when leftover cleanup fails, then retries cleanup', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push(assistant('m2', id, 'm1'));
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const original = connection.api.listQuestions.bind(connection.api);
  let fail = true;
  connection.api.listQuestions = async (directory: string) => {
    if (fail) throw new OpencodeHttpError('forbidden', 403, 'HttpError');
    return original(directory);
  };
  const stopped = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'unconfirmed');
  assert.equal(stopped.resendSafety, 'unknown');
  const stillUnconfirmed = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(stillUnconfirmed.cleanup, 'unconfirmed');
  const listAttempts = connection.api.calls.filter((call) => call.method === 'listQuestions').length;
  fail = false;
  const recovered = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.cleanup, 'complete');
  assert.ok(connection.api.calls.filter((call) => call.method === 'listQuestions').length > listAttempts);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
});

test('cleanup does not retry before a Retry-After longer than its budget', async () => {
  const { connection, engine } = setup({ cleanupTimeoutMs: 1_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push(assistant('m2', id, 'm1'));
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  let attempts = 0;
  connection.api.listQuestions = async (_directory: string) => {
    attempts++;
    throw new OpencodeHttpError('busy', 503, 'HttpError', undefined, 600);
  };
  const stopped = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'unconfirmed');
  assert.equal(attempts, 1);
});

test('a successful permission list cannot clear a history read embargo', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const original = connection.api.messages.bind(connection.api);
  let fail = true;
  let resolvePermissions: (items: OcPermissionRequest[]) => void = () => {};
  const delayedPermissions = new Promise<OcPermissionRequest[]>((resolve) => { resolvePermissions = resolve; });
  connection.api.listPermissions = async (_directory: string) => delayedPermissions;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (fail) { fail = false; throw new OpencodeHttpError('busy', 503, 'HttpError', undefined, 60); }
    return original(id, opts);
  };
  await advance(clock, 150);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).upstreamRead?.reason, 'overloaded');
  resolvePermissions([]);
  await flush();
  const reads = connection.api.calls.filter((call) => call.method === 'messages').length;
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: assistant('m2', started.sessionId, 'm1').info } });
  await advance(clock, 500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'messages').length, reads);
});

test('a body reset after HTTP headers is degraded, not an unreachable server', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const reset = new OpencodeHttpError('read ECONNRESET', 0, 'NetworkError');
  reset.responseReceived = true;
  connection.api.messages = async () => { throw reset; };
  let probes = 0;
  connection.api.health = async () => { probes++; throw reset; };
  await advance(clock, 1_000);
  assert.equal(connection.generation, 1);
  assert.equal(probes, 0);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).upstreamRead?.reason, 'network');
});

test('ambiguous abort blocks release before its window, then terminal evidence releases it', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.abortFailure = new OpencodeHttpError('lost', 503, 'HttpError');
  const stopped = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.executionState, 'unknown');
  connection.api.histories.get(started.sessionId)!.push(assistant('m2', started.sessionId, 'm1'));
  connection.api.statuses.delete(started.sessionId);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).executionState, 'unknown');
  await advance(clock, 60_100);
  const released = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(released.executionState, 'stopped');
  assert.equal(released.status, 'completed');
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m3', id), assistant('m4', id, 'm3'));
  };
  assert.equal((await engine.reply({ sessionId: started.sessionId, prompt: 'next' }, ctx())).status, 'completed');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 2);
});

test('quarantine recovery cannot discard earlier observed tool activity', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    const tool = assistant('m2', id, 'm1');
    tool.info.finish = 'tool-calls';
    tool.parts = [{ id: 'tool', sessionID: id, messageID: 'm2', type: 'tool', tool: 'bash',
      state: { status: 'completed' } }];
    const empty = assistant('m3', id, 'm1');
    empty.parts = [{ id: 'empty', sessionID: id, messageID: 'm3', type: 'text', text: '' }];
    connection.api.histories.get(id)!.push(user('m1', id), tool, empty);
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await advance(clock, 100);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).toolCallCount, 1);
  connection.api.abortFailure = new OpencodeHttpError('lost', 503, 'HttpError');
  assert.equal((await engine.cancel({ sessionId: started.sessionId }, ctx())).executionState, 'unknown');
  connection.api.statuses.delete(started.sessionId);
  const original = connection.api.messages.bind(connection.api);
  let stale = true;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    const page = await original(id, opts);
    return stale ? { ...page, items: page.items.filter((message) => message.info.id !== 'm2') } : page;
  };
  await advance(clock, 60_100);
  const checking = engine.status({ sessionId: started.sessionId }, ctx());
  await advance(clock, 8_000);
  const unconfirmed = await checking;
  assert.equal(unconfirmed.executionState, 'unknown');
  assert.equal(unconfirmed.toolCallCount, 1);
  stale = false;
  const recovered = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.warnings?.[0]?.code, 'EMPTY_RESPONSE');
  assert.equal(recovered.resendSafety, 'inspect_effects');
  assert.equal(recovered.toolCallCount, 1);
});

test('aged ambiguous abort releases a root-only stopped turn after two idle observations', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.abortFailure = new OpencodeHttpError('lost', 503, 'HttpError');
  assert.equal((await engine.cancel({ sessionId: started.sessionId }, ctx())).executionState, 'unknown');
  connection.api.statuses.delete(started.sessionId);
  await advance(clock, 60_100);
  const recovering = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 4_900);
  assert.equal((await engine.list()).sessions[0]?.status, 'quarantined');
  await advance(clock, 300);
  const released = await recovering;
  assert.equal(released.executionState, 'stopped');
  assert.equal(released.cleanup, 'complete');
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
});

test('late root and assistant recover an ambiguous submission after its observation window', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'work' }, ctx());
  await flush();
  await advance(clock, 250);
  const unknown = await pending;
  assert.equal(unknown.error?.name, 'SUBMISSION_UNCONFIRMED');
  assert.match(unknown.hint ?? '', /Do not resend/);
  connection.api.histories.get(unknown.sessionId)!.push(user('m1', unknown.sessionId), assistant('m2', unknown.sessionId, 'm1'));
  const recovered = await engine.status({ sessionId: unknown.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('a failed follow-up read after an ambiguous POST keeps the original turn running', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const original = connection.api.messages.bind(connection.api);
  let failed = false;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (opts?.limit === 100 && !failed) {
      failed = true;
      throw new OpencodeHttpError('busy', 503, 'HttpError');
    }
    return original(id, opts);
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  assert.equal(started.status, 'running');
  assert.equal(started.upstreamRead?.reason, 'overloaded');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
  connection.api.histories.get(started.sessionId)!.push(user('m1', started.sessionId), assistant('m2', started.sessionId, 'm1'));
  await advance(clock, 500);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'completed');
});

test('quarantine inspection retries transient history and status failures before accepting late evidence', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = engine.start({ prompt: 'work' }, ctx());
  await flush();
  await advance(clock, 250);
  const unknown = await pending;
  connection.api.histories.get(unknown.sessionId)!.push(user('m1', unknown.sessionId), assistant('m2', unknown.sessionId, 'm1'));
  const messages = connection.api.messages.bind(connection.api);
  const status = connection.api.sessionStatus.bind(connection.api);
  let badHistory = 1;
  let badStatus = 1;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (badHistory-- > 0) throw new OpencodeHttpError('busy', 503, 'HttpError');
    return messages(id, opts);
  };
  connection.api.sessionStatus = async (directory: string) => {
    if (badStatus-- > 0) throw new OpencodeHttpError('busy', 503, 'HttpError');
    return status(directory);
  };
  const inspection = engine.status({ sessionId: unknown.sessionId, waitSeconds: 0 }, ctx());
  await flush();
  await advance(clock, 1_000);
  const recovered = await inspection;
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.status, 'completed');
  assert.ok(badHistory < 0 && badStatus < 0);
});

test('503 delete and archive retain same-action ambiguity markers', async () => {
  for (const action of ['delete', 'archive'] as const) {
    const { connection, engine } = setup();
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(user('m1', id), assistant('m2', id, 'm1'));
    };
    const first = await engine.start({ prompt: 'work' }, ctx());
    const failure = new OpencodeHttpError('proxy failed', 503, 'HttpError');
    if (action === 'delete') connection.api.deleteSession = async () => { throw failure; };
    else connection.api.archiveSession = async () => { throw failure; };
    await assert.rejects(engine.end({ sessionId: first.sessionId, action }, ctx()), { code: 'CLEANUP_UNCONFIRMED' });
    const other = action === 'delete' ? 'archive' : 'delete';
    await assert.rejects(engine.end({ sessionId: first.sessionId, action: other }, ctx()), /Retry the original end action/);
  }
});

test('two degraded turns keep one lease, and 503 polling cannot exceed healthy frequency', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const first = await engine.start({ prompt: 'one', waitSeconds: 0 }, ctx());
  const second = await engine.start({ prompt: 'two', waitSeconds: 0 }, ctx());
  let reads = 0;
  connection.api.messages = async () => { reads++; throw new OpencodeHttpError('busy', 503, 'HttpError'); };
  await advance(clock, 500);
  for (const id of [first.sessionId, second.sessionId]) {
    const result = await engine.status({ sessionId: id, waitSeconds: 0 }, ctx());
    assert.equal(result.status, 'running');
    assert.equal(result.upstreamRead?.reason, 'overloaded');
    assert.equal(result.upstreamRead?.statusCode, 503);
    assert.equal(typeof result.upstreamRead?.since, 'number');
    assert.ok((result.upstreamRead?.nextAt ?? 0) > clock.wallNow());
    assert.equal(result.executionState, 'active');
  }
  assert.equal(connection.generation, 1);
  assert.ok(reads <= 10, `two turns made ${reads} reads in five healthy poll intervals`);
});

test('hard failures from two turns share exactly three health probes before attach loss', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  await engine.start({ prompt: 'one', waitSeconds: 0 }, ctx());
  await engine.start({ prompt: 'two', waitSeconds: 0 }, ctx());
  const hard = new OpencodeHttpError('connect ECONNREFUSED', 0, 'NetworkError');
  connection.api.messages = async () => { throw hard; };
  connection.api.listPermissions = async () => { throw hard; };
  let probes = 0;
  connection.api.health = async () => { probes++; throw hard; };
  await advance(clock, 1_000);
  assert.equal(probes, 3);
  assert.equal(connection.generation, 2);
});

test('managed child remains live through sustained 5xx reads and health failures', async () => {
  const { connection, clock, engine } = setup({ mode: 'managed' });
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const failure = new OpencodeHttpError('server busy', 503, 'HttpError');
  connection.api.messages = async () => { throw failure; };
  connection.api.listPermissions = async () => { throw failure; };
  connection.api.health = async () => { throw failure; };
  await advance(clock, 1_000);
  assert.equal(connection.generation, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
});

test('managed hard failures probe once but never recycle a live child', async () => {
  const { connection, clock, engine } = setup({ mode: 'managed' });
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const hard = new OpencodeHttpError('connect ECONNREFUSED', 0, 'NetworkError');
  connection.api.messages = async () => { throw hard; };
  connection.api.listPermissions = async () => { throw hard; };
  let probes = 0;
  connection.api.health = async () => { probes++; throw hard; };
  await advance(clock, 2_000);
  assert.equal(probes, 3);
  assert.equal(connection.generation, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
});
