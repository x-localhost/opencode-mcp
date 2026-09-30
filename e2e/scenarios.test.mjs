// Hermetic e2e scenarios for opencode-mcp (docs/design.md §9; run via e2e/run-e2e.sh, gram,
// `--network none`). Real opencode-ai@1.18.33 + a dependency-free fake OpenAI-compatible LLM
// (e2e/fake-llm-server.mjs) drive a real dist/opencode-mcp.mjs over stdio through the
// dependency-free client in e2e/lib/mcp-client.mjs. Every scenario gets its own temp git repo,
// its own fake-LLM instance and its own opencode-mcp process, so scenarios never share state and
// can be selected individually with `--test-name-pattern` (see e2e/run-e2e.sh --only).
//
// Each scenario is lettered to match docs/design.md §9's list (a-k). (j) and the stretch (k) live
// in separate files/scripts (e2e/bundle-smoke.mjs, e2e/claude-stretch.test.mjs) because they need
// a different base image (node:20) or an extra binary (claude); see e2e/README.md.
//
// A handful of additional, unlettered scenarios (FAIL400, cancel/timeout-during-bash, attach) were
// added after docs/design.md §9 was written, to close specific e2e coverage gaps found by review
// (see each scenario's own comment for the finding it addresses); they are not part of the a-k
// list but run in this same file/process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { McpClient } from './lib/mcp-client.mjs';
import {
  createTempRepo,
  startFakeLlm,
  buildOpencodeConfig,
  baseServerEnv,
  sleep,
  startExternalOpencodeServer,
  waitForFakeLlmRequest,
} from './lib/harness.mjs';

// Generous but bounded: SLOW_REPLY scenarios run up to 30s of scripted upstream "thinking".
const SCENARIO_TIMEOUT_MS = 90_000;

/** Sets up one scenario's temp repo + fake LLM + connected client. Always call `ctx.teardown()`
 * (register via `t.after`) even on failure, so temp dirs/processes never leak between tests. */
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
 * A single-turn result whose own status is failed/timeout is always isError:true (overload
 * design §B), so callers only pass expectError for kind:'error' results. */
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

function hello(repoDir) {
  return join(repoDir, 'hello.txt');
}

/** Resolves the first time an onProgress `params.message` matches `pattern` (e.g. "bash: running").
 * Used instead of a fixed sleep so cancel/timeout-during-a-running-tool scenarios never race a
 * slow/cold managed-server startup: they wait for the actual state, not a guessed duration. */
function progressWaiter(pattern) {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  const handler = (p) => {
    if (pattern.test(p.message ?? '')) resolve(p);
  };
  return { handler, promise };
}

/** Races `promise` against a timeout that rejects (rather than resolving to a sentinel), so a
 * caller that forgets to check the outcome still fails loudly instead of silently proceeding. */
