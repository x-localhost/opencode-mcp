// Spawned as a real, separate child process by managed-server.test.ts's hard-kill regression test
// (never imported in-process): starts a real managed `opencode serve` (the fake-opencode.mjs
// fixture) via startManagedServer, records the watchdog's pid and the fake-opencode.mjs process's
// own pid, then idles forever so the parent test can SIGKILL *this* process — simulating
// opencode-mcp itself being hard-killed (SIGKILL/crash/OOM) — and confirm the watchdog notices its
// parent is gone and reaps the orphaned managed process group on its own (P2 audit finding
// r2/g1-1), with no cooperation from this process possible at that point.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startManagedServer } from '../../../src/opencode/managed-server.ts';

import type { Logger } from '../../../src/types.ts';

const FAKE_BIN = fileURLToPath(new URL('../../fixtures/opencode/fake-opencode.mjs', import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`hardkill-helper: ${name} required`);
  }
  return v;
}

const shPidPath: string = requireEnv('HARDKILL_SH_PID_PATH');
const fakePidPath: string = requireEnv('HARDKILL_FAKE_PID_PATH');
const readyPath: string = requireEnv('HARDKILL_READY_PATH');

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

async function main(): Promise<void> {
  const server = await startManagedServer({
    bin: FAKE_BIN,
    serveArgs: [],
    cwd: '/tmp',
    env: { ...process.env, FAKE_OC_SELF_PID_PATH: fakePidPath } as Record<string, string>,
    startupTimeoutMs: 5000,
    logger: nullLogger(),
  });
  writeFileSync(shPidPath, String(server.pid));
  // Only now (after both pid files are guaranteed to exist) signal readiness to the parent test.
  writeFileSync(readyPath, 'ready');
  // Idle forever: the parent test SIGKILLs this exact process next. No further code in this
  // process ever runs again — everything from here on is the watchdog's own responsibility.
  setInterval(() => {}, 1 << 30);
}

void main();
