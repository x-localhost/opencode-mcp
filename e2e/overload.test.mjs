// Hermetic e2e scenarios for the overload-robustness work,
// against the REAL opencode-ai@1.18.33 binary. See docs/design.md §12 and the README overload
// section for the answer classification / UpstreamErrorDetail / resendSafety / warnings /
// upstreamRetry / output.partial contract, the response-loop watchdog behavior, and
// docs/research/probe-overload/summary.md (what real OpenCode 1.18.33 actually does for each
// shape — the numbered rows this file's scenario names map to).
//
// Deliberately does NOT import e2e/scenarios.test.mjs or e2e/features.test.mjs: each registers its
// own top-level `test(...)` scenarios, so importing one here would re-run it inside THIS file's
// `node --test` process too — defeating e2e/run-e2e.sh's separate "overload scenarios" step and its
// own PASS/FAIL/SKIP accounting. The handful of setup helpers this file needs are therefore
// duplicated (not re-exported) from e2e/scenarios.test.mjs / features.test.mjs, kept intentionally
// tiny; e2e/lib/harness.mjs remains the single shared, side-effect-free source for the actual
// process/repo/fake-LLM plumbing.
//
// "Exactly one root user message upstream" (per-scenario acceptance target): this harness runs
// opencode-mcp's managed `opencode serve` as a child process with no exposed port, so there is no
// direct way to query OpenCode's own `GET /session/{id}/message` from the test. Instead this file
// uses a reliable proxy that reads OpenCode's OWN constructed request, not opencode-mcp's: OpenCode
// resends the FULL message history (every prior user/assistant/tool message) as the `messages` array
// of every chat-completions request it sends to the model (see fake-llm-server.mjs's own comment on
// `record()`), so counting `role === "user"` entries inside that array, for every scenario
// (tool-bearing) request the fake LLM received, directly observes how many root user messages
// OpenCode itself believes exist for this session/turn — proving no second prompt ever reached
// OpenCode, independent of anything opencode-mcp reports about itself. "Scenario LLM requests" is
// used throughout for chat-completions requests that carry a non-empty `tools` array: OpenCode's own
// title/summary calls never include `tools` (see fake-llm-server.mjs's header comment) and are
// therefore excluded, so counts here reflect only the directive-driven turn traffic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpClient } from './lib/mcp-client.mjs';
import { createTempRepo, startFakeLlm, buildOpencodeConfig, baseServerEnv, sleep } from './lib/harness.mjs';

// Generous but bounded per-scenario node:test timeouts: 180s for everything
// except scenario 12 (529-always), which real OpenCode's own bounded provider-retry backoff
// (2/4/8/16/30s, probe row 2b) stretches to roughly 60-70s of wall time before it gives up.
const SCENARIO_TIMEOUT_MS = 180_000;
const SLOW_SCENARIO_TIMEOUT_MS = 240_000;

/** Sets up one scenario's temp repo + fake LLM + connected client (duplicated from
 * e2e/scenarios.test.mjs's own setupScenario / e2e/features.test.mjs's copy — see this file's
 * header comment for why). Always call `ctx.teardown()` (register via `t.after`) even on failure,
 * so temp dirs/processes never leak. */
async function setupScenario(label, { permission, heartbeatSeconds, extraEnv } = {}) {
  const repo = createTempRepo(label);
  const fakeLlm = await startFakeLlm({ label });
  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl, permission });
  const env = baseServerEnv({ cwd: repo.dir, configContent, heartbeatSeconds, extra: extraEnv });
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

/** Asserts the MCP-level isError flag, then returns structuredContent for further assertions.
 * A single-turn result whose own status is failed/timeout is always isError:true (overload design
 * §B), so callers only pass expectError for kind:'error' results (duplicated from
 * e2e/features.test.mjs — see this file's header comment for why). */
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

let tagSeq = 0;
/** A short, unique, whitespace-free tag/nonce embedded in a directive (e.g.
 * `OVERLOAD_429_ONCE_<nonce>`), so concurrent/repeated scenarios never share the fake LLM's
 * per-directive `firstCall`/tag counters. */
function uniqueTag(prefix) {
  tagSeq += 1;
  return `${prefix}${Date.now()}x${tagSeq}`;
}

/** Only chat-completions requests that carry a non-empty `tools` array — excludes OpenCode's own
 * title/summary calls (see this file's header comment). */
