// Pure, injected-clock retained-output store (v0.3 F2). No timers: expiry is lazy (swept on
// access from every public method), so this module never keeps the event loop alive.
// See v0.3 features contract §§1-2.

import type { Clock, TurnOutputMeta } from '../types.ts';
import { trimDanglingSurrogates } from './text.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OutputStoreLimits {
  ttlMs: number;
  maxTurns: number;
  maxBytes: number;
  maxTurnBytes: number;
  maxTitleChars: number;
  maxTombstones: number;
}

export const DEFAULT_OUTPUT_STORE_LIMITS: OutputStoreLimits = {
  ttlMs: 3_600_000,
  maxTurns: 128,
  maxBytes: 32 * 1024 * 1024,
  maxTurnBytes: 4 * 1024 * 1024,
  maxTitleChars: 2000,
  maxTombstones: 4096,
};

export interface RetainedToolCall {
  messageId: string;
  callId?: string;
  tool: string;
  status: string;
  title?: string;
  titleShortened?: boolean;
}

export interface TurnArtifactInput {
  sessionId: string;
  turnId: string;
  turn: number;
  partial: boolean;
  answer: string;
  toolCalls: RetainedToolCall[];
  /** canonical JSON serialization */
  structured?: string;
}

export type OutputMeta =
  | { state: 'retained'; partial: boolean; answerChars: number; toolCallCount: number; structuredChars?: number; expiresAt: number }
  | {
      state: 'unavailable';
      reason: 'too_large' | 'expired' | 'evicted';
      partial: boolean;
      answerChars?: number;
      toolCallCount: number;
    };

