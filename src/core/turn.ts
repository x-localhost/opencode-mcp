import { EngineError, OpencodeHttpError } from '../types.ts';
import type {
  ApprovalDecision,
  CallContext,
  Clock,
  Config,
  Connection,
  ConnectionLease,
  Logger,
  OcEvent,
  OcMessage,
  OcPermissionRequest,
  PromptBody,
  TurnResult,
} from '../types.ts';
import { buildContextResult, classifyOutcome, contextOverflowHint, extractInterval, interpretFinish, observedActivity, providerError, submissionEvidence, summarizeInterval, MALFORMED_STREAM_MESSAGE } from './result.ts';
import { detectResponseLoop } from './response-loop.ts';
import type { EventHub } from './hub.ts';
import type { MutationKind, TrackedSession } from './registry.ts';
import { extractOutputArtifacts } from './result.ts';
import { evaluateStructuredOutput } from './structured-output.ts';
import type { OutputSchema } from './structured-output.ts';
import { withReadRetry, isRetryableReadError, MAX_AUTOMATIC_WAIT_MS, toUpstreamErrorDetail } from '../opencode/retry.ts';
import type { OpencodeApiRetryable } from '../opencode/http.ts';
import type { ConnectionHealth } from './connection-health.ts';
import { safeSlice } from './text.ts';
import type { RunTicket } from './run-slots.ts';
import { estimatePromptTokens, promptTooLargeMessage } from './model-limits.ts';
import type { ResolvedModelLimit } from './model-limits.ts';

type StopReason = 'cancelled' | 'timeout' | 'response_loop';
type Attached = { ctx: CallContext; heartbeat?: () => void };
const neverMessage = 'Denied by opencode-mcp: approval-policy=never (no interactive approval available)';
// U06 (r1-hostile-opencode-3): bound message-history pagination in both count and (for the
// reconcile/grace read paths) time, so a hostile or buggy upstream that never stops issuing a
// fresh cursor cannot grow memory/CPU without bound or outlive a poll interval.
const MAX_INTERVAL_PAGES = 50;
// U06 (r1-hostile-opencode-9): progress text is forwarded to the MCP client verbatim; cap it so
// an oversized upstream tool title/status message can't turn into an oversized notification.
const PROGRESS_MAX_CHARS = 200;
// U06 (critic-c-parallel-subagent-load-5): coalesce a burst of message.updated events (each of
// which re-reads the whole execution interval) into at most one reconcile per debounce window;
// idle/status events still reconcile immediately.
const MESSAGE_UPDATED_DEBOUNCE_MS = 250;
const EVENT_RECONCILE_MIN_INTERVAL_MS = 1_000;
// U06 (critic-c-parallel-subagent-load-5): while the stop loop finds the root still busy, don't
// re-POST abort more than once per this interval.
const ABORT_RETRY_MS = 1000;

/** Run one admitted prompt until terminal evidence or a confirmed stop. */
export class Turn {
  phase: 'queued' | 'admitting' | 'submitting' | 'running' | 'stopping' | 'terminal' = 'admitting';
  private readyResolve: () => void = () => {};
  readonly ready: Promise<void>;
  private doneResolve: (result: TurnResult) => void = () => {};
  readonly done: Promise<TurnResult>;
  private doneValue?: TurnResult;
  private stopPromise?: Promise<TurnResult>;
  private attached = new Set<Attached>();
  private boundary?: string;
  private interval: OcMessage[] = [];
  private submittedUser?: string;
  private confirmedSubmittedUser?: string;
  private highestObservedMessageId?: string;
  private observedMessageIds = new Set<string>();
  private observedMessageCount = 0;
  private activityObserved = false;
  private maxToolCallCount = 0;
  private stopCleanupPending = false;
  private stopReason?: StopReason;
  private error?: TurnResult['error'];
  private eventError?: TurnResult['error'];
  private upstreamRetry?: TurnResult['upstreamRetry'];
  private retryActive = false;
  private responseLoop?: TurnResult['responseLoop'];
  private retryFenceId?: string;
  private retryFencePending = false;
  private lastAssistantEventId?: string;
  // P2-C: bumped only when lastAssistantEventId advances, mirroring positiveEventSerial/
  // positiveEventMarkedSerial below — lets readInterval tell whether a given read started after
  // the SSE event that announced the current newest assistant id (only such a read may be
  // rejected for lacking it; a read already in flight when the event arrives predates it).
  private lastAssistantEventSerial = 0;
  private positiveEventMessageId?: string;
  // Serials order positive SSE events against history reads: only a read that started after the
  // latest positive mark may disprove it (an older read can simply predate the part).
  private positiveEventSerial = 0;
  private positiveEventMarkedSerial = 0;
  // P3-4: monotonic time the current positiveEventMessageId was (re-)marked, so a message that
  // never shows up in any history read (the unseen-progress fence) cannot pin the watchdog off
  // for the rest of the turn — it expires after 2 * statusPollMs of silence.
  private positiveEventMarkedAt = -Infinity;
  private lastWatchdogAt = -Infinity;
  private lastEventReconcileAt = -Infinity;
  // P2-A: last time a message.part.delta carried non-empty text/reasoning for this turn — while
  // recent, it suppresses the watchdog check the same way visible progress does, without ever
  // scheduling a reconcile itself (streaming must not turn into polling).
  private lastStreamDeltaAt = -Infinity;
  private admissionFailure?: EngineError;
  private pending = new Map<string, OcPermissionRequest>();
  private approvalBusy = false;
  private deadlines = new Map<string, number>();
  // P3-3 (core review): when each id currently in `pending` was registered, so
  // scanPending's prune only drops ids the fresh list could actually have reflected — one
  // registered after the list request was issued must survive instead of being tombstoned by a
  // response that predates it.
  private pendingSince = new Map<string, number>();
  // U05 (r2-r-hostile-upstream-3): the decision already obtained for a requestId, cached right
  // after elicitation (or immediate-reject) and before the verification GET, so a failed
  // verification/reply never re-prompts a human who already answered.
  private answers = new Map<string, ApprovalDecision | null>();
  // U05 (r1-turn-lifecycle-4 / r3-r-core-5): requestIds this turn has already replied to or
  // independently confirmed OpenCode resolved (e.g. an F7 reject cascade, or a stale scanPending
  // list). permission.asked and scanPending never re-add an id in here.
  private answered = new Set<string>();
  private approvalWake?: () => void;
  private approvalController?: AbortController;
  // U05 (F7 permission.replied): the requestId the in-flight approvalController belongs to, so a
  // permission.replied event only aborts the elicitation for the id it actually resolved.
  private approvalCurrentId?: string;
  private approvalDeadlineCancel?: () => void;
  private approvalFinish?: () => void;
  private startAt: number;
  private admissionDeadlineAt: number;
  private hubClose?: () => void;
  private pollCancel?: () => void;
  private timeoutCancel?: () => void;
  private noUserCancel?: () => void;
  private reconciling = false;
  private reconcileAgain = false;
  private ambiguous = false;
  private submissionDispatched = false;
  private submissionRejected = false;
  private submissionSettledResolve: () => void = () => {};
  private submissionSettled: Promise<void>;
  private warming?: Promise<void>;
  // No-user evidence is assessed after a full poll interval from submission or later activity.
  private graceDeadline?: number;
  private observedRootUser = false;
  private executionObserved = false;
  private historyComplete = false;
  private idleFirstAt?: number;
  private idleConfirmCancel?: () => void;
  private degradedFailures = 0;
  private readFailureEpoch = 0;
  private upstreamRead?: TurnResult['upstreamRead'];
  private nextReadAt = 0;
  private unavailableOff?: () => void;
  private serverStopPromise?: Promise<void>;
  private progressText = 'OpenCode is running';
  private cleanup: 'complete' | 'unconfirmed' = 'complete';
  private executionState: 'active' | 'stopped' | 'unknown' = 'active';
  readonly entry: TrackedSession;
  readonly number: number;
  private lease: ConnectionLease;
  private connection: Connection;
  private hub: EventHub;
  private clock: Clock;
  private config: Config;
  private logger: Logger;
  private warm: (deadlineAt: number) => Promise<void>;
  private health: ConnectionHealth;
  private recovery: () => Promise<void> | undefined;
  private trackMutation: <T>(work: Promise<T>, kind: MutationKind) => Promise<T>;
  private onCommit: (result: TurnResult) => void | Promise<void>;
  private outputSchema?: OutputSchema;
  private refreshing = false;
  // U06 (r1-time-concurrency-3): a hub.reconnected that arrives while a refresh is already in
  // flight must not be dropped; re-run once the current refresh ends (mirrors reconcileAgain).
  private refreshAgain = false;
  private lastUpstreamWarning?: number;
  // U06 (critic-c-parallel-subagent-load-5): trailing debounce for message.updated-triggered
  // reconciles.
  private reconcileDebounceCancel?: () => void;
  private ticket?: RunTicket;
  private queueTimeoutMs: number | null;
  private onHeld?: (ticket: RunTicket) => void;
  private onLateConfirmedRejection?: (result: TurnResult) => void;
  private limitsForModel?: (model: string) => ResolvedModelLimit | undefined;
  constructor(
    entry: TrackedSession,
    number: number,
    lease: ConnectionLease,
    connection: Connection,
    hub: EventHub,
    clock: Clock,
    config: Config,
    logger: Logger,
    warm: (deadlineAt: number) => Promise<void>,
    health: ConnectionHealth,
    recovery: () => Promise<void> | undefined,
    trackMutation: <T>(work: Promise<T>, kind: MutationKind) => Promise<T>,
    onCommit: (result: TurnResult) => void | Promise<void>,
    outputSchema?: OutputSchema,
    admissionDeadlineAt?: number,
    ticket?: RunTicket,
    queueTimeoutMs: number | null = null,
    onHeld?: (ticket: RunTicket) => void,
    onLateConfirmedRejection?: (result: TurnResult) => void,
    limitsForModel?: (model: string) => ResolvedModelLimit | undefined,
  ) {
    this.entry = entry;
    this.number = number;
    this.lease = lease;
    this.connection = connection;
    this.hub = hub;
    this.clock = clock;
    this.config = config;
    this.logger = logger;
    this.warm = warm;
    this.health = health;
    this.recovery = recovery;
    this.trackMutation = trackMutation;
    this.onCommit = onCommit;
    this.outputSchema = outputSchema;
    this.ticket = ticket;
    this.queueTimeoutMs = queueTimeoutMs;
    this.onHeld = onHeld;
    this.onLateConfirmedRejection = onLateConfirmedRejection;
    this.limitsForModel = limitsForModel;
    if (ticket?.state === 'queued') this.phase = 'queued';
    this.startAt = clock.monotonicNow();
    this.admissionDeadlineAt = admissionDeadlineAt ??
      this.startAt + (config.startupTimeoutMs || config.sseStallMs * 2);
    this.ready = new Promise<void>((r) => {
      this.readyResolve = () => r();
    });
    this.done = new Promise<TurnResult>((r) => {
      this.doneResolve = r;
    });
    this.submissionSettled = new Promise<void>((resolve) => {
      this.submissionSettledResolve = resolve;
    });
    this.unavailableOff = connection.onUnavailable((generation, _error, kind) => {
      if (generation !== this.lease.generation) return;
      if (kind === 'exited') void this.serverStopped();
      else this.serverUnreachable();
    });
  }

