import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpencodeApi, createOpencodeApiWithRetry } from '../../src/opencode/http.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import { createFakeOpencodeServer } from './support/fake-opencode-server.ts';

import type { Logger, OcEvent, PermissionRule } from '../../src/types.ts';
import type { FakeOpencodeServer } from './support/fake-opencode-server.ts';

function nullLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function oversizedJsonResponse(): Response {
  const bytes = new Uint8Array(32 * 1024 * 1024 + 1);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('FY-1 unit: message retry keeps before and takes the smaller response cursor', async () => {
  const seen: Array<{ limit: string | null; before: string | null }> = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const limit = url.searchParams.get('limit');
    seen.push({ limit, before: url.searchParams.get('before') });
    if (limit === '100') return oversizedJsonResponse();
    return new Response(
      JSON.stringify([{ info: { id: 'msg_25', sessionID: 'session', role: 'user', time: { created: 25 } }, parts: [] }]),
      { status: 200, headers: { 'content-type': 'application/json', 'x-next-cursor': 'msg_25' } },
    );
  };
  const api = createOpencodeApi({ baseUrl: 'http://127.0.0.1:1', username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger(), fetch: fakeFetch });
  const page = await api.messages('session', { limit: 100, before: 'msg_101' });
  assert.equal(page.items[0]?.info.id, 'msg_25');
  assert.equal(page.nextCursor, 'msg_25');
  assert.deepEqual(seen, [
    { limit: '100', before: 'msg_101' },
    { limit: '25', before: 'msg_101' },
  ]);
});

test('FY-1 unit: all oversized message limits reach 1 before ResponseTooLarge', async () => {
  const limits: Array<string | null> = [];
  const fakeFetch: typeof fetch = async (input) => {
    limits.push(new URL(String(input)).searchParams.get('limit'));
    return oversizedJsonResponse();
  };
  const api = createOpencodeApi({ baseUrl: 'http://127.0.0.1:1', username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger(), fetch: fakeFetch });
  await assert.rejects(api.messages('session', { limit: 100 }), { errorName: 'ResponseTooLarge' });
  assert.deepEqual(limits, ['100', '25', '5', '1']);
});

async function withServer(
  serverOpts: Parameters<typeof createFakeOpencodeServer>[0],
  fn: (server: FakeOpencodeServer) => Promise<void>,
): Promise<void> {
  const server = await createFakeOpencodeServer(serverOpts);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('health() returns healthy + version on 2xx JSON', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const result = await api.health();
    assert.deepEqual(result, { healthy: true, version: '1.18.33-fake' });
  });
});

test('sends HTTP Basic auth when password is set, and never sends it when unset', async () => {
  await withServer({ username: 'mcp', password: 'sekrit' }, async (server) => {
    const api = createOpencodeApi({
      baseUrl: server.baseUrl,
      username: 'mcp',
      password: 'sekrit',
      requestTimeoutMs: 2000,
      logger: nullLogger(),
    });
    await api.health();
    const seen = server.requests.at(-1)?.authorization;
    assert.ok(seen?.startsWith('Basic '));
    const decoded = Buffer.from(seen!.slice('Basic '.length), 'base64').toString('utf-8');
    assert.equal(decoded, 'mcp:sekrit');
  });

  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    await api.health();
    assert.equal(server.requests.at(-1)?.authorization, undefined);
  });
});

test('missing/wrong auth against a password-protected server yields a 401 mapped error', async () => {
  await withServer({ username: 'opencode', password: 'right' }, async (server) => {
    const api = createOpencodeApi({
      baseUrl: server.baseUrl,
      username: 'opencode',
      password: 'wrong',
      requestTimeoutMs: 2000,
      logger: nullLogger(),
    });
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 401);
      return true;
    });
  });
});

test('createSession posts title/permission and returns the created session', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const rules: PermissionRule[] = [
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'ask' },
    ];
    const session = await api.createSession('/work/proj', { title: 'my task', permission: rules });
    assert.equal(session.title, 'my task');
    assert.equal(session.directory, '/work/proj');
    assert.ok(session.id.startsWith('ses_'));
    const body = server.requests.at(-1)?.body as { permission?: unknown } | undefined;
    assert.deepEqual(body?.permission, rules);
  });
});

