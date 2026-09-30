// Pure, injected-clock request-id deduplication registry (v0.3 F3). No timers: expiry is lazy
// (swept on access from every public method), so this module never keeps the event loop alive.
// See v0.3 features contract §4. Engine wiring (reserve-before-mutation,
// admitted()/failed()/unconfirmed() calls, REQUEST_* error mapping) is a later unit.

import { createHash } from 'node:crypto';
import type { Clock } from '../types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const REQUEST_ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RequestRegistryLimits {
  maxRecords: number;
  ttlMs: number;
}

export const DEFAULT_REQUEST_REGISTRY_LIMITS: RequestRegistryLimits = {
  maxRecords: 4096,
  ttlMs: 24 * 60 * 60 * 1000,
};

export type RequestTool = 'opencode' | 'opencode-reply';

export type AdmissionOutcome =
  | { kind: 'turn'; sessionId: string; turnId: string; turn: number }
  | { kind: 'unconfirmed'; sessionId?: string; message: string }
  | { kind: 'failed'; error: { code: string; message: string } };

export type RequestRecordState = 'reserved' | 'active' | 'ambiguous' | 'terminal' | 'ended';

export interface RequestRecord {
  readonly id: string;
  readonly tool: RequestTool;
  readonly state: RequestRecordState;
  readonly outcome?: AdmissionOutcome;
  /** wall ms; only set once the record is pinned no longer (terminal/ended) */
  readonly expiresAt?: number;
}

export type Reservation =
  | { kind: 'new'; record: RequestRecord }
  | { kind: 'duplicate'; record: RequestRecord; settled: Promise<AdmissionOutcome> }
  | { kind: 'conflict' }
  | { kind: 'ended'; record: RequestRecord }
  | { kind: 'capacity' }
  | { kind: 'invalid'; message: string };

// ---------------------------------------------------------------------------
// requestFingerprint: SHA-256 hex of canonical JSON {tool, args}
// ---------------------------------------------------------------------------

/**
 * Canonical string form of `value`: object keys sorted recursively (lexicographic), arrays kept
 * in order, keys whose value is `undefined` dropped entirely, `null` kept as an explicit value.
 * Not general-purpose JSON canonicalisation (no BigInt/cyclic support): args come from validated,
 * already-JSON-shaped tool input.
 */
