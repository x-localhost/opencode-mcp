import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { EventHub } from '../../src/core/hub.ts';
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
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 500,
  heartbeatMs: 100,
  statusPollMs: 100,
  sseStallMs: 1_000,
  cleanupTimeoutMs: 500,
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

function context(): CallContext {
  return { signal: new AbortController().signal };
}

function message(id: string, role: 'user' | 'assistant', finish?: string): OcMessage {
  return {
    info: {
      id,
      sessionID: 'ses_1',
      role,
      ...(role === 'assistant' ? { parentID: 'm01' } : {}),
      ...(finish ? { finish } : {}),
      time: { created: Number(id.slice(-2)), ...(finish ? { completed: 2 } : {}) },
    },
    parts: finish ? [{ id: `p_${id}`, sessionID: 'ses_1', messageID: id, type: 'text', text: 'done' }] : [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}

test('A: concurrent first admissions share one unabortable directory warm-up', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.api.warmInstance = async (directory, request) => {
    connection.api.calls.push({ method: 'warmInstance', args: [directory, request] });
    await gate;
    return { providerCatalog: {} };
  };
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const first = engine.start({ prompt: 'one', waitSeconds: 0 }, context());
  const second = engine.start({ prompt: 'two', waitSeconds: 0 }, context());
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'warmInstance').length, 1);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 2);
});

test('A: stop during warm-up waits for it and prevents POST', async () => {
  const { connection, engine } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let warms = 0;
  connection.api.warmInstance = async () => {
    warms++;
    await gate;
    return { providerCatalog: {} };
  };
  const starting = engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  await flush();
  assert.equal(warms, 1);
  const id = [...connection.api.sessions.keys()][0]!;
  const cancelling = engine.cancel({ sessionId: id }, context());
  let settled = false;
  void cancelling.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  release();
  const result = await cancelling;
  await starting;
  assert.equal(result.executionState, 'stopped');
  assert.equal(
    connection.api.calls.some((call) => call.method === 'promptAsync'),
    false,
  );
});

test('A: managed poison result disposes instance and updates hint', async () => {
  const { connection, engine, warnings } = setup();
  connection.api.onPrompt = (id) => {
    const user = message('m01', 'user');
    const failed = message('m02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(user, failed);
    connection.api.emit('/repo', {
      type: 'session.error',
      properties: {
        sessionID: id,
        error: failed.info.error,
      },
    });
  };
  const result = await engine.start({ prompt: 'work' }, context());
  assert.equal(result.error?.name, 'UnknownError');
  assert.equal(connection.api.calls.filter((call) => call.method === 'disposeInstance').length, 1);
  assert.match(result.hint, /instance was reset/i);
  assert.ok(warnings.some((warning) => warning.message.includes('instance')));
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m03', 'user'), message('m04', 'assistant', 'stop'));
  };
  assert.equal(
    (await engine.reply({ sessionId: result.sessionId, prompt: 'retry' }, context())).status,
    'completed',
  );
  assert.equal(connection.api.calls.filter((call) => call.method === 'warmInstance').length, 2);
});

test('A: failed warm-up retries, then every turn warms even across generations', async () => {
  const { connection, engine } = setup();
  let warms = 0;
  connection.api.warmInstance = async () => {
    warms++;
    if (warms === 1) throw new OpencodeHttpError('busy', 503, 'ServerError');
    return { providerCatalog: {} };
  };
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const next = history.length + 1;
    history.push(message(`m0${next}`, 'user'), message(`m0${next + 1}`, 'assistant', 'stop'));
  };
  await assert.rejects(engine.start({ prompt: 'first' }, context()), { code: 'OPENCODE_OVERLOADED' });
  assert.equal(
    connection.api.calls.some((call) => call.method === 'promptAsync'),
    false,
  );
  const sessionId = [...connection.api.sessions.keys()][0]!;
  assert.equal((await engine.reply({ sessionId, prompt: 'retry' }, context())).status, 'completed');
  assert.equal(warms, 2);
  assert.equal((await engine.reply({ sessionId, prompt: 'same generation' }, context())).status, 'completed');
  assert.equal(warms, 3);
  connection.unavailable();
  assert.equal((await engine.reply({ sessionId, prompt: 'new generation' }, context())).status, 'completed');
  assert.equal(warms, 4);
});

