// Context-concurrency design §5.3/§5.4 (U4b): limits cache fed by warm-up, per-turn context
// usage/CONTEXT_HIGH, and the prompt-size guard. See test/core/run-queue.test.ts and
// test/core/f7-batch.test.ts for the FakeConnection/FakeClock conventions this file follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine.ts';
import { FakeConnection } from '../fakes/fake-api.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { buildContextResult, contextOverflowHint, summarizeInterval } from '../../src/core/result.ts';
import type { ContextUsage } from '../../src/core/result.ts';
import { resolveModelLimit } from '../../src/core/model-limits.ts';
import { OpencodeHttpError } from '../../src/types.ts';
import type { CallContext, Config, OcMessage, OcTokens } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const base = {
  mode: 'managed',
  defaultCwd: '/repo', allowedRoots: ['/repo', '/other'], remotePaths: true,
  defaultSandbox: 'workspace-write', defaultApprovalPolicy: 'never',
  startupTimeoutMs: 5_000, turnTimeoutMs: 60_000, maxTurnTimeoutMs: 60_000,
  approvalTimeoutMs: 1_000, heartbeatMs: 100, statusPollMs: 100,
  sseStallMs: 1_000, cleanupTimeoutMs: 2_000, maxOutputChars: 2_000,
  readRetryAttempts: 1,
  maxSessions: 20, maxRunningTurns: 8, maxQueuedTurns: 8, queueTimeoutMs: 0,
  modelProfiles: {}, contextGuard: 'reject', endAction: 'delete', onExit: 'abort',
} as Config;

const ctx = (): CallContext => ({ signal: new AbortController().signal });
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };

