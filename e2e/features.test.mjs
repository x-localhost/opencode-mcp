// Hermetic e2e scenarios for opencode-mcp's v0.3 delegation features, against the REAL
// opencode-ai@1.18.33 binary (not a stub). See the v0.3 features contract and
// docs/research/opencode-features-probe.md for the real-binary behaviour this guards against
// (notably: prompt `format` must NEVER be sent — it permanently breaks
// `GET /session/{id}/message` on 1.18.33).
//
// Phase 1 (scenarios 1-5): output paging/retention (`detail`, `max-output-chars`,
// `opencode-output` section "answer"), per-turn diff (`opencode-output` section "diff"), and
// bridge-side structured output (`output-schema`).
// Phase 2 (scenarios 6-8): request-id deduplication, `opencode-info`
// discovery, and batch status via `opencode-status` `ids`/`wait-for`.
//
// Deliberately does NOT import e2e/scenarios.test.mjs: that file registers its own `test(...)`
// scenarios at module-evaluation time, so importing it here would re-run scenarios a-i (etc.)
// inside THIS file's `node --test` process too — defeating e2e/run-e2e.sh's separate "feature
// scenarios" step and its own PASS/FAIL/SKIP accounting. The handful of setup helpers this file
// needs are therefore duplicated (not re-exported) from e2e/scenarios.test.mjs, kept intentionally
// tiny; e2e/lib/harness.mjs remains the single shared, side-effect-free source for the actual
// process/repo/fake-LLM plumbing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { McpClient } from './lib/mcp-client.mjs';
import { createTempRepo, startFakeLlm, buildOpencodeConfig, baseServerEnv, sleep } from './lib/harness.mjs';
import { buildLongText } from './lib/long-text.mjs';

// Generous but bounded: the long-answer-paging scenario alone makes dozens of opencode-output
// round trips.
const SCENARIO_TIMEOUT_MS = 90_000;
// Contract invariant (v0.3 features contract §0): every result's
// structuredContent must serialize under this many characters.
const HARD_BUDGET = 45_000;

/** Sets up one scenario's temp repo + fake LLM + connected client (duplicated from
 * e2e/scenarios.test.mjs's own setupScenario — see the file header comment for why). Always call
 * `ctx.teardown()` (register via `t.after`) even on failure, so temp dirs/processes never leak.
 * `apiKey` (default 'fake-key') lets the opencode-info scenario plant a sentinel value it can then
 * assert never leaks into any MCP-facing result. */
async function setupScenario(label, { permission, heartbeatSeconds, extraEnv, apiKey } = {}) {
  const repo = createTempRepo(label);
  const fakeLlm = await startFakeLlm({ label });
  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl, permission, apiKey });
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

/** True inside the e2e Docker image (e2e/Dockerfile sets this); false for local/manual iteration
 * outside the container, where `ps` behaviour is not guaranteed (duplicated from
 * e2e/scenarios.test.mjs — see the file header comment for why). */
function insideE2eContainer() {
  return process.env.E2E_WORKDIR === '/work';
}

/** `ps -eo pid,cmd` lines whose command matches `pattern`, or `{unavailable}` if `ps` itself
 * failed/is missing (duplicated from e2e/scenarios.test.mjs). */
function listProcessesMatching(pattern) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,cmd'], { encoding: 'utf8' });
    return out
      .split('\n')
      .slice(1)
      .filter((line) => pattern.test(line) && !/\bps\b/.test(line) && line.trim().length > 0);
  } catch (err) {
    return { unavailable: String(err) };
  }
}

/** Runs `assertion(list)` when `ps` worked; otherwise logs via t.diagnostic and additionally FAILS
 * inside the e2e container (where `ps` is expected to always be available), matching
 * e2e/scenarios.test.mjs's own policy. */
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

