// In-process regression coverage for src/index.ts's shutdown path (review finding: a
// shutdownTimeoutMs bound on engine.shutdown() alone let main() close stdio and exit without ever
// reaching connection.close(), orphaning a detached `opencode serve` process). Unlike
// test/mcp/shutdown.test.ts (which spawns a real child process and exercises real signals/timers
// end to end), this file injects a FakeClock so both the engine.shutdown() bound and the
// connection.close() bound can be tripped deterministically without waiting on wall-clock time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../../src/index.ts';
import { realClock } from '../../src/core/clock.ts';
import { createConnection as createRealConnection } from '../../src/opencode/connection.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

import type { KeepAliveHandle } from '../../src/index.ts';
import type { Connection, Engine, EngineDeps } from '../../src/types.ts';

const FAKE_BIN = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));
chmodSync(FAKE_BIN, 0o755);

function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function notImplemented(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`stub ${name} should not be called by this test`);
  };
}

interface Harness {
  clock: FakeClock;
  signals: EventEmitter;
  stdin: EventEmitter;
  errors: EventEmitter;
  mainPromise: Promise<void>;
  closeCalls: () => number;
  exitCode: () => number | undefined;
}

function makeHarness(opts: {
  engineShutdown: (clock: FakeClock) => Promise<void>;
  connectionClose: (clock: FakeClock) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, main() derives shutdownTimeoutMs/connectionCloseTimeoutMs from config (the real
   * defaults being tested) instead of this harness's fixed 20000/15000 overrides.
   */
  useConfiguredTimeouts?: boolean;
  keepAlive?: () => KeepAliveHandle;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  /** Observes every exit(code) call, in addition to the harness's own exitCode() getter. */
  onExit?: (code: number) => void;
}): Harness {
  const clock = new FakeClock();
  const signals = new EventEmitter();
  const stdin = new EventEmitter();
  const errors = new EventEmitter();
  let closeCalls = 0;
  let exitCode: number | undefined;

  const stubConnection: Connection = {
    acquire: notImplemented('Connection.acquire'),
    current: () => undefined,
    invalidate: async () => {},
    onUnavailable: () => () => {},
    close: async () => {
      closeCalls += 1;
      await opts.connectionClose(clock);
    },
  };

  const stubEngine: Engine = {
    start: notImplemented('Engine.start'),
    reply: notImplemented('Engine.reply'),
    status: notImplemented('Engine.status'),
    statusMany: notImplemented('Engine.statusMany'),
    list: notImplemented('Engine.list'),
    cancel: notImplemented('Engine.cancel'),
    end: notImplemented('Engine.end'),
    output: notImplemented('Engine.output'),
    info: notImplemented('Engine.info'),
    shutdown: () => opts.engineShutdown(clock),
  };

  const mainPromise = main({
    env: opts.env ?? {},
    cwd: process.cwd(),
    clock,
    createConnection: async () => stubConnection,
    createEngine: async (_deps: EngineDeps) => stubEngine,
    createServerFactory: () => () => ({ server: { getClientCapabilities: () => undefined } }) as never,
    serveStdio: () => ({ close: async () => {} }),
    signals,
    stdin,
    errors,
    stdout: opts.stdout,
    stderr: opts.stderr,
    keepAlive: opts.keepAlive,
    exit: (code: number) => {
      exitCode = code;
      opts.onExit?.(code);
    },
    writeStderr: () => {},
    shutdownTimeoutMs: opts.useConfiguredTimeouts ? undefined : 20000,
    connectionCloseTimeoutMs: opts.useConfiguredTimeouts ? undefined : 15000,
  });

  return {
    clock,
    signals,
    stdin,
    errors,
    mainPromise,
    closeCalls: () => closeCalls,
    exitCode: () => exitCode,
  };
}