// ---------------------------------------------------------------------------
// A11: upstream identifier validation (createSession)
// ---------------------------------------------------------------------------

test('A11: createSession rejects an empty upstream session id as UPSTREAM_ERROR before returning it', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionId('');
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.notEqual(err.errorName, 'ResponseTooLarge');
      assert.equal(err.status, 200, 'the HTTP response itself was a 2xx; only its body was malformed');
      assert.doesNotMatch(err.message, /^$/);
      return true;
    });
  });
});

test('A11: createSession rejects an oversized (>200 char) upstream session id', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionId('x'.repeat(201));
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      return true;
    });
  });
});

test('A11: createSession rejects an upstream session id containing a control character (not printable)', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionId('ses_ok\u0000tail');
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), OpencodeHttpError);
  });
});

test('A11: createSession rejects an upstream session id containing a path separator', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionId('../etc/passwd');
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), OpencodeHttpError);
    server.setNextSessionId('ses\\1');
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), OpencodeHttpError);
  });
});

test('A11: createSession accepts a well-formed upstream session id unchanged', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionId('ses_perfectly_fine-1.2:3');
    const session = await api.createSession('/work/proj', { title: 't' });
    assert.equal(session.id, 'ses_perfectly_fine-1.2:3');
  });
});

// ---------------------------------------------------------------------------
// FZ #2: a 200 response with an unusable body (not just a malformed id) must never be dereferenced
// ---------------------------------------------------------------------------

test('FZ #2: createSession maps a 200 response body of literal null to ProtocolError, not a raw TypeError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionBody(null);
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'ProtocolError');
      assert.equal(err.status, 200, 'the HTTP response itself was a 2xx; only its body was unusable');
      assert.doesNotMatch(err.message, /^$/);
      return true;
    });
  });
});

test('FZ #2: createSession maps a 200 response body that is a non-object (array) to ProtocolError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setNextSessionBody([]);
    await assert.rejects(api.createSession('/work/proj', { title: 't' }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'ProtocolError');
      assert.equal(err.status, 200);
      return true;
    });
  });
});

test('directory query values are URL-encoded', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    await api.createSession('/work/needs encoding/&x=1', { title: 't' });
    const seen = server.requests.at(-1)?.url ?? '';
    // URLSearchParams uses application/x-www-form-urlencoded ('+' for space), which OpenCode's
    // server (and every standard query-string parser) decodes back to a literal space.
    assert.ok(seen.includes('directory=%2Fwork%2Fneeds+encoding%2F%26x%3D1'), seen);
    const decoded = new URL(`http://x${seen}`).searchParams.get('directory');
    assert.equal(decoded, '/work/needs encoding/&x=1');
  });
});

test('getSession returns null on 404 and the session otherwise', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    assert.equal(await api.getSession('ses_missing'), null);
    const created = await api.createSession('/work/proj', { title: 't' });
    const fetched = await api.getSession(created.id);
    assert.equal(fetched?.id, created.id);
  });
});

test('promptAsync resolves on 204 and its wire body never carries tools/messageID', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const parts = [{ type: 'text' as const, text: 'hi' }];
    await api.promptAsync(session.id, { parts });
    const body = server.requests.at(-1)?.body as Record<string, unknown> | undefined;
    assert.ok(body, 'expected a recorded prompt_async body');
    assert.deepEqual(body?.parts, parts);
    assert.ok(!('tools' in (body ?? {})), 'wire body must never carry tools');
    assert.ok(!('messageID' in (body ?? {})), 'wire body must never carry messageID');
  });
});

test('promptAsync on a missing session maps the legacy 404 NotFoundError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    await assert.rejects(
      () => api.promptAsync('ses_missing', { parts: [{ type: 'text', text: 'hi' }] }),
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.status, 404);
        assert.equal(err.errorName, 'NotFoundError');
        assert.match(err.message, /Session not found/);
        return true;
      },
    );
  });
});

