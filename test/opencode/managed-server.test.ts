import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildServeEnv, processGroupGone, processGroupHasLiveMembersFromPs, startManagedServer, terminateProcessGroup } from '../../src/opencode/managed-server.ts';
import { baseConfig } from './support/base-config.ts';

import type { Logger } from '../../src/types.ts';

const FAKE_BIN = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));

test('FY-1: process table verification ignores zombies but keeps live group members', () => {
  const zombieOnly = ' 101 900 Z\n 102 900 Z+\n 103 901 S\n';
  assert.equal(processGroupHasLiveMembersFromPs(zombieOnly, 900), false);
  assert.equal(processGroupHasLiveMembersFromPs(`${zombieOnly} 104 900 S+\n`, 900), true);
});

test('FY-1: a live member of a test-owned process group withholds the fence', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const pid = child.pid!;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    assert.equal(await processGroupGone(pid), false);
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the test child already exited */ }
    await exited;
  }
});
chmodSync(FAKE_BIN, 0o755);

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      debug(msg) {
        lines.push(msg);
      },
      info() {},
      warn() {},
      error() {},
    },
  };
}

function warnCollectingLogger(): { logger: Logger; warnings: Array<{ msg: string; fields?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    warnings,
    logger: {
      debug() {},
      info() {},
      warn(msg, fields) {
        warnings.push({ msg, fields });
      },
      error() {},
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// buildServeEnv
// ---------------------------------------------------------------------------

test('buildServeEnv inherits the base env, scrubs sensitive prefixes/names, and sets credentials', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    ANTHROPIC_API_KEY: 'secret-anthropic',
    CLAUDE_SESSION: 'abc',
    CLAUDECODE: '1',
    AI_AGENT: 'claude',
    OPENCODE_MCP_SOME_SETTING: 'x',
    OPENCODE_SERVER_USERNAME: 'previous-user',
    OPENCODE_SERVER_PASSWORD: 'previous-pass',
    KEEP_ME: 'yes',
  };
  const env = buildServeEnv(base, baseConfig({ username: 'newuser' }), 'the-password');

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_SESSION, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.AI_AGENT, undefined);
  assert.equal(env.OPENCODE_MCP_SOME_SETTING, undefined);
  assert.equal(env.OPENCODE_SERVER_USERNAME, 'newuser');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'the-password');
});

test('buildServeEnv with a non-empty allowlist keeps only listed names/prefixes plus essentials', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    USER: 'x',
    LOGNAME: 'x',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    SHELL: '/bin/bash',
    TERM: 'xterm',
    CORP_TOKEN: 'keep',
    CORP_OTHER: 'keep2',
    RANDOM_UNRELATED: 'drop-me',
  };
  const env = buildServeEnv(base, baseConfig({ childEnvAllowlist: ['CORP_*'] }), 'pw');

  assert.equal(env.CORP_TOKEN, 'keep');
  assert.equal(env.CORP_OTHER, 'keep2');
  assert.equal(env.RANDOM_UNRELATED, undefined);
  for (const essential of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM']) {
    assert.equal(env[essential], base[essential as keyof typeof base], essential);
  }
});

test('buildServeEnv scrubs OPENCODE_SERVER_*/OPENCODE_MCP_* even if explicitly allowlisted', () => {
  const base = { PATH: '/usr/bin', OPENCODE_SERVER_PASSWORD: 'leaked', OPENCODE_MCP_FOO: 'leaked2' };
  const env = buildServeEnv(base, baseConfig({ childEnvAllowlist: ['OPENCODE_SERVER_*', 'OPENCODE_MCP_*'] }), 'pw');
  assert.equal(env.OPENCODE_MCP_FOO, undefined);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw'); // overwritten by our own credential, not the leaked value
});

