import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../../src/core/engine.ts';
import { classifyOutcome, compactResult, providerError } from '../../src/core/result.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, RequestOptions } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const samples = JSON.parse(readFileSync(new URL('../../docs/research/probe-overload/samples.json', import.meta.url), 'utf8')) as
  Record<string, { firstMessages: OcMessage[]; finalAssistant?: { error?: NonNullable<OcMessage['info']['error']> } }>;
const fixture = (name: string): OcMessage[] => structuredClone(samples[name]!.firstMessages);
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const config = {
  mode: 'attach', defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  startupTimeoutMs: 2_000, requestTimeoutMs: 100, readRetryAttempts: 1,
  turnTimeoutMs: 60_000, maxTurnTimeoutMs: 60_000, approvalTimeoutMs: 500,
  heartbeatMs: 50, statusPollMs: 100, sseStallMs: 1_000, cleanupTimeoutMs: 1_000,
  maxOutputChars: 2_000, endAction: 'delete', onExit: 'abort', responseLoopLimit: 6,
} as Config;
const user = (id: string, sessionID: string): OcMessage => ({
  info: { id, sessionID, role: 'user', time: { created: 1 } }, parts: [],
});
const assistant = (id: string, sessionID: string, parentID: string, finish = 'stop', text = 'done'): OcMessage => ({
  info: { id, sessionID, parentID, role: 'assistant', finish, time: { created: 2, completed: 3 } },
  parts: [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text }],
});
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function advance(clock: FakeClock, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const progress: string[] = [];
  const engine = createEngine({ config: { ...config, ...overrides }, connection, clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const context = (): CallContext => ({ signal: new AbortController().signal, progress: (message) => progress.push(message) });
  return { connection, clock, engine, progress, context };
}

test('captured terminal outcomes distinguish termination from answer success', () => {
  for (const key of ['4-empty-stop', '5-whitespace']) {
    const result = classifyOutcome(fixture(key), true);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.name, 'EMPTY_RESPONSE');
    assert.equal(result.error?.retryable, true);
  }
  const length = classifyOutcome(fixture('11-finish-length'), true);
  assert.equal(length.status, 'completed');
  assert.equal(length.finish, 'length');
  assert.equal(length.partial, true);
  assert.equal(length.warnings?.[0]?.code, 'TRUNCATED');
  const messages = [user('m1', 's'), assistant('m2', 's', 'm1', 'stop', '  \n')];
  messages[1]!.parts.push({ id: 'tool', sessionID: 's', messageID: 'm2', type: 'tool', tool: 'bash',
    state: { status: 'completed' } });
  const activity = classifyOutcome(messages, true);
  assert.equal(activity.status, 'completed');
  assert.equal(activity.warnings?.[0]?.code, 'EMPTY_RESPONSE');
  for (const finish of ['content-filter', 'error', 'other', 'surprise']) {
    const result = classifyOutcome([user('m1', 's'), assistant('m2', 's', 'm1', finish)], true);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.name, finish === 'content-filter' ? 'ContentFilterError' : 'TURN_INCOMPLETE');
  }
  for (const finish of ['unknown', 'tool-calls']) {
    assert.equal(classifyOutcome([user('m1', 's'), assistant('m2', 's', 'm1', finish)], false).status, 'running');
  }
  const emptyLength = classifyOutcome([user('m1', 's'), assistant('m2', 's', 'm1', 'length', ' ')], true);
  assert.equal(emptyLength.error?.name, 'EMPTY_RESPONSE');
  assert.equal(emptyLength.warnings?.[0]?.code, 'TRUNCATED');
  const reasoningOnly = assistant('m2', 's', 'm1', 'stop', '');
  reasoningOnly.parts = [{ id: 'r', sessionID: 's', messageID: 'm2', type: 'reasoning', text: 'thinking' }];
  assert.equal(classifyOutcome([user('m1', 's'), reasoningOnly], true).error?.name, 'EMPTY_RESPONSE');
  const synthetic = assistant('m2', 's', 'm1', 'stop', 'ignored');
  synthetic.parts[0]!.synthetic = true;
  assert.equal(classifyOutcome([user('m1', 's'), synthetic], true).error?.name, 'EMPTY_RESPONSE');
  const patch = assistant('m2', 's', 'm1', 'stop', '');
  patch.parts = [{ id: 'patch', sessionID: 's', messageID: 'm2', type: 'patch', files: ['/repo/a'] }];
  assert.equal(classifyOutcome([user('m1', 's'), patch], true).warnings?.[0]?.code, 'EMPTY_RESPONSE');
  const noFinish = assistant('m2', 's', 'm1', 'stop', 'text');
  delete noFinish.info.finish;
  assert.equal(classifyOutcome([user('m1', 's'), noFinish], true).error?.name, 'TURN_INCOMPLETE');
  assert.equal(classifyOutcome([user('m1', 's'), noFinish], true).warnings?.[0]?.code, 'NONSTANDARD_FINISH');
  const summary = assistant('m3', 's', 'm1', 'stop', 'summary');
  summary.info.summary = true;
  assert.equal(classifyOutcome([user('m1', 's'), patch, summary], true).warnings?.[0]?.code, 'EMPTY_RESPONSE');
});