async function scenarioRequestsOf(fakeLlm) {
  const all = await fakeLlm.requests();
  return all.filter((r) => Array.isArray(r.tools) && r.tools.length > 0);
}

/** A follow-up opencode-reply on a session whose previous turn was just stopped by the watchdog may
 * transiently see SESSION_BUSY while stop cleanup is still confirming (response-loop watchdog contract §A:
 * "Stop cannot be confirmed" is a legitimate terminal shape, not just a race) — poll opencode-status
 * first, then retry, instead of treating that as a failure. Documents (via t.diagnostic) whether this
 * ever actually happened. */
async function replyOnceSessionReady(t, client, sessionId, prompt, maxAttempts = 12) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.callTool('opencode-reply', { sessionId, prompt }, { timeoutMs: 30_000 });
    const sc = res.structuredContent;
    if (sc?.kind === 'error' && sc.error?.name === 'SESSION_BUSY') {
      t.diagnostic(`follow-up opencode-reply: SESSION_BUSY on attempt ${attempt}/${maxAttempts}; polling opencode-status, then retrying`);
      await client.callTool('opencode-status', { sessionId, 'wait-seconds': 3 }, { timeoutMs: 15_000 }).catch(() => {});
      continue;
    }
    return res;
  }
  throw new Error(`opencode-reply kept returning SESSION_BUSY for session ${sessionId} after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// 1-3. Runaway-loop watchdog: OVERLOAD_EMPTY_DONE / OVERLOAD_HTML_BODY / OVERLOAD_BAD_TOOL_JSON make
// real OpenCode 1.18.33 hot-loop the LLM with no backoff (probe rows 3, 8, 9 — up to ~7.5 req/s,
// hundreds of calls in 30-90s with no watchdog). With the watchdog, all three must be caught and
// stopped well before the 120s turn timeout: confirmed UPSTREAM_RESPONSE_LOOP within 20s (target
// 10s) of the first scenario LLM request, at most 32 scenario LLM requests total, no further
// scenario request for 5s after the result, exactly one root user message upstream throughout (see
// header comment), and a follow-up opencode-reply on the same session still completes normally.
// ---------------------------------------------------------------------------

/** Shared assertions for the three runaway-loop scenarios; returns the failed TurnResult's
 * structuredContent for any scenario-specific extra checks (e.g. runaway-bad-tool's resendSafety). */
async function assertRunawayLoopStopped(t, ctx, { directive, expectedPattern, label }) {
  const { client, fakeLlm } = ctx;

  const raw = await client.callTool(
    'opencode',
    { prompt: `${directive} please help`, sandbox: 'workspace-write', 'timeout-seconds': 120 },
    { timeoutMs: 150_000 },
  );
  const resultArrivedAt = Date.now();
  const sc = unwrap(raw);

  // Logged BEFORE the strict assertions below (not just on success) so a failure here still
  // leaves precise evidence for the report: status/executionState/cleanup/resendSafety/
  // responseLoop/toolCallCount/request-count/timing, whichever the engine actually produced.
  const scenarioRequests = await scenarioRequestsOf(fakeLlm);
  const firstReqTime = scenarioRequests.length ? new Date(scenarioRequests[0].time).getTime() : undefined;
  const elapsedFromFirstRequest = firstReqTime !== undefined ? resultArrivedAt - firstReqTime : undefined;
  t.diagnostic(
    `${label}: status=${sc.status} executionState=${sc.executionState} cleanup=${sc.cleanup} ` +
      `resendSafety=${sc.resendSafety} responseLoop=${JSON.stringify(sc.responseLoop)} ` +
      `toolCallCount=${sc.toolCallCount} error=${JSON.stringify(sc.error)} ` +
      `scenarioLlmRequests=${scenarioRequests.length} elapsedFromFirstRequest=${elapsedFromFirstRequest}ms`,
  );

  assert.equal(sc.status, 'failed', `${label}: expected status failed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.equal(sc.error?.name, 'UPSTREAM_RESPONSE_LOOP', `${label}: expected error.name UPSTREAM_RESPONSE_LOOP, got ${JSON.stringify(sc.error)}`);
  assert.equal(sc.error?.retryable, false, `${label}: expected error.retryable:false, got ${JSON.stringify(sc.error)}`);
  assert.equal(sc.responseLoop?.pattern, expectedPattern, `${label}: expected responseLoop.pattern ${expectedPattern}, got ${JSON.stringify(sc.responseLoop)}`);
  assert.equal(raw.isError, true, `${label}: expected isError:true for a failed turn result`);

  assert.ok(scenarioRequests.length > 0, `${label}: expected at least one scenario (tool-bearing) LLM request`);
  assert.ok(
    elapsedFromFirstRequest < 20_000,
    `${label}: expected the result within 20s of the first scenario LLM request, got ${elapsedFromFirstRequest}ms`,
  );
  assert.ok(scenarioRequests.length <= 32, `${label}: expected <=32 scenario LLM requests, got ${scenarioRequests.length}`);

  // Exactly one root user message upstream throughout (see this file's header comment for the
  // OpenCode-resends-its-own-history proxy this relies on).
  for (const r of scenarioRequests) {
    const userCount = (r.messages ?? []).filter((m) => m.role === 'user').length;
    assert.equal(
      userCount,
      1,
      `${label}: expected exactly one root user message upstream in request seq=${r.seq}, got ${userCount}`,
    );
  }

  // No further scenario LLM request for 5s after the result (the watchdog's stop must actually have
  // silenced OpenCode's own hot loop, not just raced ahead of it).
  const countAtResult = scenarioRequests.length;
  await sleep(5_000);
  const countAfter5s = (await scenarioRequestsOf(fakeLlm)).length;
  assert.equal(
    countAfter5s,
    countAtResult,
    `${label}: expected no new scenario LLM request in the 5s after the result, before=${countAtResult} after=${countAfter5s}`,
  );

  // The session still accepts a normal subsequent reply (tolerating a transient SESSION_BUSY while
  // stop cleanup confirms).
  const replyRaw = await replyOnceSessionReady(t, client, sc.sessionId, 'please continue plainly, no directive here');
  const reply = unwrap(replyRaw);
  assert.equal(reply.status, 'completed', `${label}: expected the follow-up reply to complete normally, got ${JSON.stringify(reply).slice(0, 800)}`);

  return sc;
}