function setup(overrides: Partial<Config> = {}) {
  const connection = new FakeConnection();
  const clock = new FakeClock();
  const config = { ...base, ...overrides };
  const engine = createEngine({ config, connection, clock, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { engine, connection, clock, config,
    calls: (method: string) => connection.api.calls.filter((call) => call.method === method).length };
}

/** `connected:['corp']` provider catalog with the given per-model limits. */
function catalogFor(models: Record<string, { context?: number; input?: number; output?: number }>): unknown {
  return {
    connected: ['corp'],
    all: [{ id: 'corp', models: Object.fromEntries(Object.entries(models).map(([id, limit]) => [id, { limit }])) }],
    default: {},
  };
}

function msg(sessionID: string, id: string, role: 'user' | 'assistant', opts: {
  parentID?: string; finish?: string; text?: string; providerID?: string; modelID?: string;
  tokens?: OcTokens; error?: { name: string; data?: { message?: string } }; summary?: boolean;
} = {}): OcMessage {
  return {
    info: {
      id, sessionID, role,
      ...(opts.parentID ? { parentID: opts.parentID } : {}),
      ...(opts.finish ? { finish: opts.finish } : {}),
      ...(opts.providerID ? { providerID: opts.providerID } : {}),
      ...(opts.modelID ? { modelID: opts.modelID } : {}),
      ...(opts.tokens ? { tokens: opts.tokens } : {}),
      ...(opts.error ? { error: opts.error } : {}),
      ...(opts.summary ? { summary: true } : {}),
      time: { created: 0, ...(opts.finish || opts.error ? { completed: 1 } : {}) },
    },
    parts: opts.text !== undefined ? [{ id: `p${id}`, sessionID, messageID: id, type: 'text', text: opts.text }] : [],
  };
}

/** Standard onPrompt: records the user message and marks the session busy; pair with `finishTurn`. */
function armBusyPrompt(s: ReturnType<typeof setup>): void {
  s.connection.api.onPrompt = (id) => {
    const history = s.connection.api.histories.get(id)!;
    history.push(msg(id, `m${history.length + 1}`, 'user'));
    s.connection.api.statuses.set(id, { type: 'busy' });
  };
}

async function finishTurn(
  s: ReturnType<typeof setup>,
  sessionId: string,
  assistant: { finish?: string; text?: string; providerID?: string; modelID?: string; tokens?: OcTokens } = {},
): Promise<void> {
  const history = s.connection.api.histories.get(sessionId)!;
  const user = [...history].reverse().find((m) => m.info.role === 'user')!;
  history.push(msg(sessionId, `m${history.length + 1}`, 'assistant',
    { parentID: user.info.id, finish: 'stop', text: 'ok', ...assistant }));
  s.connection.api.statuses.delete(sessionId);
  const directory = s.connection.api.sessions.get(sessionId)!.directory;
  s.connection.api.emit(directory, { type: 'session.idle', properties: { sessionID: sessionId } });
  await flush();
}

const LARGE_PROMPT = 'a'.repeat(4_000); // estimatePromptTokens ~= 1000

// ---------------------------------------------------------------------------
// pure: summarizeInterval's context-usage observation and tokens.cache
// ---------------------------------------------------------------------------

test('summarizeInterval: context usage is the last non-summary assistant with both ids; a compaction summary assistant is excluded; total wins over the summed fallback; peakUsed is the max', () => {
  const messages: OcMessage[] = [
    msg('s', 'a1', 'assistant', { providerID: 'corp', modelID: 'one', tokens: { input: 1, output: 1, reasoning: 0, total: 500 } }),
    msg('s', 'a2', 'assistant', { summary: true, providerID: 'corp', modelID: 'summarizer',
      tokens: { input: 1, output: 1, reasoning: 0, total: 999_999 } }),
    msg('s', 'a3', 'assistant', { providerID: 'corp', modelID: 'one', tokens: { input: 200, output: 20, reasoning: 0 } }),
  ];
  const result = summarizeInterval(messages, '/repo', 2_000);
  assert.deepEqual(result.contextUsage, { model: 'corp/one', used: 220, peakUsed: 500 });
});

test('summarizeInterval: a later non-summary assistant without usage leaves "used" absent, never falling back to an earlier assistant', () => {
  const messages: OcMessage[] = [
    msg('s', 'a1', 'assistant', { providerID: 'corp', modelID: 'one', tokens: { input: 1, output: 1, reasoning: 0, total: 500 } }),
    msg('s', 'a2', 'assistant', { providerID: 'corp', modelID: 'one' }),
  ];
  const result = summarizeInterval(messages, '/repo', 2_000);
  assert.equal(result.contextUsage?.model, 'corp/one');
  assert.equal(result.contextUsage?.used, undefined);
  assert.equal(result.contextUsage?.peakUsed, 500);
});

test('summarizeInterval: no context usage when no non-summary assistant reports both provider/model ids', () => {
  const messages: OcMessage[] = [msg('s', 'a1', 'assistant', { tokens: { input: 1, output: 1, reasoning: 0, total: 5 } })];
  assert.equal(summarizeInterval(messages, '/repo', 2_000).contextUsage, undefined);
});

test('summarizeInterval: tokens.cache sums cache.read/write across assistants only when any assistant reported cache', () => {
  const withCache: OcMessage[] = [
    msg('s', 'a1', 'assistant', { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 20 } } }),
    msg('s', 'a2', 'assistant', { tokens: { input: 10, output: 5, reasoning: 0 } }),
  ];
  assert.deepEqual(summarizeInterval(withCache, '/repo', 2_000).tokens,
    { input: 20, output: 10, reasoning: 0, cache: { read: 100, write: 20 } });

  const withoutCache: OcMessage[] = [msg('s', 'a1', 'assistant', { tokens: { input: 10, output: 5, reasoning: 0 } })];
  assert.equal(summarizeInterval(withoutCache, '/repo', 2_000).tokens?.cache, undefined);
});

// ---------------------------------------------------------------------------
// pure: buildContextResult (ratio/limitSource, CONTEXT_HIGH threshold, warning cap, hint suffix)
// ---------------------------------------------------------------------------