function canonicalValue(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalValue(v)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(obj[k])}`).join(',');
    return `{${body}}`;
  }
  return 'null'; // function/symbol/bigint: not expected in validated tool args
}

export function requestFingerprint(tool: RequestTool, args: Record<string, unknown>): string {
  const canonical = canonicalValue({ tool, args });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

interface Deferred {
  promise: Promise<AdmissionOutcome>;
  resolve: (outcome: AdmissionOutcome) => void;
}

function makeDeferred(): Deferred {
  let resolve!: (outcome: AdmissionOutcome) => void;
  const promise = new Promise<AdmissionOutcome>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface InternalRecord {
  id: string;
  tool: RequestTool;
  fingerprint: string;
  state: RequestRecordState;
  outcome?: AdmissionOutcome;
  /** wall ms; set on terminal/ended transitions only (reserved/active/ambiguous are pinned) */
  expiresAt?: number;
  /** monotonic ms; mirrors expiresAt for the lazy sweep (immune to wall-clock adjustment) */
  expiresAtMonotonic?: number;
  deferred: Deferred;
}

/** Deep-copy + freeze an outcome so a returned view can never mutate registry state. */
function freezeOutcome(outcome: AdmissionOutcome): AdmissionOutcome {
  if (outcome.kind === 'turn') {
    return Object.freeze({
      kind: 'turn',
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      turn: outcome.turn,
    });
  }
  if (outcome.kind === 'unconfirmed') {
    return Object.freeze({
      kind: 'unconfirmed',
      ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      message: outcome.message,
    });
  }
  return Object.freeze({
    kind: 'failed',
    error: Object.freeze({ code: outcome.error.code, message: outcome.error.message }),
  });
}

/** The sessionId an outcome is bound to, if any ('failed' outcomes are never bound). */
function outcomeSessionId(outcome: AdmissionOutcome | undefined): string | undefined {
  if (!outcome) return undefined;
  if (outcome.kind === 'turn') return outcome.sessionId;
  if (outcome.kind === 'unconfirmed') return outcome.sessionId;
  return undefined;
}

function toView(rec: InternalRecord): RequestRecord {
  return Object.freeze({
    id: rec.id,
    tool: rec.tool,
    state: rec.state,
    ...(rec.outcome !== undefined ? { outcome: freezeOutcome(rec.outcome) } : {}),
    ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
  });
}

// ---------------------------------------------------------------------------
// RequestRegistry
// ---------------------------------------------------------------------------

export class RequestRegistry {
  private readonly clock: Pick<Clock, 'monotonicNow' | 'wallNow'>;
  private readonly serverInstanceId: string;
  private readonly limits: RequestRegistryLimits;
  private readonly records = new Map<string, InternalRecord>();

  constructor(
    clock: Pick<Clock, 'monotonicNow' | 'wallNow'>,
    serverInstanceId: string,
    limits?: Partial<RequestRegistryLimits>,
  ) {
    this.clock = clock;
    this.serverInstanceId = serverInstanceId;
    this.limits = { ...DEFAULT_REQUEST_REGISTRY_LIMITS, ...limits };
  }

  /** Drop expired terminal/ended records. Lazy: called at the start of every public method. */
  private sweep(): void {
    const now = this.clock.monotonicNow();
    for (const [id, rec] of this.records) {
      if (
        (rec.state === 'terminal' || rec.state === 'ended') &&
        rec.expiresAtMonotonic !== undefined &&
        now >= rec.expiresAtMonotonic
      ) {
        this.records.delete(id);
      }
    }
  }

  private settledFor(rec: InternalRecord): Promise<AdmissionOutcome> {
    if (rec.state === 'reserved') return rec.deferred.promise;
    return Promise.resolve(freezeOutcome(rec.outcome as AdmissionOutcome));
  }

  reserve(id: string, tool: RequestTool, fingerprint: string): Reservation {
    if (!REQUEST_ID_PATTERN.test(id)) return { kind: 'invalid', message: `Invalid request id: ${id}` };
    this.sweep();

    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.state === 'ended') return { kind: 'ended', record: toView(existing) };
      return { kind: 'duplicate', record: toView(existing), settled: this.settledFor(existing) };
    }

    if (this.records.size >= this.limits.maxRecords) return { kind: 'capacity' };

    const rec: InternalRecord = { id, tool, fingerprint, state: 'reserved', deferred: makeDeferred() };
    this.records.set(id, rec);
    return { kind: 'new', record: toView(rec) };
  }

  admitted(record: RequestRecord, outcome: { sessionId: string; turnId: string; turn: number }): void {
    this.sweep();
    const rec = this.records.get(record.id);
    if (!rec || rec.state !== 'reserved') return;
    const turnOutcome: AdmissionOutcome = {
      kind: 'turn',
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      turn: outcome.turn,
    };
    rec.state = 'active';
    rec.outcome = freezeOutcome(turnOutcome);
    rec.deferred.resolve(freezeOutcome(rec.outcome));
  }

  failed(record: RequestRecord, error: { code: string; message: string }): void {
    this.sweep();
    const rec = this.records.get(record.id);
    if (!rec || rec.state !== 'reserved') return;
    const failedOutcome: AdmissionOutcome = {
      kind: 'failed',
      error: { code: error.code, message: error.message },
    };
    rec.deferred.resolve(failedOutcome);
    this.records.delete(record.id);
  }

  unconfirmed(record: RequestRecord, detail: { sessionId?: string; message: string }): void {
    this.sweep();
    const rec = this.records.get(record.id);
    if (!rec || rec.state !== 'reserved') return;
    const outcome: AdmissionOutcome = {
      kind: 'unconfirmed',
      ...(detail.sessionId !== undefined ? { sessionId: detail.sessionId } : {}),
      message: detail.message,
    };
    rec.state = 'ambiguous';
    rec.outcome = freezeOutcome(outcome);
    rec.deferred.resolve(freezeOutcome(rec.outcome));
  }

  settleTurn(sessionId: string, turnId: string): void {
    this.sweep();
    for (const rec of this.records.values()) {
      const outcome = rec.outcome;
      const isBoundTurn =
        rec.state === 'active' &&
        outcome?.kind === 'turn' &&
        outcome.sessionId === sessionId &&
        outcome.turnId === turnId;
      if (isBoundTurn) {
        rec.state = 'terminal';
        rec.expiresAtMonotonic = this.clock.monotonicNow() + this.limits.ttlMs;
        rec.expiresAt = this.clock.wallNow() + this.limits.ttlMs;
      }
    }
  }

  sessionEnded(sessionId: string): void {
    this.sweep();
    for (const rec of this.records.values()) {
      if (rec.state === 'ended') continue;
      if (outcomeSessionId(rec.outcome) === sessionId) {
        rec.state = 'ended';
        rec.expiresAtMonotonic = this.clock.monotonicNow() + this.limits.ttlMs;
        rec.expiresAt = this.clock.wallNow() + this.limits.ttlMs;
      }
    }
  }

  receipt(
    record: RequestRecord,
    replayed: boolean,
  ): { id: string; serverInstanceId: string; replayed: boolean; scope: 'process'; expiresAt?: number } {
    return {
      id: record.id,
      serverInstanceId: this.serverInstanceId,
      replayed,
      scope: 'process',
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    };
  }

  size(): number {
    this.sweep();
    return this.records.size;
  }
}