test('runaway-empty: OVERLOAD_EMPTY_DONE trips the response-loop watchdog -> UPSTREAM_RESPONSE_LOOP', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('runaway-empty');
  t.after(ctx.teardown);
  await assertRunawayLoopStopped(t, ctx, { directive: 'OVERLOAD_EMPTY_DONE', expectedPattern: 'empty', label: 'runaway-empty' });
});

test('runaway-html: OVERLOAD_HTML_BODY trips the response-loop watchdog -> UPSTREAM_RESPONSE_LOOP', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('runaway-html');
  t.after(ctx.teardown);
  await assertRunawayLoopStopped(t, ctx, { directive: 'OVERLOAD_HTML_BODY', expectedPattern: 'empty', label: 'runaway-html' });
});

// OpenCode 1.18.33 first reports each malformed tool call as `bash` pending, then flips it to the
// `invalid` sentinel; that transient pending part must not count as progress (fixed in 080d34e).
test('runaway-bad-tool: OVERLOAD_BAD_TOOL_JSON trips the response-loop watchdog -> UPSTREAM_RESPONSE_LOOP', {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const ctx = await setupScenario('runaway-bad-tool');
  t.after(ctx.teardown);
  const sc = await assertRunawayLoopStopped(t, ctx, {
    directive: 'OVERLOAD_BAD_TOOL_JSON',
    expectedPattern: 'invalid_tool',
    label: 'runaway-bad-tool',
  });
  // response-loop watchdog contract §A: "Any tool records, including the invalid sentinel: conservatively
  // inspect_effects" when cleanup confirmed complete; if stop cleanup could not be confirmed within
  // its deadline, resendSafety degrades to 'unknown' instead (also a documented terminal shape).
  assert.ok(
    ['inspect_effects', 'unknown'].includes(sc.resendSafety),
    `runaway-bad-tool: expected resendSafety inspect_effects or unknown, got ${sc.resendSafety}`,
  );
  t.diagnostic(`runaway-bad-tool: resendSafety=${sc.resendSafety} (cleanup=${sc.cleanup})`);
});

// ---------------------------------------------------------------------------
// 4-5. Recovery before the watchdog trips: 5 unproductive attempts (below the default
// responseLoopLimit of 6) followed by a normal reply must complete normally, never tripping the
// watchdog.
// ---------------------------------------------------------------------------

