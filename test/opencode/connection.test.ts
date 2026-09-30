import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConnection } from '../../src/opencode/connection.ts';
import { terminateProcessGroup as realTerminateProcessGroup } from '../../src/opencode/managed-server.ts';
import { EngineError } from '../../src/types.ts';
import { realClock } from '../../src/core/clock.ts';
import { baseConfig } from './support/base-config.ts';
import { makeFakeManagedServer, makeStubApi } from './support/fake-deps.ts';

import type { Logger, RequestOptions } from '../../src/types.ts';
import type { CreateOpencodeApiFn, StartManagedServerFn } from './support/fake-deps.ts';
import type { CreateOpencodeApiOptions } from '../../src/opencode/http.ts';
import type { StartManagedServerOptions } from '../../src/opencode/managed-server.ts';

const FAKE_BIN = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeRealTmpFile(name: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ocmcp-connection-'));
  return { path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitUntilReal(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntilReal timed out');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function isNonZombie(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false;
  }
}

test('U09 attach invalidation drops only the current lease and advances its generation', async () => {
  let healthCalls = 0;
  const connection = createConnection(baseConfig({ mode: 'attach', serverUrl: 'http://127.0.0.1:1' }), nullLogger(), realClock, {
    createOpencodeApi: () => makeStubApi(async () => ({ healthy: ++healthCalls > 0, version: 'v1' })),
  });
  const events: Array<{ generation: number; kind: string }> = [];
  connection.onUnavailable((generation, _error, kind) => events.push({ generation, kind }));
  const first = await connection.acquire();
  await connection.invalidate(first.generation + 1, 'unreachable');
  assert.equal(connection.current(), first);
  assert.equal(healthCalls, 1);
  await connection.invalidate(first.generation, 'unreachable');
  assert.equal(connection.current(), undefined);
  assert.deepEqual(events, [{ generation: 1, kind: 'unreachable' }]);
  const next = await connection.acquire();
  assert.equal(next.generation, 2);
  assert.equal(healthCalls, 2);
});

test('U09 managed invalidation waits for stop before declaring an exit or allowing reacquire', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  let releaseStop = () => {};
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: async () => {
      const handle = makeFakeManagedServer();
      if (handles.length === 0) {
        const original = handle.server.stop;
        handle.server.stop = async (graceMs?: number) => { await stopGate; await original(graceMs); };
      }
      handles.push(handle);
      return handle.server;
    },
    createOpencodeApi: () => makeStubApi(async () => ({ healthy: true, version: 'v1' })),
    processGroupGone: () => true,
  });
  const events: Array<{ generation: number; kind: string }> = [];
  connection.onUnavailable((generation, _error, kind) => events.push({ generation, kind }));
  const first = await connection.acquire();
  await connection.invalidate(first.generation + 1, 'hung');
  assert.equal(connection.current(), first);
  const invalidating = connection.invalidate(first.generation, 'hung');
  let reacquired = false;
  const nextLease = connection.acquire().then((lease) => { reacquired = true; return lease; });
  await Promise.resolve();
  assert.deepEqual(events, []);
  assert.equal(connection.current(), first);
  assert.equal(reacquired, false);
  releaseStop();
  await invalidating;
  assert.deepEqual(events, [{ generation: 1, kind: 'exited' }]);
  assert.equal(handles[0]?.stopCalls, 1);
  assert.equal(connection.current(), undefined);
  assert.equal((await nextLease).generation, 2);
});

test('U09 managed invalidation keeps its lease when the process group is still present', async () => {
  const handle = makeFakeManagedServer();
  let gone = false;
  const connection = createConnection(baseConfig({ cleanupTimeoutMs: 1 }), nullLogger(), realClock, {
    startManagedServer: async () => handle.server,
    createOpencodeApi: () => makeStubApi(async () => ({ healthy: true, version: 'v1' })),
    processGroupGone: () => gone,
  });
  const kinds: string[] = [];
  connection.onUnavailable((_generation, _error, kind) => kinds.push(kind));
  const first = await connection.acquire();
  await assert.rejects(connection.invalidate(first.generation, 'hung'), /group remains/);
  assert.equal(connection.current(), first);
  assert.deepEqual(kinds, []);
  gone = true;
  await connection.invalidate(first.generation, 'hung');
  assert.equal(connection.current(), undefined);
  assert.deepEqual(kinds, ['exited']);
});

