import { EngineError, type Clock, type Config, type TurnQueueInfo } from '../types.ts';

export interface RunLimits {
  maxRunning: number | null;
  maxQueued: number;
  queueTimeoutMs: number | null;
  perModel: ReadonlyMap<string, number>;
}

export function runLimits(config: Partial<Config>): RunLimits {
  const perModel = new Map<string, number>();
  for (const [model, profile] of Object.entries(config.modelProfiles ?? {})) {
    if (profile.maxRunning !== undefined) perModel.set(model, profile.maxRunning);
  }
  const maxRunningTurns = config.maxRunningTurns;
  const queueTimeoutMs = config.queueTimeoutMs;
  return {
    maxRunning: maxRunningTurns === undefined ? 4 : maxRunningTurns === 0 ? null : maxRunningTurns,
    maxQueued: config.maxQueuedTurns ?? 64,
    queueTimeoutMs: queueTimeoutMs === undefined || queueTimeoutMs === 0 ? null : queueTimeoutMs,
    perModel,
  };
}

export type TicketOutcome = 'granted' | 'cancelled';

export interface RunTicket {
  readonly id: number;
  readonly model: string | undefined;
  readonly state: 'queued' | 'granted' | 'held' | 'released' | 'cancelled';
  readonly settled: Promise<TicketOutcome>;
  readonly queuedAtMono: number;
  /** Remembers a same-tick queue/grant so the Turn can report queuedMs: 0. */
  readonly everQueued: boolean;
  grantedAtMono?: number;
  queueInfo(): TurnQueueInfo | undefined;
  release(): void;
  hold(): void;
}

class Ticket implements RunTicket {
  readonly id: number;
  readonly model: string | undefined;
  readonly queuedAtMono: number;
  readonly everQueued: boolean;
  grantedAtMono?: number;
  state: RunTicket['state'];
  readonly settled: Promise<TicketOutcome>;
  private settle!: (outcome: TicketOutcome) => void;
  private slots: RunSlots;

  constructor(slots: RunSlots, id: number, model: string | undefined, queuedAtMono: number, granted: boolean) {
    this.slots = slots;
    this.id = id;
    this.model = model;
    this.queuedAtMono = queuedAtMono;
    this.everQueued = !granted;
    this.state = granted ? 'granted' : 'queued';
    this.settled = new Promise((resolve) => { this.settle = resolve; });
    if (granted) {
      this.grantedAtMono = queuedAtMono;
      this.settle('granted');
    }
  }

  grant(at: number): void {
    this.state = 'granted';
    this.grantedAtMono = at;
    this.settle('granted');
  }
  cancel(): void { this.state = 'cancelled'; this.settle('cancelled'); }
  queueInfo(): TurnQueueInfo | undefined { return this.state === 'queued' ? this.slots.ticketQueueInfo(this) : undefined; }
  release(): void { this.slots.release(this); }
  hold(): void { this.slots.hold(this); }
}

export class RunSlots {
  private tickets: Ticket[] = [];
  private closed = false;
  private scanPending = false;
  private nextId = 1;
  private limits: RunLimits;
  private clock: Clock;

  constructor(limits: RunLimits, clock: Clock) { this.limits = limits; this.clock = clock; }

  reserve(model: string | undefined): RunTicket {
    if (this.closed) throw new EngineError('SHUTTING_DOWN', 'The server is shutting down.');
    const olderEligible = this.tickets.some((ticket) => ticket.state === 'queued' && this.eligible(ticket.model));
    if (olderEligible) this.scan();
    const now = this.clock.monotonicNow();
    const ticket = new Ticket(this, this.nextId++, model, now, this.eligible(model) && !this.tickets.some((t) => t.state === 'queued' && this.eligible(t.model)));
    if (ticket.state === 'queued' && this.queuedCount() >= this.limits.maxQueued) {
      if (this.isModelBlocked(model)) {
        const cap = this.limits.perModel.get(model!);
        throw new EngineError('RUN_QUEUE_CAPACITY', `All ${cap} run slots for ${model} are busy and the run queue (${this.limits.maxQueued}) is full; nothing was submitted.`);
      }
      const running = this.runningCount();
      const saturation = this.limits.maxRunning === null ? 'All run slots' : `All ${this.limits.maxRunning} run slots`;
      throw new EngineError('RUN_QUEUE_CAPACITY', `${saturation} are busy and the run queue (${this.limits.maxQueued}) is full; nothing was submitted.`);
    }
    this.tickets.push(ticket);
    return ticket;
  }

