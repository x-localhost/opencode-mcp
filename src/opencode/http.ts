// Real HTTP client for OpenCode's v1 API (opencode-ai 1.18.33, `opencode serve`).
// Endpoints/bodies verified against docs/research/opencode-openapi-1.18.33.json and
// docs/research/opencode-api.md §4-§6 (see per-method comments for citations).

import { parseSse } from './sse.ts';
import { createRealClock, parseRetryAfterSeconds, withReadRetry } from './retry.ts';
import { validateMessagePage, validatePermissionList, validateQuestionList, validateSessionStatusMap } from './validate.ts';

import type {
  Clock,
  Logger,
  OcEvent,
  OcSession,
  OpencodeApi,
  PromptBody,
  RequestOptions,
} from '../types.ts';
import { OpencodeHttpError } from '../types.ts';

export interface CreateOpencodeApiOptions {
  baseUrl: string;
  username: string;
  password?: string;
  requestTimeoutMs: number;
  logger: Logger;
  fetch?: typeof fetch;
  /** Used to parse a `Retry-After` HTTP-date against an injected wall clock, and to schedule/bound
   * the read-retry helper's sleeps and shared deadline. Defaults to a real Clock
   * (src/opencode/retry.ts's `createRealClock`); tests inject `FakeClock`. */
  clock?: Clock;
  /** Injectable uniform-random source in [0, 1) for the read-retry helper's jitter; defaults to
   * `Math.random`. Tests can pin it for deterministic backoff assertions. */
  random?: () => number;
}

/** design §C eligible admission reads: attach health, session status, message boundary/history
 * reads, permission/question lists, and warm-up GETs. Every field the retry loop itself needs. */
export interface EligibleGetRetryOptions {
  /** Absolute monotonic-ms deadline shared by the WHOLE calling operation (admission, cleanup,
   * ...) — every attempt, sleep, and (for `messagesWithRetry`) page-size fallback rung shares it. */
  deadlineAt: number;
  /** Total attempts including the first; clamped to 1..3 (ordinarily config.readRetryAttempts). */
  maxAttempts?: number;
  signal?: AbortSignal;
}

/** `createOpencodeApiWithRetry`'s return type: every `OpencodeApi` method, plus an explicit
 * opt-in bounded-retry variant for each design §C eligible admission read, plus an explicit hook
 * to evict a session's sticky message-page-size ceiling. `createOpencodeApi` returns the exact
 * same underlying object typed as plain `OpencodeApi` (unchanged signature, for existing callers
 * like src/opencode/connection.ts). */
export interface OpencodeApiRetryable extends OpencodeApi {
  healthWithRetry(opts: EligibleGetRetryOptions): ReturnType<OpencodeApi['health']>;
  sessionStatusWithRetry(directory: string, opts: EligibleGetRetryOptions): ReturnType<OpencodeApi['sessionStatus']>;
  messagesWithRetry(
    sessionId: string,
    msgOpts: { limit?: number; before?: string } | undefined,
    opts: EligibleGetRetryOptions,
  ): ReturnType<OpencodeApi['messages']>;
  listPermissionsWithRetry(directory: string, opts: EligibleGetRetryOptions): ReturnType<OpencodeApi['listPermissions']>;
  listQuestionsWithRetry(directory: string, opts: EligibleGetRetryOptions): ReturnType<OpencodeApi['listQuestions']>;
  warmInstanceWithRetry(directory: string, opts: EligibleGetRetryOptions): ReturnType<OpencodeApi['warmInstance']>;
  /** Forgets any sticky message-page-size ceiling remembered for this session (call on session
   * end/dispose so a bounded map does not accumulate short-lived sessions forever). */
  forgetPageCeiling(sessionId: string): void;
}

type Query = Record<string, string | number | undefined>;

