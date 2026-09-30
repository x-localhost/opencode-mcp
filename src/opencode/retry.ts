// Bounded read-retry helper for eligible idempotent OpenCode GETs (overload design; summarized
// in docs/design.md §12).
//
// Mutations are NEVER retried by this module. Callers must only wrap admission reads with
// withReadRetry: attach health, session status, message boundary/history reads, permission/
// question lists, and warm-up GETs — never createSession, promptAsync, abort, deleteSession,
// archiveSession, replyPermission, rejectQuestion or disposeInstance.

import { OpencodeHttpError } from '../types.ts';

import type { Clock, UpstreamErrorDetail } from '../types.ts';

/** design §C: HTTP statuses that are transient for an idempotent GET. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Provider-overload statuses (design §B: `condition: 'MODEL_OVERLOADED'`). */
const OVERLOAD_STATUSES = new Set([429, 503, 529]);

/** The maximum automatic wait this helper will ever schedule for one retry, whether derived from
 * a server's `Retry-After` or from the default jittered backoff. A longer request is returned as
 * an error immediately rather than truncated-and-retried-early (design §C). */
export const MAX_AUTOMATIC_WAIT_MS = 3_600_000;

/** Extra jitter added on top of a valid `Retry-After` lower bound (design §C: "plus up to 250ms
 * jitter"). */
const RETRY_AFTER_JITTER_CAP_MS = 250;

/**
 * Classifies a failure from an eligible GET as retryable per design §C:
 * - transient: network failure, request timeout, HTTP 408/429/500/502/503/504/529, or
 *   malformed/empty JSON / an invalid expected response shape (`ProtocolError`).
 * - never retried: caller cancellation (`AbortError`), redirects (`RedirectError`),
 *   authentication/authorization failures (401/403), other ordinary 4xx, and an oversized
 *   response at the same page size (`ResponseTooLarge`).
 */
export function isRetryableReadError(error: unknown): boolean {
  if (!(error instanceof OpencodeHttpError)) return false;
  const { status, errorName } = error;
  if (errorName === 'AbortError' || errorName === 'RedirectError') return false;
  if (status === 401 || status === 403) return false;
  if (status === 0) {
    // Network/timeout failures share status 0 with AbortError/RedirectError, already excluded above.
    return errorName === 'TimeoutError' || errorName === 'NetworkError';
  }
  if (TRANSIENT_STATUSES.has(status)) return true;
  if (errorName === 'ProtocolError') return true;
  return false;
}

// Coarse (status, errorName) -> classification derivation lives on OpencodeHttpError itself
// (src/types.ts's `classifyHttpFailure`, re-exported from there) so every construction site gets
// it automatically; re-exported here too since callers of this module already import from it.
export { classifyHttpFailure } from '../types.ts';

/**
 * Parses a `Retry-After` header value (delta-seconds or an HTTP-date) into a non-negative integer
 * number of seconds, using an injected wall clock (`nowMs`, epoch ms) to resolve an HTTP-date —
 * never `Date.now()` directly, so parsing is deterministic under test.
 *
 * Returns `undefined` for an absent, empty, negative, or otherwise unparseable value — this
 * function never throws. A large-but-finite delta-seconds value is returned as-is (never
 * overflowed into `Infinity`/`NaN`): the caller (the retry loop, via `MAX_AUTOMATIC_WAIT_MS`) is
 * responsible for deciding whether a value this large still permits an automatic retry.
 */
// RFC 7231 §7.1.1.1 IMF-fixdate — the only HTTP-date form modern servers send (and the only one
// `Date#toUTCString()` produces). `Date.parse` alone is deliberately NOT used to gate what counts
// as a date: it has a well-known lenient legacy-format fallback that accepts many non-HTTP-date
// strings (e.g. "1.5") as an arbitrary date, which would silently misclassify a malformed header
// as a "valid" Retry-After instead of leaving it unparseable.
const HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfterSeconds(headerValue: string | null | undefined, nowMs: number): number | undefined {
  if (headerValue === null || headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds);
  }
  if (!HTTP_DATE_RE.test(trimmed)) return undefined;
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return undefined;
  const deltaMs = parsedMs - nowMs;
  if (!Number.isFinite(deltaMs)) return undefined;
  return Math.max(0, Math.ceil(deltaMs / 1000));
}

/** A real, non-mockable Clock (wall time via `Date.now()`, monotonic time via `performance.now()`,
 * scheduling via `setTimeout`) for production use; tests inject `FakeClock` (test/fakes/fake-clock.ts)
 * instead. */
export function createRealClock(): Clock {
  return {
    wallNow(): number {
      return Date.now();
    },
    monotonicNow(): number {
      return performance.now();
    },
    schedule(delayMs: number, callback: () => void): () => void {
      const timer = setTimeout(callback, Math.max(0, delayMs));
      return () => clearTimeout(timer);
    },
  };
}

/** Rejects with an AbortError the moment `signal` fires, even mid-sleep — "cancellation during
 * sleep" (design §D unit 1 test list) must not wait out the remaining delay. */
