import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../../src/core/hub.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import type { Config, OcEvent } from '../../src/types.ts';

/** Makes every subsequent `subscribe()` call throw immediately (a failed reconnect attempt)
 *  until `stop()` is called, after which the original (real, auto-connecting) implementation
 *  is restored. `errorFactory` lets a test attach structural fields (status, retryAfterSeconds)
 *  to the thrown error, matching how a real OpencodeHttpError-shaped failure would look. */
function failSubscribes(
  connection: FakeConnection,
  errorFactory: () => unknown = () => new Error('simulated reconnect failure'),
): { stop: () => void } {
  const original = connection.api.subscribe.bind(connection.api);
  let failing = true;
  connection.api.subscribe = ((directory: string, signal: AbortSignal) => {
    if (failing)
      return (async function* (): AsyncGenerator<OcEvent> {
        throw errorFactory();
      })();
    return original(directory, signal);
  }) as typeof connection.api.subscribe;
  return {
    stop: () => {
      failing = false;
    },
  };
}

test('hub shares stream, reconnects after end and changes generation', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 100 } as Config);
  const events: string[] = [];
  const lease = await connection.acquire();
  const first = hub.listen('/repo', lease, (e) => events.push(e.type));
  const second = hub.listen('/repo', lease, (e) => events.push(e.type));
  await Promise.resolve();
  connection.api.emit('/repo', { type: 'server.connected', properties: {} });
  await Promise.all([first.connected, second.connected]);
  assert.equal(connection.api.subscribeCount, 1);
  connection.api.disconnect('/repo');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  clock.tick(600);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(connection.api.subscribeCount, 2);
  // R10: the recovery refresh is jittered by up to 2000ms after the real reconnection, not
  // emitted synchronously with it.
  clock.tick(2000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(events.includes('hub.reconnected'));
  connection.unavailable();
  await Promise.resolve();
  const newer = await connection.acquire();
  const third = hub.listen('/repo', newer, (e) => events.push(e.type));
  await Promise.resolve();
  connection.api.emit('/repo', { type: 'server.connected', properties: {} });
  await third.connected;
  assert.equal(connection.api.subscribeCount, 3);
  first.close();
  second.close();
  third.close();
  hub.close();
});

test('heartbeat resets SSE stall watchdog and disposed instance reconnects', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  // random -> 0: every jittered delay (backoff and recovery refresh) resolves to its floor, so
  // this test only needs to reason about the watchdog/backoff/subscribe-count mechanics, not jitter.
  const hub = new EventHub(connection, clock, { sseStallMs: 100 } as Config, undefined, () => 0);
  const lease = await connection.acquire();
  const received: string[] = [];
  const listening = hub.listen('/repo', lease, (e) => received.push(e.type));
  await listening.connected;
  clock.tick(50);
  connection.api.emit('/repo', { type: 'server.heartbeat', properties: {} });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  clock.tick(99);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(connection.api.subscribeCount, 1);
  clock.tick(1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  clock.tick(600);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(connection.api.subscribeCount, 2);
  connection.api.emit('/repo', { type: 'server.instance.disposed', properties: {} });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  clock.tick(1200);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(received.includes('hub.reconnected'));
  assert.equal(connection.api.subscribeCount, 3);
  listening.close();
  hub.close();
});

test('EventHub ref-counts listeners: closing one keeps the shared stream alive for the other', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 100 } as Config);
  const lease = await connection.acquire();
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  const first = hub.listen('/repo', lease, (e) => firstEvents.push(e.type));
  const second = hub.listen('/repo', lease, (e) => secondEvents.push(e.type));
  await Promise.all([first.connected, second.connected]); // off the fake API's auto-seeded event
  assert.equal(connection.api.subscribeCount, 1);

  first.close();
  connection.api.emit('/repo', { type: 'server.heartbeat', properties: {} });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(secondEvents, ['server.connected', 'server.heartbeat']);
  assert.deepEqual(firstEvents, ['server.connected']);
  assert.equal(connection.api.subscribeCount, 1);

  second.close();
  const fresh = hub.listen('/repo', lease, () => {});
  await fresh.connected; // a fresh subscribe(), off its own auto-seeded event
  assert.equal(connection.api.subscribeCount, 2);

  fresh.close();
  hub.close();
});

// --- R11: one unresolved connection waiter per outage ----------------------------------------