// A6: every response/error body this adapter reads is streamed under a byte cap — never buffered
// in full — so a misbehaving or compromised upstream cannot exhaust memory through an oversized
// body. `sessionDiff`/`providerCatalog`/`agentCatalog`/`warmInstance` already had their own
// (caller-supplied or fixed) caps; these two cover every other response this module reads.
/** Default cap for an ordinary 2xx JSON body (sessions, permission/question lists, ...). */
const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Message pages can be larger; overflow triggers a retry at a smaller item limit. */
const MAX_MESSAGE_PAGE_BYTES = 32 * 1024 * 1024;
/** Cap for a non-2xx error body. Real upstream error payloads are small (a name/tag plus a short
 * message); this is far more than any of them need. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Reads a `ReadableStream<Uint8Array>` reader as UTF-8 text, cancelling and throwing
 * OpencodeHttpError('ResponseTooLarge') the moment the cumulative byte count exceeds `maxBytes`,
 * instead of ever buffering an unbounded amount of upstream data. Shared by every body-reading
 * path in this module (ordinary bodies via `SentResponse.readBodyLimited`, and the SSE connect
 * path's own non-2xx error body, which has no `SentResponse` wrapper of its own). */
async function readReaderLimited(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  status: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OpencodeHttpError(`response exceeds ${maxBytes} bytes`, status, 'ResponseTooLarge');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Bounded text read for a raw `Response` with no `SentResponse`/timeout-guard wrapper (the SSE
 * connect path's own non-2xx error body: that fetch has no per-call requestTimeoutMs of its own,
 * see subscribeGenerator). Network/stream failures propagate as-is; the caller (buildErrorFromResponse)
 * already normalizes a non-OpencodeHttpError into a NetworkError. */
async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OpencodeHttpError('response has no body', response.status, 'ProtocolError');
  }
  try {
    return await readReaderLimited(reader, maxBytes, response.status);
  } finally {
    reader.releaseLock();
  }
}

function isRedirectError(err: unknown): boolean {
  if (!(err instanceof TypeError)) {
    return false;
  }
  const cause = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : '';
  return /redirect/i.test(err.message) || /redirect/i.test(causeMessage);
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    return causeMessage ? `network error: ${causeMessage}` : `network error: ${err.message}`;
  }
  return 'network error';
}

/** Parses the two OpenCode error body families (docs/research/opencode-api.md §4) into (errorName, message). */
function describeErrorBody(status: number, parsed: unknown): { errorName: string; message: string } {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name === 'string') {
      const data = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
      const message = typeof data?.message === 'string' ? data.message : `${obj.name} (HTTP ${status})`;
      return { errorName: obj.name, message };
    }
    if (typeof obj._tag === 'string') {
      const message = typeof obj.message === 'string' ? obj.message : `${obj._tag} (HTTP ${status})`;
      return { errorName: obj._tag, message };
    }
  }
  return { errorName: 'HttpError', message: `HTTP ${status}` };
}

/**
 * Classifies a failure from `fetchImpl(...)` or from consuming a response body under the same
 * abort signal, using the same three-way test in both places: our own timeout fired, the
 * caller's signal fired, or something else (redirect/network). Used both for the initial request
 * and for body reads, so a body that stalls past the deadline is reported the same way a stalled
 * connect would be (design.md review finding: deadlines must cover body consumption too).
 */
function classifyAbortOrNetworkFailure(
  err: unknown,
  timeoutController: AbortController,
  reqSignal: AbortSignal | undefined,
  timeoutMs: number,
): OpencodeHttpError {
  if (timeoutController.signal.aborted) {
    return new OpencodeHttpError(`request timed out after ${timeoutMs}ms`, 0, 'TimeoutError');
  }
  if (reqSignal?.aborted) {
    return new OpencodeHttpError('request aborted', 0, 'AbortError');
  }
  if (isRedirectError(err)) {
    return new OpencodeHttpError('server attempted a redirect', 0, 'RedirectError');
  }
  return new OpencodeHttpError(networkErrorMessage(err), 0, 'NetworkError');
}