function withDeadline(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${message} (timed out after ${timeoutMs}ms)`);
    }),
  ]);
}

/** True inside the e2e Docker image (e2e/Dockerfile sets this); false for local/manual iteration
 * outside the container, where `ps` behaviour is not guaranteed (see the shutdown/process-list
 * helpers below). */
function insideE2eContainer() {
  return process.env.E2E_WORKDIR === '/work';
}

/** `ps -eo pid,cmd` lines whose command matches `pattern`, or `{unavailable}` if `ps` itself
 * failed/is missing. Shared by the shutdown scenarios (orphaned `opencode serve`) and the
 * cancel/timeout-during-bash scenarios (a leftover `sleep` subprocess). */
function listProcessesMatching(pattern) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,cmd'], { encoding: 'utf8' });
    return out
      .split('\n')
      .slice(1)
      .filter((line) => pattern.test(line) && !/\bps\b/.test(line) && line.trim().length > 0);
  } catch (err) {
    // `ps` may be unavailable/behave differently outside the Linux e2e container; see
    // assertProcessListOrDiagnose below for how that is handled.
    return { unavailable: String(err) };
  }
}

/** Runs `assertion(list)` when `ps` worked; otherwise always logs via t.diagnostic (never silent —
 * e2e/README.md documents this), and additionally FAILS when running inside the e2e container,
 * where `ps` is expected to always be available and its absence signals a real problem worth
 * catching rather than shrugging off (r1-tests-quality-2). Outside the container (e.g. local
 * iteration on a host without `ps`) it only skips that one assertion. */
function assertProcessListOrDiagnose(t, list, assertion) {
  if (Array.isArray(list)) {
    assertion(list);
    return;
  }
  t.diagnostic(`ps unavailable; skipping this process-list assertion: ${list.unavailable}`);
  if (insideE2eContainer()) {
    assert.fail(`ps must be available inside the e2e container; cannot verify process state (${list.unavailable})`);
  }
}

// ---------------------------------------------------------------------------
// a. delegate -> result -> reply -> status -> end
// ---------------------------------------------------------------------------

test('a: delegate -> result -> reply -> status -> end', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('a');
  t.after(ctx.teardown);
  const { client, repo } = ctx;

  const start = unwrap(await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'workspace-write' }));
  assert.equal(start.kind, 'turn');
  assert.equal(start.status, 'completed');
  assert.ok(start.sessionId, 'expected a sessionId');
  assert.ok(start.threadId, 'expected a threadId');
  assert.match(start.content, /DONE/);
  assert.ok(Array.isArray(start.filesChanged) && start.filesChanged.includes('hello.txt'), `filesChanged: ${JSON.stringify(start.filesChanged)}`);
  assert.ok(existsSync(hello(repo.dir)), 'hello.txt should exist on disk');

  const sessionId = start.sessionId;

  const reply = unwrap(await client.callTool('opencode-reply', { sessionId, prompt: 'CALL_TOOL noop {}' }));
  assert.equal(reply.kind, 'turn');
  assert.equal(reply.sessionId, sessionId);
  assert.equal(reply.turn, 2, `expected turn 2, got ${reply.turn}`);
  assert.equal(reply.status, 'completed');

  const statusById = unwrap(await client.callTool('opencode-status', { sessionId }));
  assert.equal(statusById.kind, 'turn');
  assert.equal(statusById.turn, 2);
  assert.equal(statusById.sessionId, sessionId);

  const listing = unwrap(await client.callTool('opencode-status', {}));
  assert.equal(listing.kind, 'sessions');
  assert.equal(listing.opencodeVersion, '1.18.33', `expected opencodeVersion 1.18.33, got ${listing.opencodeVersion}`);
  assert.ok(listing.sessions.some((s) => s.sessionId === sessionId), 'expected the session in the list');

  const end = unwrap(await client.callTool('opencode-end', { sessionId }));
  assert.equal(end.kind, 'end');
  assert.equal(end.status, 'ended');

  const endAgain = unwrap(await client.callTool('opencode-end', { sessionId }));
  assert.equal(endAgain.kind, 'end');
  assert.equal(endAgain.status, 'not_found');

  const statusAfterEnd = await client.callTool('opencode-status', { sessionId });
  const errorContent = unwrap(statusAfterEnd, { expectError: true });
  assert.equal(errorContent.kind, 'error');
  assert.equal(errorContent.error?.name, 'SESSION_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// b. read-only sandbox
// ---------------------------------------------------------------------------

test('b: read-only sandbox denies file mutation', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('b');
  t.after(ctx.teardown);
  const { client, repo } = ctx;

  const result = unwrap(await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'read-only' }), {
    // read-only denial can surface either as a failed turn (TURN_INCOMPLETE) or as a completed
    // turn whose content reports the rejection; both are acceptable, the file must never appear.
    expectError: false,
  });
  assert.ok(['completed', 'failed'].includes(result.status), `unexpected status ${result.status}`);
  assert.ok(!(result.filesChanged ?? []).includes('hello.txt'), `filesChanged should not include hello.txt: ${JSON.stringify(result.filesChanged)}`);
  assert.ok(!existsSync(hello(repo.dir)), 'hello.txt must not have been created under read-only sandbox');
  if (result.status === 'failed') {
    assert.equal(result.error?.name, 'TURN_INCOMPLETE', `expected TURN_INCOMPLETE, got ${JSON.stringify(result.error)}`);
  }

  // bash and edit are denied the same way (edit:*:deny also covers write per design.md F22;
  // bash:*:deny is explicit). Each assertion below is chosen so the prompt WOULD succeed if the
  // corresponding deny rule were dropped — r1-tests-quality-1/r2-r-tests-5 found the previous
  // version vacuous: `echo fake-bash-ok` never touches hello.txt either way, and `edit` targeted a
  // file that did not exist (OpenCode 1.18.33 throws "File not found" before ever asking
  // permission). Both fixes are verified non-vacuous by a manual positive control (temporarily
  // `sandbox:"workspace-write"`): bash's output DOES reach the content, and edit DOES change the
  // file, when unrestricted.
  //
  // apply_patch is NOT exercised here: design.md F22 cites `apply_patch.ts:206` from reading
  // OpenCode's source, but live against opencode-ai@1.18.33's default `build` agent with our fake
  // openai-compatible provider, `CALL_TOOL apply_patch {...}` (in *either* sandbox) gets
  // `"content":"DONE: The arguments provided to the tool are invalid: Model tried to call
  // unavailable tool 'apply_patch'. Available tools: bash, edit, glob, grep, invalid, read, skill,
  // todowrite, webfetch, write."` — the tool is simply not advertised to this session/provider, so
  // read-only's deny rule for it can never be exercised (or vacuously "pass") through this harness.
  // This is a real-binary finding, not a test bug: see the U14 report for detail; a genuine
  // apply_patch e2e check would need whatever provider/model capability actually makes OpenCode
  // advertise that tool, which is outside this unit's scope to discover.

  // bash: RUN_BASH's command (`echo fake-bash-ok`) never touches the filesystem, so the only real
  // signal is whether its output ever reached the model-visible content.
  const bashResult = unwrap(await client.callTool('opencode', { prompt: 'RUN_BASH please', sandbox: 'read-only' }));
  assert.ok(['completed', 'failed'].includes(bashResult.status), `bash: unexpected status ${bashResult.status}`);
  assert.doesNotMatch(bashResult.content ?? '', /fake-bash-ok/, 'bash: read-only must not have run the command');

  // edit: pre-create hello.txt with known content and an oldString that is an exact match, so an
  // unrestricted edit WOULD succeed; assert the file is byte-for-byte unchanged.
  const editOriginal = 'original content\n';
  writeFileSync(hello(repo.dir), editOriginal);
  const editResult = unwrap(
    await client.callTool('opencode', {
      prompt: `CALL_TOOL edit ${JSON.stringify({ filePath: 'hello.txt', oldString: editOriginal, newString: 'changed content\n' })}`,
      sandbox: 'read-only',
    }),
  );
  assert.ok(['completed', 'failed'].includes(editResult.status), `edit: unexpected status ${editResult.status}`);
  assert.equal(
    readFileSync(hello(repo.dir), 'utf8'),
    editOriginal,
    'edit: hello.txt must be unchanged under read-only sandbox',
  );
});

