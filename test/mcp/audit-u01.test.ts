import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';

// U01: an `opencode` start call's progress notifications carry the session id the engine
// surfaces mid-call through ctx.setSessionId, the same way opencode-reply's are already prefixed.

interface CallToolResultShape {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

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

test('opencode: progress notifications from a start call are prefixed with the sessionId the engine sets mid-call', async () => {
  const token = 'tok-set-session-id';
  const before1 = client.notifications.length;
  const result = (await client.callTool(
    'opencode',
    { prompt: JSON.stringify({ mode: 'set-session-id', messages: ['a', 'b'], intervalMs: 1100 }) },
    token,
  )) as CallToolResultShape;
  assert.equal(result.structuredContent?.content, 'session-id-set');

  const progressNotifs = client.notifications
    .slice(before1)
    .filter((n) => n.method === 'notifications/progress')
    .map((n) => n.params as { message?: string });

  assert.ok(progressNotifs.length >= 1, `expected at least 1 progress notification, got ${progressNotifs.length}`);
  for (const n of progressNotifs) assert.match(n.message ?? '', /^ses_x: /);
});