test('managed mode: acquire() lazily starts the server on first use', async () => {
  let startCalls = 0;
  const startFn: StartManagedServerFn = async () => {
    startCalls += 1;
    return makeFakeManagedServer().server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: '1.18.33' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });
  assert.equal(startCalls, 0);

  const lease = await connection.acquire();
  assert.equal(startCalls, 1);
  assert.equal(lease.generation, 1);
  assert.equal(lease.version, '1.18.33');
});

test('managed mode: startManagedServer and createOpencodeApi receive the expected opts (password, env scrubbing, cwd, serveArgs, baseUrl) (r2-r-tests-11)', async () => {
  const handle = makeFakeManagedServer('http://127.0.0.1:9999');
  let capturedStartOpts: StartManagedServerOptions | undefined;
  const startFn: StartManagedServerFn = async (opts) => {
    capturedStartOpts = opts;
    return handle.server;
  };
  let capturedApiOptions: CreateOpencodeApiOptions | undefined;
  const createApiFn: CreateOpencodeApiFn = (options) => {
    capturedApiOptions = options;
    return makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  };

  const injectedEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'should-not-reach-child',
    OPENCODE_MCP_SOME_SETTING: 'should-not-reach-child',
    KEEP_ME: 'kept',
  };
  const config = baseConfig({ defaultCwd: '/tmp/some-project', serveArgs: ['--pure', '--extra'] });

  const connection = createConnection(config, nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    env: injectedEnv,
  });

  await connection.acquire();

  assert.ok(capturedStartOpts, 'startManagedServer must have been called');
  assert.ok(capturedApiOptions, 'createOpencodeApi must have been called');

  const password = capturedStartOpts!.env.OPENCODE_SERVER_PASSWORD;
  assert.equal(typeof password, 'string');
  assert.equal(password.length, 43, 'a base64url encoding of 32 random bytes is 43 chars (no padding)');
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    capturedApiOptions!.password,
    password,
    'the same password used to spawn the child must be used to authenticate to it',
  );

  assert.equal(capturedStartOpts!.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(capturedStartOpts!.env.OPENCODE_MCP_SOME_SETTING, undefined);
  assert.equal(capturedStartOpts!.env.KEEP_ME, 'kept');

  assert.equal(capturedStartOpts!.cwd, config.defaultCwd);
  assert.deepEqual(capturedStartOpts!.serveArgs, config.serveArgs);
  assert.equal(capturedApiOptions!.baseUrl, handle.server.url);
});

test('managed mode: a successful lease is cached; a second acquire() does not restart the server', async () => {
  let startCalls = 0;
  const startFn: StartManagedServerFn = async () => {
    startCalls += 1;
    return makeFakeManagedServer().server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });
  const lease1 = await connection.acquire();
  const lease2 = await connection.acquire();
  assert.equal(startCalls, 1);
  assert.equal(lease1, lease2);
});

test('managed mode: concurrent acquire() calls share one in-flight startup', async () => {
  let startCalls = 0;
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const startFn: StartManagedServerFn = async () => {
    startCalls += 1;
    await gate;
    return makeFakeManagedServer().server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  const p1 = connection.acquire();
  const p2 = connection.acquire();
  const p3 = connection.acquire();
  releaseStart();
  const [lease1, lease2, lease3] = await Promise.all([p1, p2, p3]);

  assert.equal(startCalls, 1);
  assert.equal(lease1, lease2);
  assert.equal(lease2, lease3);
});

test('managed mode: unexpected exit notifies onUnavailable with the dead generation; next acquire starts a new generation', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  // Fast no-op override: this test doesn't assert on the process-group sweep itself (see the
  // dedicated sweep tests below), and the real terminateProcessGroup's 5s grace period — now
  // genuinely awaited/ref'd elsewhere per R5 — would otherwise make this test needlessly slow.
  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {},
  });

  const notifications: Array<{ generation: number; message: string }> = [];
  connection.onUnavailable((generation, error) => {
    notifications.push({ generation, message: error.message });
  });

  const lease1 = await connection.acquire();
  assert.equal(lease1.generation, 1);

  handles[0]!.resolveExit({ code: 1, signal: null });
  // let the .then() microtask attached to `exited` run
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.generation, 1);
  assert.match(notifications[0]?.message ?? '', /exited unexpectedly/);

  const lease2 = await connection.acquire();
  assert.equal(lease2.generation, 2);
  assert.equal(handles.length, 2);
});

