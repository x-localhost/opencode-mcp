import { Buffer } from 'node:buffer';
import type { Clock } from '../types.ts';

/** A safe model catalog entry. */
export interface ModelEntry {
  model: string;
  providerId: string;
  modelId: string;
  defaultForProvider: boolean;
  toolcall?: boolean;
}

/** A safe agent catalog entry. */
export interface AgentEntry { name: string; mode: 'primary' | 'all' }

/** A projection and count of rejected upstream entries. */
export interface Projection<T> { items: T[]; dropped: number }

/** Validates printable, bounded catalog identifiers. */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

/** Narrows an unknown value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Projects connected provider models into the public allowlist. */
export function projectModels(response: unknown, filter?: { provider?: string }): Projection<ModelEntry> {
  if (!isRecord(response)) return { items: [], dropped: 0 };
  const connected = response.connected;
  const all = response.all;
  const defaults = response.default;
  if (!Array.isArray(connected) || !Array.isArray(all) || !isRecord(defaults)) {
    return { items: [], dropped: 0 };
  }
  const connectedIds = new Set<string>();
  let dropped = 0;
  for (const id of connected) {
    if (validId(id) && !id.includes('/')) connectedIds.add(id);
    else dropped++;
  }
  const items: ModelEntry[] = [];
  for (const rawProvider of all) {
    if (!isRecord(rawProvider)) { dropped++; continue; }
    const providerId = rawProvider.id;
    if (!validId(providerId) || providerId.includes('/')) { dropped++; continue; }
    if (!connectedIds.has(providerId) || (filter?.provider !== undefined && filter.provider !== providerId)) {
      continue;
    }
    const models = rawProvider.models;
    if (!isRecord(models)) { dropped++; continue; }
    for (const [modelId, rawModel] of Object.entries(models)) {
      if (!validId(modelId) || !isRecord(rawModel)) { dropped++; continue; }
      if ('status' in rawModel && rawModel.status !== 'active') continue;
      const capabilities = rawModel.capabilities;
      const toolcall = isRecord(capabilities) ? capabilities.toolcall : undefined;
      const item: ModelEntry = {
        model: `${providerId}/${modelId}`,
        providerId,
        modelId,
        defaultForProvider: defaults[providerId] === modelId,
      };
      if (typeof toolcall === 'boolean') item.toolcall = toolcall;
      items.push(item);
    }
  }
  items.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  return { items, dropped };
}

/** Projects visible primary and all agents into the public allowlist. */
export function projectAgents(response: unknown): Projection<AgentEntry> {
  if (!Array.isArray(response)) return { items: [], dropped: 0 };
  const items: AgentEntry[] = [];
  let dropped = 0;
  for (const rawAgent of response) {
    if (!isRecord(rawAgent)) { dropped++; continue; }
    if (rawAgent.hidden === true) continue;
    const name = rawAgent.name;
    const mode = rawAgent.mode;
    if (!validId(name) || (mode !== 'primary' && mode !== 'all')) { dropped++; continue; }
    items.push({ name, mode });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, dropped };
}

/** An immutable catalog snapshot and its observation time. */
export interface CatalogSnapshot<T> { snapshotId: string; observedAt: number; items: T[]; dropped: number }

function freezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy)) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: freezeCopy(child), enumerable: true });
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

function snapshotView<T>(snapshot: CatalogSnapshot<unknown>): CatalogSnapshot<T> {
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    items: freezeCopy(snapshot.items) as T[],
    dropped: snapshot.dropped,
  });
}

/** Stores bounded, expiring catalog snapshots without timers. */
export class CatalogCache {
  private readonly clock: Pick<Clock, 'monotonicNow' | 'wallNow'>;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly snapshots = new Map<string, {
    snapshot: CatalogSnapshot<unknown>; expiresAt: number; bytes: number; order: number;
  }>();
  private sequence = 0;
  private order = 0;
  private totalBytes = 0;

  /** Creates a cache with a monotonic expiry clock and byte limit. */
  constructor(
    clock: Pick<Clock, 'monotonicNow' | 'wallNow'>,
    limits?: { ttlMs?: number; maxBytes?: number },
  ) {
    this.clock = clock;
    this.ttlMs = limits?.ttlMs ?? 60_000;
    this.maxBytes = limits?.maxBytes ?? 8 * 1024 * 1024;
  }

  /** Returns the live snapshot for a key, if present. */
  current<T>(key: string): CatalogSnapshot<T> | undefined {
    const entry = this.live(key);
    return entry ? snapshotView<T>(entry.snapshot) : undefined;
  }

  /** Stores and returns a fresh snapshot for a key. */
  put<T>(key: string, items: T[], dropped = 0): CatalogSnapshot<T> {
    // Expiry applies to the whole cache, including keys that are never read again.
    for (const [oldKey, old] of this.snapshots)
      if (this.clock.monotonicNow() >= old.expiresAt) this.remove(oldKey);
    this.remove(key);
    const snapshot: CatalogSnapshot<T> = {
      snapshotId: `catalog-${++this.sequence}`,
      observedAt: this.clock.wallNow(),
      items: freezeCopy(items),
      dropped,
    };
    // Charge the key, snapshot metadata and map entry as well as the projected items.
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(items)) + 128;
    if (bytes <= this.maxBytes) {
      while (this.totalBytes + bytes > this.maxBytes) {
        const oldest = [...this.snapshots.entries()].sort((a, b) => a[1].order - b[1].order)[0];
        if (!oldest) break;
        this.remove(oldest[0]);
      }
      this.snapshots.set(key, {
        snapshot: snapshot as CatalogSnapshot<unknown>,
        expiresAt: this.clock.monotonicNow() + this.ttlMs,
        bytes,
        order: ++this.order,
      });
      this.totalBytes += bytes;
    }
    return snapshotView<T>(snapshot);
  }

  /** Looks up a live snapshot by its id. */
  byId<T>(key: string, snapshotId: string): CatalogSnapshot<T> | undefined {
    const entry = this.live(key);
    return entry?.snapshot.snapshotId === snapshotId
      ? snapshotView<T>(entry.snapshot)
      : undefined;
  }

  /** Removes every snapshot with a key beginning with the prefix. */
  invalidate(prefix: string): void {
    for (const key of this.snapshots.keys()) if (key.startsWith(prefix)) this.remove(key);
  }

  /** Returns an unexpired entry, removing it if its TTL elapsed. */
  private live(key: string): { snapshot: CatalogSnapshot<unknown> } | undefined {
    const entry = this.snapshots.get(key);
    if (entry && this.clock.monotonicNow() >= entry.expiresAt) this.remove(key);
    return this.snapshots.get(key);
  }

  /** Removes one stored entry and updates byte accounting. */
  private remove(key: string): void {
    const entry = this.snapshots.get(key);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.snapshots.delete(key);
    }
  }
}

/** Returns a validated page over an array. */
export function pageItems<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; offset: number; nextOffset: number | null; total: number; hasMore: boolean } {
  const total = items.length;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || offset > total) {
    throw new TypeError('INVALID_ARGUMENT: invalid offset or limit');
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < total;
  return { items: page, offset, nextOffset: hasMore ? nextOffset : null, total, hasMore };
}
