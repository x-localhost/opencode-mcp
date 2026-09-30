import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeApi } from '../../src/opencode/http.ts';
import { OpencodeHttpError } from '../../src/types.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
function apiFor(body: string, lengths: number[] = [body.length]) {
  const calls: string[] = [];
  const api = createOpencodeApi({ baseUrl: 'http://localhost:9', username: 'test',
    requestTimeoutMs: 1000, logger, fetch: (async (input) => {
      calls.push(String(input));
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= body.length) { controller.close(); return; }
        const size = lengths.shift() ?? body.length;
        controller.enqueue(new TextEncoder().encode(body.slice(offset, offset + size)));
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

test('directory warm-up also caps streamed catalog bodies', async () => {
  const { api } = apiFor('"' + 'a'.repeat(2 * 1024 * 1024) + '"', [1024, 2 * 1024 * 1024]);
  await assert.rejects(api.warmInstance('/repo'),
    (error: unknown) => error instanceof OpencodeHttpError && error.errorName === 'ResponseTooLarge');
});