export interface DiffItem {
  file?: string;
  status?: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface DiffSnapshot {
  snapshotId: string;
  observedAt: number;
  sourceMessageId: string;
  items: Array<DiffItem & { fileIndex: number }>;
}

export type StoreError = {
  ok: false;
  code: 'TURN_NOT_FOUND' | 'OUTPUT_UNAVAILABLE' | 'SNAPSHOT_EXPIRED' | 'INVALID_ARGUMENT';
  message: string;
  reason?: 'too_large' | 'expired' | 'evicted';
};

export interface TextPage {
  ok: true;
  text: string;
  offset: number;
  nextOffset: number | null;
  total: number;
  hasMore: boolean;
  partial: boolean;
}

export interface ItemPage<T> {
  ok: true;
  items: T[];
  offset: number;
  nextOffset: number | null;
  total: number;
  hasMore: boolean;
  partial: boolean;
}

export type DiffStatItem = {
  fileIndex: number;
  file?: string;
  status?: string;
  additions: number;
  deletions: number;
  patchChars?: number;
};

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

/** Fixed per-record accounting overhead (bytes) added to every tool-call / diff-item's string bytes. */
const RECORD_OVERHEAD = 64;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/** True when `idx` sits strictly between the high and low code units of one surrogate pair. */
function isSurrogatePairBoundary(text: string, idx: number): boolean {
  if (idx <= 0 || idx >= text.length) return false;
  const hi = text.charCodeAt(idx - 1);
  const lo = text.charCodeAt(idx);
  return hi >= HIGH_SURROGATE_MIN && hi <= HIGH_SURROGATE_MAX && lo >= LOW_SURROGATE_MIN && lo <= LOW_SURROGATE_MAX;
}

function byteLen(s: string | undefined): number {
  return s ? Buffer.byteLength(s, 'utf8') : 0;
}

function toolCallBytes(tc: RetainedToolCall): number {
  return byteLen(tc.messageId) + byteLen(tc.callId) + byteLen(tc.tool) + byteLen(tc.status) + byteLen(tc.title) + RECORD_OVERHEAD;
}

function diffItemBytes(item: DiffItem): number {
  return byteLen(item.file) + byteLen(item.patch) + RECORD_OVERHEAD;
}

function invalidArgument(message: string): StoreError {
  return { ok: false, code: 'INVALID_ARGUMENT', message };
}

function isStoreError(x: unknown): x is StoreError {
  return typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
}

/** Cut `title` to at most `maxChars` UTF-16 code units without splitting a surrogate pair. */
function shortenTitle(title: string, maxChars: number): { title: string; shortened: boolean } {
  if (title.length <= maxChars) return { title, shortened: false };
  const { head } = trimDanglingSurrogates(title.slice(0, maxChars), '');
  return { title: head, shortened: true };
}

function cloneToolCall(tc: RetainedToolCall): RetainedToolCall {
  return { ...tc };
}

function cloneDiffStatItem(item: DiffStatItem): DiffStatItem {
  return { ...item };
}

/** Page a UTF-16 string on character boundaries; concatenating all pages reproduces the source. */
function pageText(text: string, offset: number, limit: number, partial: boolean): TextPage | StoreError {
  const total = text.length;
  if (offset > total) return invalidArgument(`offset ${offset} exceeds total length ${total}`);
  if (isSurrogatePairBoundary(text, offset)) return invalidArgument(`offset ${offset} falls inside a surrogate pair`);
  if (offset === total) return { ok: true, text: '', offset, nextOffset: null, total, hasMore: false, partial };
  let end = Math.min(total, offset + limit);
  if (end < total && isSurrogatePairBoundary(text, end)) {
    // A page always makes progress: if moving the boundary back would empty the page, include the
    // full pair instead (end < total here, so end + 1 <= total is guaranteed).
    end = end - 1 > offset ? end - 1 : end + 1;
  }
  const slice = text.slice(offset, end);
  return { ok: true, text: slice, offset, nextOffset: end < total ? end : null, total, hasMore: end < total, partial };
}

function pageItems<T>(
  items: T[],
  offset: number,
  limit: number,
  partial: boolean,
  clone: (item: T) => T,
): ItemPage<T> | StoreError {
  const total = items.length;
  if (offset > total) return invalidArgument(`offset ${offset} exceeds total length ${total}`);
  if (offset === total) return { ok: true, items: [], offset, nextOffset: null, total, hasMore: false, partial };
  const end = Math.min(total, offset + limit);
  const slice = items.slice(offset, end).map(clone);
  return { ok: true, items: slice, offset, nextOffset: end < total ? end : null, total, hasMore: end < total, partial };
}

interface StoredDiffSnapshot {
  snapshotId: string;
  observedAt: number;
  sourceMessageId: string;
  items: Array<DiffItem & { fileIndex: number }>;
  bytes: number;
}

interface ArtifactRecord {
  sessionId: string;
  turnId: string;
  turn: number;
  partial: boolean;
  answer: string;
  toolCalls: RetainedToolCall[];
  structured?: string;
  /** total accounted bytes: answer + structured + tool calls + current diff (if any) */
  bytes: number;
  putAtMonotonic: number;
  /** wall ms: wallNow() at put() + ttlMs */
  expiresAt: number;
  diff?: StoredDiffSnapshot;
  diffCounter: number;
}

interface Tombstone {
  sessionId: string;
  turn: number;
  reason: 'too_large' | 'expired' | 'evicted';
  partial: boolean;
  answerChars?: number;
  toolCallCount: number;
}

// ---------------------------------------------------------------------------
// OutputStore
// ---------------------------------------------------------------------------

export class OutputStore {
  private clock: Pick<Clock, 'monotonicNow' | 'wallNow'>;
  private limits: OutputStoreLimits;
  /** Insertion order == FIFO commit order (a key is only ever inserted once; eviction removes it). */
  private artifacts = new Map<string, ArtifactRecord>();
  private tombstones = new Map<string, Tombstone>();
  private totalBytes = 0;

  constructor(clock: Pick<Clock, 'monotonicNow' | 'wallNow'>, limits?: Partial<OutputStoreLimits>) {
    this.clock = clock;
    this.limits = { ...DEFAULT_OUTPUT_STORE_LIMITS, ...limits };
  }

  private key(sessionId: string, turn: number): string {
    return `${sessionId}\u0000${turn}`;
  }

  private metaForArtifact(rec: ArtifactRecord): OutputMeta {
    return {
      state: 'retained',
      partial: rec.partial,
      answerChars: rec.answer.length,
      toolCallCount: rec.toolCalls.length,
      ...(rec.structured !== undefined ? { structuredChars: rec.structured.length } : {}),
      expiresAt: rec.expiresAt,
    };
  }

  private metaForTombstone(tomb: Tombstone): OutputMeta {
    return {
      state: 'unavailable',
      reason: tomb.reason,
      partial: tomb.partial,
      ...(tomb.answerChars !== undefined ? { answerChars: tomb.answerChars } : {}),
      toolCallCount: tomb.toolCallCount,
    };
  }

  private notFoundError(sessionId: string, turn: number): StoreError {
    return { ok: false, code: 'TURN_NOT_FOUND', message: `No turn ${turn} recorded for session ${sessionId}` };
  }