  private eligible(model: string | undefined): boolean {
    if (this.limits.maxRunning !== null && this.runningCount() >= this.limits.maxRunning) return false;
    if (model !== undefined) {
      const cap = this.limits.perModel.get(model);
      if (cap !== undefined && this.modelRunning(model) >= cap) return false;
    }
    return true;
  }
  private isModelBlocked(model: string | undefined): boolean {
    return model !== undefined && (this.limits.maxRunning === null || this.runningCount() < this.limits.maxRunning)
      && this.limits.perModel.has(model) && this.modelRunning(model) >= this.limits.perModel.get(model)!;
  }
  private runningCount(): number { return this.tickets.filter((t) => t.state === 'granted' || t.state === 'held').length; }
  private modelRunning(model: string): number { return this.tickets.filter((t) => t.model === model && (t.state === 'granted' || t.state === 'held')).length; }
  private queuedCount(): number { return this.tickets.filter((t) => t.state === 'queued').length; }

  private scheduleScan(): void {
    if (this.scanPending || this.closed) return;
    this.scanPending = true;
    queueMicrotask(() => { this.scanPending = false; if (!this.closed) this.scan(); });
  }
  private scan(): void {
    if (this.closed) return;
    for (const ticket of this.tickets) {
      if (ticket.state !== 'queued') continue;
      if (this.limits.maxRunning !== null && this.runningCount() >= this.limits.maxRunning) break;
      if (this.eligible(ticket.model)) ticket.grant(this.clock.monotonicNow());
    }
  }

  release(ticket: Ticket): void {
    if (ticket.state === 'granted' || ticket.state === 'held') ticket.state = 'released';
    else if (ticket.state === 'queued') ticket.cancel();
    else return;
    // Only live tickets stay tracked, so the list is bounded by running + queued over a long process.
    this.tickets = this.tickets.filter((item) => item !== ticket);
    this.scheduleScan();
  }
  /** live (queued, granted or held) tickets; exposed for leak tests */
  get size(): number { return this.tickets.length; }
  hold(ticket: Ticket): void {
    if (ticket.state === 'granted') { ticket.state = 'held'; this.scheduleScan(); }
  }

  ticketQueueInfo(ticket: Ticket): TurnQueueInfo | undefined {
    if (ticket.state !== 'queued') return undefined;
    const modelCap = ticket.model === undefined ? undefined : this.limits.perModel.get(ticket.model);
    const globalHasRoom = this.limits.maxRunning === null || this.runningCount() < this.limits.maxRunning;
    return {
      position: this.tickets.filter((t) => t.state === 'queued' && t.id <= ticket.id).length,
      running: this.runningCount(), maxRunning: this.limits.maxRunning,
      blockedBy: globalHasRoom && modelCap !== undefined && this.modelRunning(ticket.model!) >= modelCap ? 'model' : 'global',
      ...(ticket.model === undefined ? {} : { model: ticket.model }),
      ...(modelCap === undefined ? {} : { modelRunning: this.modelRunning(ticket.model!), modelMaxRunning: modelCap }),
      queuedMs: this.clock.monotonicNow() - ticket.queuedAtMono,
    };
  }

  snapshot(): { running: number; queued: number; heldUnknown: number; available: number | null; perModel: Array<{ model: string; maxRunning: number; running: number; queued: number }> } {
    const models = [...this.limits.perModel].sort(([a], [b]) => a.localeCompare(b));
    const running = this.runningCount();
    return {
      running, queued: this.queuedCount(), heldUnknown: this.tickets.filter((t) => t.state === 'held').length,
      available: this.limits.maxRunning === null ? null : Math.max(0, this.limits.maxRunning - running),
      perModel: models.map(([model, maxRunning]) => ({ model, maxRunning, running: this.modelRunning(model), queued: this.tickets.filter((t) => t.state === 'queued' && t.model === model).length })),
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const ticket of this.tickets) if (ticket.state === 'queued') ticket.cancel();
    this.tickets = this.tickets.filter((ticket) => ticket.state !== 'cancelled');
  }
}
