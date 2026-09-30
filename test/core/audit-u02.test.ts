import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, Logger, OcMessage, OcPart } from '../../src/types.ts';

// U02: finish() is exception-safe; result text and `truncated` reflect the actual outcome.

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
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const userMsg = (id: string): OcMessage => ({
  info: { id, sessionID: 'ses_1', role: 'user', time: { created: Number(id.slice(1)) } },
  parts: [],
});

const assistantMsg = (id: string, parentID: string, parts: OcPart[]): OcMessage => ({
  info: {
    id,
    sessionID: 'ses_1',
    role: 'assistant',
    parentID,
    finish: 'stop',
    time: { created: Number(id.slice(1)), completed: Number(id.slice(1)) + 1 },
  },
  parts,
});

function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection(),
    clock = new FakeClock();
  const engine = createEngine({ config: { ...config, ...overrides } as Config, connection, clock, logger });
  return { connection, clock, engine };
}

/** Runtime-only check (the project's ES2022 tsconfig target has no typed `isWellFormed`, but
 * Node >=20 has it at runtime): true iff `s` has no lone (unpaired) UTF-16 surrogate. */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

// ---------------------------------------------------------------------------
// (a) A malformed patch part must not leave a zombie turn: finish() stays exception-safe and
// list()/status()/cancel() keep working afterward.
// ---------------------------------------------------------------------------

for (const files of [[null], 5]) {
  test(`U02(a): a patch part with malformed files (${JSON.stringify(files)}) still resolves a terminal turn, and list/status/cancel keep working`, async () => {
    const { engine, connection } = setup();
    connection.api.onPrompt = (id) => {
      const history = connection.api.histories.get(id)!;
      history.push(
        userMsg('m1'),
        assistantMsg('m2', 'm1', [
          { id: 'p1', sessionID: 'ses_1', messageID: 'm2', type: 'patch', files: files as unknown as string[] },
          { id: 'p2', sessionID: 'ses_1', messageID: 'm2', type: 'text', text: 'ok' },
        ]),
      );
    };

    const started = await engine.start({ prompt: 'hello' }, ctx());
    assert.equal(started.status, 'completed');
    assert.equal(started.content, 'ok');

    const list = await engine.list();
    assert.equal(list.sessions.find((s) => s.sessionId === started.sessionId)?.status, 'completed');

    const status = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
    assert.equal(status.status, 'completed');

    const cancelled = await engine.cancel({ sessionId: started.sessionId }, ctx());
    assert.equal(cancelled.sessionId, started.sessionId);
    assert.equal(cancelled.status, 'completed');
  });
}

// ---------------------------------------------------------------------------
// (b) A running snapshot before any reconcile must not claim OpenCode already finished.
// ---------------------------------------------------------------------------

test('U02(b): a wait-seconds:0 start before any reconcile reports a running sentence, not the finished one', async () => {
  const { engine, connection } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(userMsg('m1'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  assert.equal(started.status, 'running');
  assert.notEqual(started.content, 'OpenCode finished without a text answer; see toolCalls/filesChanged.');
  assert.match(started.content, /still running/);
});

// ---------------------------------------------------------------------------
// (c) A submission rejected before OpenCode ran must not claim OpenCode already finished.
// ---------------------------------------------------------------------------

test('U02(c): a 4xx submission rejection reports a failed sentence naming the error, not the finished one', async () => {
  const { engine, connection } = setup();
  connection.api.promptFailure = new OpencodeHttpError('bad request', 400, 'BadRequest');
  const started = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(started.status, 'failed');
  assert.equal(started.error?.name, 'UPSTREAM_ERROR');
  assert.notEqual(started.content, 'OpenCode finished without a text answer; see toolCalls/filesChanged.');
  assert.match(started.content, /failed/);
  assert.match(started.content, /UPSTREAM_ERROR/);
});

// ---------------------------------------------------------------------------
// (d) More than 20 tool calls must set `truncated`, even when content itself is short.
// ---------------------------------------------------------------------------

test('U02(d): more than 20 tool calls sets truncated even though content is short', async () => {
  const { engine, connection } = setup();
  connection.api.onPrompt = (id) => {
    const parts: OcPart[] = Array.from({ length: 23 }, (_, i) => ({
      id: `p${i}`,
      sessionID: 'ses_1',
      messageID: 'm2',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', title: `call ${i}` },
    }));
    parts.push({ id: 'ptext', sessionID: 'ses_1', messageID: 'm2', type: 'text', text: 'ok' });
    connection.api.histories.get(id)!.push(userMsg('m1'), assistantMsg('m2', 'm1', parts));
  };
  const started = await engine.start({ prompt: 'hello' }, ctx());
  assert.equal(started.status, 'completed');
  assert.equal(started.toolCallCount, 23);
  assert.equal(started.toolCalls.length, 20);
  assert.equal(started.truncated, true);
});

// ---------------------------------------------------------------------------
// (e) Truncation must never split a surrogate pair, at either the head cut or the tail cut.
// ---------------------------------------------------------------------------

test('U02(e): truncation never splits a surrogate pair, at the head cut or the tail cut', async () => {
  const emoji = '😀'; // one astral character = one high + one low surrogate
  const cases = [
    // straddles the head cut (indices 9990/9991 for maxOutputChars=20000)
    'a'.repeat(9990) + emoji + 'b'.repeat(10009),
    // straddles the tail cut
    'a'.repeat(10010) + emoji + 'b'.repeat(9989),
  ];
  for (const text of cases) {
    assert.equal(text.length, 20001);
    const { engine, connection } = setup({ maxOutputChars: 20000 });
    connection.api.onPrompt = (id) => {
      connection.api.histories.get(id)!.push(
        userMsg('m1'),
        assistantMsg('m2', 'm1', [{ id: 'p1', sessionID: 'ses_1', messageID: 'm2', type: 'text', text }]),
      );
    };
    const started = await engine.start({ prompt: 'hello' }, ctx());
    assert.equal(started.status, 'completed');
    assert.equal(started.truncated, true);
    assert.ok(wellFormed(started.content), `content was not well-formed: ...${JSON.stringify(started.content.slice(-40))}`);
  }
});
