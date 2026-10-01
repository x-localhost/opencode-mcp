// U13: the model-facing delegation contract — per-parameter descriptions (so a delegating model
// can tell timeout-seconds from wait-seconds and knows the model format), cancellation semantics
// in the tool/server descriptions, a configured-default-aware opencode-end description, a recovery
// `hint` on every error result, opencode-status rejecting wait-seconds in list mode, and a progress
// throttle immune to a backward wall-clock step.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import { buildErrorResult, buildServerInstructions, createProgressSink } from '../../src/mcp/tools.ts';
import { baseConfig } from '../opencode/support/base-config.ts';

// Context-concurrency design §6: SERVER_INSTRUCTIONS became buildServerInstructions(config) (the
// numbers it appends are only known once a Config exists). Every sentence this file pins below
// lives in the unchanged base text, so a representative config is enough to exercise them.
const SERVER_INSTRUCTIONS = buildServerInstructions(baseConfig());

interface JsonSchemaProperty {
  description?: string;
  [key: string]: unknown;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonSchemaProperty> };
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

// ---------------------------------------------------------------------------
// (a) Every input schema property has a description; cancellation is documented.
// ---------------------------------------------------------------------------

test('tools/list: every inputSchema property of every tool has a non-empty description', () => {
  for (const tool of tools) {
    const properties = tool.inputSchema.properties ?? {};
    const names = Object.keys(properties);
    assert.ok(names.length > 0, `${tool.name}: expected at least one input property`);
    for (const propName of names) {
      const description = properties[propName]?.description;
      assert.equal(typeof description, 'string', `${tool.name}.${propName}: missing description`);
      assert.ok((description as string).length > 0, `${tool.name}.${propName}: empty description`);
    }
  }
});

test('tools/list: a delegating model can tell timeout-seconds and wait-seconds apart from their descriptions alone', () => {
  const opencode = tools.find((t) => t.name === 'opencode');
  assert.ok(opencode, 'expected an opencode tool');
  const timeoutDesc = opencode!.inputSchema.properties['timeout-seconds']?.description ?? '';
  const waitDesc = opencode!.inputSchema.properties['wait-seconds']?.description ?? '';

  // timeout-seconds: stops the turn itself.
  assert.match(timeoutDesc, /stop/i);
  assert.match(timeoutDesc, /timeout/i);
  // wait-seconds: only bounds the call's own wait; the turn is left running.
  assert.match(waitDesc, /keep|continue|still (running|executing)/i);
  assert.doesNotMatch(waitDesc, /stops? the (turn|run)/i);

  const modelDesc = opencode!.inputSchema.properties.model?.description ?? '';
  assert.match(modelDesc, /provider\/model/);
});

test('tools/list: opencode and opencode-reply descriptions mention that cancelling the call cancels the turn', () => {
  const byName = new Map(tools.map((t) => [t.name, t.description]));
  for (const name of ['opencode', 'opencode-reply']) {
    const description = byName.get(name) ?? '';
    assert.match(description, /cancel/i, `${name}: expected cancellation semantics in the description`);
    assert.match(description, /wait-seconds/, `${name}: expected wait-seconds named as the alternative`);
    assert.match(description, /opencode-status/, `${name}: expected opencode-status named as the follow-up`);
  }
});

test('SERVER_INSTRUCTIONS mentions cancellation and gives recovery guidance for SESSION_BUSY / CLEANUP_UNCONFIRMED', () => {
  assert.match(SERVER_INSTRUCTIONS, /cancel/i);
  assert.match(SERVER_INSTRUCTIONS, /SESSION_BUSY/);
  assert.match(SERVER_INSTRUCTIONS, /CLEANUP_UNCONFIRMED/);
  assert.match(SERVER_INSTRUCTIONS, /opencode-status/);
  assert.match(SERVER_INSTRUCTIONS, /opencode-end|opencode-cancel/);
  assert.ok(SERVER_INSTRUCTIONS.length < 2048);
});

// ---------------------------------------------------------------------------
// (b) opencode-end advertises the server's actual configured default action.
// ---------------------------------------------------------------------------

