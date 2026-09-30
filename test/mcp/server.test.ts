import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient, waitFor } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import type { RecordedCall } from './support/stub-engine.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: string; additionalProperties?: boolean; properties: Record<string, unknown> };
  outputSchema: { type: string; required: string[] };
  annotations?: Record<string, unknown>;
}

interface CallToolResultShape {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let spawned: SpawnedServer;
let client: JsonRpcClient;
let tools: Tool[];

before(async () => {
  spawned = spawnStubServer();
  client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
  const { result } = client.request('tools/list', {});
  const res = (await result) as { tools: Tool[] };
  tools = res.tools;
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

async function isPending(promise: Promise<unknown>, quietMs = 80): Promise<boolean> {
  const sentinel = Symbol('pending');
  const raced = await Promise.race([promise.then(() => 'settled'), delay(quietMs).then(() => sentinel)]);
  return raced === sentinel;
}

async function abortedCount(): Promise<number> {
  return (await getCallLog()).filter((c) => c.tool === 'aborted').length;
}

async function waitForAbortedCount(target: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await abortedCount()) >= target) return;
    if (Date.now() > deadline) throw new Error(`waitForAbortedCount: timed out waiting for ${target}`);
    await delay(20);
  }
}

// ---------------------------------------------------------------------------
// tools/list shape
// ---------------------------------------------------------------------------

// v0.3 (F8) added opencode-output and opencode-info: seven tools now, not five (test/mcp/
// features-f8.test.ts owns the detailed schema coverage for the two new tools).
test('tools/list: exposes exactly the seven kebab-case tools', () => {
  const names = tools.map((t) => t.name).sort();
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

test('tools/list: every input schema is an object root that rejects unknown properties', () => {
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('tools/list: every output schema shares one object root requiring kind/status/content', () => {
  for (const tool of tools) {
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.deepEqual([...tool.outputSchema.required].sort(), ['content', 'kind', 'status'], tool.name);
  }
});

test('tools/list: descriptions are non-empty and under 2048 chars', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, tool.name);
    assert.ok(tool.description.length < 2048, tool.name);
  }
});

test('tools/list: annotations match design.md §4', () => {
  const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
  assert.equal(byName.get('opencode')?.destructiveHint, true);
  assert.equal(byName.get('opencode')?.openWorldHint, true);
  assert.equal(byName.get('opencode-reply')?.destructiveHint, true);
  assert.equal(byName.get('opencode-reply')?.openWorldHint, true);
  assert.equal(byName.get('opencode-status')?.readOnlyHint, false);
  assert.equal(byName.get('opencode-cancel')?.destructiveHint, true);
  assert.equal(byName.get('opencode-cancel')?.idempotentHint, true);
  assert.equal(byName.get('opencode-end')?.destructiveHint, true);
  assert.equal(byName.get('opencode-end')?.idempotentHint, true);
});

// ---------------------------------------------------------------------------
// Numeric bounds (design.md §4.1-§4.3)
// ---------------------------------------------------------------------------

test('opencode: timeout-seconds must be >= 1', async () => {
  const result = (await client.callTool('opencode', { prompt: 'x', 'timeout-seconds': 0 })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-reply: wait-seconds must be >= 0', async () => {
  const result = (await client.callTool('opencode-reply', {
    sessionId: 'ses_x',
    prompt: 'x',
    'wait-seconds': -1,
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-status: wait-seconds must be <= 600', async () => {
  const result = (await client.callTool('opencode-status', { 'wait-seconds': 601 })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-status: wait-seconds of exactly 600 is accepted by the schema', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'x' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-status', { sessionId, 'wait-seconds': 600 })) as CallToolResultShape;
  assert.notEqual(result.isError, true, JSON.stringify(result));
});

// ---------------------------------------------------------------------------
// Strict input schema enforcement at runtime
// ---------------------------------------------------------------------------

test('tools/call: an unknown input property is rejected without crashing the connection', async () => {
  const before1 = await getCallLog();
  const result = (await client.callTool('opencode', { prompt: 'x', bogus: 1 })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /bogus/);
  const after1 = await getCallLog();
  // rejected before reaching the handler: no new 'start' call recorded (only our two 'list' calls)
  assert.equal(after1.filter((c) => c.tool === 'start').length, before1.filter((c) => c.tool === 'start').length);
});

// ---------------------------------------------------------------------------
// Argument mapping (kebab-case wire -> camelCase Engine input)
// ---------------------------------------------------------------------------

test('opencode: maps every kebab-case argument to the Engine StartInput shape', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'ok' }),
    cwd: '/work/proj',
    model: 'anthropic/claude',
    agent: 'build',
    sandbox: 'read-only',
    'approval-policy': 'on-request',
    'base-instructions': 'base',
    'developer-instructions': 'dev',
    title: 'my title',
    'timeout-seconds': 120,
    'wait-seconds': 5,
  })) as CallToolResultShape;
  assert.equal(result.isError, undefined);

  const log = await getCallLog();
  const last = [...log].reverse().find((c) => c.tool === 'start');
  const args = last?.args as Record<string, unknown>;
  assert.equal(args.cwd, '/work/proj');
  assert.equal(args.model, 'anthropic/claude');
  assert.equal(args.agent, 'build');
  assert.equal(args.sandbox, 'read-only');
  assert.equal(args.approvalPolicy, 'on-request');
  assert.equal(args.baseInstructions, 'base');
  assert.equal(args.developerInstructions, 'dev');
  assert.equal(args.title, 'my title');
  assert.equal(args.timeoutSeconds, 120);
  assert.equal(args.waitSeconds, 5);
});