test('recover-empty: OVERLOAD_EMPTY_THEN_OK 5 recovers before the watchdog trips (limit=6)', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('recover-empty');
  t.after(ctx.teardown);
  const { client } = ctx;
  const tag = uniqueTag('recovempty');

  const raw = await client.callTool('opencode', { prompt: `OVERLOAD_EMPTY_THEN_OK 5 ${tag}` }, { timeoutMs: 60_000 });
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.match(sc.content, /OVERLOAD_RECOVERED/, `expected content to mention OVERLOAD_RECOVERED, got ${JSON.stringify(sc.content)}`);
  assert.equal(sc.error, undefined, `expected no error, got ${JSON.stringify(sc.error)}`);
  assert.equal(sc.responseLoop, undefined, `expected no responseLoop evidence (5 < limit 6 must not trip), got ${JSON.stringify(sc.responseLoop)}`);
});

test('recover-bad-tool: OVERLOAD_BADTOOL_THEN_OK 5 recovers before the watchdog trips (limit=6)', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('recover-bad-tool');
  t.after(ctx.teardown);
  const { client } = ctx;
  const tag = uniqueTag('recovbadtool');

  const raw = await client.callTool(
    'opencode',
    { prompt: `OVERLOAD_BADTOOL_THEN_OK 5 ${tag}`, sandbox: 'workspace-write' },
    { timeoutMs: 60_000 },
  );
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.match(sc.content, /OVERLOAD_RECOVERED/, `expected content to mention OVERLOAD_RECOVERED, got ${JSON.stringify(sc.content)}`);
  assert.equal(sc.responseLoop, undefined, `expected no responseLoop evidence (5 < limit 6 must not trip), got ${JSON.stringify(sc.responseLoop)}`);
});

// ---------------------------------------------------------------------------
// 6. Legitimate long agentic turns (>= 20 real tool steps) must never accumulate watchdog strikes:
// real tools (even many of them) are barriers, not evidence of unproductivity.
// ---------------------------------------------------------------------------

test('tool-steps: TOOL_STEPS 20 completes normally; 20+ real tool steps never trip the watchdog', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('tool-steps');
  t.after(ctx.teardown);
  const { client } = ctx;

  const raw = await client.callTool('opencode', { prompt: 'TOOL_STEPS 20', sandbox: 'workspace-write' }, { timeoutMs: 150_000 });
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.match(sc.content, /TOOL_STEPS_DONE 20/, `expected content to include TOOL_STEPS_DONE 20, got ${JSON.stringify(sc.content)}`);
  assert.ok(sc.toolCallCount >= 20, `expected toolCallCount>=20, got ${sc.toolCallCount}`);
  assert.notEqual(sc.error?.name, 'UPSTREAM_RESPONSE_LOOP', `expected no UPSTREAM_RESPONSE_LOOP, got ${JSON.stringify(sc.error)}`);
});

// ---------------------------------------------------------------------------
// 7-8. Empty / whitespace-only stop: classified failed EMPTY_RESPONSE, retryable (overload design §B:
// "stop + empty/whitespace/reasoning-only + no observed tools/patches -> failed, EMPTY_RESPONSE,
// retryable: true").
// ---------------------------------------------------------------------------

test('empty-stop: OVERLOAD_EMPTY_STOP -> failed EMPTY_RESPONSE (retryable)', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('empty-stop');
  t.after(ctx.teardown);
  const { client } = ctx;

  const raw = await client.callTool('opencode', { prompt: 'OVERLOAD_EMPTY_STOP please answer' }, { timeoutMs: 30_000 });
  const sc = unwrap(raw);
  assert.equal(sc.status, 'failed', `expected failed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.equal(sc.error?.name, 'EMPTY_RESPONSE', `expected EMPTY_RESPONSE, got ${JSON.stringify(sc.error)}`);
  assert.equal(sc.error?.retryable, true, `expected retryable:true, got ${JSON.stringify(sc.error)}`);
  assert.equal(raw.isError, true, 'expected isError:true for a failed turn result');
  t.diagnostic(`empty-stop: resendSafety=${sc.resendSafety}`);
});

test('whitespace: OVERLOAD_WHITESPACE -> failed EMPTY_RESPONSE', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('whitespace');
  t.after(ctx.teardown);
  const { client } = ctx;

  const raw = await client.callTool('opencode', { prompt: 'OVERLOAD_WHITESPACE please answer' }, { timeoutMs: 30_000 });
  const sc = unwrap(raw);
  assert.equal(sc.status, 'failed', `expected failed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.equal(sc.error?.name, 'EMPTY_RESPONSE', `expected EMPTY_RESPONSE, got ${JSON.stringify(sc.error)}`);
  assert.equal(sc.error?.retryable, true, `expected retryable:true, got ${JSON.stringify(sc.error)}`);
  assert.equal(raw.isError, true, 'expected isError:true for a failed turn result');
});