test('A: warm-up timeout releases a stopped admission without aborting warm-up', async () => {
  const { connection, clock, engine } = setup();
  let request: unknown;
  connection.api.warmInstance = async (_directory, req) => {
    request = req;
    return new Promise<{ providerCatalog: unknown }>(() => {});
  };
  const starting = engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  await flush();
  const id = [...connection.api.sessions.keys()][0]!;
  const cancelling = engine.cancel({ sessionId: id }, context());
  await flush();
  assert.equal(
    connection.api.calls.some((call) => call.method === 'promptAsync'),
    false,
  );
  clock.tick(1_000);
  await flush();
  assert.equal((await cancelling).status, 'cancelled');
  await starting;
  assert.deepEqual(request, { timeoutMs: 1_000 });
  assert.equal(
    connection.api.calls.some((call) => call.method === 'abort'),
    false,
  );
});

test('A: managed recovery waits while another owned turn is active in the directory', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const active = await engine.start({ prompt: 'long', waitSeconds: 0 }, context());
  connection.api.onPrompt = (id) => {
    const failed = message('m02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message('m01', 'user'), failed);
  };
  const failed = await engine.start({ prompt: 'poisoned' }, context());
  assert.equal(failed.error?.name, 'UnknownError');
  assert.equal(
    connection.api.calls.some((call) => call.method === 'disposeInstance'),
    false,
  );
  assert.match(failed.hint, /other active turns/i);
  await engine.cancel({ sessionId: active.sessionId }, context());
});

test('A: a hung instance disposal cannot hold the terminal result forever', async () => {
  const { connection, clock, engine } = setup();
  let disposalStarted = false;
  connection.api.disposeInstance = async () => {
    disposalStarted = true;
    return new Promise<boolean>(() => {});
  };
  connection.api.onPrompt = (id) => {
    const failed = message('m02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message('m01', 'user'), failed);
  };
  let settled = false;
  const pending = engine.start({ prompt: 'work' }, context());
  void pending.then(() => {
    settled = true;
  });
  for (let i = 0; i < 10 && !disposalStarted; i++) await flush();
  assert.equal(disposalStarted, true);
  await advance(clock, 500);
  assert.equal(settled, true);
  assert.match((await pending).hint, /recovery is pending/i);
});

test('A: attach mode explains poisoning without disposing a shared instance', async () => {
  const { connection, engine } = setup({ mode: 'attach' });
  connection.api.onPrompt = (id) => {
    const failed = message('m02', 'assistant');
    failed.info.error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
    connection.api.histories.get(id)!.push(message('m01', 'user'), failed);
  };
  const result = await engine.start({ prompt: 'work' }, context());
  assert.equal(result.error?.name, 'UnknownError');
  assert.equal(
    connection.api.calls.some((call) => call.method === 'disposeInstance'),
    false,
  );
  assert.match(result.hint, /administrator.*dispose|administrator.*restart/i);
});

test('A: fake models directory poisoning until dispose, while warm-up prevents it', async () => {
  const { connection } = setup();
  const api = connection.api;
  api.simulatePoisoning = true;
  const body = { parts: [{ type: 'text' as const, text: 'work' }] };
  const first = await api.createSession('/repo', { title: 'first' });
  api.modelResolutionPending.add('/repo');
  await api.promptAsync(first.id, body);
  await api.abort(first.id);
  const second = await api.createSession('/repo', { title: 'second' });
  await api.promptAsync(second.id, body);
  assert.equal(api.histories.get(second.id)?.at(-1)?.info.error?.name, 'UnknownError');
  await api.disposeInstance('/repo');
  const third = await api.createSession('/repo', { title: 'third' });
  await api.promptAsync(third.id, body);
  assert.equal(api.histories.get(third.id)?.at(-1)?.info.error, undefined);
  await api.warmInstance('/repo');
  api.modelResolutionPending.add('/repo');
  await api.abort(third.id);
  const fourth = await api.createSession('/repo', { title: 'fourth' });
  await api.promptAsync(fourth.id, body);
  assert.equal(api.histories.get(fourth.id)?.at(-1)?.info.error, undefined);
});

test('B1: compaction continuation outranks earlier session.error event', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const earlier = message('m02', 'assistant');
    earlier.info.error = { name: 'ContextOverflowError', data: { message: 'overflow' } };
    const summary = message('m03', 'assistant', 'stop');
    summary.info.summary = true;
    const final = message('m04', 'assistant', 'stop');
    connection.api.histories.get(id)!.push(message('m01', 'user'), earlier, summary, final);
    connection.api.emit('/repo', {
      type: 'session.error',
      properties: {
        sessionID: id,
        error: earlier.info.error,
      },
    });
  };
  const result = await engine.start({ prompt: 'work' }, context());
  assert.equal(result.status, 'completed');
  assert.equal(result.error, undefined);
});

