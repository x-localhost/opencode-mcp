import type { Clock } from '../types.ts';

/** Real time source. Tests inject a manual Clock instead. */
export const realClock: Clock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
