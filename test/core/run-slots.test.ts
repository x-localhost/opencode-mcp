import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, type Config } from '../../src/types.ts';
import { RunSlots, runLimits } from '../../src/core/run-slots.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
const limits = (maxRunning: number | null, maxQueued = 64, perModel = new Map<string, number>()) => ({ maxRunning, maxQueued, queueTimeoutMs: null, perModel });

test('reserve grants below cap and queues above cap; release grants FIFO', async () => {
  const slots = new RunSlots(limits(2), new FakeClock());
  const a = slots.reserve('a'); const b = slots.reserve('b'); const c = slots.reserve('c');
  assert.equal(a.state, 'granted'); assert.equal(b.state, 'granted'); assert.equal(c.state, 'queued');
  a.release(); assert.equal(c.state, 'queued'); await flush(); assert.equal(c.state, 'granted');
  const d = slots.reserve('d'); assert.equal(d.state, 'queued');
  b.release(); await flush(); assert.equal(d.state, 'granted');
});

test('model cap skips ahead, but global cap stops the scan', async () => {
  const slots = new RunSlots(limits(3, 10, new Map([['A', 1]])), new FakeClock());
  const a1 = slots.reserve('A'); const a2 = slots.reserve('A'); const b1 = slots.reserve('B');
  assert.equal(a2.queueInfo()?.blockedBy, 'model'); assert.equal(b1.state, 'granted');
  a1.release(); await flush(); assert.equal(a2.state, 'granted');

  const full = new RunSlots(limits(1), new FakeClock());
  const first = full.reserve('x'); const second = full.reserve('y');
  first.release(); await flush(); assert.equal(second.state, 'granted');
});

test('older eligible queued work is dispatched before a new arrival', async () => {
  const slots = new RunSlots(limits(2, 10, new Map([['A', 1]])), new FakeClock());
  const a1 = slots.reserve('A'); const a2 = slots.reserve('A');
  a1.release();
  const b = slots.reserve('B');
  assert.equal(a2.state, 'granted'); assert.equal(b.state, 'granted');
});

test('capacity errors distinguish global and model saturation, including zero queue', () => {
  const global = new RunSlots(limits(1, 0), new FakeClock()); global.reserve(undefined);
  assert.throws(() => global.reserve(undefined), (error: unknown) => error instanceof EngineError && error.code === 'RUN_QUEUE_CAPACITY' && error.message.includes('All 1 run slots are busy'));
  const model = new RunSlots(limits(3, 0, new Map([['A', 1]])), new FakeClock()); model.reserve('A');
  assert.throws(() => model.reserve('A'), (error: unknown) => error instanceof EngineError && error.message.includes('All 1 run slots for A are busy'));
});

test('release and cancellation are idempotent; queued release settles cancelled', async () => {
  const slots = new RunSlots(limits(1), new FakeClock());
  const a = slots.reserve('a'); const b = slots.reserve('b');
  b.release(); b.release(); assert.equal(await b.settled, 'cancelled');
  a.release(); a.release(); await flush(); assert.equal(slots.snapshot().running, 0);
});

test('hold keeps the slot, is counted, and release later frees it', async () => {
  const slots = new RunSlots(limits(1), new FakeClock());
  const a = slots.reserve('a'); const b = slots.reserve('b');
  a.hold(); await flush(); assert.equal(b.state, 'queued'); assert.equal(slots.snapshot().heldUnknown, 1);
  a.release(); await flush(); assert.equal(b.state, 'granted');
});

test('close cancels queued work, blocks scheduled grants and future reservations', async () => {
  const slots = new RunSlots(limits(1), new FakeClock());
  const a = slots.reserve('a'); const b = slots.reserve('b');
  a.release(); slots.close(); slots.close();
  assert.equal(await b.settled, 'cancelled'); await flush(); assert.equal(b.state, 'cancelled');
  assert.throws(() => slots.reserve('c'), (error: unknown) => error instanceof EngineError && error.code === 'SHUTTING_DOWN' && error.message === 'The server is shutting down.');
});

test('queue info and snapshot report positions, blockers, elapsed time and counts', () => {
  const clock = new FakeClock();
  const slots = new RunSlots(limits(2, 10, new Map([['A', 1]])), clock);
  const held = slots.reserve('A'); held.hold();
  const a = slots.reserve('A'); const b = slots.reserve('B'); const c = slots.reserve('C'); clock.tick(25);
  assert.deepEqual(a.queueInfo(), { position: 1, running: 2, maxRunning: 2, blockedBy: 'global', model: 'A', modelRunning: 1, modelMaxRunning: 1, queuedMs: 25 });
  assert.equal(c.queueInfo()?.position, 2); assert.equal(c.queueInfo()?.blockedBy, 'global');
  assert.equal(b.state, 'granted');
  assert.deepEqual(slots.snapshot(), { running: 2, queued: 2, heldUnknown: 1, available: 0, perModel: [{ model: 'A', maxRunning: 1, running: 1, queued: 1 }] });
});

test('unlimited global mode does not queue unless model cap blocks it', () => {
  const slots = new RunSlots(limits(null), new FakeClock());
  for (let i = 0; i < 100; i++) assert.equal(slots.reserve(undefined).state, 'granted');
  assert.equal(slots.snapshot().available, null);
});

test('runLimits normalizes absent and zero values and reads profile caps', () => {
  const defaults = runLimits({});
  assert.deepEqual({ maxRunning: defaults.maxRunning, maxQueued: defaults.maxQueued, queueTimeoutMs: defaults.queueTimeoutMs, perModel: [...defaults.perModel] }, { maxRunning: 4, maxQueued: 64, queueTimeoutMs: null, perModel: [] });
  const config = { maxRunningTurns: 0, maxQueuedTurns: 0, queueTimeoutMs: 0, modelProfiles: { 'p/a': { maxRunning: 2 }, 'p/b': { context: 100 } } } as Partial<Config>;
  const normalized = runLimits(config);
  assert.equal(normalized.maxRunning, null); assert.equal(normalized.maxQueued, 0); assert.equal(normalized.queueTimeoutMs, null);
  assert.deepEqual([...normalized.perModel], [['p/a', 2]]);
});

test('released and cancelled tickets are no longer tracked', async () => {
  const slots = new RunSlots(runLimits({ maxRunningTurns: 1 }), new FakeClock());
  for (let i = 0; i < 50; i++) {
    const a = slots.reserve(undefined);
    const b = slots.reserve(undefined);
    a.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(b.state, 'granted');
    b.release();
  }
  assert.equal(slots.size, 0);
  assert.deepEqual(slots.snapshot(), { running: 0, queued: 0, heldUnknown: 0, available: 1, perModel: [] });
});
