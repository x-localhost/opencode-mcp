import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';

let spawned: SpawnedServer;
let client: JsonRpcClient;

before(async () => {
  spawned = spawnStubServer();
  client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
});

after(async () => {
  spawned.child.kill('SIGKILL');
});

// v0.3 (F8) added opencode-output and opencode-info: seven tools now, not five.
test('smoke: initialize handshake succeeds and tools/list returns the seven tools', async () => {
  const { result } = client.request('tools/list', {});
  const res = (await result) as { tools: Array<{ name: string }> };
  const names = res.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'opencode',
    'opencode-cancel',
    'opencode-end',
    'opencode-info',
    'opencode-output',
    'opencode-reply',
    'opencode-status',
  ]);
});

test('smoke: opencode start returns an echoed content and a sessionId', async () => {
  const result = (await client.callTool('opencode', { prompt: 'hello there' })) as {
    structuredContent: { kind: string; status: string; content: string; sessionId: string };
  };
  assert.equal(result.structuredContent.kind, 'turn');
  assert.equal(result.structuredContent.status, 'completed');
  assert.equal(result.structuredContent.content, 'echo: hello there');
  assert.ok(result.structuredContent.sessionId.startsWith('ses_'));
});