// ---------------------------------------------------------------------------
// 9. finish:"length" with partial text: completed with a TRUNCATED warning and output.partial:true
// (overload design §B: "length + usable text or activity -> completed, warning TRUNCATED" — probe row
// 11 shows this was previously reported as clean success with no warning at all).
// ---------------------------------------------------------------------------

test('finish-length: OVERLOAD_FINISH_LENGTH -> completed with TRUNCATED warning and output.partial', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('finish-length');
  t.after(ctx.teardown);
  const { client } = ctx;

  const raw = await client.callTool('opencode', { prompt: 'OVERLOAD_FINISH_LENGTH please answer' }, { timeoutMs: 30_000 });
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.ok(
    (sc.warnings ?? []).some((w) => w.code === 'TRUNCATED'),
    `expected a TRUNCATED warning, got ${JSON.stringify(sc.warnings)}`,
  );
  assert.equal(sc.output?.partial, true, `expected output.partial:true, got ${JSON.stringify(sc.output)}`);
  assert.ok(!raw.isError, 'expected isError to be falsy for a completed turn result');
  assert.match(sc.content, /cut off/, `expected content to mention being cut off, got ${JSON.stringify(sc.content)}`);
});

// ---------------------------------------------------------------------------
// 10. Malformed provider SSE: whatever the outcome, the raw malformed chunk text must never leak
// into any MCP-facing field, and a failed result must carry the sanitized generic message (design-
// overload design §B / response-loop watchdog contract §B: "Replace that public message with the bounded generic parsing
// explanation; do not copy the embedded response excerpt into hints or diagnostics").
// ---------------------------------------------------------------------------

test('malformed-sse: OVERLOAD_MALFORMED_SSE never leaks the raw malformed chunk', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('malformed-sse');
  t.after(ctx.teardown);
  const { client } = ctx;

  const raw = await client.callTool('opencode', { prompt: 'OVERLOAD_MALFORMED_SSE please answer' }, { timeoutMs: 30_000 });
  const sc = unwrap(raw);
  t.diagnostic(`malformed-sse: status=${sc.status} error=${JSON.stringify(sc.error)}`);
  if (sc.status === 'failed') {
    assert.equal(sc.error?.name, 'UnknownError', `expected UnknownError, got ${JSON.stringify(sc.error)}`);
    assert.equal(
      sc.error?.message,
      'The model provider returned a malformed streaming response.',
      `expected the sanitized generic message, got ${JSON.stringify(sc.error)}`,
    );
  } else {
    assert.equal(sc.status, 'completed', `expected completed or failed, got ${JSON.stringify(sc).slice(0, 800)}`);
  }
  const haystack = JSON.stringify(sc) + JSON.stringify(raw.content);
  assert.ok(
    !haystack.includes('this is not json'),
    `the raw malformed SSE chunk text must never leak into any result, got ${haystack.slice(0, 2000)}`,
  );
});

// ---------------------------------------------------------------------------
// 11. OpenCode's own bounded provider retry recovers a transient 429 without any prompt-level
// retry from opencode-mcp (probe row 1a: "2 calls, 1 session.status{retry}, idle 4.6s -> completed").
// ---------------------------------------------------------------------------

