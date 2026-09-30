import type { ApprovalDecision, ApprovalRequest, BatchItem, CallContext, Clock, TurnResult } from '../types.ts';
import type { Admission, TrackedSession } from './registry.ts';
import type { Turn } from './turn.ts';

export type CapturedTarget =
  | { kind: 'missing' | 'idle'; sessionId: string }
  | { kind: 'last'; sessionId: string; result: TurnResult }
  | { kind: 'turn'; sessionId: string; turn: Turn }
  | { kind: 'admission'; sessionId: string; admission: Admission };

/** Capture by identity before the first await of a batch call. */
export function captureTarget(sessionId: string, entry?: TrackedSession, last?: TurnResult): CapturedTarget {
  if (!entry) return { kind: 'missing', sessionId };
  if (entry.current) return { kind: 'turn', sessionId, turn: entry.current };
  if (entry.admission) return { kind: 'admission', sessionId, admission: entry.admission };
  const result = last ?? entry.last;
  return result ? { kind: 'last', sessionId, result } : { kind: 'idle', sessionId };
}

function itemFor(result: TurnResult): BatchItem {
  return {
    sessionId: result.sessionId,
    turnId: result.turnId,
    turn: result.turn,
    status: result.status,
    executionState: result.executionState,
    cleanup: result.cleanup,
    content: result.content,
    ...(result.error ? { error: result.error } : {}),
    toolCallCount: result.toolCallCount,
    filesChangedCount: result.filesChanged.length,
    pendingApprovalCount: result.pendingApprovals.length,
    ...(result.output ? { output: result.output } : {}),
    ...(result.structuredOutputStatus ? { structuredOutputStatus: result.structuredOutputStatus } : {}),
    ...(result.finish ? { finish: result.finish } : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.resendSafety ? { resendSafety: result.resendSafety } : {}),
    ...(result.upstreamRetry ? { upstreamRetry: result.upstreamRetry } : {}),
    ...(result.upstreamRead ? { upstreamRead: result.upstreamRead } : {}),
    ...(result.responseLoop ? { responseLoop: result.responseLoop } : {}),
  };
}

function errorItem(sessionId: string, name: string, message: string): BatchItem {
  return { sessionId, status: 'error', content: '', error: { name, message } };
}

/** Immediate read before deciding whether a batch needs observer attachments. */
export function snapshotTarget(target: CapturedTarget): BatchItem {
  if (target.kind === 'missing') return errorItem(target.sessionId, 'SESSION_NOT_FOUND', `Session not found: ${target.sessionId}`);
  if (target.kind === 'idle') return { sessionId: target.sessionId, status: 'idle', content: '' };
  if (target.kind === 'last') return itemFor(target.result);
  if (target.kind === 'turn') return itemFor(target.turn.snapshot());
  return { sessionId: target.sessionId, status: 'running', content: '' };
}

export interface ObservationHandle {
  snapshot(): BatchItem;
  settled: Promise<BatchItem>;
  dispose(): void;
}

/** Attaches to one captured turn. Disposal never calls Turn.stop or any upstream method. */
export function observeTarget(target: CapturedTarget, ctx: CallContext, attachObserver = true): ObservationHandle {
  let turn = target.kind === 'turn' ? target.turn : undefined;
  let admissionFailed = false;
  let disposed = false;
  let detach = () => {};
  const attach = (value: Turn): void => {
    turn = value;
    if (!disposed && attachObserver) detach = value.observe(ctx);
  };
  const snapshot = (): BatchItem => {
    if (target.kind === 'missing') return errorItem(target.sessionId, 'SESSION_NOT_FOUND', `Session not found: ${target.sessionId}`);
    if (target.kind === 'idle') return { sessionId: target.sessionId, status: 'idle', content: '' };
    if (target.kind === 'last') return itemFor(target.result);
    if (turn) return itemFor(turn.snapshot());
    if (admissionFailed) return errorItem(target.sessionId, 'UPSTREAM_ERROR', `Turn admission failed for ${target.sessionId}`);
    return { sessionId: target.sessionId, status: 'running', content: '' };
  };
  let settled: Promise<BatchItem>;
  if (target.kind === 'turn') {
    attach(target.turn);
    settled = target.turn.done.then(itemFor);
  } else if (target.kind === 'admission') {
    settled = target.admission.created.then(async (created) => {
      if (!created) {
        admissionFailed = true;
        return snapshot();
      }
      if (disposed) return snapshot();
      attach(created);
      return itemFor(await created.done);
    });
  } else settled = Promise.resolve(snapshot());
  return {
    snapshot,
    settled,
    dispose() { disposed = true; detach(); detach = () => {}; },
  };
}

type Elicitation = {
  request: ApprovalRequest;
  requestStart: number;
  signal: AbortSignal;
  resolve: (value: ApprovalDecision | null) => void;
  abort: () => void;
  active?: AbortController;
  done: boolean;
};

/** One dialog at a time across every turn observed by this batch call. */
export function createBatchElicitor(ctx: CallContext, clock: Clock): {
  elicit: NonNullable<CallContext['elicit']>;
  dispose(): void;
} {
  const queue: Elicitation[] = [];
  let busy = false;
  let disposed = false;
  let active: Elicitation | undefined;
  let disposeWake: (() => void) | undefined;
  const finish = (task: Elicitation, value: ApprovalDecision | null): void => {
    if (task.done) return;
    task.done = true;
    task.signal.removeEventListener('abort', task.abort);
    task.resolve(value);
  };
  const drain = async (): Promise<void> => {
    if (busy || disposed || !ctx.elicit) return;
    busy = true;
    try {
      while (queue.length && !disposed) {
        const task = queue.shift()!;
        if (task.done || task.signal.aborted) { finish(task, null); continue; }
        active = task;
        task.active = new AbortController();
        const elapsed = clock.monotonicNow() - task.requestStart;
        const remaining = task.request.timeoutMs === undefined ? undefined : task.request.timeoutMs - elapsed;
        if (remaining !== undefined && remaining <= 0) { finish(task, null); active = undefined; continue; }
        try {
          const answer = await Promise.race([
            ctx.elicit(
              { ...task.request, ...(remaining === undefined ? {} : { timeoutMs: Math.max(1, remaining) }) },
              task.active.signal,
            ),
            new Promise<null>((resolve) => { disposeWake = () => resolve(null); }),
          ]);
          finish(task, task.signal.aborted || disposed ? null : answer);
        } catch { finish(task, null); }
        disposeWake = undefined;
        active = undefined;
      }
    } finally { busy = false; }
  };
  return {
    elicit(request, signal) {
      if (disposed || signal.aborted || !ctx.elicit) return Promise.resolve(null);
      return new Promise<ApprovalDecision | null>((resolve) => {
        const task: Elicitation = {
          request, signal, resolve, done: false, requestStart: clock.monotonicNow(),
          abort: () => {},
        };
        task.abort = () => {
          task.active?.abort();
          finish(task, null);
        };
        signal.addEventListener('abort', task.abort, { once: true });
        queue.push(task);
        void drain();
      });
    },
    dispose() {
      disposed = true;
      disposeWake?.();
      active?.active?.abort();
      if (active) finish(active, null);
      for (const task of queue) finish(task, null);
      queue.length = 0;
    },
  };
}
