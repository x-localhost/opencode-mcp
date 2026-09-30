import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import type { CallContext, Config, OcMessage, PromptBody } from '../../src/types.ts';
import { OpencodeHttpError } from '../../src/types.ts';

const config = {
  defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000, approvalTimeoutMs: 1000,
  heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000, cleanupTimeoutMs: 500,
  maxOutputChars: 300, endAction: 'delete', onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const engine = createEngine({ config: { ...config, ...overrides }, connection, clock, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { engine, connection, clock };
}
function message(sessionID: string, id: string, role: 'user' | 'assistant', text = '', parentID?: string, tools = 0): OcMessage {
  return {
    info: { id, sessionID, role, ...(parentID ? { parentID, finish: 'stop' } : {}), time: { created: 1, ...(parentID ? { completed: 2 } : {}) } },
    parts: [
      ...(text ? [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text }] : []),
      ...Array.from({ length: tools }, (_, i) => ({ id: `t${i}`, sessionID, messageID: id, type: 'tool', callID: `c${i}`, tool: `tool${i}`, state: { status: 'completed' as const, title: `title${i}` } })),
    ],
  };
}
function completeOnPrompt(connection: FakeConnection, answer: string, tools = 0) {
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const n = history.length + 1;
    const user = `m${String(n).padStart(3, '0')}`;
    const assistant = `m${String(n + 1).padStart(3, '0')}`;
    history.push(message(id, user, 'user'), message(id, assistant, 'assistant', answer, user, tools));
    connection.api.statuses.delete(id);
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
}

test('retains the full answer and every tool call across replies; end drops output', async () => {
  const { engine, connection } = setup();
  const answer = 'a'.repeat(255) + '😀' + 'b'.repeat(800);
  completeOnPrompt(connection, answer, 25);
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.status, 'completed');
  assert.ok(first.content.length <= 300);
  assert.equal(first.output?.state, 'retained');
  let reconstructed = '';
  let offset = 0;
  for (;;) {
    const page = await engine.output({ sessionId: first.sessionId, turn: 1, limit: 256, offset }, ctx());
    reconstructed += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(reconstructed, answer);
  const tools = await engine.output({ sessionId: first.sessionId, turn: 1, section: 'tool-calls' }, ctx());
  assert.equal(tools.total, 25);
  assert.equal(tools.toolCalls?.length, 20);
  completeOnPrompt(connection, 'second');
  await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  assert.equal((await engine.output({ sessionId: first.sessionId, turn: 1 }, ctx())).total, answer.length);
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 3 }, ctx()), { code: 'TURN_NOT_FOUND' });
  await engine.end({ sessionId: first.sessionId }, ctx());
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 1 }, ctx()), { code: 'SESSION_NOT_FOUND' });
});

test('schema validation precedes mutation and applies only to its own turn', async () => {
  const { engine, connection } = setup();
  await assert.rejects(engine.start({ prompt: 'x', outputSchema: { type: 'object' } }, ctx()), { code: 'INVALID_OUTPUT_SCHEMA' });
  assert.equal(connection.api.calls.filter((c) => ['createSession', 'promptAsync'].includes(c.method)).length, 0);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  completeOnPrompt(connection, '```json\n{"ok":true}\n```');
  const first = await engine.start({ prompt: 'x', outputSchema: schema, requestId: 'structured-replay' }, ctx());
  assert.equal(first.structuredOutputStatus, 'valid');
  assert.deepEqual(first.structuredOutput, { ok: true });
  assert.equal((await engine.output({ sessionId: first.sessionId, turn: 1, section: 'structured-output' }, ctx())).content,
    '{"ok":true}');
  const firstBody = connection.api.calls.find((c) => c.method === 'promptAsync')!.args[1] as PromptBody;
  assert.match(firstBody.system ?? '', /Schema:/);
  assert.equal('format' in firstBody, false);
  assert.equal('tools' in firstBody, false);
  const promptCount = connection.api.calls.filter((c) => c.method === 'promptAsync').length;
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'invalid', outputSchema: { type: 'object' } }, ctx()),
    { code: 'INVALID_OUTPUT_SCHEMA' });
  assert.equal(connection.api.calls.filter((c) => c.method === 'promptAsync').length, promptCount);
  completeOnPrompt(connection, 'plain');
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'y' }, ctx());
  const replay = await engine.start({ prompt: 'x', outputSchema: schema, requestId: 'structured-replay' }, ctx());
  assert.equal(replay.turnId, first.turnId);
  assert.equal(replay.structuredOutput, undefined);
  assert.equal(replay.structuredOutputStatus, 'valid');
  assert.equal(second.structuredOutputStatus, undefined);
  const secondBody = connection.api.calls.filter((c) => c.method === 'promptAsync')[1]!.args[1] as PromptBody;
  assert.doesNotMatch(secondBody.system ?? '', /Schema:/);
  assert.equal('format' in secondBody, false);
  assert.equal('tools' in secondBody, false);
});