function sleep(ms: number, clock: Clock, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpencodeHttpError('request aborted', 0, 'AbortError'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const cancelTimer = clock.schedule(ms, () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    onAbort = () => {
      cancelTimer();
      reject(new OpencodeHttpError('request aborted', 0, 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** design §C: `U(0, min(2000ms, 250ms × 2^(r−1)))` before retry number `r` (1-based: r=1 is the
 * delay before the first retry, i.e. after attempt 1 failed). */
function jitteredBackoffMs(retryNumber: number, random: () => number): number {
  const cap = Math.min(2000, 250 * 2 ** (retryNumber - 1));
  return random() * cap;
}

export interface ReadRetryAttemptInfo {
  /** This attempt's own request timeout, already capped by the shared operation deadline. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** 1-based; equals the total number of attempts made so far, including this one. */
  attemptNumber: number;
}

export interface ReadRetryOptions {
  /** Total attempts including the first; clamped to 1..3 (config: OPENCODE_MCP_READ_RETRY_ATTEMPTS). */
  maxAttempts: number;
  /** Absolute monotonic-ms deadline shared by the WHOLE calling operation (admission, cleanup,
   * ...): every attempt's own timeout, every retry sleep, and (for callers composing this with
   * pagination/fallback page sizes) every page fetch are bounded by the same value. */
  deadlineAt: number;
  clock: Clock;
  /** Cancels the whole retry loop, including an in-progress sleep. */
  signal?: AbortSignal;
  /** Per-attempt request timeout ceiling BEFORE deadline capping (ordinarily config.requestTimeoutMs). */
  requestTimeoutMs: number;
  /** Injectable uniform-random source in [0, 1); defaults to `Math.random`. Tests can pin it for
   * deterministic jitter. */
  random?: () => number;
}

/**
 * Runs `attempt` up to `options.maxAttempts` times, retrying only on `isRetryableReadError`
 * failures, honouring a valid `OpencodeHttpError.retryAfterSeconds` as a lower bound (plus jitter),
 * and never scheduling a wait that exceeds `MAX_AUTOMATIC_WAIT_MS` or the shared operation
 * deadline — in either case the last error is thrown immediately instead of truncating the delay
 * and retrying early. A non-retryable failure, or a failure on the final allowed attempt, is
 * always rethrown as-is.
 */
export async function withReadRetry<T>(
  attempt: (info: ReadRetryAttemptInfo) => Promise<T>,
  options: ReadRetryOptions,
): Promise<T> {
  const random = options.random ?? Math.random;
  const maxAttempts = Math.min(3, Math.max(1, Math.trunc(options.maxAttempts) || 1));
  let lastError: unknown;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    if (options.signal?.aborted) {
      throw new OpencodeHttpError('request aborted', 0, 'AbortError');
    }
    const remaining = options.deadlineAt - options.clock.monotonicNow();
    if (remaining <= 0) {
      throw lastError ?? new OpencodeHttpError('operation deadline exceeded before this read', 0, 'TimeoutError');
    }
    const timeoutMs = Math.max(1, Math.min(options.requestTimeoutMs, remaining));

    try {
      return await attempt({ timeoutMs, signal: options.signal, attemptNumber });
    } catch (error) {
      lastError = error;
      if (!isRetryableReadError(error) || attemptNumber >= maxAttempts) {
        throw error;
      }
      const httpError = error as OpencodeHttpError;
      let delayMs: number;
      if (httpError.retryAfterSeconds !== undefined) {
        const baseMs = httpError.retryAfterSeconds * 1000;
        if (baseMs > MAX_AUTOMATIC_WAIT_MS) {
          // Longer than the sanity cap: return the error without retrying early.
          throw error;
        }
        delayMs = Math.min(MAX_AUTOMATIC_WAIT_MS, baseMs + random() * RETRY_AFTER_JITTER_CAP_MS);
      } else {
        delayMs = jitteredBackoffMs(attemptNumber, random);
      }
      const remainingAfterFailure = options.deadlineAt - options.clock.monotonicNow();
      if (delayMs >= remainingAfterFailure) {
        // Waiting this long would exceed the shared operation deadline; never truncate and retry early.
        throw error;
      }
      await sleep(delayMs, options.clock, options.signal);
    }
  }
  // Unreachable (the loop above always returns or throws), kept for type-safety.
  throw lastError ?? new OpencodeHttpError('read retry attempts exhausted', 0, 'UnknownError');
}

const MAX_ERROR_NAME_CHARS = 200;
const MAX_ERROR_MESSAGE_CHARS = 500;

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Normalizes an `OpencodeHttpError` into the shared `UpstreamErrorDetail` shape (design §B) for
 * unit 3 to attach to `TurnResult`/`ErrorResult`/batch items: bounded name/message, a validated
 * `statusCode` (100..599), `retryable` derived only from recognized transient statuses (this
 * adapter has no explicit upstream `isRetryable` of its own to preserve), the bounded
 * `retryAfterSeconds` already carried by the error, and `condition: 'MODEL_OVERLOADED'` for
 * provider back-pressure statuses (429/503/529). Never copies response bodies or header maps.
 */
export function toUpstreamErrorDetail(error: OpencodeHttpError): UpstreamErrorDetail {
  const statusCode = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
  const retryable = TRANSIENT_STATUSES.has(error.status) || isRetryableReadError(error) ? true : undefined;
  const condition = OVERLOAD_STATUSES.has(error.status) ? ('MODEL_OVERLOADED' as const) : undefined;
  return {
    name: bound(error.errorName, MAX_ERROR_NAME_CHARS),
    message: bound(error.message, MAX_ERROR_MESSAGE_CHARS),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(condition !== undefined ? { condition } : {}),
  };
}
