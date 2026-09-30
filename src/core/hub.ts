import type { Clock, Config, Connection, ConnectionLease, Logger, OcEvent } from '../types.ts';

type Listener = (event: OcEvent) => void;

/** Bounded, credential-free diagnostic snapshot of one reconnect attempt's outcome. */
type SseFailureCause = {
  name: string;
  status?: number;
  retryAfterSeconds?: number;
};

type LastFailure = SseFailureCause & {
  attempt: number;
  backoffMs: number;
  /** wall-clock ms (Clock.wallNow()) */
  at: number;
};

type Stream = {
  directory: string;
  generation: number;
  lease: ConnectionLease;
  listeners: Set<Listener>;
  abort: AbortController;
  connected: Promise<void>;
  resolve: () => void;
  /** R11: true once `resolve()` has actually been called for the *current* `connected` promise.
   *  Only replace the promise/resolver pair when this is true — otherwise a still-unresolved
   *  waiter from an in-progress outage would be orphaned by a later failed attempt. */
  connectedSettled: boolean;
  hasConnected: boolean;
  connectedAt: number;
  watchdog?: () => void;
  retry?: () => void;
  retryResolve?: () => void;
  backoff: number;
  /** Consecutive failed/ended attempts since the last real `server.connected`. Diagnostics only —
   *  the exponential ceiling itself is tracked by `backoff`, not recomputed from this. */
  attempts: number;
  lastFailure?: LastFailure;
  /** monotonic ms of the last diagnostic log emission, for rate limiting. */
  lastLoggedAt?: number;
  /** R10: pending jittered, coalesced 'hub.reconnected' emission for the current recovery. */
  recoveryTimer?: () => void;
  /** A newer successful reconnect happened while `recoveryTimer` was still pending; emit a
   *  trailing refresh once it fires instead of dropping it. */
  recoveryAgain: boolean;
  alive: boolean;
  reconnecting: boolean;
};

// Reconnect backoff: exponential full jitter from 500ms up to a 30s ceiling, with a 250ms
// scheduling floor so a near-zero jitter draw never produces a tight reconnect loop.
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_SCHEDULING_FLOOR_MS = 250;
// Defensive cap on an honored Retry-After from a hostile/misconfigured upstream: the reconnect
// loop must keep retrying eventually rather than stalling indefinitely on a huge value.
const MAX_RETRY_AFTER_MS = 3_600_000;
// R10: per-turn recovery refresh is jittered by U(0, 2000ms) and coalesced (see scheduleRecoveryEmit).
const RECOVERY_JITTER_MAX_MS = 2_000;
// R13: bounded, rate-limited diagnostics — at most one log line per stream per this window, plus
// an escalation to 'warn' once a stream has failed several consecutive attempts.
const DIAG_LOG_INTERVAL_MS = 5_000;
const WARN_ATTEMPT_THRESHOLD = 3;
const MAX_DIAG_NAME_LEN = 200;

const noopLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * Structural (duck-typed) read of a caught reconnect failure: name/status/retryAfterSeconds only,
 * never message/body/headers. Deliberately does not import `OpencodeHttpError` so this file does
 * not depend on that type's exact shape — the structural read below is the interface contract
 * between the two.
 */
function describeError(error: unknown): SseFailureCause {
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    const rawName =
      typeof rec.errorName === 'string' && rec.errorName
        ? rec.errorName
        : typeof rec.name === 'string' && rec.name
          ? rec.name
          : 'Error';
    const name = rawName.slice(0, MAX_DIAG_NAME_LEN);
    const statusRaw = rec.status;
    const status =
      typeof statusRaw === 'number' && Number.isFinite(statusRaw) && statusRaw >= 0 && statusRaw <= 599
        ? statusRaw
        : undefined;
    const retryRaw = rec.retryAfterSeconds;
    const retryAfterSeconds =
      typeof retryRaw === 'number' && Number.isFinite(retryRaw) && retryRaw >= 0 ? retryRaw : undefined;
    return { name, status, retryAfterSeconds };
  }
  return { name: 'UnknownError' };
}

/** Share one directory stream per connection generation while listeners remain. */
export class EventHub {
  private streams = new Map<string, Stream>();
  private offUnavailable: () => void;
  private clock: Clock;
  private config: Config;
  private logger: Logger;
  private random: () => number;