test('opencode-reply: maps arguments and resolves the sessionId alias', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'first' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  const result = (await client.callTool('opencode-reply', {
    threadId: sessionId,
    prompt: JSON.stringify({ mode: 'immediate', content: 'second' }),
    model: 'm2',
    agent: 'a2',
    'developer-instructions': 'dev2',
    'timeout-seconds': 30,
    'wait-seconds': 0,
  })) as CallToolResultShape;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.sessionId, sessionId);
  assert.equal(result.structuredContent?.content, 'second');

  const log = await getCallLog();
  const last = [...log].reverse().find((c) => c.tool === 'reply');
  const args = last?.args as Record<string, unknown>;
  assert.equal(args.sessionId, sessionId);
  assert.equal(args.model, 'm2');
  assert.equal(args.agent, 'a2');
  assert.equal(args.developerInstructions, 'dev2');
  assert.equal(args.timeoutSeconds, 30);
  assert.equal(args.waitSeconds, 0);
});

// ---------------------------------------------------------------------------
// Id alias rules
// ---------------------------------------------------------------------------

for (const tool of ['opencode-reply', 'opencode-cancel', 'opencode-end']) {
  test(`${tool}: rejects when no id alias is given`, async () => {
    const args: Record<string, unknown> = tool === 'opencode-reply' ? { prompt: 'x' } : {};
    const result = (await client.callTool(tool, args)) as CallToolResultShape;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error && (result.structuredContent.error as { name: string }).name, 'INVALID_ARGUMENT');
  });

  test(`${tool}: rejects two id aliases, even with identical values`, async () => {
    const args: Record<string, unknown> =
      tool === 'opencode-reply'
        ? { prompt: 'x', sessionId: 'ses_1', threadId: 'ses_1' }
        : { sessionId: 'ses_1', threadId: 'ses_1' };
    const result = (await client.callTool(tool, args)) as CallToolResultShape;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent?.error as { name: string })?.name, 'INVALID_ARGUMENT');
  });

  test(`${tool}: accepts conversationId as an alias`, async () => {
    // First create a real session so the alias resolves to something the stub engine knows.
    const started = (await client.callTool('opencode', {
      prompt: JSON.stringify({ mode: 'immediate', content: 'alias-setup' }),
    })) as CallToolResultShape;
    const sessionId = started.structuredContent?.sessionId as string;
    const args: Record<string, unknown> =
      tool === 'opencode-reply'
        ? { prompt: JSON.stringify({ mode: 'immediate', content: 'via-alias' }), conversationId: sessionId }
        : { conversationId: sessionId };
    const result = (await client.callTool(tool, args)) as CallToolResultShape;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent?.sessionId, sessionId);
  });
}

