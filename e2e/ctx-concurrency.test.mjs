// Hermetic e2e scenarios for the context-aware model assignment + run-slot concurrency cap work
// (docs/design.md §13), against the REAL opencode-ai@1.18.33 binary. Own `run-e2e.sh` step
// (like features.test.mjs/overload.test.mjs) so it gets its own PASS/FAIL/SKIP line and TAP
// accounting, and never re-runs (or is re-run by) scenarios.test.mjs/features.test.mjs/
// overload.test.mjs.
//
// Deliberately does NOT import any other e2e/*.test.mjs file: each registers its own top-level
// `test(...)` scenarios at module-evaluation time, so importing one here would re-run it inside
// THIS file's `node --test` process too. The handful of setup helpers this file needs are
// therefore duplicated (not re-exported) from e2e/scenarios.test.mjs, kept intentionally tiny;
// e2e/lib/harness.mjs remains the single shared, side-effect-free source for the actual process/
// repo/fake-LLM plumbing.
//
// Letters a-g below are this file's own scenario list:
//   a. opencode-info models/server: per-model limit/usableInputTokens/limitSource/maxRunning, and
//      server limits/concurrency/capabilities.
//   b. PROMPT_TOO_LARGE pre-check: a prompt that cannot fit the model is rejected before any
//      upstream submission; OPENCODE_MCP_CONTEXT_GUARD=off still submits it.
//   c. Per-turn context usage: a USAGE directive drives context.used/usableInputTokens/ratio and a
//      CONTEXT_HIGH warning near budget.
//   d. Run-slot cap: OPENCODE_MCP_MAX_RUNNING_TURNS queues extra starts; all complete; the fake LLM
//      never runs more build turns at once than the cap allows.
//   e. Cancelling a queued turn never submits its prompt; the running turn it was queued behind
//      still completes.
//   f. A per-model `maxRunning` profile queues the second same-model turn while a different model
//      keeps running.
//   g. Large-catalog regression: an OpenCode config WITHOUT `enabled_providers` (so /provider is
//      ~6 MiB from the bundled models.dev snapshot) still works end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpClient } from './lib/mcp-client.mjs';
import { createTempRepo, startFakeLlm, buildOpencodeConfig, baseServerEnv, waitForFakeLlmRequest } from './lib/harness.mjs';

// Generous but bounded: every scenario here is bounded by a handful of short SLOW_REPLY windows
// (2-3s each) or a single normal turn; none approaches this budget.
const SCENARIO_TIMEOUT_MS = 90_000;

/** Sets up one scenario's temp repo + fake LLM + connected client (duplicated from
 * e2e/scenarios.test.mjs's own setupScenario — see this file's header comment for why). Always
 * call `ctx.teardown()` (register via `t.after`) even on failure, so temp dirs/processes never
 * leak between tests.
 * @param {object} [opts]
 * @param {object} [opts.extraEnv] additional/overriding OPENCODE_MCP_* env entries (e.g.
 *   OPENCODE_MCP_MAX_RUNNING_TURNS, OPENCODE_MCP_MODEL_PROFILES, OPENCODE_MCP_CONTEXT_GUARD).
 * @param {Array} [opts.models] forwarded to buildOpencodeConfig's own `models` option.
 * @param {boolean} [opts.omitEnabledProviders] forwarded to buildOpencodeConfig.
 */
async function setupScenario(label, { extraEnv, models, omitEnabledProviders } = {}) {
  const repo = createTempRepo(label);
  const fakeLlm = await startFakeLlm({ label });
  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl, models, omitEnabledProviders });
  const env = baseServerEnv({ cwd: repo.dir, configContent, extra: extraEnv });
  const client = await McpClient.connect({ cwd: repo.dir, env, initializeTimeoutMs: 20_000 });

  async function teardown() {
    try {
      await client.closeAndWait(15_000);
    } catch {
      client.kill('SIGKILL');
    }
    await fakeLlm.stop();
    repo.cleanup();
  }

  return { repo, fakeLlm, client, env, teardown };
}

/** Asserts the MCP-level isError flag, then returns structuredContent for further assertions
 * (duplicated from e2e/scenarios.test.mjs — see this file's header comment for why). */
function unwrap(result, { expectError = false } = {}) {
  const sc = result.structuredContent;
  const turnFailure = sc?.kind === 'turn' && (sc.status === 'failed' || sc.status === 'timeout');
  assert.equal(
    Boolean(result.isError),
    expectError || turnFailure,
    `expected isError=${expectError || turnFailure}, got content=${JSON.stringify(result.content)}`,
  );
  assert.ok(result.structuredContent, 'expected structuredContent to be present');
  return result.structuredContent;
}

