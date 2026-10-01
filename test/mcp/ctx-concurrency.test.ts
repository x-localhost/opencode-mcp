// Context-aware model assignment + run-slot concurrency cap — unit 5 (MCP surface):
// context-concurrency design §6 (docs/design.md §13). This file exercises the MCP layer directly
// against fixtures (formatResult) and against the stub engine's new 'queued'/'context-high'
// scripts through the real registerTools/output-validation call path (same pattern as
// test/mcp/overload-presentation.test.ts).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';
import { buildErrorResult, buildServerInstructions, outputSchema } from '../../src/mcp/tools.ts';
import { formatResult } from '../../src/mcp/format.ts';
import { baseConfig } from '../opencode/support/base-config.ts';
import type { BatchResult, InfoResult, SessionSummary, TurnResult } from '../../src/types.ts';

interface CallToolResultShape {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function baseTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    kind: 'turn',
    threadId: 'ses_1',
    sessionId: 'ses_1',
    turnId: 'ses_1#1',
    turn: 1,
    status: 'completed',
    executionState: 'stopped',
    cleanup: 'complete',
    content: 'done',
    directory: '/repo',
    filesChanged: [],
    toolCalls: [],
    toolCallCount: 0,
    pendingApprovals: [],
    elapsedMs: 100,
    truncated: false,
    hint: 'use opencode-reply to continue',
    ...overrides,
  };
}

function baseInfo(overrides: Partial<InfoResult> = {}): InfoResult {
  return { kind: 'info', status: 'ok', content: 'info', section: 'server', truncated: false, ...overrides };
}

// ---------------------------------------------------------------------------
// (A) outputSchema: a queued snapshot, and a completed turn with context+CONTEXT_HIGH+tokens.cache.
// ---------------------------------------------------------------------------

