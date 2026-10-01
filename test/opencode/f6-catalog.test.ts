import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeApi } from '../../src/opencode/http.ts';
import { PROVIDER_CATALOG_MAX_BYTES } from '../../src/opencode/http.ts';
import { OpencodeHttpError } from '../../src/types.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
function apiFor(body: string | string[], lengths: number[] = []) {
  const bodies = Array.isArray(body) ? body : [body];
  const calls: string[] = [];
  const api = createOpencodeApi({ baseUrl: 'http://localhost:9', username: 'test',
    requestTimeoutMs: 1000, logger, fetch: (async (input) => {
      calls.push(String(input));
      const responseBody = bodies[Math.min(calls.length - 1, bodies.length - 1)]!;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= responseBody.length) { controller.close(); return; }
        const size = lengths.shift() ?? responseBody.length;
        controller.enqueue(new TextEncoder().encode(responseBody.slice(offset, offset + size)));
        offset += size;
      } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch });
  return { api, calls };
}

test('catalog fetchers use directory query and parse JSON', async () => {
  const { api, calls } = apiFor('{"connected":[],"all":[],"default":{}}');
  assert.deepEqual(await api.providerCatalog('/a b', { timeoutMs: 1000, maxBytes: 1024 }),
    { connected: [], all: [], default: {} });
  assert.deepEqual(await api.agentCatalog('/a b', { timeoutMs: 1000, maxBytes: 1024 }),
    { connected: [], all: [], default: {} });
  assert.match(calls[0]!, /provider\?directory=%2Fa(?:\+|%20)b/);
  assert.match(calls[1]!, /agent\?directory=%2Fa(?:\+|%20)b/);
});

test('catalog fetch rejects over cap while streaming', async () => {
  const { api } = apiFor('"' + 'a'.repeat(200) + '"', [20, 20, 200]);
  await assert.rejects(api.providerCatalog('/repo', { timeoutMs: 1000, maxBytes: 32 }),
    (error: unknown) => error instanceof OpencodeHttpError && error.errorName === 'ResponseTooLarge');
});

test('provider catalog accepts bodies above 2 MiB and rejects bodies above 32 MiB', async () => {
  const acceptedBody = '"' + 'a'.repeat(2 * 1024 * 1024) + '"';
  const accepted = apiFor(acceptedBody);
  assert.equal((await accepted.api.providerCatalog('/repo', {
    timeoutMs: 1000, maxBytes: PROVIDER_CATALOG_MAX_BYTES,
  }) as string).length, acceptedBody.length - 2);

  const rejectedBody = '"' + 'a'.repeat(PROVIDER_CATALOG_MAX_BYTES) + '"';
  const rejected = apiFor(rejectedBody);
  await assert.rejects(rejected.api.providerCatalog('/repo', {
    timeoutMs: 1000, maxBytes: PROVIDER_CATALOG_MAX_BYTES,
  }), (error: unknown) => error instanceof OpencodeHttpError && error.errorName === 'ResponseTooLarge');
});

test('directory warm-up accepts provider catalogs above 2 MiB', async () => {
  const { api } = apiFor(['"' + 'a'.repeat(2 * 1024 * 1024) + '"', '{}'], [1024, 2 * 1024 * 1024]);
  await api.warmInstance('/repo');
});

test('directory warm-up still caps provider bodies at 32 MiB and agent bodies at 2 MiB', async () => {
  const provider = apiFor('"' + 'a'.repeat(PROVIDER_CATALOG_MAX_BYTES) + '"');
  await assert.rejects(provider.api.warmInstance('/repo'),
    (error: unknown) => error instanceof OpencodeHttpError && error.errorName === 'ResponseTooLarge');
  const agent = apiFor(['{}', '"' + 'a'.repeat(2 * 1024 * 1024) + '"']);
  await assert.rejects(agent.api.warmInstance('/repo'),
    (error: unknown) => error instanceof OpencodeHttpError && error.errorName === 'ResponseTooLarge');
});