test('managed mode: an unexpected exit sweeps the leftover process group (TERM -> grace -> KILL) before notifying onUnavailable', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const terminateCalls: number[] = [];
  const terminateFn = async (pid: number): Promise<void> => {
    terminateCalls.push(pid);
  };

  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: terminateFn,
  });

  await connection.acquire();
  assert.deepEqual(terminateCalls, []);

  handles[0]!.resolveExit({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(terminateCalls, [handles[0]!.server.pid]);
});

test('managed mode: a failed process-group sweep after an unexpected exit is logged, not thrown', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug() {},
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warnings.push({ msg, fields });
    },
    error() {},
  };

  const connection = createConnection(baseConfig(), logger, realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {
      throw new Error('sweep failed');
    },
  });

  await connection.acquire();
  handles[0]!.resolveExit({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.msg, /process group/);
});

test('A3: an unexpected exit with a surviving descendant withholds the fence and rejects acquire while unconfirmed', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug() {},
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warnings.push({ msg, fields });
    },
    error() {},
  };

  // The descendant never confirms gone within the (short, test-only) cleanup bound.
  const connection = createConnection(baseConfig({ cleanupTimeoutMs: 50 }), logger, realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {},
    processGroupGone: () => false,
  });

  const events: Array<{ generation: number; kind: string }> = [];
  connection.onUnavailable((generation, _error, kind) => events.push({ generation, kind }));

  const lease1 = await connection.acquire();
  assert.equal(lease1.generation, 1);

  handles[0]!.resolveExit({ code: 1, signal: null });
  await Promise.resolve();
  await Promise.resolve();

  let reacquired = false;
  const nextLease = connection.acquire().then((lease) => {
    reacquired = true;
    return lease;
  }, (error: unknown) => error);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, [], 'no fence (or any loss) may be published while the sweep is still verifying');
  assert.equal(reacquired, false, 'reacquire must stay blocked while the group is unconfirmed');
  assert.equal(connection.current(), lease1);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(events, [{ generation: 1, kind: 'unreachable' }], 'unconfirmed loss must never be published as the exited fence');
  assert.equal(connection.current(), lease1, 'the dead generation stays "current" (unavailable) rather than being silently replaced');
  const resolved = await nextLease;
  assert.ok(resolved instanceof EngineError);
  assert.equal(resolved.code, 'OPENCODE_UNAVAILABLE');
  await assert.rejects(connection.acquire(), { code: 'OPENCODE_UNAVAILABLE' });
  assert.equal(handles.length, 1, 'no replacement server must have been started');
  assert.ok(
    warnings.some((w) => /process group/.test(w.msg) && /could not be confirmed/.test(w.msg)),
    'expected a warning naming the unconfirmed sweep',
  );
});

test('FY-1: a later acquire confirms a formerly live group, publishes one exited fence, and starts a new generation', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  let gone = false;
  let probes = 0;
  const connection = createConnection(baseConfig({ cleanupTimeoutMs: 1 }), nullLogger(), realClock, {
    startManagedServer: async () => {
      const handle = makeFakeManagedServer();
      handles.push(handle);
      return handle.server;
    },
    createOpencodeApi: () => makeStubApi(async () => ({ healthy: true, version: 'v1' })),
    terminateProcessGroup: async () => {},
    processGroupGone: () => { probes += 1; return gone; },
  });
  const events: string[] = [];
  connection.onUnavailable((_gen, _err, kind) => events.push(kind));
  await connection.acquire();
  handles[0]!.resolveExit({ code: 1, signal: null });
  await waitUntilReal(() => events.includes('unreachable'));
  const firstProbeCount = probes;
  await assert.rejects(connection.acquire(), { code: 'OPENCODE_UNAVAILABLE' });
  assert.ok(probes > firstProbeCount, 'each acquire must recheck the pending group');
  assert.deepEqual(events, ['unreachable']);
  assert.equal(handles.length, 1);

  gone = true;
  const next = await connection.acquire();
  assert.equal(next.generation, 2);
  assert.deepEqual(events, ['unreachable', 'exited']);
  assert.equal(handles.length, 2);
  await connection.acquire();
  assert.deepEqual(events, ['unreachable', 'exited']);
});