test('buildServeEnv air-gap defaults are set only if unset, and models-fetch-disable is skipped when a models URL is configured', () => {
  const withoutOverrides = buildServeEnv({ PATH: '/usr/bin' }, baseConfig({ airgapDefaults: true }), 'pw');
  assert.equal(withoutOverrides.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(withoutOverrides.OPENCODE_DISABLE_SHARE, '1');
  assert.equal(withoutOverrides.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
  assert.equal(withoutOverrides.NPM_CONFIG_FETCH_RETRIES, '0');
  assert.equal(withoutOverrides.OPENCODE_DISABLE_MODELS_FETCH, '1');

  const withOverride = buildServeEnv(
    { PATH: '/usr/bin', OPENCODE_DISABLE_AUTOUPDATE: '0' },
    baseConfig({ airgapDefaults: true }),
    'pw',
  );
  assert.equal(withOverride.OPENCODE_DISABLE_AUTOUPDATE, '0');

  const withModelsUrl = buildServeEnv(
    { PATH: '/usr/bin', OPENCODE_MODELS_URL: 'https://internal/models.json' },
    baseConfig({ airgapDefaults: true }),
    'pw',
  );
  assert.equal(withModelsUrl.OPENCODE_DISABLE_MODELS_FETCH, undefined);
});

test('buildServeEnv without air-gap defaults does not set the disable flags', () => {
  const env = buildServeEnv({ PATH: '/usr/bin' }, baseConfig({ airgapDefaults: false }), 'pw');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, undefined);
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, undefined);
});

test('buildServeEnv drops undefined-valued base entries', () => {
  const base: Record<string, string | undefined> = { PATH: '/usr/bin', SOMETIMES_SET: undefined };
  const env = buildServeEnv(base as NodeJS.ProcessEnv, baseConfig(), 'pw');
  assert.equal('SOMETIMES_SET' in env, false);
});

// ---------------------------------------------------------------------------
// startManagedServer
// ---------------------------------------------------------------------------