test('B2: failed reply acquire leaves the prior terminal session reusable', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const next = history.length + 1;
    history.push(message(`m0${next}`, 'user'), message(`m0${next + 1}`, 'assistant', 'stop'));
  };
  const first = await engine.start({ prompt: 'one' }, context());
  const original = connection.acquire.bind(connection);
  let fail = true;
  connection.acquire = async (request) => {
    if (fail) {
      fail = false;
      throw new OpencodeHttpError('offline', 0, 'NetworkError');
    }
    return original(request);
  };
  await assert.rejects(engine.reply({ sessionId: first.sessionId, prompt: 'two' }, context()), {
    code: 'OPENCODE_UNAVAILABLE',
  });
  const reply = await engine.reply({ sessionId: first.sessionId, prompt: 'retry' }, context());
  assert.equal(reply.status, 'completed');
});

test('B2: failed start launch acquire leaves a tracked session with a failed first turn, still reusable', async () => {
  const { connection, engine } = setup();
  const original = connection.acquire.bind(connection);
  let calls = 0;
  connection.acquire = async (request) => {
    if (++calls === 2) throw new OpencodeHttpError('offline', 0, 'NetworkError');
    return original(request);
  };
  await assert.rejects(engine.start({ prompt: 'first' }, context()), { code: 'OPENCODE_UNAVAILABLE' });
  const tracked = (await engine.list()).sessions[0]!;
  assert.equal(tracked.status, 'failed');
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  assert.equal(
    (await engine.reply({ sessionId: tracked.sessionId, prompt: 'retry' }, context())).status,
    'completed',
  );
});

test('B3: shutdown with no live lease does not restart the server', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  await engine.start({ prompt: 'work' }, context());
  const original = connection.acquire.bind(connection);
  let acquires = 0;
  connection.acquire = async (request) => {
    acquires++;
    return original(request);
  };
  connection.unavailable();
  await engine.shutdown('test');
  assert.equal(acquires, 0);
  assert.equal(connection.closed, true);
});

test('B3: status and cancel on quarantine use no new lease after server loss', async () => {
  const { connection, clock, engine } = setup();
  connection.api.promptFailure = new OpencodeHttpError('lost', 0, 'NetworkError');
  const starting = engine.start({ prompt: 'work' }, context());
  await flush();
  await advance(clock, 250);
  const failed = await starting;
  assert.equal(failed.executionState, 'unknown');
  connection.unavailable('unreachable'); // An exited fence now releases this quarantine.
  const original = connection.acquire.bind(connection);
  let acquires = 0;
  connection.acquire = async (request) => {
    acquires++;
    return original(request);
  };
  assert.equal((await engine.status({ sessionId: failed.sessionId }, context())).executionState, 'unknown');
  assert.equal((await engine.cancel({ sessionId: failed.sessionId }, context())).executionState, 'unknown');
  assert.equal(acquires, 0);
});

test('B3: cancel during server loss does not abort through the stale lease', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  const original = connection.api.messages.bind(connection.api);
  let release = () => {};
  connection.api.messages = async (id, options) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(id, options);
  };
  connection.unavailable();
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  assert.equal(
    connection.api.calls.some((call) => call.method === 'abort'),
    false,
  );
  release();
  await cancelling;
});

