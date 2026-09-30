import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeApi } from '../../src/opencode/http.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test('sessionDiff encodes messageID on the directory-free session route', async () => {
  let seen: URL | undefined;
  const api = createOpencodeApi({ baseUrl: 'http://example.test/', username: 'opencode',
    requestTimeoutMs: 1000, logger,
    fetch: (async (input: URL | RequestInfo) => {
      seen = new URL(String(input));
      return new Response(JSON.stringify([{ file: 'a', additions: 1, deletions: 0, status: 'renamed' }]),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  assert.deepEqual(await api.sessionDiff('ses/a', 'm &/1', { timeoutMs: 1000, maxBytes: 1024 }),
    [{ file: 'a', additions: 1, deletions: 0 }]);
  assert.equal(seen?.pathname, '/session/ses%2Fa/diff');
  assert.equal(seen?.searchParams.get('messageID'), 'm &/1');
  assert.equal(seen?.searchParams.has('directory'), false);
});

test('sessionDiff rejects oversized streaming body before parsing and malformed items', async () => {
  let pulls = 0;
  const api = createOpencodeApi({ baseUrl: 'http://example.test/', username: 'opencode',
    requestTimeoutMs: 1000, logger,
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(128)));
      },
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(api.sessionDiff('ses', 'm', { timeoutMs: 1000, maxBytes: 256 }),
    { errorName: 'ResponseTooLarge' });
  assert.ok(pulls <= 4, `read ${pulls} streaming chunks after the byte cap`);

  const malformed = createOpencodeApi({ baseUrl: 'http://example.test/', username: 'opencode',
    requestTimeoutMs: 1000, logger,
    fetch: (async () => new Response('[{"additions":-1,"deletions":0}]',
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(malformed.sessionDiff('ses', 'm', { timeoutMs: 1000, maxBytes: 1024 }),
    { errorName: 'ProtocolError' });
});
