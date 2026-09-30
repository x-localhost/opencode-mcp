import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import type { CallContext, Config, OcMessage } from '../../src/types.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const config = {
  defaultCwd: '/repo',
  allowedRoots: ['/repo'],
  remotePaths: true,
  defaultSandbox: 'workspace-write',
  defaultApprovalPolicy: 'never',
  turnTimeoutMs: 60_000,
  maxTurnTimeoutMs: 1_200_000,
  approvalTimeoutMs: 1_000,
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
  const engine = createEngine({
    config: { ...config, ...overrides },
    connection,
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { connection, clock, engine };
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
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) { clock.tick(Math.min(25, ms - elapsed)); await flush(); }
}

test('P0-1: 204 before runner, idle abort cannot certify stop or permit end deletion', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = () => {};
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  const result = await cancelling;
  assert.equal(result.executionState, 'unknown');
  assert.equal(result.cleanup, 'unconfirmed');
  const ending = engine.end({ sessionId: started.sessionId }, context());
  await flush();
  clock.tick(500);
  await flush();
  await assert.rejects(ending, {
    code: 'CLEANUP_UNCONFIRMED',
  });
  assert.equal(
    connection.api.calls.some((call) => call.method === 'deleteSession'),
    false,
  );
});

test('P0-1: late runner after 204 causes another abort and terminal evidence confirms stop', async () => {
  // U06 (critic-c-parallel-subagent-load-5): performStop now re-POSTs abort at most once per
  // ABORT_RETRY_MS (1000 ms) while the root stays busy, so this test needs a cleanupTimeoutMs
  // comfortably longer than that floor and clock ticks that actually cross it before the second
  // abort (and thus the terminal m02 evidence it triggers) can fire.
  const { connection, clock, engine } = setup({ cleanupTimeoutMs: 2_000 });
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.api.onAbort = () => {
    if (connection.api.histories.get(started.sessionId)?.some((item) => item.info.role === 'user')) {
      connection.api.histories.get(started.sessionId)!.push(message('m02', 'assistant', 'stop'));
    }
  };
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  connection.api.histories.get(started.sessionId)!.push(message('m01', 'user'));
  connection.api.statuses.set(started.sessionId, { type: 'busy' });
  connection.api.emit('/repo', {
    type: 'session.status',
    properties: {
      sessionID: started.sessionId,
      status: { type: 'busy' },
    },
  });
  clock.tick(100);
  await flush();
  // Cross the 1000 ms abort-retry floor from the first (unthrottled) abort at t≈0.
  clock.tick(1_000);
  await flush();
  const result = await cancelling;
  assert.equal(result.executionState, 'stopped');
  assert.ok(connection.api.calls.filter((call) => call.method === 'abort').length >= 2);
});

test('P0-1: finish before assistant completion does not prove stop', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  connection.api.onAbort = (id) => {
    const final = message('m02', 'assistant', 'stop');
    delete final.info.time.completed;
    connection.api.histories.get(id)!.push(final);
  };
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  await advance(clock, 600);
  const result = await cancelling;
  assert.equal(result.executionState, 'unknown');
  assert.equal(result.cleanup, 'unconfirmed');
});

test('P0-1: queued user with no execution evidence remains unconfirmed after abort', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
  };
  const started = await engine.start({ prompt: 'work', waitSeconds: 0 }, context());
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  await flush();
  assert.equal(
    connection.api.calls.some((call) => call.method === 'abort'),
    true,
  );
  await advance(clock, 500);
  const result = await cancelling;
  assert.equal(result.executionState, 'unknown');
  assert.equal(result.cleanup, 'unconfirmed');
});

test('P0-2: end waits for reserved reply admission and prevents its POST', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const started = await engine.start({ prompt: 'first' }, context());
  const original = connection.acquire.bind(connection);
  let release = () => {};
  let blockNext = true;
  connection.acquire = async (options) => {
    if (blockNext) {
      blockNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(options);
  };
  const replying = engine.reply({ sessionId: started.sessionId, prompt: 'second' }, context());
  await flush();
  const ending = engine.end({ sessionId: started.sessionId }, context());
  let ended = false;
  void ending.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  await flush();
  assert.equal(ended, false);
  release();
  await flush();
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
  await Promise.allSettled([replying, ending]);
  assert.equal(connection.api.calls.filter((call) => call.method === 'deleteSession').length, 1);
});