test('finish values await a finite nonnegative completion timestamp', () => {
  for (const finish of ['stop', 'length', 'content-filter', 'other']) {
    for (const completed of [undefined, NaN, -1, '3']) {
      const value = assistant('m2', 's', 'm1', finish, 'answer');
      (value.info.time as { completed?: unknown }).completed = completed;
      assert.equal(classifyOutcome([user('m1', 's'), value], false).status, 'running');
      assert.equal(classifyOutcome([user('m1', 's'), value], true).error?.name, 'TURN_INCOMPLETE');
    }
  }
  const abortDuringRetry = assistant('m2', 's', 'm1', 'stop');
  delete abortDuringRetry.info.finish;
  assert.equal(classifyOutcome([user('m1', 's'), abortDuringRetry], true).error?.name, 'TURN_INCOMPLETE');
});

test('idle finish-before-completion cannot produce a clean completed turn', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    const unfinished = assistant('m2', id, 'm1', 'stop', 'answer');
    delete unfinished.info.time.completed;
    connection.api.histories.get(id)!.push(user('m1', id), unfinished);
  };
  const pending = engine.start({ prompt: 'work' }, ctx());
  await advance(clock, 5_500);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'TURN_INCOMPLETE');
  assert.equal(result.output?.partial, true);
});

test('a stale read cannot erase an earlier tool or downgrade resend safety', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    const tool = assistant('m2', id, 'm1', 'tool-calls', '');
    tool.parts = [{ id: 'tool', sessionID: id, messageID: 'm2', type: 'tool', tool: 'bash',
      state: { status: 'completed' } }];
    connection.api.histories.get(id)!.push(user('m1', id), tool, assistant('m3', id, 'm1', 'stop', ''));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await advance(clock, 100);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).toolCallCount, 1);
  const original = connection.api.messages.bind(connection.api);
  let stale = true;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    const page = await original(id, opts);
    return stale ? { ...page, items: page.items.filter((message) => message.info.id !== 'm2') } : page;
  };
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await advance(clock, 200);
  const degraded = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(degraded.status, 'running');
  assert.equal(degraded.toolCallCount, 1);
  assert.equal(degraded.upstreamRead?.reason, 'protocol');
  stale = false;
  await advance(clock, 1_000);
  const finished = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(finished.status, 'completed');
  assert.equal(finished.warnings?.[0]?.code, 'EMPTY_RESPONSE');
  assert.equal(finished.resendSafety, 'inspect_effects');
  assert.equal(finished.toolCallCount, 1);
});

test('Retry-After of ten minutes survives admission mapping and running read embargo', async () => {
  const admitted = setup();
  admitted.connection.api.statusFailure = new OpencodeHttpError('busy', 503, 'HttpError', undefined, 600);
  await assert.rejects(admitted.engine.start({ prompt: 'work' }, ctx()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'OPENCODE_OVERLOADED');
    assert.equal((error as { retryAfterSeconds?: number }).retryAfterSeconds, 600);
    return true;
  });
  const running = setup();
  running.connection.api.onPrompt = (id) => {
    running.connection.api.histories.get(id)!.push(user('m1', id));
    running.connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await running.engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const original = running.connection.api.messages.bind(running.connection.api);
  let fail = true;
  running.connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (fail) { fail = false; throw new OpencodeHttpError('busy', 503, 'HttpError', undefined, 600); }
    return original(id, opts);
  };
  running.connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: assistant('m2', started.sessionId, 'm1').info } });
  await advance(running.clock, 500);
  const reads = running.connection.api.calls.filter((call) => call.method === 'messages').length;
  await advance(running.clock, 1_000);
  assert.equal(running.connection.api.calls.filter((call) => call.method === 'messages').length, reads);
  assert.ok(((await running.engine.status({ sessionId: started.sessionId }, ctx())).upstreamRead?.nextAt ?? 0) - running.clock.wallNow() > 590_000);
});

test('provider metadata and malformed-stream sentinel are bounded and sanitized', () => {
  const fromProbe = samples['1b-429-always']!.finalAssistant!.error!;
  const detail = providerError(fromProbe, 0);
  assert.equal(detail.name, 'APIError');
  assert.equal(detail.statusCode, 429);
  assert.equal(detail.condition, 'MODEL_OVERLOADED');
  assert.equal(detail.retryable, true);
  assert.equal(detail.retryAfterSeconds, 2);
  assert.equal('responseHeaders' in detail, false);
  assert.equal(providerError({ name: 'APIError', data: { statusCode: 503, isRetryable: false } }).retryable, false);
  const malformed = samples['7-malformed-sse']!.finalAssistant!.error!;
  const result = providerError({ name: 'UnknownError', data: { message: `${malformed.data!.message} SECRET_CHUNK` } });
  assert.equal(result.message, 'The model provider returned a malformed streaming response.');
  assert.equal(JSON.stringify(result).includes('SECRET_CHUNK'), false);
});

