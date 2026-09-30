// U15: closes MCP-layer contract gaps found by the r2/r3 audits:
// opencode-end's `action` and opencode-status's id-alias/wait-seconds are never checked as
// forwarded to the engine, and a stale notifications/cancelled for an already-returned call is
// never proven not to reach a live abort listener.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import type { RecordedCall } from './support/stub-engine.ts';

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

async function getCallLog(): Promise<RecordedCall[]> {
  const result = (await client.callTool('opencode-status', {})) as CallToolResultShape;
  const content = result.structuredContent?.content as string;
  return JSON.parse(content) as RecordedCall[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function abortedCount(): Promise<number> {
  return (await getCallLog()).filter((c) => c.tool === 'aborted').length;
}

// ---------------------------------------------------------------------------
// r3-r-tests-5: opencode-end's `action` and opencode-status's id/wait-seconds forwarding
// ---------------------------------------------------------------------------

test('opencode-end: action "archive" is forwarded to the engine, not silently defaulted to delete', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'to-archive' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  const ended = (await client.callTool('opencode-end', { sessionId, action: 'archive' })) as CallToolResultShape;
  assert.notEqual(ended.isError, true, JSON.stringify(ended));
  // A regression that stopped forwarding args.action would fall back to the stub's default
  // ('delete'), and this would read 'delete' instead.
  assert.equal(ended.structuredContent?.action, 'archive');

  const log = await getCallLog();
  const last = [...log].reverse().find((c) => c.tool === 'end');
  const args = last?.args as Record<string, unknown>;
  assert.equal(args.sessionId, sessionId);
  assert.equal(args.action, 'archive');
});

test('opencode-status: an id alias with wait-seconds records {sessionId, waitSeconds} at the engine', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'for-status' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  const result = (await client.callTool('opencode-status', {
    threadId: sessionId,
    'wait-seconds': 5,
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true, JSON.stringify(result));

  const log = await getCallLog();
  const last = [...log].reverse().find((c) => c.tool === 'status');
  const args = last?.args as Record<string, unknown>;
  // A regression that dropped `wait-seconds` or mis-resolved the threadId alias would leave this
  // undefined or pointing at the wrong session.
  assert.equal(args.sessionId, sessionId);
  assert.equal(args.waitSeconds, 5);
});

test('opencode-status: a conversationId alias with wait-seconds also reaches the engine unchanged', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'for-status-2' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  await client.callTool('opencode-status', { conversationId: sessionId, 'wait-seconds': 5 });

  const log = await getCallLog();
  const last = [...log].reverse().find((c) => c.tool === 'status');
  const args = last?.args as Record<string, unknown>;
  assert.equal(args.sessionId, sessionId);
  assert.equal(args.waitSeconds, 5);
});

// ---------------------------------------------------------------------------
// r2-r-tests-3: a stale cancellation for an already-returned call must never reach a live signal
// listener — proving the MCP layer's own cleanup (not engine diligence) is what protects this.
// ---------------------------------------------------------------------------

test('a stale notifications/cancelled for an already-returned immediate-recorder call records no abort', async () => {
  const baseline = await abortedCount();
  const { id, result } = client.callToolAsync('opencode', {
    prompt: JSON.stringify({ mode: 'immediate-recorder', content: 'ir' }),
  });
  const returned = (await result) as CallToolResultShape;
  assert.notEqual(returned.isError, true, JSON.stringify(returned));

  // The call has fully returned; the stub's own ctx.signal listener is deliberately still
  // attached (see stub-engine.ts), so this documents the end-to-end guarantee design.md §5.4
  // requires: a stale cancellation for an already-returned call must never reach a live listener.
  //
  // CAVEAT (verified, not just asserted): with the currently installed @modelcontextprotocol/sdk,
  // this specific assertion cannot be made to fail by any mutation local to src/mcp/tools.ts.
  // Removing createCallContext's `detachSignal()` call in cleanup() (src/mcp/tools.ts ~946) still
  // leaves this test green, because the SDK's own Protocol implementation
  // (node_modules/@modelcontextprotocol/server/dist/src-BHSMhZ_W.mjs, class field
  // `_requestHandlerAbortControllers`) deletes its own map entry for a request's id once that
  // request's handler settles (around the "if (this._requestHandlerAbortControllers.get(request.id)
  // === abortController) ... .delete(request.id)" line), strictly before a later
  // `notifications/cancelled` for that same id could ever reach `notification.params.requestId)
  // ?.abort(...)`. So `ctx.mcpReq.signal` itself can never fire 'abort' again for a completed
  // request, independent of tools.ts's own cleanup. The substantive regression coverage for this
  // contract (design.md §5.4 / r2-r-tests-3) is the *engine-level* test 'an owner controller
  // aborted after a wait-zero snapshot no longer stops the turn' in test/core/audit-u15.test.ts,
  // which does fail when turn.ts's own attach() listener removal is dropped. This MCP-level test
  // is kept because it documents the same observable guarantee end-to-end at the MCP layer, but
  // it is defense-in-depth, not an independent regression trap at this layer today.
  client.notify('notifications/cancelled', { requestId: id });
  await delay(150);
  assert.equal(await abortedCount(), baseline, 'a stale cancellation for a returned call must record no abort');
});
