import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import type { CallContext, Config } from '../../src/types.ts';
import { OpencodeHttpError } from '../../src/types.ts';

const config = { defaultCwd: '/repo', allowedRoots: ['/repo', '/another'], remotePaths: true,
  mode: 'attach', defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60000, maxTurnTimeoutMs: 60000, approvalTimeoutMs: 1000,
  heartbeatMs: 100, statusPollMs: 100, sseStallMs: 1000, cleanupTimeoutMs: 500,
  maxOutputChars: 300, endAction: 'delete', onExit: 'abort' } as Config;
const ctx = (): CallContext => ({ signal: new AbortController().signal });
function setup() {
  const connection = new FakeConnection(); const clock = new FakeClock();
  const engine = createEngine({ config, connection, clock, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { engine, connection, clock };
}

test('server info does not acquire and rejects pagination', async () => {
  const { engine, connection } = setup();
  let acquisitions = 0;
  const acquire = connection.acquire.bind(connection);
  connection.acquire = async (req) => { acquisitions++; return acquire(req); };
  const result = await engine.info({ section: 'server' }, ctx());
  assert.equal(result.server?.connectionState, 'not_started');
  assert.equal(result.server?.sandboxEnforcement, 'permission-profile');
  assert.equal(acquisitions, 0);
  await assert.rejects(engine.info({ section: 'server', offset: 0 }, ctx()), { code: 'INVALID_ARGUMENT' });
});

test('allowlisted model/agent projection, snapshot paging, and stale continuation', async () => {
  const { engine, connection } = setup();
  connection.api.providerCatalog = async () => ({ connected: ['safe'], default: { safe: 'a' },
    all: [{ id: 'safe', apiKey: 'SECRET', models: { a: { status: 'active', apiKey: 'SECRET' },
      b: { status: 'active', options: { apiKey: 'SECRET' } } } }] });
  connection.api.agentCatalog = async () => [{ name: 'primary', mode: 'primary', prompt: 'SECRET' },
    { name: 'hidden', mode: 'primary', hidden: true, prompt: 'SECRET' }];
  const first = await engine.info({ section: 'models', limit: 1 }, ctx());
  assert.equal(first.models?.length, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(JSON.stringify(first).includes('SECRET'), false);
  const second = await engine.info({ section: 'models', offset: 1, limit: 1, snapshotId: first.snapshotId }, ctx());
  assert.equal(second.models?.length, 1);
  await assert.rejects(engine.info({ section: 'models', offset: 1, limit: 1 }, ctx()), { code: 'SNAPSHOT_EXPIRED' });
  const agents = await engine.info({ section: 'agents' }, ctx());
  assert.deepEqual(agents.agents, [{ name: 'primary', mode: 'primary' }]);
  assert.equal(JSON.stringify(agents).includes('SECRET'), false);
});

test('roots page exact paths and require snapshot for continuation', async () => {
  const { engine } = setup();
  const first = await engine.info({ section: 'roots', limit: 1 }, ctx());
  assert.deepEqual(first.roots, ['/repo']);
  const second = await engine.info({ section: 'roots', limit: 1, offset: 1, snapshotId: first.snapshotId }, ctx());
  assert.deepEqual(second.roots, ['/another']);
  await assert.rejects(engine.info({ section: 'roots', limit: 1, offset: 1, snapshotId: 'stale' }, ctx()), { code: 'SNAPSHOT_EXPIRED' });
});

test('generation loss invalidates catalog snapshots', async () => {
  const { engine, connection } = setup();
  connection.api.providerResponse = { connected: ['p'], default: {}, all: [{ id: 'p', models: {
    a: { status: 'active' }, b: { status: 'active' } } }] };
  const first = await engine.info({ section: 'models', limit: 1 }, ctx());
  connection.unavailable('exited');
  await assert.rejects(engine.info({ section: 'models', limit: 1, offset: 1, snapshotId: first.snapshotId }, ctx()),
    { code: 'SNAPSHOT_EXPIRED' });
});

test('oversize catalog error is mapped without raw response contents', async () => {
  const { engine, connection } = setup();
  connection.api.providerCatalog = async () => {
    throw new OpencodeHttpError('SECRET response exceeds cap', 200, 'ResponseTooLarge');
  };
  await assert.rejects(engine.info({ section: 'models' }, ctx()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'UPSTREAM_RESPONSE_TOO_LARGE');
    assert.equal(error.message.includes('SECRET'), false);
    return true;
  });
});

test('discovery acquisition failures do not expose upstream diagnostics', async () => {
  const { engine, connection } = setup();
  connection.acquire = async () => { throw new Error('token=SECRET-CREDENTIAL'); };
  await assert.rejects(engine.info({ section: 'models' }, ctx()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('SECRET-CREDENTIAL'), false);
    return true;
  });
});

test('provider filter has a bounded printable identifier', async () => {
  const { engine } = setup();
  for (const provider of ['x'.repeat(201), 'bad\nprovider'])
    await assert.rejects(engine.info({ section: 'models', provider }, ctx()), { code: 'INVALID_ARGUMENT' });
});

test('provider filters share one bounded unfiltered catalog snapshot', async () => {
  const { engine, connection } = setup();
  connection.api.providerResponse = { connected: ['a', 'b'], default: {}, all: [
    { id: 'a', models: { x: { status: 'active' } } },
    { id: 'b', models: { y: { status: 'active' } } },
  ] };
  const a = await engine.info({ section: 'models', provider: 'a' }, ctx());
  const b = await engine.info({ section: 'models', provider: 'b' }, ctx());
  assert.equal(a.snapshotId, b.snapshotId);
  assert.deepEqual(a.models?.map((item) => item.providerId), ['a']);
  assert.deepEqual(b.models?.map((item) => item.providerId), ['b']);
  assert.equal(connection.api.calls.filter((call) => call.method === 'providerCatalog').length, 1);
});