test('engine retains truncation, empty warnings, and output partial in status, batch and replay', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id), assistant('m2', id, 'm1', 'length', 'partial answer'));
  };
  const result = await engine.start({ prompt: 'work', requestId: 'length-key' }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(result.finish, 'length');
  assert.equal(result.output?.partial, true);
  assert.equal(result.warnings?.[0]?.code, 'TRUNCATED');
  assert.equal((await engine.status({ sessionId: result.sessionId }, ctx())).warnings?.[0]?.code, 'TRUNCATED');
  assert.equal((await engine.statusMany({ ids: [result.sessionId] }, ctx())).results[0]?.warnings?.[0]?.code, 'TRUNCATED');
  const replay = await engine.start({ prompt: 'work', requestId: 'length-key' }, ctx());
  assert.equal(replay.finish, 'length');
  assert.equal(replay.output?.partial, true);
  assert.equal(compactResult(result).warnings?.[0]?.code, 'TRUNCATED');
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('empty stop with observed tool activity completes with warning and inspect-effects safety', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const response = assistant('m2', id, 'm1', 'stop', '  \n');
    response.parts.push({ id: 'tool', sessionID: id, messageID: 'm2', type: 'tool', tool: 'bash',
      state: { status: 'completed' } });
    connection.api.histories.get(id)!.push(user('m1', id), response);
  };
  const result = await engine.start({ prompt: 'work' }, ctx());
  assert.equal(result.status, 'completed');
  assert.equal(result.warnings?.[0]?.code, 'EMPTY_RESPONSE');
  assert.equal(result.resendSafety, 'inspect_effects');
  assert.equal(result.output?.partial, true);
  assert.equal(result.content, '  \n');
  assert.equal(result.hint, 'Tool activity occurred, but the final answer is empty. Inspect opencode-output and the turn diff before continuing.');
});

test('busy retry observation appears in running snapshot and clears on idle', async () => {
  const { connection, engine, clock, context } = setup();
  connection.api.onPrompt = (id) => { connection.api.histories.get(id)!.push(user('m1', id)); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.api.statuses.set(started.sessionId, { type: 'retry', attempt: 2, message: 'busy\nretry', next: 2_000 });
  connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId,
    status: { type: 'retry', attempt: 2, message: 'busy\nretry', next: 2_000 } } });
  await advance(clock, 50);
  const running = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(running.upstreamRetry?.attempt, 2);
  assert.equal(running.upstreamRetry?.message, 'busy retry');
  connection.api.histories.get(started.sessionId)!.push(assistant('m2', started.sessionId, 'm1'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await advance(clock, 50);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).upstreamRetry, undefined);
});

test('provider retry observation survives a stop begun during retry', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'retry', attempt: 3, message: 'backing off', next: 3_000 });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId,
    status: { type: 'retry', attempt: 3, message: 'backing off', next: 3_000 } } });
  await advance(clock, 50);
  const stopping = engine.cancel({ sessionId: started.sessionId }, ctx());
  await advance(clock, 300);
  const result = await stopping;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.upstreamRetry?.attempt, 3);
  assert.equal(result.upstreamRetry?.message, 'backing off');
});

test('watchdog stops the captured empty loop and keeps its cause through replay and batch', async () => {
  const { connection, engine, clock, context, progress } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    history.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', requestId: 'loop-key', waitSeconds: 0 }, context());
  const observing = engine.status({ sessionId: started.sessionId, waitSeconds: 2 }, context());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  await advance(clock, 1_500);
  const result = await observing;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(result.error?.retryable, false);
  assert.equal(result.responseLoop?.count, 6);
  assert.equal(progress.includes('Repeated unusable model responses detected; requesting OpenCode stop.'), true);
  assert.equal(result.output?.partial, true);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal((await engine.statusMany({ ids: [started.sessionId] }, ctx())).results[0]?.responseLoop?.count, 6);
  const replay = await engine.start({ prompt: 'work', requestId: 'loop-key', waitSeconds: 0 }, ctx());
  assert.equal(replay.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(replay.responseLoop?.count, 6);
});

test('a confirmed prompt 429 is overloaded and not submitted; prompt 503 stays ambiguous', async () => {
  const first = setup();
  first.connection.api.promptFailure = new OpencodeHttpError('rate limited', 429, 'HttpError', undefined, 3);
  const rejected = await first.engine.start({ prompt: 'work' }, ctx());
  assert.equal(rejected.error?.name, 'OPENCODE_OVERLOADED');
  assert.equal(rejected.error?.retryAfterSeconds, 3);
  assert.equal(rejected.executionState, 'stopped');
  assert.equal(rejected.resendSafety, 'not_submitted');
  const second = setup();
  second.connection.api.promptFailure = new OpencodeHttpError('busy', 503, 'HttpError');
  const ambiguous = await second.engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  assert.equal(ambiguous.status, 'running');
  assert.equal(ambiguous.resendSafety, 'unknown');
});

test('admission status 503 and create 429 map to OPENCODE_OVERLOADED with bounded Retry-After', async () => {
  const read = setup();
  read.connection.api.statusFailure = new OpencodeHttpError('busy', 503, 'HttpError', undefined, 150);
  await assert.rejects(read.engine.start({ prompt: 'work' }, ctx()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'OPENCODE_OVERLOADED');
    assert.equal((error as { retryAfterSeconds?: number }).retryAfterSeconds, 150);
    return true;
  });
  assert.equal(read.connection.api.calls.some((call) => call.method === 'promptAsync'), false);
  const create = setup();
  create.connection.api.createSession = async (_directory: string) => {
    throw new OpencodeHttpError('rate limited', 429, 'HttpError', undefined, 4);
  };
  await assert.rejects(create.engine.start({ prompt: 'work' }, ctx()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'OPENCODE_OVERLOADED');
    assert.equal((error as { retryAfterSeconds?: number }).retryAfterSeconds, 4);
    return true;
  });
  const ambiguous = setup();
  ambiguous.connection.api.createSession = async (_directory: string) => {
    throw new OpencodeHttpError('busy', 503, 'HttpError');
  };
  await assert.rejects(ambiguous.engine.start({ prompt: 'work', requestId: 'ambiguous-create' }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'UPSTREAM_ERROR');
});