  private unavailableError(tomb: Tombstone, message?: string): StoreError {
    return {
      ok: false,
      code: 'OUTPUT_UNAVAILABLE',
      reason: tomb.reason,
      message: message ?? `Output for turn ${tomb.turn} is unavailable (${tomb.reason})`,
    };
  }

  /** Look up a live artifact, or the reason it is not one (tombstoned or unknown). */
  private require(sessionId: string, turn: number): ArtifactRecord | StoreError {
    const key = this.key(sessionId, turn);
    const rec = this.artifacts.get(key);
    if (rec) return rec;
    const tomb = this.tombstones.get(key);
    if (tomb) return this.unavailableError(tomb);
    return this.notFoundError(sessionId, turn);
  }

  private addTombstone(
    key: string,
    sessionId: string,
    turn: number,
    reason: Tombstone['reason'],
    partial: boolean,
    answerChars: number | undefined,
    toolCallCount: number,
  ): void {
    this.tombstones.delete(key);
    this.tombstones.set(key, { sessionId, turn, reason, partial, answerChars, toolCallCount });
    while (this.tombstones.size > this.limits.maxTombstones) {
      const oldest = this.tombstones.keys().next();
      if (oldest.done) break;
      this.tombstones.delete(oldest.value);
    }
  }

  private oldestArtifactKey(protectKey: string | undefined): string | undefined {
    for (const k of this.artifacts.keys()) {
      if (k !== protectKey) return k;
    }
    return undefined;
  }

  private evictArtifact(key: string): void {
    const rec = this.artifacts.get(key);
    if (!rec) return;
    this.artifacts.delete(key);
    this.totalBytes -= rec.bytes;
    this.addTombstone(key, rec.sessionId, rec.turn, 'evicted', rec.partial, rec.answer.length, rec.toolCalls.length);
  }

  /** Evict whole oldest artifacts (never `protectKey`) until admitting `extraTurns`/`extraBytes` fits. */
  private ensureRoom(extraTurns: number, extraBytes: number, protectKey: string | undefined): void {
    while (
      this.artifacts.size + extraTurns > this.limits.maxTurns ||
      this.totalBytes + extraBytes > this.limits.maxBytes
    ) {
      const victim = this.oldestArtifactKey(protectKey);
      if (!victim) break;
      this.evictArtifact(victim);
    }
  }

  /** Expire artifacts past ttl (monotonic). Lazy: called at the start of every public method. */
  sweep(): void {
    const now = this.clock.monotonicNow();
    for (const [key, rec] of [...this.artifacts]) {
      if (now - rec.putAtMonotonic >= this.limits.ttlMs) {
        this.artifacts.delete(key);
        this.totalBytes -= rec.bytes;
        this.addTombstone(key, rec.sessionId, rec.turn, 'expired', rec.partial, rec.answer.length, rec.toolCalls.length);
      }
    }
  }

  /** Idempotent per (sessionId, turn): a second put is ignored (immutable) and returns the existing meta. */
  put(input: TurnArtifactInput): OutputMeta {
    this.sweep();
    const key = this.key(input.sessionId, input.turn);
    const existingArtifact = this.artifacts.get(key);
    if (existingArtifact) return this.metaForArtifact(existingArtifact);
    const existingTombstone = this.tombstones.get(key);
    if (existingTombstone) return this.metaForTombstone(existingTombstone);

    const toolCalls: RetainedToolCall[] = input.toolCalls.map((tc) => {
      const shortened = tc.title !== undefined ? shortenTitle(tc.title, this.limits.maxTitleChars) : undefined;
      return {
        messageId: tc.messageId,
        ...(tc.callId !== undefined ? { callId: tc.callId } : {}),
        tool: tc.tool,
        status: tc.status,
        ...(shortened !== undefined ? { title: shortened.title } : {}),
        ...(shortened?.shortened ? { titleShortened: true } : {}),
      };
    });

    const bytes = byteLen(input.answer) + byteLen(input.structured) + toolCalls.reduce((s, tc) => s + toolCallBytes(tc), 0);

    if (bytes > this.limits.maxTurnBytes) {
      this.addTombstone(key, input.sessionId, input.turn, 'too_large', input.partial, input.answer.length, toolCalls.length);
      return {
        state: 'unavailable',
        reason: 'too_large',
        partial: input.partial,
        answerChars: input.answer.length,
        toolCallCount: toolCalls.length,
      };
    }

    this.ensureRoom(1, bytes, undefined);

    const record: ArtifactRecord = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      turn: input.turn,
      partial: input.partial,
      answer: input.answer,
      toolCalls,
      structured: input.structured,
      bytes,
      putAtMonotonic: this.clock.monotonicNow(),
      expiresAt: this.clock.wallNow() + this.limits.ttlMs,
      diffCounter: 0,
    };
    this.artifacts.set(key, record);
    this.totalBytes += bytes;
    return this.metaForArtifact(record);
  }