test('opencode-status: no id lists tracked sessions instead of erroring', async () => {
  const result = (await client.callTool('opencode-status', {})) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'sessions');
});

test('opencode-status: two ids is INVALID_ARGUMENT, not list mode', async () => {
  const result = (await client.callTool('opencode-status', { sessionId: 'a', threadId: 'b' })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'INVALID_ARGUMENT');
});

test('opencode-end: an oversized sessionId is rejected by the input schema (R6), never reaches the engine or the formatter', async () => {
  const oversized = 'x'.repeat(50_000);
  const result = (await client.callTool('opencode-end', { sessionId: oversized })) as CallToolResultShape;
  // Strict-schema violations are returned before the handler runs (docs/sdk-notes.md): isError
  // with a plain validation-error text and no structuredContent at all.
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0]?.text ?? '', /Input validation error/);
  assert.ok((result.content[0]?.text ?? '').length < 1000, 'the rejection itself must not echo the oversized id');
});

// ---------------------------------------------------------------------------
// Progress notifications
// ---------------------------------------------------------------------------

test('opencode: progress notifications carry the progressToken with strictly increasing progress', async () => {
  const token = 'tok-1';
  const before1 = client.notifications.length;
  const result = (await client.callTool(
    'opencode',
    { prompt: JSON.stringify({ mode: 'progress', messages: ['a', 'b', 'c'], intervalMs: 1100, content: 'done' }) },
    token,
  )) as CallToolResultShape;
  assert.equal(result.structuredContent?.content, 'done');

  const progressNotifs = client.notifications
    .slice(before1)
    .filter((n) => n.method === 'notifications/progress')
    .map((n) => n.params as { progressToken: unknown; progress: number; message?: string });

  assert.ok(progressNotifs.length >= 2, `expected at least 2 progress notifications, got ${progressNotifs.length}`);
  for (const n of progressNotifs) assert.equal(n.progressToken, token);
  for (let i = 1; i < progressNotifs.length; i += 1) {
    assert.ok((progressNotifs[i]?.progress ?? 0) > (progressNotifs[i - 1]?.progress ?? 0), 'progress must strictly increase');
  }
});

test('opencode-reply: progress messages are prefixed with the already-known sessionId', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'setup' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  const token = 'tok-2';
  const before1 = client.notifications.length;
  await client.callTool(
    'opencode-reply',
    { sessionId, prompt: JSON.stringify({ mode: 'progress', messages: ['x', 'y'], intervalMs: 1100 }) },
    token,
  );
  const progressNotifs = client.notifications
    .slice(before1)
    .filter((n) => n.method === 'notifications/progress')
    .map((n) => n.params as { message?: string });
  assert.ok(progressNotifs.length >= 1);
  for (const n of progressNotifs) assert.match(n.message ?? '', new RegExp(`^${sessionId}: `));
});