test('malformed SSE UnknownError is sanitized through turn result, status and batch', async () => {
  const { connection, engine } = setup();
  const raw = samples['7-malformed-sse']!.finalAssistant!.error!;
  connection.api.onPrompt = (id) => {
    const failure = assistant('m2', id, 'm1');
    failure.info.error = { name: 'UnknownError', data: { message: `${raw.data!.message} SECRET_CHUNK` } };
    connection.api.histories.get(id)!.push(user('m1', id), failure);
  };
  const result = await engine.start({ prompt: 'work' }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'UnknownError');
  assert.equal(result.hint, 'OpenCode could not parse a response. Check the model/gateway response format; inspect partial effects before retrying.');
  assert.equal(JSON.stringify(result).includes('SECRET_CHUNK'), false);
  assert.equal(JSON.stringify(await engine.status({ sessionId: result.sessionId }, ctx())).includes('SECRET_CHUNK'), false);
  assert.equal(JSON.stringify(await engine.statusMany({ ids: [result.sessionId] }, ctx())).includes('SECRET_CHUNK'), false);
});

test('five unusable attempts followed by a normal answer complete; limit zero disables the watchdog', async () => {
  for (const disabled of [false, true]) {
    const { connection, engine, clock } = setup({ responseLoopLimit: disabled ? 0 : 6 });
    connection.api.onPrompt = (id) => {
      const history = connection.api.histories.get(id)!;
      history.push(user('m000', id));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
    const history = connection.api.histories.get(started.sessionId)!;
    const captured = fixture('3-empty-done')[1]!;
    for (let i = 1; i <= (disabled ? 8 : 5); i++) {
      const message = structuredClone(captured);
      message.info.id = `m${String(i).padStart(3, '0')}`;
      message.info.sessionID = started.sessionId;
      message.info.parentID = 'm000';
      message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
      message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
        messageID: message.info.id }));
      history.push(message);
    }
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 1_500);
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
    if (disabled) {
      assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
    } else {
      history.push(assistant('m006', started.sessionId, 'm000'));
      connection.api.statuses.delete(started.sessionId);
      connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
      await advance(clock, 1_000);
      assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'completed');
    }
  }
});

test('lost abort response retains watchdog failure and uncertain stop without a second abort', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.abortFailure = new OpencodeHttpError('lost abort response', 0, 'NetworkError');
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  await advance(clock, 1_500);
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(result.executionState, 'unknown');
  assert.equal(result.cleanup, 'unconfirmed');
  assert.equal(result.resendSafety, 'unknown');
  assert.equal(result.hint.startsWith('Stop could not be confirmed'), true);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  clock.tick(60_100);
  await flush();
  history.push({ info: { id: 'm009', sessionID: started.sessionId, role: 'assistant', parentID: 'm000',
    time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  connection.api.statuses.delete(started.sessionId);
  const recovered = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(recovered.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(recovered.responseLoop?.count, 6);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.cleanup, 'complete');
  assert.equal(recovered.hint.startsWith('OpenCode was stopped after repeated unusable'), true);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
});

test('captured invalid-tool loop stops with inspect-effects safety', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('9-bad-tool-json')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  await advance(clock, 1_500);
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(result.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(result.responseLoop?.pattern, 'invalid_tool');
  assert.equal(result.resendSafety, 'inspect_effects');
  assert.equal(result.toolCallCount, 7);
});

test('transient bash pending parts cannot mask a completed invalid-tool response loop', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 100 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant',
      parentID: 'm000', time: { created: 3_000, completed: 3_001 },
      error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('9-bad-tool-json')[1]!;
  const beganAt = clock.monotonicNow();
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 130, completed: 1_050 + i * 130 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    const tool = message.parts.find((part) => part.type === 'tool')!;
    for (const part of [
      { ...tool, tool: 'bash', state: { status: 'pending', input: {} } },
      { ...tool, tool: 'invalid', state: { status: 'running', input: {} } },
      tool,
    ]) {
      connection.api.emit('/repo', { type: 'message.part.updated', properties: {
        sessionID: started.sessionId, part,
      } });
      await flush();
    }
    history.push(message);
    connection.api.emit('/repo', { type: 'message.updated', properties: {
      sessionID: started.sessionId, info: message.info,
    } });
    await advance(clock, 130);
  }
  await advance(clock, 1_500);
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.ok(clock.monotonicNow() - beganAt < 3_000);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(result.responseLoop?.pattern, 'invalid_tool');
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
});

test('an absent pending bash part alone cannot fence completed invalid-tool attempts', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 100 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant',
      parentID: 'm000', time: { created: 3_000, completed: 3_001 },
      error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('9-bad-tool-json')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 130, completed: 1_050 + i * 130 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.part.updated', properties: {
    sessionID: started.sessionId,
    part: { id: 'pending-tool', sessionID: started.sessionId, messageID: 'm008',
      type: 'tool', tool: 'bash', state: { status: 'pending', input: {} } },
  } });
  connection.api.emit('/repo', { type: 'message.updated', properties: {
    sessionID: started.sessionId, info: history.at(-1)!.info,
  } });
  await advance(clock, 1_000);
  connection.api.emit('/repo', { type: 'message.updated', properties: {
    sessionID: started.sessionId, info: history.at(-1)!.info,
  } });
  await advance(clock, 1_000);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).responseLoop?.pattern, 'invalid_tool');
});