function listOpencodeProcesses() {
  return listProcessesMatching(/\bopencode serve\b/);
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

/** Contract invariant §0: every result's structuredContent must serialize under HARD_BUDGET. */
function assertWithinBudget(structuredContent, label) {
  const size = JSON.stringify(structuredContent).length;
  assert.ok(size < HARD_BUDGET, `${label}: structuredContent must serialize under ${HARD_BUDGET} chars, got ${size}`);
}

// ---------------------------------------------------------------------------
// 1. Long-answer paging: detail:"compact" + a small max-output-chars keep the immediate result
//    small; opencode-output pages back the full retained answer exactly, across a real UTF-16
//    surrogate-pair boundary, for two different page sizes.
// ---------------------------------------------------------------------------

test(
  'long-answer-paging: compact/small max-output-chars stays small; opencode-output reconstructs the exact original text across a surrogate-pair boundary',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('long-reply');
    t.after(ctx.teardown);
    const { client } = ctx;

    const totalChars = 9000;
    const expectedText = buildLongText(totalChars);

    const start = unwrap(
      await client.callTool(
        'opencode',
        { prompt: `LONG_REPLY ${totalChars}`, detail: 'compact', 'max-output-chars': 40 },
        { timeoutMs: 30_000 },
      ),
    );
    assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start).slice(0, 500)}`);
    assert.ok(start.sessionId, 'expected a sessionId');
    assert.ok(typeof start.turn === 'number', 'expected a turn number');
    assert.ok(
      start.content.length <= 40,
      `content should be capped at max-output-chars=40, got length ${start.content.length}: ${JSON.stringify(start.content)}`,
    );
    assert.ok(start.output, 'expected output metadata on the turn result');
    assert.equal(start.output.state, 'retained', `expected output.state retained, got ${JSON.stringify(start.output)}`);
    assert.equal(
      start.output.answerChars,
      totalChars,
      `expected the retained answer to record the full ${totalChars} chars, got ${JSON.stringify(start.output)}`,
    );
    // compact drops toolCalls/filesChanged in favour of counts, and lists them in omittedFields
    // (v0.3 §1).
    assert.equal(start.toolCalls, undefined, 'compact must omit toolCalls');
    assert.equal(start.filesChanged, undefined, 'compact must omit filesChanged');
    assert.ok(
      (start.omittedFields ?? []).includes('toolCalls') && (start.omittedFields ?? []).includes('filesChanged'),
      `expected omittedFields to list toolCalls and filesChanged, got ${JSON.stringify(start.omittedFields)}`,
    );
    assertWithinBudget(start, 'opencode (compact, max-output-chars:40)');

    const { sessionId, turn } = start;

    async function readAllPages(limit) {
      let offset = 0;
      let text = '';
      let pages = 0;
      for (;;) {
        const page = unwrap(
          await client.callTool('opencode-output', { sessionId, turn, section: 'answer', offset, limit }),
        );
        pages++;
        assertWithinBudget(page, `opencode-output answer page (limit=${limit}, offset=${offset})`);
        assert.equal(page.kind, 'output');
        assert.equal(page.section, 'answer');
        assert.equal(page.total, totalChars, `total must always report the full answer length`);
        assert.equal(page.turn, turn);
        assert.equal(page.sessionId, sessionId);
        text += page.content;
        if (page.nextOffset === null) {
          assert.equal(page.hasMore, false, 'nextOffset:null must imply hasMore:false');
          break;
        }
        assert.equal(typeof page.nextOffset, 'number', 'nextOffset must be a number or null');
        assert.ok(page.nextOffset > offset, `nextOffset must advance (was ${offset}, got ${page.nextOffset})`);
        assert.equal(page.hasMore, true, 'a non-null nextOffset must imply hasMore:true');
        offset = page.nextOffset;
        assert.ok(pages < 5000, 'too many pages: paging appears to be stuck');
      }
      return text;
    }

    const reconstructed256 = await readAllPages(256);
    assert.equal(
      reconstructed256,
      expectedText,
      'limit:256 paging must reconstruct the exact original text across the surrogate-pair boundary at offset 256',
    );

    const reconstructed4000 = await readAllPages(4000);
    assert.equal(
      reconstructed4000,
      expectedText,
      'limit:4000 paging must reconstruct the exact original text across the surrogate-pair boundary at offset 4000',
    );

    // offset === total -> an explicit empty final page (contract §1), never an error.
    const emptyFinal = unwrap(
      await client.callTool('opencode-output', { sessionId, turn, section: 'answer', offset: totalChars, limit: 256 }),
    );
    assert.equal(emptyFinal.content, '');
    assert.equal(emptyFinal.nextOffset, null);
    assert.equal(emptyFinal.hasMore, false);
    assert.equal(emptyFinal.total, totalChars);

    // offset > total -> INVALID_ARGUMENT (contract §1), not a silent empty page or a crash.
    const tooFar = await client.callTool('opencode-output', {
      sessionId,
      turn,
      section: 'answer',
      offset: totalChars + 1,
      limit: 256,
    });
    const tooFarError = unwrap(tooFar, { expectError: true });
    assert.equal(tooFarError.error?.name, 'INVALID_ARGUMENT', `expected INVALID_ARGUMENT, got ${JSON.stringify(tooFarError)}`);
  },
);

// ---------------------------------------------------------------------------
// 2. Bridge-side structured output: a valid ```json block is extracted/validated; two invalid
//    variants (ambiguous / malformed) are reported without failing the turn; the schema instruction
//    is proven turn-local (present only in this turn's own request, never a later reply's); and
//    OpenCode's own `format`-injected `StructuredOutput` tool never appears in any request (proof
//    the bridge never sends prompt `format`, per docs/research/opencode-features-probe.md).
// ---------------------------------------------------------------------------

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', maxLength: 200 },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