test('opencode: progress notifications stop immediately once the call is cancelled (B1), even though the turn keeps running', async () => {
  const token = 'tok-cancel-progress';
  const before = client.notifications.length;
  const { id, result } = client.callToolAsync(
    'opencode',
    { prompt: JSON.stringify({ mode: 'progress', messages: ['a', 'b', 'c', 'd'], intervalMs: 1100 }) },
    token,
  );

  await waitFor(() => client.notifications.slice(before).some((n) => n.method === 'notifications/progress'));
  const countAtFirstProgress = client.notifications.slice(before).filter((n) => n.method === 'notifications/progress').length;
  assert.equal(countAtFirstProgress, 1);

  client.notify('notifications/cancelled', { requestId: id });

  // The stub engine's 'progress' script mode does not check ctx.signal itself and keeps sending
  // through its whole scripted message list ('b'/'c'/'d' would arrive at roughly +1.1s/+2.2s/+3.3s
  // if the sink were still live) — wait past all of them.
  await delay(3800);
  const countAfterWait = client.notifications.slice(before).filter((n) => n.method === 'notifications/progress').length;

  assert.equal(countAfterWait, 1, 'no further notifications/progress may be sent once the call is cancelled');
  assert.equal(await isPending(result, 200), true, 'server must not respond to a cancelled request either');
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('opencode: notifications/cancelled aborts ctx.signal for the owning call while running', async () => {
  const baseline = await abortedCount();
  const { id, result } = client.callToolAsync('opencode', {
    prompt: JSON.stringify({ mode: 'hang-signal' }),
  });
  // Make sure the call has actually reached the handler before cancelling it.
  await delay(50);
  client.notify('notifications/cancelled', { requestId: id });

  // Per the MCP cancellation spec ("the receiver SHOULD NOT send a response for the cancelled
  // request"), the original tools/call response must never arrive; observe the abort itself
  // through a separate, uncancelled request instead (the stub engine's call log).
  await waitForAbortedCount(baseline + 1);
  assert.equal(await isPending(result, 200), true, 'server must not respond to a cancelled request');
});

test('opencode: cancelling a request after it already returned does nothing to other calls', async () => {
  // Capture the id of a call that has already fully completed.
  const quick = client.callToolAsync('opencode', { prompt: JSON.stringify({ mode: 'immediate', content: 'q2' }) });
  await quick.result;

  const baseline = await abortedCount();
  const hanging = client.callToolAsync('opencode', { prompt: JSON.stringify({ mode: 'hang-signal' }) });
  await delay(50);

  // A stale cancellation for the already-completed request must not affect the still-running one.
  client.notify('notifications/cancelled', { requestId: quick.id });
  await delay(150);
  assert.equal(await abortedCount(), baseline, 'a stale cancellation must not abort an unrelated call');
  assert.equal(await isPending(hanging.result), true, 'the unrelated in-flight call must be unaffected');

  // Prove the hanging call still cancels normally afterwards.
  client.notify('notifications/cancelled', { requestId: hanging.id });
  await waitForAbortedCount(baseline + 1);
  assert.equal(await isPending(hanging.result, 200), true, 'server must not respond to a cancelled request');
});

// ---------------------------------------------------------------------------
// Elicitation round trip
// ---------------------------------------------------------------------------

test('opencode-cancel via hang-cancel session: cancel resolves the pending start call', async () => {
  const { result: startResult } = client.callToolAsync('opencode', {
    prompt: JSON.stringify({ mode: 'hang-cancel' }),
  });
  // Give the handler a moment to register the session before we look it up.
  await delay(50);

  // StartInput carries no sessionId back to the caller until the turn resolves, so recover the
  // freshly created session id from the tracked-sessions listing instead.
  const listed = (await client.callTool('opencode-status', {})) as CallToolResultShape;
  const sessions = (listed.structuredContent?.sessions as Array<{ sessionId: string }>) ?? [];
  const sessionId = sessions[sessions.length - 1]?.sessionId;
  assert.ok(sessionId, 'expected a tracked session to cancel');

  const cancelResult = (await client.callTool('opencode-cancel', { sessionId: sessionId as string })) as CallToolResultShape;
  assert.equal(cancelResult.structuredContent?.status, 'cancelled');
  assert.equal(cancelResult.structuredContent?.content, 'cancelled-by-tool');

  const started = (await startResult) as CallToolResultShape;
  assert.equal(started.structuredContent?.status, 'cancelled');
  assert.equal(started.structuredContent?.content, 'aborted-by-cancel');
});

async function runElicitationScenario(
  responder: (req: { id: number | string; method: string; params: unknown }) => void,
): Promise<CallToolResultShape> {
  client.onServerRequest(responder);
  try {
    return (await client.callTool('opencode', {
      prompt: JSON.stringify({ mode: 'elicit', permission: 'bash', patterns: ['rm -rf /'] }),
    })) as CallToolResultShape;
  } finally {
    client.onServerRequest(() => {});
  }
}

test('elicitation: accept + allow maps to an "allow" decision, exactly one engine call', async () => {
  const before1 = (await getCallLog()).filter((c) => c.tool === 'start').length;
  const result = await runElicitationScenario((req) => {
    assert.equal(req.method, 'elicitation/create');
    const params = req.params as { message: string; requestedSchema: unknown };
    assert.match(params.message, /OpenCode wants permission "bash" for: rm -rf \//);
    client.respond(req.id, { action: 'accept', content: { decision: 'allow' } });
  });
  assert.equal(result.structuredContent?.content, 'decision:allow:');
  const after1 = (await getCallLog()).filter((c) => c.tool === 'start').length;
  assert.equal(after1 - before1, 1);
});

test('elicitation: accept + reject maps to a "reject" decision with feedback', async () => {
  const result = await runElicitationScenario((req) => {
    client.respond(req.id, { action: 'accept', content: { decision: 'reject', feedback: 'no thanks' } });
  });
  assert.equal(result.structuredContent?.content, 'decision:reject:no thanks');
});

test('elicitation: decline maps to a null decision', async () => {
  const result = await runElicitationScenario((req) => {
    client.respond(req.id, { action: 'decline' });
  });
  assert.equal(result.structuredContent?.content, 'decision:null');
});

test('elicitation: a client-side error response maps to a null decision, never throws', async () => {
  const result = await runElicitationScenario((req) => {
    client.respondError(req.id, -32000, 'elicitation failed');
  });
  assert.equal(result.structuredContent?.content, 'decision:null');
});

// ---------------------------------------------------------------------------
// EngineError -> isError + ErrorResult
// ---------------------------------------------------------------------------

test('EngineError from the engine becomes isError with an ErrorResult carrying the known sessionId', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'throw-engine-error', code: 'UPSTREAM_ERROR', message: 'upstream boom' }),
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'error');
  assert.equal((result.structuredContent?.error as { name: string }).name, 'UPSTREAM_ERROR');
  assert.equal(typeof result.structuredContent?.sessionId, 'string');
  assert.equal(result.structuredContent?.threadId, result.structuredContent?.sessionId);
});