/** Build-agent (tool-bearing) requests only, excluding OpenCode's own title/summary calls — same
 * convention e2e/overload.test.mjs's header comment documents and e2e/features.test.mjs relies on
 * (OpenCode never sends `tools` on a title/summary call). */
function buildRequests(reqs) {
  return reqs.filter((r) => Array.isArray(r.tools) && r.tools.length > 0);
}

// ---------------------------------------------------------------------------
// a. opencode-info models/server: per-model limit/usableInputTokens/limitSource/maxRunning, and
//    server limits/concurrency/capabilities.
// ---------------------------------------------------------------------------

test(
  'a: opencode-info models/server report per-model limits, usableInputTokens, limitSource, maxRunning, and server concurrency/capabilities',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('models-info', {
      models: [
        { id: 'small', limit: { context: 16000, output: 2000 } },
        { id: 'large', limit: { context: 200000, output: 8000 } },
        { id: 'noprofile' }, // no `limit` in OpenCode at all; given one only via a profile below
      ],
      extraEnv: {
        OPENCODE_MCP_MODEL_PROFILES: JSON.stringify({
          'fake/noprofile': { context: 32768, output: 4096, maxRunning: 1 },
        }),
      },
    });
    t.after(ctx.teardown);
    const { client } = ctx;

    const models = unwrap(await client.callTool('opencode-info', { section: 'models' }));
    assert.equal(models.section, 'models');
    const byModel = Object.fromEntries((models.models ?? []).map((m) => [m.model, m]));

    const small = byModel['fake/small'];
    assert.ok(small, `expected fake/small among ${JSON.stringify(Object.keys(byModel))}`);
    assert.deepEqual(small.limit, { context: 16000, output: 2000 });
    assert.equal(small.usableInputTokens, 14000, `expected usable 16000-2000=14000, got ${JSON.stringify(small)}`);
    assert.equal(small.limitSource, 'opencode');

    const large = byModel['fake/large'];
    assert.ok(large, `expected fake/large among ${JSON.stringify(Object.keys(byModel))}`);
    assert.deepEqual(large.limit, { context: 200000, output: 8000 });
    assert.equal(large.usableInputTokens, 192000, `expected usable 200000-8000=192000, got ${JSON.stringify(large)}`);
    assert.equal(large.limitSource, 'opencode');

    const profiled = byModel['fake/noprofile'];
    assert.ok(profiled, `expected fake/noprofile among ${JSON.stringify(Object.keys(byModel))}`);
    assert.deepEqual(profiled.limit, { context: 32768, output: 4096 });
    assert.equal(profiled.usableInputTokens, 28672, `expected usable 32768-4096=28672, got ${JSON.stringify(profiled)}`);
    assert.equal(profiled.limitSource, 'profile');
    assert.equal(profiled.maxRunning, 1);

    const server = unwrap(await client.callTool('opencode-info', { section: 'server' }));
    assert.equal(server.section, 'server');
    assert.ok(server.server, 'expected a server object');
    assert.equal(server.server.limits.maxRunningTurns, 4, `expected the default cap of 4, got ${JSON.stringify(server.server.limits)}`);
    assert.equal(server.server.limits.maxQueuedTurns, 64, `expected the default queue of 64, got ${JSON.stringify(server.server.limits)}`);
    assert.ok(server.server.concurrency, 'expected a concurrency object');
    assert.equal(typeof server.server.concurrency.running, 'number');
    assert.equal(typeof server.server.concurrency.queued, 'number');
    assert.equal(typeof server.server.concurrency.available, 'number');

    // See this file's header comment / this unit's report: 'model-limits' and 'context-usage' are
    // expected to be missing from this array on this base (src/core/engine.ts's section "server"
    // capabilities list currently hardcodes only 'run-queue' among the three), even though
    // model-limits projection itself already works above. Kept exactly as specified, not weakened.
    assert.ok(
      server.server.capabilities.includes('run-queue'),
      `expected 'run-queue', got ${JSON.stringify(server.server.capabilities)}`,
    );
    assert.ok(
      server.server.capabilities.includes('model-limits'),
      `expected 'model-limits', got ${JSON.stringify(server.server.capabilities)}`,
    );
    assert.ok(
      server.server.capabilities.includes('context-usage'),
      `expected 'context-usage', got ${JSON.stringify(server.server.capabilities)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// b. PROMPT_TOO_LARGE pre-check (depends on the other unit — see this file's header comment).
// ---------------------------------------------------------------------------

test(
  'b: PROMPT_TOO_LARGE pre-check rejects an oversized prompt before submission; OPENCODE_MCP_CONTEXT_GUARD=off still submits it',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    // 80,000 ASCII chars ~ 20,000 estimated tokens (design.md §5.4: ceil(asciiChars/4)), clearly
    // over the profiled model's usable budget of 8000-2000=6000 tokens below.
    const bigPrompt = 'A'.repeat(80_000);
    const guardedProfile = { 'fake/guarded': { context: 8000, output: 2000 } };

    const rejectCtx = await setupScenario('guard-reject', {
      models: [{ id: 'guarded' }],
      extraEnv: { OPENCODE_MCP_MODEL_PROFILES: JSON.stringify(guardedProfile) },
    });
    t.after(rejectCtx.teardown);
    const before = await rejectCtx.fakeLlm.requests();
    const rejected = await rejectCtx.client.callTool('opencode', { prompt: bigPrompt, model: 'fake/guarded' });
    const rejectedError = unwrap(rejected, { expectError: true });
    assert.equal(
      rejectedError.error?.name,
      'PROMPT_TOO_LARGE',
      `expected PROMPT_TOO_LARGE, got ${JSON.stringify(rejectedError)}`,
    );
    const after = await rejectCtx.fakeLlm.requests();
    assert.equal(after.length, before.length, 'a rejected prompt must never reach the fake LLM');

    const offCtx = await setupScenario('guard-off', {
      models: [{ id: 'guarded' }],
      extraEnv: {
        OPENCODE_MCP_MODEL_PROFILES: JSON.stringify(guardedProfile),
        OPENCODE_MCP_CONTEXT_GUARD: 'off',
      },
    });
    t.after(offCtx.teardown);
    // Outcome deliberately not asserted (it may succeed or fail) — only that it was submitted.
    offCtx.client.callTool('opencode', { prompt: bigPrompt, model: 'fake/guarded' }).catch(() => {});
    const req = await waitForFakeLlmRequest(offCtx.fakeLlm, (r) => (r.tools ?? []).length > 0, { timeoutMs: 30_000 });
    assert.ok(req, 'expected the guard-off prompt to actually reach the fake LLM');
  },
);

// ---------------------------------------------------------------------------
// c. Per-turn context usage (depends on the other unit — see this file's header comment).
// ---------------------------------------------------------------------------

test(
  'c: a USAGE directive near budget reports context.used/usableInputTokens/ratio and a CONTEXT_HIGH warning; a small usage has no warning',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('context-usage', {
      models: [{ id: 'small', limit: { context: 16000, output: 2000 } }],
    });
    t.after(ctx.teardown);
    const { client } = ctx;

    const high = unwrap(await client.callTool('opencode', { prompt: 'USAGE 12000', model: 'fake/small' }));
    assert.equal(high.status, 'completed', `expected completed, got ${JSON.stringify(high)}`);
    assert.ok(high.context, `expected a context object, got ${JSON.stringify(high)}`);
    assert.equal(high.context?.model, 'fake/small');
    assert.ok((high.context?.used ?? 0) >= 12000, `expected used >= 12000, got ${JSON.stringify(high.context)}`);
    assert.equal(high.context?.usableInputTokens, 14000, `expected usable 16000-2000=14000, got ${JSON.stringify(high.context)}`);
    assert.ok((high.context?.ratio ?? 0) >= 0.8, `expected ratio >= 0.8, got ${JSON.stringify(high.context)}`);
    assert.ok(
      (high.warnings ?? []).some((w) => w.code === 'CONTEXT_HIGH'),
      `expected a CONTEXT_HIGH warning, got ${JSON.stringify(high.warnings)}`,
    );

    const low = unwrap(await client.callTool('opencode', { prompt: 'USAGE 1000', model: 'fake/small' }));
    assert.equal(low.status, 'completed', `expected completed, got ${JSON.stringify(low)}`);
    assert.ok(
      !(low.warnings ?? []).some((w) => w.code === 'CONTEXT_HIGH'),
      `expected no CONTEXT_HIGH warning for a small usage, got ${JSON.stringify(low.warnings)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// d. Run-slot cap: the extra starts queue; all four complete; the fake LLM never runs more build
//    turns at once than the cap allows.
// ---------------------------------------------------------------------------

test(
  'd: OPENCODE_MCP_MAX_RUNNING_TURNS=2 queues the extra starts; all four complete; the fake LLM never runs more than 2 build turns at once',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('run-cap', { extraEnv: { OPENCODE_MCP_MAX_RUNNING_TURNS: '2' } });
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    const starts = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        client.callTool('opencode', { prompt: `SLOW_REPLY 2 cap-${i}`, 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
      ),
    );
    const results = starts.map((r) => unwrap(r));
    for (const r of results) {
      assert.equal(r.status, 'running', `expected running immediately, got ${JSON.stringify(r)}`);
    }
    const queued = results.filter((r) => r.queue !== undefined);
    const notQueued = results.filter((r) => r.queue === undefined);
    assert.ok(
      queued.length >= 2,
      `expected at least two queued results (cap=2, 4 starts), got ${JSON.stringify(results.map((r) => r.queue))}`,
    );
    for (const r of queued) {
      assert.equal(r.resendSafety, 'not_submitted', `expected not_submitted while queued, got ${JSON.stringify(r)}`);
      assert.equal(r.content, '', `expected empty content while queued, got ${JSON.stringify(r)}`);
    }

    const ids = results.map((r) => r.sessionId);
    const batch = unwrap(
      await client.callTool('opencode-status', { ids, 'wait-for': 'all', 'wait-seconds': 60 }, { timeoutMs: 70_000 }),
    );
    assert.equal(batch.status, 'ready', `expected all four to finish, got ${JSON.stringify(batch)}`);
    for (const item of batch.results) {
      assert.equal(item.status, 'completed', `expected completed, got ${JSON.stringify(item)}`);
    }

    // queuedMs: present (a number) only for the results that were actually queued; absent for the
    // two admitted immediately (design.md §3: "absent if never queued").
    const byId = new Map(batch.results.map((item) => [item.sessionId, item]));
    for (const r of queued) {
      const final = byId.get(r.sessionId);
      assert.equal(typeof final.queuedMs, 'number', `expected a numeric queuedMs, got ${JSON.stringify(final)}`);
    }
    for (const r of notQueued) {
      const final = byId.get(r.sessionId);
      assert.equal(final.queuedMs, undefined, `expected no queuedMs for a turn never queued, got ${JSON.stringify(final)}`);
    }

    // The fake LLM must never have run more than 2 build-agent (tool-bearing) requests at once.
    const reqs = buildRequests(await fakeLlm.requests());
    assert.ok(reqs.length >= 4, `expected at least 4 build requests (one per start), got ${reqs.length}`);
    const events = [];
    for (const r of reqs) {
      assert.equal(typeof r.startMs, 'number', `expected a numeric startMs, got ${JSON.stringify(r)}`);
      assert.equal(typeof r.endMs, 'number', `expected a numeric endMs (response finished), got ${JSON.stringify(r)}`);
      events.push([r.startMs, 1], [r.endMs, -1]);
    }
    // Ends sort before starts at the same instant, so a request finishing exactly when another
    // starts is never counted as overlapping it.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let concurrent = 0;
    let maxConcurrent = 0;
    for (const [, delta] of events) {
      concurrent += delta;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }
    assert.ok(maxConcurrent <= 2, `expected at most 2 overlapping build requests, observed ${maxConcurrent}`);
  },
);

// ---------------------------------------------------------------------------
// e. Cancelling a queued turn never submits its prompt; the running turn it was queued behind
//    still completes.
// ---------------------------------------------------------------------------

test(
  'e: opencode-cancel on a queued session cancels it without the fake LLM ever seeing its prompt; the running turn still completes',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('cancel-queued', { extraEnv: { OPENCODE_MCP_MAX_RUNNING_TURNS: '1' } });
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    const a = unwrap(
      await client.callTool('opencode', { prompt: 'SLOW_REPLY 3 cancel-test-a', 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
    );
    assert.equal(a.status, 'running');
    assert.equal(a.queue, undefined, `expected A to be admitted immediately, got ${JSON.stringify(a)}`);

    const bMarker = 'CANCEL_QUEUE_MARKER_B';
    const b = unwrap(
      await client.callTool('opencode', { prompt: `SLOW_REPLY 3 ${bMarker}`, 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
    );
    assert.equal(b.status, 'running');
    assert.ok(b.queue, `expected B to be queued behind the cap-1 running turn, got ${JSON.stringify(b)}`);
    assert.equal(b.resendSafety, 'not_submitted', `expected not_submitted while queued, got ${JSON.stringify(b)}`);

    const cancelled = unwrap(await client.callTool('opencode-cancel', { sessionId: b.sessionId }, { timeoutMs: 20_000 }));
    assert.equal(cancelled.status, 'cancelled', `expected cancelled, got ${JSON.stringify(cancelled)}`);
    assert.equal(cancelled.resendSafety, 'not_submitted', `expected not_submitted, got ${JSON.stringify(cancelled)}`);

    const reqs = await fakeLlm.requests();
    assert.ok(
      !reqs.some((r) => (r.messages ?? []).some((m) => m.text.includes(bMarker))),
      `the fake LLM must never have received B's prompt: ${JSON.stringify(reqs.map((r) => r.messages))}`,
    );

    const aFinal = unwrap(
      await client.callTool('opencode-status', { sessionId: a.sessionId, 'wait-seconds': 30 }, { timeoutMs: 40_000 }),
    );
    assert.equal(aFinal.status, 'completed', `expected A to complete, got ${JSON.stringify(aFinal)}`);
  },
);

// ---------------------------------------------------------------------------
// f. A per-model maxRunning profile queues the second same-model turn (blockedBy "model") while a
//    different model keeps running.
// ---------------------------------------------------------------------------

test(
  'f: a per-model maxRunning:1 profile on the large model queues the second large-model turn (blockedBy "model") while a small-model turn runs unblocked',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('model-cap', {
      models: [
        { id: 'small', limit: { context: 16000, output: 2000 } },
        { id: 'large', limit: { context: 200000, output: 8000 } },
      ],
      extraEnv: {
        OPENCODE_MCP_MAX_RUNNING_TURNS: '4',
        OPENCODE_MCP_MODEL_PROFILES: JSON.stringify({ 'fake/large': { maxRunning: 1 } }),
      },
    });
    t.after(ctx.teardown);
    const { client } = ctx;

    const large1 = unwrap(
      await client.callTool(
        'opencode',
        { prompt: 'SLOW_REPLY 2 large-1', model: 'fake/large', 'wait-seconds': 0 },
        { timeoutMs: 20_000 },
      ),
    );
    assert.equal(large1.status, 'running');
    assert.equal(large1.queue, undefined, `expected the first large-model turn to run immediately, got ${JSON.stringify(large1)}`);

    const [large2Raw, smallRaw] = await Promise.all([
      client.callTool('opencode', { prompt: 'SLOW_REPLY 2 large-2', model: 'fake/large', 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
      client.callTool('opencode', { prompt: 'SLOW_REPLY 2 small-1', model: 'fake/small', 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
    ]);
    const large2 = unwrap(large2Raw);
    const small = unwrap(smallRaw);

    assert.ok(large2.queue, `expected the second large-model turn to be queued, got ${JSON.stringify(large2)}`);
    assert.equal(large2.queue.blockedBy, 'model', `expected blockedBy "model", got ${JSON.stringify(large2.queue)}`);
    assert.equal(small.status, 'running');
    assert.equal(small.queue, undefined, `expected the small-model turn to run unblocked, got ${JSON.stringify(small)}`);

    const batch = unwrap(
      await client.callTool(
        'opencode-status',
        { ids: [large1.sessionId, large2.sessionId, small.sessionId], 'wait-for': 'all', 'wait-seconds': 30 },
        { timeoutMs: 40_000 },
      ),
    );
    for (const item of batch.results) {
      assert.equal(item.status, 'completed', `expected completed, got ${JSON.stringify(item)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// g. Large-catalog regression: an OpenCode config WITHOUT enabled_providers (so /provider is
//    ~6 MiB from the bundled models.dev snapshot) still works end-to-end.
// ---------------------------------------------------------------------------

test(
  'g: without enabled_providers (~6 MiB /provider body), a turn still completes and opencode-info models still lists the custom provider',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('large-catalog', { omitEnabledProviders: true });
    t.after(ctx.teardown);
    const { client } = ctx;

    const turn = unwrap(
      await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'workspace-write' }, { timeoutMs: 60_000 }),
    );
    assert.equal(turn.status, 'completed', `expected completed, got ${JSON.stringify(turn)}`);

    const models = unwrap(await client.callTool('opencode-info', { section: 'models' }, { timeoutMs: 60_000 }));
    assert.equal(models.section, 'models');
    assert.ok(
      (models.models ?? []).some((m) => m.providerId === 'fake'),
      `expected the custom "fake" provider's models to be listed, got ${JSON.stringify((models.models ?? []).map((m) => m.model))}`,
    );
  },
);