test('a genuine bash tool becoming active still suppresses response-loop detection', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('9-bad-tool-json')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 130, completed: 1_050 + i * 130 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    history.push(message);
  }
  const realTool = assistant('m008', started.sessionId, 'm000', 'tool-calls', '');
  realTool.info.time = { created: 2_000, completed: 2_100 };
  realTool.parts = [{ id: 'real-tool', sessionID: started.sessionId, messageID: 'm008',
    type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'echo ok' } } }];
  for (const status of ['pending', 'running', 'completed'] as const) {
    connection.api.emit('/repo', { type: 'message.part.updated', properties: {
      sessionID: started.sessionId,
      part: { ...realTool.parts[0]!, state: { status, input: { command: 'echo ok' } } },
    } });
    await flush();
  }
  connection.api.emit('/repo', { type: 'message.updated', properties: {
    sessionID: started.sessionId, info: history.at(-1)!.info,
  } });
  await advance(clock, 500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  history.push(realTool);
  connection.api.emit('/repo', { type: 'message.updated', properties: {
    sessionID: started.sessionId, info: realTool.info,
  } });
  await advance(clock, 1_500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
});

test('retry status fences its assistant; a failed confirmation read cannot stop a loop', async () => {
  for (const failedRead of [false, true]) {
    const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(user('m000', id));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
    const history = connection.api.histories.get(started.sessionId)!;
    const captured = fixture('3-empty-done')[1]!;
    for (let i = 1; i <= 7; i++) {
      const message = structuredClone(captured);
      message.info.id = `m${String(i).padStart(3, '0')}`;
      message.info.sessionID = started.sessionId;
      message.info.parentID = 'm000';
      message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
      message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
        messageID: message.info.id }));
      history.push(message);
    }
    if (failedRead) connection.api.statusFailure = new OpencodeHttpError('temporarily busy', 503, 'HttpError');
    else connection.api.statuses.set(started.sessionId, { type: 'retry', attempt: 1, message: 'provider retry', next: 2_000 });
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 1_500);
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
    assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
    if (!failedRead) {
      connection.api.statuses.set(started.sessionId, { type: 'busy' });
      connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId,
        status: { type: 'busy' } } });
      await advance(clock, 1_500);
      assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
    }
  }
});

test('invalid retry metadata still fences the watchdog until a fresh busy status', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    history.push(message);
  }
  connection.api.statuses.set(started.sessionId, { type: 'retry', attempt: -1, message: 'bad metadata', next: 0 });
  connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId,
    status: { type: 'retry', attempt: -1 } } });
  await advance(clock, 1_500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).upstreamRetry, undefined);
  connection.api.statuses.set(started.sessionId, { type: 'busy' });
  connection.api.emit('/repo', { type: 'session.status', properties: { sessionID: started.sessionId,
    status: { type: 'busy' } } });
  await advance(clock, 1_500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
});

test('productive assistant after a historical loop prevents a watchdog abort', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    history.push(message);
  }
  const productive = assistant('m008', started.sessionId, 'm000', 'unknown', '');
  delete productive.info.time.completed;
  delete productive.info.finish;
  productive.parts = [{ id: 'reasoning', sessionID: started.sessionId,
    messageID: productive.info.id, type: 'reasoning', text: 'working on it' }];
  history.push(productive);
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: productive.info } });
  await advance(clock, 1_500);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
});

test('continuous message events cannot postpone watchdog reconciliation', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  for (let elapsed = 0; elapsed < 1_500; elapsed += 50) {
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 50);
  }
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).error?.name, 'UPSTREAM_RESPONSE_LOOP');
});

test('evicted keyed receipt retains the provider error name and classification scalars', async () => {
  const { connection, engine } = setup();
  let turns = 0;
  connection.api.onPrompt = (id) => {
    turns++;
    const userId = `m${String(turns * 2 - 1).padStart(3, '0')}`;
    const assistantId = `m${String(turns * 2).padStart(3, '0')}`;
    const result = assistant(assistantId, id, userId);
    if (turns === 1) result.info.error = { name: 'VendorBackpressureError',
      data: { message: 'provider busy', statusCode: 529, isRetryable: false } };
    connection.api.histories.get(id)!.push(user(userId, id), result);
  };
  const input = { prompt: 'first', requestId: 'provider-receipt' };
  const first = await engine.start(input, ctx());
  assert.equal(first.error?.name, 'VendorBackpressureError');
  for (let i = 0; i < 64; i++) {
    const result = await engine.reply({ sessionId: first.sessionId, prompt: `step ${i}` }, ctx());
    assert.equal(result.status, 'completed');
  }
  const replay = await engine.start(input, ctx());
  assert.equal(replay.error?.name, 'VendorBackpressureError');
  assert.equal(replay.error?.statusCode, 529);
  assert.equal(replay.error?.retryable, false);
  assert.equal(replay.error?.condition, 'MODEL_OVERLOADED');
  assert.equal(turns, 65);
});