test('opencode-end description advertises the configured default action, not a hardcoded one', async () => {
  const archiveSpawn = spawnStubServer({ OPENCODE_MCP_END_ACTION: 'archive' });
  try {
    const archiveClient = new JsonRpcClient(archiveSpawn.child);
    await archiveClient.initializeLegacy();
    const { result } = archiveClient.request('tools/list', {});
    const res = (await result) as { tools: Tool[] };
    const end = res.tools.find((t) => t.name === 'opencode-end');
    assert.ok(end, 'expected an opencode-end tool');
    assert.match(end!.description, /archive/, 'expected the configured default (archive) to be advertised');
    assert.doesNotMatch(end!.description, /default delete/i, 'must not hardcode the old default');
  } finally {
    archiveSpawn.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// (c) opencode-status: wait-seconds with no id is rejected, not silently dropped.
// ---------------------------------------------------------------------------

test('opencode-status: wait-seconds with no id is INVALID_ARGUMENT, not a silently-ignored list', async () => {
  const result = (await client.callTool('opencode-status', { 'wait-seconds': 5 })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string } | undefined)?.name, 'INVALID_ARGUMENT');
  assert.match((result.structuredContent?.content as string | undefined) ?? '', /session id/);
});

test('opencode-status: no id and no wait-seconds still lists tracked sessions', async () => {
  const result = (await client.callTool('opencode-status', {})) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.kind, 'sessions');
});

// ---------------------------------------------------------------------------
// (d) buildErrorResult carries a recovery hint per error code.
// ---------------------------------------------------------------------------

test('buildErrorResult: SESSION_BUSY hint points the model at opencode-status', () => {
  const result = buildErrorResult('SESSION_BUSY', 'a turn is already running', 'ses_1');
  assert.equal(result.sessionId, 'ses_1');
  assert.match(result.hint ?? '', /opencode-status/);
});

test('buildErrorResult: CLEANUP_UNCONFIRMED hint says the session is still tracked and to retry opencode-end', () => {
  const result = buildErrorResult('CLEANUP_UNCONFIRMED', 'stop could not be confirmed', 'ses_2');
  assert.match(result.hint ?? '', /retry/i);
  assert.match(result.hint ?? '', /opencode-end/);
});

test('buildErrorResult: every documented error code carries a hint', () => {
  const codes = [
    'SESSION_BUSY',
    'CLEANUP_UNCONFIRMED',
    'SUBMISSION_UNCONFIRMED',
    'TURN_INCOMPLETE',
    'SESSION_NOT_FOUND',
    'OPENCODE_UNAVAILABLE',
    'PATH_NOT_ALLOWED',
    'INVALID_ARGUMENT',
  ] as const;
  for (const code of codes) {
    const result = buildErrorResult(code, 'message', 'ses_x');
    assert.equal(typeof result.hint, 'string', `${code}: expected a hint`);
    assert.ok((result.hint ?? '').length > 0, `${code}: expected a non-empty hint`);
  }
});

// ---------------------------------------------------------------------------
// (e) createProgressSink: a backward wall-clock step cannot silence heartbeats.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createProgressSink: a Date.now() step 40 minutes backwards does not delay the next heartbeat', async () => {
  const originalDateNow = Date.now;
  const sent: unknown[] = [];
  const notify = async (n: unknown): Promise<void> => {
    sent.push(n);
  };
  const sink = createProgressSink(notify as unknown as Parameters<typeof createProgressSink>[0], 'tok', {
    current: undefined,
  });

  try {
    sink.send('first');
    assert.equal(sent.length, 1, 'the first send must go through immediately');

    // Step the wall clock 40 minutes backwards. A Date.now()-based throttle would compute a
    // strongly negative `elapsed` here and arm a ~40-minute timer for the next message; a
    // monotonic-clock-based one (performance.now()) is unaffected.
    const FORTY_MIN_MS = 40 * 60 * 1000;
    Date.now = () => originalDateNow() - FORTY_MIN_MS;

    const started = originalDateNow();
    sink.send('second');
    // Poll (real wall clock, via the un-stubbed reference) until the second message is delivered
    // or a generous safety margin elapses.
    for (let i = 0; i < 30 && sent.length < 2; i += 1) {
      await delay(50);
    }
    const elapsedRealMs = originalDateNow() - started;

    assert.equal(sent.length, 2, 'the second heartbeat must still be delivered, not silenced by the clock step');
    // One throttle window (1s) plus generous scheduling slack — nowhere near the 40-minute delay a
    // wall-clock-based throttle would have produced.
    assert.ok(elapsedRealMs <= 1500, `expected delivery within ~1s of real time, took ${elapsedRealMs}ms`);
  } finally {
    Date.now = originalDateNow;
    sink.dispose();
  }
});