test('A3: an unexpected exit publishes the execution fence only once the process-group sweep actually confirms the group is gone', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  let gone = false;
  const connection = createConnection(baseConfig({ cleanupTimeoutMs: 500 }), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {},
    processGroupGone: () => gone,
  });

  const events: Array<{ generation: number; kind: string }> = [];
  connection.onUnavailable((generation, _error, kind) => events.push({ generation, kind }));

  const lease1 = await connection.acquire();
  handles[0]!.resolveExit({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, [], 'must not publish the fence while the descendant is still alive');
  assert.equal(connection.current(), lease1);

  gone = true; // the descendant finally dies (e.g. the sweep's own SIGKILL lands)
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(events, [{ generation: 1, kind: 'exited' }]);
  assert.equal(connection.current(), undefined);

  const lease2 = await connection.acquire();
  assert.equal(lease2.generation, 2);
  assert.equal(handles.length, 2);
});

test('A3 (real process): an unexpected exit fences only after every non-zombie descendant is gone', async () => {
  // The whole scenario (spawn, crash, sweep, timing assertions) is retried with a fresh process on
  // ANY failure: under full-suite parallel load this shared container's CPU/network stack
  // occasionally starves or resets/refuses a legitimate, already-listening socket for a few
  // seconds — unrelated to the A3 behaviour under test, which every retry re-exercises from
  // scratch against a brand-new real process. A genuine regression in the behaviour itself fails
  // the same way on every attempt, so it still fails this test after ATTEMPTS retries.
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const { path: pidPath, cleanup } = makeRealTmpFile('term-ignore.pid');
    const termReceivedPath = `${pidPath}.term-received`;
    const heartbeatPath = `${pidPath}.heartbeat`;
    const connection = createConnection(
      baseConfig({
        opencodeBin: FAKE_BIN,
        serveArgs: [],
        defaultCwd: '/tmp',
        startupTimeoutMs: 3000,
        cleanupTimeoutMs: 500,
      }),
      nullLogger(),
      realClock,
      {
        env: {
          ...process.env,
          FAKE_OC_MODE: 'crash-after',
          FAKE_OC_CRASH_AFTER_MS: '50',
          FAKE_OC_TERM_IGNORING_GRANDCHILD_PID_PATH: pidPath,
        },
        // Shortens the sweep's own grace period (default 5s) so this test stays fast, while still
        // exercising the real SIGTERM -> grace -> (best-effort) SIGKILL sequence against a real OS
        // process. After SIGKILL, the host may either reap the orphan promptly or retain a
        // zombie, so the assertions below accept either outcome while checking the fence.
        terminateProcessGroup: (pid, opts) => realTerminateProcessGroup(pid, { ...opts, graceMs: 150 }),
      },
    );

    const events: Array<{ generation: number; kind: string; liveAtPublication: boolean }> = [];
    connection.onUnavailable((generation, _error, kind) => {
      let grandchildPid = 0;
      try { grandchildPid = Number(readFileSync(pidPath, 'utf-8').trim()); } catch { /* not created yet */ }
      events.push({ generation, kind, liveAtPublication: grandchildPid > 0 && isNonZombie(grandchildPid) });
    });

    let lease1;
    try {
      lease1 = await connection.acquire();
    } catch (err) {
      cleanup();
      if (attempt === ATTEMPTS) throw err;
      continue;
    }

    try {
      assert.equal(lease1.generation, 1);

      await waitUntilReal(() => {
        try {
          return readFileSync(heartbeatPath, 'utf-8').trim().length > 0;
        } catch {
          return false;
        }
      }, 10_000);

      // Past the 50ms self-crash but well short of the 150ms SIGKILL grace: the grandchild is
      // still ignoring SIGTERM and no loss may be published yet.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(events, [], 'must not publish while the grandchild is still ignoring SIGTERM');

      // Generous bound: under heavy full-suite parallel load, scheduling this async chain
      // (terminateGroupFn's own grace wait, then the confirmation poll) can occasionally take
      // several seconds of wall-clock time even though it does very little actual work.
      await waitUntilReal(() => events.length > 0, 10_000);
      // SIGTERM did actually reach the grandchild (proof the real sweep ran).
      assert.equal(readFileSync(termReceivedPath, 'utf-8'), 'received');
      // (assert.deepEqual above narrowed `events` to never[]; re-widen it for the checks below.)
      const published = events as unknown as Array<{ generation: number; kind: string; liveAtPublication: boolean }>;
      assert.equal(published.length, 1);
      assert.equal(published[0]!.generation, 1);
      if (published[0]!.kind === 'unreachable') {
        // The first sweep did not verify the group before its deadline.
        assert.equal(connection.current(), lease1);
      } else {
        // Zombie-only groups are safe to fence, whether or not PID 1 has reaped them.
        assert.equal(published[0]!.kind, 'exited');
        assert.equal(published[0]!.liveAtPublication, false, 'exited published while a non-zombie member lived');
      }
      return;
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
    } finally {
      cleanup();
    }
  }
});