test('P0-3: stopped admission cannot POST after stalled boundary read resumes', async () => {
  const { connection, clock, engine } = setup();
  const original = connection.api.messages.bind(connection.api);
  let release = () => {};
  connection.api.messages = async (id, options) => {
    if (options?.limit === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(id, options);
  };
  const starting = engine.start({ prompt: 'work' }, context());
  await flush();
  const id = [...connection.api.sessions.keys()][0]!;
  const cancelling = engine.cancel({ sessionId: id }, context());
  await flush();
  clock.tick(500);
  await flush();
  release();
  await flush();
  assert.equal(
    connection.api.calls.some((call) => call.method === 'promptAsync'),
    false,
  );
  await Promise.allSettled([starting, cancelling]);
});

test('P0-4: shutdown closes connection when cleanup request never resolves', async () => {
  const { connection, clock, engine } = setup({ onExit: 'end' });
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  await engine.start({ prompt: 'work' }, context());
  connection.api.listPermissions = async () => new Promise(() => {});
  const shutdown = engine.shutdown('test');
  await flush();
  clock.tick(550);
  await flush();
  assert.equal(connection.closed, true);
  await shutdown;
});

test('P0-4: shutdown freezes a reserved reply before a late acquire can POST', async () => {
  const { connection, clock, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'), message('m02', 'assistant', 'stop'));
  };
  const started = await engine.start({ prompt: 'first' }, context());
  const original = connection.acquire.bind(connection);
  let release = () => {};
  let blockNext = true;
  connection.acquire = async (options) => {
    if (blockNext) {
      blockNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(options);
  };
  const replying = engine.reply({ sessionId: started.sessionId, prompt: 'second' }, context());
  await flush();
  const shutdown = engine.shutdown('test');
  await flush();
  clock.tick(550);
  await flush();
  assert.equal(connection.closed, true);
  release();
  await flush();
  await Promise.allSettled([replying, shutdown]);
  assert.equal(connection.api.calls.filter((call) => call.method === 'promptAsync').length, 1);
});

test('P1-6: cancelling during approval verification cannot send once', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const started = await engine.start(
    { prompt: 'work', waitSeconds: 0, approvalPolicy: 'on-request' },
    context(),
  );
  const permission = {
    id: 'per_1',
    sessionID: started.sessionId,
    permission: 'bash',
    patterns: ['echo'],
    metadata: {},
    always: ['*'],
  };
  connection.api.permissions.set(permission.id, permission);
  const original = connection.api.listPermissions.bind(connection.api);
  let release = () => {};
  let first = true;
  connection.api.listPermissions = async (directory) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(directory);
  };
  const observing = engine.status(
    { sessionId: started.sessionId, waitSeconds: 10 },
    {
      signal: new AbortController().signal,
      elicit: async () => ({ decision: 'allow' }),
    },
  );
  connection.api.emit('/repo', { type: 'permission.asked', properties: permission });
  await flush();
  const cancelling = engine.cancel({ sessionId: started.sessionId }, context());
  release();
  await flush();
  await Promise.all([observing, cancelling]);
  assert.equal(
    connection.api.calls.some((call) => call.method === 'replyPermission' && call.args[2] === 'once'),
    false,
  );
});

test('P1-7: assistant arriving between history and idle status wins reconciliation', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    connection.api.histories.get(id)!.push(message('m01', 'user'));
    connection.api.statuses.set(id, { type: 'busy' });
  };
  const original = connection.api.messages.bind(connection.api);
  let reads = 0;
  connection.api.messages = async (id, options) => {
    const page = await original(id, options);
    if (++reads === 2) {
      connection.api.histories.get(id)!.push(message('m02', 'assistant', 'stop'));
      connection.api.statuses.delete(id);
    }
    return page;
  };
  const result = await engine.start({ prompt: 'work' }, context());
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'done');
});

test('P2-13: start and reply accept waitSeconds above 600 within turn maximum', async () => {
  const { connection, engine } = setup();
  connection.api.onPrompt = (id) => {
    const history = connection.api.histories.get(id)!;
    const index = history.length + 1;
    history.push(message(`m0${index}`, 'user'), message(`m0${index + 1}`, 'assistant', 'stop'));
  };
  const started = await engine.start({ prompt: 'first', waitSeconds: 601 }, context());
  assert.equal(started.status, 'completed');
  const reply = await engine.reply(
    { sessionId: started.sessionId, prompt: 'second', waitSeconds: 601 },
    context(),
  );
  assert.equal(reply.status, 'completed');
  await assert.rejects(engine.status({ sessionId: started.sessionId, waitSeconds: 601 }, context()), {
    code: 'INVALID_ARGUMENT',
  });
});