// ---------------------------------------------------------------------------
// c. approval on-request (elicitation) and approval-policy=never
// ---------------------------------------------------------------------------

test('c: on-request approval via elicitation, and never auto-denies', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('c', { permission: { bash: 'ask' } });
  t.after(ctx.teardown);
  const { client } = ctx;

  // 1. accept -> bash runs.
  client.setElicitationHandler(async (req) => {
    assert.match(req.message ?? '', /permission/i);
    return { action: 'accept', content: { decision: 'allow' } };
  });
  const allowed = unwrap(
    await client.callTool('opencode', { prompt: 'RUN_BASH please', sandbox: 'workspace-write', 'approval-policy': 'on-request' }),
  );
  assert.equal(allowed.status, 'completed', `expected completed, got ${JSON.stringify(allowed)}`);
  assert.match(allowed.content, /fake-bash-ok/);

  // 2. decline -> bash does not run; the rejection must be visible one way or another.
  client.setElicitationHandler(async () => ({ action: 'decline' }));
  const declined = unwrap(
    await client.callTool('opencode', { prompt: 'RUN_BASH please', sandbox: 'workspace-write', 'approval-policy': 'on-request' }),
  );
  assert.doesNotMatch(declined.content ?? '', /fake-bash-ok/);
  assert.ok(['completed', 'failed'].includes(declined.status), `unexpected status ${declined.status}`);

  // 3. approval-policy=never -> no elicitation is ever sent, bash is rejected outright.
  let elicitCount = 0;
  client.setElicitationHandler(async () => {
    elicitCount += 1;
    return { action: 'accept', content: { decision: 'allow' } };
  });
  const never = unwrap(
    await client.callTool('opencode', { prompt: 'RUN_BASH please', sandbox: 'workspace-write', 'approval-policy': 'never' }),
  );
  assert.equal(elicitCount, 0, 'approval-policy=never must never elicit');
  assert.doesNotMatch(never.content ?? '', /fake-bash-ok/);
});