test('current() returns the live lease without starting a server, and is undefined before start / after close / after an unexpected exit', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  let startCalls = 0;
  const startFn: StartManagedServerFn = async () => {
    startCalls += 1;
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  // A fast no-op override: this test's own `close()` call now (correctly) awaits the unexpected
  // exit's process-group sweep (R5) — the real terminateProcessGroup's 5s grace period would make
  // this test needlessly slow without changing what it is actually asserting.
  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {},
  });

  assert.equal(connection.current(), undefined);
  assert.equal(startCalls, 0, 'current() must never start a server on its own');

  const lease = await connection.acquire();
  assert.equal(connection.current(), lease);
  assert.equal(startCalls, 1, 'current() after a real acquire() must not have started a second server');

  handles[0]!.resolveExit({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connection.current(), undefined);

  const lease2 = await connection.acquire();
  assert.equal(connection.current(), lease2);

  await connection.close();
  assert.equal(connection.current(), undefined);
});

test('attach mode: a malformed OPENCODE_MCP_SERVER_URL never echoes the value (it may itself carry credentials)', async () => {
  const synthetic = 'https://user:SYNTHETIC_SECRET@[';
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  const connection = createConnection(baseConfig({ mode: 'attach', serverUrl: synthetic }), nullLogger(), realClock, {
    createOpencodeApi: createApiFn,
  });

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'INVALID_ARGUMENT');
    assert.match(err.message, /OPENCODE_MCP_SERVER_URL/);
    assert.doesNotMatch(err.message, /SYNTHETIC_SECRET/);
    assert.doesNotMatch(err.message, /\[/, 'must not echo the raw value at all, not just redact the secret part');
    return true;
  });
});

test('onUnavailable returns an unsubscribe function', async () => {
  const handles: ReturnType<typeof makeFakeManagedServer>[] = [];
  const startFn: StartManagedServerFn = async () => {
    const handle = makeFakeManagedServer();
    handles.push(handle);
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  // Fast no-op override — see the comment on the previous test for why.
  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: async () => {},
  });

  let calls = 0;
  const unsubscribe = connection.onUnavailable(() => {
    calls += 1;
  });
  await connection.acquire();
  unsubscribe();
  handles[0]!.resolveExit({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 0);
});

test('managed mode: a startup failure rejects with EngineError OPENCODE_UNAVAILABLE; a later acquire retries', async () => {
  let attempt = 0;
  const startFn: StartManagedServerFn = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('boom: fake spawn failure');
    }
    return makeFakeManagedServer().server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    assert.match(err.message, /boom: fake spawn failure/);
    return true;
  });

  const lease = await connection.acquire();
  assert.equal(attempt, 2);
  assert.ok(lease.generation >= 2, 'a fresh generation is used for the retry, never reusing the failed one');
});

test('managed mode: a failed health check stops the freshly spawned child and rejects OPENCODE_UNAVAILABLE', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  const createApiFn: CreateOpencodeApiFn = () =>
    makeStubApi(async () => {
      throw new Error('connection refused');
    });

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    return true;
  });
  assert.equal(handle.stopCalls, 1);
});