test('a listener joining during a reconnect outage resolves once the real reconnection succeeds, surviving multiple failed attempts', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 20_000 } as Config, undefined, () => 1);
  const lease = await connection.acquire();
  const first = hub.listen('/repo', lease, () => {});
  await first.connected; // initial auto-connect, before any failure injection

  const failures = failSubscribes(connection);
  connection.api.disconnect('/repo'); // ends the open stream; starts the reconnect loop
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // A late listener joins mid-outage and receives the shared, still-unresolved waiter.
  const late = hub.listen('/repo', lease, () => {});
  let lateResolved = false;
  void late.connected.then(() => {
    lateResolved = true;
  });

  // Drive several failed reconnect attempts (each attempt's own backoff is well under 31s
  // regardless of the exact jitter formula, since the ceiling is capped at 30s).
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 5; j++) await Promise.resolve();
    clock.tick(31_000);
  }
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.equal(lateResolved, false, 'a failed reconnect attempt must not resolve the waiter');

  // The next attempt succeeds for real.
  failures.stop();
  clock.tick(31_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  assert.equal(lateResolved, true, 'the waiter must resolve once server.connected actually fires');
  first.close();
  late.close();
  hub.close();
});

// --- R10: one recovery notification per successful reconnect, jittered and coalesced ---------

test('hub.reconnected fires exactly once after a real reconnection, jittered, never on a failed attempt', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const random = () => 0.25; // deterministic: recovery jitter resolves to exactly 500ms
  const hub = new EventHub(connection, clock, { sseStallMs: 20_000 } as Config, undefined, random);
  const lease = await connection.acquire();
  const events: string[] = [];
  const listening = hub.listen('/repo', lease, (e) => events.push(e.type));
  await listening.connected;

  const failures = failSubscribes(connection);
  connection.api.disconnect('/repo');
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 5; j++) await Promise.resolve();
    clock.tick(31_000);
  }
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.ok(!events.includes('hub.reconnected'), 'no refresh must fire on a failed attempt');

  failures.stop();
  clock.tick(31_000);
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.ok(events.includes('server.connected'), 'the real reconnection itself must be observed');
  assert.ok(!events.includes('hub.reconnected'), 'the refresh is jittered, not emitted immediately');

  clock.tick(499);
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.ok(!events.includes('hub.reconnected'), 'still within the 500ms jitter window');

  clock.tick(1);
  for (let j = 0; j < 5; j++) await Promise.resolve();
  const count = events.filter((e) => e === 'hub.reconnected').length;
  assert.equal(count, 1, 'exactly one recovery notification for the one successful reconnect');

  listening.close();
  hub.close();
});

// --- Reconnect delay: full jitter, 250ms floor, 30s cap ---------------------------------------

test('reconnect backoff floors every delay at 250ms when jitter draws near zero', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 60_000 } as Config, undefined, () => 0);
  const lease = await connection.acquire();
  const listening = hub.listen('/repo', lease, () => {});
  await listening.connected;

  const retryDelays: number[] = [];
  const originalSchedule = clock.schedule.bind(clock);
  clock.schedule = ((delayMs: number, cb: () => void) => {
    if (delayMs !== 60_000 && retryDelays.length < 8) retryDelays.push(delayMs);
    return originalSchedule(delayMs, cb);
  }) as typeof clock.schedule;

  failSubscribes(connection); // never stopped: every attempt fails for the whole test
  connection.api.disconnect('/repo');
  for (let i = 0; i < 10 && retryDelays.length < 8; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    clock.tick(31_000);
  }
  for (let j = 0; j < 10; j++) await Promise.resolve();

  assert.equal(retryDelays.length, 8);
  // random() === 0 always: U(0, backoff) draws 0, so every delay hits the 250ms floor regardless
  // of how large the exponential ceiling itself has grown.
  for (const d of retryDelays) assert.equal(d, 250);

  listening.close();
  hub.close();
});

test('reconnect backoff ceiling doubles from 500ms and caps at 30s', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 60_000 } as Config, undefined, () => 1);
  const lease = await connection.acquire();
  const listening = hub.listen('/repo', lease, () => {});
  await listening.connected;

  const retryDelays: number[] = [];
  const originalSchedule = clock.schedule.bind(clock);
  clock.schedule = ((delayMs: number, cb: () => void) => {
    if (delayMs !== 60_000 && retryDelays.length < 8) retryDelays.push(delayMs);
    return originalSchedule(delayMs, cb);
  }) as typeof clock.schedule;

  failSubscribes(connection); // never stopped
  connection.api.disconnect('/repo');
  for (let i = 0; i < 10 && retryDelays.length < 8; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    clock.tick(31_000);
  }
  for (let j = 0; j < 10; j++) await Promise.resolve();

  // random() === 1 always: U(0, backoff) draws the ceiling itself, exposing the raw exponential
  // sequence 500 -> 1000 -> 2000 -> 4000 -> 8000 -> 16000 -> 30000 (capped, stays capped).
  assert.deepEqual(retryDelays, [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);

  listening.close();
  hub.close();
});