test('running output is pending; cancelled and unknown turns retain partial artifacts', async () => {
  const { engine, connection, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message(id, 'm001', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const running = await engine.start({ prompt: 'long', waitSeconds: 0 }, ctx());
  assert.equal(running.output?.state, 'pending');
  await assert.rejects(engine.output({ sessionId: running.sessionId, turn: 1 }, ctx()), { code: 'OUTPUT_NOT_READY' });
  connection.api.histories.get(running.sessionId)!.push(message(running.sessionId, 'm002', 'assistant', 'partial', 'm001'));
  const cancelled = await engine.cancel({ sessionId: running.sessionId }, ctx());
  assert.equal(cancelled.output?.partial, true);
  assert.equal((await engine.output({ sessionId: running.sessionId, turn: 1 }, ctx())).content, 'partial');

  const second = setup();
  second.connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const pending = second.engine.start({ prompt: 'unknown' }, ctx());
  for (let i = 0; i < 40; i++) await Promise.resolve();
  second.clock.tick(500);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  second.clock.tick(500);
  const unknown = await pending;
  assert.equal(unknown.executionState, 'unknown');
  assert.equal(unknown.output?.partial, true);
  assert.equal((await second.engine.output({ sessionId: unknown.sessionId, turn: 1 }, ctx())).partial, true);
  void clock;
});

test('structured missing and invalid results do not change completed status', async () => {
  const { engine, connection } = setup();
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  completeOnPrompt(connection, 'ordinary text');
  const missing = await engine.start({ prompt: 'x', outputSchema: schema }, ctx());
  assert.equal(missing.status, 'completed');
  assert.equal(missing.structuredOutputStatus, 'missing');
  assert.equal(missing.structuredOutputError?.code, 'JSON_MISSING');
  completeOnPrompt(connection, '{"ok":"wrong"}');
  const invalid = await engine.reply({ sessionId: missing.sessionId, prompt: 'y', outputSchema: schema }, ctx());
  assert.equal(invalid.status, 'completed');
  assert.equal(invalid.structuredOutputStatus, 'invalid');
  assert.equal(invalid.structuredOutputError?.code, 'SCHEMA_MISMATCH');
  assert.equal(invalid.structuredOutput, undefined);
  const valid = await engine.output({ sessionId: missing.sessionId, turn: 1 }, ctx());
  assert.equal(valid.content, 'ordinary text');
});

test('diff anchors to the submitted user, freezes pages, and failures leave reply admission open', async () => {
  const { engine, connection, clock } = setup();
  completeOnPrompt(connection, 'done');
  const first = await engine.start({ prompt: 'x' }, ctx());
  connection.api.diffItems = Array.from({ length: 55 }, (_, i) => ({ file: `f${i}`, additions: i, deletions: 0, patch: `patch${i}` }));
  const page = await engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff' }, ctx());
  assert.equal(page.diff?.sourceMessageId, 'm001');
  assert.equal(page.diff?.files?.length, 50);
  assert.equal(connection.api.calls.find((c) => c.method === 'sessionDiff')?.args[1], 'm001');
  const id = page.diff!.snapshotId;
  connection.api.diffItems = [];
  const continued = await engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff', offset: 50, snapshotId: id }, ctx());
  assert.equal(continued.diff?.files?.length, 5);
  assert.equal(connection.api.calls.filter((c) => c.method === 'sessionDiff').length, 1);
  const patch = await engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff', diffView: 'patch', fileIndex: 0, snapshotId: id, limit: 256 }, ctx());
  assert.equal(patch.content, 'patch0');
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff', snapshotId: 'stale' }, ctx()), { code: 'SNAPSHOT_EXPIRED' });
  clock.tick(5 * 60_000);
  const refreshed = await engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff' }, ctx());
  assert.notEqual(refreshed.diff?.snapshotId, id);
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff', snapshotId: id }, ctx()),
    { code: 'SNAPSHOT_EXPIRED' });
  completeOnPrompt(connection, 'second');
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'y' }, ctx());
  assert.equal(second.status, 'completed');
  connection.api.diffFailure = new OpencodeHttpError('bad diff', 500, 'ProtocolError');
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 2, section: 'diff' }, ctx()), { code: 'UPSTREAM_ERROR' });
  connection.api.diffFailure = new OpencodeHttpError('large', 200, 'ResponseTooLarge');
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 2, section: 'diff' }, ctx()), { code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
  connection.api.diffFailure = undefined;
  completeOnPrompt(connection, 'third');
  assert.equal((await engine.reply({ sessionId: first.sessionId, prompt: 'z' }, ctx())).status, 'completed');
  const before = connection.api.calls.filter((c) => c.method === 'sessionDiff').length;
  await Promise.all([
    engine.output({ sessionId: first.sessionId, turn: 3, section: 'diff' }, ctx()),
    engine.output({ sessionId: first.sessionId, turn: 3, section: 'diff' }, ctx()),
  ]);
  assert.equal(connection.api.calls.filter((c) => c.method === 'sessionDiff').length, before + 1);
});