test('buildContextResult: usableInputTokens/limitSource/ratio reflect the resolved limit (opencode, profile, mixed)', () => {
  const usage: ContextUsage = { model: 'corp/one', used: 100 };
  const opencodeOnly = resolveModelLimit('corp/one', { context: 1000, output: 100 }, undefined)!;
  const r1 = buildContextResult(usage, false, opencodeOnly, undefined, 'base');
  assert.equal(r1.context?.limitSource, 'opencode');
  assert.equal(r1.context?.usableInputTokens, 900);
  assert.equal(r1.context?.ratio, Math.round((100 / 900) * 1000) / 1000);
  assert.equal(r1.context?.compacted, false);

  const profileOnly = resolveModelLimit('corp/one', undefined, { context: 500, output: 50 })!;
  assert.equal(buildContextResult(usage, false, profileOnly, undefined, 'base').context?.limitSource, 'profile');

  const mixed = resolveModelLimit('corp/one', { context: 1000, output: 100 }, { output: 50 })!;
  assert.equal(buildContextResult(usage, false, mixed, undefined, 'base').context?.limitSource, 'mixed');

  // No resolved limit at all: usableInputTokens/limitSource/ratio all absent.
  const none = buildContextResult(usage, false, undefined, undefined, 'base');
  assert.equal(none.context?.usableInputTokens, undefined);
  assert.equal(none.context?.limitSource, undefined);
  assert.equal(none.context?.ratio, undefined);
});