  constructor(connection: Connection, clock: Clock, config: Config, logger?: Logger, random?: () => number) {
    this.clock = clock;
    this.config = config;
    this.logger = logger ?? noopLogger;
    this.random = random ?? Math.random;
    this.offUnavailable = connection.onUnavailable((generation) => {
      for (const stream of this.streams.values())
        if (stream.generation === generation) {
          stream.abort.abort();
          stream.watchdog?.();
          stream.retry?.();
          stream.retryResolve?.();
          stream.recoveryTimer?.();
          stream.alive = false;
          this.streams.delete(stream.directory);
        }
    });
  }

  listen(
    directory: string,
    lease: ConnectionLease,
    listener: Listener,
  ): { connected: Promise<void>; close: () => void } {
    let stream = this.streams.get(directory);
    if (stream && stream.generation !== lease.generation) {
      stream.abort.abort();
      stream.watchdog?.();
      stream.retry?.();
      stream.retryResolve?.();
      stream.recoveryTimer?.();
      stream.alive = false;
      this.emit(stream, { type: 'hub.reconnected', properties: {} });
      this.streams.delete(directory);
      stream = undefined;
    }
    if (!stream) {
      let resolve = () => {};
      const connected = new Promise<void>((r) => {
        resolve = () => r();
      });
      stream = {
        directory,
        generation: lease.generation,
        lease,
        listeners: new Set(),
        abort: new AbortController(),
        connected,
        resolve,
        connectedSettled: false,
        hasConnected: false,
        connectedAt: 0,
        backoff: INITIAL_BACKOFF_MS,
        attempts: 0,
        recoveryAgain: false,
        alive: true,
        reconnecting: false,
      };
      this.streams.set(directory, stream);
      this.run(stream);
    }
    stream.listeners.add(listener);
    const current = stream;
    return {
      connected: current.connected,
      close: () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          current.alive = false;
          current.abort.abort();
          current.watchdog?.();
          current.retry?.();
          current.retryResolve?.();
          current.recoveryTimer?.();
          if (this.streams.get(directory) === current) this.streams.delete(directory);
        }
      },
    };
  }

  /** R13: bounded accessor so an admission timeout can explain *why* the stream never connected. */
  lastFailureCause(directory: string): LastFailure | undefined {
    return this.streams.get(directory)?.lastFailure;
  }

  private emit(stream: Stream, event: OcEvent): void {
    for (const listener of stream.listeners) listener(event);
  }

  private arm(stream: Stream): void {
    stream.watchdog?.();
    stream.watchdog = this.clock.schedule(this.config.sseStallMs, () => {
      stream.abort.abort();
    });
  }

  /** R10: emit exactly one 'hub.reconnected' per successful reconnection, jittered by
   *  U(0, 2000ms) and coalesced — a reconnect that completes while a prior emission is still
   *  pending does not fire a second, immediate notification; it instead schedules one trailing
   *  refresh once the pending one fires, so listeners still learn about the latest recovery. */
  private scheduleRecoveryEmit(stream: Stream): void {
    if (stream.recoveryTimer) {
      stream.recoveryAgain = true;
      return;
    }
    const jitterMs = Math.max(0, this.random() * RECOVERY_JITTER_MAX_MS);
    stream.recoveryTimer = this.clock.schedule(jitterMs, () => {
      stream.recoveryTimer = undefined;
      this.emit(stream, { type: 'hub.reconnected', properties: {} });
      if (stream.recoveryAgain) {
        stream.recoveryAgain = false;
        this.scheduleRecoveryEmit(stream);
      }
    });
  }

  /** Bounded, rate-limited diagnostics for one ended attempt: name/status/attempt/backoff only —
   *  never message, body, headers or credentials. Always updates the accessor's snapshot; the
   *  logger call itself is rate-limited per stream so a flapping connection cannot flood logs. */
  private recordFailure(stream: Stream, failure: unknown): void {
    const cause: SseFailureCause = failure === undefined ? { name: 'StreamEnded' } : describeError(failure);
    stream.lastFailure = {
      ...cause,
      attempt: stream.attempts,
      backoffMs: stream.backoff,
      at: this.clock.wallNow(),
    };
    const now = this.clock.monotonicNow();
    if (stream.lastLoggedAt !== undefined && now - stream.lastLoggedAt < DIAG_LOG_INTERVAL_MS) return;
    stream.lastLoggedAt = now;
    const level = stream.attempts >= WARN_ATTEMPT_THRESHOLD ? 'warn' : 'debug';
    this.logger[level]('SSE stream reconnect attempt failed', {
      directory: stream.directory,
      attempt: stream.attempts,
      errorName: cause.name,
      status: cause.status,
      backoffMs: stream.backoff,
    });
  }

  /** Exponential full jitter U(0, backoff) with a 250ms scheduling floor, honouring a
   *  structurally-carried Retry-After (from the most recently recorded failure) as a lower bound. */
  private reconnectDelayMs(stream: Stream): number {
    const jittered = Math.max(BACKOFF_SCHEDULING_FLOOR_MS, this.random() * stream.backoff);
    const retryAfterSeconds = stream.lastFailure?.retryAfterSeconds;
    if (retryAfterSeconds === undefined) return jittered;
    const floorMs = Math.min(Math.max(0, retryAfterSeconds * 1000), MAX_RETRY_AFTER_MS);
    return Math.max(jittered, floorMs);
  }

  private async run(stream: Stream): Promise<void> {
    while (stream.alive) {
      stream.abort = new AbortController();
      this.arm(stream);
      const attemptStartedAt = this.clock.monotonicNow();
      let failure: unknown;
      try {
        for await (const event of stream.lease.api.subscribe(stream.directory, stream.abort.signal)) {
          if (!stream.alive) break;
          this.arm(stream);
          if (event.type === 'server.connected') {
            stream.hasConnected = true;
            stream.connectedAt = this.clock.monotonicNow();
            stream.attempts = 0;
            stream.connectedSettled = true;
            stream.resolve();
          }
          this.emit(stream, event);
          if (event.type === 'server.connected' && stream.reconnecting) {
            stream.reconnecting = false;
            this.scheduleRecoveryEmit(stream);
          }
          if (event.type === 'server.instance.disposed') {
            stream.abort.abort();
            break;
          }
        }
      } catch (error) {
        failure = error;
        /* Reconnect and reconcile through the synthetic event. */
      }
      stream.watchdog?.();
      if (!stream.alive) break;
      stream.attempts += 1;
      this.recordFailure(stream, failure);
      if (stream.hasConnected) {
        // Only reset the backoff when *this* attempt connected (not a stale connect from before a
        // run of failed reconnects) and lived long enough. Otherwise keep doubling (hub.ts review
        // finding r1-adapter-http-sse-1): connectedAt is set once on server.connected and never
        // cleared on failure, so comparing it against `now` alone would reset backoff to 500 on
        // every subsequent failed attempt once the stream had ever connected for sseStallMs/2.
        if (
          stream.connectedAt >= attemptStartedAt &&
          this.clock.monotonicNow() - stream.connectedAt >= this.config.sseStallMs / 2
        )
          stream.backoff = INITIAL_BACKOFF_MS;
        // R11: only replace the connected waiter once the current one has actually resolved.
        // Otherwise a listener holding a reference to a still-unresolved promise from earlier in
        // this same outage would be orphaned by a later failed attempt.
        if (stream.connectedSettled) {
          let resolve = () => {};
          stream.connected = new Promise<void>((r) => {
            resolve = () => r();
          });
          stream.resolve = resolve;
          stream.connectedSettled = false;
        }
      }
      stream.reconnecting = true;
      const delay = this.reconnectDelayMs(stream);
      await new Promise<void>((resolve) => {
        stream.retryResolve = () => resolve();
        stream.retry = this.clock.schedule(delay, () => resolve());
      });
      stream.retry = undefined;
      stream.retryResolve = undefined;
      stream.backoff = Math.min(stream.backoff * 2, MAX_BACKOFF_MS);
    }
  }

  close(): void {
    for (const stream of this.streams.values()) {
      stream.alive = false;
      stream.abort.abort();
      stream.watchdog?.();
      stream.retry?.();
      stream.retryResolve?.();
      stream.recoveryTimer?.();
    }
    this.streams.clear();
    this.offUnavailable();
  }
}
