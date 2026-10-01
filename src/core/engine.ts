import { EngineError, OpencodeHttpError } from '../types.ts';
import { randomUUID } from 'node:crypto';
import type {
  CallContext,
  ConnectionLease,
  Engine,
  EngineDeps,
  EndAction,
  EndResult,
  ListResult,
  OcSession,
  PromptBody,
  RequestOptions,
  ReplyInput,
  SessionSummary,
  StartInput,
  TurnResult,
  OutputInput,
  OutputResult,
  InfoInput,
  InfoResult,
  BatchStatusInput,
  BatchResult,
} from '../types.ts';
import { EventHub } from './hub.ts';
import { resolveWorkingDirectory } from './paths.ts';
import { sessionRulesFor } from './policy.ts';
import { Registry } from './registry.ts';
import type { Admission, MutationKind, MutationMarker, QuarantineRecovery, TrackedSession } from './registry.ts';
import { buildContextResult, classifyOutcome, compactResult, contextOverflowHint, extractInterval, extractOutputArtifacts, submissionEvidence, summarizeInterval } from './result.ts';
import { Turn } from './turn.ts';
import { estimatePromptTokens, projectModelLimits, promptTooLargeMessage, resolveModelLimit } from './model-limits.ts';
import type { ModelLimit, ResolvedModelLimit } from './model-limits.ts';
import { OutputStore, DEFAULT_OUTPUT_STORE_LIMITS, refreshOutputMeta } from './output-store.ts';
import { captureTarget, createBatchElicitor, observeTarget, snapshotTarget } from './observe-many.ts';
import type { StoreError } from './output-store.ts';
import { validateOutputSchema, buildStructuredOutputInstruction } from './structured-output.ts';
import type { OutputSchema } from './structured-output.ts';
import { RequestRegistry, requestFingerprint, DEFAULT_REQUEST_REGISTRY_LIMITS } from './request-registry.ts';
import type { RequestRecord, RequestTool } from './request-registry.ts';
import { CatalogCache, pageItems, projectAgents, projectModels, validId } from './discovery.ts';
import { SERVER_VERSION } from '../version.ts';
import { ConnectionHealth } from './connection-health.ts';
import { withReadRetry, isRetryableReadError } from '../opencode/retry.ts';
import { RunSlots, runLimits } from './run-slots.ts';
import type { RunTicket } from './run-slots.ts';
import { PROVIDER_CATALOG_MAX_BYTES } from '../opencode/http.ts';
import type { OpencodeApiRetryable } from '../opencode/http.ts';

/** Diff snapshots refresh independently of the one-hour retained turn artifact. */
const DIFF_SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_COMMITTED_RESULTS = 256;

// U06 (r1-hostile-opencode-3): mirror turn.ts's page cap for the quiescence-recovery read path.
const MAX_INTERVAL_PAGES = 50;

function model(value: string | undefined): PromptBody['model'] {
  if (value === undefined) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1)
    throw new EngineError('INVALID_ARGUMENT', 'Model must be provider/model');
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}
function positivePrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim())
    throw new EngineError('INVALID_ARGUMENT', 'Prompt must be non-empty');
}
function waitValue(value: number | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new EngineError('INVALID_ARGUMENT', `waitSeconds must be an integer from 0 to ${max}`);
  return value;
}
function turnWaitValue(value: number | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0)
    throw new EngineError('INVALID_ARGUMENT', 'waitSeconds must be a non-negative integer');
  return Math.min(value, max);
}
function timeoutValue(value: number | undefined, defaultMs: number, maxMs: number): number {
  if (value === undefined) return defaultMs;
  if (!Number.isInteger(value) || value < 1)
    throw new EngineError('INVALID_ARGUMENT', 'timeoutSeconds must be a positive integer');
  return Math.min(value * 1000, maxMs);
}
function upstream(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof OpencodeHttpError)
    return new EngineError(error.errorName === 'ResponseTooLarge' ? 'UPSTREAM_RESPONSE_TOO_LARGE' :
      error.classification === 'overloaded' ? 'OPENCODE_OVERLOADED' :
      error.status === 0 ? 'OPENCODE_UNAVAILABLE' : 'UPSTREAM_ERROR', error.message.slice(0, 500), undefined,
      error.classification === 'overloaded' && error.retryAfterSeconds !== undefined
        ? Math.min(3600, error.retryAfterSeconds) : undefined);
  return new EngineError('OPENCODE_UNAVAILABLE', error instanceof Error ? error.message : String(error));
}
/** Only a confirmed HTTP rejection (4xx) proves the create never happened upstream. OpenCode
 * 1.18.33 never emits 429 for createSession/promptAsync, so this deployment's rate-limiting proxy
 * rejected such a request before forwarding it. Status 0
 * (network/timeout/abort), 5xx (forwarded but the outcome upstream is unknown) and a 2xx whose body
 * was malformed/oversized/carried an invalid session id (ProtocolError/ResponseTooLarge — the POST
 * itself plainly succeeded) must all be treated as ambiguous, never as "never happened". */
function isConfirmedRejection(error: OpencodeHttpError): boolean {
  return error.status >= 400 && error.status < 500;
}
function outputPage<T extends { ok: true }>(value: T | StoreError, sessionId: string): T {
  if (!value.ok) throw new EngineError(value.code, value.message, sessionId);
  return value;
}

