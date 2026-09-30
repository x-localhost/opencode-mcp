import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';

function countOccurrences(lines: string[], needle: string): number {
  return lines.filter((l) => l.includes(needle)).length;
}

test('SIGINT: engine.shutdown is called exactly once and the process exits 0', async () => {
  const spawned = spawnStubServer();
  const client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
  // Prove the server is actually up and serving before we ask it to shut down.
  await client.callTool('opencode', { prompt: JSON.stringify({ mode: 'immediate', content: 'ready' }) });

  spawned.child.kill('SIGINT');
  const { code, signal } = await spawned.exitCode;

  assert.equal(code, 0, `expected exit code 0, got code=${code} signal=${signal}`);
  assert.equal(countOccurrences(client.stderrLines, 'STUB_SHUTDOWN_CALLED'), 1);
  for (const line of client.rawStdoutLines) {
    assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
  }
});

test('stdin EOF: engine.shutdown is called exactly once and the process exits 0', async () => {
  const spawned = spawnStubServer();
  const client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
  await client.callTool('opencode', { prompt: JSON.stringify({ mode: 'immediate', content: 'ready' }) });

  spawned.child.stdin.end();
  const { code, signal } = await spawned.exitCode;

  assert.equal(code, 0, `expected exit code 0, got code=${code} signal=${signal}`);
  assert.equal(countOccurrences(client.stderrLines, 'STUB_SHUTDOWN_CALLED'), 1);
});

test('SIGINT followed immediately by SIGTERM still shuts down exactly once', async () => {
  const spawned = spawnStubServer();
  const client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
  await client.callTool('opencode', { prompt: JSON.stringify({ mode: 'immediate', content: 'ready' }) });

  spawned.child.kill('SIGINT');
  spawned.child.kill('SIGTERM');
  const { code } = await spawned.exitCode;

  assert.equal(code, 0);
  assert.equal(countOccurrences(client.stderrLines, 'STUB_SHUTDOWN_CALLED'), 1, 'shutdown must run only once');
});
