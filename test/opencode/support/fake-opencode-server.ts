// A tiny in-process node:http fake of the OpenCode v1 HTTP API, for testing src/opencode/http.ts
// and src/opencode/sse.ts's real usage inside subscribe(). Covers just enough of the real API
// (docs/research/opencode-api.md §4-§7) to exercise createOpencodeApi: auth, the two error-body
// families, 404s, pagination headers, redirects, a controllable slow/hang endpoint, and a
// scriptable SSE stream. Zero third-party dependencies.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { OcEvent, OcMessage, OcPermissionRequest, OcQuestionRequest, OcSession, OcSessionStatus } from '../../../src/types.ts';

export type Override =
  | 'none'
  | 'redirect'
  | 'html'
  | 'slow'
  | 'hang'
  | 'stall-body'
  | 'stall-body-error'
  | 'huge-body'
  | 'huge-error-body';

export interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  /** Parsed JSON request body, when this request's handler reads one. */
  body?: unknown;
}

export interface FakeOpencodeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** `directory` query values seen by GET /provider, in call order. */
  providerCalls: string[];
  /** `directory` query values seen by GET /agent, in call order. */
  agentCalls: string[];
  /** `directory` query values seen by POST /instance/dispose, in call order. */
  disposeCalls: string[];
  setOverride(kind: Override, opts?: { slowMs?: number; bytes?: number }): void;
  createSessionDirect(session: OcSession): void;
  setMessages(sessionId: string, messages: OcMessage[]): void;
  /** A11: one-shot override for the `id` the next POST /session response reports, so a test can
   * simulate a malformed/adversarial upstream session id without the fake server's own id
   * generation getting in the way. Cleared after the next createSession call. */
  setNextSessionId(id: string): void;
  /** FZ #2: one-shot override for the ENTIRE next POST /session response body (still 200, still
   * application/json), so a test can simulate an unusable body (e.g. literal `null`) that a
   * well-formed session never has. Cleared after the next createSession call. */
  setNextSessionBody(body: unknown): void;
  setDiff(sessionId: string, body: unknown): void;
  setPermissions(list: OcPermissionRequest[]): void;
  setQuestions(list: OcQuestionRequest[]): void;
  setSessionStatus(status: Record<string, OcSessionStatus>): void;
  setSseScript(events: OcEvent[]): void;
  setSseCloseAfterScript(close: boolean): void;
  sseConnectionCount(): number;
  closeAllSse(): void;
  waitForStalledErrorBody(): Promise<void>;
  close(): Promise<void>;
}

interface CreateOpts {
  username?: string;
  password?: string;
  version?: string;
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(text);
}

function legacyError(res: ServerResponse, status: number, name: string, message: string): void {
  send(res, status, { name, data: { message } });
}

function effectError(res: ServerResponse, status: number, tag: string, message: string, extra?: Record<string, unknown>): void {
  send(res, status, { _tag: tag, message, ...extra });
}

