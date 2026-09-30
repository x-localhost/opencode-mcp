// v0.3 delegation features (F8): MCP wiring tests for the new tool arguments (request-id,
// output-schema, detail, max-output-chars, ids/wait-for) and the two new tools (opencode-output,
// opencode-info), against the stub engine — like test/mcp/server.test.ts. Deep presentation/
// fitting behaviour lives in test/mcp/format-f8.test.ts (pure unit tests, no server).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer, spawnStubServerNoV03 } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import { buildErrorResult } from '../../src/mcp/tools.ts';

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  items?: unknown;
  [key: string]: unknown;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: string; additionalProperties?: boolean; properties: Record<string, JsonSchemaProperty>; required?: string[] };
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

function toolByName(name: string): Tool {
  const t = tools.find((tool) => tool.name === name);
  assert.ok(t, `expected a ${name} tool`);
  return t as Tool;
}

async function start(prompt: unknown): Promise<CallToolResultShape> {
  return (await client.callTool('opencode', { prompt: JSON.stringify(prompt) })) as CallToolResultShape;
}

// ---------------------------------------------------------------------------
// tools/list shape: seven tools, new args present with the right bounds
// ---------------------------------------------------------------------------

test('tools/list: exposes all seven kebab-case tools', () => {
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

test('tools/list: every input schema (including the two new tools) is a strict object root', () => {
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('tools/list: opencode/opencode-reply declare request-id, output-schema, detail, max-output-chars', () => {
  for (const name of ['opencode', 'opencode-reply']) {
    const props = toolByName(name).inputSchema.properties;
    assert.ok(props['request-id'], `${name}: expected request-id`);
    assert.match(props['request-id']!.pattern ?? '', /\^/);
    assert.ok(props['output-schema'], `${name}: expected output-schema`);
    assert.equal(props['output-schema']!.type, 'object');
    assert.ok(props.detail, `${name}: expected detail`);
    assert.ok(props['max-output-chars'], `${name}: expected max-output-chars`);
    assert.equal(props['max-output-chars']!.minimum, 0);
    assert.equal(props['max-output-chars']!.maximum, 44000);
  }
});

test('tools/list: opencode-status declares ids, wait-for, detail, max-output-chars', () => {
  const props = toolByName('opencode-status').inputSchema.properties;
  assert.ok(props.ids);
  assert.equal(props.ids!.type, 'array');
  assert.ok(props['wait-for']);
  assert.ok(props.detail);
  assert.ok(props['max-output-chars']);
});

test('tools/list: opencode-output declares one id alias, turn, section, offset, limit, diff-view, file-index, snapshot-id', () => {
  const props = toolByName('opencode-output').inputSchema.properties;
  for (const key of ['sessionId', 'threadId', 'conversationId', 'turn', 'section', 'offset', 'limit', 'diff-view', 'file-index', 'snapshot-id']) {
    assert.ok(props[key], `expected opencode-output.${key}`);
  }
  assert.ok(toolByName('opencode-output').inputSchema.required?.includes('turn'));
});

test('tools/list: opencode-info declares section, cwd, provider, offset, limit, snapshot-id', () => {
  const props = toolByName('opencode-info').inputSchema.properties;
  for (const key of ['section', 'cwd', 'provider', 'offset', 'limit', 'snapshot-id']) {
    assert.ok(props[key], `expected opencode-info.${key}`);
  }
});

test('tools/list: opencode-output/opencode-info are annotated read-only, and every output schema still requires kind/status/content', () => {
  assert.equal(toolByName('opencode-output').annotations?.readOnlyHint, true);
  assert.equal(toolByName('opencode-info').annotations?.readOnlyHint, true);
  for (const tool of tools) {
    assert.deepEqual([...tool.outputSchema.required].sort(), ['content', 'kind', 'status'], tool.name);
  }
});

test('tools/list: every description (including the two new tools) is non-empty and under 2048 chars', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, tool.name);
    assert.ok(tool.description.length < 2048, tool.name);
  }
});

// ---------------------------------------------------------------------------
// request-id: pattern rejection at the schema
// ---------------------------------------------------------------------------

test('opencode: request-id must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', async () => {
  for (const bad of ['-starts-with-dash', ' has space', '', 'has/slash', 'a'.repeat(129)]) {
    const result = (await client.callTool('opencode', { prompt: 'x', 'request-id': bad })) as CallToolResultShape;
    assert.equal(result.isError, true, `expected rejection for request-id=${JSON.stringify(bad)}`);
  }
});

test('opencode: a well-formed request-id is accepted by the schema', async () => {
  const result = await start({ mode: 'immediate', content: 'ok' });
  const withId = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'ok' }),
    'request-id': 'abc.def_ghi:jkl-123',
  })) as CallToolResultShape;
  assert.notEqual(withId.isError, true, JSON.stringify(withId));
  assert.notEqual(result.isError, true);
});

