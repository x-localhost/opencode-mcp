import { OpencodeHttpError } from '../types.ts';
import type { Clock, Config, Connection, ConnectionLease } from '../types.ts';

// A timeout may occur after OpenCode received a request. Only a status-0 transport error whose
// code identifies refusal, pre-response reset, DNS, or route failure is hard evidence.
function hardFailure(error: unknown): boolean {
  return error instanceof OpencodeHttpError && error.status === 0 && error.responseReceived !== true &&
    error.errorName === 'NetworkError' &&
    /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL)\b/i.test(error.message);
}

/** One health monitor for all turns using a connection generation. */
export class ConnectionHealth {
  private readonly lease: ConnectionLease;
  private readonly connection: Connection;
  private readonly clock: Clock;
  private readonly config: Config;
  private hardSince?: number;
  private epoch = 0;
  private probing = false;
  private cancel?: () => void;

  constructor(
    lease: ConnectionLease, connection: Connection, clock: Clock, config: Config,
  ) {
    this.lease = lease;
    this.connection = connection;
    this.clock = clock;
    this.config = config;
  }

  succeeded(): void {
    this.epoch++;
    this.hardSince = undefined;
    this.cancel?.();
    this.cancel = undefined;
  }

  failed(error: unknown): void {
    if (!hardFailure(error)) {
      // Any HTTP response, timeout, or unclassified transport error breaks the sequence.
      this.succeeded();
      return;
    }
    if (this.hardSince !== undefined) return;
    this.hardSince = this.clock.monotonicNow();
    const epoch = ++this.epoch;
    const delay = Math.max(2 * this.config.statusPollMs, this.config.requestTimeoutMs);
    this.cancel = this.clock.schedule(delay, () => { void this.probe(epoch, 1); });
  }

  private current(epoch: number): boolean {
    return this.epoch === epoch && this.hardSince !== undefined &&
      this.connection.current()?.generation === this.lease.generation;
  }

  private async probe(epoch: number, number: number): Promise<void> {
    if (!this.current(epoch) || this.probing) return;
    this.probing = true;
    let failure: unknown;
    try {
      await this.lease.api.health({ timeoutMs: this.config.requestTimeoutMs });
      this.succeeded();
      return;
    } catch (error) {
      failure = error;
    } finally {
      this.probing = false;
    }
    if (!this.current(epoch)) return;
    if (!hardFailure(failure)) {
      this.succeeded();
      return;
    }
    if (number === 3) {
      if (this.config.mode === 'attach') {
        this.succeeded();
        try { await this.connection.invalidate(this.lease.generation, 'unreachable'); }
        catch { /* A later connection acquisition can retry; turns retain their evidence. */ }
      }
      // In managed mode, keep the hard streak parked until a real success or child exit.
      // The child's exit event is the authoritative process-loss signal.
      return;
    }
    const poll = this.config.statusPollMs;
    const delay = number * poll + Math.random() * poll / 2;
    this.cancel = this.clock.schedule(delay, () => { void this.probe(epoch, number + 1); });
  }
}