/** Lets every currently-pending microtask (promise `.then`/`await` continuation) run to
 * completion before the next assertion — a macrotask boundary (setImmediate) always drains the
 * whole microtask queue first. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('managed mode, onExit=abort (the harness default): connection.close() starts immediately in parallel with engine.shutdown, not only after it', async () => {
  // P2 fix (r2/g1-2): killing the managed process group is a stronger, faster execution fence
  // than engine.shutdown()'s own HTTP abort-and-poll loop, so it must start right away instead of
  // waiting out engine.shutdown first. makeHarness's default config (no OPENCODE_MCP_MODE/
  // OPENCODE_MCP_ON_EXIT override) is managed + onExit=abort, exactly where this applies.
  const h = makeHarness({
    engineShutdown: () => new Promise<void>(() => {}),
    connectionClose: async () => {},
  });
  await h.mainPromise;

  h.signals.emit('SIGTERM');
  await flush();
  assert.equal(h.closeCalls(), 1, 'connection.close() must start immediately, in parallel with engine.shutdown');
  assert.equal(h.exitCode(), undefined, 'must not exit yet: engine.shutdown itself is still hanging');

  h.clock.tick(20000); // trips engine.shutdown's own bound
  await flush();
  await flush();

  assert.equal(h.closeCalls(), 1, 'connection.close() must still be called exactly once');
  assert.equal(
    h.exitCode(),
    1,
    'an engine shutdown timeout must yield a non-zero exit despite close success',
  );
});

test('shutdown still exits within bounds even when both engine.shutdown and connection.close() hang forever, and exits 1', async () => {
  const h = makeHarness({
    engineShutdown: () => new Promise<void>(() => {}),
    connectionClose: () => new Promise<void>(() => {}),
  });
  await h.mainPromise;

  h.signals.emit('SIGTERM');
  await flush();

  assert.equal(
    h.closeCalls(),
    1,
    'connection.close() must have started immediately (managed mode, onExit=abort default)',
  );
  assert.equal(h.exitCode(), undefined);

  h.clock.tick(15000); // trips connection.close()'s own bound (started earlier, so this trips first)
  await flush();
  await flush();
  assert.equal(
    h.exitCode(),
    undefined,
    'must not exit yet: engine.shutdown itself is still hanging and has its own still-pending bound',
  );

  h.clock.tick(5000); // total 20000: trips engine.shutdown's own bound too
  await flush();
  await flush();

  assert.equal(
    h.exitCode(),
    1,
    'must exit within bounds but with a non-zero code, since both bounds tripped and the managed child ' +
      'may still be alive',
  );
});

test('shutdown is idempotent even under the double-hang scenario: a second signal does not call connection.close() twice', async () => {
  const h = makeHarness({
    engineShutdown: () => new Promise<void>(() => {}),
    connectionClose: async () => {},
  });
  await h.mainPromise;

  h.signals.emit('SIGTERM');
  h.signals.emit('SIGINT');
  await flush();

  h.clock.tick(20000);
  await flush();
  await flush();

  assert.equal(h.closeCalls(), 1);
  assert.equal(h.exitCode(), 1, 'an engine shutdown timeout must yield a non-zero exit');
});

test('a configured cleanupTimeoutMs above 20s is no longer truncated by a fixed engine.shutdown bound', async () => {
  const originalWrite = process.stderr.write;
  const stderrLines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    let engineShutdownResolvedAt: number | undefined;
    let connectionCloseCalledAt: number | undefined;

    const h = makeHarness({
      env: { OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS: '30' },
      useConfiguredTimeouts: true,
      engineShutdown: (clock) =>
        new Promise<void>((resolve) => {
          clock.schedule(25000, () => {
            engineShutdownResolvedAt = clock.now;
            resolve();
          });
        }),
      connectionClose: async (clock) => {
        connectionCloseCalledAt = clock.now;
      },
    });
    await h.mainPromise;

    h.signals.emit('SIGTERM');
    await flush();

    h.clock.tick(25000); // engine.shutdown resolves here; the old fixed 20000ms bound would have
    // already tripped by now and logged 'engine shutdown failed' instead.
    await flush();
    await flush();

    assert.equal(
      engineShutdownResolvedAt,
      25000,
      'engine.shutdown must be allowed to resolve at 25s of FakeClock time, not truncated at 20s',
    );
    assert.equal(h.closeCalls(), 1);
    assert.ok(
      connectionCloseCalledAt !== undefined && connectionCloseCalledAt === 0,
      'connection.close() must start immediately (managed mode, onExit=abort default), in parallel with ' +
        'engine.shutdown, not wait for it to finish',
    );
    assert.equal(h.exitCode(), 0);
    assert.ok(
      !stderrLines.some((l) => l.includes('engine shutdown failed')),
      `must not log 'engine shutdown failed' when engine.shutdown resolves within the configured window; got: ${JSON.stringify(stderrLines)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});

// Context-concurrency design §2: startup warns once when a profile sets `maxRunning` but no
// default model is configured (turns without a model obey only the global cap, never a per-model
// one). Same stderr-spy pattern as the cleanupTimeoutMs test above.
test('startup: a model profile with maxRunning and no default model logs exactly one warning', async () => {
  const originalWrite = process.stderr.write;
  const stderrLines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const h = makeHarness({
      env: { OPENCODE_MCP_MODEL_PROFILES: '{"corp/one":{"maxRunning":2}}' },
      engineShutdown: async () => {},
      connectionClose: async () => {},
    });
    await h.mainPromise;

    const warnLines = stderrLines.filter((line) =>
      line.includes('OPENCODE_MCP_MODEL_PROFILES sets maxRunning but OPENCODE_MCP_DEFAULT_MODEL is unset'));
    assert.equal(warnLines.length, 1, `expected exactly one warning line; got: ${JSON.stringify(stderrLines)}`);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('startup: no warning when a default model is configured, even with a maxRunning profile', async () => {
  const originalWrite = process.stderr.write;
  const stderrLines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const h = makeHarness({
      env: {
        OPENCODE_MCP_MODEL_PROFILES: '{"corp/one":{"maxRunning":2}}',
        OPENCODE_MCP_DEFAULT_MODEL: 'corp/one',
      },
      engineShutdown: async () => {},
      connectionClose: async () => {},
    });
    await h.mainPromise;

    assert.ok(
      !stderrLines.some((line) => line.includes('sets maxRunning but OPENCODE_MCP_DEFAULT_MODEL is unset')),
      `must not warn when a default model is configured; got: ${JSON.stringify(stderrLines)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('startup: no warning when no profile sets maxRunning', async () => {
  const originalWrite = process.stderr.write;
  const stderrLines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const h = makeHarness({
      env: { OPENCODE_MCP_MODEL_PROFILES: '{"corp/one":{"context":1000,"output":100}}' },
      engineShutdown: async () => {},
      connectionClose: async () => {},
    });
    await h.mainPromise;

    assert.ok(
      !stderrLines.some((line) => line.includes('sets maxRunning but OPENCODE_MCP_DEFAULT_MODEL is unset')),
      `must not warn when no profile sets maxRunning; got: ${JSON.stringify(stderrLines)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('an uncaught exception during shutdown escalates the exit code to 1', async () => {
  let resolveEngineShutdown: () => void = () => {};
  const h = makeHarness({
    engineShutdown: () =>
      new Promise<void>((resolve) => {
        resolveEngineShutdown = resolve;
      }),
    connectionClose: async () => {},
  });
  await h.mainPromise;

  h.errors.emit('uncaughtException', new Error('x'));
  await flush();

  // Managed mode, onExit=abort default: connection.close() starts immediately, in parallel with
  // engine.shutdown, not gated behind it (P2 fix r2/g1-2).
  assert.equal(h.closeCalls(), 1, 'connection.close() must start immediately, in parallel with engine.shutdown');
  assert.equal(h.exitCode(), undefined, 'must not exit yet: engine.shutdown itself is still running');

  // A fatal error during signal-triggered shutdown escalates the code without starting cleanup
  // again.
  h.errors.emit('uncaughtException', new Error('y'));
  await flush();
  assert.equal(h.closeCalls(), 1, 'connection.close() must still only ever be called once');

  resolveEngineShutdown();
  await flush();
  await flush();

  assert.equal(h.closeCalls(), 1, 'the original shutdown must still complete normally');
  assert.equal(h.exitCode(), 1, 'an uncaught exception must force a non-zero exit even though cleanup succeeded');
});

test('a rejected engine shutdown exits 1 even when connection.close succeeds', async () => {
  const h = makeHarness({
    engineShutdown: async () => {
      throw new Error('engine shutdown failed');
    },
    connectionClose: async () => {},
  });
  await h.mainPromise;

  h.signals.emit('SIGTERM');
  await flush();
  await flush();

  assert.equal(h.closeCalls(), 1);
  assert.equal(h.exitCode(), 1);
});

test('a fatal error during signal-triggered shutdown escalates the final exit code', async () => {
  let resolveEngineShutdown: () => void = () => {};
  const h = makeHarness({
    engineShutdown: () =>
      new Promise<void>((resolve) => {
        resolveEngineShutdown = resolve;
      }),
    connectionClose: async () => {},
  });
  await h.mainPromise;

  h.signals.emit('SIGTERM');
  await flush();
  h.errors.emit('unhandledRejection', new Error('fatal during shutdown'));
  resolveEngineShutdown();
  await flush();
  await flush();

  assert.equal(h.closeCalls(), 1);
  assert.equal(h.exitCode(), 1);
});

test("shutdown starts an injected keep-alive when it begins, and clears it just before exit()", async () => {
  let started = false;
  let cleared = false;
  let clearedBeforeExit: boolean | undefined;

  const keepAlive = (): KeepAliveHandle => {
    started = true;
    return {
      clear: () => {
        cleared = true;
      },
    };
  };

  const h = makeHarness({
    engineShutdown: async () => {},
    connectionClose: async () => {},
    keepAlive,
    onExit: () => {
      clearedBeforeExit = cleared;
    },
  });
  await h.mainPromise;

  assert.equal(started, false, 'the keep-alive must not start before shutdown begins');

  h.signals.emit('SIGTERM');
  await flush();
  await flush();

  assert.equal(started, true, 'the keep-alive must be started once shutdown begins');
  assert.equal(cleared, true, 'the keep-alive must be cleared before the process exits');
  assert.equal(clearedBeforeExit, true, 'the keep-alive must be cleared before exit() is called, not after');
  assert.equal(h.exitCode(), 0);
});

test('an emitted stdout EPIPE error is inert and does not trigger shutdown', async () => {
  const stdout = new EventEmitter();
  const h = makeHarness({
    engineShutdown: async () => {},
    connectionClose: async () => {},
    stdout,
  });
  await h.mainPromise;

  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => stdout.emit('error', epipe));
  await flush();

  assert.equal(h.closeCalls(), 0, 'an EPIPE on stdout must not start shutdown');
  assert.equal(h.exitCode(), undefined, 'an EPIPE on stdout must not exit the process');
});

// ---------------------------------------------------------------------------
// P2 fix (r2/g1-2), end-to-end with a REAL managed connection (not the inert stub above): a
// running turn's managed process group must be terminated early — well before a slow
// engine.shutdown (standing in for the real engine's up-to-~25s HTTP abort-and-poll loop) settles.
// ---------------------------------------------------------------------------

test('managed mode, onExit=abort (real connection): the managed process group is terminated early, well before a slow engine.shutdown settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocmcp-early-close-'));
  const pidPath = join(dir, 'self.pid');
  const signals = new EventEmitter();
  const stdin = new EventEmitter();
  const errors = new EventEmitter();
  let exitCode: number | undefined;
  let slowShutdownFinished = false;
  let capturedConnection: Connection | undefined;
  // Shared between main()'s own config loading (env option) and this test's createConnection
  // override (deps.env below) so the real managed child actually receives FAKE_OC_SELF_PID_PATH
  // — deps.env defaults to the real process.env, which is NOT what main() itself was given.
  const testEnv = {
    ...process.env,
    OPENCODE_MCP_OPENCODE_BIN: FAKE_BIN,
    OPENCODE_MCP_DEFAULT_CWD: '/tmp',
    FAKE_OC_SELF_PID_PATH: pidPath,
  };

  const mainPromise = main({
    env: testEnv,
    cwd: '/tmp',
    clock: realClock,
    // The real createConnection (real startManagedServer, real watchdog-wrapped FAKE_BIN child),
    // captured here only so the test itself can acquire a lease directly below (simulating an
    // already-running turn) — main()'s own shutdown path still goes through this exact instance.
    createConnection: async (config, logger, clock) => {
      const connection = createRealConnection(config, logger, clock, { env: testEnv });
      capturedConnection = connection;
      return connection;
    },
    createServerFactory: () => () => ({ server: { getClientCapabilities: () => undefined } }) as never,
    serveStdio: () => ({ close: async () => {} }),
    createEngine: async (_deps: EngineDeps): Promise<Engine> => ({
      start: notImplemented('Engine.start'),
      reply: notImplemented('Engine.reply'),
      status: notImplemented('Engine.status'),
      statusMany: notImplemented('Engine.statusMany'),
      list: notImplemented('Engine.list'),
      cancel: notImplemented('Engine.cancel'),
      end: notImplemented('Engine.end'),
      output: notImplemented('Engine.output'),
      info: notImplemented('Engine.info'),
      // Stands in for the real engine's up-to-~25s per-turn HTTP abort/poll loop with a
      // long-but-bounded real delay, deliberately decoupled from the connection: the point of
      // this test is that connection.close() must not wait for this to finish.
      shutdown: async () => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        slowShutdownFinished = true;
      },
    }),
    signals,
    stdin,
    errors,
    exit: (code: number) => {
      exitCode = code;
    },
    writeStderr: () => {},
  });

  try {
    // main()'s own promise resolves once setup (createConnection/createEngine, signal wiring)
    // completes — not once shutdown finishes (confirmed by every other test in this file, which
    // all await this before ever emitting a signal).
    await mainPromise;
    assert.ok(capturedConnection, 'createConnection must have run during setup');

    // Simulates "a delegated turn is running" (the P2 finding's own scenario): acquire the real
    // managed lease directly, spawning the real watchdog-wrapped FAKE_BIN child, before shutdown
    // ever begins.
    await capturedConnection!.acquire();

    await waitUntilReal(() => {
      try {
        return readFileSync(pidPath, 'utf-8').trim().length > 0;
      } catch {
        return false;
      }
    }, 5000);
    const childPid = Number(readFileSync(pidPath, 'utf-8').trim());
    await waitUntilReal(() => isAliveReal(childPid), 2000);

    signals.emit('SIGTERM');

    // The real managed child must be confirmed dead well before the artificial slow
    // engine.shutdown() finishes (4s) — proof the group kill started in parallel with
    // engine.shutdown, not only after it.
    await waitUntilReal(() => !isAliveReal(childPid), 3000);
    assert.equal(
      slowShutdownFinished,
      false,
      'the managed child died before the slow engine.shutdown settled: proves the group kill started early',
    );

    await waitUntilReal(() => exitCode !== undefined, 5000);
    assert.equal(exitCode, 0);
    assert.equal(slowShutdownFinished, true, 'engine.shutdown must still be awaited and allowed to finish');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