  get submittedUserId(): string | undefined {
    return this.confirmedSubmittedUser;
  }
  get executionWasObserved(): boolean { return this.executionObserved; }
  get highestObservedMessage(): string | undefined { return this.highestObservedMessageId; }
  get observedMessageHistory(): string[] { return [...this.observedMessageIds]; }
  get observedMessageTotal(): number { return this.observedMessageCount; }
  get observedActivity(): boolean { return this.activityObserved; }
  get maxObservedToolCallCount(): number { return this.maxToolCallCount; }
  get needsStopCleanup(): boolean { return this.stopCleanupPending; }

  get outputArtifacts(): ReturnType<typeof extractOutputArtifacts> {
    return extractOutputArtifacts(this.interval);
  }

  get historyBoundary(): string | undefined { return this.boundary; }
  get wasSubmissionDispatched(): boolean { return this.submissionDispatched; }
  get admissionError(): EngineError | undefined { return this.admissionFailure; }
  get terminalBoundary(): string | undefined { return this.interval.at(-1)?.info.id; }

  get id(): string {
    return `${this.entry.id}#${this.number}`;
  }

  private queuedMs(): number | undefined {
    const ticket = this.ticket;
    return ticket?.everQueued
      ? Math.max(0, (ticket.grantedAtMono ?? this.clock.monotonicNow()) - ticket.queuedAtMono)
      : undefined;
  }

  private queueProgress(): string | undefined {
    const info = this.ticket?.queueInfo();
    if (!info) return undefined;
    return info.blockedBy === 'model' && info.model && info.modelMaxRunning !== undefined
      ? `Queued for an OpenCode run slot for ${info.model} (position ${info.position}; model ${info.modelRunning}/${info.modelMaxRunning} running).`.slice(0, PROGRESS_MAX_CHARS)
      : `Queued for an OpenCode run slot (position ${info.position}; ${info.running}/${info.maxRunning ?? 'unlimited'} running).`;
  }

  start(body: PromptBody, timeoutMs: number): void {
    void this.execute(body, timeoutMs);
  }