test('an unexpected (non-EngineError) throw becomes a generic INTERNAL isError result', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'throw-unexpected' }),
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string }).name, 'INTERNAL');
});

test('a reply to an unknown sessionId is SESSION_NOT_FOUND, not a crash', async () => {
  const result = (await client.callTool('opencode-reply', {
    sessionId: 'ses_does_not_exist',
    prompt: 'hi',
  })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string }).name, 'SESSION_NOT_FOUND');
  assert.equal(result.structuredContent?.sessionId, 'ses_does_not_exist');
});

// ---------------------------------------------------------------------------
// opencode-end
// ---------------------------------------------------------------------------

test('opencode-end: ends a known session and forgets it', async () => {
  const started = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'to-end' }),
  })) as CallToolResultShape;
  const sessionId = started.structuredContent?.sessionId as string;

  const ended = (await client.callTool('opencode-end', { sessionId })) as CallToolResultShape;
  assert.equal(ended.structuredContent?.status, 'ended');
  assert.equal(ended.structuredContent?.action, 'delete');

  const again = (await client.callTool('opencode-end', { sessionId })) as CallToolResultShape;
  assert.equal(again.structuredContent?.status, 'not_found');
});

// ---------------------------------------------------------------------------
// stdout hygiene
// ---------------------------------------------------------------------------

test('stdout carries only well-formed JSON-RPC frames', () => {
  assert.ok(client.rawStdoutLines.length > 0);
  for (const line of client.rawStdoutLines) {
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `non-JSON line on stdout: ${line}`);
    assert.equal((parsed as { jsonrpc?: string }).jsonrpc, '2.0', `missing jsonrpc envelope: ${line}`);
  }
});