test('buildContextResult: CONTEXT_HIGH fires at an unrounded ratio >= 0.8 and not at 0.79; appended last, existing codes kept first, capped at 3', () => {
  const resolved = resolveModelLimit('corp/one', { context: 1000, output: 100 }, undefined)!; // usable 900
  const existing = [{ code: 'TRUNCATED' as const, message: 'truncated' }, { code: 'EMPTY_RESPONSE' as const, message: 'empty' }];

  const below = buildContextResult({ model: 'corp/one', used: 711 }, false, resolved, undefined, 'hint'); // 711/900 = 0.79
  assert.equal(below.warnings, undefined);
  assert.equal(below.hint, 'hint');

  const at = buildContextResult({ model: 'corp/one', used: 720 }, false, resolved, existing, 'hint'); // 720/900 = 0.80
  assert.equal(at.warnings?.length, 3);
  assert.deepEqual(at.warnings?.map((w) => w.code), ['TRUNCATED', 'EMPTY_RESPONSE', 'CONTEXT_HIGH']);
  assert.match(at.warnings![2]!.message, /Last reported context usage is 80% of corp\/one's budget \(720 of 900 tokens\)\./);
  assert.equal(at.hint, 'hint Context is nearly full; continue in a new opencode session with a self-contained prompt and opencode-end this one.');

  const overflowing = [
    { code: 'TRUNCATED' as const, message: 'a' }, { code: 'EMPTY_RESPONSE' as const, message: 'b' },
    { code: 'NONSTANDARD_FINISH' as const, message: 'c' },
  ];
  const stillFits = buildContextResult({ model: 'corp/one', used: 900 }, false, resolved, overflowing, 'hint');
  assert.equal(stillFits.warnings?.length, 3);
  assert.deepEqual(stillFits.warnings?.map((w) => w.code), ['TRUNCATED', 'EMPTY_RESPONSE', 'CONTEXT_HIGH']);
});

test('buildContextResult: the CONTEXT_HIGH hint gets the profile-source suffix only when limitSource is profile', () => {
  const profile = resolveModelLimit('corp/one', undefined, { context: 1000, output: 100 })!;
  const r = buildContextResult({ model: 'corp/one', used: 950 }, false, profile, undefined, 'hint');
  assert.ok(r.hint.endsWith('If OpenCode itself has no context limit configured for this model, it will not compact proactively.'));

  const opencode = resolveModelLimit('corp/one', { context: 1000, output: 100 }, undefined)!;
  const r2 = buildContextResult({ model: 'corp/one', used: 950 }, false, opencode, undefined, 'hint');
  assert.equal(r2.hint.includes('no context limit configured'), false);
});

test('buildContextResult: returns the base hint/warnings unchanged when there is no context observation', () => {
  const warnings = [{ code: 'TRUNCATED' as const, message: 'x' }];
  assert.deepEqual(buildContextResult(undefined, false, undefined, warnings, 'hint'), { warnings, hint: 'hint' });
});

test('contextOverflowHint wording', () => {
  assert.equal(
    contextOverflowHint('corp/one'),
    'The prompt or session history exceeded corp/one\'s context window. Split the task, start a new session, or choose a larger-context model (opencode-info section "models").',
  );
});

// ---------------------------------------------------------------------------
// engine: limits cache fed by warm-up (no extra request), invalidation epoch, TTL, profiles
// ---------------------------------------------------------------------------

test('a successful warm-up populates the limits cache from its own /provider body, with no extra request', async () => {
  const s = setup();
  armBusyPrompt(s);
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  const first = await s.engine.start({ prompt: 'hi', model: 'corp/one', waitSeconds: 0 }, ctx());
  await finishTurn(s, first.sessionId);
  assert.equal(s.calls('warmInstance'), 1);
  assert.equal(s.calls('providerCatalog'), 0);
  // The cache now holds usable=900 for corp/one: a reply whose prompt alone exceeds it is
  // rejected at the synchronous pre-check (no extra warm/providerCatalog calls either).
  await assert.rejects(
    s.engine.reply({ sessionId: first.sessionId, prompt: LARGE_PROMPT, waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
  );
  assert.equal(s.calls('warmInstance'), 1);
  assert.equal(s.calls('providerCatalog'), 0);
});

test('TTL: a cached limit stops applying 60s after it was stored', async () => {
  const s = setup();
  armBusyPrompt(s);
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  const first = await s.engine.start({ prompt: 'hi', model: 'corp/one', waitSeconds: 0 }, ctx());
  await finishTurn(s, first.sessionId);

  await assert.rejects(
    s.engine.reply({ sessionId: first.sessionId, prompt: LARGE_PROMPT, waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
    'the cache should still be fresh right after the warm-up',
  );

  s.clock.tick(60_001);
  await assert.doesNotReject(
    s.engine.reply({ sessionId: first.sessionId, prompt: LARGE_PROMPT, waitSeconds: 0 }, ctx()),
    'an expired cache entry must not be used by the pre-check',
  );
});

test('invalidation epoch: a warm that started before an invalidation does not repopulate the cache after it', async () => {
  const s = setup();
  // '/repo' always warms immediately with an empty catalog. '/other' is gated on its FIRST call
  // only (turn B's); any later call for '/other' (a fresh, post-epoch-bump warm) resolves at once.
  let releaseOther: ((v: { providerCatalog: unknown }) => void) | undefined;
  let otherCalls = 0;
  s.connection.api.warmInstance = async (directory, req) => {
    s.connection.api.calls.push({ method: 'warmInstance', args: [directory, req] });
    if (directory === '/other') {
      otherCalls++;
      if (otherCalls === 1) return new Promise((resolve) => { releaseOther = resolve; });
    }
    return { providerCatalog: { connected: [], all: [], default: {} } };
  };
  s.connection.api.onPrompt = (id) => {
    const session = s.connection.api.sessions.get(id)!;
    const history = s.connection.api.histories.get(id)!;
    if (session.directory === '/repo') {
      const userId = `m${history.length + 1}`;
      const assistantId = `m${history.length + 2}`;
      const error = { name: 'UnknownError', data: { message: 'All fibers interrupted without error' } };
      history.push(msg(id, userId, 'user'), msg(id, assistantId, 'assistant', { error }));
      s.connection.api.emit('/repo', { type: 'session.error', properties: { sessionID: id, error } });
      return;
    }
    history.push(msg(id, `m${history.length + 1}`, 'user'));
    s.connection.api.statuses.set(id, { type: 'busy' });
  };

  // Start turn B's warm-up for '/other' (gated) and let it register before continuing.
  const pendingB = s.engine.start({ prompt: 'small-b', cwd: '/other', model: 'corp/one', waitSeconds: 0 }, ctx());
  await flush();
  assert.equal(s.calls('warmInstance'), 1, "turn B's own warm-up should already have started");

  // Fully run a poisoning cycle for '/repo', which invalidates the (global) limits-cache epoch.
  const poisoned = await s.engine.start({ prompt: 'poison', cwd: '/repo' }, ctx());
  assert.equal(poisoned.error?.name, 'UnknownError');
  assert.equal(s.connection.api.calls.some((c) => c.method === 'disposeInstance'), true);

  // Now let turn B's warm-up resolve, late, with a catalog that WOULD exceed a large prompt.
  assert.equal(releaseOther !== undefined, true, "turn B's warm-up must still be the one in flight");
  releaseOther!({ providerCatalog: catalogFor({ one: { context: 1_000, output: 100 } }) });
  await flush();
  await pendingB.catch(() => {});

  // The late write must have been skipped: a start in '/other' with a huge prompt is NOT rejected
  // at the synchronous pre-check (which runs before this turn's own, fresh warm-up).
  await assert.doesNotReject(
    s.engine.start({ prompt: LARGE_PROMPT, cwd: '/other', model: 'corp/one', waitSeconds: 0 }, ctx()),
    'the epoch guard should have prevented the late warm-up from repopulating the cache',
  );
});

test('profiles apply to the guard even with a cold cache (no warm-up has ever run)', async () => {
  const s = setup({ modelProfiles: { 'corp/two': { context: 500, output: 50 } } }); // usable 450
  await assert.rejects(
    s.engine.start({ prompt: LARGE_PROMPT, model: 'corp/two', waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
  );
  assert.equal(s.calls('warmInstance'), 0);
  assert.equal(s.calls('createSession'), 0);
});

// ---------------------------------------------------------------------------
// engine: prompt-size guard pre-check (start/reply), guard off, estimate composition
// ---------------------------------------------------------------------------

test('PROMPT_TOO_LARGE pre-check on start: no createSession, request-id freed, capacity freed', async () => {
  const s = setup({ maxSessions: 1, modelProfiles: { 'corp/two': { context: 500, output: 50 } } });
  await assert.rejects(
    s.engine.start({ prompt: LARGE_PROMPT, model: 'corp/two', requestId: 'req-1', waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE', message: /~1000 tokens.*450 tokens/ },
  );
  assert.equal(s.calls('createSession'), 0);
  // Capacity was freed: with maxSessions:1, a fresh start still fits.
  armBusyPrompt(s);
  const retry = await s.engine.start({ prompt: 'small', requestId: 'req-1', waitSeconds: 0 }, ctx());
  assert.equal(retry.status, 'running');
});

test('PROMPT_TOO_LARGE pre-check on reply: session stays idle, model/agent unchanged, can reply again', async () => {
  const s = setup({ modelProfiles: { 'corp/two': { context: 500, output: 50 } } });
  armBusyPrompt(s);
  const first = await s.engine.start({ prompt: 'hi', model: 'x/y', agent: 'planner', waitSeconds: 0 }, ctx());
  await finishTurn(s, first.sessionId);

  await assert.rejects(
    s.engine.reply({ sessionId: first.sessionId, prompt: LARGE_PROMPT, model: 'corp/two', agent: 'other', waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
  );

  // The session stayed idle and untouched: another reply (no model override) succeeds immediately
  // and reports the ORIGINAL model, proving the rejected attempt never mutated the entry.
  const again = await s.engine.reply({ sessionId: first.sessionId, prompt: 'small', waitSeconds: 0 }, ctx());
  assert.equal(again.status, 'running');
  assert.equal(again.model, 'x/y');
  assert.equal(again.agent, 'planner');
});

test('contextGuard "off" disables the pre-check even when a profile would otherwise reject', async () => {
  const s = setup({ contextGuard: 'off', modelProfiles: { 'corp/two': { context: 500, output: 50 } } });
  const result = await s.engine.start({ prompt: LARGE_PROMPT, model: 'corp/two', waitSeconds: 0 }, ctx());
  assert.equal(result.status, 'running');
});

test('the guard measures prompt + developer instructions + structured-output instructions, not the prompt alone', async () => {
  const s = setup({ modelProfiles: { 'corp/two': { context: 500, output: 50 } } }); // usable 450
  await assert.doesNotReject(
    s.engine.start({ prompt: 'short prompt', model: 'corp/two', waitSeconds: 0 }, ctx()),
    'the small prompt alone must fit',
  );
  await assert.rejects(
    s.engine.start({ prompt: 'short prompt', model: 'corp/two',
      developerInstructions: 'd'.repeat(2_000), waitSeconds: 0 }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
    'developer instructions must count toward the estimate',
  );
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 15; i++) properties[`field${i}`] = { type: 'string', description: 'x'.repeat(100) };
  await assert.rejects(
    s.engine.start({ prompt: 'short prompt', model: 'corp/two', waitSeconds: 0,
      outputSchema: { type: 'object', additionalProperties: false, properties } }, ctx()),
    { code: 'PROMPT_TOO_LARGE' },
    'the structured-output instruction text must count toward the estimate',
  );
});

test('in-turn fallback catches PROMPT_TOO_LARGE when the pre-check cache was cold: no prompt POST, failed/not_submitted/stopped', async () => {
  const s = setup();
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  // The very first call in a fresh engine: the pre-check sees no connection generation yet and no
  // profile, so it skips; the in-turn check (after this turn's own warm-up) must catch it instead.
  const result = await s.engine.start({ prompt: LARGE_PROMPT, model: 'corp/one' }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'PROMPT_TOO_LARGE');
  assert.equal(result.resendSafety, 'not_submitted');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
  assert.equal(s.calls('promptAsync'), 0);
  assert.equal(s.calls('warmInstance'), 1);
});

test('in-turn fallback catches PROMPT_TOO_LARGE on a reply once the limits cache has gone cold (TTL expiry)', async () => {
  const s = setup();
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  armBusyPrompt(s);
  const first = await s.engine.start({ prompt: 'hi', model: 'corp/one', waitSeconds: 0 }, ctx());
  await finishTurn(s, first.sessionId);
  assert.equal(s.calls('warmInstance'), 1);

  // Let the limits cache entry (60s TTL) expire: the reply's own synchronous pre-check then sees
  // no usable budget and skips, exactly the "cold cache" condition the in-turn fallback is for.
  s.clock.tick(60_000);

  const result = await s.engine.reply({ sessionId: first.sessionId, prompt: LARGE_PROMPT }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.name, 'PROMPT_TOO_LARGE');
  assert.equal(result.resendSafety, 'not_submitted');
  assert.equal(result.executionState, 'stopped');
  assert.equal(result.cleanup, 'complete');
  // Still 1 (from the first turn's own successful submission): the rejected reply's prompt itself
  // must never have reached promptAsync.
  assert.equal(s.calls('promptAsync'), 1);
  assert.equal(s.calls('warmInstance'), 2, "the reply's own warm-up must have run and repopulated the cache");

  // The session stayed idle and untouched: a normal reply still works afterward.
  const again = await s.engine.reply({ sessionId: first.sessionId, prompt: 'small', waitSeconds: 0 }, ctx());
  assert.equal(again.status, 'running');
});

// ---------------------------------------------------------------------------
// engine: ContextOverflowError hint, and a recovered overflow stays completed
// ---------------------------------------------------------------------------

test('a final ContextOverflowError failure gets the context-window hint', async () => {
  const s = setup();
  armBusyPrompt(s);
  const first = await s.engine.start({ prompt: 'hi', model: 'corp/one', waitSeconds: 0 }, ctx());
  const history = s.connection.api.histories.get(first.sessionId)!;
  const user = [...history].reverse().find((m) => m.info.role === 'user')!;
  history.push(msg(first.sessionId, `m${history.length + 1}`, 'assistant',
    { parentID: user.info.id, error: { name: 'ContextOverflowError', data: { message: 'too big' } } }));
  s.connection.api.statuses.delete(first.sessionId);
  s.connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: first.sessionId } });
  await flush();
  const status = await s.engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.status, 'failed');
  assert.equal(status.error?.name, 'ContextOverflowError');
  assert.equal(status.hint, contextOverflowHint('corp/one'));
});

test('a recovered overflow (session.error ContextOverflowError + compaction + a successful final assistant) stays completed', async () => {
  const s = setup();
  armBusyPrompt(s);
  const first = await s.engine.start({ prompt: 'hi', waitSeconds: 0 }, ctx());
  const history = s.connection.api.histories.get(first.sessionId)!;
  const rootUser = [...history].reverse().find((m) => m.info.role === 'user')!;
  // The failing assistant: no finish, no error recorded on the message itself (matches the probe),
  // but a session.error ContextOverflowError event is still emitted.
  history.push(msg(first.sessionId, 'm_err', 'assistant', { parentID: rootUser.info.id }));
  s.connection.api.emit('/repo', {
    type: 'session.error',
    properties: { sessionID: first.sessionId, error: { name: 'ContextOverflowError', data: { message: 'overflow' } } },
  });
  await flush();
  // Compaction: a summary assistant, then a synthetic continue user, then a successful final assistant.
  history.push(
    msg(first.sessionId, 'm_summary', 'assistant', { parentID: rootUser.info.id, finish: 'stop', summary: true }),
    msg(first.sessionId, 'm_continue_user', 'user', { parentID: rootUser.info.id }),
    msg(first.sessionId, 'm_final', 'assistant', { parentID: 'm_continue_user', finish: 'stop', text: 'continuing' }),
  );
  s.connection.api.statuses.delete(first.sessionId);
  s.connection.api.emit('/repo', { type: 'session.idle', properties: { sessionID: first.sessionId } });
  await flush();
  const status = await s.engine.status({ sessionId: first.sessionId, waitSeconds: 0 }, ctx());
  assert.equal(status.status, 'completed');
  assert.equal(status.error, undefined);
});

// ---------------------------------------------------------------------------
// batch item and quarantine recovery carry context
// ---------------------------------------------------------------------------

test('a batch item carries context for a completed turn', async () => {
  const s = setup();
  armBusyPrompt(s);
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  const first = await s.engine.start({ prompt: 'hi', model: 'corp/one', waitSeconds: 0 }, ctx());
  await finishTurn(s, first.sessionId, { providerID: 'corp', modelID: 'one', tokens: { input: 850, output: 20, reasoning: 0 } });
  const batch = await s.engine.statusMany({ ids: [first.sessionId], waitSeconds: 0 }, ctx());
  assert.equal(batch.results[0]?.context?.model, 'corp/one');
  assert.equal(batch.results[0]?.context?.used, 870);
});

test('quarantine recovery recomputes context from the recovered interval', async () => {
  // No onPrompt is armed (matching test/core/round5.test.ts's F3 pattern): promptAsync records the
  // call but writes no history, so sessionStatus stays idle and the turn waits on no-user grace
  // (scheduled, never fired, since the clock is never ticked) until the ambiguous abort below.
  const s = setup();
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  const first = await s.engine.start({ prompt: 'first', model: 'corp/one', waitSeconds: 0 }, ctx());
  s.connection.api.abort = async () => { throw new OpencodeHttpError('lost', 0, 'NetworkError'); };
  const cancelled = await s.engine.cancel({ sessionId: first.sessionId }, ctx());
  assert.equal(cancelled.executionState, 'unknown');

  // The prompt execution turns out to have happened after all: push the root user and a
  // successful final assistant directly, simulating evidence that only now becomes visible.
  s.connection.api.histories.get(first.sessionId)!.push(
    msg(first.sessionId, 'm01', 'user'),
    msg(first.sessionId, 'm02', 'assistant', {
      parentID: 'm01', finish: 'stop', text: 'done',
      providerID: 'corp', modelID: 'one', tokens: { input: 850, output: 20, reasoning: 0 },
    }),
  );
  // The settled-but-ambiguous abort marker blocks quiescence confirmation for a bounded
  // late-landing window (engine.ts's hasAbort/abortWindowMs, mirrored by
  // test/core/round5.test.ts's F3 tests); advance past it so status() can recompute.
  s.clock.tick(60_001);

  const status = await s.engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(status.executionState, 'stopped');
  assert.equal(status.status, 'completed');
  assert.equal(status.context?.model, 'corp/one');
  assert.equal(status.context?.used, 870);
});

test('quarantine recovery REPLACES a stale CONTEXT_HIGH warning/context, not merges it, once the recovered interval shows low usage', async () => {
  const s = setup();
  s.connection.api.providerResponse = catalogFor({ one: { context: 1_000, output: 100 } });
  armBusyPrompt(s);
  const first = await s.engine.start({ prompt: 'first', model: 'corp/one', waitSeconds: 0 }, ctx());

  // While the session still reports busy, a terminal HIGH-usage assistant lands in history. The
  // poll-driven reconcile reads it into the Turn's own interval (buildSummary/contextUsage do not
  // require idle), but classifyOutcome keeps the turn 'running' while busy, so it never finishes.
  const history = s.connection.api.histories.get(first.sessionId)!;
  const user = [...history].reverse().find((m) => m.info.role === 'user')!;
  history.push(msg(first.sessionId, 'm_high', 'assistant', {
    parentID: user.info.id, finish: 'stop', text: 'high',
    providerID: 'corp', modelID: 'one', tokens: { input: 850, output: 20, reasoning: 0 },
  }));
  s.clock.tick(150);
  await flush();

  // Cancel while still busy: the abort is ambiguous (lost response), so finish() runs with the
  // high-usage assistant already in the interval — entry.last already carries ratio>=0.8 and
  // CONTEXT_HIGH, exactly the stale state this regression guards against.
  s.connection.api.abort = async () => { throw new OpencodeHttpError('lost', 0, 'NetworkError'); };
  const cancelled = await s.engine.cancel({ sessionId: first.sessionId }, ctx());
  assert.equal(cancelled.executionState, 'unknown');
  assert.ok((cancelled.context?.ratio ?? 0) >= 0.8);
  assert.ok(cancelled.warnings?.some((warning) => warning.code === 'CONTEXT_HIGH'));
  assert.ok(cancelled.hint.includes('Context is nearly full'));

  // New evidence supersedes it: the session is actually idle, and the real final assistant used
  // far less of the budget.
  s.connection.api.statuses.delete(first.sessionId);
  history.push(msg(first.sessionId, 'm_low', 'assistant', {
    parentID: user.info.id, finish: 'stop', text: 'low',
    providerID: 'corp', modelID: 'one', tokens: { input: 100, output: 10, reasoning: 0 },
  }));
  // Past the ambiguous-abort marker's late-landing window (see the previous test's comment). That
  // window (60s) is the same length as the limits cache TTL, so the cache populated by this turn's
  // own warm-up (~0ms in) has also just gone cold; refresh it via an unrelated turn in the same
  // directory so the recovery below can still resolve a usable budget for the low-usage assistant.
  s.clock.tick(60_001);
  const refresh = await s.engine.start({ prompt: 'refresh', model: 'corp/one', waitSeconds: 0 }, ctx());
  await finishTurn(s, refresh.sessionId);

  const status = await s.engine.status({ sessionId: first.sessionId }, ctx());
  assert.equal(status.executionState, 'stopped');
  assert.equal(status.status, 'completed');
  assert.equal(status.context?.used, 110);
  assert.equal(status.context?.ratio, Math.round((110 / 900) * 1000) / 1000);
  assert.ok(!status.warnings?.some((warning) => warning.code === 'CONTEXT_HIGH'));
  assert.ok(!status.hint.includes('Context is nearly full'));
});