test('sessionDiff uses encoded messageID without directory and validates the response', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    server.setDiff(session.id, [{ file: 'a.ts', additions: 2, deletions: 1, patch: 'diff', status: 'modified' }]);
    assert.deepEqual(await api.sessionDiff(session.id, 'm &/1', { timeoutMs: 2000, maxBytes: 1024 }),
      [{ file: 'a.ts', additions: 2, deletions: 1, patch: 'diff', status: 'modified' }]);
    const seen = new URL(server.requests.at(-1)!.url, 'http://fake');
    assert.equal(seen.searchParams.get('messageID'), 'm &/1');
    assert.equal(seen.searchParams.has('directory'), false);
    server.setDiff(session.id, [{ additions: -1, deletions: 0 }]);
    await assert.rejects(api.sessionDiff(session.id, 'm', { timeoutMs: 2000, maxBytes: 1024 }),
      { errorName: 'ProtocolError' });
  });
});

test('sessionDiff caps bytes during streaming before JSON parsing', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    server.setDiff(session.id, [{ additions: 0, deletions: 0, patch: 'x'.repeat(10000) }]);
    await assert.rejects(api.sessionDiff(session.id, 'm', { timeoutMs: 2000, maxBytes: 256 }),
      { errorName: 'ResponseTooLarge' });
  });
});

test('A6: an ordinary (2xx) JSON response over the default byte cap is rejected as ResponseTooLarge, not buffered in full', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('huge-body');
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'ResponseTooLarge');
      return true;
    });
  });
});

test('FY-1: an oversized 100-message page retries at 25 and returns that page and its cursor', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 10000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const padding = 'x'.repeat(340 * 1024);
    server.setMessages(session.id, Array.from({ length: 101 }, (_, i) => ({
      info: { id: `msg_${i}`, sessionID: session.id, role: 'user' as const, time: { created: i } },
      parts: [{ id: `prt_${i}`, sessionID: session.id, messageID: `msg_${i}`, type: 'text' as const, text: padding }],
    })));
    const page = await api.messages(session.id, { limit: 100 });
    assert.equal(page.items.length, 25);
    assert.equal(page.items[0]?.info.id, 'msg_76');
    assert.equal(page.nextCursor, 'msg_76');
    const limits = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limits, ['100', '25']);
    const older = await api.messages(session.id, { limit: 25, before: page.nextCursor });
    assert.equal(older.items[0]?.info.id, 'msg_51');
    assert.equal(older.nextCursor, 'msg_51');
  });
});

test('FY-1: a single message beyond the page cap still throws ResponseTooLarge', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 10000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    server.setMessages(session.id, [{
      info: { id: 'msg_huge', sessionID: session.id, role: 'user', time: { created: 1 } },
      parts: [{ id: 'prt_huge', sessionID: session.id, messageID: 'msg_huge', type: 'text', text: 'x'.repeat(33 * 1024 * 1024) }],
    }]);
    await assert.rejects(() => api.messages(session.id, { limit: 100 }), { errorName: 'ResponseTooLarge' });
    const limits = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limits, ['100', '25', '5', '1']);
  });
});

test('A6: a non-2xx error body over the (smaller) error-body byte cap is rejected as ResponseTooLarge, not truncated-and-parsed', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('huge-error-body');
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'ResponseTooLarge');
      return true;
    });
  });
});

test('A6: an error body just under the error-body byte cap still parses normally (the cap does not clip legitimate error bodies)', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    // 32 KiB of padding is comfortably inside a 64 KiB error-body cap, while still exercising the
    // streaming reader across multiple chunks.
    server.setOverride('huge-error-body', { bytes: 32 * 1024 });
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 500);
      assert.equal(err.errorName, 'UnknownError');
      return true;
    });
  });
});

test('promptAsync on a 400 BadRequest maps the legacy error family', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    await assert.rejects(
      // @ts-expect-error -- intentionally malformed body to trigger the fake server's 400 path
      () => api.promptAsync(session.id, { parts: 'not-an-array' }),
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.status, 400);
        assert.equal(err.errorName, 'BadRequest');
        return true;
      },
    );
  });
});

test('abort returns the boolean body', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    assert.equal(await api.abort(session.id), true);
  });
});