export async function createFakeOpencodeServer(opts: CreateOpts = {}): Promise<FakeOpencodeServer> {
  const sessions = new Map<string, OcSession>();
  const messages = new Map<string, OcMessage[]>();
  const diffs = new Map<string, unknown>();
  let permissions: OcPermissionRequest[] = [];
  let questions: OcQuestionRequest[] = [];
  let sessionStatus: Record<string, OcSessionStatus> = {};
  let override: Override = 'none';
  let overrideSlowMs = 0;
  let overrideBytes = 0;
  let nextSessionId: string | undefined;
  let nextSessionBody: { value: unknown } | undefined;
  let sseScript: OcEvent[] = [];
  let sseCloseAfterScript = true;
  const sseConnections = new Set<ServerResponse>();
  const requests: RecordedRequest[] = [];
  const providerCalls: string[] = [];
  const agentCalls: string[] = [];
  const disposeCalls: string[] = [];
  let idCounter = 0;
  let resolveStalledErrorBody: () => void = () => {};
  const stalledErrorBodyStarted = new Promise<void>((resolve) => {
    resolveStalledErrorBody = resolve;
  });

  const version = opts.version ?? '1.18.33-fake';

  function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}_fake${idCounter}`;
  }

  function checkAuth(req: IncomingMessage): boolean {
    if (opts.password === undefined) {
      return true;
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      return false;
    }
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
    const expectedUser = opts.username ?? 'opencode';
    return decoded === `${expectedUser}:${opts.password}`;
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function handleEvent(res: ServerResponse, hasDirectory: boolean): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sseConnections.add(res);
    res.on('close', () => sseConnections.delete(res));
    // Instance scoping (docs/research/gaps.md G2): without `directory`, the real server accepts
    // the connection but the client's own directory instance never publishes events to it, so it
    // sees none of the scripted events.
    if (hasDirectory) {
      for (const evt of sseScript) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    }
    if (sseCloseAfterScript) {
      res.end();
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://internal');
      const recorded: RecordedRequest = { method, url: req.url ?? '/', authorization: req.headers.authorization };
      requests.push(recorded);
      const hasDirectory = (url.searchParams.get('directory') ?? '') !== '';

      if (!checkAuth(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
        res.end();
        return;
      }

      if (override === 'redirect') {
        override = 'none';
        res.writeHead(302, { location: '/session' });
        res.end();
        return;
      }
      if (override === 'html') {
        override = 'none';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body>opencode web ui</body></html>');
        return;
      }
      if (override === 'hang') {
        override = 'none';
        return; // never respond; caller relies on its own timeout/abort
      }
      if (override === 'stall-body') {
        override = 'none';
        // Sends valid 200 JSON headers, then writes a truncated body and never ends the response:
        // reproduces a server that answers headers promptly but then stalls streaming the body.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"healthy":true,"vers');
        return;
      }
      if (override === 'huge-body') {
        override = 'none';
        // A well-formed, but oversized, 2xx JSON body — reproduces an upstream response that
        // exceeds the client's own streaming byte cap on an ordinary (non-error) response.
        const padding = 'x'.repeat(overrideBytes || 9 * 1024 * 1024);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: padding }));
        return;
      }
      if (override === 'huge-error-body') {
        override = 'none';
        // A well-formed, but oversized, non-2xx JSON error body — reproduces an upstream error
        // response that exceeds the client's own (smaller) error-body byte cap.
        const padding = 'x'.repeat(overrideBytes || 128 * 1024);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'UnknownError', data: { message: padding } }));
        return;
      }
      if (override === 'stall-body-error') {
        override = 'none';
        // Same as 'stall-body' but for the non-2xx (errorFromResponse) body-read path.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.write('{"name":"Unkno');
        resolveStalledErrorBody();
        return;
      }
      if (override === 'slow') {
        override = 'none';
        const ms = overrideSlowMs;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          t.unref?.();
        });
      }

      const parts = url.pathname.split('/').filter(Boolean);

      try {
        if (method === 'GET' && url.pathname === '/global/health') {
          send(res, 200, { healthy: true, version });
          return;
        }

        if (method === 'GET' && url.pathname === '/event') {
          handleEvent(res, hasDirectory);
          return;
        }

        if (method === 'GET' && url.pathname === '/session/status') {
          // Instance scoping (gaps.md G2): without `directory` the real server returned `{}`.
          send(res, 200, hasDirectory ? sessionStatus : {});
          return;
        }

        if (method === 'GET' && url.pathname === '/provider') {
          providerCalls.push(url.searchParams.get('directory') ?? '');
          send(res, 200, { all: [], default: {}, connected: [] });
          return;
        }

        if (method === 'GET' && url.pathname === '/agent') {
          agentCalls.push(url.searchParams.get('directory') ?? '');
          send(res, 200, []);
          return;
        }

        if (method === 'POST' && url.pathname === '/instance/dispose') {
          disposeCalls.push(url.searchParams.get('directory') ?? '');
          send(res, 200, true);
          return;
        }

        if (method === 'GET' && url.pathname === '/permission') {
          // Instance scoping (gaps.md G2): without `directory`, the real server returned 0 items.
          send(res, 200, hasDirectory ? permissions : []);
          return;
        }

        if (method === 'POST' && parts[0] === 'permission' && parts[2] === 'reply') {
          const requestId = parts[1] ?? '';
          const body = (await readBody(req)) as { reply?: string; message?: string };
          recorded.body = body;
          // Instance scoping (gaps.md G2): without `directory`, the real server 404s here.
          if (!hasDirectory) {
            effectError(res, 404, 'PermissionNotFoundError', `Permission not found: ${requestId}`, { requestID: requestId });
            return;
          }
          const validReply = body?.reply === 'once' || body?.reply === 'always' || body?.reply === 'reject';
          const validMessage = body?.message === undefined || typeof body.message === 'string';
          const validKeys = Object.keys(body ?? {}).every((k) => k === 'reply' || k === 'message');
          if (!validReply || !validMessage || !validKeys) {
            legacyError(res, 400, 'BadRequest', 'Expected {reply: "once"|"always"|"reject", message?: string}');
            return;
          }
          const idx = permissions.findIndex((p) => p.id === requestId);
          if (idx === -1) {
            effectError(res, 404, 'PermissionNotFoundError', `Permission not found: ${requestId}`, { requestID: requestId });
            return;
          }
          permissions = permissions.filter((p) => p.id !== requestId);
          send(res, 200, true);
          return;
        }

        if (method === 'GET' && url.pathname === '/question') {
          // Instance scoping (gaps.md G2): without `directory`, the real server returned 0 items.
          send(res, 200, hasDirectory ? questions : []);
          return;
        }

        if (method === 'POST' && parts[0] === 'question' && parts[2] === 'reject') {
          const requestId = parts[1] ?? '';
          // Instance scoping (gaps.md G2): without `directory`, the real server 404s here.
          if (!hasDirectory) {
            effectError(res, 404, 'QuestionNotFoundError', `Question not found: ${requestId}`);
            return;
          }
          const idx = questions.findIndex((q) => q.id === requestId);
          if (idx === -1) {
            effectError(res, 404, 'QuestionNotFoundError', `Question not found: ${requestId}`);
            return;
          }
          questions = questions.filter((q) => q.id !== requestId);
          send(res, 200, true);
          return;
        }

        if (method === 'POST' && url.pathname === '/session') {
          const body = (await readBody(req)) as { title?: string; permission?: unknown };
          recorded.body = body;
          if (nextSessionBody) {
            const overrideBody = nextSessionBody.value;
            nextSessionBody = undefined;
            send(res, 200, overrideBody);
            return;
          }
          const id = nextSessionId ?? nextId('ses');
          nextSessionId = undefined;
          const now = Date.now();
          const session: OcSession = {
            id,
            directory: url.searchParams.get('directory') ?? '/work/proj',
            title: body?.title ?? '',
            time: { created: now, updated: now },
          };
          sessions.set(id, session);
          messages.set(id, []);
          send(res, 200, session);
          return;
        }

        if (parts[0] === 'session' && parts.length >= 2) {
          const sessionId = parts[1];
          const session = sessions.get(sessionId);

          if (parts.length === 3 && parts[2] === 'diff' && method === 'GET') {
            if (!session) { legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`); return; }
            send(res, 200, diffs.get(sessionId) ?? []);
            return;
          }

          if (parts.length === 2 && method === 'GET') {
            if (!session) {
              legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`);
              return;
            }
            send(res, 200, session);
            return;
          }

          if (parts.length === 2 && method === 'DELETE') {
            if (!session) {
              legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`);
              return;
            }
            sessions.delete(sessionId);
            messages.delete(sessionId);
            send(res, 200, true);
            return;
          }

          if (parts.length === 2 && method === 'PATCH') {
            if (!session) {
              legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`);
              return;
            }
            const body = (await readBody(req)) as { title?: string; time?: { archived?: number } };
            recorded.body = body;
            if (body?.title !== undefined) {
              session.title = body.title;
            }
            if (body?.time?.archived !== undefined) {
              session.time.archived = body.time.archived;
            }
            session.time.updated = Date.now();
            send(res, 200, session);
            return;
          }

          if (parts.length === 3 && parts[2] === 'prompt_async' && method === 'POST') {
            if (!session) {
              legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`);
              return;
            }
            const body = (await readBody(req)) as { parts?: unknown };
            recorded.body = body;
            if (!body || !Array.isArray(body.parts)) {
              legacyError(res, 400, 'BadRequest', 'Expected array at ["parts"]');
              return;
            }
            res.writeHead(204);
            res.end();
            return;
          }

          if (parts.length === 3 && parts[2] === 'abort' && method === 'POST') {
            send(res, 200, true);
            return;
          }

          if (parts.length === 3 && parts[2] === 'message' && method === 'GET') {
            if (!session) {
              legacyError(res, 404, 'NotFoundError', `Session not found: ${sessionId}`);
              return;
            }
            const all = messages.get(sessionId) ?? [];
            const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : all.length;
            const before = url.searchParams.get('before');
            let endIdx = all.length;
            if (before) {
              const idx = all.findIndex((m) => m.info.id === before);
              endIdx = idx === -1 ? all.length : idx;
            }
            const startIdx = Math.max(0, endIdx - limit);
            const page = all.slice(startIdx, endIdx);
            const headers: Record<string, string> = {};
            if (startIdx > 0) {
              headers['x-next-cursor'] = all[startIdx]!.info.id;
            }
            send(res, 200, page, headers);
            return;
          }
        }

        legacyError(res, 404, 'NotFoundError', `Route not found: ${method} ${url.pathname}`);
      } catch (err) {
        legacyError(res, 500, 'UnknownError', `fake server error: ${(err as Error).message}`);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake opencode server failed to bind');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    providerCalls,
    agentCalls,
    disposeCalls,
    setOverride(kind, o) {
      override = kind;
      overrideSlowMs = o?.slowMs ?? 0;
      overrideBytes = o?.bytes ?? 0;
    },
    createSessionDirect(session) {
      sessions.set(session.id, session);
      if (!messages.has(session.id)) {
        messages.set(session.id, []);
      }
    },
    setMessages(sessionId, list) {
      messages.set(sessionId, list);
    },
    setNextSessionId(id) {
      nextSessionId = id;
    },
    setNextSessionBody(body) {
      nextSessionBody = { value: body };
    },
    setDiff(sessionId, body) { diffs.set(sessionId, body); },
    setPermissions(list) {
      permissions = list;
    },
    setQuestions(list) {
      questions = list;
    },
    setSessionStatus(status) {
      sessionStatus = status;
    },
    setSseScript(events) {
      sseScript = events;
    },
    setSseCloseAfterScript(close) {
      sseCloseAfterScript = close;
    },
    sseConnectionCount() {
      return sseConnections.size;
    },
    closeAllSse() {
      for (const res of sseConnections) {
        res.end();
      }
    },
    waitForStalledErrorBody() {
      return stalledErrorBodyStarted;
    },
    close() {
      for (const res of sseConnections) {
        res.end();
      }
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
