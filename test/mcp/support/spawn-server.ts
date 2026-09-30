import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

export interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  exitCode: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const FIXTURE_PATH = path.join(import.meta.dirname, '../fixtures/stub-server.ts');
const FIXTURE_PATH_NO_V03 = path.join(import.meta.dirname, '../fixtures/stub-server-no-v03.ts');

function spawnFixture(fixturePath: string, env: Record<string, string>): SpawnedServer {
  const child = spawn(process.execPath, [fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_MCP_LOG_LEVEL: 'error', ...env },
  }) as ChildProcessWithoutNullStreams;

  const exitCode = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, exitCode };
}

export function spawnStubServer(env: Record<string, string> = {}): SpawnedServer {
  return spawnFixture(FIXTURE_PATH, env);
}

/** v0.3 (F8): the injected engine lacks output/info/statusMany, for testing the "not available in
 * this build" fallback. */
export function spawnStubServerNoV03(env: Record<string, string> = {}): SpawnedServer {
  return spawnFixture(FIXTURE_PATH_NO_V03, env);
}