test('deleteSession returns false on 404 and true when it existed', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    assert.equal(await api.deleteSession('ses_missing'), false);
    const session = await api.createSession('/work/proj', { title: 't' });
    assert.equal(await api.deleteSession(session.id), true);
    assert.equal(await api.getSession(session.id), null);
  });
});

test('archiveSession PATCHes time.archived and returns the updated session', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const archived = await api.archiveSession(session.id, 12345);
    assert.equal(archived.time.archived, 12345);
  });
});

test('messages() paginates using X-Next-Cursor', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const all = Array.from({ length: 5 }, (_, i) => ({
      info: { id: `msg_${i}`, sessionID: session.id, role: 'user' as const, time: { created: i } },
      parts: [],
    }));
    server.setMessages(session.id, all);

    const page1 = await api.messages(session.id, { limit: 2 });
    assert.deepEqual(
      page1.items.map((m) => m.info.id),
      ['msg_3', 'msg_4'],
    );
    assert.equal(page1.nextCursor, 'msg_3');

    const page2 = await api.messages(session.id, { limit: 2, before: page1.nextCursor });
    assert.deepEqual(
      page2.items.map((m) => m.info.id),
      ['msg_1', 'msg_2'],
    );
    assert.equal(page2.nextCursor, 'msg_1');

    const page3 = await api.messages(session.id, { limit: 2, before: page2.nextCursor });
    assert.deepEqual(
      page3.items.map((m) => m.info.id),
      ['msg_0'],
    );
    assert.equal(page3.nextCursor, undefined);
  });
});

test('sessionStatus/listPermissions/listQuestions return the configured lists', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setSessionStatus({ ses_1: { type: 'busy' } });
    server.setPermissions([
      { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['*'], metadata: {}, always: ['*'] },
    ]);
    server.setQuestions([{ id: 'que_1', sessionID: 'ses_1', questions: [] }]);

    assert.deepEqual(await api.sessionStatus('/work/proj'), { ses_1: { type: 'busy' } });
    const perms = await api.listPermissions('/work/proj');
    assert.equal(perms.length, 1);
    assert.equal(perms[0]?.id, 'per_1');
    const questions = await api.listQuestions('/work/proj');
    assert.equal(questions.length, 1);
  });
});

test('replyPermission returns false on 404 PermissionNotFoundError (already resolved)', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    assert.equal(await api.replyPermission('/work/proj', 'per_missing', 'reject'), false);
  });
});

test('replyPermission returns true and clears the pending request on success', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setPermissions([
      { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['*'], metadata: {}, always: ['*'] },
    ]);
    assert.equal(await api.replyPermission('/work/proj', 'per_1', 'once'), true);
    assert.deepEqual(await api.listPermissions('/work/proj'), []);
  });
});

test('replyPermission posts exactly {reply, message?} with no extra keys', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setPermissions([
      { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['*'], metadata: {}, always: ['*'] },
      { id: 'per_2', sessionID: 'ses_1', permission: 'edit', patterns: ['*'], metadata: {}, always: ['*'] },
    ]);
    assert.equal(await api.replyPermission('/work/proj', 'per_1', 'reject', 'why'), true);
    assert.deepEqual(server.requests.at(-1)?.body, { reply: 'reject', message: 'why' });
    assert.equal(await api.replyPermission('/work/proj', 'per_2', 'once'), true);
    assert.deepEqual(server.requests.at(-1)?.body, { reply: 'once' });
  });
});

test('rejectQuestion returns false on 404 and true on success', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    assert.equal(await api.rejectQuestion('/work/proj', 'que_missing'), false);
    server.setQuestions([{ id: 'que_1', sessionID: 'ses_1', questions: [] }]);
    assert.equal(await api.rejectQuestion('/work/proj', 'que_1'), true);
  });
});

test('warmInstance() GETs /provider then /agent with the directory, and resolves with the parsed /provider body', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const result = await api.warmInstance('/work/proj');
    assert.deepEqual(server.providerCalls, ['/work/proj']);
    assert.deepEqual(server.agentCalls, ['/work/proj']);
    assert.deepEqual(result, { providerCatalog: { all: [], default: {}, connected: [] } });
  });
});