test('B4: reconnect notification follows server.connected on the new stream', async () => {
  const { connection, clock, config } = setup();
  // R10: the recovery notification is now jittered by U(0, 2000ms) after the reconnect itself.
  // Inject a deterministic random (0) so the test only needs one extra tick to observe it, instead
  // of racing the default Math.random().
  const hub = new EventHub(connection, clock, config, undefined, () => 0);
  const events: string[] = [];
  const listener = hub.listen('/repo', await connection.acquire(), (event) => events.push(event.type));
  await listener.connected;
  await flush();
  events.length = 0;
  connection.api.disconnect('/repo');
  await flush();
  clock.tick(600);
  await flush();
  assert.ok(events.includes('server.connected'));
  // The recovery refresh is scheduled once the reconnect above completes; it needs its own tick.
  clock.tick(1);
  await flush();
  assert.equal(events.at(-1), 'hub.reconnected');
  listener.close();
  hub.close();
});

test('B4: a permission discovered during the SSE gap is handled on reconnect', async () => {
  const { connection, clock, engine } = setup({ statusPollMs: 30_000 });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.api.disconnect('/repo');
  await flush();
  const request = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(request.id, request);
  clock.tick(600);
  await flush();
  // R10: the recovery refresh that drives scanPending() is jittered by up to 2000ms after the
  // reconnect above completes (this test uses the engine's own hub, so it cannot inject a
  // deterministic random) — give it room to fire before checking for the reject.
  clock.tick(2_100);
  await flush();
  assert.ok(
    connection.api.calls.some(
      (call) => call.method === 'replyPermission' && call.args[1] === request.id && call.args[2] === 'reject',
    ),
  );
});

test('B5: terminal turn aborts elicitation and clears its deadline', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    { prompt: 'work', waitSeconds: 0, approvalPolicy: 'on-request' },
    context(),
  );
  const request = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(request.id, request);
  let signal: AbortSignal | undefined;
  const observing = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: new AbortController().signal,
      elicit: (_request, given) => {
        signal = given;
        return new Promise((_resolve, reject) => {
          given.addEventListener('abort', () => reject(new Error('closed')), { once: true });
        });
      },
    },
  );
  connection.api.emit('/repo', { type: 'permission.asked', properties: request });
  await flush();
  assert.ok(signal);
  connection.api.histories.get(started.sessionId)!.push(message('m02', 'assistant', 'stop'));
  connection.api.statuses.delete(started.sessionId);
  connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: started.sessionId } });
  await observing;
  assert.equal(signal.aborted, true);
  assert.equal(clock.pendingJobs(), 0);
});

test('B6: end treats a missing delete or archive target as already gone', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const first = await engine.start({ prompt: 'one' }, context());
  connection.api.sessions.delete(first.sessionId);
  const deleted = await engine.end({ sessionId: first.sessionId }, context());
  assert.equal(deleted.status, 'ended');
  assert.match(deleted.content, /no longer existed/i);
  const second = await engine.start({ prompt: 'two' }, context());
  connection.api.deleteSession = async () => {
    throw new OpencodeHttpError('missing', 404, 'NotFoundError');
  };
  const missingDelete = await engine.end({ sessionId: second.sessionId }, context());
  assert.equal(missingDelete.status, 'ended');
  assert.match(missingDelete.content, /no longer existed/i);
  const third = await engine.start({ prompt: 'three' }, context());
  connection.api.archiveSession = async () => {
    throw new OpencodeHttpError('missing', 404, 'NotFoundError');
  };
  const archived = await engine.end({ sessionId: third.sessionId, action: 'archive' }, context());
  assert.equal(archived.status, 'ended');
  assert.match(archived.content, /no longer existed/i);
});

test('B6: end keeps a session quarantined when delete fails with a server error', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const started = await engine.start({ prompt: 'work' }, context());
  connection.api.deleteSession = async () => {
    throw new OpencodeHttpError('upstream failed', 503, 'UnknownError');
  };
  await assert.rejects(engine.end({ sessionId: started.sessionId }, context()), {
    code: 'CLEANUP_UNCONFIRMED',
  });
  assert.equal(connection.api.sessions.has(started.sessionId), true);
  await assert.rejects(engine.reply({ sessionId: started.sessionId, prompt: 'again' }, context()), {
    code: 'SESSION_BUSY',
  });
});