test(
  'structured-output: valid JSON is extracted and validated; invalid variants report status without failing; the schema instruction is turn-local',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('structured');
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    const value = { answer: '42', confidence: 0.9 };
    const start = unwrap(
      await client.callTool('opencode', {
        prompt: `STRUCTURED_VALID ${JSON.stringify(value)}`,
        'output-schema': ANSWER_SCHEMA,
      }),
    );
    assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start)}`);
    assert.equal(start.structuredOutputStatus, 'valid', `expected valid, got ${JSON.stringify(start)}`);
    assert.deepEqual(start.structuredOutput, value);
    assertWithinBudget(start, 'opencode (valid structured output)');
    const { sessionId, turn } = start;

    // The schema instruction must appear somewhere in THIS turn's own request to the fake LLM, and
    // OpenCode's own `format`-injected tool must never appear in ANY request — proof prompt
    // `format` was never sent (probe headline surprise #1: it permanently breaks message-list
    // reads on 1.18.33).
    //
    // The marker is the fixed instruction PROSE (src/core/structured-output.ts's
    // buildStructuredOutputInstruction), not `JSON.stringify(ANSWER_SCHEMA)`: `validateOutputSchema`
    // returns a re-built, keyword-checked COPY of the caller's schema (src/core/
    // structured-output.ts's `copyNode`), which inserts keys in its OWN fixed order (`type`,
    // `properties`, `additionalProperties`, `required`) — not the caller's literal key order — so
    // comparing against the caller's own `JSON.stringify` is a real, order-sensitive test bug, not
    // a product one (confirmed against the real binary: the schema content — property names,
    // `maxLength`, `additionalProperties` — is present, just reserialized). Individual
    // field-level substrings (stable regardless of outer key order) additionally prove the schema
    // CONTENT itself, not just generic instruction prose, made it into the request.
    const INSTRUCTION_MARKER = 'your final message must contain exactly one fenced code block';
    const SCHEMA_FIELD_MARKERS = ['"confidence"', '"maxLength":200', '"additionalProperties":false'];
    const reqsAfterStart = await fakeLlm.requests();
    for (const r of reqsAfterStart) {
      assert.ok(
        !(r.tools ?? []).includes('StructuredOutput'),
        `no request may ever include OpenCode's own injected StructuredOutput tool: ${JSON.stringify(r.tools)}`,
      );
    }
    const turnRequest = reqsAfterStart.find(
      (r) => (r.tools ?? []).length > 0 && (r.messages ?? []).some((m) => m.text.includes('STRUCTURED_VALID')),
    );
    assert.ok(turnRequest, `expected to find the fake LLM request for the structured-output turn among ${JSON.stringify(reqsAfterStart.map((r) => r.plan))}`);
    const turnRequestText = turnRequest.messages.map((m) => m.text).join('\n---\n');
    assert.ok(
      turnRequestText.includes(INSTRUCTION_MARKER),
      `expected the schema instruction prose to appear in this turn's request: ${turnRequestText.slice(-1000)}`,
    );
    for (const marker of SCHEMA_FIELD_MARKERS) {
      assert.ok(
        turnRequestText.includes(marker),
        `expected the schema content (${marker}) to appear in this turn's request: ${turnRequestText.slice(-1000)}`,
      );
    }

    // opencode-output section structured-output returns the canonical (whole, single-page) JSON.
    const structuredPage = unwrap(await client.callTool('opencode-output', { sessionId, turn, section: 'structured-output' }));
    assert.equal(structuredPage.content, JSON.stringify(value));
    assert.equal(structuredPage.nextOffset, null);
    assert.equal(structuredPage.total, JSON.stringify(value).length);

    // A follow-up reply WITHOUT output-schema must complete normally and must never resend the
    // schema instruction (v0.3 §6: "Turn-local: never inherited by a later reply" — and probe Q1:
    // OpenCode itself does not resend this kind of per-message addition to a later prompt either).
    const reply = unwrap(await client.callTool('opencode-reply', { sessionId, prompt: 'CALL_TOOL noop {}' }));
    assert.equal(reply.status, 'completed', `expected completed, got ${JSON.stringify(reply)}`);
    assert.equal(reply.structuredOutputStatus, undefined, 'a reply without output-schema must not report structuredOutputStatus');
    assert.match(reply.content, /DONE/);

    const reqsAfterReply = await fakeLlm.requests();
    const newRequests = reqsAfterReply.slice(reqsAfterStart.length);
    assert.ok(newRequests.length > 0, 'expected at least one new fake-LLM request for the reply');
    for (const r of newRequests) {
      assert.ok(
        !(r.messages ?? []).some((m) => m.text.includes(INSTRUCTION_MARKER)),
        `the schema instruction must not be resent on a later reply's request: ${JSON.stringify(r.messages)}`,
      );
      assert.ok(!(r.tools ?? []).includes('StructuredOutput'), `no request may ever include StructuredOutput: ${JSON.stringify(r.tools)}`);
    }

    // Invalid variant 1: two ```json blocks -> JSON_AMBIGUOUS; the turn still completes (conformance
    // never changes status/error — v0.3 §6).
    const ambiguous = unwrap(
      await client.callTool('opencode-reply', { sessionId, prompt: 'STRUCTURED_AMBIGUOUS', 'output-schema': ANSWER_SCHEMA }),
    );
    assert.equal(ambiguous.status, 'completed', `expected completed even though structured output is invalid, got ${JSON.stringify(ambiguous)}`);
    assert.equal(ambiguous.structuredOutputStatus, 'invalid');
    assert.equal(
      ambiguous.structuredOutputError?.code,
      'JSON_AMBIGUOUS',
      `expected JSON_AMBIGUOUS, got ${JSON.stringify(ambiguous.structuredOutputError)}`,
    );
    assert.equal(ambiguous.structuredOutput, undefined, 'invalid status must never carry a structuredOutput value');

    // Invalid variant 2: a properly-closed ```json block whose body is not valid JSON ->
    // JSON_PARSE_ERROR; the turn still completes.
    const badJson = unwrap(
      await client.callTool('opencode-reply', { sessionId, prompt: 'STRUCTURED_BADJSON', 'output-schema': ANSWER_SCHEMA }),
    );
    assert.equal(badJson.status, 'completed', `expected completed even though structured output is invalid, got ${JSON.stringify(badJson)}`);
    assert.equal(badJson.structuredOutputStatus, 'invalid');
    assert.equal(
      badJson.structuredOutputError?.code,
      'JSON_PARSE_ERROR',
      `expected JSON_PARSE_ERROR, got ${JSON.stringify(badJson.structuredOutputError)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Per-turn diff: turn 1 writes file A (a `write` tool call), turn 2 writes file B via `bash`.
//    opencode-output section "diff" for each turn lists only that turn's own file (stat view, with
//    a snapshot-id), and the patch view returns that file's patch text. A snapshot-id that does not
//    match the live snapshot (a stand-in for "stale after a refetch" — see the note below) ->
//    SNAPSHOT_EXPIRED.
// ---------------------------------------------------------------------------

test(
  'per-turn diff: each turn\'s diff lists only the file that turn touched; patch view reads its content; a mismatched snapshot-id is rejected',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('diff');
    t.after(ctx.teardown);
    const { client } = ctx;

    // Turn 1: write A.txt via the `write` tool.
    const start = unwrap(
      await client.callTool('opencode', {
        prompt: `CALL_TOOL write ${JSON.stringify({ filePath: 'A.txt', content: 'hello A\n' })}`,
        sandbox: 'workspace-write',
      }),
    );
    assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start)}`);
    assert.ok((start.filesChanged ?? []).includes('A.txt'), `expected filesChanged to include A.txt: ${JSON.stringify(start.filesChanged)}`);
    const { sessionId } = start;
    const turn1 = start.turn;

    // Turn 2: write B.txt via `bash` (not the `write` tool) — proves the diff is read from
    // OpenCode's own snapshot, not just from tracking `write` tool calls.
    const reply = unwrap(
      await client.callTool('opencode-reply', {
        sessionId,
        prompt: 'CALL_TOOL bash {"command":"echo hi > B.txt","description":"write B"}',
      }),
    );
    assert.equal(reply.status, 'completed', `expected completed, got ${JSON.stringify(reply)}`);
    const turn2 = reply.turn;
    assert.notEqual(turn2, turn1);

    // Turn 1's diff: stat view, only A.txt.
    const diff1 = unwrap(await client.callTool('opencode-output', { sessionId, turn: turn1, section: 'diff' }));
    assert.equal(diff1.kind, 'output');
    assert.equal(diff1.section, 'diff');
    assert.ok(diff1.diff, 'expected a diff object');
    assert.equal(diff1.diff.source, 'opencode-snapshot');
    assert.equal(diff1.diff.completeness, 'not-guaranteed');
    assert.equal(diff1.diff.view, 'stat');
    assert.equal(diff1.diff.files.length, 1, `expected exactly one changed file for turn 1, got ${JSON.stringify(diff1.diff.files)}`);
    assert.ok(diff1.diff.files[0].file?.endsWith('A.txt'), `expected A.txt, got ${JSON.stringify(diff1.diff.files[0])}`);
    assertWithinBudget(diff1, 'opencode-output diff stat (turn 1)');
    const snapshotId1 = diff1.diff.snapshotId;
    assert.ok(snapshotId1, 'expected a snapshot-id from the stat page');

    // Turn 2's diff: stat view, only B.txt (never A.txt, even though A.txt still exists on disk).
    const diff2 = unwrap(await client.callTool('opencode-output', { sessionId, turn: turn2, section: 'diff' }));
    assert.equal(diff2.diff.files.length, 1, `expected exactly one changed file for turn 2, got ${JSON.stringify(diff2.diff.files)}`);
    assert.ok(diff2.diff.files[0].file?.endsWith('B.txt'), `expected B.txt, got ${JSON.stringify(diff2.diff.files[0])}`);
    assert.equal(diff2.diff.source, 'opencode-snapshot');
    assert.equal(diff2.diff.completeness, 'not-guaranteed');

    // Turn 1's patch view: the patch text of A.txt.
    const patch1 = unwrap(
      await client.callTool('opencode-output', {
        sessionId,
        turn: turn1,
        section: 'diff',
        'diff-view': 'patch',
        'file-index': 0,
        'snapshot-id': snapshotId1,
      }),
    );
    assert.equal(patch1.diff.view, 'patch');
    assert.ok(patch1.content.length > 0, 'expected non-empty patch text');
    assert.match(patch1.content, /hello A/, `expected the patch text to mention the file's new content: ${JSON.stringify(patch1.content)}`);
    assertWithinBudget(patch1, 'opencode-output diff patch (turn 1)');

    // A snapshot-id that does not match the current live snapshot is rejected as SNAPSHOT_EXPIRED —
    // this is the same code path a genuinely stale snapshot-id (from before a TTL-driven refetch)
    // would hit; we exercise it via a mismatched id instead of waiting out the real 5-minute TTL
    // (src/core/engine.ts's DIFF_SNAPSHOT_TTL_MS), which would make this suite five minutes slower
    // for the same code path. See this test's report for the exact distinction.
    const stale = await client.callTool('opencode-output', {
      sessionId,
      turn: turn1,
      section: 'diff',
      'diff-view': 'patch',
      'file-index': 0,
      'snapshot-id': 'not-a-real-snapshot-id',
    });
    const staleError = unwrap(stale, { expectError: true });
    assert.equal(staleError.error?.name, 'SNAPSHOT_EXPIRED', `expected SNAPSHOT_EXPIRED, got ${JSON.stringify(staleError)}`);
  },
);