test('warmInstance() rejects with a mapped OpencodeHttpError if either endpoint fails', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 50, logger: nullLogger() });
    server.setOverride('hang');
    await assert.rejects(() => api.warmInstance('/work/proj'), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    });
  });
});

test('disposeInstance() POSTs /instance/dispose with the directory and returns the boolean body', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    const result = await api.disposeInstance('/work/proj');
    assert.equal(result, true);
    assert.deepEqual(server.disposeCalls, ['/work/proj']);
  });
});

test('a redirect response is rejected as RedirectError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setOverride('redirect');
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 0);
      assert.equal(err.errorName, 'RedirectError');
      return true;
    });
  });
});

test('a 200 HTML response where JSON is expected is a ProtocolError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setOverride('html');
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'ProtocolError');
      return true;
    });
  });
});

test('a slow endpoint past the per-call timeout is a TimeoutError, distinct from AbortError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 50, logger: nullLogger() });
    server.setOverride('slow', { slowMs: 500 });
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 0);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    });
  });
});

test('per-call timeoutMs override takes precedence over the configured default', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('slow', { slowMs: 200 });
    await assert.rejects(() => api.health({ timeoutMs: 30 }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    });
  });
});

test('a response that sends headers then stalls the body still times out (deadline covers body reads too)', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 100, logger: nullLogger() });
    server.setOverride('stall-body');
    const startedAt = Date.now();
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 0);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `expected the body-stall to be caught by requestTimeoutMs=100, took ${elapsed}ms`);
  });
});

test('a non-2xx response that stalls its error body also surfaces as TimeoutError, not an empty error message', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 100, logger: nullLogger() });
    server.setOverride('stall-body-error');
    const startedAt = Date.now();
    await assert.rejects(() => api.health(), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'TimeoutError');
      return true;
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `expected the error-body stall to be caught by requestTimeoutMs=100, took ${elapsed}ms`);
  });
});

test('caller-provided AbortSignal cancels the request with AbortError, not TimeoutError', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => api.health({ signal: controller.signal }), (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 0);
      assert.equal(err.errorName, 'AbortError');
      return true;
    });
  });
});

test('a network error (server unreachable) is a NetworkError with status 0', async () => {
  const api = createOpencodeApi({
    baseUrl: 'http://127.0.0.1:1', // reserved/forbidden port: connection is refused immediately
    username: 'opencode',
    requestTimeoutMs: 2000,
    logger: nullLogger(),
  });
  await assert.rejects(() => api.health(), (err: unknown) => {
    assert.ok(err instanceof OpencodeHttpError);
    assert.equal(err.status, 0);
    assert.equal(err.errorName, 'NetworkError');
    return true;
  });
});

test('recorded URLs carry directory= for every instance-scoped call', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    await api.sessionStatus('/work/proj');
    await api.listPermissions('/work/proj');
    await api.replyPermission('/work/proj', 'per_missing', 'reject');
    await api.listQuestions('/work/proj');
    await api.rejectQuestion('/work/proj', 'que_missing');

    server.setSseScript([{ id: 'evt_1', type: 'server.connected', properties: {} }]);
    server.setSseCloseAfterScript(true);
    const controller = new AbortController();
    for await (const _evt of api.subscribe('/work/proj', controller.signal)) {
      // drain until the fake ends the scripted stream
    }

    const scopedPaths = [
      '/session/status',
      '/permission',
      '/permission/per_missing/reply',
      '/question',
      '/question/que_missing/reject',
      '/event',
    ];
    for (const path of scopedPaths) {
      const req = server.requests.find((r) => r.url.startsWith(path));
      assert.ok(req, `no recorded request for ${path}`);
      assert.ok(req!.url.includes('directory='), `${path} url missing directory=: ${req!.url}`);
    }
  });
});

test('subscribe() yields parsed events from the SSE stream, ending normally on server close', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setSseScript([
      { id: 'evt_1', type: 'server.connected', properties: {} },
      { id: 'evt_2', type: 'server.heartbeat', properties: {} },
      { id: 'evt_3', type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);
    server.setSseCloseAfterScript(true);

    const controller = new AbortController();
    const events: OcEvent[] = [];
    for await (const evt of api.subscribe('/work/proj', controller.signal)) {
      events.push(evt);
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['server.connected', 'server.heartbeat', 'session.idle'],
    );
  });
});