/**
 * A response whose timeout/abort guard is still armed. The guard (and its underlying timer) is
 * only cleared by `release()` or by `readBodyLimited()` completing, so a caller that inspects
 * headers (status, content-type) and then reads the body is protected by the *same* deadline the
 * whole way through — clearing it right after headers arrive (the bug this fixes) would let a
 * response that sends headers and then stalls the body hang forever.
 */
interface SentResponse {
  response: Response;
  /** A6: reads the body as text under a byte cap (never in full — every caller streams under a
   * cap chosen for its own payload shape, e.g. DEFAULT_MAX_JSON_BYTES or MAX_ERROR_BODY_BYTES),
   * normalizing a timeout/abort/network failure mid-read into the same OpencodeHttpError family
   * as a failed connect, and an overflow into OpencodeHttpError('ResponseTooLarge'). Always
   * releases the guard afterwards. */
  readBodyLimited(maxBytes: number): Promise<string>;
  /** Clears the timeout guard for callers that never read a body (204s, 404 short-circuits). Idempotent. */
  release(): void;
}

function makeSentResponse(
  response: Response,
  timer: ReturnType<typeof setTimeout>,
  timeoutController: AbortController,
  reqSignal: AbortSignal | undefined,
  timeoutMs: number,
  deadlineAt: number | undefined,
  clock: Clock,
): SentResponse {
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    clearTimeout(timer);
  }
  return {
    response,
    release,
    async readBodyLimited(maxBytes: number): Promise<string> {
      const reader = response.body?.getReader();
      if (!reader) { release(); throw new OpencodeHttpError('response has no body', response.status, 'ProtocolError'); }
      try {
        const body = await readReaderLimited(reader, maxBytes, response.status);
        if (deadlineAt !== undefined && clock.monotonicNow() >= deadlineAt)
          throw new OpencodeHttpError('request deadline expired', 0, 'TimeoutError');
        return body;
      } catch (err) {
        const failure = err instanceof OpencodeHttpError ? err :
          classifyAbortOrNetworkFailure(err, timeoutController, reqSignal, timeoutMs);
        failure.responseReceived = true;
        throw failure;
      } finally { release(); reader.releaseLock(); }
    },
  };
}

/** A11: validates an upstream-returned session id before anything is tracked — non-empty, <=200
 * chars, printable (no control characters), and free of path separators. This id becomes
 * TrackedSession.id (the engine's own tracking key) and is embedded in every turn id derived from
 * it (`${session.id}#${turn}`), so a malformed one from upstream must never reach the engine.
 * Mirrors src/core/discovery.ts's own printable/bounded id check (kept local here: this adapter
 * module must not import from src/core). */
function isValidUpstreamSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(value) &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function validateDiffItems(value: unknown): Array<{ file?: string; status?: 'added' | 'deleted' | 'modified'; additions: number; deletions: number; patch?: string }> {
  if (!Array.isArray(value)) throw new OpencodeHttpError('malformed session diff response', 200, 'ProtocolError');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new OpencodeHttpError('malformed session diff item', 200, 'ProtocolError');
    const x = entry as Record<string, unknown>;
    if (typeof x.additions !== 'number' || !Number.isFinite(x.additions) || x.additions < 0 ||
        typeof x.deletions !== 'number' || !Number.isFinite(x.deletions) || x.deletions < 0 ||
        (x.file !== undefined && typeof x.file !== 'string') ||
        (x.patch !== undefined && typeof x.patch !== 'string') ||
        (x.status !== undefined && typeof x.status !== 'string'))
      throw new OpencodeHttpError('malformed session diff item', 200, 'ProtocolError');
    return {
      ...(typeof x.file === 'string' ? { file: x.file } : {}),
      ...(x.status === 'added' || x.status === 'deleted' || x.status === 'modified' ? { status: x.status } : {}),
      additions: x.additions as number, deletions: x.deletions as number,
      ...(typeof x.patch === 'string' ? { patch: x.patch } : {}),
    };
  });
}