test('outputSchema: a queued turn (status running + queue object) validates', () => {
  const result = baseTurn({
    status: 'running',
    executionState: 'active',
    resendSafety: 'not_submitted',
    content: '',
    queue: { position: 3, running: 4, maxRunning: 4, blockedBy: 'global', queuedMs: 1500 },
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.deepEqual(structuredContent.queue, {
    position: 3,
    running: 4,
    maxRunning: 4,
    blockedBy: 'global',
    queuedMs: 1500,
  });
  assert.match(text, /queued: position 3 \(4\/4 running\)/);
  const parsed = outputSchema.safeParse(structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('outputSchema: a queued turn blocked by a per-model cap renders the model variant and validates', () => {
  const result = baseTurn({
    status: 'running',
    executionState: 'active',
    resendSafety: 'not_submitted',
    content: '',
    queue: {
      position: 1,
      running: 4,
      maxRunning: null,
      blockedBy: 'model',
      model: 'corp/big',
      modelRunning: 2,
      modelMaxRunning: 2,
      queuedMs: 400,
    },
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /queued: position 1 for corp\/big \(model 2\/2 running\)/);
  assert.equal(outputSchema.safeParse(structuredContent).success, true);
});

test('text mirror: a globally blocked queued turn with a model uses the global wording', () => {
  const result = baseTurn({
    status: 'running', executionState: 'active', resendSafety: 'not_submitted', content: '',
    queue: { position: 2, running: 4, maxRunning: 4, blockedBy: 'global', model: 'corp/small', queuedMs: 10 },
  });
  const { text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /queued: position 2 \(4\/4 running\)/);
});

test('outputSchema: a completed turn with context + CONTEXT_HIGH + tokens.cache validates and renders the ratio line', () => {
  const result = baseTurn({
    status: 'completed',
    context: {
      model: 'corp/coding-model',
      used: 104_080,
      peakUsed: 110_000,
      usableInputTokens: 123_904,
      ratio: 0.84,
      limitSource: 'opencode',
      compacted: false,
    },
    tokens: { input: 104_080, output: 500, reasoning: 0, cache: { read: 100, write: 50 } },
    warnings: [
      {
        code: 'CONTEXT_HIGH',
        message: "Last reported context usage is 84% of corp/coding-model's budget (104080 of 123904 tokens).",
      },
    ],
  });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.deepEqual(structuredContent.context, {
    model: 'corp/coding-model',
    used: 104_080,
    peakUsed: 110_000,
    usableInputTokens: 123_904,
    ratio: 0.84,
    limitSource: 'opencode',
    compacted: false,
  });
  assert.deepEqual(structuredContent.tokens, { input: 104_080, output: 500, reasoning: 0, cache: { read: 100, write: 50 } });
  assert.deepEqual(structuredContent.warnings, [
    {
      code: 'CONTEXT_HIGH',
      message: "Last reported context usage is 84% of corp/coding-model's budget (104080 of 123904 tokens).",
    },
  ]);
  assert.match(text, /context: 84% of 123904 \(corp\/coding-model\)/);
  assert.match(text, /warning: CONTEXT_HIGH/);
  const parsed = outputSchema.safeParse(structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('outputSchema: context with only `used` (no usable budget known) renders the plain used line', () => {
  const result = baseTurn({ context: { model: 'corp/unknown-limit', used: 5000, compacted: false } });
  const { structuredContent, text } = formatResult(result, { maxOutputChars: 20_000 });
  assert.match(text, /context: used 5000 \(corp\/unknown-limit\)/);
  assert.equal(outputSchema.safeParse(structuredContent).success, true);
});

test('outputSchema: a SessionSummary with a `queue` object validates (sessions list item)', () => {
  const session: SessionSummary = {
    sessionId: 'ses_1',
    title: 'ses_1',
    directory: '/repo',
    status: 'running',
    turns: 1,
    updatedAt: 0,
    queue: { position: 2, running: 4, maxRunning: 4, blockedBy: 'global', queuedMs: 900 },
  };
  const { structuredContent } = formatResult(
    { kind: 'sessions', content: 'x', sessions: [session], truncated: false },
    { maxOutputChars: 20_000 },
  );
  const parsed = outputSchema.safeParse(structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  assert.deepEqual((structuredContent.sessions as unknown[])[0], session);
});

test('formatResult (batch): a queued and a context-bearing item both render their one-liners inside the bracketed extras', () => {
  const batch: BatchResult = {
    kind: 'batch',
    status: 'ready',
    content: '',
    waitFor: 'any',
    reason: 'condition',
    results: [
      {
        sessionId: 'ses_1',
        status: 'running',
        content: '',
        queue: { position: 3, running: 4, maxRunning: 4, blockedBy: 'global', queuedMs: 1500 },
      },
      {
        sessionId: 'ses_2',
        status: 'completed',
        content: 'done',
        context: { model: 'corp/coding-model', used: 1000, usableInputTokens: 2000, ratio: 0.5, compacted: false },
      },
    ],
    readyIds: ['ses_1', 'ses_2'],
    pendingIds: [],
    truncated: false,
  };
  const { structuredContent, text } = formatResult(batch, { maxOutputChars: 20_000 });
  assert.match(text, /ses_1: running \[queued: position 3 \(4\/4 running\)\]/);
  assert.match(text, /ses_2: completed — done \[context: 50% of 2000 \(corp\/coding-model\)\]/);
  assert.deepEqual((structuredContent.results as Array<Record<string, unknown>>)[0]?.queue, {
    position: 3,
    running: 4,
    maxRunning: 4,
    blockedBy: 'global',
    queuedMs: 1500,
  });
});

test('formatResult: queue/context survive detail:"compact"', () => {
  const result = baseTurn({
    status: 'running',
    queue: { position: 1, running: 1, maxRunning: 4, blockedBy: 'global', queuedMs: 10 },
    context: { model: 'corp/m', used: 10, compacted: false },
  });
  const { structuredContent } = formatResult(result, { maxOutputChars: 20_000, detail: 'compact' });
  assert.ok(structuredContent.queue !== undefined);
  assert.ok(structuredContent.context !== undefined);
});

// ---------------------------------------------------------------------------
// (B) ERROR_HINTS: RUN_QUEUE_CAPACITY / PROMPT_TOO_LARGE exact texts (design.md §6).
// ---------------------------------------------------------------------------

test('buildErrorResult: RUN_QUEUE_CAPACITY carries the exact design.md §6 hint', () => {
  const result = buildErrorResult('RUN_QUEUE_CAPACITY', 'no room to queue this turn');
  assert.equal(
    result.hint,
    'All run slots and the queue are full. Nothing was submitted; retry after running turns finish ' +
      '(opencode-info section "server" shows concurrency).',
  );
});

test('buildErrorResult: PROMPT_TOO_LARGE carries the exact design.md §6 hint', () => {
  const result = buildErrorResult('PROMPT_TOO_LARGE', 'estimated prompt size exceeds the model budget');
  assert.equal(
    result.hint,
    'The prompt alone does not fit the model. Nothing was submitted; split the task or pass a ' +
      'larger-context model (opencode-info section "models").',
  );
});

// ---------------------------------------------------------------------------
// (C) buildServerInstructions: content and length bounds (default + worst-case numbers + 0=unlimited).
// ---------------------------------------------------------------------------

test('buildServerInstructions: default config (4/64) builds in the real numbers and stays under 2048 chars', () => {
  const instructions = buildServerInstructions(baseConfig());
  assert.match(instructions, /Up to 4 turns run at once;/);
  assert.match(instructions, /extra turns queue \(max 64\)/);
  assert.match(instructions, /queue object is waiting for a run slot/);
  assert.match(instructions, /never resend it/);
  assert.match(instructions, /wait-seconds:0/);
  assert.match(instructions, /opencode-status ids/);
  assert.match(instructions, /usableInputTokens/);
  assert.match(instructions, /~8k/);
  assert.match(instructions, /CONTEXT_HIGH/);
  assert.match(instructions, /opencode-end the old one/);
  // The pre-existing pinned sentences (test/mcp/audit-u13.test.ts, overload-presentation.test.ts)
  // must still be present in the base text this function builds on.
  assert.match(instructions, /cancel/i);
  assert.match(instructions, /SESSION_BUSY/);
  assert.match(instructions, /CLEANUP_UNCONFIRMED/);
  assert.match(instructions, /error\.retryable describes a transient fault/);
  assert.ok(instructions.length < 2048, `expected < 2048 chars, got ${instructions.length}`);
});

test('buildServerInstructions: maxRunningTurns 0 says there is no cap instead of "0 turns"', () => {
  const instructions = buildServerInstructions(baseConfig({ maxRunningTurns: 0 }));
  assert.match(instructions, /Turns run without a run-slot cap;/);
  assert.doesNotMatch(instructions, /Up to 0 turns/);
  assert.ok(instructions.length < 2048);
});

test('buildServerInstructions: worst-case numbers (256 running / 1024 queued) still stay under 2048 chars', () => {
  const instructions = buildServerInstructions(baseConfig({ maxRunningTurns: 256, maxQueuedTurns: 1024 }));
  assert.match(instructions, /Up to 256 turns run at once;/);
  assert.match(instructions, /extra turns queue \(max 1024\)/);
  assert.ok(instructions.length < 2048, `expected < 2048 chars, got ${instructions.length}`);
});

test('buildServerInstructions: maxQueuedTurns 0 says there is no queue instead of "max 0"', () => {
  const instructions = buildServerInstructions(baseConfig({ maxQueuedTurns: 0 }));
  assert.match(instructions, /no queue: extra turns are rejected with RUN_QUEUE_CAPACITY/);
  assert.doesNotMatch(instructions, /extra turns queue \(max 0\)/);
  assert.ok(instructions.length < 2048, `expected < 2048 chars, got ${instructions.length}`);
});

// ---------------------------------------------------------------------------
// (D) Info formatting: models text mirror and a 32-entry/200-char-id worst case under budget.
// ---------------------------------------------------------------------------

test('formatResult (info, models): text mirror renders only the present fields, plus "(server default)"', () => {
  const info = baseInfo({
    section: 'models',
    models: [
      {
        model: 'corp/coding-model',
        providerId: 'corp',
        modelId: 'coding-model',
        defaultForProvider: true,
        limit: { context: 128_000, output: 4096 },
        usableInputTokens: 123_904,
        maxRunning: 2,
      },
      {
        model: 'corp/coder-32k',
        providerId: 'corp',
        modelId: 'coder-32k',
        defaultForProvider: false,
        serverDefault: true,
      },
    ],
  });
  const { text } = formatResult(info, { maxOutputChars: 20_000 });
  const lines = text.split('\n');
  assert.ok(lines.includes('corp/coding-model ctx=128000 out=4096 usable=123904 maxRunning=2'));
  assert.ok(lines.includes('corp/coder-32k (server default)'));
});

test('formatResult (info, server): renders a concurrency line and a limits line when the engine supplies them', () => {
  const info = baseInfo({
    section: 'server',
    server: {
      mcpVersion: '0.1.0',
      serverInstanceId: 'inst_1',
      mode: 'managed',
      remotePaths: false,
      connectionState: 'connected',
      opencodeVersion: '1.18.33',
      defaults: {
        cwd: '/work',
        model: null,
        agent: null,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        turnTimeoutSeconds: 600,
        maxTurnTimeoutSeconds: 3600,
        contextGuard: 'reject',
      },
      limits: {
        maxOutputChars: 20000,
        structuredContentBudget: 45000,
        maxWaitSeconds: 600,
        maxBatchIds: 16,
        outputRetention: { ttlSeconds: 3600, maxTurns: 128, maxBytes: 33554432 },
        requestIds: { maxRecords: 4096, ttlSeconds: 86400 },
        maxSessions: 256,
        maxRunningTurns: 4,
        maxQueuedTurns: 64,
        queueTimeoutSeconds: null,
      },
      concurrency: {
        running: 3,
        queued: 2,
        heldUnknown: 0,
        available: 1,
        perModel: [],
        perModelTotal: 0,
        perModelTruncated: false,
      },
      capabilities: ['run-queue', 'model-limits', 'context-usage'],
      sandboxEnforcement: 'permission-profile',
    },
  });
  const { text } = formatResult(info, { maxOutputChars: 20_000 });
  assert.match(text, /run slots: 3\/4 running, 2 queued, 0 held/);
  assert.match(text, /limits: maxRunningTurns=4 maxQueuedTurns=64 queueTimeoutSeconds=disabled/);
});

test('formatResult (info, server): unlimited maxRunningTurns renders as "unlimited" in both lines', () => {
  const info = baseInfo({
    section: 'server',
    server: {
      mcpVersion: '0.1.0',
      serverInstanceId: 'inst_1',
      mode: 'managed',
      remotePaths: false,
      connectionState: 'connected',
      opencodeVersion: '1.18.33',
      defaults: {
        cwd: '/work',
        model: null,
        agent: null,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        turnTimeoutSeconds: 600,
        maxTurnTimeoutSeconds: 3600,
      },
      limits: {
        maxOutputChars: 20000,
        structuredContentBudget: 45000,
        maxWaitSeconds: 600,
        maxBatchIds: 16,
        outputRetention: { ttlSeconds: 3600, maxTurns: 128, maxBytes: 33554432 },
        requestIds: { maxRecords: 4096, ttlSeconds: 86400 },
        maxRunningTurns: null,
        maxQueuedTurns: 64,
        queueTimeoutSeconds: 1800,
      },
      concurrency: { running: 5, queued: 0, heldUnknown: 0, available: null, perModel: [], perModelTotal: 0, perModelTruncated: false },
      capabilities: [],
      sandboxEnforcement: 'permission-profile',
    },
  });
  const { text } = formatResult(info, { maxOutputChars: 20_000 });
  assert.match(text, /run slots: 5\/unlimited running, 0 queued, 0 held/);
  assert.match(text, /limits: maxRunningTurns=unlimited maxQueuedTurns=64 queueTimeoutSeconds=1800/);
});

test('formatInfoResult: worst case — 32 perModel entries with 200-char model ids stays well under the 45,000-char budget', () => {
  const perModel = Array.from({ length: 32 }, (_, i) => ({
    model: `${'x'.repeat(190)}-${i}`,
    maxRunning: 4,
    running: i % 4,
    queued: 0,
  }));
  const info = baseInfo({
    section: 'server',
    server: {
      mcpVersion: '0.1.0',
      serverInstanceId: 'inst_1',
      mode: 'managed',
      remotePaths: false,
      connectionState: 'connected',
      opencodeVersion: '1.18.33',
      defaults: {
        cwd: '/work',
        model: null,
        agent: null,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        turnTimeoutSeconds: 600,
        maxTurnTimeoutSeconds: 3600,
      },
      limits: {
        maxOutputChars: 20000,
        structuredContentBudget: 45000,
        maxWaitSeconds: 600,
        maxBatchIds: 16,
        outputRetention: { ttlSeconds: 3600, maxTurns: 128, maxBytes: 33554432 },
        requestIds: { maxRecords: 4096, ttlSeconds: 86400 },
        maxRunningTurns: 4,
        maxQueuedTurns: 64,
        queueTimeoutSeconds: null,
      },
      concurrency: { running: 4, queued: 0, heldUnknown: 0, available: 0, perModel, perModelTotal: 32, perModelTruncated: false },
      capabilities: ['run-queue', 'model-limits', 'context-usage'],
      sandboxEnforcement: 'permission-profile',
    },
  });
  const { structuredContent, truncated } = formatResult(info, { maxOutputChars: 20_000 });
  assert.equal(truncated, false);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
  // Identifiers are never shortened: every 200-char model id survives intact.
  const serverOut = structuredContent.server as Record<string, unknown>;
  const perModelOut = (serverOut.concurrency as Record<string, unknown>).perModel as Array<Record<string, unknown>>;
  assert.equal(perModelOut.length, 32);
  assert.equal((perModelOut[0]?.model as string).length, 192);
});

test('formatInfoResult: worst case — 32 models entries with 200-char ids and full new fields stays well under budget', () => {
  const models = Array.from({ length: 32 }, (_, i) => ({
    model: `${'y'.repeat(190)}-${i}`,
    providerId: 'y'.repeat(100),
    modelId: `model-${i}`,
    defaultForProvider: i === 0,
    toolcall: true,
    limit: { context: 128_000, input: 100_000, output: 4096 },
    usableInputTokens: 123_904,
    limitSource: 'opencode' as const,
    maxRunning: 4,
    serverDefault: i === 0,
  }));
  const info = baseInfo({ section: 'models', models });
  const { structuredContent, truncated } = formatResult(info, { maxOutputChars: 20_000 });
  assert.equal(truncated, false);
  assert.ok(JSON.stringify(structuredContent).length < 45_000);
  assert.equal((structuredContent.models as unknown[]).length, 32);
});

// ---------------------------------------------------------------------------
// (E) Wire tests: stub engine's 'queued'/'context-high' scripts through the real call path.
// ---------------------------------------------------------------------------

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

test('wire: a queued start (stub mode "queued") comes back as status "running" with a queue object, and validates', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'queued', position: 2, running: 4, maxRunning: 4 }),
    'wait-seconds': 0,
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'running');
  assert.equal(result.structuredContent?.resendSafety, 'not_submitted');
  assert.deepEqual(result.structuredContent?.queue, {
    position: 2,
    running: 4,
    maxRunning: 4,
    blockedBy: 'global',
    queuedMs: 1500,
  });
  const parsed = outputSchema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('wire: a completed turn (stub mode "context-high") carries context/tokens.cache/CONTEXT_HIGH, and validates', async () => {
  const result = (await client.callTool('opencode', {
    prompt: JSON.stringify({ mode: 'context-high' }),
  })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.status, 'completed');
  const context = result.structuredContent?.context as Record<string, unknown>;
  assert.equal(context.model, 'corp/coding-model');
  assert.equal(context.ratio, 0.84);
  const tokens = result.structuredContent?.tokens as Record<string, unknown>;
  assert.deepEqual(tokens.cache, { read: 100, write: 50 });
  const warnings = result.structuredContent?.warnings as Array<Record<string, unknown>>;
  assert.equal(warnings[0]?.code, 'CONTEXT_HIGH');
  const parsed = outputSchema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('wire: opencode-info section "server" advertises the new capabilities/limits/concurrency/contextGuard', async () => {
  const result = (await client.callTool('opencode-info', { section: 'server' })) as CallToolResultShape;
  assert.notEqual(result.isError, true);
  const server = result.structuredContent?.server as Record<string, unknown>;
  assert.ok((server.capabilities as string[]).includes('run-queue'));
  assert.ok((server.capabilities as string[]).includes('model-limits'));
  assert.ok((server.capabilities as string[]).includes('context-usage'));
  const defaults = server.defaults as Record<string, unknown>;
  assert.equal(defaults.contextGuard, 'reject');
  const limits = server.limits as Record<string, unknown>;
  assert.equal(limits.maxRunningTurns, 4);
  assert.equal(limits.maxQueuedTurns, 64);
  const concurrency = server.concurrency as Record<string, unknown>;
  assert.equal(typeof concurrency.running, 'number');
  const parsed = outputSchema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

// ---------------------------------------------------------------------------
// (F) Descriptions carry the required guidance and stay under the 2048-char module-load check.
// ---------------------------------------------------------------------------

interface JsonSchemaProperty {
  description?: string;
  [key: string]: unknown;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonSchemaProperty> };
}

test('tools/list: opencode/opencode-reply/opencode-status/opencode-info descriptions mention the new guidance', async () => {
  const { result } = client.request('tools/list', {});
  const res = (await result) as { tools: Tool[] };
  const byName = new Map(res.tools.map((t) => [t.name, t.description]));

  const opencode = byName.get('opencode') ?? '';
  assert.match(opencode, /queue object/);
  assert.match(opencode, /PROMPT_TOO_LARGE/);
  assert.match(opencode, /usableInputTokens/);

  const reply = byName.get('opencode-reply') ?? '';
  assert.match(reply, /queue object/);
  assert.match(reply, /PROMPT_TOO_LARGE/);

  const status = byName.get('opencode-status') ?? '';
  assert.match(status, /not ready/);
  assert.match(status, /timeout-seconds/);

  const info = byName.get('opencode-info') ?? '';
  assert.match(info, /usableInputTokens/);
  assert.match(info, /maxRunning/);
  assert.match(info, /serverDefault/);
  assert.match(info, /concurrency/);

  const model = res.tools.find((t) => t.name === 'opencode')!.inputSchema.properties.model?.description ?? '';
  assert.match(model, /usableInputTokens/);

  const waitSeconds = res.tools.find((t) => t.name === 'opencode')!.inputSchema.properties['wait-seconds']?.description ?? '';
  assert.match(waitSeconds, /at once if the turn is queued/);

  for (const [name, desc] of byName) {
    assert.ok(desc.length < 2048, `${name}: description length ${desc.length} >= 2048`);
  }
});