// ---------------------------------------------------------------------------
// max-output-chars bounds
// ---------------------------------------------------------------------------

test('opencode: max-output-chars must be 0..44000', async () => {
  const tooBig = (await client.callTool('opencode', { prompt: 'x', 'max-output-chars': 44001 })) as CallToolResultShape;
  assert.equal(tooBig.isError, true);
  const negative = (await client.callTool('opencode', { prompt: 'x', 'max-output-chars': -1 })) as CallToolResultShape;
  assert.equal(negative.isError, true);
  const zero = await start({ mode: 'immediate', content: 'hidden' });
  assert.notEqual(zero.isError, true);
});

test('opencode: max-output-chars 0 returns empty content in structuredContent', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'immediate', content: 'hidden answer' }),
    'max-output-chars': 0,
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.content, '');
});

// ---------------------------------------------------------------------------
// detail:"compact" over the wire; independence between two calls
// ---------------------------------------------------------------------------

test('opencode-status: detail "compact" on a single session omits toolCalls/filesChanged and adds counts', async () => {
  const started = await start({
    mode: 'immediate',
    content: 'built it',
    overrides: { toolCalls: [{ tool: 'bash', status: 'completed', title: 'npm test' }], filesChanged: ['a.ts', 'b.ts'] },
  });
  const sessionId = started.structuredContent?.sessionId as string;

  const compact = (await client.callTool('opencode-status', { sessionId, detail: 'compact' })) as CallToolResultShape;
  assert.equal(compact.structuredContent?.toolCalls, undefined);
  assert.equal(compact.structuredContent?.filesChanged, undefined);
  assert.equal(compact.structuredContent?.filesChangedCount, 2);

  const standard = (await client.callTool('opencode-status', { sessionId })) as CallToolResultShape;
  assert.equal((standard.structuredContent?.toolCalls as unknown[]).length, 1);
  assert.equal((standard.structuredContent?.filesChanged as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// ids / wait-for batch mode
// ---------------------------------------------------------------------------

test('opencode-status: ids is mutually exclusive with sessionId/threadId/conversationId', async () => {
  const result = (await client.callTool('opencode-status', { sessionId: 'ses_x', ids: ['ses_x'] })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'INVALID_ARGUMENT');
});

test('opencode-status: wait-for without ids is INVALID_ARGUMENT', async () => {
  const result = (await client.callTool('opencode-status', { 'wait-for': 'all' })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'INVALID_ARGUMENT');
});

test('opencode-status: ids over 16 entries is rejected by the schema', async () => {
  const ids = Array.from({ length: 17 }, (_, i) => `ses_${i}`);
  const result = (await client.callTool('opencode-status', { ids })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-status: an empty ids array is rejected by the schema', async () => {
  const result = (await client.callTool('opencode-status', { ids: [] })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-status: duplicate ids is INVALID_ARGUMENT', async () => {
  const started = await start({ mode: 'immediate', content: 'dup' });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-status', { ids: [sessionId, sessionId] })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'INVALID_ARGUMENT');
});

test('opencode-status: ids batch mode returns kind "batch", includes a per-item error for an unknown id, never fails the call', async () => {
  const started = await start({ mode: 'immediate', content: 'batched' });
  const sessionId = started.structuredContent?.sessionId as string;

  const result = (await client.callTool('opencode-status', {
    ids: [sessionId, 'ses_does_not_exist'],
    'wait-for': 'all',
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.kind, 'batch');
  assert.equal(result.structuredContent?.waitFor, 'all');
  const items = result.structuredContent?.results as Array<{ sessionId: string; status: string; error?: { name: string } }>;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.sessionId, sessionId);
  assert.notEqual(items[0]!.status, 'error');
  assert.equal(items[1]!.sessionId, 'ses_does_not_exist');
  assert.equal(items[1]!.status, 'error');
  assert.equal(items[1]!.error?.name, 'SESSION_NOT_FOUND');
});

test('opencode-status: batch max-output-chars is the aggregate budget, not a per-session cap', async () => {
  const a = await start({ mode: 'immediate', content: 'A'.repeat(2000) });
  const b = await start({ mode: 'immediate', content: 'B'.repeat(2000) });
  const idA = a.structuredContent?.sessionId as string;
  const idB = b.structuredContent?.sessionId as string;

  const result = (await client.callTool('opencode-status', {
    ids: [idA, idB],
    'max-output-chars': 200,
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  const items = result.structuredContent?.results as Array<{ content: string }>;
  const total = items.reduce((sum, item) => sum + item.content.length, 0);
  assert.ok(total <= 200, `expected the 200-char aggregate to be respected, got ${total}`);
});

// ---------------------------------------------------------------------------
// opencode-output
// ---------------------------------------------------------------------------

test('opencode-output: turn is required by the schema', async () => {
  const started = await start({ mode: 'immediate', content: 'x' });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-output', { sessionId })) as CallToolResultShape;
  assert.equal(result.isError, true);
});

test('opencode-output: an unknown session id is SESSION_NOT_FOUND', async () => {
  const result = (await client.callTool('opencode-output', { sessionId: 'ses_nope', turn: 1 })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'SESSION_NOT_FOUND');
});

test('opencode-output: an out-of-range turn is TURN_NOT_FOUND, with a hint', async () => {
  const started = await start({ mode: 'immediate', content: 'x' });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-output', { sessionId, turn: 99 })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'TURN_NOT_FOUND');
  assert.ok((result.structuredContent?.hint as string | undefined)?.length, 'expected a recovery hint');
});

test('opencode-output: reads back the full retained answer from the matching turn, and pages it', async () => {
  const longAnswer = 'The quick brown fox. '.repeat(50);
  const started = await start({ mode: 'immediate', content: longAnswer });
  const sessionId = started.structuredContent?.sessionId as string;

  const full = (await client.callTool('opencode-output', { sessionId, turn: 1 })) as CallToolResultShape;
  assert.notEqual(full.isError, true, JSON.stringify(full));
  assert.equal(full.structuredContent?.kind, 'output');
  assert.equal(full.structuredContent?.section, 'answer');
  assert.equal(full.structuredContent?.content, longAnswer);
  assert.equal(full.structuredContent?.hasMore, false);

  // v0.3 §1 freezes the text-section minimum at limit >= 256 (mid-review finding 15): use a legal
  // paging value here, and assert rejection below 256 in the dedicated test right after this one.
  const page = (await client.callTool('opencode-output', { sessionId, turn: 1, offset: 0, limit: 256 })) as CallToolResultShape;
  assert.equal(page.structuredContent?.content, longAnswer.slice(0, 256));
  assert.equal(page.structuredContent?.hasMore, true);
  assert.equal(page.structuredContent?.nextOffset, 256);
});

test('opencode-output: a limit below 256 for a text section is rejected (the frozen minimum, mid-review finding 15)', async () => {
  const longAnswer = 'The quick brown fox. '.repeat(50);
  const started = await start({ mode: 'immediate', content: longAnswer });
  const sessionId = started.structuredContent?.sessionId as string;

  const tooSmall = (await client.callTool('opencode-output', {
    sessionId,
    turn: 1,
    section: 'answer',
    limit: 10,
  })) as CallToolResultShape;
  assert.equal(tooSmall.isError, true);
  assert.equal((tooSmall.structuredContent?.error as { name: string } | undefined)?.name, 'INVALID_ARGUMENT');
});

test('opencode-output: section "tool-calls" reads back the recorded tool calls for that turn', async () => {
  const started = await start({
    mode: 'immediate',
    content: 'ran a command',
    overrides: { toolCalls: [{ tool: 'bash', status: 'completed', title: 'ls' }] },
  });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-output', { sessionId, turn: 1, section: 'tool-calls' })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  const toolCalls = result.structuredContent?.toolCalls as Array<{ tool: string }>;
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.tool, 'bash');
});

test('opencode-output: an engine-signalled OUTPUT_UNAVAILABLE surfaces as isError with a hint', async () => {
  const started = await start({
    mode: 'immediate',
    content: 'x',
    nextOutputError: { code: 'OUTPUT_UNAVAILABLE', message: 'evicted (stub)' },
  });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-output', { sessionId, turn: 1 })) as CallToolResultShape;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent?.error as { name: string })?.name, 'OUTPUT_UNAVAILABLE');
  assert.ok((result.structuredContent?.hint as string | undefined)?.length);
});

test('A10: a formatter-generated kind:"error" envelope (the engine call itself did not throw) still surfaces as isError:true', async () => {
  // The engine call succeeds outright (no EngineError thrown); format.ts's own last-resort
  // fitting logic (formatOutputResult -> buildOutputTooLargeError, when even a single emitted
  // item cannot fit the response's hard size budget) is what turns this into kind:"error". Before
  // the A10 fix, src/mcp/tools.ts's isError flag was set solely from whether the engine call
  // threw, so this specific case shipped as isError:false despite an error envelope in the body.
  const started = await start({
    mode: 'immediate',
    content: 'x',
    nextOutputHugeSnapshotIdChars: 50_000,
  });
  const sessionId = started.structuredContent?.sessionId as string;
  const result = (await client.callTool('opencode-output', {
    sessionId,
    turn: 1,
    section: 'diff',
    'diff-view': 'patch',
    'file-index': 0,
  })) as CallToolResultShape;
  assert.equal(result.structuredContent?.kind, 'error', JSON.stringify(result));
  assert.equal(result.isError, true, 'the MCP isError flag must follow the final formatted envelope, not the (successful) engine call');
});

// ---------------------------------------------------------------------------
// opencode-info
// ---------------------------------------------------------------------------

test('opencode-info: default section is "server" and never contacts a session', async () => {
  const result = (await client.callTool('opencode-info', {})) as CallToolResultShape;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.kind, 'info');
  assert.equal(result.structuredContent?.section, 'server');
  const server = result.structuredContent?.server as Record<string, unknown>;
  assert.equal(typeof server.mcpVersion, 'string');
  assert.equal(typeof server.serverInstanceId, 'string');
});

test('opencode-info: section "models"/"agents"/"roots" return paginated arrays', async () => {
  const models = (await client.callTool('opencode-info', { section: 'models' })) as CallToolResultShape;
  assert.notEqual(models.isError, true);
  assert.ok(Array.isArray(models.structuredContent?.models));

  const agents = (await client.callTool('opencode-info', { section: 'agents' })) as CallToolResultShape;
  assert.ok(Array.isArray(agents.structuredContent?.agents));

  const roots = (await client.callTool('opencode-info', { section: 'roots' })) as CallToolResultShape;
  assert.ok(Array.isArray(roots.structuredContent?.roots));
});

// ---------------------------------------------------------------------------
// Engine lacks output/info/statusMany -> INTERNAL "not available in this build"
// ---------------------------------------------------------------------------

test('when the engine lacks output/info/statusMany, the matching tools return INTERNAL "not available in this build"', async () => {
  const legacy = spawnStubServerNoV03();
  try {
    const legacyClient = new JsonRpcClient(legacy.child);
    await legacyClient.initializeLegacy();

    const started = (await legacyClient.callTool('opencode', {
      prompt: JSON.stringify({ mode: 'immediate', content: 'x' }),
    })) as CallToolResultShape;
    const sessionId = started.structuredContent?.sessionId as string;

    const output = (await legacyClient.callTool('opencode-output', { sessionId, turn: 1 })) as CallToolResultShape;
    assert.equal(output.isError, true);
    assert.equal((output.structuredContent?.error as { name: string })?.name, 'INTERNAL');
    assert.match(output.structuredContent?.content as string, /not available in this build/);

    const info = (await legacyClient.callTool('opencode-info', {})) as CallToolResultShape;
    assert.equal(info.isError, true);
    assert.equal((info.structuredContent?.error as { name: string })?.name, 'INTERNAL');

    const batch = (await legacyClient.callTool('opencode-status', { ids: [sessionId] })) as CallToolResultShape;
    assert.equal(batch.isError, true);
    assert.equal((batch.structuredContent?.error as { name: string })?.name, 'INTERNAL');
  } finally {
    legacy.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// New error codes carry hints (buildErrorResult, direct import — same pattern as audit-u13)
// ---------------------------------------------------------------------------

test('buildErrorResult: every new v0.3 error code carries a non-empty hint', () => {
  const codes = [
    'TURN_NOT_FOUND',
    'OUTPUT_NOT_READY',
    'OUTPUT_UNAVAILABLE',
    'OUTPUT_LIMIT_TOO_SMALL',
    'SNAPSHOT_EXPIRED',
    'UPSTREAM_RESPONSE_TOO_LARGE',
    'INVALID_OUTPUT_SCHEMA',
    'REQUEST_ID_CONFLICT',
    'REQUEST_UNCONFIRMED',
    'REQUEST_ENDED',
    'REQUEST_CAPACITY',
  ] as const;
  for (const code of codes) {
    const result = buildErrorResult(code, 'message', 'ses_x');
    assert.equal(typeof result.hint, 'string', `${code}: expected a hint`);
    assert.ok((result.hint ?? '').length > 0, `${code}: expected a non-empty hint`);
  }
});

// ---------------------------------------------------------------------------
// Mid-review finding 17: cancellation ownership is qualified (a duplicate request-id call is an
// observer, not the owner), and OUTPUT_LIMIT_TOO_SMALL points at server configuration.
// ---------------------------------------------------------------------------

test('opencode/opencode-reply descriptions qualify that cancelling only stops the turn for the call that owns it', () => {
  for (const name of ['opencode', 'opencode-reply']) {
    const description = toolByName(name).description;
    assert.match(
      description,
      /observ|duplicate request-id|joins/i,
      `${name}: expected the description to qualify cancellation ownership (an observer/duplicate request-id call never cancels the turn)`,
    );
  }
});

test("buildErrorResult: OUTPUT_LIMIT_TOO_SMALL's hint points at server configuration, not the caller's limit argument", () => {
  const result = buildErrorResult('OUTPUT_LIMIT_TOO_SMALL', 'server cap too small', 'ses_x');
  assert.match(result.hint ?? '', /OPENCODE_MCP_MAX_OUTPUT_CHARS/);
  assert.doesNotMatch(result.hint ?? '', /^Increase limit/);
});

// ---------------------------------------------------------------------------
// stdout hygiene (same invariant as server.test.ts, re-checked here since new tools were added)
// ---------------------------------------------------------------------------

test('stdout carries only well-formed JSON-RPC frames after exercising the new tools', () => {
  assert.ok(client.rawStdoutLines.length > 0);
  for (const line of client.rawStdoutLines) {
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `non-JSON line on stdout: ${line}`);
    assert.equal((parsed as { jsonrpc?: string }).jsonrpc, '2.0', `missing jsonrpc envelope: ${line}`);
  }
});