test("429-once: OVERLOAD_429_ONCE_<nonce> recovers via OpenCode's own provider retry", { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('429-once');
  t.after(ctx.teardown);
  const { client } = ctx;
  const nonce = uniqueTag('n429once');

  const start = Date.now();
  const raw = await client.callTool('opencode', { prompt: `OVERLOAD_429_ONCE_${nonce} please answer` }, { timeoutMs: 40_000 });
  const elapsedMs = Date.now() - start;
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.match(sc.content, /OVERLOAD_RECOVERED/, `expected content to mention OVERLOAD_RECOVERED, got ${JSON.stringify(sc.content)}`);
  t.diagnostic(`429-once: completed in ${elapsedMs}ms (target within ~30000ms)`);
  assert.ok(elapsedMs < 35_000, `expected completion within ~30s, got ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// 12. Bounded provider retry exhaustion (probe row 2b): OpenCode's own 529 backoff runs its full
// course (2/4/8/16/30s, ~68-71s wall time observed) before giving up; opencode-mcp must surface
// upstreamRetry progress while running, then a failed MODEL_OVERLOADED result, without amplifying
// the load itself (<=6 scenario LLM requests total: 1 initial + OpenCode's own capped 5 retries).
// ---------------------------------------------------------------------------

test(
  '529-always: OVERLOAD_529_ALWAYS -> failed after OpenCode\'s own bounded provider retries (MODEL_OVERLOADED)',
  { timeout: SLOW_SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('529-always');
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    const start = unwrap(
      await client.callTool(
        'opencode',
        { prompt: 'OVERLOAD_529_ALWAYS please answer', 'wait-seconds': 0, 'timeout-seconds': 200 },
        { timeoutMs: 30_000 },
      ),
    );
    assert.equal(start.status, 'running', `expected running immediately (wait-seconds:0), got ${JSON.stringify(start).slice(0, 800)}`);
    const { sessionId } = start;

    let sawUpstreamRetry = false;
    let finalSc;
    let finalRaw;
    const deadline = Date.now() + 220_000;
    for (;;) {
      const raw = await client.callTool('opencode-status', { sessionId, 'wait-seconds': 5 }, { timeoutMs: 20_000 });
      const sc = unwrap(raw);
      if (sc.upstreamRetry && sc.upstreamRetry.attempt >= 1) {
        sawUpstreamRetry = true;
        t.diagnostic(`529-always: observed upstreamRetry attempt=${sc.upstreamRetry.attempt} message=${JSON.stringify(sc.upstreamRetry.message)}`);
      }
      if (sc.status !== 'running' && sc.status !== 'waiting_for_approval') {
        finalRaw = raw;
        finalSc = sc;
        break;
      }
      if (Date.now() > deadline) throw new Error('529-always: timed out waiting for the turn to reach a terminal state');
    }

    assert.ok(sawUpstreamRetry, 'expected at least one running snapshot to carry upstreamRetry with attempt>=1');
    assert.equal(finalSc.status, 'failed', `expected failed, got ${JSON.stringify(finalSc).slice(0, 800)}`);
    assert.equal(finalSc.error?.statusCode, 529, `expected error.statusCode 529, got ${JSON.stringify(finalSc.error)}`);
    assert.equal(finalSc.error?.condition, 'MODEL_OVERLOADED', `expected error.condition MODEL_OVERLOADED, got ${JSON.stringify(finalSc.error)}`);
    assert.equal(finalRaw.isError, true, 'expected isError:true for the failed turn result');

    const scenarioRequests = await scenarioRequestsOf(fakeLlm);
    t.diagnostic(`529-always: ${scenarioRequests.length} scenario LLM requests total (bound <=6)`);
    assert.ok(scenarioRequests.length <= 6, `expected <=6 scenario LLM requests, got ${scenarioRequests.length}`);
  },
);

// ---------------------------------------------------------------------------
// 13. A slow first token alone (no completed unproductive attempts) must never trip the watchdog
// (response-loop watchdog contract §A: "Forty seconds waiting for the first token remains valid: there is no
// sequence of completed attempts").
// ---------------------------------------------------------------------------

test('slow-first-token: OVERLOAD_SLOW_FIRST_TOKEN 40 completes without tripping the watchdog', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('slow-first-token');
  t.after(ctx.teardown);
  const { client } = ctx;

  const start = Date.now();
  const raw = await client.callTool(
    'opencode',
    { prompt: 'OVERLOAD_SLOW_FIRST_TOKEN 40 please answer', 'timeout-seconds': 90 },
    { timeoutMs: 100_000 },
  );
  const elapsedMs = Date.now() - start;
  const sc = unwrap(raw);
  assert.equal(sc.status, 'completed', `expected completed, got ${JSON.stringify(sc).slice(0, 800)}`);
  assert.match(sc.content, /OVERLOAD_SLOW_FIRST_TOKEN_DONE/, `expected the recovered text, got ${JSON.stringify(sc.content)}`);
  assert.notEqual(sc.error?.name, 'UPSTREAM_RESPONSE_LOOP', 'the watchdog must not trip on a single slow first token');
  t.diagnostic(`slow-first-token: completed in ${elapsedMs}ms (>=40000ms expected)`);
});