test('managed mode: a health request that hangs is bounded by the remaining startup budget, not the full requestTimeoutMs (r2-r-adapter-3)', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  let capturedTimeoutMs: number | undefined;
  const createApiFn: CreateOpencodeApiFn = () => {
    const api = makeStubApi(async () => ({ healthy: true, version: 'v1' }));
    api.health = (req?: RequestOptions) =>
      new Promise((_resolve, reject) => {
        capturedTimeoutMs = req?.timeoutMs;
        const ms = req?.timeoutMs ?? 60_000;
        setTimeout(() => reject(new Error('health request timed out (simulated)')), ms);
      });
    return api;
  };

  const connection = createConnection(baseConfig({ startupTimeoutMs: 150, requestTimeoutMs: 5000 }), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
  });

  const startedAt = Date.now();
  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    return true;
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(capturedTimeoutMs !== undefined, 'the health request must be given an explicit bounded timeoutMs');
  assert.ok(
    capturedTimeoutMs! > 0 && capturedTimeoutMs! <= 150,
    `expected the health timeoutMs to be bounded by the remaining startup budget (<=150ms), got ${capturedTimeoutMs}`,
  );
  assert.ok(
    elapsed < 1000,
    `expected acquire() to reject within the startup budget (~150ms), not the 5000ms requestTimeoutMs, took ${elapsed}ms`,
  );
});

test('close() is idempotent and stops the managed child; a later acquire() rejects "connection closed"', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });
  await connection.acquire();

  await connection.close();
  await connection.close();
  assert.equal(handle.stopCalls, 1);

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    assert.match(err.message, /closed/);
    return true;
  });
});

test('close() called while a start is in flight stops the server once it comes up, and the pending acquire() rejects', async () => {
  const handle = makeFakeManagedServer();
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const startFn: StartManagedServerFn = async () => {
    await gate;
    return handle.server;
  };
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  const acquirePromise = connection.acquire();
  const closePromise = connection.close();
  releaseStart();

  await assert.rejects(() => acquirePromise, (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    return true;
  });
  await closePromise;
  assert.equal(handle.stopCalls, 1);
});

// ---------------------------------------------------------------------------
// R2/R5 (review round 2): close() must be memoized end-to-end, a pending managed startup
// must be cancellable so close() can reclaim its child immediately, and an outstanding
// unexpected-exit process-group sweep must be awaited by close(), not abandoned.
// ---------------------------------------------------------------------------

test('close() is memoized: concurrent callers share one promise that only resolves once real termination completes', async () => {
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stopCalls = 0;
  const server = {
    url: 'http://127.0.0.1:1',
    pid: 4242,
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}),
    async stop() {
      stopCalls += 1;
      await stopGate;
    },
  };
  const startFn: StartManagedServerFn = async () => server;
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  await connection.acquire();

  let firstResolved = false;
  let secondResolved = false;
  const p1 = connection.close().then(() => {
    firstResolved = true;
  });
  const p2 = connection.close().then(() => {
    secondResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firstResolved, false, 'close() must not resolve before stop() actually completes');
  assert.equal(secondResolved, false, 'a second concurrent close() must not resolve early either — it is the same promise');

  releaseStop();
  await Promise.all([p1, p2]);
  assert.equal(firstResolved, true);
  assert.equal(secondResolved, true);
  assert.equal(stopCalls, 1, 'stop() must be called exactly once even with concurrent close() callers');
});

test('close() during a pending managed startup aborts it immediately instead of waiting out the startup timeout', async () => {
  let sawAbort = false;
  const startFn: StartManagedServerFn = (opts) =>
    new Promise((_resolve, reject) => {
      // Simulates a startup stuck waiting for readiness: never settles on its own, only reacts to
      // the abort signal — exactly like the real startManagedServer's `aborted` race participant.
      opts.signal?.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('startup aborted (simulated)'));
      });
    });
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  const acquirePromise = connection.acquire();
  // Let acquire() actually invoke startFn and register its abort listener before closing.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const closeStartedAt = Date.now();
  await connection.close();
  const elapsed = Date.now() - closeStartedAt;

  assert.equal(sawAbort, true, 'close() must abort a managed startup that is still pending');
  assert.ok(elapsed < 2000, `close() must resolve promptly once the startup is aborted, took ${elapsed}ms`);
  await assert.rejects(() => acquirePromise, (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    return true;
  });
});

test('close() awaits an outstanding unexpected-exit process-group cleanup sweep before resolving', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  let releaseTerminate!: () => void;
  const terminateGate = new Promise<void>((resolve) => {
    releaseTerminate = resolve;
  });
  let terminateCalls = 0;
  const terminateFn = async (_pid: number): Promise<void> => {
    terminateCalls += 1;
    await terminateGate;
  };

  const connection = createConnection(baseConfig(), nullLogger(), realClock, {
    startManagedServer: startFn,
    createOpencodeApi: createApiFn,
    terminateProcessGroup: terminateFn,
  });

  await connection.acquire();
  handle.resolveExit({ code: 1, signal: null }); // fires the unexpected-exit sweep internally
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the .then() handler start terminateFn

  assert.equal(terminateCalls, 1);

  let closeResolved = false;
  const closePromise = connection.close().then(() => {
    closeResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeResolved, false, 'close() must wait for the outstanding group-cleanup sweep, not abandon it');

  releaseTerminate();
  await closePromise;
  assert.equal(closeResolved, true);
});

