// Lazily-started managed or attached OpenCode connection (design.md §5.1).

import { randomBytes } from 'node:crypto';

import { buildServeEnv, processGroupGone, startManagedServer, terminateProcessGroup } from './managed-server.ts';
import { createOpencodeApi } from './http.ts';
import type { OpencodeApiRetryable } from './http.ts';
import { withReadRetry } from './retry.ts';
import { EngineError } from '../types.ts';

import type { ManagedServer } from './managed-server.ts';
import type { Clock, Config, Connection, ConnectionLease, Logger, OpencodeApi, RequestOptions } from '../types.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(hostname: string): boolean {
  // URL#hostname keeps IPv6 brackets off already, but strip them defensively just in case.
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '');
  return LOOPBACK_HOSTS.has(bare);
}

/** Attach mode URL validation (design.md §5.1): no userinfo; https unless loopback or opted in.
 * Every failure names the env var and the rule violated but never echoes `config.serverUrl` — a
 * malformed value can itself carry credentials (e.g. `https://user:pass@[`), and that value would
 * otherwise round-trip into startup diagnostics on stderr (main()'s top-level catch logs
 * EngineError/Error messages verbatim). */
function validateAttachUrl(config: Config): URL {
  if (!config.serverUrl) {
    throw new EngineError('INVALID_ARGUMENT', 'attach mode requires OPENCODE_MCP_SERVER_URL');
  }
  let url: URL;
  try {
    url = new URL(config.serverUrl);
  } catch {
    throw new EngineError('INVALID_ARGUMENT', 'OPENCODE_MCP_SERVER_URL is not a valid URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new EngineError('INVALID_ARGUMENT', 'OPENCODE_MCP_SERVER_URL must not contain userinfo (username/password)');
  }
  if (url.protocol !== 'https:') {
    if (url.protocol === 'http:' && (isLoopbackHost(url.hostname) || config.allowInsecureHttp)) {
      return url;
    }
    throw new EngineError(
      'INVALID_ARGUMENT',
      'OPENCODE_MCP_SERVER_URL must use https: unless the host is loopback or OPENCODE_MCP_ALLOW_INSECURE_HTTP=1',
    );
  }
  return url;
}

export interface CreateConnectionDeps {
  startManagedServer?: typeof startManagedServer;
  createOpencodeApi?: typeof createOpencodeApi;
  terminateProcessGroup?: typeof terminateProcessGroup;
  processGroupGone?: (pid: number) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

export function createConnection(config: Config, logger: Logger, clock: Clock, deps: CreateConnectionDeps = {}): Connection {
  const startFn = deps.startManagedServer ?? startManagedServer;
  const createApiFn = deps.createOpencodeApi ?? createOpencodeApi;
  const terminateGroupFn = deps.terminateProcessGroup ?? terminateProcessGroup;
  const groupGoneFn = deps.processGroupGone ?? processGroupGone;
  const envSource = deps.env ?? process.env;
  const admissionHealth = (
    api: OpencodeApi, deadlineAt: number, signal: AbortSignal, timeoutMs: number,
  ): ReturnType<OpencodeApi['health']> => {
    const retryable = api as OpencodeApiRetryable;
    return retryable.healthWithRetry
      ? retryable.healthWithRetry({ deadlineAt, maxAttempts: config.readRetryAttempts, signal })
      : withReadRetry(({ timeoutMs: attemptMs }) => api.health({ timeoutMs: attemptMs, signal }), {
          deadlineAt, maxAttempts: config.readRetryAttempts, clock,
          requestTimeoutMs: timeoutMs, signal,
        });
  };

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let generation = 0;
  let currentLease: ConnectionLease | undefined;
  let currentStop: ((graceMs?: number) => Promise<void>) | undefined;
  let currentPid: number | undefined;
  let starting: Promise<ConnectionLease> | undefined;
  let invalidating: Promise<void> | undefined;
  let recyclingGeneration: number | undefined;
  let pendingGroupVerification: { lease: ConnectionLease; pid: number; generation: number; exitError: Error } | undefined;
  let pendingVerificationCheck: Promise<void> | undefined;
  /** Aborts the in-flight managed startup (if any), so close() can reclaim a mid-startup child
   * immediately instead of waiting for the full startup timeout to elapse naturally. */
  let startupAbort: AbortController | undefined;
  /** Unexpected-exit process-group sweeps that are still running (fire-and-forget from the
   * `server.exited` handler below): close() must await all of these before it resolves, or a
   * delayed SIGKILL sweep can finish after the process has already exited. */
  const pendingGroupCleanups = new Set<Promise<void>>();
  const unavailableListeners = new Set<(generation: number, error: Error, kind: 'exited' | 'unreachable') => void>();

  function notifyUnavailable(gen: number, error: Error, kind: 'exited' | 'unreachable'): void {
    for (const listener of [...unavailableListeners]) {
      try {
        listener(gen, error, kind);
      } catch (err) {
        logger.warn('onUnavailable listener threw', { error: (err as Error).message });
      }
    }
  }

  async function verifyPendingGroup(): Promise<void> {
    if (pendingVerificationCheck) return pendingVerificationCheck;
    const pending = pendingGroupVerification;
    if (!pending) return;
    const check = (async () => {
      const gone = await groupGoneFn(pending.pid);
      if (!gone || closed || pendingGroupVerification !== pending || currentLease !== pending.lease) return;
      pendingGroupVerification = undefined;
      currentLease = undefined;
      currentStop = undefined;
      currentPid = undefined;
      notifyUnavailable(pending.generation, pending.exitError, 'exited');
    })();
    pendingVerificationCheck = check;
    try { await check; }
    finally { if (pendingVerificationCheck === check) pendingVerificationCheck = undefined; }
  }

  async function startManaged(req?: RequestOptions): Promise<ConnectionLease> {
    generation += 1;
    const myGeneration = generation;
    const password = randomBytes(32).toString('base64url');
    const env = buildServeEnv(envSource, config, password);

    const abortController = new AbortController();
    startupAbort = abortController;
    // Measures elapsed time against config.startupTimeoutMs for the health request's own timeout
    // below (F15/r2-r-adapter-3): the readiness wait (inside startFn) and the health check must
    // together stay within startupTimeoutMs, not let the health check run out its own separate
    // (and much larger) requestTimeoutMs on top.
    const spawnStartedAt = clock.monotonicNow();

    let server: ManagedServer;
    try {
      server = await startFn({
        bin: config.opencodeBin,
        serveArgs: config.serveArgs,
        cwd: config.defaultCwd,
        env,
        startupTimeoutMs: config.startupTimeoutMs,
        logger,
        signal: abortController.signal,
      });
    } catch (err) {
      startupAbort = undefined;
      throw new EngineError('OPENCODE_UNAVAILABLE', `failed to start opencode serve: ${(err as Error).message}`);
    }

    // Register ownership of the spawned child (the stop handle) immediately once it's ready —
    // BEFORE the health check, not after — so close() can reclaim it right away without waiting
    // for health to complete (F1: the health check can be slow or effectively hung, and the child
    // must not be left running unsupervised for its whole duration). `startupAbort` is
    // deliberately NOT cleared yet: cancellation stays in force through the health check too (see
    // the combined signal below), covering the same window this stop handle now also covers.
    // `myStop` is kept locally (not just read back from `currentStop`) so the health-failure catch
    // below can tell whether `currentStop` still refers to THIS attempt before clearing it — a
    // concurrent close() may already have taken and cleared it, or a hypothetical later attempt
    // may already have overwritten it.
    const myStop = (graceMs?: number) => server.stop(graceMs);
    currentStop = myStop;
    currentPid = server.pid;

    try {
      const api = createApiFn({
        baseUrl: server.url,
        username: config.username,
        password,
        requestTimeoutMs: config.requestTimeoutMs,
        logger,
        clock,
      });
      // The health request honours BOTH the caller's own signal (req?.signal, e.g. an MCP call
      // being cancelled) AND our internal startup-abort signal, so an explicit close() (or a
      // startup abort from any other cause) interrupts a slow health check instead of leaving it
      // to run out its full requestTimeoutMs.
      const healthSignal = req?.signal ? AbortSignal.any([abortController.signal, req.signal]) : abortController.signal;
      // Bounds the health request itself to whatever remains of the startup budget (capped at
      // config.requestTimeoutMs), so one acquire() stays within startupTimeoutMs end-to-end
      // instead of the health check separately running out its own (much larger) requestTimeoutMs
      // on top (r2-r-adapter-3; design.md §5.1 doc fix deferred to U17).
      const healthTimeoutMs = Math.max(1, Math.min(config.requestTimeoutMs, spawnStartedAt + config.startupTimeoutMs - clock.monotonicNow()));
      const health = await admissionHealth(api, spawnStartedAt + config.startupTimeoutMs, healthSignal, healthTimeoutMs);
      if (!health.healthy) {
        throw new Error('opencode server reported unhealthy status');
      }

      if (closed) {
        // close() may have run while we were mid-startup; the shared catch below stops the
        // child exactly once and this EngineError propagates unwrapped.
        throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
      }

      const lease: ConnectionLease = { api, generation: myGeneration, version: health.version };
      currentLease = lease;
      // currentStop was already registered above, right after the child became ready.

      server.exited.then((result) => {
        if (currentLease === lease && !closed && recyclingGeneration !== myGeneration) {
          // The direct child already exited, but it may have spawned descendants that are still
          // alive (e.g. a still-running tool subprocess). A3: neither the 'exited' execution fence
          // (which tells every Turn on this generation "definitely no further mutation can land")
          // nor a replacement generation may be handed out until the process-group sweep has
          // actually confirmed the whole group is gone — reusing the exact verification
          // invalidate() uses below (terminateGroupFn's own TERM -> grace -> KILL, then a bounded
          // groupGoneFn poll). `currentLease`/`currentStop`/`currentPid` are deliberately NOT
          // cleared yet: `invalidating` (which acquire() already awaits, and which a concurrent
          // invalidate() call for this same generation folds into via its own `currentLease?.
          // generation === gen` check) is the sole gate during this window, so a concurrent
          // acquire() blocks instead of either racing a new generation past a surviving descendant
          // or returning this already-dead lease as if it might still work.
          recyclingGeneration = myGeneration;
          let work: Promise<void> | undefined;
          work = (async () => {
            try {
              await terminateGroupFn(server.pid, { childReaped: true }).catch((err) => {
                logger.warn('failed to terminate process group after unexpected exit', {
                  error: (err as Error).message,
                  pid: server.pid,
                });
              });
              const deadline = clock.monotonicNow() + Math.min(1000, config.cleanupTimeoutMs);
              let gone = await groupGoneFn(server.pid);
              while (!gone && clock.monotonicNow() < deadline) {
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                gone = await groupGoneFn(server.pid);
              }
              if (currentLease !== lease) return;
              const exitError = new Error(`opencode server exited unexpectedly (code=${result.code}, signal=${result.signal})`);
              if (gone) {
                currentLease = undefined;
                currentStop = undefined;
                currentPid = undefined;
                notifyUnavailable(
                  myGeneration,
                  exitError,
                  'exited',
                );
              } else {
                // Never publish the safe-execution fence for evidence we could not verify.
                // The dead lease remains owned, but acquisition rechecks the group and rejects
                // while it cannot establish the safe execution fence. Published as 'unreachable':
                // the engine/turn already
                // treat that like any other ambiguous connectivity loss (unknown, quarantined,
                // mutation markers kept), which is exactly the safe behaviour here too.
                logger.warn(
                  'managed process group could not be confirmed gone after an unexpected exit within the cleanup bound; treating the generation as unreachable, not a safe execution fence',
                  { pid: server.pid },
                );
                pendingGroupVerification = { lease, pid: server.pid, generation: myGeneration, exitError };
                notifyUnavailable(
                  myGeneration,
                  new Error(
                    `opencode server exited unexpectedly and its process group could not be confirmed gone (code=${result.code}, signal=${result.signal})`,
                  ),
                  'unreachable',
                );
              }
            } finally {
              if (recyclingGeneration === myGeneration) recyclingGeneration = undefined;
              if (invalidating === work) invalidating = undefined;
              pendingGroupCleanups.delete(work!);
            }
          })();
          // Retained in `pendingGroupCleanups` (not just fire-and-forget) so close() can await
          // this delayed SIGKILL sweep (and its confirmation poll) instead of letting the process
          // exit while it is still in flight.
          pendingGroupCleanups.add(work);
          invalidating = work;
        }
      });

      return lease;
    } catch (err) {
      await server.stop().catch(() => {});
      // r1-connection-managed-1: without this, a failed health check leaves `currentStop` pointing
      // at this now-stopped child forever (it is only ever overwritten by a later successful
      // attempt's own registration above). A close() arriving before that later attempt reaches its
      // own registration would then take this stale, already-satisfied stop handle and resolve
      // immediately without ever awaiting the later attempt's `starting` — skipping the wait for its
      // own child to actually be reaped. Only clear it if it still belongs to THIS attempt: a
      // concurrent close() may have already taken and cleared it itself.
      if (currentStop === myStop) {
        currentStop = undefined;
        currentPid = undefined;
      }
      if (err instanceof EngineError) {
        throw err;
      }
      throw new EngineError('OPENCODE_UNAVAILABLE', `opencode server failed its health check: ${(err as Error).message}`);
    } finally {
      // Cancellation no longer needs to stay in force once the health check has settled either
      // way (success, failure, or abort) — the stop handle registered above is now the sole path
      // for reclaiming this child.
      if (startupAbort === abortController) {
        startupAbort = undefined;
      }
    }
  }

  async function startAttach(req?: RequestOptions): Promise<ConnectionLease> {
    const url = validateAttachUrl(config);
    if (closed) {
      throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
    }

    const api = createApiFn({
      baseUrl: url.toString(),
      username: config.username,
      password: config.password,
      requestTimeoutMs: config.requestTimeoutMs,
      logger,
      clock,
    });

    // r1-connection-managed-4: without a startup-abort controller here, close() has nothing to
    // interrupt an in-flight attach health check with, so it just awaits `starting` until the
    // health request's own requestTimeoutMs elapses (up to 30 s by default) — mirrors the managed
    // path's F1 fix.
    const abortController = new AbortController();
    startupAbort = abortController;

    let health: { healthy: boolean; version: string };
    try {
      const healthSignal = req?.signal ? AbortSignal.any([abortController.signal, req.signal]) : abortController.signal;
      const deadlineAt = clock.monotonicNow() + Math.min(config.startupTimeoutMs, req?.timeoutMs ?? config.startupTimeoutMs);
      health = await admissionHealth(api, deadlineAt, healthSignal, Math.min(config.requestTimeoutMs, req?.timeoutMs ?? config.requestTimeoutMs));
      if (!health.healthy) {
        throw new Error('opencode server reported unhealthy status');
      }
    } catch (err) {
      throw new EngineError('OPENCODE_UNAVAILABLE', `attach health check failed: ${(err as Error).message}`);
    } finally {
      if (startupAbort === abortController) {
        startupAbort = undefined;
      }
    }

    if (closed) {
      throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
    }

    const lease: ConnectionLease = { api, generation: ++generation, version: health.version };
    currentLease = lease;
    currentStop = undefined; // attach mode never owns the remote process.
    currentPid = undefined;
    return lease;
  }

  return {
    async acquire(req?: RequestOptions): Promise<ConnectionLease> {
      if (closed) {
        throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
      }
      if (invalidating) await invalidating;
      if (closed) throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
      if (pendingGroupVerification) {
        await verifyPendingGroup();
        if (closed) throw new EngineError('OPENCODE_UNAVAILABLE', 'connection closed');
        if (pendingGroupVerification) {
          throw new EngineError('OPENCODE_UNAVAILABLE', 'opencode exited; its managed process group is not yet confirmed gone');
        }
      }
      if (currentLease) {
        return currentLease;
      }
      if (!starting) {
        const attempt = config.mode === 'attach' ? startAttach(req) : startManaged(req);
        starting = attempt.finally(() => {
          starting = undefined;
        });
      }
      return starting;
    },

    invalidate(gen: number, reason: 'unreachable' | 'hung'): Promise<void> {
      if (invalidating && currentLease?.generation === gen) return invalidating;
      if (pendingGroupVerification?.generation === gen) return verifyPendingGroup();
      if (closed || currentLease?.generation !== gen) return Promise.resolve();
      const lease = currentLease;
      if (config.mode === 'attach') {
        currentLease = undefined;
        notifyUnavailable(gen, new Error('OpenCode server unreachable'), 'unreachable');
        return Promise.resolve();
      }
      const stop = currentStop;
      const pid = currentPid;
      if (!stop || pid === undefined) return Promise.resolve();
      recyclingGeneration = gen;
      let work: Promise<void> | undefined;
      work = (async () => {
        try {
          await stop();
          // stop() reaps the direct child and sweeps the group, but a descendant can remain
          // briefly after SIGKILL. Do not publish an execution fence until the group is gone.
          const deadline = clock.monotonicNow() + Math.min(1000, config.cleanupTimeoutMs);
          while (!(await groupGoneFn(pid))) {
            if (clock.monotonicNow() >= deadline) throw new Error('managed process group remains after stop');
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
          if (currentLease === lease) {
            currentLease = undefined;
            currentStop = undefined;
            currentPid = undefined;
            notifyUnavailable(gen, new Error(`OpenCode managed server recycled (${reason})`), 'exited');
          }
        } finally {
          if (recyclingGeneration === gen) recyclingGeneration = undefined;
          if (invalidating === work) invalidating = undefined;
        }
      })();
      invalidating = work;
      return work;
    },

    current(): ConnectionLease | undefined {
      // Deliberately does not consult `starting`: a caller on this path (cleanup/shutdown) must
      // never trigger or wait for a server start, only observe one that is already up.
      return currentLease;
    },

    onUnavailable(listener: (generation: number, error: Error, kind: 'exited' | 'unreachable') => void): () => void {
      unavailableListeners.add(listener);
      return () => unavailableListeners.delete(listener);
    },

    close(): Promise<void> {
      // Memoized: every caller (including the first) gets the exact same promise, which only
      // resolves once the full termination sweep is actually done. The old `if (closed) return;`
      // short-circuit made a *second* concurrent close() resolve immediately while the first was
      // still mid-termination — e.g. engine.shutdown()'s own internal close() call racing against
      // index.ts's explicit safety-net close() call — letting the process exit before the managed
      // child was actually gone.
      if (!closePromise) {
        closePromise = (async () => {
          closed = true;
          // A managed startup in flight is not awaited passively: abort it so a not-yet-ready
          // child is killed right away, rather than waiting out the full startup timeout for
          // `starting` to settle on its own. This same signal also now reaches an in-flight health
          // check (F1), so `starting` itself settles promptly too in that case.
          startupAbort?.abort();
          currentLease = undefined;
          pendingGroupVerification = undefined;
          const stop = currentStop;
          currentStop = undefined;
          currentPid = undefined;
          if (stop) {
            // A child has already been registered (readiness was reported) — reclaim it directly.
            // Deliberately does NOT wait for `starting` first: `starting` covers the health check
            // too, which can be slow or effectively hung (F1), and the child must not be left
            // running unsupervised for that whole duration just because our own bookkeeping
            // promise hasn't settled yet. `starting`'s own eventual settlement (swallowed by
            // startManaged()'s catch, which no-ops on an already-stopped child) is not needed for
            // correctness once the child itself is confirmed terminated below.
            await stop();
          } else if (starting) {
            // No child has been registered yet: either nothing was ever spawned, or the abort
            // above is what will make the spawn/readiness wait fail and clean up after itself.
            await starting.catch(() => {});
          }
          // Await any outstanding unexpected-exit process-group sweeps too (R5): a delayed
          // SIGKILL sweep must finish before close() resolves, not race the process exiting.
          await Promise.allSettled([...pendingGroupCleanups]);
        })();
      }
      return closePromise;
    },
  };
}