  meta(sessionId: string, turn: number): OutputMeta | undefined {
    this.sweep();
    const key = this.key(sessionId, turn);
    const rec = this.artifacts.get(key);
    if (rec) return this.metaForArtifact(rec);
    const tomb = this.tombstones.get(key);
    if (tomb) return this.metaForTombstone(tomb);
    return undefined;
  }

  readText(
    sessionId: string,
    turn: number,
    section: 'answer' | 'structured-output',
    offset: number,
    limit: number,
  ): TextPage | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;
    if (!Number.isInteger(offset) || offset < 0) return invalidArgument(`offset must be an integer >= 0 (got ${offset})`);
    if (!Number.isInteger(limit) || limit < 1) return invalidArgument(`limit must be an integer >= 1 (got ${limit})`);

    let text: string;
    if (section === 'answer') text = found.answer;
    else if (section === 'structured-output') {
      if (found.structured === undefined)
        return { ok: false, code: 'OUTPUT_UNAVAILABLE', message: `Turn ${turn} has no structured-output section` };
      text = found.structured;
    } else return invalidArgument(`Unknown section: ${section as string}`);

    return pageText(text, offset, limit, found.partial);
  }

  readToolCalls(sessionId: string, turn: number, offset: number, limit: number): ItemPage<RetainedToolCall> | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;
    if (!Number.isInteger(offset) || offset < 0) return invalidArgument(`offset must be an integer >= 0 (got ${offset})`);
    if (!Number.isInteger(limit) || limit < 1) return invalidArgument(`limit must be an integer >= 1 (got ${limit})`);
    return pageItems(found.toolCalls, offset, limit, found.partial, cloneToolCall);
  }

  /** Replaces any older snapshot of that turn. */
  putDiff(sessionId: string, turn: number, sourceMessageId: string, items: DiffItem[]): DiffSnapshot | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;

    const key = this.key(sessionId, turn);
    const newItems: Array<DiffItem & { fileIndex: number }> = items.map((item, fileIndex) => ({ ...item, fileIndex }));
    const diffBytes = newItems.reduce((s, item) => s + diffItemBytes(item), 0);
    const oldDiffBytes = found.diff?.bytes ?? 0;
    const turnBytesWithoutOldDiff = found.bytes - oldDiffBytes;

    if (turnBytesWithoutOldDiff + diffBytes > this.limits.maxTurnBytes) {
      return {
        ok: false,
        code: 'OUTPUT_UNAVAILABLE',
        reason: 'too_large',
        message: `Diff for turn ${turn} exceeds the per-turn size limit`,
      };
    }

    const deltaTotal = diffBytes - oldDiffBytes;
    if (deltaTotal > 0) this.ensureRoom(0, deltaTotal, key);

    const counter = ++found.diffCounter;
    const snapshot: StoredDiffSnapshot = {
      snapshotId: `${found.turnId}:d${counter}`,
      observedAt: this.clock.wallNow(),
      sourceMessageId,
      items: newItems,
      bytes: diffBytes,
    };

    this.totalBytes += deltaTotal;
    found.bytes = turnBytesWithoutOldDiff + diffBytes;
    found.diff = snapshot;

    return { snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt, sourceMessageId, items: newItems.map((i) => ({ ...i })) };
  }

  /** undefined → current snapshot if any, else an error the engine can treat as "fetch needed"
   * (SNAPSHOT_EXPIRED: the documented recovery is the same — re-request offset 0 without a
   * snapshot-id to obtain a fresh snapshot). */
  diff(sessionId: string, turn: number, snapshotId: string | undefined): DiffSnapshot | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;
    if (!found.diff || (snapshotId !== undefined && found.diff.snapshotId !== snapshotId)) {
      return {
        ok: false,
        code: 'SNAPSHOT_EXPIRED',
        message: `No current diff snapshot for turn ${turn} matches ${snapshotId ?? '(none requested)'}`,
      };
    }
    const snap = found.diff;
    return { snapshotId: snap.snapshotId, observedAt: snap.observedAt, sourceMessageId: snap.sourceMessageId, items: snap.items.map((i) => ({ ...i })) };
  }

  currentDiff(sessionId: string, turn: number): DiffSnapshot | undefined {
    this.sweep();
    const key = this.key(sessionId, turn);
    const rec = this.artifacts.get(key);
    if (!rec || !rec.diff) return undefined;
    const snap = rec.diff;
    return { snapshotId: snap.snapshotId, observedAt: snap.observedAt, sourceMessageId: snap.sourceMessageId, items: snap.items.map((i) => ({ ...i })) };
  }

  readDiffStat(sessionId: string, turn: number, snapshotId: string, offset: number, limit: number): ItemPage<DiffStatItem> | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;
    if (!found.diff || found.diff.snapshotId !== snapshotId)
      return { ok: false, code: 'SNAPSHOT_EXPIRED', message: `Snapshot ${snapshotId} is not the current snapshot for turn ${turn}` };
    if (!Number.isInteger(offset) || offset < 0) return invalidArgument(`offset must be an integer >= 0 (got ${offset})`);
    if (!Number.isInteger(limit) || limit < 1) return invalidArgument(`limit must be an integer >= 1 (got ${limit})`);

    const statItems: DiffStatItem[] = found.diff.items.map((item) => ({
      fileIndex: item.fileIndex,
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
      additions: item.additions,
      deletions: item.deletions,
      ...(item.patch !== undefined ? { patchChars: item.patch.length } : {}),
    }));
    return pageItems(statItems, offset, limit, found.partial, cloneDiffStatItem);
  }

  readPatch(sessionId: string, turn: number, snapshotId: string, fileIndex: number, offset: number, limit: number): TextPage | StoreError {
    this.sweep();
    const found = this.require(sessionId, turn);
    if (isStoreError(found)) return found;
    if (!found.diff || found.diff.snapshotId !== snapshotId)
      return { ok: false, code: 'SNAPSHOT_EXPIRED', message: `Snapshot ${snapshotId} is not the current snapshot for turn ${turn}` };
    if (!Number.isInteger(fileIndex) || fileIndex < 0) return invalidArgument(`file-index must be an integer >= 0 (got ${fileIndex})`);
    const item = found.diff.items.find((i) => i.fileIndex === fileIndex);
    if (!item) return invalidArgument(`No diff item at file-index ${fileIndex}`);
    if (!Number.isInteger(offset) || offset < 0) return invalidArgument(`offset must be an integer >= 0 (got ${offset})`);
    if (!Number.isInteger(limit) || limit < 1) return invalidArgument(`limit must be an integer >= 1 (got ${limit})`);
    return pageText(item.patch ?? '', offset, limit, found.partial);
  }

  /** On successful opencode-end: remove all of this session's artifacts and tombstones. */
  dropSession(sessionId: string): void {
    this.sweep();
    for (const [key, rec] of [...this.artifacts]) {
      if (rec.sessionId === sessionId) {
        this.artifacts.delete(key);
        this.totalBytes -= rec.bytes;
      }
    }
    for (const [key, tomb] of [...this.tombstones]) {
      if (tomb.sessionId === sessionId) this.tombstones.delete(key);
    }
  }

  stats(): { turns: number; bytes: number } {
    this.sweep();
    return { turns: this.artifacts.size, bytes: this.totalBytes };
  }
}

/**
 * Reconcile a TurnResult's cached `output` field (captured once, at commit time) against the
 * store's current truth for that same (sessionId, turn) — `fresh` is whatever `OutputStore.meta()`
 * returns right now. Used by engine.ts's `status`, `statusMany` and keyed-request replay so a stale
 * cached 'retained' is never handed back once the store itself has forgotten the turn: `meta()`
 * normally still finds a tombstone after ordinary eviction/expiry (so `fresh` is defined and wins
 * outright), but capacity can also evict the tombstone itself (FY-2 #5; `maxTombstones`) — `fresh`
 * is then `undefined` even though the cached `current.state` still says 'retained'. Only a cached
 * 'retained' ever needs reinterpreting; 'pending'/'unavailable' are already accurate as of commit.
 */
export function refreshOutputMeta(current: TurnOutputMeta, fresh: OutputMeta | undefined, wallNow: number): TurnOutputMeta {
  if (fresh) return fresh;
  if (current.state !== 'retained') return current;
  return {
    state: 'unavailable',
    reason: current.expiresAt !== undefined && wallNow >= current.expiresAt ? 'expired' : 'evicted',
    toolCallCount: current.toolCallCount,
    partial: current.partial,
  };
}