test('subscribe() ends the iteration without throwing when its signal is aborted', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setSseScript([{ id: 'evt_1', type: 'server.connected', properties: {} }]);
    server.setSseCloseAfterScript(false); // stays open until the client (or server) closes it

    const controller = new AbortController();
    const events: OcEvent[] = [];
    const iterate = (async () => {
      for await (const evt of api.subscribe('/work/proj', controller.signal)) {
        events.push(evt);
        controller.abort();
      }
    })();
    await iterate; // must resolve (not reject) once aborted
    assert.deepEqual(
      events.map((e) => e.type),
      ['server.connected'],
    );
  });
});

test('subscribe() throws OpencodeHttpError ProtocolError on a non-SSE (HTML) response', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
    server.setOverride('html');
    const controller = new AbortController();
    await assert.rejects(
      async () => {
        for await (const _evt of api.subscribe('/work/proj', controller.signal)) {
          // no-op
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.errorName, 'ProtocolError');
        return true;
      },
    );
  });
});

test('subscribe() against a password-protected server with the wrong password throws status 401', async () => {
  await withServer({ username: 'opencode', password: 'right' }, async (server) => {
    const api = createOpencodeApi({
      baseUrl: server.baseUrl,
      username: 'opencode',
      password: 'wrong',
      requestTimeoutMs: 2000,
      logger: nullLogger(),
    });
    const controller = new AbortController();
    await assert.rejects(
      async () => {
        for await (const _evt of api.subscribe('/work/proj', controller.signal)) {
          // no-op
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });
});

test('subscribe() ends without throwing when aborted while reading a stalled non-2xx error body', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('stall-body-error');

    const controller = new AbortController();
    const events: OcEvent[] = [];
    const iterate = (async () => {
      for await (const evt of api.subscribe('/work/proj', controller.signal)) {
        events.push(evt);
      }
    })();
    await server.waitForStalledErrorBody();
    controller.abort();
    await iterate; // must resolve (not reject) once aborted mid error-body-read
    assert.deepEqual(events, []);
  });
});

test('A6: subscribe() caps a non-2xx connect-time error body the same way as any other error body', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setOverride('huge-error-body');
    const controller = new AbortController();
    await assert.rejects(
      async () => {
        for await (const _evt of api.subscribe('/work/proj', controller.signal)) {
          // no-op
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof OpencodeHttpError);
        assert.equal(err.errorName, 'ResponseTooLarge');
        return true;
      },
    );
  });
});

test('subscribe() throws OpencodeHttpError NetworkError when the server is unreachable', async () => {
  const api = createOpencodeApi({ baseUrl: 'http://127.0.0.1:1', username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger() });
  const controller = new AbortController();
  await assert.rejects(
    async () => {
      for await (const _evt of api.subscribe('/work/proj', controller.signal)) {
        // no-op
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.errorName, 'NetworkError');
      return true;
    },
  );
});

test('subscribe() ends normally when the server closes the stream mid-script (server-side close)', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 5000, logger: nullLogger() });
    server.setSseScript([{ id: 'evt_1', type: 'server.connected', properties: {} }]);
    server.setSseCloseAfterScript(false);

    const controller = new AbortController();
    const events: OcEvent[] = [];
    const iteration = (async () => {
      for await (const evt of api.subscribe('/work/proj', controller.signal)) {
        events.push(evt);
      }
    })();

    // Give the fake server a tick to accept the connection and flush the scripted event, then
    // close it server-side (simulating `server.instance.disposed` ending the stream).
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.closeAllSse();
    await iteration;

    assert.deepEqual(
      events.map((e) => e.type),
      ['server.connected'],
    );
  });
});

// ---------------------------------------------------------------------------
// R14: sticky message-page ceiling (overload design; summarized in docs/design.md §12)
// ---------------------------------------------------------------------------