// ---------------------------------------------------------------------------
// d. async: wait-seconds:0, then opencode-status wait-seconds:30
// ---------------------------------------------------------------------------

test('d: wait-seconds:0 returns running, status waits to completion', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('d');
  t.after(ctx.teardown);
  const { client } = ctx;

  const start = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 8', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
  assert.equal(start.status, 'running', `expected running immediately, got ${start.status}`);
  const sessionId = start.sessionId;
  assert.ok(sessionId);

  const done = unwrap(await client.callTool('opencode-status', { sessionId, 'wait-seconds': 30 }, { timeoutMs: 40_000 }));
  assert.equal(done.status, 'completed', `expected completed after waiting, got ${done.status}`);
  assert.match(done.content, /SLOW_DONE/);
});

// ---------------------------------------------------------------------------
// e. cancel: session stays usable afterwards
// ---------------------------------------------------------------------------

test('e: cancel stops the turn, session remains usable', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('e');
  t.after(ctx.teardown);
  const { client } = ctx;

  const start = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 30', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
  assert.equal(start.status, 'running');
  const sessionId = start.sessionId;

  const cancelled = unwrap(await client.callTool('opencode-cancel', { sessionId }, { timeoutMs: 20_000 }));
  assert.equal(cancelled.status, 'cancelled', `expected cancelled, got ${JSON.stringify(cancelled)}`);

  const reply = unwrap(await client.callTool('opencode-reply', { sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }));
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after cancel, got ${JSON.stringify(reply)}`);
});

// ---------------------------------------------------------------------------
// f. owning-call cancellation via notifications/cancelled
// ---------------------------------------------------------------------------

test('f: notifications/cancelled on the owning call gets no response', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('f');
  t.after(ctx.teardown);
  const { client, fakeLlm } = ctx;

  let requestId;
  const callPromise = client.callTool('opencode', { prompt: 'SLOW_REPLY 30' }, { onRequestId: (id) => { requestId = id; } });
  callPromise.catch(() => {}); // intentionally abandoned below; avoid an unhandled rejection warning

  // r1-tests-quality-12: a fixed sleep before cancelling races a fresh managed server's own
  // startup (spawn + SSE connect + warm-up, up to config.startupTimeoutMs). If the cancel landed
  // before the prompt was even dispatched, performStop takes its pre-dispatch branch (never calls
  // /abort) and the test would pass without ever exercising owning-call cancel of a real upstream
  // request. Wait for proof the fake LLM actually received the SLOW_REPLY completion request
  // instead.
  await waitForFakeLlmRequest(fakeLlm, (r) => r.plan?.kind === 'slow');
  assert.ok(requestId !== undefined, 'expected to capture a request id before cancelling');
  client.cancel(requestId, 'owning-call-cancel-test');

  const outcome = await Promise.race([
    callPromise.then(() => 'responded'),
    sleep(10_000).then(() => 'no-response'),
  ]);
  assert.equal(outcome, 'no-response', 'the server must not answer a request the client already cancelled');

  // We never got a sessionId back (the call was cancelled before responding), so poll the list —
  // it should be the only tracked session in this scenario's fresh server, and become cancelled.
  let session;
  for (let i = 0; i < 10 && !session; i++) {
    const listing = unwrap(await client.callTool('opencode-status', {}));
    session = listing.sessions.find((s) => s.status === 'cancelled');
    if (!session) await sleep(1000);
  }
  assert.ok(session, 'expected a cancelled session to show up in opencode-status (no id)');

  // The session must not be left quarantined by an owning-call cancel: a follow-up reply must
  // still complete.
  const reply = unwrap(
    await client.callTool('opencode-reply', { sessionId: session.sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }),
  );
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after an owning-call cancel, got ${JSON.stringify(reply)}`);
});