function makeTmpFile(name: string): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ocmcp-managed-'));
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('startManagedServer resolves a ManagedServer that answers /global/health with Basic auth', async () => {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, OPENCODE_SERVER_USERNAME: 'mcp', OPENCODE_SERVER_PASSWORD: 'sekrit' } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger: nullLogger(),
  });
  try {
    assert.ok(server.url.startsWith('http://127.0.0.1:'));
    assert.ok(server.pid > 0);
    assert.ok(isAlive(server.pid));

    const auth = Buffer.from('mcp:sekrit', 'utf-8').toString('base64');
    const res = await fetch(`${server.url}/global/health`, { headers: { authorization: `Basic ${auth}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { healthy: boolean };
    assert.equal(body.healthy, true);

    const unauthed = await fetch(`${server.url}/global/health`);
    assert.equal(unauthed.status, 401);
  } finally {
    await server.stop();
  }
});

test('a different (wrong) listening URL is treated as a startup failure', async () => {
  await assert.rejects(
    () =>
      startManagedServer({
        bin: FAKE_BIN,
        serveArgs: [],
        cwd: '/tmp',
        env: { ...process.env, FAKE_OC_MODE: 'wrong-url' } as Record<string, string>,
        startupTimeoutMs: 3000,
        logger: nullLogger(),
      }),
    /unexpected URL/,
  );
});

test('startup timeout rejects and kills the child (the pid is confirmed gone afterwards)', async () => {
  const { path: pidPath, cleanup } = makeTmpFile('self.pid');
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        startManagedServer({
          bin: FAKE_BIN,
          serveArgs: [],
          cwd: '/tmp',
          env: {
            ...process.env,
            FAKE_OC_MODE: 'never-ready',
            FAKE_OC_SELF_PID_PATH: pidPath,
          } as Record<string, string>,
          startupTimeoutMs: 200,
          logger: nullLogger(),
        }),
      /did not report readiness/,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `expected a prompt rejection, took ${elapsed}ms`);

    await waitUntil(() => {
      try {
        return readFileSync(pidPath, 'utf-8').trim().length > 0;
      } catch {
        return false;
      }
    });
    const childPid = Number(readFileSync(pidPath, 'utf-8').trim());
    assert.equal(isAlive(childPid), false, 'the never-ready child must be killed after the startup timeout');
  } finally {
    cleanup();
  }
});

test('exit-early is a startup failure whose thrown message is generic — no stderr content, only a pointer to the server log', async () => {
  // A3 (review): raw opencode/OS stderr must never flow into the thrown Error's message, since it
  // becomes model-visible (EngineError -> the tool's ErrorResult.error.message). See the next test
  // for where the actual (redacted) detail goes instead.
  await assert.rejects(
    () =>
      startManagedServer({
        bin: FAKE_BIN,
        serveArgs: [],
        cwd: '/tmp',
        env: { ...process.env, FAKE_OC_MODE: 'exit-early', OPENCODE_SERVER_PASSWORD: 'super-secret-pw' } as Record<
          string,
          string
        >,
        startupTimeoutMs: 3000,
        logger: nullLogger(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /exited before becoming ready/);
      assert.match(err.message, /see server log/);
      assert.doesNotMatch(err.message, /super-secret-pw/);
      assert.doesNotMatch(err.message, /about to fail/, 'the raw stderr line text itself must not appear in the thrown message');
      return true;
    },
  );
});

test('exit-early: the recent stderr (password redacted) is logged via logger.warn, not thrown', async () => {
  const { logger, warnings } = warnCollectingLogger();
  await assert.rejects(() =>
    startManagedServer({
      bin: FAKE_BIN,
      serveArgs: [],
      cwd: '/tmp',
      env: { ...process.env, FAKE_OC_MODE: 'exit-early', OPENCODE_SERVER_PASSWORD: 'super-secret-pw' } as Record<
        string,
        string
      >,
      startupTimeoutMs: 3000,
      logger,
    }),
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.msg, /opencode startup failed/);
  const recentStderr = warnings[0]!.fields?.recentStderr as string;
  assert.match(recentStderr, /\[REDACTED\]/);
  assert.doesNotMatch(recentStderr, /super-secret-pw/);
});

test('stop() sends SIGTERM to the process group and resolves once the child (the watchdog) has exited', async () => {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger: nullLogger(),
  });
  assert.ok(isAlive(server.pid));
  const startedAt = Date.now();
  await server.stop(); // default graceMs=5000; the child must exit well before that on its own.
  const elapsed = Date.now() - startedAt;
  assert.equal(isAlive(server.pid), false);
  const result = await server.exited;
  // `server.pid`/`server.exited` now refer to the watchdog (/bin/sh), not the fake-opencode.mjs
  // process directly (P2 fix g1-1): a process-group-wide SIGTERM reaches the watchdog itself too,
  // but it traps TERM (forwards it to the real child, then `wait`s for it and exits with its
  // status) instead of being killed by the signal outright. POSIX `wait` reports a
  // signal-terminated child's status as 128+signum, so the watchdog's own (normal, non-signalled)
  // exit code is 128+15=143, not signal='SIGTERM'.
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
  // Regression: the grace-period timer races the child's own exit and must be cancelled when the
  // child wins, not left dangling (ref'd) for the rest of its 5s duration — otherwise stop()
  // resolving fast is fine, but the process/test run keeps needlessly alive for ~5s afterwards.
  assert.ok(elapsed < 2000, `expected stop() to resolve promptly (child exits on its own), took ${elapsed}ms`);
});

test('stop() is idempotent (safe to call more than once, concurrently or sequentially)', async () => {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger: nullLogger(),
  });
  await Promise.all([server.stop(), server.stop()]);
  await server.stop();
  assert.equal(isAlive(server.pid), false);
});

test('stop() kills the whole process group, including a grandchild the child spawned', async () => {
  const { path: pidPath, cleanup } = makeTmpFile('grandchild.pid');
  try {
    const server = await startManagedServer({
      bin: FAKE_BIN,
      serveArgs: [],
      cwd: '/tmp',
      env: { ...process.env, FAKE_OC_GRANDCHILD_PID_PATH: pidPath } as Record<string, string>,
      startupTimeoutMs: 3000,
      logger: nullLogger(),
    });

    await waitUntil(() => {
      try {
        return readFileSync(pidPath, 'utf-8').trim().length > 0;
      } catch {
        return false;
      }
    });
    const grandchildPid = Number(readFileSync(pidPath, 'utf-8').trim());
    assert.ok(isAlive(grandchildPid), 'grandchild should be alive before stop()');

    const terminatedPath = `${pidPath}.terminated`;
    await server.stop();

    assert.equal(isAlive(server.pid), false);
    // The grandchild's own SIGTERM handler writes this marker. We check for the marker (proof it
    // actually received the group-wide signal) rather than polling `kill(pid, 0)`: in a container
    // whose PID 1 never reaps re-parented orphans, a terminated grandchild can remain an unreaped
    // zombie whose pid still answers `kill(pid, 0)` indefinitely, which would make that check
    // meaningless here.
    await waitUntil(() => {
      try {
        return readFileSync(terminatedPath, 'utf-8') === 'terminated';
      } catch {
        return false;
      }
    }, 2000);
  } finally {
    cleanup();
  }
});

test('startManagedServer with a nonexistent bin rejects promptly with a clear error (never hangs)', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      startManagedServer({
        bin: '/definitely/does/not/exist/opencode-xyz',
        serveArgs: [],
        cwd: '/tmp',
        env: { ...process.env } as Record<string, string>,
        startupTimeoutMs: 3000,
        logger: nullLogger(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /failed to spawn opencode/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `expected a prompt rejection (no valid pid to wait on), took ${elapsed}ms`);
});

test('stop() SIGKILLs a TERM-ignoring process-group member even though the direct child exits promptly', async () => {
  const { path: pidPath, cleanup } = makeTmpFile('term-ignore.pid');
  const termReceivedPath = `${pidPath}.term-received`;
  const heartbeatPath = `${pidPath}.heartbeat`;
  try {
    const server = await startManagedServer({
      bin: FAKE_BIN,
      serveArgs: [],
      cwd: '/tmp',
      env: { ...process.env, FAKE_OC_TERM_IGNORING_GRANDCHILD_PID_PATH: pidPath } as Record<string, string>,
      startupTimeoutMs: 3000,
      logger: nullLogger(),
    });

    await waitUntil(() => {
      try {
        return readFileSync(heartbeatPath, 'utf-8').trim().length > 0;
      } catch {
        return false;
      }
    });

    // Short grace: the direct child (default SIGTERM disposition) dies almost immediately, well
    // before this elapses. Without the fix, `outcome === 'exited'` would skip SIGKILL entirely
    // and the grandchild would run forever.
    await server.stop(200);
    assert.equal(isAlive(server.pid), false);

    await waitUntil(() => {
      try {
        return readFileSync(termReceivedPath, 'utf-8') === 'received';
      } catch {
        return false;
      }
    });

    // Prove the grandchild is actually dead (SIGKILLed), not merely alive-but-ignoring-TERM: its
    // heartbeat counter must stop advancing. `kill(pid, 0)` is deliberately not used here — it can
    // keep succeeding against an unreaped zombie's table entry in a container that never reaps
    // re-parented orphans.
    const valueAfterStop = Number(readFileSync(heartbeatPath, 'utf-8').trim());
    await new Promise((r) => setTimeout(r, 200));
    const valueLater = Number(readFileSync(heartbeatPath, 'utf-8').trim());
    assert.equal(
      valueLater,
      valueAfterStop,
      'the TERM-ignoring process-group member must be dead (SIGKILLed) after stop(), not merely ignoring TERM while still alive',
    );
  } finally {
    cleanup();
  }
});

test('stdout/stderr lines are forwarded to logger.debug', async () => {
  const { logger, lines } = collectingLogger();
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger,
  });
  try {
    assert.ok(lines.some((l) => l.includes('opencode server listening on')));
  } finally {
    await server.stop();
  }
});

test('an unexpected exit after becoming ready is observable via the exited promise', async () => {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, FAKE_OC_MODE: 'crash-after', FAKE_OC_CRASH_AFTER_MS: '50' } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger: nullLogger(),
  });
  const result = await server.exited;
  assert.equal(result.code, 1);
  assert.equal(isAlive(server.pid), false);
});

test('the child is spawned with explicit --hostname/--port/--mdns=false, then serveArgs appended', async () => {
  const { path: argvPath, cleanup } = makeTmpFile('argv.json');
  try {
    const server = await startManagedServer({
      bin: FAKE_BIN,
      serveArgs: ['--pure'],
      cwd: '/tmp',
      env: { ...process.env, FAKE_OC_DUMP_ARGV_PATH: argvPath } as Record<string, string>,
      startupTimeoutMs: 3000,
      logger: nullLogger(),
    });
    try {
      const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[];
      const port = server.url.split(':').at(-1);
      assert.deepEqual(argv, ['serve', '--hostname', '127.0.0.1', '--port', port, '--mdns=false', '--pure']);
    } finally {
      await server.stop();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// r1-connection-managed-3: stdout must keep being drained (not paused) after readiness.
// ---------------------------------------------------------------------------

test('chatty stdout after readiness (>256 KiB across many lines) keeps being drained and logged; /global/health still answers', async () => {
  const { logger, lines } = collectingLogger();
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, FAKE_OC_MODE: 'chatty-stdout' } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger,
  });
  try {
    // The fixture writes 1000 post-readiness lines (>256 KiB total); wait for the last one to prove
    // stdout is still being read (and forwarded to logger.debug), not paused after the readiness
    // line as it was before the fix.
    await waitUntil(() => lines.some((l) => l.includes('post-readiness stdout line 999:')), 5000);

    const res = await fetch(`${server.url}/global/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { healthy: boolean };
    assert.equal(body.healthy, true);
    assert.ok(isAlive(server.pid), 'the child must not be wedged/dead after a burst of post-readiness stdout');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// r1-connection-managed-5: a missing/invalid cwd must give an actionable error, not a misleading
// "spawn <bin> ENOENT".
// ---------------------------------------------------------------------------

test('a nonexistent cwd gives an actionable error naming the cwd, not a misleading spawn ENOENT', async () => {
  const missingCwd = join(tmpdir(), `ocmcp-missing-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await assert.rejects(
    () =>
      startManagedServer({
        bin: FAKE_BIN,
        serveArgs: [],
        cwd: missingCwd,
        env: { ...process.env } as Record<string, string>,
        startupTimeoutMs: 3000,
        logger: nullLogger(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /managed OpenCode cwd does not exist or is not a directory/);
      assert.ok(err.message.includes(missingCwd), 'the error must name the actual missing cwd');
      assert.match(err.message, /OPENCODE_MCP_DEFAULT_CWD/);
      assert.doesNotMatch(err.message, /spawn/, 'must not surface as the misleading spawn ENOENT message');
      return true;
    },
  );
});

test('a cwd that exists but is a file (not a directory) is also rejected with the actionable error', async () => {
  const { path: filePath, cleanup } = makeTmpFile('not-a-directory');
  writeFileSync(filePath, 'not a directory');
  try {
    await assert.rejects(
      () =>
        startManagedServer({
          bin: FAKE_BIN,
          serveArgs: [],
          cwd: filePath,
          env: { ...process.env } as Record<string, string>,
          startupTimeoutMs: 3000,
          logger: nullLogger(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /managed OpenCode cwd does not exist or is not a directory/);
        assert.ok(err.message.includes(filePath));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// r1-connection-managed-2: the post-exit sweep must never signal a recycled pid and must skip the
// 5 s grace when the process group is already empty.
// ---------------------------------------------------------------------------

test('terminateProcessGroup on an already-empty process group resolves well under 5 s and never falls back to kill(pid)', async () => {
  // A short-lived, detached child (pgid === pid) that exits almost immediately and is reaped, so
  // its process group is empty by the time terminateProcessGroup runs — the common case connection.ts
  // hits after an unexpected exit (the direct child is already confirmed reaped before it calls
  // terminateProcessGroup at all).
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await waitUntil(() => !isAlive(pid), 2000);

  const calls: Array<{ target: number; signal: unknown }> = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((target: number, signal?: string | number) => {
    calls.push({ target, signal });
    return originalKill(target, signal);
  }) as typeof process.kill;

  try {
    const startedAt = Date.now();
    await terminateProcessGroup(pid);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 500, `expected an empty-group sweep to skip the 5s grace entirely, took ${elapsed}ms`);
  } finally {
    process.kill = originalKill;
  }

  const positiveCalls = calls.filter((c) => c.target === pid);
  assert.equal(positiveCalls.length, 0, 'must never fall back to kill(pid) (a positive pid) once the group is known empty');
  const groupProbes = calls.filter((c) => c.target === -pid);
  assert.ok(groupProbes.length >= 1, 'must probe the process group at least once (kill(-pid, 0))');
});

// ---------------------------------------------------------------------------
// P3 (audit findings r1-connection-managed-2 / r2/g1, loc 99 & 168): stop()/killAndWait must
// never fall back to signalling the bare (possibly-recycled) pid once the direct child is already
// reaped.
// ---------------------------------------------------------------------------

test('stop() after the child has already exited on its own never falls back to kill(pid) (only ever signals the group)', async () => {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, FAKE_OC_MODE: 'crash-after', FAKE_OC_CRASH_AFTER_MS: '20' } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger: nullLogger(),
  });
  await server.exited; // the watchdog (and the fake-opencode child it wraps) already exited/reaped.
  await waitUntil(() => !isAlive(server.pid), 2000);

  const calls: Array<{ target: number; signal: unknown }> = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((target: number, signal?: string | number) => {
    calls.push({ target, signal });
    return originalKill(target, signal);
  }) as typeof process.kill;

  try {
    await server.stop();
  } finally {
    process.kill = originalKill;
  }

  const positiveCalls = calls.filter((c) => c.target === server.pid);
  assert.equal(
    positiveCalls.length,
    0,
    'stop() must never signal the bare (reuse-risk) pid once the direct child is already reaped',
  );
});

// ---------------------------------------------------------------------------
// critic Q2: a long newline-less child output line must be capped, not buffered without bound.
// ---------------------------------------------------------------------------

test('a long newline-less stdout line is capped at 64 KiB, not buffered without bound, and the reader resyncs on the next line', async () => {
  const { logger, lines } = collectingLogger();
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, FAKE_OC_MODE: 'huge-line-stdout' } as Record<string, string>,
    startupTimeoutMs: 3000,
    logger,
  });
  try {
    await waitUntil(() => lines.some((l) => l.includes('huge-line-done')), 5000);
    const hugeLine = lines.find((l) => l.startsWith('XXXX'));
    assert.ok(hugeLine, 'the long line must still be forwarded (capped), not silently dropped entirely');
    assert.ok(hugeLine!.length <= 64 * 1024, `expected the line to be capped at 64 KiB, got ${hugeLine!.length}`);
    // Proves the reader resynced cleanly on the very next '\n' instead of getting stuck mid-drop.
    assert.ok(lines.some((l) => l === 'huge-line-done'), 'the line after the oversized one must be forwarded intact');
    assert.ok(isAlive(server.pid), 'the child must not be wedged/dead from the oversized line');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// P2 (audit findings r2/g1, loc 246 & 249): a hard-killed opencode-mcp must not orphan the
// managed `opencode serve` process (or the watchdog wrapping it).
// ---------------------------------------------------------------------------

test('hard-killing the managed-server owner leaves no orphan: the watchdog and the wrapped opencode both die within ~10s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocmcp-hardkill-'));
  const shPidPath = join(dir, 'sh.pid');
  const fakePidPath = join(dir, 'fake.pid');
  const readyPath = join(dir, 'ready');
  const helperPath = fileURLToPath(new URL('./support/hardkill-helper.ts', import.meta.url));

  const helper = spawn(process.execPath, [helperPath], {
    stdio: 'ignore',
    env: {
      ...process.env,
      HARDKILL_SH_PID_PATH: shPidPath,
      HARDKILL_FAKE_PID_PATH: fakePidPath,
      HARDKILL_READY_PATH: readyPath,
    },
  });

  try {
    await waitUntil(() => {
      try {
        return readFileSync(readyPath, 'utf-8') === 'ready';
      } catch {
        return false;
      }
    }, 8000);

    const shPid = Number(readFileSync(shPidPath, 'utf-8').trim());
    const fakePid = Number(readFileSync(fakePidPath, 'utf-8').trim());
    assert.ok(shPid > 0 && fakePid > 0);
    assert.ok(isAlive(shPid), 'the watchdog must be alive before the hard kill');
    assert.ok(isAlive(fakePid), 'the fake opencode process must be alive before the hard kill');

    // Simulates opencode-mcp itself being hard-killed (SIGKILL/crash/OOM): only the helper
    // process (which this test itself spawned) is ever signalled — never the watchdog or the
    // fake opencode process directly — so this genuinely exercises the watchdog noticing its
    // parent is gone on its own, not the test doing the watchdog's job for it.
    helper.kill('SIGKILL');

    // processGroupGone (not a bare isAlive/kill(pid,0) poll): sh and fake-opencode share one
    // process group (sh is the detached leader), and a container whose PID 1 never reaps
    // re-parented orphans can leave a terminated process as an unreaped zombie whose pid still
    // answers kill(pid,0) indefinitely — processGroupGone already tolerates that (see its own doc
    // comment and the "A3 (real process)" test in connection.test.ts for the same reasoning).
    const start = Date.now();
    while (!(await processGroupGone(shPid))) {
      if (Date.now() - start > 10_000) {
        throw new Error(`watchdog process group ${shPid} still has live (non-zombie) members after 10s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    // Best-effort cleanup only: never signals anything this test did not itself spawn (the
    // helper) or observe as that helper's own recorded pids.
    try {
      if (!helper.killed) helper.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    try {
      const shPid = Number(readFileSync(shPidPath, 'utf-8').trim());
      if (isAlive(shPid)) process.kill(-shPid, 'SIGKILL');
    } catch {
      /* file missing, unreadable, or the group is already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