// ---------------------------------------------------------------------------
// F1 (review round 3): startup cancellation must stay in force through the health check,
// not just the spawn/readiness wait — close() must stop an already-spawned child promptly even
// while a slow (or effectively hung) health check is still running, not wait for it to settle.
// ---------------------------------------------------------------------------

test('close() stops an already-spawned child promptly during a slow health check, without waiting for it to finish (F1)', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  let releaseHealth: (() => void) | undefined;
  const healthGate = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const createApiFn: CreateOpencodeApiFn = () =>
    makeStubApi(async () => {
      await healthGate; // simulates a health check that would otherwise run for its full timeout.
      return { healthy: true, version: 'v1' };
    });

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  const acquirePromise = connection.acquire();
  // Let acquire() actually spawn the child and reach (and register ownership for) the health
  // check before closing.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const closeStartedAt = Date.now();
  await connection.close();
  const elapsed = Date.now() - closeStartedAt;

  assert.equal(handle.stopCalls, 1, 'close() must stop the already-spawned child without waiting for the health check');
  assert.ok(elapsed < 2000, `close() must resolve promptly during a slow health check, took ${elapsed}ms`);

  releaseHealth?.(); // let the abandoned startManaged() attempt settle so nothing leaks past this test.
  await assert.rejects(() => acquirePromise, (err: unknown) => {
    assert.ok(err instanceof EngineError);
    return true;
  });
});

test('close() aborts an in-flight health check via the combined signal (F1)', async () => {
  const handle = makeFakeManagedServer();
  const startFn: StartManagedServerFn = async () => handle.server;
  let healthAborted = false;
  const createApiFn: CreateOpencodeApiFn = () => {
    const api = makeStubApi(async () => ({ healthy: true, version: 'v1' }));
    // Overrides the stub's `health` with one that never settles on its own, only reacting to the
    // signal it is called with — proving close() actually threads its abort through to the
    // in-flight health request, not just to the spawn/readiness wait (matches the real
    // fetch-backed implementation in src/opencode/http.ts, which rejects when its signal aborts).
    api.health = (req?: RequestOptions) =>
      new Promise((_resolve, reject) => {
        req?.signal?.addEventListener('abort', () => {
          healthAborted = true;
          reject(new Error('health aborted (simulated)'));
        });
      });
    return api;
  };

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  const acquirePromise = connection.acquire();
  await new Promise((resolve) => setTimeout(resolve, 10));

  await connection.close();

  assert.equal(healthAborted, true, 'the health request must be aborted when close() runs, not left to run indefinitely');
  await assert.rejects(() => acquirePromise);
});

// ---------------------------------------------------------------------------
// r1-connection-managed-1: a failed health check must clear the stale stop handle it registered,
// so close() cannot resolve via it while skipping a concurrent, still-in-flight retry.
// ---------------------------------------------------------------------------

test('close() after a failed health check awaits a gated retry instead of resolving via the stale stop handle (r1-connection-managed-1)', async () => {
  const handle1 = makeFakeManagedServer();
  let attempt = 0;
  let releaseSecondStart!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecondStart = resolve;
  });
  const startFn: StartManagedServerFn = async () => {
    attempt += 1;
    if (attempt === 1) {
      return handle1.server;
    }
    await secondGate;
    throw new Error('gated startup rejected (simulated)');
  };
  const createApiFn: CreateOpencodeApiFn = () =>
    makeStubApi(async () => {
      throw new Error('unhealthy');
    });

  const connection = createConnection(baseConfig(), nullLogger(), realClock, { startManagedServer: startFn, createOpencodeApi: createApiFn });

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    return true;
  });
  assert.equal(handle1.stopCalls, 1, 'the first (unhealthy) child must have been stopped');

  const acquirePromise = connection.acquire(); // generation 2, startFn gated on secondGate
  await new Promise((resolve) => setTimeout(resolve, 10)); // let acquire() actually invoke startFn

  let closeResolved = false;
  const closePromise = connection.close().then(() => {
    closeResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    closeResolved,
    false,
    'close() must not resolve before the gated retry settles, even though a stale stop handle exists from the first (failed-health) attempt',
  );

  releaseSecondStart();
  await closePromise;
  assert.equal(closeResolved, true);
  await assert.rejects(() => acquirePromise);
});