// ---------------------------------------------------------------------------
// g. timeout-seconds
// ---------------------------------------------------------------------------

test('g: timeout-seconds produces status timeout', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('g');
  t.after(ctx.teardown);
  const { client } = ctx;

  const result = unwrap(
    await client.callTool('opencode', { prompt: 'SLOW_REPLY 30', 'timeout-seconds': 3 }, { timeoutMs: 30_000 }),
  );
  assert.equal(result.status, 'timeout', `expected timeout, got ${JSON.stringify(result)}`);

  // The session must not be left quarantined by a timeout: a follow-up reply must still complete
  // (r1-tests-quality-10: a timeout whose stop-confirmation could not be confirmed still reports
  // status 'timeout', so status alone does not prove the session stayed usable).
  const reply = unwrap(
    await client.callTool('opencode-reply', { sessionId: result.sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }),
  );
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after a timeout, got ${JSON.stringify(reply)}`);
});

// ---------------------------------------------------------------------------
// h. progress notifications
// ---------------------------------------------------------------------------

test('h: progress notifications arrive and strictly increase', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('h', { heartbeatSeconds: 2 });
  t.after(ctx.teardown);
  const { client } = ctx;

  const progress = [];
  const result = unwrap(
    await client.callTool('opencode', { prompt: 'SLOW_REPLY 8' }, { onProgress: (p) => progress.push(p), timeoutMs: 30_000 }),
  );
  assert.equal(result.status, 'completed');
  assert.ok(progress.length >= 2, `expected >=2 progress notifications, got ${progress.length}: ${JSON.stringify(progress)}`);
  let last = -Infinity;
  for (const p of progress) {
    assert.ok(p.progress > last, `progress must strictly increase, saw ${p.progress} after ${last}`);
    last = p.progress;
  }
});

// ---------------------------------------------------------------------------
// FAIL400: a real upstream provider error is classified `failed`, not TURN_INCOMPLETE
// (r2-r-tests-5: FAIL500/FAIL400 were implemented in fake-llm-server.mjs but never exercised by
// any scenario, so `status:'failed'` classification of a real OpenCode `info.error` was only ever
// tested against hand-built unit fakes, never real opencode-ai@1.18.33's own error shape.)
// ---------------------------------------------------------------------------

test('FAIL400: forced upstream 400 is classified failed with the real OpenCode error name', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('fail400');
  t.after(ctx.teardown);
  const { client } = ctx;

  const result = unwrap(await client.callTool('opencode', { prompt: 'FAIL400 please' }, { timeoutMs: 30_000 }));
  assert.equal(result.status, 'failed', `expected failed, got ${JSON.stringify(result)}`);
  assert.equal(
    result.error?.name,
    'APIError',
    `expected the real OpenCode error name APIError (not the bridge's own TURN_INCOMPLETE fallback), got ${JSON.stringify(result.error)}`,
  );
  assert.equal(result.executionState, 'stopped', `expected executionState stopped, got ${JSON.stringify(result)}`);

  // The session must not be left quarantined by an upstream failure: a follow-up reply must
  // still complete.
  const reply = unwrap(
    await client.callTool('opencode-reply', { sessionId: result.sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }),
  );
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after FAIL400, got ${JSON.stringify(reply)}`);
});

// ---------------------------------------------------------------------------
// cancel/timeout-during-bash: abort a turn while a *tool* (bash) is actually running, not just
// streaming assistant text (r2-r-tests-7: every existing abort scenario only ever aborted a
// SLOW_REPLY text stream; nothing proved a running bash subprocess is actually killed, or that the
// stop-confirmation loop settles once OpenCode aborts a running tool call instead of streamed
// text).
// ---------------------------------------------------------------------------

const BASH_SLEEP_PROMPT = 'CALL_TOOL bash {"command":"sleep 60","description":"wait"}';

test('cancel-during-bash: opencode-cancel while a bash tool is running kills the process', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('cancel-bash');
  t.after(ctx.teardown);
  const { client } = ctx;

  // wait-seconds:0 returns as soon as the turn is admitted, before the tool has necessarily
  // started — so it hands back a sessionId, but its own progress channel is torn down right after
  // (per-call, not per-turn). Attach a second call (opencode-status) to the same running turn to
  // keep receiving progress for it (design.md's "two observers each receiving heartbeats"
  // guarantee) and wait for the actual "bash: running" tool-progress notification on that call
  // before cancelling — not a fixed sleep, which could land before the tool ever started.
  const start = unwrap(
    await client.callTool('opencode', { prompt: BASH_SLEEP_PROMPT, 'wait-seconds': 0 }, { timeoutMs: 20_000 }),
  );
  assert.equal(start.status, 'running', `expected running immediately, got ${start.status}`);
  const sessionId = start.sessionId;

  const { handler: onProgress, promise: bashRunning } = progressWaiter(/bash: running/);
  const statusPromise = client.callTool(
    'opencode-status',
    { sessionId, 'wait-seconds': 30 },
    { onProgress, timeoutMs: 40_000 },
  );
  statusPromise.catch(() => {}); // observed only for its progress notifications; not awaited below

  await withDeadline(bashRunning, 20_000, 'expected a "bash: running" progress notification');

  const cancelled = unwrap(await client.callTool('opencode-cancel', { sessionId }, { timeoutMs: 20_000 }));
  assert.equal(cancelled.status, 'cancelled', `expected cancelled, got ${JSON.stringify(cancelled)}`);
  assert.equal(
    cancelled.executionState,
    'stopped',
    `expected executionState stopped (a confirmed abort), got ${JSON.stringify(cancelled)}`,
  );

  await sleep(500); // brief grace period for the killed subprocess to actually be reaped
  assertProcessListOrDiagnose(t, listProcessesMatching(/\bsleep 60\b/), (list) =>
    assert.equal(list.length, 0, `expected no leftover "sleep 60" process, found:\n${list.join('\n')}`),
  );

  const reply = unwrap(
    await client.callTool('opencode-reply', { sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }),
  );
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after cancel-during-bash, got ${JSON.stringify(reply)}`);
});