// P2-B: a positive part is disproved only by a history read that STARTED after the part event —
// not by any subsequent read regardless of timing. The previous version of this test ran with
// statusPollMs:30_000 and only ever triggered a reconcile via message.updated events emitted
// AFTER the fence-clearing mutation already existed in history, so its first `advance()` never
// actually ran a reconcile at all (part events alone never schedule one) and its assertions never
// exercised the "before vs after" ordering the fence exists to enforce — it passed vacuously.
// This rewrite uses the fake API's ability to hold a messages() read's return (but not its
// synchronous start, which is what "started" means here) to construct both orderings explicitly.
test('a positive part is disproved only by a history read that started after it', async () => {
  const captured = fixture('3-empty-done')[1]!;
  const pushLoopHistory = (history: OcMessage[], sessionId: string): void => {
    for (let i = 1; i <= 7; i++) {
      const message = structuredClone(captured);
      message.info.id = `m${String(i).padStart(3, '0')}`;
      message.info.sessionID = sessionId;
      message.info.parentID = 'm000';
      message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
      message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
        sessionID: sessionId, messageID: message.info.id }));
      history.push(message);
    }
  };
  const positivePart = (sessionId: string) => ({ id: 'text', sessionID: sessionId, messageID: 'm007',
    type: 'text', text: 'Recovered answer' });

  // (a) then (b), on the same turn: a read already in flight (its underlying request already
  // issued) when the positive part event fires must not be disproved by its own — necessarily
  // stale — result; only a later read that genuinely starts after the event may clear the fence,
  // at which point the already-qualifying 7-attempt streak aborts immediately.
  {
    const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(user('m000', id));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    connection.api.onAbort = (id) => {
      connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant',
        parentID: 'm000', time: { created: 3_000, completed: 3_001 },
        error: { name: 'MessageAbortedError' } }, parts: [] });
    };
    const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
    const history = connection.api.histories.get(started.sessionId)!;
    pushLoopHistory(history, started.sessionId);
    const original = connection.api.messages.bind(connection.api);
    let releaseGate: (() => void) | undefined;
    let gated = false;
    connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
      // Captures the snapshot synchronously (before any `await`), exactly like the real read
      // does the moment it is issued — only the RETURN to the caller is held back, modelling a
      // read that started before the event below but resolves after it.
      const result = original(id, opts);
      if (!gated) {
        gated = true;
        await new Promise<void>((resolve) => { releaseGate = resolve; });
      }
      return result;
    };
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 300);
    assert.equal(releaseGate !== undefined, true, 'the read must already be in flight before the event fires');
    // The positive part event fires while that read is still pending: this read started before
    // it and must never be allowed to disprove it, however it resolves.
    connection.api.emit('/repo', { type: 'message.part.updated', properties: { sessionID: started.sessionId,
      part: positivePart(started.sessionId) } });
    releaseGate!();
    await advance(clock, 300);
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);

    // (b) A later read genuinely starts after the event (the gate only ever held the first call)
    // and still finds m007 without the announced text — the fake server never actually
    // materialized it. Only this ordering may clear the fence, and once cleared the
    // already-qualifying streak aborts.
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 1_500);
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  }

  // (c) When the announced text genuinely lands in history before the next read, that read sees
  // real progress and the watchdog must not fire — regardless of the fence/ordering rule above.
  {
    const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(user('m000', id));
      connection.api.statuses.set(id, { type: 'busy' });
    };
    const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
    const history = connection.api.histories.get(started.sessionId)!;
    pushLoopHistory(history, started.sessionId);
    const part = positivePart(started.sessionId);
    connection.api.emit('/repo', { type: 'message.part.updated', properties: { sessionID: started.sessionId, part } });
    history.at(-1)!.parts.push(part);
    connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
      info: history.at(-1)!.info } });
    await advance(clock, 1_500);
    assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
    assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
  }
});

