// U06: turn read path bounds, grace timing, reconnect refresh, progress size, and observer
// wait-seconds bounds during admission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const base = {
  mode: 'managed',
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  startupTimeoutMs: 1_000,
  requestTimeoutMs: 100,
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 500,
  heartbeatMs: 1_000,
  statusPollMs: 100,
  sseStallMs: 1_000,
  cleanupTimeoutMs: 2_000,
  maxOutputChars: 2_000,
  endAction: 'delete',
  onExit: 'abort',
} as Config;

function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn(message: string, fields?: Record<string, unknown>) {
      warnings.push({ message, fields });
    },
  };
  const config = { ...base, ...overrides };
  const engine = createEngine({ config, connection, clock, logger });
  return { connection, clock, engine, warnings, config };
}

function ctx(): CallContext {
  return { signal: new AbortController().signal };
}

function msg(id: string, role: 'user' | 'assistant', parentID?: string, finish?: string, text = 'done'): OcMessage {
  return {
    info: {
      id,
      sessionID: 'ses_1',
      role,
      parentID,
      finish,
      time: { created: Number(id.slice(1)), ...(finish ? { completed: Number(id.slice(1)) + 1 } : {}) },
    },
    parts: finish ? [{ id: `p${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text }] : [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Ticks the FakeClock forward in small steps, flushing microtasks between each, so timers
 * re-armed mid-flush (grace re-checks, debounced reconciles) get their own later tick to fire
 * instead of requiring one big tick to land exactly on every collision. */
async function advance(clock: FakeClock, totalMs: number, stepMs = 25): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    clock.tick(step);
    await flush();
    remaining -= step;
  }
}

test('U06(a): a reply cannot complete while idle is observed before the new user message exists', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop', 'first'));
  };
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.status, 'completed');
  assert.equal(first.content, 'first');

  // The reply's onPrompt reports idle (no busy status) and pushes nothing: OpenCode has not yet
  // created the new user message. The boundary must keep the turn "running", not resolve it with
  // turn 1's answer.
  connection.api.onPrompt = (id) => {
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
  const replying = engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  await flush();
  const observed = await engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(observed.status, 'running');
  assert.notEqual(observed.content, 'first');

  connection.api.histories.get(first.sessionId)!.push(msg('m3', 'user'), msg('m4', 'assistant', 'm3', 'stop', 'second'));
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: first.sessionId } });
  const reply = await replying;
  assert.equal(reply.status, 'completed');
  assert.equal(reply.content, 'second');
});

test('U06(b): a vanished boundary never lets a reply complete with an earlier answer', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop', 'first'));
  };
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.content, 'first');

  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m3', 'user'), msg('m4', 'assistant', 'm3', 'stop', 'second'));
  };
  const second = await engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  assert.equal(second.content, 'second');

  // The boundary message (m4) vanishes from the upstream history from the moment the third
  // turn's POST is dispatched (e.g. a shared-server third-party mutation), simulating the
  // server never returning it again despite it having existed at boundary-capture time.
  let vanish = false;
  const originalMessages = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    const page = await originalMessages(id, opts);
    return vanish ? { ...page, items: page.items.filter((m) => m.info.id !== 'm4') } : page;
  };
  connection.api.onPrompt = (id) => {
    vanish = true;
    connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: id } });
  };
  const third = engine.reply({ sessionId: first.sessionId, prompt: 'third' }, ctx());
  await flush();
  const observed = await engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(observed.status, 'running');
  assert.notEqual(observed.content, 'first');

  connection.api.histories.get(first.sessionId)!.push(msg('m5', 'user'), msg('m6', 'assistant', 'm5', 'stop', 'third'));
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: first.sessionId } });
  const result = await third;
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'third');
});

test('U06(c): interval paging is capped so a runaway cursor cannot stall reconcile or stop', async () => {
  const { connection, engine, warnings } = setup({ cleanupTimeoutMs: 2_000 });
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  assert.equal(started.status, 'running');

  let cursor = 0;
  connection.api.messages = async () => {
    cursor++;
    const items: OcMessage[] = Array.from({ length: 100 }, (_, i) => ({
      info: {
        id: `z${cursor}_${String(i).padStart(3, '0')}`,
        sessionID: started.sessionId,
        role: 'user' as const,
        time: { created: 0 },
      },
      parts: [],
    }));
    return { items, nextCursor: `c${cursor}` };
  };

  const cancelled = await engine.cancel({ sessionId: started.sessionId }, ctx());
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.executionState, 'unknown');
  assert.ok(cursor >= 50, `expected the page cap to bound pagination, saw ${cursor} pages`);
  assert.ok(
    warnings.some((w) => /page cap/i.test(w.message)),
    'expected a page-cap warning to be logged',
  );
});

test('U06(j): the ambiguous-POST follow-up read is bounded to a poll interval, not just the page cap', async () => {
  // P3-4 (core review): before the fix, this read had no deadline and was bounded
  // only by 50 pages x requestTimeoutMs; a hostile/slow upstream that keeps returning a fresh
  // cursor could stall admission far longer than one poll interval. With the fix, the read must
  // give up once now + max(statusPollMs, requestTimeoutMs) passes, well short of 50 pages.
  // A failed observation after an ambiguous POST keeps the original turn running.
  const { connection, clock, engine } = setup({ statusPollMs: 50, requestTimeoutMs: 30, cleanupTimeoutMs: 5_000 });
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  let cursor = 0;
  let boundaryCaptured = false;
  const originalMessages = connection.api.messages.bind(connection.api);
  connection.api.messages = async (id: string, opts?: { limit?: number; before?: string }) => {
    if (!boundaryCaptured) {
      boundaryCaptured = true;
      return originalMessages(id, opts);
    }
    cursor++;
    // Each page "costs" 40ms of (fake) time to arrive — comfortably more than the 50ms deadline
    // after only two pages, and nowhere near the 50-page cap.
    clock.tick(40);
    const items: OcMessage[] = [
      { info: { id: `z${cursor}`, sessionID: 'ses_1', role: 'user' as const, time: { created: 0 } }, parts: [] },
    ];
    return { items, nextCursor: `c${cursor}` };
  };

  const result = await engine.start({ prompt: 'first', waitSeconds: 0 }, ctx());
  assert.equal(result.executionState, 'active');
  assert.equal(result.status, 'running');
  assert.equal(result.upstreamRead?.reason, 'timeout');
  assert.ok(cursor < 50, `expected the deadline to cut the read short well before the page cap, saw ${cursor} pages`);
});

test('U06(d): the no-user grace is measured from when the ambiguous POST settles, not before dispatch', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 100, requestTimeoutMs: 100 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.api.onPrompt = async () => {
    await gate;
  };
  connection.api.promptFailure = new OpencodeHttpError('Timed out', 0, 'TimeoutError');

  const pending = engine.start({ prompt: 'hello', waitSeconds: 0 }, ctx());
  await flush();
  // The POST itself takes a full statusPollMs before settling; none of that time may count
  // against the grace window.
  await advance(clock, 100);
  release();
  await flush();
  const started = await pending;
  assert.equal(started.status, 'running');

  // Just under a full statusPollMs after the POST settled, the grace has not expired.
  await advance(clock, 80);
  const early = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(early.executionState, 'active');

  // Overload observation now spans two poll intervals after settlement.
  await advance(clock, 160);
  const late = await engine.status({ sessionId: started.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(late.error?.name, 'SUBMISSION_UNCONFIRMED');
});

test("U06(e): a second reconnect's notification arriving during a gated refresh still re-runs it once the gate releases", async () => {
  // Under the fixed EventHub (overload-robustness R10), a single outage now emits exactly one,
  // jittered 'hub.reconnected' — the old behavior this test used to rely on (an immediate
  // pre-backoff emission on every attempt, plus a second one on the real post-connect) is gone;
  // one outage can no longer produce two notifications on its own. Reproduce the scenario
  // turn.ts's refreshing/refreshAgain gate actually exists for with two separate outages instead:
  // the second reconnect's notification must arrive while the first refresh is still stuck on the
  // gated connection.acquire() call, and must still coalesce into exactly one trailing refresh
  // once the gate releases — never dropped, and never a third, concurrent refresh.
  const { connection, clock, engine } = setup({ statusPollMs: 100_000 });
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await flush();
  const before = connection.api.calls.filter((c) => c.method === 'listPermissions').length;

  const originalAcquire = connection.acquire.bind(connection);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquireCalls = 0;
  connection.acquire = async (req) => {
    acquireCalls++;
    if (acquireCalls === 1) await gate;
    return originalAcquire(req);
  };

  // First outage: reconnects, then its jittered (R10) recovery notification fires and starts a
  // refresh that gets stuck on the gated first acquire() call.
  connection.api.disconnect('/repo');
  await flush();
  clock.tick(600);
  await flush();
  clock.tick(2_100); // past the up-to-2000ms recovery jitter
  await flush();
  assert.equal(connection.api.calls.filter((c) => c.method === 'listPermissions').length, before);
  assert.equal(acquireCalls, 1, 'the first notification must have started the gated refresh');

  // Second outage while the first refresh is still gated: its own recovery notification must not
  // be dropped, but it also must not start a second, concurrent refresh — only mark the gated one
  // to run again once it releases.
  connection.api.disconnect('/repo');
  await flush();
  clock.tick(600);
  await flush();
  clock.tick(2_100);
  await flush();
  assert.equal(connection.api.calls.filter((c) => c.method === 'listPermissions').length, before);
  assert.equal(acquireCalls, 1, "the second notification must not start a second concurrent refresh");

  release();
  await flush();
  assert.equal(connection.api.calls.filter((c) => c.method === 'listPermissions').length, before + 2);
});

test('U06(f): progress text from an oversized tool title is bounded to 200 chars', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  assert.equal(started.status, 'running');

  const progressed: string[] = [];
  const observing = engine.status(
    { sessionId: started.sessionId, waitSeconds: 5 },
    { signal: new AbortController().signal, progress: (message) => progressed.push(message) },
  );
  await flush();

  connection.api.emit('/repo', {
    type: 'message.part.updated',
    properties: {
      sessionID: started.sessionId,
      part: { type: 'tool', tool: 'bash', state: { status: 'running', title: 'x'.repeat(20_000) } },
    },
  });
  await flush();

  assert.ok(progressed.length > 0, 'expected at least one progress notification');
  for (const message of progressed)
    assert.ok(message.length <= 200, `progress message too long: ${message.length} chars`);

  clock.tick(5_000);
  await flush();
  await observing;
});

test('U06(g): a late message.updated for the previous turn\'s user does not suppress the grace', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 100, requestTimeoutMs: 100 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop', 'first'));
  };
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.content, 'first');

  connection.api.onPrompt = undefined;
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const replying = engine.reply({ sessionId: first.sessionId, prompt: 'second' }, ctx());
  await flush();

  // A late re-emission of the PREVIOUS turn's root user (id <= boundary) must not count as
  // evidence for this turn.
  connection.api.emit('/repo', {
    type: 'message.updated',
    properties: { sessionID: first.sessionId, info: { id: 'm1', role: 'user', time: { created: 0 } } },
  });
  await flush();
  await advance(clock, 500);

  const result = await replying;
  assert.equal(result.error?.name, 'SUBMISSION_UNCONFIRMED');
});

test('U06(g): a message.updated for this turn\'s new root user suppresses the no-user grace', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 100, requestTimeoutMs: 100 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(msg('m1', 'user'), msg('m2', 'assistant', 'm1', 'stop', 'first'));
  };
  const first = await engine.start({ prompt: 'first' }, ctx());
  assert.equal(first.content, 'first');

  connection.api.onPrompt = undefined;
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const replying = engine.reply({ sessionId: first.sessionId, prompt: 'second', waitSeconds: 0 }, ctx());
  await flush();

  // A message.updated for THIS turn's new root user (id > boundary) must suppress the grace,
  // even though the history read never independently observed it.
  connection.api.emit('/repo', {
    type: 'message.updated',
    properties: { sessionID: first.sessionId, info: { id: 'm3', role: 'user', time: { created: 0 } } },
  });
  await flush();
  await advance(clock, 500);
  await replying;

  const status = await engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.executionState, 'active');
  assert.equal(status.status, 'running');
});

test('U06(h): an observer with wait-seconds:0 does not block on a gated admission', async () => {
  const { connection, clock, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalWarm = connection.api.warmInstance.bind(connection.api);
  connection.api.warmInstance = async (directory, req) => {
    await gate;
    return originalWarm(directory, req);
  };

  const starting = engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await flush();

  const statusPromise = engine.status({ sessionId: 'ses_1', waitSeconds: 0 }, ctx());
  clock.tick(1);
  const observed = await statusPromise;
  assert.equal(observed.status, 'running');

  release();
  await starting;
});

test('U06(i): message.updated bursts are debounced to at most two reconciles', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 100_000 });
  connection.api.onPrompt = (id) => {
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, ctx());
  await flush();
  const before = connection.api.calls.filter((c) => c.method === 'sessionStatus').length;

  for (let i = 0; i < 30; i++) {
    connection.api.emit('/repo', {
      type: 'message.updated',
      properties: { sessionID: started.sessionId, info: { id: `noise_${i}`, role: 'assistant' } },
    });
    clock.tick(3);
    await flush();
  }
  clock.tick(250);
  await flush();

  const after = connection.api.calls.filter((c) => c.method === 'sessionStatus').length;
  assert.ok(after - before <= 2, `expected at most 2 reconciles, saw ${after - before}`);
});