test('timeout-during-bash: timeout-seconds while a bash tool is running kills the process', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('timeout-bash');
  t.after(ctx.teardown);
  const { client } = ctx;

  const progress = [];
  const result = unwrap(
    await client.callTool(
      'opencode',
      { prompt: BASH_SLEEP_PROMPT, 'timeout-seconds': 5 },
      { onProgress: (p) => progress.push(p), timeoutMs: 20_000 },
    ),
  );
  assert.equal(result.status, 'timeout', `expected timeout, got ${JSON.stringify(result)}`);
  assert.equal(
    result.executionState,
    'stopped',
    `expected executionState stopped (a confirmed abort), got ${JSON.stringify(result)}`,
  );
  // Prove the timeout actually landed while the tool was running, not merely during admission —
  // otherwise this would suffer the exact vacuousness r1-tests-quality-12 found in scenario f.
  assert.ok(
    progress.some((p) => /bash: running/.test(p.message ?? '')),
    `expected to observe a "bash: running" progress notification before the timeout fired; saw: ${JSON.stringify(progress)}`,
  );

  await sleep(500);
  assertProcessListOrDiagnose(t, listProcessesMatching(/\bsleep 60\b/), (list) =>
    assert.equal(list.length, 0, `expected no leftover "sleep 60" process, found:\n${list.join('\n')}`),
  );

  const reply = unwrap(
    await client.callTool('opencode-reply', { sessionId: result.sessionId, prompt: 'are you still there?' }, { timeoutMs: 20_000 }),
  );
  assert.equal(reply.status, 'completed', `expected the session to accept a reply after timeout-during-bash, got ${JSON.stringify(reply)}`);
});