test('SSE reconnect honours a structurally-carried Retry-After on the connect failure', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 60_000 } as Config, undefined, () => 0);
  const lease = await connection.acquire();
  const listening = hub.listen('/repo', lease, () => {});
  await listening.connected;

  const retryDelays: number[] = [];
  const originalSchedule = clock.schedule.bind(clock);
  clock.schedule = ((delayMs: number, cb: () => void) => {
    if (delayMs !== 60_000) retryDelays.push(delayMs);
    return originalSchedule(delayMs, cb);
  }) as typeof clock.schedule;

  // `OpencodeHttpError` carries `retryAfterSeconds`. Simulate that shape structurally, without
  // importing the symbol, matching the interface contract in src/core/hub.ts's describeError().
  failSubscribes(connection, () =>
    Object.assign(new Error('rate limited'), { status: 429, errorName: 'HttpError', retryAfterSeconds: 7 }),
  );
  // The already-open stream ends cleanly here (no error yet), so its own first retry is an
  // ordinary floored 250ms wait; the injected Retry-After error is only thrown by the *next*
  // subscribe() attempt, made once that retry fires.
  connection.api.disconnect('/repo');
  for (let j = 0; j < 10; j++) await Promise.resolve();
  assert.equal(retryDelays.length, 1);
  assert.equal(retryDelays[0], 250);

  clock.tick(300); // fires the first retry; the resulting subscribe() attempt throws with Retry-After
  for (let j = 0; j < 10; j++) await Promise.resolve();

  assert.equal(retryDelays.length, 2);
  // random() === 0 would otherwise floor to 250ms; the 7s Retry-After must win as the lower bound.
  assert.equal(retryDelays[1], 7000);

  const cause = hub.lastFailureCause('/repo');
  assert.equal(cause?.name, 'HttpError');
  assert.equal(cause?.status, 429);
  assert.equal(cause?.retryAfterSeconds, 7);
  assert.equal(cause?.attempt, 2);
  assert.equal(cause?.backoffMs, 1000);

  listening.close();
  hub.close();
});

test('SSE reconnect preserves a ten-minute Retry-After rather than retrying at two minutes', async () => {
  const clock = new FakeClock(), connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 60_000 } as Config, undefined, () => 0);
  const lease = await connection.acquire();
  const listening = hub.listen('/repo', lease, () => {});
  await listening.connected;
  let subscriptions = 0;
  failSubscribes(connection, () => {
    subscriptions++;
    return Object.assign(new Error('rate limited'),
      { status: 429, errorName: 'HttpError', retryAfterSeconds: 600 });
  });
  connection.api.disconnect('/repo');
  for (let j = 0; j < 10; j++) await Promise.resolve();
  clock.tick(300);
  for (let j = 0; j < 10; j++) await Promise.resolve();
  assert.equal(subscriptions, 1);
  assert.equal(hub.lastFailureCause('/repo')?.retryAfterSeconds, 600);
  clock.tick(120_000);
  for (let j = 0; j < 10; j++) await Promise.resolve();
  assert.equal(subscriptions, 1);
  clock.tick(480_000);
  for (let j = 0; j < 10; j++) await Promise.resolve();
  assert.equal(subscriptions, 2);
  listening.close();
  hub.close();
});

// --- Timer cleanup on close --------------------------------------------------------------------

test('hub.close() cancels every pending timer: watchdog, retry backoff and jittered recovery refresh', async () => {
  const clock = new FakeClock(),
    connection = new FakeConnection();
  const hub = new EventHub(connection, clock, { sseStallMs: 20_000 } as Config, undefined, () => 0.25);
  const lease = await connection.acquire();
  const listening = hub.listen('/repo', lease, () => {});
  await listening.connected; // the stall watchdog is now armed
  assert.ok(clock.pendingJobs() > 0);

  const failures = failSubscribes(connection);
  connection.api.disconnect('/repo');
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.ok(clock.pendingJobs() > 0, 'a retry backoff timer must be pending mid-outage');

  failures.stop();
  clock.tick(31_000); // let the next attempt succeed, arming a jittered recovery-emit timer too
  for (let j = 0; j < 5; j++) await Promise.resolve();
  assert.ok(clock.pendingJobs() > 0, 'the watchdog and the jittered recovery refresh are pending');

  hub.close();
  assert.equal(clock.pendingJobs(), 0, 'every timer the hub owns must be cancelled on close');
  void listening;
});