test('R14: a second poll starts at the previously successful smaller limit instead of re-walking from 100', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 10000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const padding = 'x'.repeat(340 * 1024);
    server.setMessages(session.id, Array.from({ length: 101 }, (_, i) => ({
      info: { id: `msg_${i}`, sessionID: session.id, role: 'user' as const, time: { created: i } },
      parts: [{ id: `prt_${i}`, sessionID: session.id, messageID: `msg_${i}`, type: 'text' as const, text: padding }],
    })));

    const first = await api.messages(session.id, { limit: 100 });
    assert.equal(first.items.length, 25);
    const limitsAfterFirst = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limitsAfterFirst, ['100', '25']);

    // Second poll uses the default (no explicit limit) — must start directly at the remembered
    // ceiling (25), never re-attempting 100 first (R14: "32 MB is re-downloaded on every poll").
    const second = await api.messages(session.id);
    assert.equal(second.items.length, 25);
    const limitsAfterSecond = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limitsAfterSecond, ['100', '25', '25']);
  });
});

test('R14: an explicit smaller limit is honoured even with a larger sticky ceiling remembered', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApi({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 10000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const padding = 'x'.repeat(340 * 1024);
    server.setMessages(session.id, Array.from({ length: 101 }, (_, i) => ({
      info: { id: `msg_${i}`, sessionID: session.id, role: 'user' as const, time: { created: i } },
      parts: [{ id: `prt_${i}`, sessionID: session.id, messageID: `msg_${i}`, type: 'text' as const, text: padding }],
    })));
    await api.messages(session.id, { limit: 100 }); // remembers ceiling 25
    await api.messages(session.id, { limit: 1 });
    const limits = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limits, ['100', '25', '1']);
  });
});

test('R14: forgetPageCeiling() resets a session back to the default 100-first ladder', async () => {
  await withServer({}, async (server) => {
    const api = createOpencodeApiWithRetry({ baseUrl: server.baseUrl, username: 'opencode', requestTimeoutMs: 10000, logger: nullLogger() });
    const session = await api.createSession('/work/proj', { title: 't' });
    const padding = 'x'.repeat(340 * 1024);
    server.setMessages(session.id, Array.from({ length: 101 }, (_, i) => ({
      info: { id: `msg_${i}`, sessionID: session.id, role: 'user' as const, time: { created: i } },
      parts: [{ id: `prt_${i}`, sessionID: session.id, messageID: `msg_${i}`, type: 'text' as const, text: padding }],
    })));
    await api.messages(session.id, { limit: 100 });
    api.forgetPageCeiling(session.id);
    await api.messages(session.id, { limit: 100 });
    const limits = server.requests.filter((r) => r.url.includes('/message?')).map((r) => new URL(r.url, server.baseUrl).searchParams.get('limit'));
    assert.deepEqual(limits, ['100', '25', '100', '25']);
  });
});

// ---------------------------------------------------------------------------
// Runtime shape validation (design §C: "reject non-arrays/non-objects as protocol errors instead
// of casting") — a raw fake `fetch` is used here (not the shared fake server) because these tests
// need to inject deliberately malformed bodies that the shared server's typed setters refuse.
// ---------------------------------------------------------------------------

function fakeApiWithBody(status: number, body: unknown, headers: Record<string, string> = {}): ReturnType<typeof createOpencodeApi> {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  return createOpencodeApi({ baseUrl: 'http://127.0.0.1:1', username: 'opencode', requestTimeoutMs: 2000, logger: nullLogger(), fetch: fakeFetch });
}

test('sessionStatus() rejects a non-object body as ProtocolError instead of casting', async () => {
  await assert.rejects(fakeApiWithBody(200, ['not', 'an', 'object']).sessionStatus('/work'), { errorName: 'ProtocolError' });
});

test('sessionStatus() rejects an invalid retry entry (missing attempt/message/next) as ProtocolError', async () => {
  await assert.rejects(
    fakeApiWithBody(200, { ses_1: { type: 'retry' } }).sessionStatus('/work'),
    { errorName: 'ProtocolError' },
  );
});

test('sessionStatus() rejects an unrecognized status type as ProtocolError', async () => {
  await assert.rejects(
    fakeApiWithBody(200, { ses_1: { type: 'unknown-future-type' } }).sessionStatus('/work'),
    { errorName: 'ProtocolError' },
  );
});