// ---------------------------------------------------------------------------
// attach: OPENCODE_MCP_SERVER_URL against a real, externally-owned opencode serve
// (r2-r-tests-8: attach mode had zero e2e coverage against a real OpenCode process; unit tests
// only ever exercised it through a stub API that ignores credentials.)
// ---------------------------------------------------------------------------

test('attach: MCP runs against an externally-owned opencode serve without killing it', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const repo = createTempRepo('attach');
  const fakeLlm = await startFakeLlm({ label: 'attach' });
  const password = randomBytes(24).toString('base64url');
  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl });
  const externalServer = await startExternalOpencodeServer({ cwd: repo.dir, configContent, password });

  let client;
  t.after(async () => {
    try {
      client?.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    await externalServer.stop();
    await fakeLlm.stop();
    repo.cleanup();
  });

  // No OPENCODE_CONFIG_CONTENT here: attach mode never spawns OpenCode itself, so the MCP process
  // needs only the URL and the shared credential — this is exactly the wiring r2-r-tests-8 found
  // untested (config.serverUrl/username/password reaching createOpencodeApi via startAttach).
  const env = {
    OPENCODE_MCP_SERVER_URL: externalServer.url,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_MCP_DEFAULT_CWD: repo.dir,
    OPENCODE_MCP_ALLOWED_ROOTS: repo.dir,
    OPENCODE_MCP_HEARTBEAT_SECONDS: '2',
  };
  client = await McpClient.connect({ cwd: repo.dir, env, initializeTimeoutMs: 20_000 });

  const start = unwrap(await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'workspace-write' }));
  assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start)}`);
  assert.ok(existsSync(join(repo.dir, 'hello.txt')), 'expected the externally-owned server to have actually written hello.txt');
  const sessionId = start.sessionId;

  const reply = unwrap(await client.callTool('opencode-reply', { sessionId, prompt: 'CALL_TOOL noop {}' }));
  assert.equal(reply.status, 'completed', `expected completed, got ${JSON.stringify(reply)}`);

  const end = unwrap(await client.callTool('opencode-end', { sessionId }));
  assert.equal(end.status, 'ended', `expected ended, got ${JSON.stringify(end)}`);

  // Query the externally-owned server directly — the one check attach mode makes possible that
  // managed mode cannot: proof the DELETE actually reached upstream, not just local bookkeeping
  // (scenario a's SESSION_NOT_FOUND after `end` comes from the local registry, not upstream; see
  // e2e/README.md).
  const authHeader = `Basic ${Buffer.from('opencode:' + password, 'utf8').toString('base64')}`;
  const upstream = await fetch(`${externalServer.url}/session/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: authHeader },
  });
  assert.equal(upstream.status, 404, `expected the session to be gone on the externally-owned server, got HTTP ${upstream.status}`);

  // Shut the MCP down via stdin EOF; attach mode must never own (or kill) the remote process —
  // design.md §5.1.
  await client.closeAndWait(15_000);
  assert.ok(
    externalServer.isAlive(),
    'expected the externally-owned opencode serve process to still be running after MCP shutdown',
  );
});

// ---------------------------------------------------------------------------
// i. shutdown (stdin EOF and, separately, SIGINT) stops orphaned opencode processes
// ---------------------------------------------------------------------------

// r1-tests-quality-2: /\bopencode\b/ also matched the MCP server's OWN command line (`node
// /work/dist/opencode-mcp.mjs` — because "opencode" is a substring of "opencode-mcp.mjs" with a
// word boundary), so the "before" precondition below was always true even if the managed
// `opencode serve` child never spawned at all. Match only the managed child's own command.
function listOpencodeProcesses() {
  return listProcessesMatching(/\bopencode serve\b/);
}

