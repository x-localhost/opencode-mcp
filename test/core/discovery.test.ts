import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogCache, pageItems, projectAgents, projectModels } from '../../src/core/discovery.ts';

const provider = {
  all: [
    { id: 'fake', models: {
      'fake-model': { id: 'fake-model', status: 'active', capabilities: { toolcall: true } },
      'open/model': { id: 'open/model', status: 'active' },
      old: { id: 'old', status: 'deprecated' },
    } },
    { id: 'offline', models: { hidden: { id: 'hidden' } } },
  ],
  default: { fake: 'fake-model' }, connected: ['fake'],
};

test('projects connected active models through the allowlist', () => {
  assert.deepEqual(projectModels(provider), { items: [
    { model: 'fake/fake-model', providerId: 'fake', modelId: 'fake-model',
      defaultForProvider: true, toolcall: true },
    { model: 'fake/open/model', providerId: 'fake', modelId: 'open/model',
      defaultForProvider: false },
  ], dropped: 0 });
  assert.equal(projectModels(provider, { provider: 'fake' }).items.length, 2);
  const hostile = {
    ...provider,
    all: [
      {
        id: 'fake',
        name: 'SENTINEL-SECRET-123',
        env: { token: 'SENTINEL-SECRET-123' },
        models: {
          'fake-model': {
            id: 'fake-model',
            status: 'active',
            capabilities: { toolcall: true },
            options: { apiKey: 'SENTINEL-SECRET-123' },
            headers: { secret: 'SENTINEL-SECRET-123' },
          },
        },
      },
    ],
  };
  assert.equal(projectModels(hostile).items.length, 1);
  assert.equal(JSON.stringify(projectModels(hostile)).includes('SENTINEL-SECRET-123'), false);
});

test('malformed model shapes drop unusable entries without throwing', () => {
  assert.equal(projectModels({ all: [], default: {}, connected: ['bad/'] }).dropped, 1);
  assert.equal(projectModels({ all: [{ id: 'bad\n', models: {} }], default: {},
    connected: ['bad\n'] }).dropped, 2);
  assert.equal(projectModels({ all: [{ id: 'x'.repeat(201), models: {} }], default: {},
    connected: ['x'.repeat(201)] }).dropped, 2);
  assert.equal(projectModels({ all: [{ id: 'x', models: { ['m'.repeat(201)]: {} } }],
    default: {}, connected: ['x'] }).dropped, 1);
  assert.equal(projectModels({ all: [{ id: 'x', models: [] }], default: {},
    connected: ['x'] }).dropped, 1);
  assert.deepEqual(projectModels({ all: [], default: {}, connected: 'fake' }), { items: [], dropped: 0 });
  assert.deepEqual(projectModels(null), { items: [], dropped: 0 });
});

test('projects visible primary and all agents only', () => {
  const result = projectAgents([
    { name: 'zeta', mode: 'all', prompt: 'SENTINEL-SECRET-123', options: {}, permission: {} },
    { name: 'hidden', mode: 'primary', hidden: true },
    { name: 'sub', mode: 'subagent' },
    { name: 'alpha', mode: 'primary' },
  ]);
  assert.deepEqual(result, {
    items: [{ name: 'alpha', mode: 'primary' }, { name: 'zeta', mode: 'all' }], dropped: 1,
  });
  assert.equal(JSON.stringify(result).includes('SENTINEL-SECRET-123'), false);
  assert.equal(projectAgents({}).dropped, 0);
});

test('catalog snapshots expire, replace, invalidate, and obey byte limits', () => {
  let now = 0;
  const clock = { monotonicNow: () => now, wallNow: () => 123 };
  const cache = new CatalogCache(clock, { ttlMs: 10, maxBytes: 145 });
  const first = cache.put('a:one', ['x']);
  assert.equal(first.observedAt, 123);
  assert.deepEqual(cache.current('a:one'), first);
  assert.deepEqual(cache.byId('a:one', first.snapshotId), first);
  const second = cache.put('a:one', ['y']);
  assert.equal(cache.byId('a:one', first.snapshotId), undefined);
  assert.deepEqual(cache.byId('a:one', second.snapshotId), second);
  cache.put('b:two', ['z']);
  assert.equal(cache.current('a:one'), undefined);
  assert.ok(cache.put('oversize', ['x'.repeat(100)]));
  assert.equal(cache.current('oversize'), undefined);
  now = 11;
  assert.equal(cache.current('b:two'), undefined);
  cache.put('prefix:item', []);
  cache.invalidate('prefix:');
  assert.equal(cache.current('prefix:item'), undefined);
});

test('catalog snapshots detach and freeze input and returned item arrays', () => {
  let now = 0;
  const cache = new CatalogCache({ monotonicNow: () => now, wallNow: () => 123 },
    { ttlMs: 10, maxBytes: 300 });
  const input = [{ name: 'x' }];
  const stored = cache.put('key', input);
  input[0]!.name = 'changed';
  input.push({ name: 'y' });
  assert.deepEqual(cache.current<typeof input[number]>('key')?.items, [{ name: 'x' }]);
  try {
    (stored.items[0] as { name: string }).name = 'changed-again';
    stored.items.push({ name: 'z' });
  } catch { /* Frozen in strict mode. */ }
  const read = cache.byId<typeof input[number]>('key', stored.snapshotId);
  assert.deepEqual(read?.items, [{ name: 'x' }]);
  assert.equal(cache.put('other', ['12345']).snapshotId, 'catalog-2');
  assert.equal(cache.current('key')?.snapshotId, stored.snapshotId);
});

test('put globally sweeps expired entries and retains dropped count in the snapshot', () => {
  let now = 0;
  const cache = new CatalogCache({ monotonicNow: () => now, wallNow: () => now },
    { ttlMs: 10, maxBytes: 300 });
  assert.equal(cache.put('first', [], 7).dropped, 7);
  now = 11;
  cache.put('second', [], 2);
  const internals = cache as unknown as { snapshots: Map<string, unknown> };
  assert.equal(internals.snapshots.has('first'), false);
  assert.equal(cache.current('second')?.dropped, 2);
});

test('catalog budget charges key and entry overhead', () => {
  const cache = new CatalogCache({ monotonicNow: () => 0, wallNow: () => 0 },
    { maxBytes: 150 });
  cache.put('x'.repeat(200), []);
  assert.equal(cache.current('x'.repeat(200)), undefined);
  cache.put('short', []);
  assert.ok(cache.current('short'));
});

test('pages arrays and rejects invalid bounds', () => {
  assert.deepEqual(pageItems([1, 2, 3], 1, 1), {
    items: [2], offset: 1, nextOffset: 2, total: 3, hasMore: true,
  });
  assert.deepEqual(pageItems([1], 1, 1), {
    items: [], offset: 1, nextOffset: null, total: 1, hasMore: false,
  });
  const source = [1, 2];
  const page = pageItems(source, 0, 1);
  page.items.push(3);
  assert.deepEqual(source, [1, 2]);
  for (const [offset, limit] of [[-1, 1], [0, 0], [0.5, 1], [0, 1.5], [2, 1]]) {
    assert.throws(() => pageItems([1], offset, limit), { name: 'TypeError', message: /^INVALID_ARGUMENT:/ });
  }
});
