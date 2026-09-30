import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = {
  mode: 'attach', defaultCwd: '/repo', allowedRoots: ['/repo'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1_000, requestTimeoutMs: 100, turnTimeoutMs: 3_600_000,
  maxTurnTimeoutMs: 3_600_000, approvalTimeoutMs: 500, heartbeatMs: 50,
  statusPollMs: 100, sseStallMs: 1_000, cleanupTimeoutMs: 2_000,
  maxOutputChars: 2_000, endAction: 'delete', onExit: 'abort',
} as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
const outage = new OpencodeHttpError('offline', 0, 'NetworkError');
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function advance(clock: FakeClock, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(25); await flush(); }
}
function setup(mode: 'attach' | 'managed' = 'attach') {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const engine = createEngine({
    config: { ...config, mode }, connection, clock,
    logger: { debug() {}, info() {}, error() {}, warn(message, fields) { warnings.push({ message, fields }); } },
  });
  return { connection, clock, engine, warnings };
}

test('U09 ambiguous network read failures stay degraded, then cancel on the same lease', async () => {
  const { connection, clock, engine, warnings } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
    connection.api.histories.get(id)?.push({
      info: { id: 'm1', sessionID: id, role: 'user', time: { created: 1 } }, parts: [],
    });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  assert.equal(started.status, 'running');
  const originalMessages = connection.api.messages.bind(connection.api);
  connection.api.messages = async () => { throw outage; };
  connection.api.listPermissions = async () => { throw outage; };
  connection.api.health = async () => { throw outage; };
  await advance(clock, 350);
  const failed = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(failed.status, 'running');
  assert.equal(failed.upstreamRead?.state, 'degraded');
  assert.equal(failed.executionState, 'active');
  assert.equal(connection.generation, 1);
  assert.ok(warnings.some((w) => /upstream|request|reconcile/i.test(w.message)));
  connection.api.messages = originalMessages;
  connection.api.listPermissions = async () => [];
  connection.api.health = async () => ({ healthy: true, version: 'v1' });
  const cancelling = engine.cancel({ sessionId: started.sessionId }, ctx());
  await flush();
  await advance(clock, 250);
  const cancelled = await cancelling;
  assert.equal(cancelled.executionState, 'stopped');
});

test('U09 managed timeouts keep the live child and turn', async () => {
  const { connection, clock, engine } = setup('managed');
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const timedOut = new OpencodeHttpError('Timed out', 0, 'TimeoutError');
  connection.api.messages = async () => { throw timedOut; };
  connection.api.listPermissions = async () => { throw timedOut; };
  connection.api.health = async () => { throw timedOut; };
  await advance(clock, 350);
  const failed = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(failed.status, 'running');
  assert.equal(failed.upstreamRead?.reason, 'timeout');
  assert.equal(failed.executionState, 'active');
  assert.equal(connection.generation, 1);
});

test('U09 a soft network failure does not start hard-failure probes', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  connection.api.messages = async () => { throw outage; };
  connection.api.listPermissions = async () => { throw outage; };
  let probes = 0;
  connection.api.health = async () => { probes++; return { healthy: true, version: 'v1' }; };
  await advance(clock, 350);
  const status = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.status, 'running');
  assert.equal(connection.generation, 1);
  assert.equal(probes, 0);
});

test('U09 unreachable attach does not repair an unknown mutation into stopped', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = outage;
  const pending = engine.start({ prompt: 'ambiguous' }, ctx());
  await flush();
  await advance(clock, 250);
  const first = await pending;
  assert.equal(first.executionState, 'unknown');
  await connection.invalidate(1, 'unreachable');
  const after = await engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(after.executionState, 'unknown');
  assert.equal(connection.generation, 2);
});

test('U09 a successful request cancels an older failed health probe', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => { connection.api.statuses.set(id, { type: 'busy' }); };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  const messages = connection.api.messages.bind(connection.api);
  const listPermissions = connection.api.listPermissions.bind(connection.api);
  const hard = new OpencodeHttpError('connect ECONNREFUSED', 0, 'NetworkError');
  connection.api.messages = async () => { throw hard; };
  connection.api.listPermissions = async () => { throw hard; };
  let rejectProbe = (_error: Error) => {};
  connection.api.health = () => new Promise<{ healthy: boolean; version: string }>((_resolve, reject) => { rejectProbe = reject; });
  await advance(clock, 300);
  connection.api.messages = messages;
  connection.api.listPermissions = listPermissions;
  await advance(clock, 100);
  rejectProbe(hard);
  await flush();
  assert.equal(connection.generation, 1);
  assert.equal((await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx())).status, 'running');
});