// ---------------------------------------------------------------------------
// Attach mode
// ---------------------------------------------------------------------------

test('attach mode: a URL with userinfo is rejected as INVALID_ARGUMENT without ever calling createOpencodeApi', async () => {
  let apiCalls = 0;
  const createApiFn: CreateOpencodeApiFn = () => {
    apiCalls += 1;
    return makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  };
  const connection = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'https://user:pass@internal.example/oc' }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'INVALID_ARGUMENT');
    return true;
  });
  assert.equal(apiCalls, 0);
});

test('attach mode: a non-loopback http URL is rejected unless allowInsecureHttp is set', async () => {
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));

  const rejecting = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'http://oc.internal.example:4096', allowInsecureHttp: false }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );
  await assert.rejects(() => rejecting.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'INVALID_ARGUMENT');
    return true;
  });

  const allowed = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'http://oc.internal.example:4096', allowInsecureHttp: true }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );
  const lease = await allowed.acquire();
  assert.equal(lease.generation, 1);
});

test('attach mode: loopback http is allowed even without allowInsecureHttp, and generation is always 1', async () => {
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  const connection = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'http://127.0.0.1:4096', allowInsecureHttp: false }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );
  const lease1 = await connection.acquire();
  const lease2 = await connection.acquire();
  assert.equal(lease1.generation, 1);
  assert.equal(lease2.generation, 1);
});

test('attach mode: a health-check failure rejects OPENCODE_UNAVAILABLE and is retried on the next acquire()', async () => {
  let attempt = 0;
  const createApiFn: CreateOpencodeApiFn = () =>
    makeStubApi(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('refused');
      }
      return { healthy: true, version: 'v1' };
    });
  const connection = createConnection(baseConfig({ mode: 'attach', serverUrl: 'http://127.0.0.1:4096' }), nullLogger(), realClock, {
    createOpencodeApi: createApiFn,
  });

  await assert.rejects(() => connection.acquire(), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'OPENCODE_UNAVAILABLE');
    return true;
  });

  const lease = await connection.acquire();
  assert.equal(lease.generation, 1);
  assert.equal(attempt, 2);
});

test('attach mode: close() aborts an in-flight health check promptly, mirroring the managed-mode F1 fix (r1-connection-managed-4)', async () => {
  let healthAborted = false;
  const createApiFn: CreateOpencodeApiFn = () => {
    const api = makeStubApi(async () => ({ healthy: true, version: 'v1' }));
    // Never settles on its own, only reacts to the signal it is called with — proving close()
    // actually threads its abort through to an in-flight attach health request, not just the
    // managed path's.
    api.health = (req?: RequestOptions) =>
      new Promise((_resolve, reject) => {
        req?.signal?.addEventListener('abort', () => {
          healthAborted = true;
          reject(new Error('health aborted (simulated)'));
        });
      });
    return api;
  };
  const connection = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'http://127.0.0.1:4096' }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );

  const acquirePromise = connection.acquire();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const closeStartedAt = Date.now();
  await connection.close();
  const elapsed = Date.now() - closeStartedAt;

  assert.equal(healthAborted, true, 'close() must abort an in-flight attach health check, not wait out requestTimeoutMs');
  assert.ok(elapsed < 2000, `close() must resolve promptly during a hung attach health check, took ${elapsed}ms`);
  await assert.rejects(() => acquirePromise);
});

test('attach mode: https is accepted for a non-loopback host', async () => {
  const createApiFn: CreateOpencodeApiFn = () => makeStubApi(async () => ({ healthy: true, version: 'v1' }));
  const connection = createConnection(
    baseConfig({ mode: 'attach', serverUrl: 'https://oc.internal.example', allowInsecureHttp: false }),
    nullLogger(),
    realClock,
    { createOpencodeApi: createApiFn },
  );
  const lease = await connection.acquire();
  assert.equal(lease.generation, 1);
});