test('diff fetched across newer admission is discarded', async () => {
  const { engine, connection } = setup();
  completeOnPrompt(connection, 'first');
  const first = await engine.start({ prompt: 'first' }, ctx());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetching = false;
  connection.api.sessionDiff = async () => { fetching = true; await gate; return []; };
  const diff = engine.output({ sessionId: first.sessionId, turn: 1, section: 'diff' }, ctx());
  for (let i = 0; i < 40 && !fetching; i++) await Promise.resolve();
  assert.equal(fetching, true);
  completeOnPrompt(connection, 'second');
  await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  release();
  await assert.rejects(diff, { code: 'OUTPUT_NOT_READY' });
});

test('text output rejects a server cap below 256 while item output remains readable', async () => {
  const { engine, connection } = setup({ maxOutputChars: 255 });
  completeOnPrompt(connection, 'hello', 1);
  const turn = await engine.start({ prompt: 'x' }, ctx());
  await assert.rejects(engine.output({ sessionId: turn.sessionId, turn: 1 }, ctx()), { code: 'OUTPUT_LIMIT_TOO_SMALL' });
  assert.equal((await engine.output({ sessionId: turn.sessionId, turn: 1, section: 'tool-calls' }, ctx())).total, 1);
});

test('timeout retains a partial output artifact', async () => {
  const { engine, connection, clock } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message(id, 'm001', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const running = await engine.start({ prompt: 'slow', waitSeconds: 0 }, ctx());
  clock.tick(60000);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const stopped = await engine.status({ sessionId: running.sessionId }, ctx());
  assert.equal(stopped.status, 'timeout');
  assert.equal(stopped.output?.partial, true);
  assert.equal((await engine.output({ sessionId: running.sessionId, turn: 1 }, ctx())).partial, true);
});

test('expired and oversized artifacts report OUTPUT_UNAVAILABLE with a reason', async () => {
  const { engine, connection, clock } = setup();
  completeOnPrompt(connection, 'short');
  const first = await engine.start({ prompt: 'x' }, ctx());
  clock.tick(3_600_000);
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 1 }, ctx()),
    (error: unknown) => { assert.equal((error as { code: string }).code, 'OUTPUT_UNAVAILABLE'); assert.match((error as Error).message, /expired/); return true; });
  completeOnPrompt(connection, 'x'.repeat(4 * 1024 * 1024 + 1));
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'y' }, ctx());
  assert.equal(second.output?.state, 'unavailable');
  assert.equal(second.output?.reason, 'too_large');
  await assert.rejects(engine.output({ sessionId: first.sessionId, turn: 2 }, ctx()),
    (error: unknown) => { assert.equal((error as { code: string }).code, 'OUTPUT_UNAVAILABLE'); assert.match((error as Error).message, /too_large/); return true; });
});