// P2-A: OpenCode 1.18.33 streams `message.part.delta` chunks between the text-start
// `message.part.updated {text:""}` and the full text only at stream end. A genuine answer
// streaming right after a run of bad attempts must not look like another silent one.
test('streaming text deltas suppress the watchdog while they flow, and it re-arms after they stop', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 1_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 30_000, completed: 30_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 6; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`,
      sessionID: started.sessionId, messageID: message.info.id }));
    history.push(message);
  }
  // The 7th attempt is a genuine answer starting to stream: uncompleted, text "" so far — the
  // exact "silent newer attempt" shape the watchdog would otherwise treat as more silence.
  const streaming = assistant('m007', started.sessionId, 'm000', 'stop', '');
  delete streaming.info.finish;
  delete streaming.info.time.completed;
  streaming.info.time.created = 1_700;
  streaming.parts = [{ id: 'p7_0', sessionID: started.sessionId, messageID: 'm007', type: 'text', text: '' }];
  history.push(streaming);
  for (let elapsed = 0; elapsed < 12_000; elapsed += 500) {
    connection.api.emit('/repo', { type: 'message.part.delta', properties: { sessionID: started.sessionId,
      messageID: 'm007', partID: 'p7_0', field: 'text', delta: 'x' } });
    await advance(clock, 500);
  }
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).status, 'running');
  // Deltas stop and history is unchanged (m007 is still silent/uncompleted): once the 10s quiet
  // window elapses, the watchdog re-arms. This is intentional, not a false positive — a stream
  // that stops emitting deltas without the assistant ever completing (a stalled/dropped stream)
  // is exactly the runaway shape the watchdog exists to catch, so 10s of silence after the last
  // delta must resume checking, the same as if no deltas had ever arrived.
  await advance(clock, 11_000);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).error?.name, 'UPSTREAM_RESPONSE_LOOP');
});

// P2-C, ordering 1: a read that STARTED after the SSE event announcing a newer assistant id must
// reflect it — otherwise a lagging history GET can report a false 'completed' off an earlier,
// merely finish-shaped assistant while the newer one is still genuinely running.
test('an SSE-announced newer assistant absent from a read that started after it is rejected as inconsistent', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m001', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  // m002 looks like a complete answer, but OpenCode has already moved on to m003 (still running,
  // and never landing in the fake history below) by the time it announces it over SSE.
  history.push(assistant('m002', started.sessionId, 'm001'));
  connection.api.statuses.set(started.sessionId, { type: 'idle' });
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: { id: 'm003', sessionID: started.sessionId, role: 'assistant', parentID: 'm001', time: { created: 2_000 } } } });
  await advance(clock, 300);
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  // A read that started after the announcement and still lacks m003 must be treated as stale —
  // never a false 'completed' off m002 while m003 is genuinely running.
  assert.equal(result.status, 'running');
  assert.equal(result.upstreamRead?.reason, 'protocol');
});

// P2-C, ordering 2: a read already in flight when the announcement arrives started before it and
// must not be rejected for lacking the id it could not possibly have seen yet.
test('a read already in flight when a newer assistant is announced is not rejected for lacking it', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m001', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  history.push(assistant('m002', started.sessionId, 'm001'));
  const original = connection.api.messages.bind(connection.api);
  let releaseGate: (() => void) | undefined;
  let gated = false;
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    const result = original(id, opts);
    if (!gated) {
      gated = true;
      await new Promise<void>((resolve) => { releaseGate = resolve; });
    }
    return result;
  };
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  await advance(clock, 300);
  assert.equal(releaseGate !== undefined, true, 'the read must be in flight before m003 is announced');
  // m003 is announced while this read is still pending, and the session stays busy (so this
  // reconcile performs only the one, already-in-flight read — an idle transition would trigger a
  // second read that legitimately starts after the announcement, which is a different case) — it
  // started before the announcement and must not be blamed for lacking it.
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: { id: 'm003', sessionID: started.sessionId, role: 'assistant', parentID: 'm001', time: { created: 2_000 } } } });
  releaseGate!();
  await advance(clock, 300);
  const result = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(result.status, 'running');
  assert.equal(result.upstreamRead, undefined);
});

// P3-1: once cleanup for a response-loop stop completes, the stale "Stop could not be
// confirmed…" hint set when the stop itself was unconfirmed must be recomputed to the
// confirmed-stop wording.
test('cleanup completing for a response-loop stop recomputes the confirmed-stop hint', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  // The stop's own leftover cleanup fails persistently through the whole cleanup deadline:
  // execution confirms stopped (the abort landed and evidence was found), but the cleanup itself
  // does not (stopCleanupPending stays true). listQuestions (unlike listPermissions) is never
  // called by the ordinary approval-polling loop, so this cannot also delay loop detection itself.
  const originalListQuestions = connection.api.listQuestions.bind(connection.api);
  connection.api.listQuestions = async () => {
    throw new OpencodeHttpError('Simulated listQuestions() failure', 0, 'NetworkError');
  };
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  // The abort/evidence-confirm cycle plus the stop's own cleanupTimeoutMs-bounded (1000ms)
  // leftover-question retries can together take noticeably longer than the usual ~1.5s margin
  // used elsewhere in this file (each retry's jittered backoff adds up); 2.5s leaves headroom.
  await advance(clock, 2_500);
  const stopped = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'unconfirmed');
  assert.equal(stopped.hint.startsWith('Stop could not be confirmed'), true);
  // The leftover-questions read now succeeds: cleanup confirms, and the hint must be recomputed
  // to the confirmed-stop wording — not left at the stale "could not be confirmed".
  connection.api.listQuestions = originalListQuestions;
  const recovered = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(recovered.cleanup, 'complete');
  assert.equal(recovered.executionState, 'stopped');
  assert.equal(recovered.error?.name, 'UPSTREAM_RESPONSE_LOOP');
  assert.equal(recovered.hint,
    'OpenCode was stopped after repeated unusable model responses. Check the model/gateway and inspect partial effects before trying again.');
});

// P3-2: shutdown must also confirm quiescence for a stopped-but-cleanup-unconfirmed
// (stopCleanupPending) response-loop turn, not only executionState:'unknown', so onExit=end can
// clean such a session instead of leaving it stranded upstream.
test('shutdown with onExit=end cleans a stopped response-loop turn whose own cleanup could not confirm', async () => {
  const { connection, engine, clock } = setup({ onExit: 'end' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  // See the P3-1 test above: listQuestions (not listPermissions) isolates the stop's own
  // leftover-cleanup failure from the unrelated periodic approval-polling loop.
  const originalListQuestions = connection.api.listQuestions.bind(connection.api);
  connection.api.listQuestions = async () => {
    throw new OpencodeHttpError('Simulated listQuestions() failure', 0, 'NetworkError');
  };
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  // See the P3-1 test above for why this needs more than the usual ~1.5s margin.
  await advance(clock, 2_500);
  const stopped = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(stopped.executionState, 'stopped');
  assert.equal(stopped.cleanup, 'unconfirmed');
  // The read now succeeds; shutdown must still run quiescence recovery for this
  // stopCleanupPending session (not only for executionState:'unknown') so it can be cleaned.
  connection.api.listQuestions = originalListQuestions;
  await engine.shutdown('test');
  assert.equal(connection.api.calls.some((call) => call.method === 'deleteSession'), true);
});

// P3-3: a stale-relative-to-HTTP (or, via P2-C, stale-relative-to-SSE) read is a ProtocolError
// that itself carries a normal 2xx status — the request succeeded, only its content was
// inconsistent. Reporting "HTTP 200" reads as a server error it never was.
test('a read stale relative to HTTP omits statusCode and names the reason in progress', async () => {
  const { connection, engine, clock, progress, context } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await advance(clock, 50);
  const observing = engine.status({ sessionId: started.sessionId, waitSeconds: 1 }, context());
  const original = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    const page = await original(id, opts);
    // A read that drops the already-confirmed root user id is the same "stale relative to HTTP"
    // shape as the pre-existing consistency guard, and carries the same 200 status.
    return { ...page, items: page.items.filter((message) => message.info.id !== 'm1') };
  };
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await advance(clock, 1_500);
  assert.equal(progress.some((message) => message === 'OpenCode reads are delayed (protocol); next check in 1s.'), true);
  assert.equal(progress.some((message) => message.includes('HTTP 200')), false);
  const result = await observing;
  assert.equal(result.status, 'running');
  assert.equal(result.upstreamRead?.reason, 'protocol');
  assert.equal(result.upstreamRead?.statusCode, undefined);
});

// P3-4: a positive part event for a messageID that never actually lands in any history read (a
// dropped/phantom SSE announcement) must not pin the watchdog off for the rest of the turn — it
// expires after 2 * statusPollMs of silence.
test('an unseen-progress fence expires after 2x statusPollMs, letting the watchdog resume', async () => {
  const { connection, engine, clock } = setup({ statusPollMs: 200 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.onAbort = (id) => {
    connection.api.histories.get(id)!.push({ info: { id: 'm009', sessionID: id, role: 'assistant', parentID: 'm000',
      time: { created: 30_000, completed: 30_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.part.updated', properties: { sessionID: started.sessionId,
    part: { id: 'ghost', sessionID: started.sessionId, messageID: 'm999', type: 'text', text: 'phantom answer' } } });
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  // The event is only actually delivered (and the fence marked) on the first clock tick, not at
  // simulated t=0 — advance(300) covers the polls at ~200/275ms, comfortably inside the 400ms
  // (2 * statusPollMs) fence, so no abort yet.
  await advance(clock, 300);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 0);
  // The watchdog check itself is separately throttled to at most once per second (turn.ts's
  // lastWatchdogAt), and the very first admission-time reconcile (before the fence even existed)
  // already consumed that throttle at ~t=0 — so even once the fence clears (~425ms), the next
  // *eligible* check is the ~1000ms poll, not the ~600ms one. advance(1_000) more (past 1300ms
  // total) comfortably covers both the fence's ~425ms expiry and the throttle's 1000ms floor.
  await advance(clock, 1_000);
  assert.equal(connection.api.calls.filter((call) => call.method === 'abort').length, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId }, ctx())).error?.name, 'UPSTREAM_RESPONSE_LOOP');
});

// P3-5: readInterval's messages() calls share the operation's absolute deadline (deadlineAt), not
// only a per-attempt timeoutMs, so the adapter's own page-size fallback ladder cannot overrun the
// read's budget one rung at a time.
test('reconcile shares one absolute deadline with its messages() read', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m1', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const seen: Array<RequestOptions | undefined> = [];
  const original = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }, req?: RequestOptions) => {
    seen.push(req);
    return original(id, opts);
  };
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await advance(clock, 200);
  assert.ok(seen.length > 0);
  for (const req of seen) assert.equal(typeof req?.deadlineAt, 'number');
});

// P3-5: the same sharing for engine.ts's quiescence-recovery read.
test('quiescence recovery shares one absolute deadline with its messages() read', async () => {
  const { connection, engine, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(user('m000', id));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  connection.api.abortFailure = new OpencodeHttpError('lost abort response', 0, 'NetworkError');
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const history = connection.api.histories.get(started.sessionId)!;
  const captured = fixture('3-empty-done')[1]!;
  for (let i = 1; i <= 7; i++) {
    const message = structuredClone(captured);
    message.info.id = `m${String(i).padStart(3, '0')}`;
    message.info.sessionID = started.sessionId;
    message.info.parentID = 'm000';
    message.info.time = { created: 1_000 + i * 100, completed: 1_050 + i * 100 };
    message.parts = message.parts.map((part, index) => ({ ...part, id: `p${i}_${index}`, sessionID: started.sessionId,
      messageID: message.info.id }));
    history.push(message);
  }
  connection.api.emit('/repo', { type: 'message.updated', properties: { sessionID: started.sessionId,
    info: history.at(-1)!.info } });
  await advance(clock, 1_500);
  const lost = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(lost.executionState, 'unknown');
  const seen: Array<RequestOptions | undefined> = [];
  const original = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }, req?: RequestOptions) => {
    seen.push(req);
    return original(id, opts);
  };
  // finish()'s abort-marker freshness guard (turn.ts) requires the earlier ambiguous abort marker
  // to age past 60s before new evidence can settle it — see the "lost abort response…" test above.
  clock.tick(60_100);
  await flush();
  history.push({ info: { id: 'm009', sessionID: started.sessionId, role: 'assistant', parentID: 'm000',
    time: { created: 3_000, completed: 3_001 }, error: { name: 'MessageAbortedError' } }, parts: [] });
  connection.api.statuses.delete(started.sessionId);
  const recovered = await engine.status({ sessionId: started.sessionId }, ctx());
  assert.equal(recovered.executionState, 'stopped');
  assert.ok(seen.length > 0);
  for (const req of seen) assert.equal(typeof req?.deadlineAt, 'number');
});