// ---------------------------------------------------------------------------
// 4. Regression guard: message history stays readable after a structured-output turn (1.18.33's
//    `format`-breaks-message-list bug, docs/research/opencode-features-probe.md headline surprise
//    #1 — never triggered here since the bridge never sends `format`, but this is what would have
//    caught it if it had been).
// ---------------------------------------------------------------------------

test(
  'structured-output regression: message history stays readable after a structured-output turn (a follow-up reply completes normally)',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('structured-regression');
    t.after(ctx.teardown);
    const { client } = ctx;

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const start = unwrap(
      await client.callTool('opencode', { prompt: `STRUCTURED_VALID ${JSON.stringify({ ok: true })}`, 'output-schema': schema }),
    );
    assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start)}`);
    assert.equal(start.structuredOutputStatus, 'valid');
    const { sessionId, turn } = start;

    // A follow-up reply reads the session's message history to build its own result (src/core/
    // turn.ts calls `api.messages`); if the bridge had ever sent OpenCode's own `format`, this
    // would fail with a permanent HTTP 400 on 1.18.33 instead of completing.
    const reply = unwrap(await client.callTool('opencode-reply', { sessionId, prompt: 'CALL_TOOL noop {}' }));
    assert.equal(reply.status, 'completed', `expected completed, got ${JSON.stringify(reply)}`);
    assert.match(reply.content, /DONE/);
    assert.equal(reply.turn, turn + 1);

    // opencode-status against the same session still works (also reads session state upstream).
    const status = unwrap(await client.callTool('opencode-status', { sessionId }));
    assert.equal(status.status, 'completed');
    assert.equal(status.turn, turn + 1);

    // The ORIGINAL structured-output turn's retained answer is still readable too.
    const answerPage = unwrap(await client.callTool('opencode-output', { sessionId, turn, section: 'answer' }));
    assert.equal(answerPage.kind, 'output');
    assert.ok(answerPage.content.length > 0, 'expected the original structured-output turn\'s answer text to still be readable');
  },
);

// ---------------------------------------------------------------------------
// 5. opencode-end then opencode-output -> SESSION_NOT_FOUND.
// ---------------------------------------------------------------------------

test('opencode-end then opencode-output -> SESSION_NOT_FOUND', { timeout: SCENARIO_TIMEOUT_MS }, async (t) => {
  const ctx = await setupScenario('end-then-output');
  t.after(ctx.teardown);
  const { client } = ctx;

  const start = unwrap(await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'workspace-write' }));
  assert.equal(start.status, 'completed', `expected completed, got ${JSON.stringify(start)}`);
  const { sessionId, turn } = start;

  const end = unwrap(await client.callTool('opencode-end', { sessionId }));
  assert.equal(end.status, 'ended', `expected ended, got ${JSON.stringify(end)}`);

  const afterEnd = await client.callTool('opencode-output', { sessionId, turn });
  const errorContent = unwrap(afterEnd, { expectError: true });
  assert.equal(errorContent.kind, 'error');
  assert.equal(errorContent.error?.name, 'SESSION_NOT_FOUND', `expected SESSION_NOT_FOUND, got ${JSON.stringify(errorContent)}`);
});

// ---------------------------------------------------------------------------
// 6. request-id: two concurrent identical `opencode` calls with the same request-id join one
//    operation (one session, one delegated prompt); a different prompt under the same id ->
//    REQUEST_ID_CONFLICT; after opencode-end, the same id/args -> REQUEST_ENDED; a duplicate
//    opencode-reply with the same request-id never sends a second prompt either.
// ---------------------------------------------------------------------------

test(
  'request-id: concurrent duplicates join one operation; conflicting/ended reservations are rejected; duplicate replies never re-send',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('request-id');
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    const slowCount = async () => (await fakeLlm.requests()).filter((r) => r.plan?.kind === 'slow').length;

    const rid = 'f9b-req-1';
    const startArgs = { prompt: 'SLOW_REPLY 3', 'request-id': rid };

    // Two calls fired without awaiting between them, same request-id and same arguments: exactly
    // one operation is actually admitted; the other joins it as a replay.
    const [r1, r2] = await Promise.all([
      client.callTool('opencode', startArgs, { timeoutMs: 30_000 }),
      client.callTool('opencode', startArgs, { timeoutMs: 30_000 }),
    ]);
    const a = unwrap(r1);
    const b = unwrap(r2);
    assert.equal(a.status, 'completed', `expected completed, got ${JSON.stringify(a)}`);
    assert.equal(b.status, 'completed', `expected completed, got ${JSON.stringify(b)}`);
    assert.equal(a.sessionId, b.sessionId, 'both duplicate calls must resolve to the same session');
    assert.equal(a.turn, b.turn, 'both duplicate calls must resolve to the same turn');
    assert.ok(a.request && b.request, `expected a request receipt on both results: ${JSON.stringify([a.request, b.request])}`);
    assert.equal(a.request.id, rid);
    assert.equal(b.request.id, rid);
    assert.deepEqual(
      [a.request.replayed, b.request.replayed].sort(),
      [false, true],
      `expected exactly one original (replayed:false) and one duplicate (replayed:true), got ${JSON.stringify([a.request, b.request])}`,
    );

    // Exactly one prompt was actually delegated to OpenCode/the fake LLM for this request-id.
    assert.equal(await slowCount(), 1, 'expected exactly one delegated SLOW_REPLY request for two duplicate calls');

    // Exactly one session was created.
    const listing = unwrap(await client.callTool('opencode-status', {}));
    assert.equal(listing.kind, 'sessions');
    assert.equal(
      listing.sessions.filter((s) => s.sessionId === a.sessionId).length,
      1,
      `expected exactly one tracked session, got ${JSON.stringify(listing.sessions)}`,
    );
    const sessionId = a.sessionId;

    // The same request-id with a DIFFERENT prompt -> REQUEST_ID_CONFLICT, and it never reaches
    // OpenCode/the fake LLM at all (reservation is checked before any upstream mutation).
    const beforeConflict = (await fakeLlm.requests()).length;
    const conflict = await client.callTool('opencode', { prompt: 'SLOW_REPLY 3 but different', 'request-id': rid });
    const conflictError = unwrap(conflict, { expectError: true });
    assert.equal(conflictError.error?.name, 'REQUEST_ID_CONFLICT', `expected REQUEST_ID_CONFLICT, got ${JSON.stringify(conflictError)}`);
    assert.equal((await fakeLlm.requests()).length, beforeConflict, 'a conflicting request-id must never reach OpenCode/the fake LLM');

    // opencode-end, then the SAME request-id with the SAME original arguments -> REQUEST_ENDED.
    const end = unwrap(await client.callTool('opencode-end', { sessionId }));
    assert.equal(end.status, 'ended', `expected ended, got ${JSON.stringify(end)}`);
    const afterEnd = await client.callTool('opencode', startArgs);
    const endedError = unwrap(afterEnd, { expectError: true });
    assert.equal(endedError.error?.name, 'REQUEST_ENDED', `expected REQUEST_ENDED, got ${JSON.stringify(endedError)}`);

    // A duplicate opencode-reply with the same request-id never sends a second prompt either.
    const fresh = unwrap(await client.callTool('opencode', { prompt: 'WRITE_FILE please', sandbox: 'workspace-write' }));
    assert.equal(fresh.status, 'completed', `expected completed, got ${JSON.stringify(fresh)}`);
    const replyArgs = { sessionId: fresh.sessionId, prompt: 'SLOW_REPLY 3', 'request-id': 'f9b-reply-1' };
    const beforeReplyCount = await slowCount();
    const [rr1, rr2] = await Promise.all([
      client.callTool('opencode-reply', replyArgs, { timeoutMs: 30_000 }),
      client.callTool('opencode-reply', replyArgs, { timeoutMs: 30_000 }),
    ]);
    const ra = unwrap(rr1);
    const rb = unwrap(rr2);
    assert.equal(ra.status, 'completed', `expected completed, got ${JSON.stringify(ra)}`);
    assert.equal(rb.status, 'completed', `expected completed, got ${JSON.stringify(rb)}`);
    assert.equal(ra.turn, rb.turn, 'both duplicate replies must resolve to the same turn');
    assert.deepEqual([ra.request?.replayed, rb.request?.replayed].sort(), [false, true]);
    assert.equal(
      (await slowCount()) - beforeReplyCount,
      1,
      'expected exactly one delegated prompt for two duplicate opencode-reply calls',
    );
  },
);

// ---------------------------------------------------------------------------
// 7. opencode-info: section "server" works without ever starting OpenCode; "models" lists the fake
//    provider's model id (and that id works as `model` in a following opencode call); "agents"
//    includes "build"; "roots" lists the allowed root; no secret-shaped value leaks anywhere.
// ---------------------------------------------------------------------------

test(
  'opencode-info: server/models/agents/roots never leak secrets; a discovered model id works in a following opencode call',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const SENTINEL_API_KEY = 'SENTINEL-DO-NOT-LEAK-9f3c2a7e';
    const ctx = await setupScenario('info', { apiKey: SENTINEL_API_KEY });
    t.after(ctx.teardown);
    const { client, repo, fakeLlm } = ctx;

    // section "server" (default): the very first call this fresh process makes. Must never start
    // OpenCode — assert both the reported state AND that no `opencode serve` process exists yet.
    const server = unwrap(await client.callTool('opencode-info', {}));
    assert.equal(server.kind, 'info');
    assert.equal(server.section, 'server');
    assert.ok(server.server, `expected a server object, got ${JSON.stringify(server)}`);
    assert.equal(server.server.connectionState, 'not_started', `expected not_started, got ${JSON.stringify(server.server)}`);
    assert.equal(server.server.opencodeVersion, null);
    assert.equal(server.server.mode, 'managed');
    assert.ok(Array.isArray(server.server.capabilities) && server.server.capabilities.includes('request-id'));
    assertProcessListOrDiagnose(t, listOpencodeProcesses(), (list) =>
      assert.equal(list.length, 0, `expected no opencode serve process yet, found:\n${list.join('\n')}`),
    );
    assertWithinBudget(server, 'opencode-info section:server');

    // section "models": lists the fake provider's model id (this DOES warm up OpenCode).
    const models = unwrap(await client.callTool('opencode-info', { section: 'models' }));
    assert.equal(models.section, 'models');
    assert.ok(Array.isArray(models.models) && models.models.length > 0, `expected at least one model, got ${JSON.stringify(models.models)}`);
    const fakeModel = models.models.find((m) => m.providerId === 'fake');
    assert.ok(fakeModel, `expected a "fake" provider model, got ${JSON.stringify(models.models)}`);
    assert.equal(fakeModel.model, 'fake/fake-model', `expected model id "fake/fake-model", got ${JSON.stringify(fakeModel)}`);

    // That model identifier actually works as `model` in a following opencode call.
    const started = unwrap(
      await client.callTool('opencode', { prompt: 'WRITE_FILE please', model: fakeModel.model, sandbox: 'workspace-write' }),
    );
    assert.equal(started.status, 'completed', `expected completed with model ${fakeModel.model}, got ${JSON.stringify(started)}`);

    // section "agents": includes "build" (real OpenCode 1.18.33's default primary agent, used
    // implicitly by every other scenario in this file).
    const agents = unwrap(await client.callTool('opencode-info', { section: 'agents' }));
    assert.equal(agents.section, 'agents');
    assert.ok(
      agents.agents.some((agent) => agent.name === 'build'),
      `expected a "build" agent, got ${JSON.stringify(agents.agents)}`,
    );

    // section "roots": lists the allowed root (this scenario's own temp repo dir).
    const roots = unwrap(await client.callTool('opencode-info', { section: 'roots' }));
    assert.equal(roots.section, 'roots');
    assert.ok(roots.roots.includes(repo.dir), `expected roots to include ${repo.dir}, got ${JSON.stringify(roots.roots)}`);

    // No apiKey/baseURL/secret-looking value leaks anywhere across any of these results.
    const haystack = JSON.stringify({ server, models, agents, roots, started });
    assert.ok(!haystack.includes(SENTINEL_API_KEY), 'the sentinel apiKey must never leak into any opencode-info (or turn) result');
    assert.doesNotMatch(haystack, /apiKey/i, 'no result may ever mention an apiKey field');
    assert.ok(!haystack.includes(fakeLlm.baseUrl), 'the fake LLM base URL must never leak into any result');
  },
);

// ---------------------------------------------------------------------------
// 8. batch status: opencode-status ids/wait-for observes several turns without owning them;
//    wait-for:"any" returns as soon as the first finishes, "all" waits for every item; an unknown
//    id yields a per-item error without failing the batch; cancelling the batch call itself only
//    detaches its observers — the turns it was watching keep running/completing untouched.
// ---------------------------------------------------------------------------

test(
  'batch status: opencode-status ids/wait-for observes turns without owning them; unknown ids never fail the batch; cancelling the batch call never aborts the underlying turns',
  { timeout: SCENARIO_TIMEOUT_MS },
  async (t) => {
    const ctx = await setupScenario('batch');
    t.after(ctx.teardown);
    const { client, fakeLlm } = ctx;

    async function waitForSlowRequestCount(minCount, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const count = (await fakeLlm.requests()).filter((r) => r.plan?.kind === 'slow').length;
        if (count >= minCount) return;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for >=${minCount} delegated SLOW_REPLY requests`);
        await sleep(200);
      }
    }

    const startA = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 3', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
    assert.equal(startA.status, 'running', `expected running immediately, got ${JSON.stringify(startA)}`);
    const idA = startA.sessionId;

    const startB = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 9', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
    assert.equal(startB.status, 'running', `expected running immediately, got ${JSON.stringify(startB)}`);
    const idB = startB.sessionId;

    // wait-for:"any" with a generous bound returns as soon as A (the shorter one) finishes, while
    // B is still running.
    const anyResult = unwrap(
      await client.callTool('opencode-status', { ids: [idA, idB], 'wait-for': 'any', 'wait-seconds': 30 }, { timeoutMs: 40_000 }),
    );
    assert.equal(anyResult.kind, 'batch');
    assert.equal(anyResult.status, 'ready', `expected ready, got ${JSON.stringify(anyResult)}`);
    assert.equal(anyResult.waitFor, 'any');
    assert.deepEqual(anyResult.readyIds, [idA], `expected only A ready, got ${JSON.stringify(anyResult.readyIds)}`);
    assert.deepEqual(anyResult.pendingIds, [idB], `expected B still pending, got ${JSON.stringify(anyResult.pendingIds)}`);
    assert.equal(anyResult.results.length, 2, 'expected exactly one result per input id, in input order');
    const itemA = anyResult.results.find((r) => r.sessionId === idA);
    assert.equal(itemA.status, 'completed', `expected A completed, got ${JSON.stringify(itemA)}`);
    assertWithinBudget(anyResult, 'opencode-status batch (wait-for:any)');

    // wait-for:"all" waits for B too.
    const allResult = unwrap(
      await client.callTool('opencode-status', { ids: [idA, idB], 'wait-for': 'all', 'wait-seconds': 30 }, { timeoutMs: 40_000 }),
    );
    assert.equal(allResult.status, 'ready', `expected ready, got ${JSON.stringify(allResult)}`);
    assert.deepEqual(allResult.readyIds, [idA, idB]);
    assert.equal(allResult.pendingIds.length, 0);
    const itemB = allResult.results.find((r) => r.sessionId === idB);
    assert.equal(itemB.status, 'completed', `expected B completed, got ${JSON.stringify(itemB)}`);

    // An unknown id yields a per-item error without failing the whole batch.
    const bogusId = 'not-a-real-session-id';
    const mixed = unwrap(await client.callTool('opencode-status', { ids: [idA, bogusId], 'wait-for': 'any' }));
    assert.equal(mixed.status, 'ready');
    const bogusItem = mixed.results.find((r) => r.sessionId === bogusId);
    assert.equal(bogusItem.status, 'error', `expected an error item, got ${JSON.stringify(bogusItem)}`);
    assert.equal(bogusItem.error?.name, 'SESSION_NOT_FOUND', `expected SESSION_NOT_FOUND, got ${JSON.stringify(bogusItem)}`);

    // Cancelling the batch call itself only detaches its observers (v0.3 §3: "zero upstream
    // aborts") — the turns it was watching must keep running to completion untouched.
    const beforeCD = (await fakeLlm.requests()).filter((r) => r.plan?.kind === 'slow').length;
    const startC = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 4', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
    const idC = startC.sessionId;
    const startD = unwrap(await client.callTool('opencode', { prompt: 'SLOW_REPLY 4', 'wait-seconds': 0 }, { timeoutMs: 20_000 }));
    const idD = startD.sessionId;

    let batchRequestId;
    const batchPromise = client.callTool(
      'opencode-status',
      { ids: [idC, idD], 'wait-for': 'all', 'wait-seconds': 30 },
      { onRequestId: (id) => { batchRequestId = id; }, timeoutMs: 40_000 },
    );
    batchPromise.catch(() => {}); // intentionally abandoned below; avoid an unhandled rejection warning

    await waitForSlowRequestCount(beforeCD + 2);
    assert.ok(batchRequestId !== undefined, 'expected to capture a request id before cancelling');
    client.cancel(batchRequestId, 'batch-cancel-test');

    const outcome = await Promise.race([
      batchPromise.then(() => 'responded'),
      sleep(6_000).then(() => 'no-response'),
    ]);
    assert.equal(outcome, 'no-response', 'a cancelled batch call must get no response (protocol-correct, like an owning-call cancel)');

    // Both turns must still complete naturally afterward, on their own — proof cancelling the
    // batch OBSERVER never aborted anything: a real abort would have stopped the fake LLM's stream
    // before it ever sent SLOW_DONE.
    const finalCheck = unwrap(
      await client.callTool('opencode-status', { ids: [idC, idD], 'wait-for': 'all', 'wait-seconds': 30 }, { timeoutMs: 40_000 }),
    );
    assert.equal(finalCheck.status, 'ready', `expected both C and D to complete naturally, got ${JSON.stringify(finalCheck)}`);
    for (const id of [idC, idD]) {
      const item = finalCheck.results.find((r) => r.sessionId === id);
      assert.equal(item.status, 'completed', `expected ${id} completed, got ${JSON.stringify(item)}`);
      assert.match(
        item.content ?? '',
        /SLOW_DONE/,
        `expected the stream to have completed naturally (SLOW_DONE), got ${JSON.stringify(item.content)}`,
      );
    }
  },
);