function buildApi(opts: CreateOpencodeApiOptions): OpencodeApiRetryable {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const authHeader =
    opts.password !== undefined ? `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf-8').toString('base64')}` : undefined;
  const clock = opts.clock ?? createRealClock();
  const random = opts.random;
  // R14/design §"SSE and page-size hygiene": remembers the last successful message-page ceiling
  // per session (this api instance IS already scoped to one connection generation), so a session
  // whose pages overflow the default limit does not re-walk the 100→25→5→1 ladder (re-downloading
  // up to 32 MiB) on every subsequent poll. Never grown back up automatically (design: "Do not
  // automatically grow it again in this release"). Bounded (FIFO-evicted) so a long-lived
  // connection with many short-lived sessions cannot leak memory; also evicted with the api
  // instance itself (a fresh Map per generation) and via the explicit `forgetPageCeiling` hook.
  const stickyPageCeiling = new Map<string, number>();
  const STICKY_PAGE_CEILING_MAX_ENTRIES = 500;
  function rememberPageCeiling(sessionId: string, limit: number): void {
    stickyPageCeiling.delete(sessionId);
    stickyPageCeiling.set(sessionId, limit);
    if (stickyPageCeiling.size > STICKY_PAGE_CEILING_MAX_ENTRIES) {
      const oldest = stickyPageCeiling.keys().next().value;
      if (oldest !== undefined) stickyPageCeiling.delete(oldest);
    }
  }

  function buildUrl(path: string, query?: Query): URL {
    const url = new URL(path.replace(/^\//, ''), baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  interface SendArgs {
    method: string;
    path: string;
    query?: Query;
    body?: unknown;
    req?: RequestOptions;
    accept?: string;
  }

  /**
   * Performs one non-SSE request. Never throws for non-2xx statuses (returns the Response so
   * callers can special-case 404s); throws OpencodeHttpError for timeout/abort/network/redirect
   * failures, which have no Response to inspect. The returned guard stays armed until the caller
   * finishes reading the body (or calls `release()` if it never reads one), so `timeoutMs`/the
   * caller's signal bound the whole request, not just the time to first byte.
   */
  async function send(args: SendArgs): Promise<SentResponse> {
    const url = buildUrl(args.path, args.query);
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.authorization = authHeader;
    }
    if (args.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    headers.accept = args.accept ?? 'application/json';

    const remaining = args.req?.deadlineAt === undefined ? Infinity : args.req.deadlineAt - clock.monotonicNow();
    if (remaining <= 0) throw new OpencodeHttpError('request deadline expired', 0, 'TimeoutError');
    const timeoutMs = Math.min(args.req?.timeoutMs ?? opts.requestTimeoutMs, remaining);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signals: AbortSignal[] = [timeoutController.signal];
    if (args.req?.signal) {
      signals.push(args.req.signal);
    }
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeoutController.signal;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: args.method,
        headers,
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal,
        redirect: 'error',
      });
    } catch (err) {
      clearTimeout(timer);
      throw classifyAbortOrNetworkFailure(err, timeoutController, args.req?.signal, timeoutMs);
    }
    if (args.req?.deadlineAt !== undefined && clock.monotonicNow() >= args.req.deadlineAt) {
      clearTimeout(timer);
      const failure = new OpencodeHttpError('request deadline expired', 0, 'TimeoutError');
      failure.responseReceived = true;
      throw failure;
    }
    // Method, path and status only — never headers (which would include Authorization) or body.
    opts.logger.debug(`${args.method} ${url.pathname} -> ${response.status}`);
    return makeSentResponse(response, timer, timeoutController, args.req?.signal, timeoutMs, args.req?.deadlineAt, clock);
  }

  /** Reads a 2xx body expected to be JSON, streamed under `maxBytes` (A6: DEFAULT_MAX_JSON_BYTES
   * unless a caller needs a different bound). Non-JSON content-type (the embedded web UI HTML on
   * an unknown path) is a protocol error, not a parse retry. */
  async function readJson<T>(sent: SentResponse, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
    const contentType = sent.response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      sent.release();
      throw new OpencodeHttpError(
        `expected a JSON response but got content-type "${contentType || '(none)'}"`,
        sent.response.status,
        'ProtocolError',
      );
    }
    const text = await sent.readBodyLimited(maxBytes);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpencodeHttpError('failed to parse JSON response body', sent.response.status, 'ProtocolError');
    }
  }

  async function readCatalog(sent: SentResponse, maxBytes: number): Promise<unknown> {
    const contentType = sent.response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      sent.release();
      throw new OpencodeHttpError('expected JSON catalog', sent.response.status, 'ProtocolError');
    }
    const body = await sent.readBodyLimited(maxBytes);
    try { return JSON.parse(body) as unknown; }
    catch { throw new OpencodeHttpError('malformed catalog JSON', sent.response.status, 'ProtocolError'); }
  }

  /** Shared core for turning a non-2xx response into an OpencodeHttpError, whether the body is
   * read through the timeout-guarded `SentResponse.readBodyLimited()` (every non-SSE call) or the
   * standalone `readTextLimited()` (the SSE connect path below, which has no per-call timeout of
   * its own). Both readers are byte-capped (A6: MAX_ERROR_BODY_BYTES) — an overflow surfaces as
   * OpencodeHttpError('ResponseTooLarge') and is returned as-is, never silently degraded to a
   * truncated-and-reparsed message. A body read that itself fails (stalled/aborted/network) still
   * surfaces as the same OpencodeHttpError family a stalled success body would. */
  async function buildErrorFromResponse(response: Response, readBody: () => Promise<string>): Promise<OpencodeHttpError> {
    // design §C: a valid `Retry-After` (delta-seconds or HTTP-date) is a lower bound for the
    // read-retry helper. Parsed against THIS response's own headers, against an injected wall
    // clock — the raw header string never leaves this function.
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'), clock.wallNow());
    let text: string;
    try {
      text = await readBody();
    } catch (err) {
      if (err instanceof OpencodeHttpError) {
        if (err.retryAfterSeconds === undefined) err.retryAfterSeconds = retryAfterSeconds;
        return err;
      }
      return new OpencodeHttpError(networkErrorMessage(err), response.status, 'NetworkError', undefined, retryAfterSeconds);
    }
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const { errorName, message } = describeErrorBody(response.status, parsed);
    return new OpencodeHttpError(message, response.status, errorName, parsed, retryAfterSeconds);
  }

  async function errorFromResponse(sent: SentResponse): Promise<OpencodeHttpError> {
    return buildErrorFromResponse(sent.response, () => sent.readBodyLimited(MAX_ERROR_BODY_BYTES));
  }

  function sessionPath(sessionId: string, suffix = ''): string {
    return `session/${encodeURIComponent(sessionId)}${suffix}`;
  }

  const base: OpencodeApi = {
    async health(req) {
      const sent = await send({ method: 'GET', path: 'global/health', req });
      if (sent.response.ok) {
        return readJson<{ healthy: boolean; version: string }>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async createSession(directory, body, req) {
      const sent = await send({
        method: 'POST',
        path: 'session',
        query: { directory },
        body: { title: body.title, permission: body.permission },
        req,
      });
      if (sent.response.ok) {
        const parsed = await readJson<unknown>(sent);
        // A11/FZ #2: the shape of the parsed body is validated BEFORE it is ever dereferenced —
        // a 2xx with an unusable body (null, a primitive, an array, or an object with no valid id)
        // must never throw a raw, unclassified TypeError from a bare `.id` access. Such a body is
        // normalized into the exact same OpencodeHttpError this call already raises for a
        // malformed id, before this ever returns — before the engine tracks it as
        // TrackedSession.id or derives any turn id from it. The response itself was a successful
        // 2xx (only its body is unusable), so this maps to UPSTREAM_ERROR (never
        // OPENCODE_UNAVAILABLE, which upstream() in engine.ts reserves for status 0). The
        // malformed id itself is never echoed into the message (it may contain control
        // characters or otherwise be unsafe to surface verbatim).
        const session = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as OcSession) : undefined;
        if (!session || !isValidUpstreamSessionId(session.id)) {
          throw new OpencodeHttpError(
            'OpenCode returned a session with a malformed id (empty, oversized, non-printable, or containing a path separator)',
            sent.response.status,
            'ProtocolError',
          );
        }
        return session;
      }
      throw await errorFromResponse(sent);
    },

    async getSession(sessionId, req) {
      const sent = await send({ method: 'GET', path: sessionPath(sessionId), req });
      if (sent.response.status === 404) {
        sent.release();
        return null;
      }
      if (sent.response.ok) {
        return readJson<OcSession>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async promptAsync(sessionId, body: PromptBody, req) {
      const sent = await send({ method: 'POST', path: sessionPath(sessionId, '/prompt_async'), body, req });
      if (sent.response.status === 204 || sent.response.ok) {
        sent.release();
        return;
      }
      throw await errorFromResponse(sent);
    },

    async abort(sessionId, req) {
      const sent = await send({ method: 'POST', path: sessionPath(sessionId, '/abort'), req });
      if (sent.response.ok) {
        return readJson<boolean>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async deleteSession(sessionId, req) {
      const sent = await send({ method: 'DELETE', path: sessionPath(sessionId), req });
      if (sent.response.status === 404) {
        sent.release();
        return false;
      }
      if (sent.response.ok) {
        return readJson<boolean>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async archiveSession(sessionId, archivedAtMs, req) {
      const sent = await send({
        method: 'PATCH',
        path: sessionPath(sessionId),
        body: { time: { archived: archivedAtMs } },
        req,
      });
      if (sent.response.ok) {
        return readJson<OcSession>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async messages(sessionId, msgOpts, req) {
      const sticky = stickyPageCeiling.get(sessionId);
      let limit = msgOpts?.limit ?? sticky ?? 100;
      if (sticky !== undefined && limit > sticky) limit = sticky;
      let shrunk = false;
      for (;;) {
        const sent = await send({
          method: 'GET',
          path: sessionPath(sessionId, '/message'),
          query: { limit, before: msgOpts?.before },
          req,
        });
        if (!sent.response.ok) throw await errorFromResponse(sent);
        const nextCursor = sent.response.headers.get('x-next-cursor') ?? undefined;
        try {
          const raw = await readJson<unknown>(sent, MAX_MESSAGE_PAGE_BYTES);
          const items = validateMessagePage(raw, sent.response.status);
          // R14/sticky page-size fallback: only ever recorded when THIS call had to shrink below
          // the starting limit — never grown back up automatically once a smaller ceiling is known.
          if (shrunk) rememberPageCeiling(sessionId, limit);
          return { items, nextCursor };
        } catch (error) {
          if (!(error instanceof OpencodeHttpError) || error.errorName !== 'ResponseTooLarge') throw error;
          const smaller = [100, 25, 5, 1].find((candidate) => candidate < limit);
          if (smaller === undefined) throw error;
          limit = smaller;
          shrunk = true;
        }
      }
    },

    async sessionDiff(sessionId, messageId, diffOpts) {
      const sent = await send({ method: 'GET', path: sessionPath(sessionId, '/diff'),
        query: { messageID: messageId }, req: { timeoutMs: diffOpts.timeoutMs } });
      if (!sent.response.ok) throw await errorFromResponse(sent);
      const contentType = sent.response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        sent.release(); throw new OpencodeHttpError('expected JSON session diff', sent.response.status, 'ProtocolError');
      }
      const body = await sent.readBodyLimited(diffOpts.maxBytes);
      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { throw new OpencodeHttpError('malformed session diff JSON', sent.response.status, 'ProtocolError'); }
      return validateDiffItems(parsed);
    },

    async providerCatalog(directory, opts) {
      const sent = await send({ method: 'GET', path: 'provider', query: { directory }, req: { timeoutMs: opts.timeoutMs } });
      if (!sent.response.ok) throw await errorFromResponse(sent);
      return readCatalog(sent, opts.maxBytes);
    },

    async agentCatalog(directory, opts) {
      const sent = await send({ method: 'GET', path: 'agent', query: { directory }, req: { timeoutMs: opts.timeoutMs } });
      if (!sent.response.ok) throw await errorFromResponse(sent);
      return readCatalog(sent, opts.maxBytes);
    },

    async sessionStatus(directory, req) {
      const sent = await send({ method: 'GET', path: 'session/status', query: { directory }, req });
      if (sent.response.ok) {
        const raw = await readJson<unknown>(sent);
        return validateSessionStatusMap(raw, sent.response.status);
      }
      throw await errorFromResponse(sent);
    },

    async listPermissions(directory, req) {
      const sent = await send({ method: 'GET', path: 'permission', query: { directory }, req });
      if (sent.response.ok) {
        const raw = await readJson<unknown>(sent);
        return validatePermissionList(raw, sent.response.status);
      }
      throw await errorFromResponse(sent);
    },

    async replyPermission(directory, requestId, reply, message, req) {
      const sent = await send({
        method: 'POST',
        path: `permission/${encodeURIComponent(requestId)}/reply`,
        query: { directory },
        body: message !== undefined ? { reply, message } : { reply },
        req,
      });
      if (sent.response.status === 404) {
        sent.release();
        return false;
      }
      if (sent.response.ok) {
        return readJson<boolean>(sent);
      }
      throw await errorFromResponse(sent);
    },

    async listQuestions(directory, req) {
      const sent = await send({ method: 'GET', path: 'question', query: { directory }, req });
      if (sent.response.ok) {
        const raw = await readJson<unknown>(sent);
        return validateQuestionList(raw, sent.response.status);
      }
      throw await errorFromResponse(sent);
    },

    async rejectQuestion(directory, requestId, req) {
      const sent = await send({
        method: 'POST',
        path: `question/${encodeURIComponent(requestId)}/reject`,
        query: { directory },
        req,
      });
      if (sent.response.status === 404) {
        sent.release();
        return false;
      }
      if (sent.response.ok) {
        return readJson<boolean>(sent);
      }
      throw await errorFromResponse(sent);
    },

    // Upstream instance-poisoning mitigation (docs/research/upstream-issues.md U1): pre-resolve
    // the directory instance's provider+agent state outside any prompt run, before the first
    // submission, so an early abort during the first prompt's own model resolution never lands.
    async warmInstance(directory, req) {
      const providerSent = await send({ method: 'GET', path: 'provider', query: { directory }, req });
      if (!providerSent.response.ok) {
        throw await errorFromResponse(providerSent);
      }
      await readCatalog(providerSent, 2 * 1024 * 1024);

      const agentSent = await send({ method: 'GET', path: 'agent', query: { directory }, req });
      if (!agentSent.response.ok) {
        throw await errorFromResponse(agentSent);
      }
      await readCatalog(agentSent, 2 * 1024 * 1024);
    },

    async disposeInstance(directory, req) {
      const sent = await send({ method: 'POST', path: 'instance/dispose', query: { directory }, req });
      if (sent.response.ok) {
        return readJson<boolean>(sent);
      }
      throw await errorFromResponse(sent);
    },

    subscribe(directory, signal): AsyncIterable<OcEvent> {
      return subscribeGenerator(directory, signal);
    },
  };

  function clampAttempts(maxAttempts: number | undefined): number {
    const n = maxAttempts ?? 3;
    return Math.min(3, Math.max(1, Math.trunc(n) || 1));
  }

  /** Wraps one eligible admission GET (design §C) with the bounded read-retry helper, sharing the
   * caller's own operation deadline and (optionally pinned) jitter source. */
  async function retryGet<T>(retryOpts: EligibleGetRetryOptions, invoke: (req: RequestOptions) => Promise<T>): Promise<T> {
    return withReadRetry(
      (attemptInfo) => invoke({ signal: attemptInfo.signal, timeoutMs: attemptInfo.timeoutMs,
        deadlineAt: retryOpts.deadlineAt }),
      {
        maxAttempts: clampAttempts(retryOpts.maxAttempts),
        deadlineAt: retryOpts.deadlineAt,
        clock,
        signal: retryOpts.signal,
        requestTimeoutMs: opts.requestTimeoutMs,
        random,
      },
    );
  }

  return {
    ...base,
    async healthWithRetry(retryOpts) {
      return retryGet(retryOpts, (req) => base.health(req));
    },
    async sessionStatusWithRetry(directory, retryOpts) {
      return retryGet(retryOpts, (req) => base.sessionStatus(directory, req));
    },
    async messagesWithRetry(sessionId, msgOpts, retryOpts) {
      return retryGet(retryOpts, (req) => base.messages(sessionId, msgOpts, req));
    },
    async listPermissionsWithRetry(directory, retryOpts) {
      return retryGet(retryOpts, (req) => base.listPermissions(directory, req));
    },
    async listQuestionsWithRetry(directory, retryOpts) {
      return retryGet(retryOpts, (req) => base.listQuestions(directory, req));
    },
    async warmInstanceWithRetry(directory, retryOpts) {
      return retryGet(retryOpts, (req) => base.warmInstance(directory, req));
    },
    forgetPageCeiling(sessionId: string): void {
      stickyPageCeiling.delete(sessionId);
    },
  };

  async function* subscribeGenerator(directory: string, signal: AbortSignal): AsyncGenerator<OcEvent> {
    const url = buildUrl('event', { directory });
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (authHeader) {
      headers.authorization = authHeader;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' });
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (isRedirectError(err)) {
        throw new OpencodeHttpError('server attempted a redirect', 0, 'RedirectError');
      }
      throw new OpencodeHttpError(networkErrorMessage(err), 0, 'NetworkError');
    }

    opts.logger.debug(`GET ${url.pathname} -> ${response.status}`);
    // subscribe()'s contract (types.ts) is that aborting `signal` ends the iteration without
    // throwing. Every branch below that would otherwise throw checks signal.aborted first: an
    // abort landing after the fetch resolves (including mid-read of a stalled non-2xx error body)
    // must return quietly, the same as an abort during the fetch itself or the SSE body loop.
    if (signal.aborted) {
      return;
    }
    if (!response.ok) {
      const err = await buildErrorFromResponse(response, () => readTextLimited(response, MAX_ERROR_BODY_BYTES));
      if (signal.aborted) {
        return;
      }
      throw err;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      if (signal.aborted) {
        return;
      }
      throw new OpencodeHttpError(
        `expected an SSE response but got content-type "${contentType || '(none)'}"`,
        response.status,
        'ProtocolError',
      );
    }
    if (!response.body) {
      if (signal.aborted) {
        return;
      }
      throw new OpencodeHttpError('event stream response has no body', response.status, 'ProtocolError');
    }

    try {
      for await (const evt of parseSse(response.body)) {
        yield evt;
      }
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      throw new OpencodeHttpError(networkErrorMessage(err), 0, 'NetworkError');
    }
  }
}

/** Unchanged signature/behavior from before the overload-robustness work: every existing caller
 * (src/opencode/connection.ts and its tests) keeps compiling and running exactly as before. The
 * returned object also carries the `*WithRetry` methods and `forgetPageCeiling` at runtime, but
 * this narrower return type keeps them invisible to callers that only expect `OpencodeApi`. */
export function createOpencodeApi(opts: CreateOpencodeApiOptions): OpencodeApi {
  return buildApi(opts);
}

/** Same underlying client as `createOpencodeApi`, typed to also expose the design §C bounded
 * read-retry variants (`*WithRetry`) and `forgetPageCeiling`, for unit 3 to wire into admission/
 * cleanup call sites. */
export function createOpencodeApiWithRetry(opts: CreateOpencodeApiOptions): OpencodeApiRetryable {
  return buildApi(opts);
}