  private async execute(body: PromptBody, timeoutMs: number): Promise<void> {
    const api = this.lease.api,
      id = this.entry.id,
      directory = this.entry.directory;
    let admissionDeadline = this.admissionDeadlineAt;
    try {
      const ticket = this.ticket;
      if (ticket?.everQueued) {
        if (ticket.state === 'queued') this.phase = 'queued';
        const deadline = this.queueTimeoutMs === null ? undefined : ticket.queuedAtMono + this.queueTimeoutMs;
        let cancelQueueTimer = () => {};
        try {
          await Promise.race([
            ticket.settled,
            this.done.then(() => 'terminal' as const),
            ...(deadline === undefined ? [] : [new Promise<'cancelled'>((resolve) => {
              cancelQueueTimer = this.clock.schedule(Math.max(0, deadline - this.clock.monotonicNow()),
                () => resolve('cancelled'));
            })]),
          ]);
        } finally { cancelQueueTimer(); }
        if (this.doneValue || this.stopReason) return;
        // Grant time, not construction time, decides expiry. A delayed timer still wins if
        // the ticket had not been granted strictly before its monotonic deadline.
        const grantedInTime = ticket.state === 'granted' && ticket.grantedAtMono !== undefined &&
          (deadline === undefined || ticket.grantedAtMono < deadline);
        if (deadline !== undefined && !grantedInTime && this.clock.monotonicNow() >= deadline) {
          ticket.release();
          this.error = { name: 'QUEUE_TIMEOUT',
            message: `Waited ${this.queueTimeoutMs! / 1000}s for a run slot; nothing was submitted.`, retryable: true };
          this.executionState = 'stopped';
          this.finish('failed');
          return;
        }
        if (!grantedInTime) {
          this.executionState = 'stopped';
          this.finish('cancelled');
          return;
        }
        if (this.connection.current()?.generation !== this.lease.generation) {
          this.error = { name: 'OPENCODE_UNAVAILABLE', message: 'OpenCode server changed while the turn was queued' };
          this.executionState = 'stopped';
          this.finish('failed');
          return;
        }
        admissionDeadline = this.clock.monotonicNow() +
          (this.config.startupTimeoutMs || this.config.sseStallMs * 2);
        this.admissionDeadlineAt = admissionDeadline;
      }
      if (this.doneValue || this.stopReason) return;
      this.phase = 'admitting';
      const subscription = this.hub.listen(directory, this.lease, (event) => this.onEvent(event));
      this.hubClose = subscription.close;
      let cancelConnect = () => {};
      try {
        await Promise.race([
          subscription.connected,
          new Promise<never>((_resolve, reject) => {
            cancelConnect = this.clock.schedule(
              Math.max(1, admissionDeadline - this.clock.monotonicNow()),
              () =>
                reject(new EngineError('OPENCODE_UNAVAILABLE', 'OpenCode event stream did not connect', id)),
            );
          }),
        ]);
      } finally {
        cancelConnect();
      }
      if (this.stopReason || this.doneValue) return;
      {
        // Bounded: a hostile server listing many leftover requests must not stall admission
        // indefinitely, and a cancel/timeout arriving mid-loop must stop issuing new replies.
        const leftoverDeadline = Math.min(admissionDeadline, this.clock.monotonicNow() + this.config.cleanupTimeoutMs);
        try {
          await this.withinDeadline(this.rejectLeftovers(leftoverDeadline, true), leftoverDeadline);
        } catch (error) {
          if (error instanceof EngineError && error.code === 'CLEANUP_UNCONFIRMED')
            throw new EngineError(
              'OPENCODE_UNAVAILABLE',
              'Could not reject leftover approvals before admission',
              this.entry.id,
            );
          throw error;
        }
      }
      if (this.stopReason || this.doneValue) return;
      const status = await this.admissionStatus(admissionDeadline);
      if (this.stopReason || this.doneValue) return;
      if (status[id]) throw new EngineError('SESSION_BUSY', `OpenCode session is busy: ${id}`, id);
      this.boundary = await this.admissionBoundary(admissionDeadline);
      if (this.stopReason || this.doneValue) return;
      // The boundary is exclusive: earlier conversation cannot complete this turn.
      this.logger.debug('Turn admitted', { sessionId: id, turnId: this.id, boundaryId: this.boundary });
      this.warming = this.warm(admissionDeadline);
      try {
        await this.withinDeadline(this.warming, admissionDeadline);
      } finally {
        this.warming = undefined;
      }
      if (this.stopReason || this.doneValue) return;
      // A recovery may have been reserved while warm-up was in flight. Re-warm
      // after it releases, with a final synchronous check before dispatch.
      while (this.recovery()) {
        await this.withinDeadline(this.recovery()!, admissionDeadline);
        if (this.stopReason || this.doneValue) return;
        this.warming = this.warm(admissionDeadline);
        try {
          await this.withinDeadline(this.warming, admissionDeadline);
        } finally {
          this.warming = undefined;
        }
        if (this.stopReason || this.doneValue) return;
      }
      // Context guard: in-turn fallback after warm-up/recovery and before promptAsync.
      if (this.stopReason || this.doneValue) return;
      if (this.checkPromptGuard(body)) return;
      this.phase = 'submitting';
      if (this.entry.phase !== 'ending') this.entry.phase = 'running';
      // This synchronous flag is the ownership boundary for an ambiguous POST.
      if (this.stopReason || this.doneValue) return;
      this.submissionDispatched = true;
      try {
        await api.promptAsync(id, body);
        this.logger.info('Turn submitted', { sessionId: id, turnId: this.id });
      } catch (error) {
        // OpenCode 1.18.33 itself does not emit 429 here: our rate-limiting proxy rejects
        // before forwarding. No automatic prompt resend follows any other failure either.
        if (error instanceof OpencodeHttpError && error.status >= 400 && error.status < 500) {
          this.submissionRejected = true;
          // Re-read after the await: TS keeps the pre-await narrowing of doneValue to undefined.
          const published = this.doneValue as TurnResult | undefined;
          if (published?.executionState === 'unknown') {
            // The original POST was rejected before execution. Repair the already-published
            // outcome, including keyed replays, without clearing unrelated mutation barriers.
            const result = published;
            this.executionState = 'stopped';
            this.cleanup = this.entry.unresolvedMutations?.size ? 'unconfirmed' : 'complete';
            result.executionState = 'stopped';
            result.cleanup = this.cleanup;
            result.resendSafety = 'not_submitted';
            result.hint = this.cleanup === 'complete'
              ? 'The prompt was rejected before execution. Use opencode-reply to retry or opencode-end to finish.'
              : 'The prompt was rejected before execution, but earlier cleanup remains unconfirmed. Use opencode-status or opencode-cancel before continuing.';
            this.onLateConfirmedRejection?.(result);
          }
          if (this.stopReason || this.doneValue) return;
          this.error = { ...toUpstreamErrorDetail(error),
            name: error.status === 429 ? 'OPENCODE_OVERLOADED' : 'UPSTREAM_ERROR',
            ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: Math.min(3600, error.retryAfterSeconds) } : {}) };
          this.executionState = 'stopped';
          this.finish('failed');
          return;
        }
        this.ambiguous = true;
        this.logger.info('Turn submitted with ambiguous response', { sessionId: id, turnId: this.id });
        // The POST may have been accepted. Never retry it; observation decides later.
      } finally {
        // U06 (r3-r-hostile-upstream-3): arm the no-user grace from when the POST settles, not
        // from before it was dispatched — an ambiguous POST that itself takes close to
        // statusPollMs must not leave the grace already expired the moment it settles.
        this.graceDeadline = this.clock.monotonicNow() + 2 * this.config.statusPollMs;
        this.submissionSettledResolve();
      }
      if (this.stopReason || this.doneValue) return;
      // P3-4 (core review): bound this read the same way reconcile() does — a
      // hostile/buggy upstream that never stops issuing a fresh cursor must not stall admission
      // past a poll interval, not just past 50 pages.
      if (this.ambiguous) {
        try {
          const readStartEpoch = this.readFailureEpoch;
          await this.readInterval(this.clock.monotonicNow() + Math.max(this.config.statusPollMs, this.config.requestTimeoutMs));
          this.upstreamSucceeded(readStartEpoch);
        } catch (error) {
          // This GET cannot decide whether the POST ran. Keep observing the original turn.
          this.upstreamFailed(error);
        }
      }
      if (this.stopReason || this.doneValue) return;
      this.phase = 'running';
      this.timeoutCancel = this.clock.schedule(timeoutMs, () => {
        void this.stop('timeout');
      });
      this.armPoll();
      this.readyResolve();
      await this.reconcile();
      if (this.stopReason && !this.doneValue) void this.stop(this.stopReason);
    } catch (error) {
      if (!this.doneValue) {
        if (this.stopReason) return;
        if (this.phase === 'admitting') {
          this.admissionFailure =
            error instanceof EngineError
              ? error.sessionId
                ? error
                : new EngineError(error.code, error.message, this.entry.id, error.retryAfterSeconds)
                : error instanceof OpencodeHttpError && error.classification === 'overloaded'
                  ? new EngineError('OPENCODE_OVERLOADED', error.message.slice(0, 500), this.entry.id,
                    error.retryAfterSeconds === undefined ? undefined : Math.min(3600, error.retryAfterSeconds))
                  : new EngineError(
                    error instanceof OpencodeHttpError && error.status === 0 ? 'OPENCODE_UNAVAILABLE' : 'UPSTREAM_ERROR',
                    error instanceof Error ? error.message : String(error), this.entry.id);
          this.error = { name: this.admissionFailure.code, message: this.admissionFailure.message };
          this.executionState = 'stopped';
          this.finish('failed');
          return;
        }
        this.error = {
          name: error instanceof EngineError ? error.code : 'UPSTREAM_ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
        this.executionState = 'unknown';
        this.cleanup = 'unconfirmed';
        this.finish('failed');
      }
    } finally {
      this.readyResolve();
    }
  }

  private onEvent(event: OcEvent): void {
    const p = event.properties;
    if (event.type === 'hub.reconnected') {
      void this.refreshAfterReconnect();
      return;
    }
    if (p.sessionID !== this.entry.id) return;
    if (event.type === 'message.updated') {
      const info = p.info as { id?: string; role?: string; parentID?: string; finish?: string; error?: unknown } | undefined;
      this.deferNoUserGrace();
      if (info?.role === 'user' && !info.parentID && info.id && (!this.boundary || info.id > this.boundary)) {
        this.observedRootUser = true;
      }
      if (info?.role === 'assistant' && info.id && (!this.boundary || info.id > this.boundary)) {
        if (!this.lastAssistantEventId || info.id > this.lastAssistantEventId) {
          this.lastAssistantEventId = info.id;
          this.lastAssistantEventSerial++;
        }
        if (this.retryActive && (!this.retryFenceId || info.id > this.retryFenceId))
          this.retryFenceId = info.id;
        if (['stop', 'length', 'content-filter'].includes(info.finish ?? '') || info.error)
          this.markPositiveEvent(info.id);
      }
      // U06 (critic-c-parallel-subagent-load-5): debounce message.updated-triggered reconciles —
      // each one re-reads the whole execution interval, so a burst must not each fire it in turn.
      this.scheduleReconcile();
      return;
    }
    if (event.type === 'session.error') {
      // An event seen before this POST was dispatched cannot certify its outcome.
      if (!this.submissionDispatched) return;
      const raw = p.error as { name?: string; data?: { message?: string } } | undefined;
      this.eventError = raw?.name ? providerError({ name: raw.name, data: raw.data }, this.clock.wallNow())
        : { name: 'UPSTREAM_ERROR', message: 'OpenCode session error' };
      this.executionObserved = true;
      void this.handleSessionError();
    } else if (event.type === 'permission.asked') {
      const request = p as unknown as OcPermissionRequest;
      // U05 (r3-r-core-5): never resurrect a request this turn already answered or independently
      // confirmed resolved.
      if (request.id && !this.pending.has(request.id) && !this.answered.has(request.id)) {
        this.pending.set(request.id, request);
        this.deadlines.set(request.id, this.clock.monotonicNow() + this.config.approvalTimeoutMs);
        this.pendingSince.set(request.id, this.clock.monotonicNow());
        this.progress('Waiting for approval');
        void this.processApprovals();
      }
    } else if (event.type === 'permission.replied') {
      // U05 (r1-turn-lifecycle-4, F7): OpenCode's reject cascade (or any other external
      // resolution) replies every other pending request of the session too. Drop it here
      // immediately instead of waiting for the next elicit/poll pass to notice it is gone, and
      // abort an in-flight elicitation for this exact id.
      const requestId = String(p.requestID ?? '');
      if (requestId) {
        this.pending.delete(requestId);
        this.deadlines.delete(requestId);
        this.answers.delete(requestId);
        this.pendingSince.delete(requestId);
        this.answered.add(requestId);
        if (this.approvalCurrentId === requestId) this.approvalController?.abort();
      }
    } else if (event.type === 'question.asked') {
      const requestId = String(p.id ?? '');
      if (requestId)
        void this.trackMutation(this.lease.api.rejectQuestion(this.entry.directory, requestId, {
          timeoutMs: this.config.requestTimeoutMs,
        }), 'question').catch(
          () => {},
        );
    } else if (event.type === 'message.part.updated') {
      const part = p.part as
        | { type?: string; messageID?: string; text?: string; tool?: string; state?: { status?: string; title?: string } }
        | undefined;
      if (part?.messageID && this.submissionDispatched &&
          (!this.boundary || part.messageID > this.boundary) &&
          ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && !!part.text.trim() ||
            part.type === 'tool' && part.tool !== 'invalid' &&
              ['running', 'completed', 'error'].includes(part.state?.status ?? '') ||
            part.type !== undefined && !['step-start', 'step-finish', 'text', 'reasoning', 'tool'].includes(part.type))) {
        // Progress only suppresses the watchdog; it must not turn streaming into polling.
        this.markPositiveEvent(part.messageID);
      }
      if (part?.type === 'tool')
        this.progress(
          `${part.tool ?? 'Tool'}: ${part.state?.status ?? 'running'}${part.state?.title ? ` — ${part.state.title}` : ''}`,
        );
    } else if (event.type === 'message.part.delta') {
      // P2-A: OpenCode 1.18.33 emits message.part.updated with text:"" at stream start, then a
      // delta per chunk here (no `part` wrapper — messageID/partID/field/delta sit directly on
      // properties), and the full text only at stream end (another message.part.updated, or the
      // terminal message.updated). Without this, a genuine answer streaming right after a run of
      // bad attempts looks like another silent one to the watchdog. This only records *when*
      // text is flowing — like message.part.delta itself, it must never schedule a reconcile
      // (streaming must not turn into polling); reconcile()'s watchdog check reads the timestamp.
      const messageId = typeof p.messageID === 'string' ? p.messageID : undefined;
      const field = p.field;
      const delta = p.delta;
      if (this.submissionDispatched && messageId && (!this.boundary || messageId > this.boundary) &&
          (field === 'text' || field === 'reasoning') && typeof delta === 'string' && delta.length > 0)
        this.lastStreamDeltaAt = this.clock.monotonicNow();
    } else if (event.type === 'session.status') {
      const status = p.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined;
      this.observeStatus(status);
      if (status?.type === 'busy' || status?.type === 'retry') {
        if (this.submittedUser || this.observedRootUser) this.executionObserved = true;
        this.deferNoUserGrace();
      }
      if (status?.type === 'idle') void this.reconcile();
    } else if (event.type === 'session.idle') void this.reconcile();
  }

  private async handleSessionError(): Promise<void> {
    // Our own abort emits session.error (MessageAbortedError) before idle; the stop path owns
    // the terminal status once it has started, so this must never race it to 'failed'.
    if (this.doneValue || this.stopReason) return;
    await this.submissionSettled;
    if (this.doneValue || this.stopReason) return;
    // The event is execution evidence, but only a complete idle observation can certify stop.
    void this.reconcile();
  }

  private resetIdleConfirmation(): void {
    this.idleFirstAt = undefined;
    this.idleConfirmCancel?.();
    this.idleConfirmCancel = undefined;
  }

  private confirmIdleAfterDelay(): boolean {
    const now = this.clock.monotonicNow();
    if (this.idleFirstAt === undefined) this.idleFirstAt = now;
    if (now - this.idleFirstAt >= 5_000) {
      this.idleConfirmCancel?.();
      this.idleConfirmCancel = undefined;
      return true;
    }
    if (!this.idleConfirmCancel) this.idleConfirmCancel = this.clock.schedule(
      this.idleFirstAt + 5_000 - now,
      () => { this.idleConfirmCancel = undefined; void this.reconcile(); },
    );
    return false;
  }

  private async refreshAfterReconnect(): Promise<void> {
    if (this.doneValue || this.stopReason || this.serverStopPromise) return;
    // U06 (r1-time-concurrency-3): EventHub emits hub.reconnected both before the backoff wait and
    // after the new stream actually connects. A refresh already in flight (e.g. its acquire() or
    // reads outlast the backoff) must not silently drop the second one — re-run once it ends,
    // mirroring reconcileAgain.
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const lease = await this.connection.acquire();
      if (this.serverStopPromise || this.doneValue) return;
      if (lease.generation !== this.lease.generation) {
        if (this.config.mode === 'attach') this.serverUnreachable();
        else await this.serverStopped();
        return;
      }
      await this.scanPending();
      await this.reconcile();
    } catch (error) {
      this.upstreamFailed(error);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refreshAfterReconnect();
      }
    }
  }

  private deferNoUserGrace(): void {
    if (this.submittedUser || this.observedRootUser) return;
    this.graceDeadline = this.clock.monotonicNow() + this.config.statusPollMs;
    this.noUserCancel?.();
    this.noUserCancel = undefined;
  }

  private armNoUserGrace(): void {
    if (this.noUserCancel || this.submittedUser || this.observedRootUser || this.doneValue) return;
    const remaining = Math.max(
      0,
      (this.graceDeadline ?? this.clock.monotonicNow()) - this.clock.monotonicNow(),
    );
    this.noUserCancel = this.clock.schedule(remaining, () => {
      this.noUserCancel = undefined;
      void this.checkNoUserAfterGrace();
    });
  }

  private serverStopped(): Promise<void> {
    if (this.serverStopPromise) return this.serverStopPromise;
    if (this.doneValue) return Promise.resolve();
    this.serverStopPromise = (async () => {
      if (this.submissionDispatched) {
        try {
          await this.readInterval(this.clock.monotonicNow() + this.config.cleanupTimeoutMs);
        } catch {
          /* Partial history is best effort. */
        }
      }
      if (this.doneValue) return;
      this.logger.info('Turn server stopped', { sessionId: this.entry.id, turnId: this.id });
      this.executionState = 'stopped';
      this.cleanup = 'complete';
      // A server loss while our own stop is in flight still commits the stop reason (cancelled/
      // timeout), not 'failed': the runner is provably gone, which is exactly what a stop wants.
      if (this.stopReason) {
        this.error = {
          name: 'OPENCODE_UNAVAILABLE',
          message: 'OpenCode server stopped while the turn was being stopped',
        };
        this.finish(this.stopReason === 'response_loop' ? 'failed' : this.stopReason);
      } else {
        this.error = { name: 'OPENCODE_UNAVAILABLE', message: 'OpenCode server stopped during the turn' };
        this.finish('failed');
      }
    })();
    return this.serverStopPromise;
  }

  private serverUnreachable(): void {
    if (this.doneValue) return;
    if (this.stopReason !== 'response_loop')
      this.error = { name: 'OPENCODE_UNAVAILABLE', message: 'OpenCode server unreachable' };
    // This turn owns no possible upstream execution until its own POST starts.
    this.executionState = this.submissionDispatched ? 'unknown' : 'stopped';
    this.cleanup = this.submissionDispatched ? 'unconfirmed' : 'complete';
    this.finish('failed');
  }

  private upstreamSucceeded(startEpoch: number): void {
    this.health.succeeded();
    if (startEpoch !== this.readFailureEpoch) return;
    this.degradedFailures = 0;
    this.upstreamRead = undefined;
    this.nextReadAt = 0;
  }

  private upstreamFailed(error: unknown): void {
    if (this.doneValue || this.stopReason) return;
    this.health.failed(error);
    if (!(error instanceof OpencodeHttpError)) return;
    this.readFailureEpoch++;
    const now = this.clock.monotonicNow();
    const poll = this.config.statusPollMs;
    const failures = ++this.degradedFailures;
    const jitterCap = Math.min(3 * poll, poll * (2 ** Math.min(failures, 10) - 1));
    const retryAfter = error.retryAfterSeconds === undefined ? 0 :
      Math.min(MAX_AUTOMATIC_WAIT_MS, error.retryAfterSeconds * 1000);
    const delay = Math.max(poll + Math.random() * jitterCap, retryAfter);
    this.nextReadAt = Math.max(this.nextReadAt, now + delay);
    const reason: NonNullable<TurnResult['upstreamRead']>['reason'] =
      [429, 503, 529].includes(error.status) ? 'overloaded' :
      error.errorName === 'TimeoutError' || error.status === 408 ? 'timeout' :
      error.errorName === 'ProtocolError' ? 'protocol' :
      error.status === 0 ? 'network' : 'server_error';
    // P3-3: a stale-relative-to-HTTP-or-SSE read (the P1-2/P2-C consistency guards) is a
    // ProtocolError that itself carries a normal 2xx status — the request succeeded; only its
    // *content* was inconsistent. Reporting that as "HTTP 200" reads as a server error it never
    // was, so this (and any other 2xx, defensively) omits statusCode and falls back to the
    // reason label instead.
    const omitStatus = error.errorName === 'ProtocolError' || (error.status >= 200 && error.status < 300);
    this.upstreamRead = {
      state: 'degraded', reason,
      ...(!omitStatus && error.status >= 100 && error.status <= 599 ? { statusCode: error.status } : {}),
      since: this.upstreamRead?.since ?? this.clock.wallNow(),
      nextAt: this.clock.wallNow() + Math.max(0, this.nextReadAt - now),
    };
    const label = omitStatus ? reason : error.status > 0 ? `HTTP ${error.status}` : reason;
    this.progress(`OpenCode reads are delayed (${label}); next check in ${Math.ceil((this.nextReadAt - now) / 1000)}s.`);
    this.armPoll();
    if (this.lastUpstreamWarning === undefined || now - this.lastUpstreamWarning >= 60_000) {
      this.logger.warn('Turn upstream request failed', {
        sessionId: this.entry.id, turnId: this.id, errorName: error.name,
      });
      this.lastUpstreamWarning = now;
    }
  }

  /** Settle a turn after its live server disappears, without sending an abort. */
  connectionLost(): Promise<TurnResult> {
    if (this.config.mode === 'attach') this.serverUnreachable();
    else void this.serverStopped();
    return this.done;
  }

  private progress(message: string): void {
    // U06 (r1-hostile-opencode-9): collapse to one line and bound the length before this ever
    // reaches progressText or an attached call's progress sink — tool titles/status messages come
    // straight from upstream with no size limit of their own.
    const text = message.replace(/[\r\n]+/g, ' ').slice(0, PROGRESS_MAX_CHARS);
    this.progressText = text;
    for (const a of this.attached) {
      try {
        a.ctx.progress?.(text);
      } catch {
        this.attached.delete(a);
        a.heartbeat?.();
      }
    }
  }

  private armPoll(): void {
    this.pollCancel?.();
    const delay = Math.max(this.config.statusPollMs, this.nextReadAt - this.clock.monotonicNow());
    this.pollCancel = this.clock.schedule(delay, () => {
      void this.scanPending();
      void this.reconcile();
      if (!this.doneValue) this.armPoll();
    });
  }

  /** Trailing debounce for message.updated-triggered reconciles (idle/status events reconcile
   * immediately, bypassing this). */
  private scheduleReconcile(): void {
    if (this.clock.monotonicNow() < this.nextReadAt) return;
    if (this.reconcileDebounceCancel) return;
    // Non-starving: a later event never postpones an already scheduled reconcile, and
    // event-driven reconciles start at most once per second, so a hot upstream loop emitting
    // several message.updated events per second cannot turn into rapid history polling.
    const delay = Math.max(MESSAGE_UPDATED_DEBOUNCE_MS,
      this.lastEventReconcileAt + EVENT_RECONCILE_MIN_INTERVAL_MS - this.clock.monotonicNow());
    this.reconcileDebounceCancel = this.clock.schedule(delay, () => {
      this.reconcileDebounceCancel = undefined;
      this.lastEventReconcileAt = this.clock.monotonicNow();
      void this.reconcile();
    });
  }

  private markPositiveEvent(messageId: string): void {
    this.positiveEventSerial++;
    if (!this.positiveEventMessageId || messageId >= this.positiveEventMessageId) {
      this.positiveEventMessageId = messageId;
      this.positiveEventMarkedSerial = this.positiveEventSerial;
      // P3-4: (re-)start the unseen-progress fence's own clock every time the mark advances, so
      // it is the time since the LATEST mark — not the first one ever seen — that is measured.
      this.positiveEventMarkedAt = this.clock.monotonicNow();
    }
  }

  private observeStatus(status: { type?: string; attempt?: number; message?: string; next?: number } | undefined): void {
    // A stop result retains the provider-retry observation present when stopping began.
    if (this.stopReason) return;
    if (status?.type === 'retry') {
      this.retryActive = true;
      this.upstreamRetry = undefined;
      const observedAssistant = this.interval.filter((m) => m.info.role === 'assistant').at(-1)?.info.id;
      if (!observedAssistant) this.retryFencePending = true;
      this.retryFenceId = [this.retryFenceId, this.lastAssistantEventId, observedAssistant]
        .filter((id): id is string => !!id).sort().at(-1);
      if (Number.isInteger(status.attempt) && status.attempt! >= 0 && status.attempt! <= 1_000_000 &&
          typeof status.message === 'string') {
        const nextAt = typeof status.next === 'number' && Number.isSafeInteger(status.next) &&
          status.next >= 0 && status.next <= 8_640_000_000_000_000
          ? status.next : undefined;
        this.upstreamRetry = { attempt: status.attempt!,
          message: safeSlice(status.message.replace(/[\r\n\u2028\u2029]+/g, ' '), 200),
          observedAt: this.clock.wallNow(), ...(nextAt !== undefined ? { nextAt } : {}) };
        const seconds = nextAt === undefined ? '' : `; next retry in ${Math.max(0, Math.ceil((nextAt - this.clock.wallNow()) / 1000))}s`;
        this.progress(`OpenCode is retrying the model provider (attempt ${status.attempt})${seconds}.`);
      }
    } else if (!status || status.type === 'busy' || status.type === 'idle') {
      this.retryActive = false;
      this.upstreamRetry = undefined;
    }
  }

  private remaining(deadline: number): number {
    const left = deadline - this.clock.monotonicNow();
    if (left <= 0) throw new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup deadline expired', this.entry.id);
    return Math.max(1, Math.ceil(left));
  }

  private async withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    let cancel = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          cancel = this.clock.schedule(this.remaining(deadline), () =>
            reject(new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup deadline expired', this.entry.id)),
          );
        }),
      ]);
    } finally {
      cancel();
    }
  }

  private admissionRetry<T>(deadlineAt: number, attempt: (timeoutMs: number) => Promise<T>): Promise<T> {
    return withReadRetry(({ timeoutMs }) => attempt(timeoutMs), {
      deadlineAt, maxAttempts: this.config.readRetryAttempts, clock: this.clock,
      requestTimeoutMs: this.config.requestTimeoutMs || 30_000,
    });
  }

  private admissionStatus(deadlineAt: number): ReturnType<ConnectionLease['api']['sessionStatus']> {
    const api = this.lease.api as OpencodeApiRetryable;
    return api.sessionStatusWithRetry
      ? api.sessionStatusWithRetry(this.entry.directory, { deadlineAt, maxAttempts: this.config.readRetryAttempts })
      : this.admissionRetry(deadlineAt, (timeoutMs) => api.sessionStatus(this.entry.directory, { timeoutMs }));
  }

  private admissionBoundary(deadlineAt: number): Promise<string | undefined> {
    const api = this.lease.api as OpencodeApiRetryable;
    const known = this.entry.upstreamHistoryKnown === true;
    return withReadRetry(async ({ timeoutMs }) => {
      const page = api.messagesWithRetry
        ? await api.messagesWithRetry(this.entry.id, { limit: 1 }, { deadlineAt, maxAttempts: 1 })
        : await api.messages(this.entry.id, { limit: 1 }, { timeoutMs });
      if (known && page.items.length === 0)
        throw new OpencodeHttpError('Known session history disappeared at admission', 200, 'ProtocolError');
      if (page.items.length) this.entry.upstreamHistoryKnown = true;
      return page.items.at(-1)?.info.id;
    }, {
      deadlineAt, maxAttempts: this.config.readRetryAttempts, clock: this.clock,
      requestTimeoutMs: this.config.requestTimeoutMs || 30_000,
    });
  }

  private async cleanupRead<T>(deadline: number, read: (timeoutMs: number) => Promise<T>): Promise<T> {
    let failures = 0;
    while (true) {
      try {
        return await this.withinDeadline(read(Math.min(this.config.requestTimeoutMs || 5_000, 5_000, this.remaining(deadline))), deadline);
      } catch (error) {
        if (error instanceof EngineError && error.code === 'CLEANUP_UNCONFIRMED') throw error;
        if (!isRetryableReadError(error)) throw error;
        await this.cleanupPause(deadline, ++failures, error);
      }
    }
  }

  private async readInterval(deadline?: number, cleanup = false): Promise<void> {
    const pages: OcMessage[][] = [];
    let before: string | undefined;
    const seen = new Set<string>();
    // P2-C: snapshotting these here — before the first page request — captures exactly what this
    // particular read "started after". An id/serial that only advances later (mid-read) must
    // never be blamed on this read; see the consistency check below.
    const assistantIdAtStart = this.lastAssistantEventId;
    const assistantSerialAtStart = this.lastAssistantEventSerial;
    while (true) {
      if (deadline !== undefined && deadline <= this.clock.monotonicNow() && !cleanup)
        throw new OpencodeHttpError('message read deadline expired', 0, 'TimeoutError');
      const page = await this.lease.api.messages(
        this.entry.id,
        { limit: 100, ...(before ? { before } : {}) },
        // P3-5: share the operation deadline (not just a per-attempt timeoutMs) so the adapter's
        // own page-size fallback ladder (ResponseTooLarge retries at a smaller limit) cannot
        // overrun this read's budget one rung at a time.
        deadline === undefined ? undefined : { timeoutMs: Math.min(this.config.requestTimeoutMs || 30_000, cleanup ? 5_000 : Infinity, this.remaining(deadline)), deadlineAt: deadline },
      );
      // U06 (r1-hostile-opencode-3): an empty page (no items, possibly still with a cursor) can
      // never contain the boundary or new evidence; stop instead of looping forever.
      if (page.items.length === 0) break;
      pages.push(page.items);
      if (
        page.items.some((x) => x.info.id === this.boundary) ||
        !page.nextCursor ||
        seen.has(page.nextCursor)
      )
        break;
      if (pages.length >= MAX_INTERVAL_PAGES) {
        this.logger.warn('Turn message pagination exceeded the page cap', {
          sessionId: this.entry.id,
          turnId: this.id,
          pages: MAX_INTERVAL_PAGES,
        });
        throw new EngineError(
          'UPSTREAM_ERROR',
          `Message history pagination exceeded ${MAX_INTERVAL_PAGES} pages`,
          this.entry.id,
        );
      }
      seen.add(page.nextCursor);
      before = page.nextCursor;
    }
    const interval = extractInterval(pages, this.boundary);
    const freshIds = new Set(interval.map((message) => message.info.id));
    if ((this.confirmedSubmittedUser && !interval.some((m) => m.info.id === this.confirmedSubmittedUser)) ||
        (this.highestObservedMessageId && !interval.some((m) => m.info.id === this.highestObservedMessageId)) ||
        [...this.observedMessageIds].some((id) => !freshIds.has(id)) ||
        interval.length < this.observedMessageCount ||
        // P2-C: an SSE-announced assistant id newer than anything this read has ever produced is
        // execution evidence too — a read that itself started after that announcement and still
        // lacks the id is stale relative to SSE, the same way one that drops a known id is stale
        // relative to HTTP above. assistantSerialAtStart > 0 gates this on an announcement having
        // actually happened before this read began; a read that started earlier (or before any
        // assistant was ever announced) is exempt — it cannot be expected to reflect an event it
        // predates.
        (assistantSerialAtStart > 0 && assistantIdAtStart !== undefined && !freshIds.has(assistantIdAtStart)))
      throw new OpencodeHttpError('Known turn history missing from fresh read', 200, 'ProtocolError');
    this.interval = interval;
    if (this.retryFencePending) {
      const latestAssistant = interval.filter((message) => message.info.role === 'assistant').at(-1)?.info.id;
      if (latestAssistant) {
        if (!this.retryFenceId || latestAssistant > this.retryFenceId) this.retryFenceId = latestAssistant;
        this.retryFencePending = false;
      }
    }
    this.observedMessageCount = Math.max(this.observedMessageCount, freshIds.size);
    // P3-7: the 4096 cap bounds this set's memory, not correctness — observedMessageCount above
    // (a plain running max) still enforces that the interval can never shrink even past the cap.
    // Once reached, no further ids are tracked, so the "known id missing" check above stops
    // gaining new members to check, but every id already inside keeps being enforced; no real
    // turn's message count comes remotely close to this bound.
    if (this.observedMessageIds.size + freshIds.size <= 4096)
      for (const id of freshIds) this.observedMessageIds.add(id);
    this.activityObserved ||= observedActivity(interval);
    this.maxToolCallCount = Math.max(this.maxToolCallCount,
      interval.reduce((count, message) => count + message.parts.filter((part) => part.type === 'tool').length, 0));
    const highest = interval.at(-1)?.info.id;
    if (highest && (!this.highestObservedMessageId || highest > this.highestObservedMessageId))
      this.highestObservedMessageId = highest;
    if (interval.length) this.entry.upstreamHistoryKnown = true;
    this.submittedUser = this.interval.find((m) => m.info.role === 'user' && !m.info.parentID)?.info.id;
    if (!this.confirmedSubmittedUser && this.submissionDispatched && this.submittedUser)
      this.confirmedSubmittedUser = this.submittedUser;
    if (this.submittedUser && submissionEvidence(this.interval).assistant !== 'absent') this.executionObserved = true;
  }

  async reconcile(): Promise<void> {
    if (this.doneValue || this.stopReason || this.phase === 'queued' || this.phase === 'admitting' || this.phase === 'submitting') return;
    if (this.clock.monotonicNow() < this.nextReadAt) return;
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    const readStartEpoch = this.readFailureEpoch;
    const positiveSerialAtReadStart = this.positiveEventSerial;
    try {
      // U06 (r1-hostile-opencode-3): a read loop must never outlive a poll interval.
      const deadline = this.clock.monotonicNow() + Math.max(this.config.statusPollMs, this.config.requestTimeoutMs);
      const previousHighest = this.highestObservedMessageId;
      await this.readInterval(deadline);
      const status = await this.lease.api.sessionStatus(this.entry.directory);
      this.observeStatus(status[this.entry.id]);
      const idle = !status[this.entry.id] || status[this.entry.id]?.type === 'idle';
      // The runner may finish between the history and status requests.
      if (idle) await this.readInterval(deadline);
      this.upstreamSucceeded(readStartEpoch);
      if (this.stopReason) return;
      const positiveMessage = this.interval.find((message) => message.info.id === this.positiveEventMessageId);
      const progressVisible = positiveMessage && (
        ['stop', 'length', 'content-filter'].includes(positiveMessage.info.finish ?? '') || !!positiveMessage.info.error ||
        positiveMessage.parts.some((part) =>
          ((part.type === 'text' || part.type === 'reasoning') && !!part.text?.trim()) ||
          (part.type === 'tool' && part.tool !== 'invalid' &&
            ['running', 'completed', 'error'].includes(part.state?.status ?? '')) ||
          !['step-start', 'step-finish', 'text', 'reasoning', 'tool'].includes(part.type)));
      // A transient part update can be superseded before the next history read. Once that
      // message is present in a read that started after the event, its validated parts decide
      // whether progress was real; an earlier read may predate the part and decides nothing.
      if (positiveMessage && !progressVisible && this.positiveEventMarkedSerial <= positiveSerialAtReadStart)
        this.positiveEventMessageId = undefined;
      // P3-4: the message a positive event announced can also simply never show up (e.g. an SSE
      // part for a messageID that never lands in history within any read). Without a separate
      // expiry, that unseen-progress fence would pin the watchdog off for the rest of the turn.
      if (this.positiveEventMessageId !== undefined && !positiveMessage &&
          this.clock.monotonicNow() - this.positiveEventMarkedAt >= 2 * this.config.statusPollMs)
        this.positiveEventMessageId = undefined;
      const unseenProgress = this.positiveEventMessageId !== undefined && !progressVisible;
      if (status[this.entry.id]?.type === 'busy' && !this.retryActive && !unseenProgress && this.pending.size === 0 && this.config.responseLoopLimit > 0 &&
          this.submittedUser && this.clock.monotonicNow() - this.lastWatchdogAt >= 1_000 &&
          // P2-A: text/reasoning is actively streaming for this turn; suppress the check (not the
          // evidence) while recent — never schedule extra polling from message.part.delta itself.
          this.clock.monotonicNow() - this.lastStreamDeltaAt >= 10_000) {
        this.lastWatchdogAt = this.clock.monotonicNow();
        const evidence = detectResponseLoop(this.interval, this.submittedUser, this.config.responseLoopLimit, this.retryFenceId);
        if (evidence) {
          this.responseLoop = evidence;
          this.progress('Repeated unusable model responses detected; requesting OpenCode stop.');
          void this.stop('response_loop');
          return;
        }
      }
      if (!this.submittedUser) {
        if (this.eventError && idle) {
          this.noUserCancel?.();
          this.noUserCancel = undefined;
          if (this.confirmIdleAfterDelay()) {
            this.error = this.eventError;
            this.executionState = 'stopped';
            this.cleanup = 'complete';
            this.finish('failed');
          }
          return;
        }
        if (!idle) this.resetIdleConfirmation();
        if (idle) this.armNoUserGrace();
        else {
          this.deferNoUserGrace();
        }
        return;
      }
      this.noUserCancel?.();
      this.noUserCancel = undefined;
      if (!idle) this.executionObserved = true;
      if (!idle || (previousHighest && previousHighest !== this.highestObservedMessageId))
        this.resetIdleConfirmation();
      const evidence = submissionEvidence(this.interval);
      if (idle && evidence.assistant !== 'terminal') {
        if (!this.executionObserved || this.entry.unresolvedMutations?.size) return;
        if (!this.confirmIdleAfterDelay()) return;
      }
      const outcome = classifyOutcome(this.interval, idle, this.clock.wallNow(), this.activityObserved);
      this.logger.debug('Turn reconcile outcome', {
        sessionId: this.entry.id,
        turnId: this.id,
        status: outcome.status,
        idle,
      });
      if (outcome.status !== 'running') {
        this.historyComplete = idle;
        this.error =
          outcome.status === 'failed' && outcome.error?.name === 'TURN_INCOMPLETE'
            ? (this.eventError ?? outcome.error)
            : outcome.error;
        this.executionState = 'stopped';
        this.finish(outcome.status);
      }
    } catch (error) {
      this.resetIdleConfirmation();
      this.upstreamFailed(error);
    } finally {
      this.reconciling = false;
      if (this.reconcileAgain) {
        this.reconcileAgain = false;
        void this.reconcile();
      }
    }
  }

  private async checkNoUserAfterGrace(): Promise<void> {
    if (this.doneValue || this.stopReason) return;
    if (this.eventError) { void this.reconcile(); return; }
    if (this.clock.monotonicNow() < this.nextReadAt) {
      this.noUserCancel = this.clock.schedule(this.nextReadAt - this.clock.monotonicNow(), () => {
        this.noUserCancel = undefined;
        void this.checkNoUserAfterGrace();
      });
      return;
    }
    try {
      // U06 (r1-hostile-opencode-3): a read loop must never outlive a poll interval.
      const readStartEpoch = this.readFailureEpoch;
      const deadline = this.clock.monotonicNow() + Math.max(this.config.statusPollMs, this.config.requestTimeoutMs);
      await this.readInterval(deadline);
      const status = await this.lease.api.sessionStatus(this.entry.directory);
      if (!status[this.entry.id] || status[this.entry.id]?.type === 'idle')
        await this.readInterval(deadline);
      this.upstreamSucceeded(readStartEpoch);
      if (
        this.submittedUser ||
        this.observedRootUser ||
        (status[this.entry.id] && status[this.entry.id]?.type !== 'idle') ||
        this.doneValue ||
        this.stopReason
      )
        return;
      if (this.clock.monotonicNow() < (this.graceDeadline ?? 0)) {
        this.armNoUserGrace();
        return;
      }
      if (this.ambiguous) this.submissionUnconfirmed();
      else {
        // A 204 can precede runner creation by longer than the poll interval.
        // Only a later stop with submission evidence may certify stopped.
        this.progress('Waiting for OpenCode to start the prompt');
        this.logger.debug('Turn awaiting submitted user message', {
          sessionId: this.entry.id,
          turnId: this.id,
        });
      }
    } catch (error) {
      this.upstreamFailed(error);
    }
  }

  private submissionUnconfirmed(): void {
    this.error = { name: 'SUBMISSION_UNCONFIRMED', message: 'Submission is unconfirmed. Do not resend. Use opencode-status to observe the existing session.' };
    this.executionState = 'unknown';
    this.cleanup = 'unconfirmed';
    this.finish('failed');
  }

  private async scanPending(): Promise<void> {
    if (this.clock.monotonicNow() < this.nextReadAt) return;
    // P3-3 (core review): a list response can only speak for ids that already
    // existed when it was issued. An id registered after that (e.g. a permission.asked delivered
    // while this request was in flight) must survive an absence in this particular response.
    const issuedAt = this.clock.monotonicNow();
    try {
      const fresh = await this.lease.api.listPermissions(this.entry.directory);
      this.health.succeeded();
      // U05 (r1-turn-lifecycle-4): prune anything this turn still thinks is pending but the fresh
      // directory-scoped list (F2, authoritative) no longer carries — e.g. an F7 reject cascade
      // this session never observed a permission.replied event for.
      const freshIds = new Set(fresh.filter((p) => p.sessionID === this.entry.id).map((p) => p.id));
      for (const id of [...this.pending.keys()])
        if (!freshIds.has(id) && (this.pendingSince.get(id) ?? 0) < issuedAt) {
          this.pending.delete(id);
          this.deadlines.delete(id);
          this.answers.delete(id);
          this.pendingSince.delete(id);
          this.answered.add(id);
          // P3-5 (core review): a pruned id can be mid-elicitation; the
          // permission.replied handler already aborts it for this same reason.
          if (this.approvalCurrentId === id) this.approvalController?.abort();
        }
      for (const p of fresh)
        // U05 (r3-r-core-5): never resurrect an id this turn already answered or confirmed
        // resolved, even from a list response that raced a reply.
        if (p.sessionID === this.entry.id && !this.pending.has(p.id) && !this.answered.has(p.id)) {
          this.pending.set(p.id, p);
          this.deadlines.set(p.id, this.clock.monotonicNow() + this.config.approvalTimeoutMs);
          this.pendingSince.set(p.id, this.clock.monotonicNow());
        }
      void this.processApprovals();
    } catch (error) {
      this.upstreamFailed(error);
    }
  }

  private async processApprovals(): Promise<void> {
    if (this.approvalBusy || this.doneValue || this.stopReason) return;
    this.approvalBusy = true;
    try {
      while (this.pending.size && !this.doneValue && !this.stopReason) {
        const request = this.pending.values().next().value as OcPermissionRequest;
        if (this.entry.approvalPolicy === 'never') {
          this.logger.info('Turn approval decision', {
            sessionId: this.entry.id,
            turnId: this.id,
            permissionId: request.id,
            permission: request.permission,
            patternCount: request.patterns.length,
            decision: 'reject',
          });
          await this.trackMutation(
            this.lease.api.replyPermission(this.entry.directory, request.id, 'reject', neverMessage, {
              timeoutMs: this.config.requestTimeoutMs,
            }),
            'reply',
          );
          this.answered.add(request.id);
          this.pending.delete(request.id);
          // U05 (r1-security-secrets-2): the on-request branch below always clears its deadline
          // entry too; this branch previously did not, leaking one entry per never-policy ask.
          this.deadlines.delete(request.id);
          this.pendingSince.delete(request.id);
          continue;
        }

        // U05 (r1-turn-lifecycle-4 / r3-r-core-5): re-verify against the authoritative
        // directory-scoped list before ever eliciting a human, so a request OpenCode already
        // resolved (e.g. an F7 reject cascade) is skipped instead of prompted for again.
        try {
          const fresh = await this.lease.api.listPermissions(this.entry.directory);
          if (!fresh.some((p) => p.id === request.id && p.sessionID === this.entry.id)) {
            this.pending.delete(request.id);
            this.deadlines.delete(request.id);
            this.answers.delete(request.id);
            this.pendingSince.delete(request.id);
            this.answered.add(request.id);
            continue;
          }
        } catch {
          // A failed pre-check must not block progress; the post-elicit verification below
          // re-checks (and itself tolerates a failure) before ever replying.
        }
        if (this.doneValue || this.stopReason) break;
        if (!this.pending.has(request.id)) continue; // tombstoned by permission.replied meanwhile

        const deadline =
          this.deadlines.get(request.id) ?? this.clock.monotonicNow() + this.config.approvalTimeoutMs;
        // U05 (r2-r-hostile-upstream-3): reuse an answer already obtained for this requestId
        // instead of eliciting a human a second time for a decision they already gave.
        const cached = this.answers.has(request.id);
        let answer: ApprovalDecision | null = cached ? (this.answers.get(request.id) ?? null) : null;
        if (!cached) {
          let eligible = [...this.attached].find((a) => a.ctx.elicit);
          // U05 (r1-hostile-client-1): if every attached call has declared it can never elicit
          // (no elicitation capability on that connection), waiting out the full approval
          // deadline can never be satisfied by a later attach; reject immediately instead. Keep
          // waiting only while no call is attached at all (design.md §5.4).
          const noneCanElicit = () =>
            this.attached.size > 0 && !eligible && [...this.attached].every((a) => a.ctx.elicitationUnsupported);
          while (
            !eligible &&
            !this.stopReason &&
            !this.doneValue &&
            this.clock.monotonicNow() < deadline &&
            this.pending.has(request.id) &&
            !noneCanElicit()
          ) {
            await new Promise<void>((resolve) => {
              const cancel = this.clock.schedule(Math.max(0, deadline - this.clock.monotonicNow()), () =>
                resolve(),
              );
              this.approvalWake = () => {
                cancel();
                resolve();
              };
            });
            this.approvalWake = undefined;
            eligible = [...this.attached].find((a) => a.ctx.elicit);
          }
          if (!this.pending.has(request.id)) continue; // tombstoned while waiting for an eligible call
          if (eligible?.ctx.elicit) {
            const controller = new AbortController();
            this.approvalController = controller;
            this.approvalCurrentId = request.id;
            let cancelDeadline = () => {};
            answer = await Promise.race([
              eligible.ctx
                .elicit(
                  {
                    requestId: request.id,
                    sessionId: this.entry.id,
                    turnId: this.id,
                    permission: request.permission,
                    patterns: request.patterns,
                    metadata: request.metadata,
                    // U05 (r1-mcp-tools-1): remaining time to this request's own deadline, forwarded
                    // by buildElicit as the MCP request's timeout so the SDK's own 60 s default
                    // never auto-rejects an approval before the real window elapses.
                    timeoutMs: Math.max(1, deadline - this.clock.monotonicNow()),
                  },
                  controller.signal,
                )
                .catch(() => null),
              new Promise<null>((resolve) => {
                cancelDeadline = this.clock.schedule(Math.max(0, deadline - this.clock.monotonicNow()), () => {
                  controller.abort();
                  resolve(null);
                });
                this.approvalDeadlineCancel = cancelDeadline;
              }),
              new Promise<null>((resolve) => {
                this.approvalFinish = () => resolve(null);
              }),
            ]);
            cancelDeadline();
            this.approvalDeadlineCancel = undefined;
            this.approvalFinish = undefined;
            this.approvalController = undefined;
            this.approvalCurrentId = undefined;
            // A batch observer can dispose its dialog while the permission remains live.
            // Detachment is not a human decline; keep the original absolute deadline.
            if (answer === null && !this.attached.has(eligible) && this.clock.monotonicNow() < deadline)
              continue;
          }
          if (this.doneValue || this.stopReason) break;
          if (!this.pending.has(request.id)) continue; // tombstoned mid-elicit (permission.replied)
          this.answers.set(request.id, answer);
        }
        if (this.doneValue || this.stopReason) break;
        let still: boolean;
        try {
          still = (await this.lease.api.listPermissions(this.entry.directory)).some(
            (p) => p.id === request.id && p.sessionID === this.entry.id,
          );
        } catch {
          // U05 (r2-r-hostile-upstream-3): never turn a transport failure into a lost decision —
          // treat it as still pending and go straight to the reply below instead of dropping the
          // already-obtained answer. A genuine 404-equivalent absence (the try above) is the only
          // thing that counts as "already resolved".
          still = true;
        }
        // Cancellation may happen while the pending-permission lookup is in flight.
        if (this.stopReason || this.doneValue || this.entry.current !== this) break;
        if (still) {
          const decision =
            answer?.decision === 'allow' && this.clock.monotonicNow() < deadline ? 'once' : 'reject';
          this.logger.info('Turn approval decision', {
            sessionId: this.entry.id,
            turnId: this.id,
            permissionId: request.id,
            permission: request.permission,
            patternCount: request.patterns.length,
            decision,
          });
          // A throw here (network/5xx) intentionally propagates to the outer catch below,
          // leaving `request.id` in `pending` with its cached `answers` entry intact so the next
          // processApprovals pass retries the reply with the same decision instead of eliciting
          // again (r2-r-hostile-upstream-3).
          await this.trackMutation(
            this.lease.api.replyPermission(this.entry.directory, request.id, decision, answer?.feedback, {
              timeoutMs: this.config.requestTimeoutMs,
            }),
            'reply',
          );
        }
        this.answered.add(request.id);
        this.pending.delete(request.id);
        this.deadlines.delete(request.id);
        this.answers.delete(request.id);
        this.pendingSince.delete(request.id);
      }
    } catch {
      /* Cleanup retries outstanding requests. */
    } finally {
      this.approvalController = undefined;
      this.approvalCurrentId = undefined;
      this.approvalBusy = false;
    }
  }

  /** `guardStop` is only for the admission-time caller (before a runner exists, stop() finishes
   * immediately and does not otherwise interrupt this loop): it stops issuing new replies once a
   * concurrent stop sets stopReason/doneValue. The stop-path caller never guards — it deliberately
   * runs this after stopReason is already set, to clear leftovers as part of confirming the stop. */
  private async rejectLeftovers(deadline?: number, guardStop = false): Promise<void> {
    const api = this.lease.api,
      directory = this.entry.directory,
      id = this.entry.id;
    const req = () => (deadline === undefined ? undefined : { timeoutMs: Math.min(this.config.requestTimeoutMs || 5_000, 5_000, this.remaining(deadline)) });
    const stopped = () => guardStop && (this.stopReason !== undefined || this.doneValue !== undefined);
    const retryApi = api as OpencodeApiRetryable;
    const permissions = async () => guardStop && deadline !== undefined
      ? retryApi.listPermissionsWithRetry
        ? retryApi.listPermissionsWithRetry(directory, { deadlineAt: deadline, maxAttempts: this.config.readRetryAttempts })
        : this.admissionRetry(deadline, (timeoutMs) => api.listPermissions(directory, { timeoutMs }))
      : deadline !== undefined
        ? this.cleanupRead(deadline, (timeoutMs) => api.listPermissions(directory, { timeoutMs }))
        : api.listPermissions(directory);
    const questions = async () => guardStop && deadline !== undefined
      ? retryApi.listQuestionsWithRetry
        ? retryApi.listQuestionsWithRetry(directory, { deadlineAt: deadline, maxAttempts: this.config.readRetryAttempts })
        : this.admissionRetry(deadline, (timeoutMs) => api.listQuestions(directory, { timeoutMs }))
      : deadline !== undefined
        ? this.cleanupRead(deadline, (timeoutMs) => api.listQuestions(directory, { timeoutMs }))
        : api.listQuestions(directory);
    if (!stopped())
      for (const request of await permissions()) {
        if (stopped()) break;
        if (request.sessionID === id)
          await this.trackMutation(api.replyPermission(directory, request.id, 'reject', undefined, req()), 'reply');
      }
    if (!stopped())
      for (const question of await questions()) {
        if (stopped()) break;
        if (question.sessionID === id)
          await this.trackMutation(api.rejectQuestion(directory, question.id, req()), 'question');
      }
    this.pending.clear();
    this.deadlines.clear();
    this.pendingSince.clear();
  }

  /**
   * U4b in-turn fallback (context-concurrency design §5.4): the engine's synchronous pre-check
   * skips when no cached/profile limit is known yet; by the time this turn's own warm-up has
   * populated the engine's limits cache, this runs once more, right before the prompt POST, over
   * exactly the text `body` would send (prompt plus system/instructions). On exceed, finishes the
   * turn `failed`/`PROMPT_TOO_LARGE` directly (never through `admissionFailure`) and returns true
   * so the caller skips dispatch.
   */
  private checkPromptGuard(body: PromptBody): boolean {
    if ((this.config.contextGuard ?? 'reject') === 'off') return false;
    const modelName = this.entry.model;
    if (!modelName) return false;
    const usable = this.limitsForModel?.(modelName)?.usableInputTokens;
    if (usable === undefined) return false;
    const text = body.parts.map((part) => part.text).join('') + (body.system ?? '');
    const estimated = estimatePromptTokens(text);
    if (estimated <= usable) return false;
    this.error = { name: 'PROMPT_TOO_LARGE', message: promptTooLargeMessage(modelName, estimated, usable), retryable: false };
    this.executionState = 'stopped';
    this.finish('failed');
    return true;
  }

  stop(reason: StopReason): Promise<TurnResult> {
    if (this.doneValue) return this.done;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: StopReason): Promise<TurnResult> {
    this.logger.info('Turn stop requested', { sessionId: this.entry.id, turnId: this.id, reason });
    const deadline = this.clock.monotonicNow() + this.config.cleanupTimeoutMs;
    if (!this.stopReason) this.stopReason = reason;
    this.noUserCancel?.();
    this.noUserCancel = undefined;
    this.approvalController?.abort();
    this.approvalWake?.();
    this.phase = 'stopping';
    if (this.entry.phase !== 'ending') this.entry.phase = 'stopping';
    // A turn stopped before dispatch cannot create a runner; admission guards every await.
    if (!this.submissionDispatched) {
      if (this.warming) {
        try {
          await this.warming;
        } catch {
          // The warm-up request owns its timeout and is never cancelled by this stop.
        }
      }
      if (this.doneValue) return this.done;
      this.executionState = 'stopped';
      this.finish(reason === 'response_loop' ? 'failed' : reason);
      return this.done;
    }
    try {
      // Even a 204 may precede runner creation, so abort only after the POST settles.
      await this.withinDeadline(this.submissionSettled, deadline);
      if (this.submissionRejected) {
        this.executionState = 'stopped';
      } else {
        let needsAbort = true;
        // U06 (critic-c-parallel-subagent-load-5): re-POST abort at most once per ABORT_RETRY_MS
        // while the root stays busy, instead of on every ~100 ms busy iteration.
        let lastAbortAt: number | undefined;
        let previousUser = this.submittedUser;
        let firstIdleAt: number | undefined;
        let abortAcknowledgedAfterExecution = false;
        let abortAcknowledged = false;
        let cleanupFailures = 0;
        let confirmed = false;
        while (this.clock.monotonicNow() < deadline && !this.doneValue) {
          // A server loss mid-stop is owned by serverStopped(), not by this loop's evidence
          // search: keep polling a dead lease would never confirm anything.
          if (this.serverStopPromise || this.connection.current()?.generation !== this.lease.generation)
            break;
          if (
            needsAbort &&
            (lastAbortAt === undefined || this.clock.monotonicNow() - lastAbortAt >= ABORT_RETRY_MS)
          ) {
            try {
              const acknowledged = await this.withinDeadline(
                this.trackMutation(
                  this.lease.api.abort(this.entry.id, { timeoutMs: Math.min(this.config.requestTimeoutMs || 5_000, 5_000, this.remaining(deadline)) }),
                  'abort',
                ), deadline,
              );
              abortAcknowledged = acknowledged === true;
              abortAcknowledgedAfterExecution = abortAcknowledged && this.executionObserved;
              lastAbortAt = this.clock.monotonicNow();
              needsAbort = false;
              firstIdleAt = undefined;
            } catch {
              // A lost abort response may still land later. Never issue a second blind abort.
              throw new EngineError('CLEANUP_UNCONFIRMED', 'Abort acknowledgement was lost', this.entry.id);
            }
          }
          let idle: boolean;
          try {
            await this.withinDeadline(this.readInterval(deadline, true), deadline);
            const statuses = await this.withinDeadline(
              this.lease.api.sessionStatus(this.entry.directory, { timeoutMs: Math.min(this.config.requestTimeoutMs || 5_000, 5_000, this.remaining(deadline)) }),
              deadline,
            );
            idle = !statuses[this.entry.id] || statuses[this.entry.id]?.type === 'idle';
            if (idle) await this.withinDeadline(this.readInterval(deadline, true), deadline);
            cleanupFailures = 0;
          } catch (error) {
            firstIdleAt = undefined;
            if (!isRetryableReadError(error)) throw error;
            await this.cleanupPause(deadline, ++cleanupFailures, error);
            continue;
          }
          const evidence = submissionEvidence(this.interval);
          const newUser = evidence.userId !== undefined && evidence.userId !== previousUser;
          previousUser = evidence.userId;
          if (idle && evidence.userId && evidence.assistant === 'terminal') {
            confirmed = true;
            break;
          }
          if (!idle || newUser) {
            if (evidence.userId) this.executionObserved = true;
            // Re-abort only after a positively acknowledged abort and fresh busy evidence.
            needsAbort = abortAcknowledged && !!evidence.userId;
            firstIdleAt = undefined;
          } else if (evidence.userId && evidence.assistant === 'absent') {
            if (this.executionObserved && abortAcknowledgedAfterExecution &&
                this.confirmedSubmittedUser === evidence.userId) {
              firstIdleAt ??= this.clock.monotonicNow();
            } else firstIdleAt = undefined;
            if (firstIdleAt !== undefined && this.clock.monotonicNow() - firstIdleAt >= 5_000) {
              confirmed = true;
              break;
            }
          } else {
            firstIdleAt = undefined;
          }
          await this.withinDeadline(
            new Promise<void>((resolve) => {
              this.clock.schedule(Math.min(100, this.config.statusPollMs, this.remaining(deadline)), resolve);
            }),
            deadline,
          );
        }
        if (!confirmed) {
          if (this.serverStopPromise) {
            await this.serverStopPromise;
            return this.done;
          }
          throw new EngineError('CLEANUP_UNCONFIRMED', 'Stop evidence was not found', this.entry.id);
        }
        this.historyComplete = true;
        this.executionState = 'stopped';
        this.stopCleanupPending = true;
        await this.withinDeadline(this.rejectLeftovers(deadline), deadline);
        this.remaining(deadline);
        this.stopCleanupPending = false;
      }
    } catch {
      // A server loss mid-stop is owned by serverStopped(): defer to its verdict (stopped, not
      // unknown) instead of committing an unconfirmed quarantine ourselves.
      if (this.serverStopPromise) {
        await this.serverStopPromise;
        return this.done;
      }
      if (this.executionState !== 'stopped') this.executionState = 'unknown';
      this.cleanup = 'unconfirmed';
    }
    this.logger.info('Turn stop result', {
      sessionId: this.entry.id,
      turnId: this.id,
      reason,
      executionState: this.executionState,
      cleanup: this.cleanup,
    });
    this.finish(reason === 'response_loop' ? 'failed' : reason);
    return this.done;
  }

  private async cleanupPause(deadline: number, failures: number, error?: unknown): Promise<void> {
    const cap = Math.min(2_000, 250 * 2 ** Math.min(failures - 1, 4));
    const retryAfter = error instanceof OpencodeHttpError && error.retryAfterSeconds !== undefined
      ? Math.min(MAX_AUTOMATIC_WAIT_MS, error.retryAfterSeconds * 1000) : 0;
    const delay = Math.max(100, Math.random() * cap, retryAfter);
    if (delay >= this.remaining(deadline))
      throw new EngineError('CLEANUP_UNCONFIRMED', 'Cleanup retry exceeds deadline', this.entry.id);
    await this.withinDeadline(new Promise<void>((resolve) => {
      this.clock.schedule(delay, resolve);
    }), deadline);
  }

  /** Guarded summary builder shared by finish() and snapshot(): summarizeInterval must stay total,
   * but this is defense in depth against any other unforeseen adversarial/buggy upstream payload —
   * a summary failure must never leave the turn without a result. */
  private buildSummary(outcome: {
    status: TurnResult['status'];
    error?: { name: string; message: string };
  }): ReturnType<typeof summarizeInterval> {
    try {
      return summarizeInterval(this.interval, this.entry.directory, this.config.maxOutputChars, outcome);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      this.logger.warn('Turn result summary failed; using a degraded result', {
        sessionId: this.entry.id,
        turnId: this.id,
        error: name,
      });
      return {
        content: `Result summary unavailable (${name})`,
        truncated: false,
        filesChanged: [],
        toolCalls: [],
        toolCallCount: 0,
        tokens: undefined,
        cost: undefined,
        contextUsage: undefined,
      };
    }
  }

  private finish(status: TurnResult['status']): void {
    if (this.doneValue) return;
    if (this.stopReason === 'response_loop') {
      status = 'failed';
      this.error = { name: 'UPSTREAM_RESPONSE_LOOP',
        message: 'OpenCode repeatedly produced unusable model responses.', retryable: false };
    }
    if (this.error) this.error = { ...this.error, name: safeSlice(this.error.name, 200),
      message: safeSlice(this.error.message, 500) };
    // reserveReply excludes earlier abort markers, so any abort marker here belongs to this turn.
    if ([...(this.entry.unresolvedMutations?.values() ?? [])].some((marker) =>
      marker.kind === 'abort' && (marker.settledAt === undefined ||
        this.clock.monotonicNow() - marker.settledAt < Math.max(2 * (this.config.requestTimeoutMs || 5_000), 60_000)))) {
      this.executionState = 'unknown';
      this.cleanup = 'unconfirmed';
    }
    this.approvalController?.abort();
    this.approvalDeadlineCancel?.();
    this.approvalFinish?.();
    this.approvalWake?.();
    this.logger.info('Turn terminal', {
      sessionId: this.entry.id,
      turnId: this.id,
      status,
      executionState: this.executionState,
      cleanup: this.cleanup,
    });
    // (#2 accepted trade-off, narrowed) this.stopReason is only ever set by this turn's own
    // performStop() (owner-cancel, timeout, end, shutdown) — so a 'cancelled'/TURN_INCOMPLETE
    // outcome reached without it (via reconcile()'s classifyOutcome, or handleSessionError())
    // means some abort this call never issued for THIS turn ended it: possibly a delayed abort
    // whose HTTP round trip outlived an earlier call's own timeout and only now landed (it can
    // land against whichever turn happens to be running then, not necessarily the one that timed
    // out), or another client entirely. Tool effects before that abort are never undone, and this
    // must never be reported as 'completed' — only cancelled/TURN_INCOMPLETE is possible here.
    // TURN_INCOMPLETE also follows a rejected permission (finish 'tool-calls'); only the
    // abort-during-retry shape (completed, no finish, no error) is evidence of an abort.
    const lastAssistant = [...this.interval]
      .reverse()
      .find((message) => message.info.role === 'assistant' && !message.info.summary);
    const abortShape =
      lastAssistant !== undefined &&
      lastAssistant.info.time?.completed !== undefined &&
      lastAssistant.info.finish === undefined &&
      !lastAssistant.info.error;
    const unsolicitedAbort =
      this.submissionDispatched &&
      this.stopReason === undefined &&
      (status === 'cancelled' ||
        (status === 'failed' && this.error?.name === 'TURN_INCOMPLETE' && abortShape));
    const finishFacts = lastAssistant ? interpretFinish(lastAssistant, this.interval, this.clock.wallNow(), this.activityObserved) : undefined;
    const classified = classifyOutcome(this.interval, this.executionState === 'stopped', this.clock.wallNow(), this.activityObserved);
    const activity = this.activityObserved;
    const resendSafety: TurnResult['resendSafety'] =
      !this.submissionDispatched || this.submissionRejected ? 'not_submitted' :
      this.executionState !== 'stopped' || this.cleanup !== 'complete' ||
      this.entry.unresolvedMutations?.size || this.pending.size || !this.submittedUser || !this.historyComplete
        ? 'unknown' : activity ? 'inspect_effects' : 'no_observed_effects';
    let result: TurnResult;
    try {
      const summary = this.buildSummary({ status, error: this.error });
      summary.toolCallCount = Math.max(summary.toolCallCount, this.maxToolCallCount);
      const { contextUsage, ...summaryRest } = summary;
      const resolvedLimit = contextUsage ? this.limitsForModel?.(contextUsage.model) : undefined;
      const overflowModel = contextUsage?.model ?? this.entry.model ?? 'the model';
      const baseWarnings = this.stopReason !== 'response_loop' ? classified.warnings : undefined;
      const baseHint =
        this.stopReason === 'response_loop'
          ? this.executionState === 'stopped' && this.cleanup === 'complete'
            ? 'OpenCode was stopped after repeated unusable model responses. Check the model/gateway and inspect partial effects before trying again.'
            : 'Stop could not be confirmed; OpenCode may still be issuing requests. Do not resend. Use opencode-status or opencode-cancel to inspect the session.'
          : this.error?.name === 'SUBMISSION_UNCONFIRMED'
          ? 'Submission is unconfirmed. Do not resend. Use opencode-status to observe the existing session.'
          : this.error?.name === 'ContextOverflowError'
          ? contextOverflowHint(overflowModel)
          : this.error?.name === 'UnknownError' && this.error.message === MALFORMED_STREAM_MESSAGE
          ? 'OpenCode could not parse a response. Check the model/gateway response format; inspect partial effects before retrying.'
          : this.executionState === 'unknown'
          ? 'Use opencode-cancel to confirm stop before continuing.'
          : this.error?.name === 'EMPTY_RESPONSE'
            ? 'OpenCode finished without answer text. No tool or patch activity was observed. Inspect the result, then retry once after a short wait if appropriate.'
          : classified.warnings?.some((warning) => warning.code === 'EMPTY_RESPONSE')
            ? 'Tool activity occurred, but the final answer is empty. Inspect opencode-output and the turn diff before continuing.'
          : classified.warnings?.some((warning) => warning.code === 'TRUNCATED')
            ? 'The provider truncated the answer. Use opencode-reply to continue from the stopping point.'
          : unsolicitedAbort
            ? 'OpenCode aborted this turn without a request from this call (possibly a delayed ' +
              'abort from an earlier timed-out cancel, or another client). Inspect partial ' +
              'effects with opencode-output or the turn diff before retrying.'
            : status === 'running' || status === 'waiting_for_approval'
              ? 'Use opencode-status to observe this turn.'
              : 'Use opencode-reply to continue or opencode-end to finish.';
      const { context, warnings: finalWarnings, hint } = buildContextResult(
        contextUsage, this.outputArtifacts.compacted, resolvedLimit, baseWarnings, baseHint,
      );
      result = {
        kind: 'turn',
        threadId: this.entry.id,
        sessionId: this.entry.id,
        turnId: this.id,
        turn: this.number,
        status,
        executionState: this.executionState,
        cleanup: this.cleanup,
        ...summaryRest,
        output: { state: 'pending', toolCallCount: Math.max(summaryRest.toolCallCount, this.maxToolCallCount),
          partial: status !== 'completed' || this.executionState !== 'stopped' || !!finishFacts?.partial },
        directory: this.entry.directory,
        ...(this.entry.agent ? { agent: this.entry.agent } : {}),
        ...(this.entry.model ? { model: this.entry.model } : {}),
        ...(this.queuedMs() !== undefined ? { queuedMs: this.queuedMs() } : {}),
        ...(context ? { context } : {}),
        pendingApprovals: [...this.pending.values()].map((p) => ({
          id: p.id,
          sessionId: p.sessionID,
          permission: p.permission,
          patterns: p.patterns,
        })),
        ...(this.error ? { error: this.error } : {}),
        ...(finishFacts?.finish ? { finish: finishFacts.finish } : {}),
        ...(finalWarnings && finalWarnings.length ? { warnings: finalWarnings } : {}),
        resendSafety,
        ...(this.upstreamRetry ? { upstreamRetry: this.upstreamRetry } : {}),
        ...(this.upstreamRead ? { upstreamRead: this.upstreamRead } : {}),
        ...(this.responseLoop ? { responseLoop: this.responseLoop } : {}),
        elapsedMs: Math.max(0, this.clock.monotonicNow() - this.startAt),
        hint,
      };
      const artifacts = this.outputArtifacts;
      if (this.outputSchema && artifacts.hasTerminalAssistant) {
        const evaluation = evaluateStructuredOutput(artifacts.answer, this.outputSchema);
        result.structuredOutputStatus = evaluation.status;
        if (evaluation.status === 'valid') result.structuredOutput = evaluation.value;
        else result.structuredOutputError = evaluation.error;
      }
    } finally {
      // Teardown happens after the result is built (not before): a summary failure must not leave
      // the turn without a poll/timeout/listener AND without a result (the zombie-turn defect this
      // reordering fixes).
      this.pollCancel?.();
      this.timeoutCancel?.();
      this.noUserCancel?.();
      this.idleConfirmCancel?.();
      this.reconcileDebounceCancel?.();
      this.hubClose?.();
      this.unavailableOff?.();
    }
    this.doneValue = result;
    this.phase = 'terminal';
    if (this.ticket) {
      if (this.executionState === 'unknown') {
        this.ticket.hold();
        this.onHeld?.(this.ticket);
      } else this.ticket.release();
    }
    this.readyResolve();
    try {
      const committed = this.onCommit(result);
      if (committed) {
        void committed
          .catch(() => {
            this.logger.warn('Turn terminal callback failed', { sessionId: this.entry.id, turnId: this.id });
          })
          .finally(() => this.doneResolve(result));
      } else this.doneResolve(result);
    } catch {
      this.logger.warn('Turn terminal callback failed', { sessionId: this.entry.id, turnId: this.id });
      this.doneResolve(result);
    }
  }

  snapshot(): TurnResult {
    if (this.doneValue) return this.doneValue;
    const queue = this.ticket?.queueInfo();
    const summary = this.buildSummary({ status: 'running' });
    summary.toolCallCount = Math.max(summary.toolCallCount, this.maxToolCallCount);
    const { contextUsage, ...summaryRest } = summary;
    const lastAssistant = this.interval.filter((m) => m.info.role === 'assistant' && m.info.summary !== true).at(-1);
    const facts = lastAssistant ? interpretFinish(lastAssistant, this.interval, this.clock.wallNow(), this.activityObserved) : undefined;
    const resolvedLimit = contextUsage ? this.limitsForModel?.(contextUsage.model) : undefined;
    const baseHint = queue
      ? 'This turn is queued for a run slot and will start automatically; keep observing it with opencode-status and do not resend it.'
      : this.stopReason === 'response_loop'
        ? 'Stop could not be confirmed; OpenCode may still be issuing requests. Do not resend. Use opencode-status or opencode-cancel to inspect the session.'
        : 'Use opencode-status to observe this turn.';
    const { context, warnings: finalWarnings, hint } = buildContextResult(
      contextUsage, this.outputArtifacts.compacted, resolvedLimit, facts?.warnings, baseHint,
    );
    return {
      kind: 'turn',
      threadId: this.entry.id,
      sessionId: this.entry.id,
      turnId: this.id,
      turn: this.number,
      status: this.pending.size ? 'waiting_for_approval' : 'running',
      executionState: this.executionState,
      cleanup: this.cleanup,
      ...summaryRest,
      ...(queue ? { content: '' } : {}),
      output: { state: 'pending', toolCallCount: Math.max(summaryRest.toolCallCount, this.maxToolCallCount), partial: true },
      directory: this.entry.directory,
      ...(this.entry.agent ? { agent: this.entry.agent } : {}),
      ...(this.entry.model ? { model: this.entry.model } : {}),
      ...(queue ? { queue } : this.queuedMs() !== undefined ? { queuedMs: this.queuedMs() } : {}),
      ...(context ? { context } : {}),
      pendingApprovals: [...this.pending.values()].map((p) => ({
        id: p.id,
        sessionId: p.sessionID,
        permission: p.permission,
        patterns: p.patterns,
      })),
      elapsedMs: Math.max(0, this.clock.monotonicNow() - this.startAt),
      ...(facts?.finish ? { finish: facts.finish } : {}),
      ...(finalWarnings && finalWarnings.length ? { warnings: finalWarnings } : {}),
      resendSafety: !this.submissionDispatched || this.submissionRejected ? 'not_submitted' : 'unknown',
      ...(this.upstreamRetry ? { upstreamRetry: this.upstreamRetry } : {}),
      ...(this.upstreamRead ? { upstreamRead: this.upstreamRead } : {}),
      ...(this.responseLoop ? { responseLoop: this.responseLoop } : {}),
      hint,
    };
  }

  /** Attach a read-only observer without its own wait timer or progress stream. */
  observe(ctx: CallContext): () => void {
    if (this.doneValue || ctx.signal.aborted) return () => {};
    const item: Attached = { ctx };
    this.attached.add(item);
    this.approvalWake?.();
    void this.processApprovals();
    return () => {
      this.attached.delete(item);
      this.approvalWake?.();
    };
  }

  async attach(ctx: CallContext, waitSeconds: number | undefined, owner: boolean): Promise<TurnResult> {
    const item: Attached = { ctx };
    this.attached.add(item);
    this.approvalWake?.();
    const beat = () => {
      try {
        ctx.progress?.(this.queueProgress() ?? this.progressText);
      } catch {
        this.attached.delete(item);
        return;
      }
      item.heartbeat = this.clock.schedule(this.config.heartbeatMs, beat);
    };
    item.heartbeat = this.clock.schedule(this.config.heartbeatMs, beat);
    void this.processApprovals();
    const onAbort = () => {
      if (owner) void this.stop('cancelled');
    };
    ctx.signal.addEventListener('abort', onAbort);
    if (ctx.signal.aborted) onAbort();
    // A positive wait uses one deadline across queue, admission and observation. Keep the
    // legacy immediate-grant waitSeconds:0 owner behavior (wait through admission); queued
    // owners return their visible queued snapshot immediately.
    const observerDeadline =
      waitSeconds !== undefined ? this.clock.monotonicNow() + waitSeconds * 1000 : undefined;
    const observerRemainingMs = (): number => Math.max(0, (observerDeadline ?? Infinity) - this.clock.monotonicNow());
    try {
      if (waitSeconds === 0 && (!owner || this.ticket?.everQueued) && !ctx.signal.aborted) {
        if (this.admissionFailure) throw this.admissionFailure;
        return this.doneValue ?? this.snapshot();
      }
      if (owner && (waitSeconds === undefined || waitSeconds === 0)) {
        await this.ready;
      } else {
        // Race admission against the same wait timer. Expiry returns a snapshot and leaves the
        // Turn running; a later admission failure remains available to status and replay.
        if (ctx.signal.aborted) return this.doneValue ?? this.snapshot();
        let cancelAdmitWait = () => {};
        let onAdmitDetach = () => {};
        try {
          const admitted = new Promise<'timer' | 'detach'>((resolve) => {
            if (observerDeadline !== undefined)
              cancelAdmitWait = this.clock.schedule(observerRemainingMs(), () => resolve('timer'));
            onAdmitDetach = () => resolve('detach');
            ctx.signal.addEventListener('abort', onAdmitDetach, { once: true });
          });
          const winner = await Promise.race([this.ready.then(() => 'ready' as const), admitted]);
          if (winner !== 'ready') return this.doneValue ?? this.snapshot();
        } finally {
          cancelAdmitWait();
          ctx.signal.removeEventListener('abort', onAdmitDetach);
        }
      }
      if (this.admissionFailure) throw this.admissionFailure;
      if (this.doneValue) return this.done;
      if ((waitSeconds === 0 && !ctx.signal.aborted) || (!owner && ctx.signal.aborted) ||
          (observerDeadline !== undefined && observerRemainingMs() <= 0))
        return this.snapshot();
      let cancelWait = () => {};
      let onDetach = () => {};
      const observation = new Promise<TurnResult>((resolve) => {
        if (observerDeadline !== undefined) {
          cancelWait = this.clock.schedule(observerRemainingMs(), () => resolve(this.snapshot()));
        }
        if (!owner) {
          onDetach = () => resolve(this.snapshot());
          ctx.signal.addEventListener('abort', onDetach, { once: true });
        }
      });
      try {
        return await Promise.race([this.done, observation]);
      } finally {
        cancelWait();
        ctx.signal.removeEventListener('abort', onDetach);
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      item.heartbeat?.();
      this.attached.delete(item);
    }
  }
}