/** Create the process-owned session engine and its lifecycle gate. */
export function createEngine(deps: EngineDeps): Engine {
  const { config, connection, clock, logger } = deps;
  const registry = new Registry();
  const limits = runLimits(config);
  const slots = new RunSlots(limits, clock);
  const pendingStarts = new Set<RunTicket>();
  const heldTickets = new Map<string, Set<RunTicket>>();
  const releaseHeld = (sessionId: string): void => {
    const held = heldTickets.get(sessionId);
    heldTickets.delete(sessionId);
    for (const ticket of held ?? []) ticket.release();
  };
  const releaseHeldTicket = (sessionId: string, ticket: RunTicket): void => {
    const held = heldTickets.get(sessionId);
    if (!held?.delete(ticket)) return;
    if (held.size === 0) heldTickets.delete(sessionId);
    ticket.release();
  };
  const outputStore = new OutputStore(clock);
  const serverInstanceId = randomUUID();
  const requests = new RequestRegistry(clock, serverInstanceId);
  const catalogs = new CatalogCache(clock);
  // U4b: per-generation/directory model-limits cache fed by a successful warm-up (context-
  // concurrency design §5.3) — separate from the paging snapshot cache above. Bounded LRU with a
  // TTL on the injected clock, plus a global invalidation epoch so a warm that started before an
  // invalidation can never repopulate a key after it (checked by storeLimits below).
  const MAX_LIMITS_CACHE_ENTRIES = 64;
  const LIMITS_CACHE_TTL_MS = 60_000;
  const limitsCache = new Map<string, { limits: Map<string, ModelLimit>; expiresAtMono: number }>();
  let limitsEpoch = 0;
  const limitsCacheKey = (generation: number, directory: string): string => `${generation}\0${directory}`;
  const invalidateLimits = (prefix: string): void => {
    limitsEpoch++;
    for (const key of limitsCache.keys()) if (key.startsWith(prefix)) limitsCache.delete(key);
  };
  const storeLimits = (generation: number, directory: string, providerCatalog: unknown, epochAtStart: number): void => {
    if (limitsEpoch !== epochAtStart) return;
    const key = limitsCacheKey(generation, directory);
    limitsCache.delete(key);
    limitsCache.set(key, { limits: projectModelLimits(providerCatalog), expiresAtMono: clock.monotonicNow() + LIMITS_CACHE_TTL_MS });
    while (limitsCache.size > MAX_LIMITS_CACHE_ENTRIES) {
      const oldestKey = limitsCache.keys().next().value;
      if (oldestKey === undefined) break;
      limitsCache.delete(oldestKey);
    }
  };
  /** Profiles apply even when the cache is cold or `generation` is unknown. */
  const limitsFor = (generation: number | undefined, directory: string, modelName: string): ResolvedModelLimit | undefined => {
    let upstream: ModelLimit | undefined;
    if (generation !== undefined) {
      const key = limitsCacheKey(generation, directory);
      const entry = limitsCache.get(key);
      if (entry) {
        if (clock.monotonicNow() >= entry.expiresAtMono) limitsCache.delete(key);
        else {
          // LRU touch.
          limitsCache.delete(key);
          limitsCache.set(key, entry);
          upstream = entry.limits.get(modelName);
        }
      }
    }
    return resolveModelLimit(modelName, upstream, config.modelProfiles?.[modelName]);
  };
  /** U4b prompt-size guard pre-check (context-concurrency design §5.4); synchronous, no awaits. */
  const checkPromptSize = (
    modelName: string | undefined,
    generation: number | undefined,
    directory: string,
    prompt: string,
    system: string,
  ): void => {
    if ((config.contextGuard ?? 'reject') === 'off' || !modelName) return;
    const usable = limitsFor(generation, directory, modelName)?.usableInputTokens;
    if (usable === undefined) return;
    const estimated = estimatePromptTokens(prompt + system);
    if (estimated > usable)
      throw new EngineError('PROMPT_TOO_LARGE', promptTooLargeMessage(modelName, estimated, usable));
  };
  const committedResults = new Map<string, Map<number, TurnResult>>();
  const committedOrder = new Map<string, { sessionId: string; turn: number }>();
  type KeyedReceipt = Pick<TurnResult, 'sessionId' | 'turnId' | 'turn' | 'status' | 'executionState' | 'cleanup'> &
    Pick<TurnResult, 'error' | 'finish' | 'warnings' | 'resendSafety' | 'upstreamRetry' | 'upstreamRead' | 'responseLoop'> &
    { admissionError?: { code: string; message: string; retryAfterSeconds?: number }; expiresAtMonotonic?: number };
  // At most one small receipt per request registry record (4096 maximum).
  const keyedFallbacks = new Map<string, KeyedReceipt>();
  // Receipts copy normalized scalar fields only. Never retain raw provider bodies or headers.
  let acquireAttempted = false;
  const diffFetches = new Map<string, Promise<void>>();
  const hub = new EventHub(connection, clock, config);
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let version: string | undefined;
  const warmed = new Map<string, Promise<void>>();
  type DirectoryRecovery = {
    directory: string;
    generation: number;
    phase: 'disposing' | 'retrying' | 'quarantined';
    settled: Promise<void>;
    resolve: () => void;
    inFlight: Set<Promise<boolean>>;
    latestAttempt: number;
    confirmedAttempt: number;
  };
  // A reservation is published synchronously before disposal can yield.
  const recovering = new Map<string, DirectoryRecovery>();
  const pendingPoison = new Map<string, number>();
  const healthMonitors = new Map<number, ConnectionHealth>();
  const healthFor = (lease: ConnectionLease): ConnectionHealth => {
    let monitor = healthMonitors.get(lease.generation);
    if (!monitor) {
      monitor = new ConnectionHealth(lease, connection, clock, config);
      healthMonitors.set(lease.generation, monitor);
      for (const generation of healthMonitors.keys()) if (generation !== lease.generation) healthMonitors.delete(generation);
    }
    return monitor;
  };
  const active = () => {
    if (shuttingDown) throw new EngineError('SHUTTING_DOWN', 'Engine is shutting down');
  };
  const acquire = async (req?: RequestOptions) => {
    acquireAttempted = true;
    try {
      const lease = await connection.acquire(req);
      version = lease.version;
      return lease;
    } catch (error) {
      throw upstream(error);
    }
  };
  const remaining = (deadline: number): number => {
    const left = deadline - clock.monotonicNow();
    if (left <= 0) throw new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup deadline expired');
    return Math.max(1, Math.ceil(left));
  };
  const withinCleanup = async <T>(work: Promise<T>, deadline: number): Promise<T> => {
    let cancel = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          cancel = clock.schedule(remaining(deadline), () =>
            reject(new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup deadline expired')),
          );
        }),
      ]);
    } finally {
      cancel();
    }
  };
  const cleanupPause = async (deadline: number, failures: number, error?: unknown): Promise<void> => {
    const cap = Math.min(2_000, 250 * 2 ** Math.min(failures - 1, 4));
    const retryAfter = error instanceof OpencodeHttpError && error.retryAfterSeconds !== undefined
      ? Math.min(3_600_000, error.retryAfterSeconds * 1000) : 0;
    const delay = Math.max(100, Math.random() * cap, retryAfter);
    if (delay >= remaining(deadline))
      throw new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup retry exceeds deadline');
    await withinCleanup(new Promise<void>((resolve) => {
      clock.schedule(delay, resolve);
    }), deadline);
  };
  const clearWarm = (directory: string): void => {
    for (const key of warmed.keys()) if (key.endsWith(`\0${directory}`)) warmed.delete(key);
    catalogs.invalidate('');
    invalidateLimits('');
  };
  const releaseDirectory = (state: DirectoryRecovery): void => {
    if (recovering.get(state.directory) !== state) return;
    recovering.delete(state.directory);
    clearWarm(state.directory);
    state.resolve();
  };
  const disposalPending = (directory: string): EngineError =>
    new EngineError(
      'OPENCODE_UNAVAILABLE',
      `OpenCode directory instance for ${directory} is being recovered; retry later`,
    );
  const attemptDispose = async (state: DirectoryRecovery, lease: ConnectionLease): Promise<void> => {
    const attempt = ++state.latestAttempt;
    const request = Promise.resolve().then(() =>
      lease.api.disposeInstance(state.directory, { timeoutMs: config.cleanupTimeoutMs }),
    );
    // A later successful retry cannot admit work while an older disposal may still land.
    state.inFlight.add(request);
    void request.then(
      (disposed) => {
        state.inFlight.delete(request);
        if (disposed) state.confirmedAttempt = Math.max(state.confirmedAttempt, attempt);
        if (state.confirmedAttempt === state.latestAttempt && state.inFlight.size === 0)
          releaseDirectory(state);
      },
      () => {
        state.inFlight.delete(request);
        if (state.confirmedAttempt === state.latestAttempt && state.inFlight.size === 0)
          releaseDirectory(state);
      },
    );
    try {
      const disposed = await withinCleanup(request, clock.monotonicNow() + config.cleanupTimeoutMs);
      if (!disposed) throw disposalPending(state.directory);
      state.confirmedAttempt = Math.max(state.confirmedAttempt, attempt);
      if (state.confirmedAttempt === state.latestAttempt && state.inFlight.size === 0)
        releaseDirectory(state);
      if (recovering.get(state.directory) === state) throw disposalPending(state.directory);
    } catch {
      throw disposalPending(state.directory);
    } finally {
      if (recovering.get(state.directory) === state) {
        state.phase = 'quarantined';
        state.resolve();
      }
    }
  };
  const hasInFlight = (entry: TrackedSession): boolean =>
    [...(entry.unresolvedMutations?.values() ?? [])].some((marker) => !marker.settled);
  const abortWindowMs = Math.max(2 * (config.requestTimeoutMs || 5_000), 60_000);
  const hasAnyAbort = (entry: TrackedSession): boolean =>
    [...(entry.unresolvedMutations?.values() ?? [])].some((marker) => marker.kind === 'abort');
  const hasAbort = (entry: TrackedSession): boolean =>
    [...(entry.unresolvedMutations?.values() ?? [])].some((marker) =>
      marker.kind === 'abort' &&
      (marker.settledAt === undefined || clock.monotonicNow() - marker.settledAt < abortWindowMs));
  const releaseExpiredAborts = (entry: TrackedSession): void => {
    // After a bounded late-landing window, availability wins: a late abort can only end the
    // next turn cancelled/TURN_INCOMPLETE with the unsolicited-abort hint, never completed.
    for (const [key, marker] of entry.unresolvedMutations ?? [])
      if (marker.kind === 'abort' && marker.settledAt !== undefined &&
          clock.monotonicNow() - marker.settledAt >= abortWindowMs)
        entry.unresolvedMutations?.delete(key);
  };
  const blocksDisposal = (directory: string, excluded?: TrackedSession): boolean =>
    registry.all().some((entry) =>
      entry !== excluded &&
      entry.directory === directory &&
      (entry.admission !== undefined ||
        (entry.current !== undefined &&
          ['admitting', 'submitting', 'running', 'stopping'].includes(entry.current.phase)) ||
        [...(entry.unresolvedMutations?.values() ?? [])].some(
          (marker) => !marker.settled &&
            (marker.kind === 'abort' || marker.kind === 'delete' || marker.kind === 'archive'),
        )),
    );
  const startRecovery = (directory: string, lease: ConnectionLease): Promise<void> => {
    if (recovering.has(directory)) throw disposalPending(directory);
    pendingPoison.delete(directory);
    let resolveRecovery = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const state: DirectoryRecovery = {
      directory,
      generation: lease.generation,
      phase: 'disposing',
      settled,
      resolve: resolveRecovery,
      inFlight: new Set<Promise<boolean>>(),
      latestAttempt: 0,
      confirmedAttempt: 0,
    };
    recovering.set(directory, state);
    // Disposal can abort an idle quarantined sibling's upstream runner. Its local
    // result stays unknown; only later status/cancel inspection with terminal
    // evidence (or generation-loss evidence) may mark that sibling stopped.
    return attemptDispose(state, lease);
  };
  const rearmPending = (directory: string, lease: ConnectionLease): void => {
    if (pendingPoison.get(directory) !== lease.generation ||
      connection.current()?.generation !== lease.generation ||
      recovering.has(directory) || blocksDisposal(directory)) return;
    void startRecovery(directory, lease).catch(() => {
      // The quarantined recovery state remains available for a bounded retry.
    });
  };
  const clearSettled = (entry: TrackedSession, kind: MutationKind): void => {
    // Used after an explicit, successful same-action end retry. Ambiguous aborts are released
    // separately, after their late-landing window and a valid idle observation.
    for (const [key, marker] of entry.unresolvedMutations ?? [])
      if (marker.kind === kind && marker.settled) entry.unresolvedMutations?.delete(key);
  };
  const refreshOutput = (result: TurnResult): TurnResult => {
    if (result.turn < 1 || !result.output) return result;
    const meta = outputStore.meta(result.sessionId, result.turn);
    const output = refreshOutputMeta(result.output, meta, clock.wallNow());
    return output === result.output ? result : { ...result, output };
  };
  const settleRecovered = (entry: TrackedSession, recovered?: TurnResult, ticket?: RunTicket): void => {
    const result = recovered ?? entry.last;
    if (!result || result.executionState !== 'stopped') return;
    if (ticket) releaseHeldTicket(entry.id, ticket);
    else releaseHeld(entry.id);
    requests.settleTurn(entry.id, result.turnId);
    // Refresh only an already-retained copy, so the per-session/process caps stay accounted.
    const retained = committedResults.get(entry.id);
    if (retained?.has(result.turn)) retained.set(result.turn, compactResult(result));
    for (const fallback of keyedFallbacks.values()) {
      if (fallback.turnId !== result.turnId) continue;
      fallback.status = result.status;
      fallback.executionState = result.executionState;
      fallback.cleanup = result.cleanup;
      fallback.error = result.error;
      fallback.finish = result.finish;
      fallback.warnings = result.warnings;
      fallback.resendSafety = result.resendSafety;
      fallback.upstreamRetry = result.upstreamRetry;
      fallback.upstreamRead = result.upstreamRead;
      fallback.responseLoop = result.responseLoop;
      fallback.expiresAtMonotonic = clock.monotonicNow() + DEFAULT_REQUEST_REGISTRY_LIMITS.ttlMs;
    }
    const turnRecord = entry.turnRecords?.get(result.turn);
    if (turnRecord) turnRecord.executionState = 'stopped';
  };
  const trackMutation = <T>(
    entry: TrackedSession,
    work: Promise<T>,
    kind: MutationKind,
    generation: number,
  ): Promise<T> => {
    const marker = Symbol('upstream mutation');
    const unresolved = (entry.unresolvedMutations ??= new Map<symbol, MutationMarker>());
    unresolved.set(marker, { kind, generation, settled: false });
    const rearm = () => {
      const lease = connection.current();
      if (lease?.generation === generation) rearmPending(entry.directory, lease);
    };
    void work.then(
      () => {
        unresolved.delete(marker);
        rearm();
      },
      (error: unknown) => {
        if (error instanceof OpencodeHttpError &&
            (kind === 'reply' || kind === 'question'
              ? error.status > 0 && error.status < 500
              : error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429))
          unresolved.delete(marker);
        else {
          const current = unresolved.get(marker);
          if (!current) return;
          if (kind === 'reply' || kind === 'question') {
            // A late reject for a vanished request is harmless; admission re-lists leftovers.
            unresolved.delete(marker);
          } else {
            current.settled = true;
            if (kind === 'abort') current.settledAt = clock.monotonicNow();
          }
        }
        rearm();
      },
    );
    return work;
  };
  const unavailableOff = connection.onUnavailable((generation, _error, kind) => {
    // An attached server may resume the same runner. Its outstanding mutations and disposal
    // attempts remain live until later evidence settles them; generation change alone is no fence.
    if (kind === 'unreachable') {
      for (const key of warmed.keys()) if (key.startsWith(`${generation}\0`)) warmed.delete(key);
      catalogs.invalidate(`${generation}\0`);
      invalidateLimits(`${generation}\0`);
      return;
    }
    for (const state of recovering.values()) if (state.generation === generation) releaseDirectory(state);
    for (const [directory, pendingGeneration] of pendingPoison)
      if (pendingGeneration === generation) pendingPoison.delete(directory);
    for (const key of warmed.keys()) if (key.startsWith(`${generation}\0`)) warmed.delete(key);
    catalogs.invalidate(`${generation}\0`);
    invalidateLimits(`${generation}\0`);
    for (const entry of registry.all()) {
      for (const [key, marker] of entry.unresolvedMutations ?? [])
        if (marker.generation === generation) {
          entry.unresolvedMutations?.delete(key);
        }
      const lastRecord = entry.last && entry.turnRecords?.get(entry.last.turn);
      if (!entry.unresolvedMutations?.size && entry.last?.executionState === 'unknown' &&
          lastRecord?.generation === generation) {
        entry.last = { ...entry.last, executionState: 'stopped', cleanup: 'complete' };
        settleRecovered(entry);
        if (entry.phase === 'quarantined' && !entry.endFailure) entry.phase = 'idle';
      }
    }
  });
  const warmDirectory = async (lease: ConnectionLease, directory: string, entry?: TrackedSession, admissionDeadline?: number): Promise<void> => {
    while (true) {
      const pendingGeneration = pendingPoison.get(directory);
      if (pendingGeneration !== undefined) {
        if (pendingGeneration > lease.generation) throw disposalPending(directory);
        if (pendingGeneration < lease.generation) {
          if (config.mode === 'attach') pendingPoison.set(directory, lease.generation);
          else pendingPoison.delete(directory);
        }
        if (pendingPoison.has(directory) && !recovering.has(directory)) {
          if (blocksDisposal(directory, entry)) throw disposalPending(directory);
          await startRecovery(directory, lease);
          continue;
        }
      }
      const state = recovering.get(directory);
      if (!state) break;
      if (state.generation !== lease.generation) {
        if (state.generation > lease.generation) throw disposalPending(directory);
        if (config.mode === 'attach') state.generation = lease.generation;
        else { releaseDirectory(state); break; }
      }
      if (state.phase === 'disposing') {
        await state.settled;
        continue;
      }
      if (state.phase === 'retrying') throw disposalPending(directory);
      let resolve = () => {};
      state.settled = new Promise<void>((done) => {
        resolve = done;
      });
      state.resolve = resolve;
      state.phase = 'retrying';
      await attemptDispose(state, lease);
    }
    const key = `${lease.generation}\0${directory}`;
    const existing = warmed.get(key);
    if (existing) return existing;
    const timeoutMs = config.startupTimeoutMs || config.sseStallMs * 2;
    const epochAtWarmStart = limitsEpoch;
    const task = (async () => {
      let cancel = () => {};
      try {
        const result = await Promise.race([
          admissionDeadline === undefined
            ? lease.api.warmInstance(directory, { timeoutMs })
            : (() => {
                const api = lease.api as OpencodeApiRetryable;
                return api.warmInstanceWithRetry
                  ? api.warmInstanceWithRetry(directory, { deadlineAt: admissionDeadline, maxAttempts: config.readRetryAttempts })
                  : withReadRetry(({ timeoutMs: attemptMs }) => api.warmInstance(directory, { timeoutMs: attemptMs }), {
                      deadlineAt: admissionDeadline, maxAttempts: config.readRetryAttempts,
                      requestTimeoutMs: config.requestTimeoutMs || 30_000, clock,
                    });
              })(),
          new Promise<never>((_resolve, reject) => {
            cancel = clock.schedule(timeoutMs, () =>
              reject(new EngineError('OPENCODE_UNAVAILABLE', 'OpenCode instance warm-up timed out')),
            );
          }),
        ]);
        storeLimits(lease.generation, directory, result.providerCatalog, epochAtWarmStart);
      } catch (error) {
        throw upstream(error);
      } finally {
        cancel();
      }
    })();
    warmed.set(key, task);
    const clear = () => {
      if (warmed.get(key) === task) warmed.delete(key);
    };
    void task.then(clear, clear);
    return task;
  };
  // U4b: factored out of bodyFor so the prompt guard (checkPromptSize) measures exactly the
  // prompt + system text the body would send (base/developer instructions and structured-output
  // instructions included) — context-concurrency design §5.4.
  const systemTextFor = (base: string | undefined, developer: string | undefined, schema?: OutputSchema): string =>
    [base, developer, ...(schema ? [buildStructuredOutputInstruction(schema)] : [])]
      .filter((x) => x !== undefined && x !== '')
      .join('\n\n');
  const bodyFor = (entry: TrackedSession, prompt: string, schema?: OutputSchema): PromptBody => {
    const system = systemTextFor(entry.baseInstructions, entry.developerInstructions, schema);
    return {
      parts: [{ type: 'text', text: prompt }],
      ...(model(entry.model) ? { model: model(entry.model) } : {}),
      ...(entry.agent ? { agent: entry.agent } : {}),
      ...(system ? { system } : {}),
    };
  };
  const rejectLeftovers = async (entry: TrackedSession, allowAcquire = true): Promise<void> => {
    const deadline = clock.monotonicNow() + config.cleanupTimeoutMs;
    const lease = allowAcquire ? await acquire() : connection.current();
    if (!lease) {
      logger.warn('Cleanup skipped because OpenCode has no live lease', { sessionId: entry.id });
      return;
    }
    const api = lease.api;
    for (const request of await withinCleanup(
      api.listPermissions(entry.directory, { timeoutMs: remaining(deadline) }),
      deadline,
    ))
      if (request.sessionID === entry.id)
        await withinCleanup(
          trackMutation(
            entry,
            api.replyPermission(entry.directory, request.id, 'reject', undefined, {
              timeoutMs: remaining(deadline),
            }),
            'reply',
            lease.generation,
          ),
          deadline,
        );
    for (const question of await withinCleanup(
      api.listQuestions(entry.directory, { timeoutMs: remaining(deadline) }),
      deadline,
    ))
      if (question.sessionID === entry.id)
        await withinCleanup(
          trackMutation(
            entry,
            api.rejectQuestion(entry.directory, question.id, { timeoutMs: remaining(deadline) }),
            'question',
            lease.generation,
          ),
          deadline,
        );
  };
  const launch = (
    entry: TrackedSession,
    prompt: string,
    timeoutMs: number,
    ctx: CallContext,
    waitSeconds: number | undefined,
    schema?: OutputSchema,
    keyed?: { record: RequestRecord; onTurn: (turn: Turn) => void },
    suppliedAdmissionDeadlineAt?: number,
    ticket?: RunTicket,
    onTicketTransfer?: () => void,
  ): Promise<TurnResult> => {
    const admissionDeadlineAt = suppliedAdmissionDeadlineAt ??
      clock.monotonicNow() + (config.startupTimeoutMs || config.sseStallMs * 2);
    let resolveAdmission = () => {};
    let resolveCreated: (turn: Turn | undefined) => void = () => {};
    const admission: Admission = {
      stopRequested: false,
      settled: new Promise<void>((resolve) => {
        resolveAdmission = resolve;
      }),
      created: new Promise<Turn | undefined>((resolve) => {
        resolveCreated = resolve;
      }),
    };
    // Reserve an awaitable admission synchronously, before connection acquisition.
    entry.admission = admission;
    const createTurn = async (): Promise<Turn> => {
      let turnBuilt = false;
      let recoveryLease: ConnectionLease | undefined;
      try {
        const admissionRemaining = admissionDeadlineAt - clock.monotonicNow();
        if (admissionRemaining <= 0)
          throw new EngineError('OPENCODE_UNAVAILABLE', 'Turn admission deadline expired', entry.id);
        const lease: ConnectionLease = await acquire({ timeoutMs: admissionRemaining });
        recoveryLease = lease;
        entry.generation = lease.generation;
        const turn = new Turn(
          entry,
          entry.turns + 1,
          lease,
          connection,
          hub,
          clock,
          config,
          logger,
          (deadlineAt) => warmDirectory(lease, entry.directory, entry, deadlineAt),
          healthFor(lease),
          () => recovering.get(entry.directory)?.settled,
          <T>(work: Promise<T>, kind: MutationKind) => trackMutation(entry, work, kind, lease.generation),
          (result) => {
            const commit = () => {
              const artifacts = turn.outputArtifacts;
              const record = {
                turnId: turn.id, turn: turn.number, submittedUserId: turn.submittedUserId,
                boundary: turn.historyBoundary, terminalBoundary: turn.terminalBoundary,
                submissionDispatched: turn.wasSubmissionDispatched,
                executionObserved: turn.executionWasObserved,
                highestObservedMessageId: turn.highestObservedMessage,
                observedMessageIds: turn.observedMessageHistory,
                observedMessageCount: turn.observedMessageTotal,
                activityObserved: turn.observedActivity,
                maxToolCallCount: turn.maxObservedToolCallCount,
                stopCleanupPending: turn.needsStopCleanup,
                ...(turn.admissionError ? { admissionError: {
                  code: turn.admissionError.code, message: turn.admissionError.message,
                  retryAfterSeconds: turn.admissionError.retryAfterSeconds } } : {}),
                directory: entry.directory, generation: lease.generation,
                executionState: result.executionState, compacted: artifacts.compacted,
              };
              const records = entry.turnRecords ?? (entry.turnRecords = new Map());
              records.set(turn.number, record);
              while (records.size > 128) records.delete(records.keys().next().value!);
              result.output = outputStore.put({ sessionId: entry.id, turnId: turn.id, turn: turn.number,
                partial: result.output?.partial === true || result.status !== 'completed' || result.executionState !== 'stopped',
                answer: artifacts.answer, toolCalls: artifacts.toolCalls,
                ...(result.structuredOutputStatus === 'valid' && result.structuredOutput !== undefined
                  ? { structured: JSON.stringify(result.structuredOutput) } : {}),
              });
              const results = committedResults.get(entry.id) ?? new Map<number, TurnResult>();
              if (!committedResults.has(entry.id)) committedResults.set(entry.id, results);
              results.set(turn.number, compactResult(result));
              const committedKey = `${entry.id}\0${turn.number}`;
              committedOrder.set(committedKey, { sessionId: entry.id, turn: turn.number });
              while (results.size > 64) {
                const oldest = results.keys().next().value!;
                results.delete(oldest);
                committedOrder.delete(`${entry.id}\0${oldest}`);
              }
              while (committedOrder.size > MAX_COMMITTED_RESULTS) {
                const [oldKey, old] = committedOrder.entries().next().value!;
                committedOrder.delete(oldKey);
                const oldResults = committedResults.get(old.sessionId);
                oldResults?.delete(old.turn);
                if (oldResults?.size === 0) committedResults.delete(old.sessionId);
              }
              if (keyed) {
                if (result.executionState === 'stopped') requests.settleTurn(entry.id, turn.id);
                const now = clock.monotonicNow();
                for (const [id, old] of keyedFallbacks)
                  if (old.expiresAtMonotonic !== undefined && now >= old.expiresAtMonotonic)
                    keyedFallbacks.delete(id);
                keyedFallbacks.set(keyed.record.id, {
                  sessionId: entry.id, turnId: turn.id, turn: turn.number,
                  status: result.status, executionState: result.executionState,
                  cleanup: result.cleanup,
                  error: result.error, finish: result.finish, warnings: result.warnings,
                  resendSafety: result.resendSafety, upstreamRetry: result.upstreamRetry,
                  upstreamRead: result.upstreamRead, responseLoop: result.responseLoop,
                  ...(turn.admissionError ? { admissionError: {
                    code: turn.admissionError.code,
                    message: turn.admissionError.message.slice(0, 300),
                    retryAfterSeconds: turn.admissionError.retryAfterSeconds } } : {}),
                  ...(result.executionState === 'stopped'
                    ? { expiresAtMonotonic: now + DEFAULT_REQUEST_REGISTRY_LIMITS.ttlMs } : {}),
                });
              }
              if (entry.endFailure !== undefined)
                result.hint = `opencode-end failed (${entry.endFailure}); the session is still tracked — retry opencode-end.`;
              entry.last = result;
              entry.lastSubmittedUser = turn.submittedUserId;
              entry.updatedAt = clock.wallNow();
              if (entry.phase !== 'ending')
                entry.phase = result.executionState === 'unknown' || result.cleanup === 'unconfirmed' ||
                  entry.endFailure !== undefined ? 'quarantined' : 'idle';
              entry.current = undefined;
              rearmPending(entry.directory, lease);
            };
            const poisoned =
              result.error?.name === 'UnknownError' &&
              result.error.message.includes('All fibers interrupted without error');
            if (!poisoned) {
              commit();
              return;
            }
            if (config.mode !== 'managed') {
              result.hint =
                'OpenCode reported a poisoned directory instance. Ask an administrator to dispose or restart the shared OpenCode server.';
              commit();
              return;
            }
            if (connection.current()?.generation !== lease.generation) {
              result.hint = 'The OpenCode server changed after this turn began. Retry on the current server.';
              commit();
              return;
            }
            if (recovering.has(entry.directory)) {
              result.hint = 'OpenCode instance recovery is pending. Retry later after disposal succeeds or the server restarts.';
              commit();
              return;
            }
            if (blocksDisposal(entry.directory, entry)) {
              pendingPoison.set(entry.directory, lease.generation);
              result.hint = 'OpenCode instance recovery must wait for other active turns in this directory.';
              commit();
              return;
            }
            logger.warn('OpenCode directory instance poisoned; resetting', {
              sessionId: entry.id,
              generation: lease.generation,
            });
            return (async () => {
              try {
                await startRecovery(entry.directory, lease);
                result.hint =
                  'The OpenCode instance was reset after an upstream error. You may retry with opencode-reply.';
              } catch {
                result.hint =
                  'OpenCode instance recovery is pending. Retry later after disposal succeeds or the server restarts.';
              } finally {
                commit();
              }
            })();
          },
          schema,
          admissionDeadlineAt,
          ticket,
          limits.queueTimeoutMs,
          (held) => {
            const set = heldTickets.get(entry.id) ?? new Set<RunTicket>();
            set.add(held);
            heldTickets.set(entry.id, set);
          },
          (recovered) => {
            if (registry.find(entry.id) !== entry) {
              if (ticket) releaseHeldTicket(entry.id, ticket);
              return;
            }
            const wasLast = entry.last?.turnId === turn.id;
            if (wasLast)
              entry.last = { ...entry.last!, executionState: 'stopped', cleanup: recovered.cleanup,
                resendSafety: 'not_submitted', hint: recovered.hint };
            settleRecovered(entry, wasLast ? entry.last : recovered, ticket!);
            entry.updatedAt = clock.wallNow();
            if (wasLast && entry.phase !== 'ending')
              entry.phase = recovered.cleanup === 'complete' && !entry.recovery &&
                !entry.unresolvedMutations?.size && !entry.endFailure ? 'idle' : 'quarantined';
          },
          (modelName: string) => limitsFor(lease.generation, entry.directory, modelName),
        );
        entry.turns++;
        onTicketTransfer?.();
        entry.current = turn;
        turnBuilt = true;
        keyed?.onTurn(turn);
        resolveCreated(turn);
        if (entry.phase !== 'ending') entry.phase = 'admitting';
        if (admission.stopRequested || shuttingDown || entry.phase === 'ending') void turn.stop('cancelled');
        else turn.start(bodyFor(entry, prompt, schema), timeoutMs);
        return turn;
      } catch (error) {
        // No turn was constructed and no POST was sent, so the prior result remains reusable.
        // Shutdown already blocks later calls through active(), and 'ending' keeps its phase.
        if (entry.phase !== 'ending') entry.phase = entry.endFailure !== undefined ? 'quarantined' : 'idle';
        if (error instanceof EngineError && !error.sessionId)
          error = new EngineError(error.code, error.message, entry.id, error.retryAfterSeconds);
        if (!turnBuilt && !entry.last) {
          entry.last = {
            kind: 'turn',
            threadId: entry.id,
            sessionId: entry.id,
            turnId: `${entry.id}#0`,
            turn: 0,
            status: 'failed',
            executionState: 'stopped',
            cleanup: 'complete',
            resendSafety: 'not_submitted',
            content: 'The first turn failed before it was sent to OpenCode.',
            directory: entry.directory,
            filesChanged: [],
            toolCalls: [],
            toolCallCount: 0,
            pendingApprovals: [],
            error: {
              name: error instanceof EngineError ? error.code : 'INTERNAL',
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: 0,
            truncated: false,
            hint: 'Use opencode-reply to retry or opencode-end to remove the session.',
          };
          entry.updatedAt = clock.wallNow();
        }
        throw error;
      } finally {
        if (!turnBuilt) resolveCreated(undefined);
        if (entry.admission === admission) entry.admission = undefined;
        resolveAdmission();
        if (recoveryLease) rearmPending(entry.directory, recoveryLease);
      }
    };
    return createTurn().then((turn) => turn.attach(ctx, waitSeconds, true));
  };
  const clean = (entry: TrackedSession) =>
    entry.last?.executionState !== 'unknown' && entry.phase === 'idle' && !entry.unresolvedMutations?.size;
  // P3-7 (core review): the "do not resend" phrasing only fits an outcome the
  // caller can build on (completed/failed with a real answer). A rebuilt outcome of 'cancelled'
  // (e.g. killed by disposal or this recovery's own re-abort) must fall back to the generic hint,
  // matching the same status's hint from Turn.finish().
  const releaseHint = (
    entry: TrackedSession,
    submittedUser: string | undefined,
    outcomeStatus?: TurnResult['status'],
  ): string =>
    entry.endFailure !== undefined
      ? `opencode-end failed (${entry.endFailure}); the session is still tracked — retry opencode-end.`
      : entry.last?.error?.name === 'SUBMISSION_UNCONFIRMED' && submittedUser && outcomeStatus !== 'cancelled'
        ? 'The prompt did run; do not resend it. Use opencode-reply to continue.'
        : 'Use opencode-reply to continue or opencode-end to finish.';
  const inspectQuiescence = async (
    entry: TrackedSession,
    abort: boolean,
    allowAcquire: boolean,
    turnId: string,
    boundary: string | undefined,
  ): Promise<void> => {
    const ownRecord = entry.turnRecords?.get(entry.last?.turn ?? -1);
    const last = entry.last;
    if (!last || (last.executionState !== 'unknown' &&
        !(last.executionState === 'stopped' && last.cleanup === 'unconfirmed' && ownRecord?.stopCleanupPending)) ||
        last.turnId !== turnId ||
        !ownRecord || ownRecord.turnId !== turnId || !ownRecord.submissionDispatched ||
        ownRecord.boundary !== boundary) return;
    const deadline = clock.monotonicNow() + config.cleanupTimeoutMs;
    try {
      const lease = allowAcquire ? await withinCleanup(acquire(), deadline) : connection.current();
      if (!lease) {
        logger.warn('Quiescence check skipped because OpenCode has no live lease', {
          sessionId: entry.id,
        });
        return;
      }
      const api = lease.api;
      if (ownRecord.stopCleanupPending && last.executionState === 'stopped') {
        const req = () => ({ timeoutMs: Math.min(config.requestTimeoutMs || 5_000, 5_000, remaining(deadline)) });
        for (const request of await withinCleanup(api.listPermissions(entry.directory, req()), deadline))
          if (request.sessionID === entry.id)
            await withinCleanup(trackMutation(entry,
              api.replyPermission(entry.directory, request.id, 'reject', undefined, req()), 'reply', lease.generation), deadline);
        for (const question of await withinCleanup(api.listQuestions(entry.directory, req()), deadline))
          if (question.sessionID === entry.id)
            await withinCleanup(trackMutation(entry,
              api.rejectQuestion(entry.directory, question.id, req()), 'question', lease.generation), deadline);
        if (entry.last?.turnId !== turnId || entry.turnRecords?.get(last.turn) !== ownRecord) return;
        ownRecord.stopCleanupPending = false;
        // P3-1: cleanup for a response-loop stop just confirmed — the hint set when the loop
        // first stopped (unconfirmed: "Stop could not be confirmed…") is now stale; recompute it
        // to the confirmed-stop hint. Any other stop reason keeps today's recomputation (none —
        // `last.hint` carries forward unchanged).
        const loop = last.error?.name === 'UPSTREAM_RESPONSE_LOOP';
        entry.last = { ...last, cleanup: 'complete',
          resendSafety: entry.unresolvedMutations?.size ? 'unknown' :
            ownRecord.activityObserved ? 'inspect_effects' : 'no_observed_effects',
          ...(loop ? { hint: 'OpenCode was stopped after repeated unusable model responses. Check the model/gateway and inspect partial effects before trying again.' } : {}) };
        settleRecovered(entry);
        if (entry.phase !== 'ending' && !entry.endFailure) entry.phase = 'idle';
        return;
      }
      const read = async () => {
        const pages = [];
        let before: string | undefined;
        const seen = new Set<string>();
        while (true) {
          const page = await withinCleanup(
            api.messages(
              entry.id,
              { limit: 100, ...(before ? { before } : {}) },
              {
                // P3-5: share the operation deadline too, so the adapter's own page-size fallback
                // ladder cannot overrun this read's budget one rung at a time.
                timeoutMs: Math.min(config.requestTimeoutMs || 5_000, 5_000, remaining(deadline)),
                deadlineAt: deadline,
              },
            ),
            deadline,
          );
          // U06 (r1-hostile-opencode-3): an empty page can never carry the boundary or new
          // evidence; stop instead of looping forever.
          if (page.items.length === 0) break;
          pages.push(page.items);
          if (
            page.items.some((message) => message.info.id === boundary) ||
            !page.nextCursor ||
            seen.has(page.nextCursor)
          )
            break;
          if (pages.length >= MAX_INTERVAL_PAGES) {
            logger.warn('Quiescence message pagination exceeded the page cap', {
              sessionId: entry.id,
              pages: MAX_INTERVAL_PAGES,
            });
            throw new EngineError(
              'UPSTREAM_ERROR',
              `Message history pagination exceeded ${MAX_INTERVAL_PAGES} pages`,
              entry.id,
            );
          }
          seen.add(page.nextCursor);
          before = page.nextCursor;
        }
        return extractInterval(pages, boundary);
      };
      let needsAbort = abort && !hasAnyAbort(entry);
      let previousUser = entry.lastSubmittedUser;
      let firstIdleAt: number | undefined;
      let abortAcknowledgedAfterExecution = false;
      let abortAcknowledged = false;
      let executionObserved = ownRecord.executionObserved === true;
      let lastAbortAt: number | undefined;
      let failures = 0;
      while (clock.monotonicNow() < deadline) {
        if (entry.last?.turnId !== turnId || entry.turnRecords?.get(entry.last.turn) !== ownRecord) return;
        if (hasInFlight(entry) || (!abort && hasAbort(entry))) return;
        if (needsAbort && (lastAbortAt === undefined || clock.monotonicNow() - lastAbortAt >= 1_000)) {
          try {
            const acknowledged = await withinCleanup(
              trackMutation(entry, api.abort(entry.id, { timeoutMs: Math.min(config.requestTimeoutMs || 5_000, 5_000, remaining(deadline)) }), 'abort', lease.generation),
              deadline,
            );
            abortAcknowledged = acknowledged === true;
            abortAcknowledgedAfterExecution = abortAcknowledged && executionObserved;
            needsAbort = false;
            lastAbortAt = clock.monotonicNow();
            firstIdleAt = undefined;
          } catch {
            // An ambiguous abort may arrive later. Keep its marker and never issue another.
            return;
          }
        }
        let interval: Awaited<ReturnType<typeof read>>;
        let idle: boolean;
        try {
          interval = await read();
          const statuses = await withinCleanup(
            api.sessionStatus(entry.directory, { timeoutMs: Math.min(config.requestTimeoutMs || 5_000, 5_000, remaining(deadline)) }),
            deadline,
          );
          idle = !statuses[entry.id] || statuses[entry.id]?.type === 'idle';
          if (idle) interval = await read();
          if (entry.lastSubmittedUser && !interval.some((message) => message.info.id === entry.lastSubmittedUser))
            throw new OpencodeHttpError('Known turn root missing from fresh read', 200, 'ProtocolError');
          if (ownRecord.highestObservedMessageId &&
              !interval.some((message) => message.info.id === ownRecord.highestObservedMessageId))
            throw new OpencodeHttpError('Known turn message missing from fresh read', 200, 'ProtocolError');
          const ids = new Set(interval.map((message) => message.info.id));
          if (ownRecord.observedMessageIds?.some((id) => !ids.has(id)) ||
              interval.length < (ownRecord.observedMessageCount ?? 0))
            throw new OpencodeHttpError('Known turn history missing from fresh read', 200, 'ProtocolError');
          failures = 0;
        } catch (error) {
          firstIdleAt = undefined;
          if (!isRetryableReadError(error)) throw error;
          await cleanupPause(deadline, ++failures, error);
          continue;
        }
        const evidence = submissionEvidence(interval);
        const newUser = evidence.userId !== undefined && evidence.userId !== previousUser;
        previousUser = evidence.userId;
        if (idle && evidence.userId && evidence.assistant === 'terminal') {
          if (entry.last?.turnId !== turnId || entry.turnRecords?.get(entry.last.turn) !== ownRecord) return;
          if (hasInFlight(entry) || hasAbort(entry)) return;
          const outcome = classifyOutcome(interval, true, clock.wallNow(), ownRecord.activityObserved === true);
          const summary = summarizeInterval(interval, entry.directory, config.maxOutputChars, outcome);
          summary.toolCallCount = Math.max(summary.toolCallCount, ownRecord.maxToolCallCount ?? 0);
          const { contextUsage, ...summaryRest } = summary;
          const loop = entry.last?.error?.name === 'UPSTREAM_RESPONSE_LOOP';
          const overflowModel = contextUsage?.model ?? entry.model ?? 'the model';
          const baseHint = loop
            ? 'OpenCode was stopped after repeated unusable model responses. Check the model/gateway and inspect partial effects before trying again.'
            : outcome.error?.name === 'ContextOverflowError'
              ? contextOverflowHint(overflowModel)
              : outcome.error?.name === 'EMPTY_RESPONSE'
                ? 'OpenCode finished without answer text. No tool or patch activity was observed. Inspect the result, then retry once after a short wait if appropriate.'
                : outcome.warnings?.some((warning) => warning.code === 'EMPTY_RESPONSE')
                  ? 'Tool activity occurred, but the final answer is empty. Inspect opencode-output and the turn diff before continuing.'
                  : outcome.warnings?.some((warning) => warning.code === 'TRUNCATED')
                    ? 'The provider truncated the answer. Use opencode-reply to continue from the stopping point.'
                    : releaseHint(entry, evidence.userId, outcome.status);
          // U4b: quarantine recovery recomputes context/warnings/hint the same way Turn.finish()
          // does (context-concurrency design §5.3).
          const resolvedLimit = contextUsage ? limitsFor(lease.generation, entry.directory, contextUsage.model) : undefined;
          const { context, warnings: finalWarnings, hint } = buildContextResult(
            contextUsage, extractOutputArtifacts(interval).compacted, resolvedLimit,
            loop ? undefined : outcome.warnings, baseHint,
          );
          releaseExpiredAborts(entry);
          entry.last = {
            ...entry.last,
            ...summaryRest,
            status: loop ? 'failed' : outcome.status,
            error: loop ? entry.last.error : outcome.error,
            ...(loop ? {} : { finish: outcome.finish }),
            // Explicitly replace (not merge) `warnings`/`context`: `entry.last` was just spread
            // above, so without this, a recomputed empty `finalWarnings`/absent `context` would
            // silently keep the pre-recovery turn's stale CONTEXT_HIGH warning/context forever.
            warnings: finalWarnings && finalWarnings.length ? finalWarnings : undefined,
            context,
            resendSafety: entry.unresolvedMutations?.size ? 'unknown' :
              ownRecord.activityObserved || interval.some((message) => message.parts.some((part) => part.type === 'tool' || part.type === 'patch'))
                ? 'inspect_effects' : 'no_observed_effects',
            output: entry.last.output ? { ...entry.last.output,
              toolCallCount: Math.max(entry.last.output.toolCallCount, ownRecord.maxToolCallCount ?? 0),
              partial: loop || outcome.partial === true || outcome.status !== 'completed' } : entry.last.output,
            executionState: 'stopped',
            cleanup: 'complete',
            hint,
          };
          settleRecovered(entry);
          if (entry.phase !== 'ending' && !entry.endFailure) entry.phase = 'idle';
          return;
        }
        if (!abort) return;
        if (!idle || newUser) {
          if (evidence.userId) executionObserved = true;
          needsAbort = abortAcknowledged && !!evidence.userId && !hasAnyAbort(entry);
          firstIdleAt = undefined;
        } else if (evidence.userId && evidence.assistant === 'absent') {
          if (executionObserved && (abortAcknowledgedAfterExecution || (hasAnyAbort(entry) && !hasAbort(entry))) &&
              evidence.userId === entry.lastSubmittedUser) firstIdleAt ??= clock.monotonicNow();
          else firstIdleAt = undefined;
          if (firstIdleAt !== undefined && clock.monotonicNow() - firstIdleAt >= 5_000) {
            if (entry.last?.turnId !== turnId || entry.turnRecords?.get(entry.last.turn) !== ownRecord) return;
            if (hasInFlight(entry) || hasAbort(entry)) return;
            // This branch only runs when abort is requested and no assistant response ever
            // appeared: the outcome is a cancellation, not a completed/failed run to report on.
            const loop = entry.last?.error?.name === 'UPSTREAM_RESPONSE_LOOP';
            const hint = loop
              ? 'OpenCode was stopped after repeated unusable model responses. Check the model/gateway and inspect partial effects before trying again.'
              : releaseHint(entry, evidence.userId, 'cancelled');
            releaseExpiredAborts(entry);
            entry.last = {
              ...entry.last,
              executionState: 'stopped',
              cleanup: 'complete',
              resendSafety: loop
                ? entry.last.toolCallCount || entry.last.filesChanged.length ? 'inspect_effects' : 'no_observed_effects'
                : entry.last.resendSafety,
              hint,
            };
            settleRecovered(entry);
            if (entry.phase !== 'ending' && !entry.endFailure) entry.phase = 'idle';
            return;
          }
        } else {
          firstIdleAt = undefined;
        }
        await withinCleanup(
          new Promise<void>((resolve) => {
            clock.schedule(Math.min(100, config.statusPollMs, remaining(deadline)), resolve);
          }),
          deadline,
        );
      }
    } catch {
      /* No terminal evidence: preserve the quarantine. */
    }
  };
  // Every recovery owns the original turn and boundary until its inspection settles.
  const confirmQuiescence = (
    entry: TrackedSession,
    abort: boolean,
    allowAcquire = false,
  ): Promise<TurnResult | undefined> => {
    const target = entry.last;
    const record = target && entry.turnRecords?.get(target.turn);
    if (!target || (target.executionState !== 'unknown' &&
        !(target.executionState === 'stopped' && target.cleanup === 'unconfirmed' && record?.stopCleanupPending)) || !record ||
        record.turnId !== target.turnId || !record.submissionDispatched)
      return Promise.resolve(target);
    if (hasInFlight(entry) || (!abort && hasAbort(entry))) return Promise.resolve(target);
    const existing = entry.recovery;
    if (existing) {
      return existing.settled.then((result) => {
        if (abort && result?.executionState === 'unknown' && entry.last?.turnId === existing.turnId &&
            !hasAnyAbort(entry) && !hasInFlight(entry))
          return confirmQuiescence(entry, true, allowAcquire);
        return result;
      });
    }
    let resolveRecovery = (_result: TurnResult | undefined) => {};
    const settled = new Promise<TurnResult | undefined>((resolve) => {
      resolveRecovery = resolve;
    });
    const reservation: QuarantineRecovery = {
      turnId: target.turnId,
      boundary: record.boundary,
      settled,
    };
    entry.recovery = reservation;
    void (async () => {
      try {
        await inspectQuiescence(entry, abort, allowAcquire, reservation.turnId, reservation.boundary);
      } catch {
        logger.warn('Quarantine inspection failed', { sessionId: entry.id, turnId: reservation.turnId });
      } finally {
        const result =
          entry.last?.turnId === reservation.turnId &&
            entry.turnRecords?.get(entry.last.turn) === record
            ? entry.last
            : target;
        if (entry.recovery === reservation) entry.recovery = undefined;
        resolveRecovery(result);
      }
    })();
    return settled;
  };
  const endInternal = async (
    entry: TrackedSession,
    action: EndAction,
    allowAcquire = true,
  ): Promise<EndResult> => {
    registry.reserveEnd(entry);
    let abortedRunningTurn = false;
    try {
      const admission = entry.admission;
      if (admission) {
        abortedRunningTurn = true;
        admission.stopRequested = true;
        await withinCleanup(admission.settled, clock.monotonicNow() + config.cleanupTimeoutMs);
      }
      if (entry.current) {
        abortedRunningTurn = true;
        const stopped = await entry.current.stop('cancelled');
        if (stopped.executionState === 'unknown' || stopped.cleanup === 'unconfirmed')
          throw new EngineError(
            'CLEANUP_UNCONFIRMED',
            `Stop could not be confirmed for ${entry.id}`,
            entry.id,
          );
      }
      if (entry.last?.executionState === 'unknown') {
        await confirmQuiescence(entry, true, allowAcquire);
        if (entry.last?.executionState === 'unknown')
          throw new EngineError(
            'CLEANUP_UNCONFIRMED',
            `Stop could not be confirmed for ${entry.id}`,
            entry.id,
          );
      }
      await rejectLeftovers(entry, allowAcquire);
      if (hasInFlight(entry) || hasAbort(entry))
        throw new EngineError('CLEANUP_UNCONFIRMED', `Recovery remains pending for ${entry.id}`, entry.id);
      // A prior timed-out delete/archive can be retried, but changing action would leave
      // an ambiguous operation of the other kind able to affect the session later.
      if ([...(entry.unresolvedMutations?.values() ?? [])].some((marker) => marker.kind !== action))
        throw new EngineError('CLEANUP_UNCONFIRMED', `Retry the original end action for ${entry.id}`, entry.id);
      const lease = allowAcquire ? await acquire() : connection.current();
      if (!lease) throw new EngineError('CLEANUP_UNCONFIRMED', 'OpenCode has no live lease', entry.id);
      const api = lease.api;
      let alreadyGone = false;
      const deadline = clock.monotonicNow() + config.cleanupTimeoutMs;
      if (action === 'delete') {
        try {
          alreadyGone = !(await withinCleanup(
            trackMutation(entry, api.deleteSession(entry.id, { timeoutMs: remaining(deadline) }), 'delete', lease.generation),
            deadline,
          ));
        } catch (error) {
          if (error instanceof OpencodeHttpError && error.status === 404) alreadyGone = true;
          else throw error;
        }
      } else {
        try {
          await withinCleanup(
            trackMutation(
              entry,
              api.archiveSession(entry.id, clock.wallNow(), { timeoutMs: remaining(deadline) }),
              'archive',
              lease.generation,
            ),
            deadline,
          );
        } catch (error) {
          if (error instanceof OpencodeHttpError && error.status === 404) alreadyGone = true;
          else throw error;
        }
      }
      clearSettled(entry, action);
      registry.delete(entry.id);
      releaseHeld(entry.id);
      outputStore.dropSession(entry.id);
      committedResults.delete(entry.id);
      for (const [key, item] of committedOrder)
        if (item.sessionId === entry.id) committedOrder.delete(key);
      requests.sessionEnded(entry.id);
      for (const [id, fallback] of keyedFallbacks)
        if (fallback.sessionId === entry.id) keyedFallbacks.delete(id);
      return {
        kind: 'end',
        threadId: entry.id,
        sessionId: entry.id,
        status: 'ended',
        action,
        abortedRunningTurn,
        cleanup: 'complete',
        content: alreadyGone
          ? `Session ${entry.id} no longer existed upstream.`
          : `Session ${entry.id} ${action === 'delete' ? 'deleted' : 'archived'}.`,
      };
    } catch (error) {
      entry.phase = 'quarantined';
      const reason = error instanceof Error ? error.message : String(error);
      entry.endFailure = reason;
      // P2-1 (core review): a bare in-flight or ambiguous delete/archive/reply/
      // question mutation must not downgrade the turn's own (already known) executionState —
      // reserveReply already blocks on any unresolved delete/archive marker regardless of
      // settlement, and the same-action-retry check above blocks a mismatched end action, so
      // nothing here depends on entry.last being 'unknown'. Only an unresolved abort — which
      // could still land and change what the reported turn actually did — must downgrade it.
      if (hasAbort(entry) && entry.last)
        entry.last = { ...entry.last, executionState: 'unknown', cleanup: 'unconfirmed' };
      if (entry.last)
        entry.last = {
          ...entry.last,
          hint: `opencode-end failed (${reason}); the session is still tracked — retry opencode-end.`,
        };
      if (error instanceof EngineError && error.code === 'CLEANUP_UNCONFIRMED') throw error;
      throw new EngineError(
        'CLEANUP_UNCONFIRMED',
        `Cleanup could not be confirmed for ${entry.id}: ${reason}`,
        entry.id,
      );
    }
  };
  const keyedResult = (result: TurnResult, record: RequestRecord, replayed: boolean): TurnResult =>
    ({ ...refreshOutput(result), request: requests.receipt(record, replayed) });
  const duplicateResult = async (
    record: RequestRecord,
    settled: Promise<import('./request-registry.ts').AdmissionOutcome>,
    ctx: CallContext,
    wait: number | undefined,
  ): Promise<TurnResult> => {
    // One monotonic deadline governs the whole duplicate call: the reservation-admission wait below
    // and the later Turn.attach wait share it, so a slow original admission cannot make a duplicate
    // block for up to 2x its promised wait-seconds.
    const deadline = wait === undefined ? undefined : clock.monotonicNow() + wait * 1000;
    const remainingWaitSeconds = (): number | undefined =>
      deadline === undefined ? undefined : Math.max(0, deadline - clock.monotonicNow()) / 1000;
    let outcome: import('./request-registry.ts').AdmissionOutcome;
    if (record.state === 'reserved') {
      if (wait === 0 || ctx.signal.aborted)
        throw new EngineError('REQUEST_PENDING', 'Original request admission is still pending; retry this request id later');
      let cancelDeadline = () => {};
      let cancelBeat = () => {};
      let removeAbort = () => {};
      const beat = () => {
        ctx.progress?.('Waiting for original request admission');
        cancelBeat = clock.schedule(config.heartbeatMs, beat);
      };
      beat();
      const detached = new Promise<null>((resolve) => {
        const abort = () => resolve(null);
        ctx.signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => ctx.signal.removeEventListener('abort', abort);
        if (deadline !== undefined)
          cancelDeadline = clock.schedule(Math.max(0, deadline - clock.monotonicNow()), () => resolve(null));
      });
      try {
        const observed = await Promise.race([settled, detached]);
        if (!observed) throw new EngineError('REQUEST_PENDING', 'Original request admission is still pending; retry this request id later');
        outcome = observed;
      } finally { cancelDeadline(); cancelBeat(); removeAbort(); }
    } else outcome = await settled;
    if (outcome.kind === 'failed')
      throw new EngineError(outcome.error.code as EngineError['code'], outcome.error.message);
    if (outcome.kind === 'unconfirmed')
      throw new EngineError('REQUEST_UNCONFIRMED', outcome.message, outcome.sessionId);
    ctx.setSessionId?.(outcome.sessionId);
    const entry = registry.find(outcome.sessionId);
    if (!entry) throw new EngineError('REQUEST_ENDED', 'Request id belongs to an ended session', outcome.sessionId);
    const admissionError = entry?.turnRecords?.get(outcome.turn)?.admissionError ??
      keyedFallbacks.get(record.id)?.admissionError;
    if (admissionError)
      throw new EngineError(admissionError.code as EngineError['code'], admissionError.message,
        outcome.sessionId, admissionError.retryAfterSeconds);
    const retained = committedResults.get(outcome.sessionId)?.get(outcome.turn);
    if (retained) return keyedResult({ ...retained,
      output: outputStore.meta(outcome.sessionId, outcome.turn) ?? retained.output }, record, true);
    if (entry?.current?.id === outcome.turnId)
      return keyedResult(await entry.current.attach(ctx, remainingWaitSeconds(), false), record, true);
    const fallback = keyedFallbacks.get(record.id);
    if (fallback && fallback.turnId === outcome.turnId) return keyedResult({
      kind: 'turn', threadId: outcome.sessionId, sessionId: outcome.sessionId,
      turnId: fallback.turnId, turn: fallback.turn, status: fallback.status,
      executionState: fallback.executionState, cleanup: fallback.cleanup,
      content: 'Original turn summary was evicted; use opencode-output for retained content if available.',
      directory: entry.directory, filesChanged: [], toolCalls: [], toolCallCount: 0,
      pendingApprovals: [], elapsedMs: 0, truncated: true,
      hint: 'Original detail arrays are omitted from this replay.',
      ...(fallback.error ? { error: fallback.error } : {}),
      ...(fallback.finish ? { finish: fallback.finish } : {}),
      ...(fallback.warnings ? { warnings: fallback.warnings } : {}),
      ...(fallback.resendSafety ? { resendSafety: fallback.resendSafety } : {}),
      ...(fallback.upstreamRetry ? { upstreamRetry: fallback.upstreamRetry } : {}),
      ...(fallback.upstreamRead ? { upstreamRead: fallback.upstreamRead } : {}),
      ...(fallback.responseLoop ? { responseLoop: fallback.responseLoop } : {}),
      ...(outputStore.meta(outcome.sessionId, outcome.turn)
        ? { output: outputStore.meta(outcome.sessionId, outcome.turn) } : {}),
    }, record, true);
    throw new EngineError('INTERNAL', 'Retained keyed result invariant was violated', outcome.sessionId);
  };
  const reserveKey = (id: string | undefined, tool: RequestTool, args: Record<string, unknown>) => {
    if (id === undefined) return undefined;
    if (typeof id !== 'string') throw new EngineError('INVALID_ARGUMENT', 'Request id must be a string');
    const reservation = requests.reserve(id, tool, requestFingerprint(tool, args));
    if (reservation.kind === 'invalid') throw new EngineError('INVALID_ARGUMENT', reservation.message);
    if (reservation.kind === 'conflict') throw new EngineError('REQUEST_ID_CONFLICT', 'Request id is bound to different arguments');
    if (reservation.kind === 'ended') throw new EngineError('REQUEST_ENDED', 'Request id belongs to an ended session');
    if (reservation.kind === 'capacity') throw new EngineError('REQUEST_CAPACITY', 'Request id registry is full');
    return reservation;
  };
  const infoWait = async <T>(work: Promise<T>, ctx: CallContext): Promise<T> => {
    if (ctx.signal.aborted) {
      void work.catch(() => {});
      throw new EngineError('OPENCODE_UNAVAILABLE', 'Discovery call cancelled');
    }
    let cancelBeat = () => {};
    let removeAbort = () => {};
    const beat = () => {
      ctx.progress?.('Loading OpenCode discovery catalog');
      cancelBeat = clock.schedule(config.heartbeatMs, beat);
    };
    cancelBeat = clock.schedule(config.heartbeatMs, beat);
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new EngineError('OPENCODE_UNAVAILABLE', 'Discovery call cancelled'));
      ctx.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => ctx.signal.removeEventListener('abort', abort);
    });
    try { return await Promise.race([work, cancelled]); }
    finally { cancelBeat(); removeAbort(); }
  };
  const catalogError = (error: unknown, section: InfoInput['section']): EngineError => {
    const sizeMessage = section === 'models'
      ? 'OpenCode catalog exceeds the 32 MiB limit' : 'OpenCode catalog exceeds the 2 MiB limit';
    if (error instanceof EngineError) {
      if (error.message === 'Discovery call cancelled') return error;
      return new EngineError(error.code === 'UPSTREAM_RESPONSE_TOO_LARGE' || error.code === 'OPENCODE_OVERLOADED' ? error.code :
        error.code === 'OPENCODE_UNAVAILABLE' ? error.code : 'UPSTREAM_ERROR',
        error.code === 'UPSTREAM_RESPONSE_TOO_LARGE'
          ? sizeMessage : 'OpenCode catalog request failed', undefined,
        error.retryAfterSeconds);
    }
    if (error instanceof OpencodeHttpError) {
      const code = error.errorName === 'ResponseTooLarge' ? 'UPSTREAM_RESPONSE_TOO_LARGE'
        : error.classification === 'overloaded' ? 'OPENCODE_OVERLOADED'
        : error.status === 0 ? 'OPENCODE_UNAVAILABLE' : 'UPSTREAM_ERROR';
      return new EngineError(code, code === 'UPSTREAM_RESPONSE_TOO_LARGE'
        ? sizeMessage : 'OpenCode catalog request failed', undefined,
        code === 'OPENCODE_OVERLOADED' && error.retryAfterSeconds !== undefined
          ? Math.min(3600, error.retryAfterSeconds) : undefined);
    }
    return new EngineError('OPENCODE_UNAVAILABLE', 'OpenCode catalog request failed');
  };
  return {
    async start(input: StartInput, ctx: CallContext): Promise<TurnResult> {
      active();
      positivePrompt(input.prompt);
      const validated = input.outputSchema === undefined ? undefined : validateOutputSchema(input.outputSchema);
      if (validated && !validated.ok) throw new EngineError('INVALID_OUTPUT_SCHEMA', validated.message);
      const schema = validated?.ok ? validated.schema : undefined;
      const wait = turnWaitValue(input.waitSeconds, Math.floor(config.maxTurnTimeoutMs / 1000)),
        timeout = timeoutValue(input.timeoutSeconds, config.turnTimeoutMs, config.maxTurnTimeoutMs);
      model(input.model ?? config.defaultModel);
      const directory = await resolveWorkingDirectory(input.cwd, config);
      active();
      const title = (input.title?.trim() || input.prompt.split('\n')[0] || 'OpenCode task').slice(0, 80);
      const sandbox = input.sandbox ?? config.defaultSandbox,
        approvalPolicy = input.approvalPolicy ?? config.defaultApprovalPolicy;
      if (
        !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox) ||
        !['never', 'on-request'].includes(approvalPolicy)
      )
        throw new EngineError('INVALID_ARGUMENT', 'Invalid sandbox or approval policy');
      const reservation = reserveKey(input.requestId, 'opencode', { ...input, cwd: input.cwd === undefined ? undefined : directory,
        resolvedDirectory: directory, requestId: undefined, waitSeconds: undefined });
      if (reservation?.kind === 'duplicate')
        return duplicateResult(reservation.record, reservation.settled, ctx, wait);
      const record = reservation?.record;
      const admissionDeadlineAt = clock.monotonicNow() +
        (config.startupTimeoutMs || config.sseStallMs * 2);
      let created = false;
      let entryId: string | undefined;
      let ticket: RunTicket | undefined;
      let transferred = false;
      try {
        // FZ #1: reserve capacity SYNCHRONOUSLY, before any upstream mutation (acquire() included)
        // and before any await at all — a pending-creation counter is checked together with the
        // tracked-session count in one atomic step, so a concurrent burst of starts can never all
        // observe the same under-the-cap count and exceed it. The reservation is transferred into
        // the registry once add() below runs, and released on every failure/abort path before that
        // (see the inner finally) so it never leaks. Never evict an active or quarantined session to
        // make room. A rejection here is a pure local/pre-POST failure, so the outer catch's
        // requests.failed below frees the request-id for a retry once capacity exists again.
        if (!registry.reserveCreation(config.maxSessions))
          throw new EngineError(
            'SESSION_CAPACITY',
            `Too many tracked sessions (limit ${config.maxSessions}); end finished sessions with opencode-end`,
          );
        let capacityReserved = true;
        try {
          // Context guard: synchronous prompt-size pre-check before reserving a run slot.
          checkPromptSize(input.model ?? config.defaultModel, connection.current()?.generation, directory,
            input.prompt, systemTextFor(input.baseInstructions, input.developerInstructions, schema));
          ticket = slots.reserve(input.model ?? config.defaultModel);
          pendingStarts.add(ticket);
          const admissionRemaining = admissionDeadlineAt - clock.monotonicNow();
          if (admissionRemaining <= 0)
            throw new EngineError('OPENCODE_UNAVAILABLE', 'Session admission deadline expired');
          const lease = await acquire({ timeoutMs: admissionRemaining });
          active();
          let session: OcSession;
          try {
            session = await lease.api.createSession(directory, { title, permission: sessionRulesFor(sandbox) });
            created = true;
          } catch (error) {
            // FZ #2: the create POST has now been dispatched, so ANY error surfacing here — not
            // just a classified OpencodeHttpError — is treated conservatively as ambiguous, unless
            // it is a confirmed 4xx rejection. Only a confirmed 4xx proves the create never
            // happened upstream; status 0, 5xx, a 2xx whose body was malformed/oversized/carried an
            // invalid id (mapped by the adapter to OpencodeHttpError('ProtocolError')), and any
            // other unexpected error the adapter failed to classify must all be treated as
            // ambiguous — the POST may have created a session this process can no longer name. Pin
            // the request-id (REQUEST_UNCONFIRMED for a duplicate) instead of freeing it for a
            // retry that would then risk a second, orphaned session.
            if (record && !(error instanceof OpencodeHttpError && isConfirmedRejection(error)))
              requests.unconfirmed(record, { message: 'Session creation outcome is unconfirmed' });
            // A 5xx create response may have followed execution; retain mutation ambiguity.
            if (error instanceof OpencodeHttpError && error.status >= 500)
              throw new EngineError('UPSTREAM_ERROR', error.message.slice(0, 500));
            throw upstream(error);
          }
          const entry: TrackedSession = {
            id: session.id,
            directory,
            title,
            sandbox,
            approvalPolicy,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
            agent: input.agent ?? config.defaultAgent,
            model: input.model ?? config.defaultModel,
            turns: 0,
            phase: 'admitting',
            generation: lease.generation,
            updatedAt: clock.wallNow(),
          };
          registry.add(entry);
          // Transfer the reservation: the tracked session itself now accounts for this slot via
          // registry.all().length, so the pending-creation counter must release it here — leaving
          // it held would double-count this session on every future capacity check.
          registry.releaseCreation();
          capacityReserved = false;
          entryId = entry.id;
          ctx.setSessionId?.(entry.id);
          const result = await launch(entry, input.prompt, timeout, ctx, wait, schema,
            record ? { record, onTurn: (turn) => requests.admitted(record, { sessionId: entry.id, turnId: turn.id, turn: turn.number }) } : undefined,
            admissionDeadlineAt, ticket, () => {
              transferred = true;
              pendingStarts.delete(ticket!);
            });
          return record ? keyedResult(result, record, false) : result;
        } finally {
          if (capacityReserved) registry.releaseCreation();
        }
      } catch (error) {
        if (record) {
          const reason = upstream(error);
          if (created) requests.unconfirmed(record, { sessionId: entryId, message: 'Session exists but turn admission is unconfirmed' });
          else requests.failed(record, { code: reason.code, message: reason.message });
        }
        throw error;
      } finally {
        if (ticket && !transferred && ticket.state !== 'released' && ticket.state !== 'cancelled') ticket.release();
        if (ticket) pendingStarts.delete(ticket);
      }
    },
    async reply(input: ReplyInput, ctx: CallContext): Promise<TurnResult> {
      active();
      positivePrompt(input.prompt);
      const validated = input.outputSchema === undefined ? undefined : validateOutputSchema(input.outputSchema);
      if (validated && !validated.ok) throw new EngineError('INVALID_OUTPUT_SCHEMA', validated.message);
      const schema = validated?.ok ? validated.schema : undefined;
      const wait = turnWaitValue(input.waitSeconds, Math.floor(config.maxTurnTimeoutMs / 1000)),
        timeout = timeoutValue(input.timeoutSeconds, config.turnTimeoutMs, config.maxTurnTimeoutMs);
      model(input.model);
      const reservation = reserveKey(input.requestId, 'opencode-reply', { ...input,
        sessionId: input.sessionId, requestId: undefined, waitSeconds: undefined });
      if (reservation?.kind === 'duplicate')
        return duplicateResult(reservation.record, reservation.settled, ctx, wait);
      const record = reservation?.record;
      let ticket: RunTicket | undefined;
      let transferred = false;
      let replyEntry: TrackedSession | undefined;
      let replyReserved = false;
      try {
        const entry = registry.get(input.sessionId);
        const effectiveModel = input.model ?? entry.model;
        // Context guard: synchronous prompt-size pre-check before reserving a run slot.
        checkPromptSize(effectiveModel, connection.current()?.generation, entry.directory, input.prompt,
          systemTextFor(entry.baseInstructions, input.developerInstructions ?? entry.developerInstructions, schema));
        registry.reserveReply(entry);
        replyEntry = entry;
        replyReserved = true;
        ticket = slots.reserve(effectiveModel);
        if (input.model !== undefined) entry.model = input.model;
        if (input.agent !== undefined) entry.agent = input.agent;
        if (input.developerInstructions !== undefined)
          entry.developerInstructions = input.developerInstructions;
        const result = await launch(entry, input.prompt, timeout, ctx, wait, schema,
          record ? { record, onTurn: (turn) => requests.admitted(record, { sessionId: entry.id, turnId: turn.id, turn: turn.number }) } : undefined,
          undefined, ticket, () => { transferred = true; });
        return record ? keyedResult(result, record, false) : result;
      } catch (error) {
        if (record) {
          const reason = upstream(error);
          requests.failed(record, { code: reason.code, message: reason.message });
        }
        throw error;
      } finally {
        if (ticket && !transferred && ticket.state !== 'released' && ticket.state !== 'cancelled') ticket.release();
        if (replyReserved && !ticket && replyEntry) registry.releaseReply(replyEntry);
      }
    },
    async status(input: { sessionId: string; waitSeconds?: number }, ctx: CallContext): Promise<TurnResult> {
      active();
      const wait = waitValue(input.waitSeconds ?? 0, 600);
      const entry = registry.get(input.sessionId);
      if (entry.current) return entry.current.attach(ctx, wait, false);
      const recovered = await confirmQuiescence(entry, false);
      if (recovered) return refreshOutput(recovered);
      if (entry.last) {
        return refreshOutput(entry.last);
      }
      throw new EngineError('SESSION_BUSY', `Session ${entry.id} has no admitted turn yet`, entry.id);
    },
    async info(input: InfoInput, ctx: CallContext): Promise<InfoResult> {
      active();
      const section = input.section ?? 'server';
      if (!['server', 'models', 'agents', 'roots'].includes(section))
        throw new EngineError('INVALID_ARGUMENT', 'Invalid info section');
      if (section === 'server') {
        if (input.offset !== undefined || input.limit !== undefined || input.snapshotId !== undefined)
          throw new EngineError('INVALID_ARGUMENT', 'Server info does not support pagination');
        if (input.provider !== undefined || input.cwd !== undefined)
          throw new EngineError('INVALID_ARGUMENT', 'Server info does not support provider or cwd');
        const lease = connection.current();
        const concurrency = slots.snapshot();
        const perModelTotal = concurrency.perModel.length;
        return { kind: 'info', status: 'ok', section, content: 'OpenCode MCP server information', truncated: false,
          server: { mcpVersion: SERVER_VERSION, serverInstanceId, mode: config.mode,
            remotePaths: config.remotePaths,
            connectionState: lease ? 'connected' : acquireAttempted ? 'unavailable' : 'not_started',
            opencodeVersion: lease?.version ?? null,
            defaults: { cwd: config.defaultCwd, model: config.defaultModel ?? null,
              agent: config.defaultAgent ?? null, sandbox: config.defaultSandbox,
              approvalPolicy: config.defaultApprovalPolicy, turnTimeoutSeconds: config.turnTimeoutMs / 1000,
              maxTurnTimeoutSeconds: config.maxTurnTimeoutMs / 1000,
              contextGuard: config.contextGuard ?? 'reject' },
            limits: { maxOutputChars: config.maxOutputChars, structuredContentBudget: 45000,
              maxWaitSeconds: 600, maxBatchIds: 16,
              maxSessions: config.maxSessions, maxRunningTurns: limits.maxRunning,
              maxQueuedTurns: limits.maxQueued,
              queueTimeoutSeconds: limits.queueTimeoutMs === null ? null : limits.queueTimeoutMs / 1000,
              outputRetention: { ttlSeconds: DEFAULT_OUTPUT_STORE_LIMITS.ttlMs / 1000,
                maxTurns: DEFAULT_OUTPUT_STORE_LIMITS.maxTurns, maxBytes: DEFAULT_OUTPUT_STORE_LIMITS.maxBytes },
              requestIds: { maxRecords: DEFAULT_REQUEST_REGISTRY_LIMITS.maxRecords,
                ttlSeconds: DEFAULT_REQUEST_REGISTRY_LIMITS.ttlMs / 1000 } },
            concurrency: { ...concurrency, perModel: concurrency.perModel.slice(0, 32),
              perModelTotal, perModelTruncated: perModelTotal > 32 },
            capabilities: ['output-paging', 'per-turn-diff', 'structured-output', 'request-id', 'discovery',
              'batch-status', 'run-queue', 'model-limits', 'context-usage'],
            sandboxEnforcement: 'permission-profile' } };
      }
      if (input.provider !== undefined && section !== 'models')
        throw new EngineError('INVALID_ARGUMENT', 'Provider filter is only valid for models');
      if (input.provider !== undefined && (!validId(input.provider) || input.provider.includes('/')))
        throw new EngineError('INVALID_ARGUMENT', 'Invalid provider filter');
      if (input.cwd !== undefined && section === 'roots')
        throw new EngineError('INVALID_ARGUMENT', 'Roots section does not accept cwd');
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;
      if (!Number.isInteger(offset) || offset < 0 || offset > 10_000 ||
          !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new EngineError('INVALID_ARGUMENT', 'Invalid discovery offset or limit');
      if (offset > 0 && !input.snapshotId)
        throw new EngineError('SNAPSHOT_EXPIRED', 'A snapshot id is required to continue discovery paging');
      const directory = section === 'roots' ? '' : await resolveWorkingDirectory(input.cwd, config);
      let lease: ConnectionLease | undefined;
      if (section !== 'roots') {
        try { lease = await infoWait(acquire(), ctx); }
        catch (error) { throw catalogError(error, section); }
      }
      const key = section === 'roots' ? 'roots' : `${lease!.generation}\0${directory}\0${section}`;
      let snapshot = input.snapshotId && offset > 0 ? catalogs.byId<unknown>(key, input.snapshotId) : catalogs.current<unknown>(key);
      if (input.snapshotId && offset > 0 && !snapshot)
        throw new EngineError('SNAPSHOT_EXPIRED', 'Discovery snapshot expired');
      let dropped = 0;
      if (!snapshot) {
        let items: unknown[];
        if (section === 'roots') {
          items = config.allowedRoots.filter((root) => {
            const valid = typeof root === 'string' && root.length <= 4096;
            if (!valid) dropped++;
            return valid;
          });
        } else {
          try { await infoWait(warmDirectory(lease!, directory), ctx); }
          catch (error) { throw catalogError(error, section); }
          if (ctx.signal.aborted) throw new EngineError('OPENCODE_UNAVAILABLE', 'Discovery call cancelled');
          const opts = { timeoutMs: config.requestTimeoutMs,
            maxBytes: section === 'models' ? PROVIDER_CATALOG_MAX_BYTES : 2 * 1024 * 1024 };
          try {
            const raw = section === 'models'
              ? await infoWait(lease!.api.providerCatalog(directory, opts), ctx)
              : await infoWait(lease!.api.agentCatalog(directory, opts), ctx);
            const projected = section === 'models'
              ? projectModels(raw, undefined, { profiles: config.modelProfiles, defaultModel: config.defaultModel })
              : projectAgents(raw);
            items = projected.items;
            dropped = projected.dropped;
          } catch (error) { throw catalogError(error, section); }
        }
        snapshot = catalogs.put(key, items, dropped);
      }
      const visible = section === 'models' && input.provider !== undefined
        ? (snapshot.items as NonNullable<InfoResult['models']>).filter((item) => item.providerId === input.provider)
        : snapshot.items;
      let page: ReturnType<typeof pageItems<unknown>>;
      try { page = pageItems(visible, offset, limit); }
      catch { throw new EngineError('INVALID_ARGUMENT', 'Discovery offset exceeds item count'); }
      return { kind: 'info', status: 'ok', section,
        content: `${page.items.length} of ${page.total} ${section}`,
        truncated: page.hasMore || snapshot.dropped > 0,
        ...(section === 'models' ? { models: page.items as NonNullable<InfoResult['models']>, availability: 'advertised' as const } : {}),
        ...(section === 'agents' ? { agents: page.items as NonNullable<InfoResult['agents']> } : {}),
        ...(section === 'roots' ? { roots: page.items as string[] } : {}),
        snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt,
        offset: page.offset, nextOffset: page.nextOffset, total: page.total };
    },
    async statusMany(input: BatchStatusInput, ctx: CallContext): Promise<BatchResult> {
      active();
      if (input === null || typeof input !== 'object' || !Array.isArray(input.ids) ||
        input.ids.length < 1 || input.ids.length > 16 ||
        Array.from(input.ids).some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
        new Set(input.ids).size !== input.ids.length)
        throw new EngineError('INVALID_ARGUMENT', 'ids must contain 1 to 16 unique session ids of 1 to 200 characters');
      if (input.waitFor !== undefined && input.waitFor !== 'any' && input.waitFor !== 'all')
        throw new EngineError('INVALID_ARGUMENT', 'waitFor must be any or all');
      const wait = waitValue(input.waitSeconds ?? 0, 600)!;
      const waitFor = input.waitFor ?? 'any';
      // No await before the full capture: a reply cannot retarget an earlier item.
      // refreshOutput() re-derives output.state from the live outputStore instead of trusting
      // entry.last's own (possibly stale) cached copy — otherwise a batch capture could report a
      // resurrected 'retained' for output that artifact+tombstone eviction already dropped.
      const targets = input.ids.map((id) => {
        const entry = registry.find(id);
        const last = entry?.last;
        return captureTarget(id, entry, last ? refreshOutput(last) : undefined);
      });
      const ready = (item: ReturnType<typeof snapshotTarget>) =>
        item.status !== 'running' && item.status !== 'waiting_for_approval';
      const meetsCondition = (items: ReturnType<typeof snapshotTarget>[]) =>
        waitFor === 'any' ? items.some(ready) : items.every(ready);
      const shouldWait = wait > 0 && !ctx.signal.aborted && !meetsCondition(targets.map(snapshotTarget));
      const elicitor = createBatchElicitor(ctx, clock);
      const observerCtx: CallContext = {
        signal: ctx.signal,
        ...(ctx.elicit ? { elicit: elicitor.elicit } : {}),
        ...(ctx.elicitationUnsupported ? { elicitationUnsupported: true } : {}),
      };
      const handles = targets.map((target) => observeTarget(target, observerCtx, shouldWait));
      const observations = () => handles.map((handle) => handle.snapshot());
      let cancelDeadline = () => {};
      let cancelBeat = () => {};
      let onAbort = () => {};
      try {
        let reason: BatchResult['reason'] = 'deadline';
        if (meetsCondition(observations())) reason = 'condition';
        else if (shouldWait) {
          const beat = () => {
            const count = observations().filter(ready).length;
            ctx.progress?.(`${count}/${handles.length} ready`);
            cancelBeat = clock.schedule(config.heartbeatMs, beat);
          };
          beat();
          const condition = waitFor === 'any'
            ? Promise.race(handles.map((handle) => handle.settled))
            : Promise.all(handles.map((handle) => handle.settled));
          const deadline = new Promise<'deadline'>((resolve) => {
            cancelDeadline = clock.schedule(wait * 1000, () => resolve('deadline'));
          });
          const cancelled = new Promise<'cancelled'>((resolve) => {
            onAbort = () => resolve('cancelled');
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          });
          const winner = await Promise.race([condition.then(() => 'condition' as const), deadline, cancelled]);
          if (winner === 'condition') reason = 'condition';
        }
        const results = observations();
        const readyIds = input.ids.filter((_id, index) => ready(results[index]!));
        const pendingIds = input.ids.filter((_id, index) => !ready(results[index]!));
        return { kind: 'batch', status: reason === 'condition' ? 'ready' : 'waiting', content: `${readyIds.length}/${input.ids.length} ready`,
          waitFor, reason, results, readyIds, pendingIds, truncated: false };
      } finally {
        cancelDeadline(); cancelBeat(); ctx.signal.removeEventListener('abort', onAbort);
        for (const handle of handles) handle.dispose();
        elicitor.dispose();
      }
    },
    async output(input: OutputInput, _ctx: CallContext): Promise<OutputResult> {
      active();
      const entry = registry.get(input.sessionId);
      if (!Number.isInteger(input.turn) || input.turn < 1 || input.turn > entry.turns || !entry.turnRecords?.has(input.turn)) {
        if (entry.current?.number === input.turn) throw new EngineError('OUTPUT_NOT_READY', `Turn ${input.turn} is still running`, entry.id);
        throw new EngineError('TURN_NOT_FOUND', `Turn ${input.turn} is not recorded`, entry.id);
      }
      if (entry.current?.number === input.turn) throw new EngineError('OUTPUT_NOT_READY', `Turn ${input.turn} is still running`, entry.id);
      const record = entry.turnRecords.get(input.turn)!;
      const retained = outputStore.meta(entry.id, input.turn);
      if (!retained || retained.state === 'unavailable')
        throw new EngineError('OUTPUT_UNAVAILABLE', `Output for turn ${input.turn} is unavailable (${retained?.reason ?? 'evicted'})`, entry.id);
      const section = input.section ?? 'answer';
      if (!['answer', 'tool-calls', 'structured-output', 'diff'].includes(section))
        throw new EngineError('INVALID_ARGUMENT', 'Invalid output section', entry.id);
      if (section !== 'diff' && (input.diffView !== undefined || input.fileIndex !== undefined || input.snapshotId !== undefined))
        throw new EngineError('INVALID_ARGUMENT', 'Diff options require section diff', entry.id);
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw new EngineError('INVALID_ARGUMENT', 'offset must be a non-negative integer', entry.id);
      const textSection = section === 'answer' || section === 'structured-output' || (section === 'diff' && input.diffView === 'patch');
      const cap = Math.min(20000, config.maxOutputChars);
      if (textSection && cap < 256) throw new EngineError('OUTPUT_LIMIT_TOO_SMALL', 'Server output cap is below 256 characters', entry.id);
      const limit = input.limit ?? (textSection ? Math.min(4000, cap) : section === 'tool-calls' ? 20 : 50);
      if (!Number.isInteger(limit) || (textSection ? limit < 256 || limit > cap : limit < 1 || limit > 100))
        throw new EngineError('INVALID_ARGUMENT', `Invalid limit ${limit} for ${section}`, entry.id);
      const common = { kind: 'output' as const, status: 'ok' as const, sessionId: entry.id,
        threadId: entry.id, turnId: record.turnId, turn: record.turn, section };
      if (section === 'answer' || section === 'structured-output') {
        const page = outputPage(outputStore.readText(entry.id, input.turn, section, offset, limit), entry.id);
        return { ...common, content: page.text, offset: page.offset, nextOffset: page.nextOffset,
          total: page.total, hasMore: page.hasMore, partial: page.partial, truncated: page.hasMore };
      }
      if (section === 'tool-calls') {
        const page = outputPage(outputStore.readToolCalls(entry.id, input.turn, offset, limit), entry.id);
        return { ...common, content: `${page.items.length} of ${page.total} tool calls`, toolCalls: page.items,
          offset: page.offset, nextOffset: page.nextOffset, total: page.total,
          hasMore: page.hasMore, partial: page.partial, truncated: page.hasMore };
      }
      const view = input.diffView ?? 'stat';
      if (view !== 'stat' && view !== 'patch') throw new EngineError('INVALID_ARGUMENT', 'Invalid diff view', entry.id);
      if (view === 'patch' && (!Number.isInteger(input.fileIndex) || input.fileIndex! < 0))
        throw new EngineError('INVALID_ARGUMENT', 'file-index is required for patch view', entry.id);
      if ((view === 'patch' || offset > 0) && !input.snapshotId)
        throw new EngineError('INVALID_ARGUMENT', 'snapshot-id is required for this diff page', entry.id);
      if (view === 'stat' && input.fileIndex !== undefined)
        throw new EngineError('INVALID_ARGUMENT', 'file-index is only valid for patch view', entry.id);
      let snapshot = outputStore.currentDiff(entry.id, input.turn);
      if (snapshot && clock.wallNow() - snapshot.observedAt >= DIFF_SNAPSHOT_TTL_MS) snapshot = undefined;
      if (input.snapshotId && snapshot?.snapshotId !== input.snapshotId)
        throw new EngineError('SNAPSHOT_EXPIRED', 'Diff snapshot is no longer current', entry.id);
      if (!snapshot) {
        if (record.executionState !== 'stopped' || entry.current || entry.admission || !record.submittedUserId)
          throw new EngineError('OUTPUT_UNAVAILABLE', 'Diff is unavailable until the submitted turn and session are stopped', entry.id);
        const observedTurns = entry.turns;
        const key = `${entry.id}\u0000${input.turn}`;
        let pending = diffFetches.get(key);
        if (!pending) {
          pending = (async () => {
            const lease = await acquire();
            if (entry.current || entry.admission)
              throw new EngineError('OUTPUT_UNAVAILABLE', 'Diff fetch waits until this session is idle', entry.id);
            const items = await lease.api.sessionDiff(entry.id, record.submittedUserId!,
              { timeoutMs: Math.max(1000, config.cleanupTimeoutMs), maxBytes: 4 * 1024 * 1024 });
            if (entry.turns !== observedTurns || entry.current || entry.admission)
              throw new EngineError('OUTPUT_NOT_READY', 'A newer turn was admitted during the diff fetch', entry.id);
            const stored = outputStore.putDiff(entry.id, input.turn, record.submittedUserId!, items);
            if ('ok' in stored && !stored.ok)
              throw new EngineError(stored.code, stored.message, entry.id);
          })();
          diffFetches.set(key, pending);
          void pending.finally(() => { if (diffFetches.get(key) === pending) diffFetches.delete(key); }).catch(() => {});
        }
        try { await pending; } catch (error) { throw upstream(error); }
        if (entry.turns !== observedTurns || entry.current || entry.admission)
          throw new EngineError('OUTPUT_NOT_READY', 'A newer turn was admitted during the diff fetch', entry.id);
        snapshot = outputStore.currentDiff(entry.id, input.turn);
      }
      if (!snapshot) throw new EngineError('SNAPSHOT_EXPIRED', 'Diff snapshot is unavailable', entry.id);
      const diffBase = { source: 'opencode-snapshot' as const, scope: 'user-message' as const,
        sourceMessageId: snapshot.sourceMessageId, snapshotId: snapshot.snapshotId,
        observedAt: snapshot.observedAt, completeness: 'not-guaranteed' as const,
        compacted: record.compacted, view };
      if (view === 'stat') {
        const page = outputPage(outputStore.readDiffStat(entry.id, input.turn, snapshot.snapshotId, offset, limit), entry.id);
        return { ...common, content: page.total === 0
          ? 'OpenCode reported no snapshot entries for this turn (not proof that nothing changed).'
          : `${page.items.length} of ${page.total} diff entries`,
          offset: page.offset, nextOffset: page.nextOffset, total: page.total,
          hasMore: page.hasMore, partial: page.partial, truncated: page.hasMore,
          diff: { ...diffBase, files: page.items } };
      }
      const page = outputPage(outputStore.readPatch(entry.id, input.turn, snapshot.snapshotId, input.fileIndex!, offset, limit), entry.id);
      const file = snapshot.items[input.fileIndex!];
      return { ...common, content: page.text, offset: page.offset, nextOffset: page.nextOffset,
        total: page.total, hasMore: page.hasMore, partial: page.partial, truncated: page.hasMore,
        diff: { ...diffBase, patch: { fileIndex: input.fileIndex!, ...(file?.file !== undefined ? { file: file.file } : {}) } } };
    },
    async list(): Promise<ListResult> {
      active();
      if (!version && registry.all().length) await acquire();
      const all = registry.all();
      const isActive = (entry: TrackedSession): boolean =>
        entry.current !== undefined || entry.admission !== undefined ||
        entry.last?.status === 'waiting_for_approval';
      all.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.updatedAt - a.updatedAt);
      const sessions: SessionSummary[] = all.slice(0, 100).map((e) => ({
        sessionId: e.id,
        title: e.title,
        directory: e.directory,
        status:
          e.phase === 'ending'
            ? 'ending'
            : e.phase === 'quarantined'
              ? 'quarantined'
            : e.current
              ? e.current.snapshot().status
              : (e.last?.status ?? 'idle'),
        turns: e.turns,
        updatedAt: e.updatedAt,
        ...(e.current?.snapshot().queue ? { queue: e.current.snapshot().queue } : {}),
      }));
      return {
        kind: 'sessions',
        content:
          sessions.map((s) => `${s.sessionId}: ${s.title} (${s.status})`).join('\n') ||
          'No tracked sessions.',
        sessions,
        opencodeVersion: version,
        truncated: all.length > 100,
      };
    },
    async cancel(input: { sessionId: string }, _ctx: CallContext): Promise<TurnResult> {
      active();
      const entry = registry.get(input.sessionId);
      if (entry.admission) {
        const admission = entry.admission;
        admission.stopRequested = true;
        await withinCleanup(admission.settled, clock.monotonicNow() + config.cleanupTimeoutMs);
      }
      if (entry.current) {
        if (!connection.current()) {
          logger.warn('Cancel observed no live OpenCode lease', { sessionId: entry.id });
          return entry.current.connectionLost();
        }
        return entry.current.stop('cancelled');
      }
      if (entry.last) {
        return (await confirmQuiescence(entry, true, config.mode === 'attach' && !connection.current())) ?? entry.last;
      }
      throw new EngineError('SESSION_BUSY', `Session ${entry.id} has no turn`, entry.id);
    },
    async end(input: { sessionId: string; action?: EndAction }, _ctx: CallContext): Promise<EndResult> {
      active();
      const entry = registry.find(input.sessionId);
      if (!entry)
        return {
          kind: 'end',
          threadId: input.sessionId,
          sessionId: input.sessionId,
          status: 'not_found',
          action: 'none',
          abortedRunningTurn: false,
          cleanup: 'complete',
          content: `Session ${input.sessionId} was not found.`,
        };
      const action = input.action ?? config.endAction;
      if (action !== 'delete' && action !== 'archive')
        throw new EngineError('INVALID_ARGUMENT', 'Invalid end action');
      return endInternal(entry, action);
    },
    shutdown(_reason: string): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      slots.close();
      shuttingDown = true;
      for (const ticket of pendingStarts)
        if (ticket.state !== 'released' && ticket.state !== 'cancelled') ticket.release();
      // Freeze every admission before cleanup begins or a late acquire can POST.
      for (const entry of registry.all()) if (entry.admission) entry.admission.stopRequested = true;
      shutdownPromise = (async () => {
        const deadline = clock.monotonicNow() + config.cleanupTimeoutMs + 50;
        const warned = new Set<string>();
        const warnLeft = (entry: TrackedSession, reason: string): void => {
          if (warned.has(entry.id)) return;
          warned.add(entry.id);
          logger.warn('Session left upstream', { sessionId: entry.id, reason });
        };
        try {
          await withinCleanup(
            Promise.all(
              registry.all().map(async (entry) => {
                try {
                  if (entry.admission) await withinCleanup(entry.admission.settled, deadline);
                  if (entry.current && connection.current()) await entry.current.stop('cancelled');
                  else if (entry.current) {
                    logger.warn('Turn cleanup skipped because OpenCode has no live lease', {
                      sessionId: entry.id,
                    });
                    await entry.current.connectionLost();
                  }
                  // P3-2: also run this for a stopped-but-cleanup-unconfirmed response-loop stop
                  // (stopCleanupPending), not only 'unknown' — otherwise onExit=end can never
                  // clean such a session because its quiescence recovery never runs here.
                  const shutdownRecord = entry.turnRecords?.get(entry.last?.turn ?? -1);
                  if ((entry.last?.executionState === 'unknown' ||
                      (entry.last?.executionState === 'stopped' && entry.last?.cleanup === 'unconfirmed' &&
                        shutdownRecord?.stopCleanupPending)) && connection.current())
                    await confirmQuiescence(entry, true, false);
                  await rejectLeftovers(entry, false);
                  const canEnd = clean(entry) ||
                    (entry.phase === 'quarantined' && entry.endFailure !== undefined &&
                      entry.last?.executionState !== 'unknown' && !hasInFlight(entry) && !hasAbort(entry));
                  if (config.onExit === 'end' && canEnd && connection.current())
                    await endInternal(entry, config.endAction, false);
                  else if (config.onExit === 'end')
                    warnLeft(entry, !connection.current() ? 'no live lease' : 'cleanup remains unconfirmed');
                  else if (entry.last?.executionState === 'unknown')
                    logger.warn('Shutdown cleanup unconfirmed', { sessionId: entry.id });
                } catch {
                  if (config.onExit === 'end') warnLeft(entry, 'cleanup failed');
                  else logger.warn('Shutdown cleanup failed', { sessionId: entry.id });
                }
              }),
            ),
            deadline,
          );
        } catch {
          logger.warn('Shutdown cleanup deadline expired');
        } finally {
          if (config.onExit === 'end')
            for (const entry of registry.all()) warnLeft(entry, 'shutdown finished before end was confirmed');
          hub.close();
          try {
            await connection.close();
          } finally {
            unavailableOff();
          }
        }
      })();
      return shutdownPromise;
    },
  };
}