test('listPermissions() rejects a non-array body as ProtocolError', async () => {
  await assert.rejects(fakeApiWithBody(200, {}).listPermissions('/work'), { errorName: 'ProtocolError' });
});

test('listPermissions() rejects an entry missing required fields as ProtocolError', async () => {
  await assert.rejects(fakeApiWithBody(200, [{ id: 'per_1' }]).listPermissions('/work'), { errorName: 'ProtocolError' });
});

test('listQuestions() rejects a non-array body as ProtocolError', async () => {
  await assert.rejects(fakeApiWithBody(200, 'nope').listQuestions('/work'), { errorName: 'ProtocolError' });
});

test('listQuestions() rejects an entry missing required fields as ProtocolError', async () => {
  await assert.rejects(fakeApiWithBody(200, [{ id: 'que_1' }]).listQuestions('/work'), { errorName: 'ProtocolError' });
});

test('messages() rejects a non-array page body as ProtocolError', async () => {
  await assert.rejects(fakeApiWithBody(200, { not: 'an array' }).messages('session'), { errorName: 'ProtocolError' });
});

test('messages() rejects an entry missing info.time.created as ProtocolError', async () => {
  await assert.rejects(
    fakeApiWithBody(200, [{ info: { id: 'm1', sessionID: 's', role: 'user' }, parts: [] }]).messages('session'),
    { errorName: 'ProtocolError' },
  );
});

test('messages() rejects an entry whose parts is not an array as ProtocolError', async () => {
  await assert.rejects(
    fakeApiWithBody(200, [{ info: { id: 'm1', sessionID: 's', role: 'user', time: { created: 1 } }, parts: 'nope' }]).messages('session'),
    { errorName: 'ProtocolError' },
  );
});

// ---------------------------------------------------------------------------
// Retry-After header capture (design §C: parsed against an injected wall clock; the raw header
// string never leaves the normalization function)
// ---------------------------------------------------------------------------

test('a 429 with a delta-seconds Retry-After attaches a bounded retryAfterSeconds and an "overloaded" classification', async () => {
  await assert.rejects(
    fakeApiWithBody(429, { name: 'RateLimitError', data: { message: 'slow down' } }, { 'retry-after': '7' }).health(),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 7);
      assert.equal(err.classification, 'overloaded');
      return true;
    },
  );
});

test('a 503 with an HTTP-date Retry-After resolves against Date.now() and attaches an "overloaded" classification (502 stays "degraded")', async () => {
  const future = new Date(Date.now() + 30_000).toUTCString();
  await assert.rejects(
    fakeApiWithBody(503, { name: 'UnknownError', data: { message: 'busy' } }, { 'retry-after': future }).health(),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.ok(err.retryAfterSeconds !== undefined && err.retryAfterSeconds >= 28 && err.retryAfterSeconds <= 31, `got ${err.retryAfterSeconds}`);
      assert.equal(err.classification, 'overloaded');
      return true;
    },
  );
  await assert.rejects(
    fakeApiWithBody(502, { name: 'UnknownError', data: { message: 'bad gateway' } }).health(),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.classification, 'degraded');
      return true;
    },
  );
});

test('an invalid Retry-After header is ignored (retryAfterSeconds stays undefined; never throws)', async () => {
  await assert.rejects(
    fakeApiWithBody(503, { name: 'UnknownError', data: { message: 'busy' } }, { 'retry-after': 'not-a-valid-value' }).health(),
    (err: unknown) => {
      assert.ok(err instanceof OpencodeHttpError);
      assert.equal(err.retryAfterSeconds, undefined);
      return true;
    },
  );
});

test('malformed-shape and other non-retryable protocol errors never carry a retryAfterSeconds', async () => {
  await assert.rejects(fakeApiWithBody(200, { not: 'an array' }).messages('session'), (err: unknown) => {
    assert.ok(err instanceof OpencodeHttpError);
    assert.equal(err.classification, 'protocol');
    assert.equal(err.retryAfterSeconds, undefined);
    return true;
  });
});