async function runShutdownScenario(t, label, stopFn) {
  const ctx = await setupScenario(label);
  const { client } = ctx;
  let torndown = false;
  const teardownOnce = async () => {
    if (torndown) return;
    torndown = true;
    await ctx.teardown();
  };
  t.after(teardownOnce);

  const callPromise = client.callTool('opencode', { prompt: 'SLOW_REPLY 30' });
  callPromise.catch(() => {});
  await sleep(2000); // let the managed `opencode serve` actually spawn and start the turn

  assertProcessListOrDiagnose(t, listOpencodeProcesses(), (list) =>
    assert.ok(list.length > 0, 'expected a managed `opencode serve` process to be running before shutdown'),
  );

  stopFn(client);
  const exit = await client.waitForExit(20_000);
  // src/index.ts always calls process.exit(code) on both the stdin-EOF and every signal path, so
  // a real exit code/signal===null is always attainable; `code===null` (death by an unhandled
  // signal) would silently accept a broken/removed shutdown handler (r1-tests-quality-2).
  assert.equal(exit.code, 0, `expected a clean exit code, got ${JSON.stringify(exit)}`);
  assert.equal(exit.signal, null, `expected the process to exit on its own, not be killed by a signal, got ${JSON.stringify(exit)}`);

  await sleep(1500); // grace period for process-group cleanup after the server exits
  assertProcessListOrDiagnose(t, listOpencodeProcesses(), (list) =>
    assert.equal(list.length, 0, `expected no leftover opencode processes, found:\n${list.join('\n')}`),
  );

  await teardownOnce();
}

test('i: shutdown via stdin EOF cleans up orphaned opencode processes', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  await runShutdownScenario(t, 'i-eof', (client) => client.close());
});

test('i2: shutdown via SIGINT cleans up orphaned opencode processes', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  await runShutdownScenario(t, 'i-sigint', (client) => client.kill('SIGINT'));
});

// ---------------------------------------------------------------------------
// i3: a hard SIGKILL of the MCP server itself (mid-turn) must not orphan `opencode serve` (P2 fix
// r2/g1-1). Unlike i/i2 above, no graceful shutdown code in src/index.ts ever runs here — the
// managed child's own watchdog (managed-server.ts) is the only thing that can notice its parent
// died and reap it.
// ---------------------------------------------------------------------------

test('i3: SIGKILL of the MCP server mid-turn leaves no orphaned opencode serve process', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('i3-sigkill');
  const { client } = ctx;
  let torndown = false;
  const teardownOnce = async () => {
    if (torndown) return;
    torndown = true;
    await ctx.teardown();
  };
  t.after(teardownOnce);

  const callPromise = client.callTool('opencode', { prompt: 'SLOW_REPLY 30' });
  callPromise.catch(() => {});
  await sleep(2000); // let the managed `opencode serve` actually spawn and start the turn

  assertProcessListOrDiagnose(t, listOpencodeProcesses(), (list) =>
    assert.ok(list.length > 0, 'expected a managed `opencode serve` process to be running before the hard kill'),
  );

  // Hard-kill the MCP server itself (SIGKILL: uncatchable, no code in src/index.ts ever runs).
  client.kill('SIGKILL');
  await client.waitForExit(10_000);

  // The watchdog polls its parent's liveness every 5s (managed-server.ts's WATCHDOG_SCRIPT), then
  // TERMs the real opencode process. A slightly wider margin than the unit test's ~10s bound is
  // used here (a real opencode-ai binary's own shutdown can take a little longer than the
  // fake-opencode.mjs fixture's near-instant exit).
  await sleep(12_000);
  assertProcessListOrDiagnose(t, listOpencodeProcesses(), (list) =>
    assert.equal(
      list.length,
      0,
      `expected no leftover opencode processes after a hard SIGKILL, found:\n${list.join('\n')}`,
    ),
  );

  await teardownOnce();
});

export { setupScenario, unwrap, hello };
