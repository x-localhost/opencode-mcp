import type { Clock } from '../../src/types.ts';

/** Deterministic Clock whose scheduled callbacks run when tests advance time. */
export class FakeClock implements Clock {
  now = 0;
  private next = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();
  wallNow(): number {
    return this.now;
  }

  monotonicNow(): number {
    return this.now;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const id = ++this.next;
    this.jobs.set(id, { at: this.now + Math.max(0, delayMs), callback });
    return () => {
      this.jobs.delete(id);
    };
  }

  pendingJobs(): number {
    return this.jobs.size;
  }

  tick(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}
