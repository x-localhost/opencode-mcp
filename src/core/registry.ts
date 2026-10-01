import { EngineError } from '../types.ts';
import type { ApprovalPolicy, Sandbox, TurnResult } from '../types.ts';
import type { Turn } from './turn.ts';

export interface Admission {
  stopRequested: boolean;
  settled: Promise<void>;
  /** Resolves to exactly the turn created by this reservation, or undefined on admission failure. */
  created: Promise<Turn | undefined>;
}

export interface QuarantineRecovery {
  turnId: string;
  boundary?: string;
  settled: Promise<TurnResult | undefined>;
}

/** Lifecycle states used by the per-session reservation gate. */
export type SessionPhase =
  | 'idle'
  | 'admitting'
  | 'running'
  | 'stopping'
  | 'ending'
  | 'quarantined';
export type MutationKind = 'abort' | 'reply' | 'question' | 'delete' | 'archive';
export interface MutationMarker {
  kind: MutationKind;
  generation: number;
  settled: boolean;
  settledAt?: number;
}
export interface TrackedTurnRecord {
  turnId: string;
  turn: number;
  submittedUserId?: string;
  boundary?: string;
  submissionDispatched: boolean;
  executionObserved?: boolean;
  highestObservedMessageId?: string;
  observedMessageIds?: string[];
  observedMessageCount?: number;
  activityObserved?: boolean;
  maxToolCallCount?: number;
  stopCleanupPending?: boolean;
  admissionError?: { code: string; message: string; retryAfterSeconds?: number };
  terminalBoundary?: string;
  directory: string;
  generation: number;
  executionState: TurnResult['executionState'];
  compacted: boolean;
}
/** Process-owned session state; foreign OpenCode sessions never enter this registry. */
export interface TrackedSession {
  id: string;
  directory: string;
  title: string;
  sandbox: Sandbox;
  approvalPolicy: ApprovalPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  agent?: string;
  model?: string;
  turns: number;
  turnRecords?: Map<number, TrackedTurnRecord>;
  phase: SessionPhase;
  current?: Turn;
  admission?: Admission;
  recovery?: QuarantineRecovery;
  /** In-flight and ambiguous upstream mutations, tagged with the issuing lease. */
  unresolvedMutations?: Map<symbol, MutationMarker>;
  last?: TurnResult;
  lastSubmittedUser?: string;
  /** Sticky evidence that this upstream session has at least one message. */
  upstreamHistoryKnown?: boolean;
  endFailure?: string;
  generation: number;
  updatedAt: number;
}
/** Reserve reply and end synchronously before either operation awaits. */
export class Registry {
  private sessions = new Map<string, TrackedSession>();
  /** FZ #1: brand-new sessions not yet added to `sessions` but already counted against the cap —
   * incremented synchronously by reserveCreation() before the caller's first await (acquire(),
   * createSession()), so a concurrent burst of starts can never all observe the same
   * under-the-cap count. Transferred (not double-counted) once add() runs for that reservation;
   * released via releaseCreation() on every failure/abort path before add(). */
  private pendingCreations = 0;

  /** Atomically checks tracked-plus-pending session count against `max` and, if there is room,
   * reserves one slot (synchronously, no await in between) before returning true. The caller must
   * releaseCreation() on every path that does not end in add() for this reservation (use
   * try/finally), and must never call this twice for the same in-flight creation. */
  reserveCreation(max: number): boolean {
    if (this.sessions.size + this.pendingCreations >= max) return false;
    this.pendingCreations += 1;
    return true;
  }

  /** Releases one previously reserveCreation()'d slot without adding a session (the creation
   * failed or was aborted before add()). A no-op below zero so a stray extra call never underflows
   * capacity accounting for other in-flight reservations. */
  releaseCreation(): void {
    if (this.pendingCreations > 0) this.pendingCreations -= 1;
  }

  add(entry: TrackedSession): void {
    this.sessions.set(entry.id, entry);
  }

  get(id: string): TrackedSession {
    const entry = this.sessions.get(id);
    if (!entry) throw new EngineError('SESSION_NOT_FOUND', `Session not found: ${id}`);
    return entry;
  }

  find(id: string): TrackedSession | undefined {
    return this.sessions.get(id);
  }

  all(): TrackedSession[] {
    return [...this.sessions.values()];
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  reserveReply(entry: TrackedSession): void {
    // A completed stop cannot override an end reservation or a quarantined turn.
    if ([...(entry.unresolvedMutations?.values() ?? [])].some((marker) =>
      !marker.settled || marker.kind === 'abort' || marker.kind === 'delete' || marker.kind === 'archive'))
      throw new EngineError(
        'SESSION_BUSY',
        `Session ${entry.id} has pending upstream recovery; retry later`,
        entry.id,
      );
    if (entry.phase !== 'idle' || entry.recovery || entry.last?.executionState === 'unknown')
      throw new EngineError('SESSION_BUSY', `Session ${entry.id} is not idle and clean`, entry.id);
    entry.phase = 'admitting';
  }

  releaseReply(entry: TrackedSession): void {
    if (entry.phase === 'admitting' && !entry.admission && !entry.current) entry.phase = 'idle';
  }

  reserveEnd(entry: TrackedSession): void {
    // Ending wins the gate immediately, including against a later reply.
    if (entry.phase === 'ending')
      throw new EngineError('SESSION_BUSY', `Session ${entry.id} is ending`, entry.id);
    entry.phase = 'ending';
  }
}
