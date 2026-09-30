# opencode-mcp e2e harness

Hermetic end-to-end tests: a real `opencode-ai@1.18.33` (`opencode serve`), a dependency-free fake
OpenAI-compatible LLM, and a dependency-free MCP stdio client drive a real built
`dist/opencode-mcp.mjs` inside a Docker container with `--network none`. This proves the whole
stack — server, engine, OpenCode adapter, and the real OpenCode binary — without any external
network access or a real model. See `docs/design.md` §9 for the scenario list this implements and
`docs/research/opencode-offline.md` for the offline-behaviour research it is based on.

Everything here runs in Docker on a remote host, never locally (no docker/npm/opencode on the
machine you're editing from). The default host is the maintainer's SSH alias `gram`; override
with `OCMCP_REMOTE_HOST`. `e2e/run-e2e.sh` does the rsync/ssh/docker plumbing for you.

## Running

```
e2e/run-e2e.sh                     # scenarios a-i (+ FAIL400/cancel-during-bash/timeout-during-bash/attach),
                                    # the F9 v0.3 feature scenarios (features.test.mjs), the overload
                                    # scenarios (overload.test.mjs), plus the node:20 bundle smoke (j)
                                    # and the npm packaging check
e2e/run-e2e.sh --only cancel       # only tests whose name contains "cancel"
e2e/run-e2e.sh --only pack         # only the npm packaging check
e2e/run-e2e.sh --only attach       # only the attach-mode scenario (handy for iterating on it alone)
e2e/run-e2e.sh --only diff         # only the per-turn-diff feature scenario
e2e/run-e2e.sh --only runaway      # only the response-loop-watchdog overload scenarios
e2e/run-e2e.sh --keep              # keep temp repos/dirs inside the container on failure
e2e/run-e2e.sh --with-claude       # also build claude-code into the image and run stretch (k)
```

Exit code is non-zero if any step failed. The script prints a compact pass/fail summary at the
end; scroll up in its output for the actual `node --test` failure detail of any failing scenario.
The summary is derived from each step's actual TAP `# pass`/`# skipped` counters, not just its
exit code, so a step that ran zero tests (a typo'd `--only`) or only skipped (e.g. `--with-claude`
with a broken `claude` binary) is reported FAIL, never PASS.

Runtime: the main suite (a-i, plus the unlettered FAIL400/cancel-during-bash/timeout-during-bash/
attach scenarios) takes roughly 3-4 minutes (dominated by the `SLOW_REPLY`-based scenarios
d/e/f/g/h, each bounded at 8-30s of scripted "thinking" time, plus the attach scenario spawning a
second, independent real `opencode serve`), plus the one-time `npm ci && build && bundle` and
`docker build` steps (a minute or two, mostly cached after the first run). The F9 feature
scenarios (`e2e/features.test.mjs`, its own step) add roughly another 30-60s, dominated by the
long-answer-paging scenario's dozens of `opencode-output` round trips. The overload scenarios
(`e2e/overload.test.mjs`, its own step) add roughly another 2-3 minutes, dominated by the
`529-always` scenario (OpenCode's own bounded provider-retry backoff, ~60-70s of real wall time)
and the `tool-steps` scenario (20 sequential real tool round trips). The node:20 bundle smoke
(j) and the npm packaging check are each a few seconds. The stretch scenario (k) adds another
20-60s and installs `@anthropic-ai/claude-code` into the image, so it is opt-in.

## What each scenario proves (docs/design.md §9)

| # | File | Proves |
|---|---|---|
| a | scenarios.test.mjs | The core lifecycle: `opencode` (write a file) -> result -> `opencode-reply` -> `opencode-status` (by id, then list) -> `opencode-end` -> a second `end` is `not_found` -> the session is forgotten by the MCP process (`SESSION_NOT_FOUND`) and the upstream `DELETE` was accepted. This is a *local* check (the registry lookup, not a live upstream query); the `attach` scenario below separately confirms `GET /session/{id}` is 404 on the real OpenCode server after `end`. |
| b | scenarios.test.mjs | `sandbox:"read-only"` actually stops file mutation: `write` (via a real `WRITE_FILE` prompt), `edit` (pre-seeded file + a matching `oldString`, so an unrestricted edit would succeed) and `bash` (its output must never reach the model-visible content) are each denied, not just incidentally unable to do anything. `apply_patch` is not exercised: real OpenCode 1.18.33's default `build` agent does not advertise that tool for our fake provider at all (`"Model tried to call unavailable tool 'apply_patch'"`), contradicting design.md F22's source-only claim — see the U14 unit report. |
| c | scenarios.test.mjs | `approval-policy:"on-request"` round-trips a real MCP `elicitation/create`: accept runs the (asked) command, decline blocks it and the rejection is visible; `approval-policy:"never"` never elicits at all and still blocks the ask. |
| d | scenarios.test.mjs | `wait-seconds:0` returns `running` immediately without blocking; a later `opencode-status` with `wait-seconds` blocks until the turn actually completes. |
| e | scenarios.test.mjs | `opencode-cancel` stops a running turn (status `cancelled`) without destroying the session — a subsequent `opencode-reply` still works. |
| f | scenarios.test.mjs | Cancelling the *owning* blocking call via `notifications/cancelled` gets no response at all (protocol-correct), and the session still shows up (cancelled) via `opencode-status`. Waits for the fake LLM to actually receive the request before cancelling, so it cannot pass by racing a pre-dispatch stop. |
| g | scenarios.test.mjs | `timeout-seconds` enforces a server-side deadline independent of the client: the turn ends with status `timeout`, and a follow-up `opencode-reply` still completes (the session is not left quarantined). |
| h | scenarios.test.mjs | `notifications/progress` is actually sent during a long turn, with a strictly increasing `progress` value tied to the request's `progressToken` — required so Claude Code's 30-minute stdio idle timer never fires. |
| FAIL400 | scenarios.test.mjs | A forced upstream 400 (the fake LLM's `FAIL400` directive) is classified `status:"failed"` with the real OpenCode error name (`APIError`), not the bridge's own `TURN_INCOMPLETE` fallback — and a follow-up reply still completes. |
| cancel-during-bash / timeout-during-bash | scenarios.test.mjs | `opencode-cancel` / `timeout-seconds` actually abort a turn while a **tool** (`bash sleep 60`) is running, not just a streamed text reply: waits for a real `"bash: running"` progress notification first, then asserts `executionState:"stopped"`, that the `sleep` subprocess is actually gone, and that a follow-up reply completes. |
| attach | scenarios.test.mjs | `OPENCODE_MCP_SERVER_URL` attach mode against a real, externally-spawned `opencode serve` (not opencode-mcp's own managed child): delegate -> reply -> end works, `GET /session/{id}` is 404 on that real server after `end`, and the server is still alive (not killed) after the MCP shuts down via stdin EOF. |
| i / i2 | scenarios.test.mjs | Shutdown (stdin EOF, and separately SIGINT) makes the server exit within ~20s with a clean exit code and no signal, **and** leaves no orphaned `opencode serve` process behind, even mid-turn. |
| j | bundle-smoke.mjs | The exact same `dist/opencode-mcp.mjs` bundle also starts and answers `tools/list` correctly under Node 20 (the stated minimum), not just Node 22. |
| npm packaging check | packaging-check.mjs | The package actually installed via `npm install -g` (the real npm `bin` symlink, not `node dist/index.js`) starts and answers an `initialize` + `tools/list` handshake with exactly the 5 expected tools — this is what previously caught an entry-point/symlink bug bundle-smoke.mjs cannot reproduce. Select it alone with `--only pack`. |
| k (stretch) | claude-stretch.test.mjs | A real, unmodified `@anthropic-ai/claude-code@2.1.284` binary (`claude -p`), talking to a fake Anthropic API, actually calls `mcp__opencode__opencode` then `mcp__opencode__opencode-end` and gets back a completed turn plus a written file — end-to-end proof against the real MCP client, not just our own harness client. |

### F9: v0.3 feature scenarios (`features.test.mjs`, own `run-e2e.sh` step)

Phase 1 (scenarios 1-5) — output paging, per-turn diff, bridge-side structured output. Phase 2
(scenarios 6-8) — request-id deduplication (F6), `opencode-info` discovery (F6), and batch status
via `opencode-status` `ids`/`wait-for` (F7).

| # | Proves |
|---|---|
| long-answer-paging | `detail:"compact"` + a small `max-output-chars` keep the immediate `opencode` result small (`output.state:"retained"`, full `answerChars` recorded); `opencode-output` section `"answer"` pages the full retained text back byte-for-byte at two different page sizes (256/4000), deliberately crossing a real UTF-16 surrogate-pair boundary on the first page of each; every page's `structuredContent` stays under the 45,000-char hard budget; the final page reports `nextOffset:null`; `offset===total` is an empty page, `offset>total` is `INVALID_ARGUMENT`. |
| structured-output | A `output-schema` turn whose final message contains one fenced ```json block extracts and validates it (`structuredOutputStatus:"valid"`, canonical value); two invalid variants (two blocks, malformed JSON) report `"invalid"` with `JSON_AMBIGUOUS`/`JSON_PARSE_ERROR` without ever failing the turn; the schema instruction is proven present in only that turn's own request to the LLM (never a later reply's, and OpenCode's own `format`-injected `StructuredOutput` tool never appears in any request — proof `format` is never sent, per `docs/research/opencode-features-probe.md`'s headline surprise #1). |
| per-turn diff | Turn 1 writes `A.txt` (a `write` tool call), turn 2 writes `B.txt` via `bash`; `opencode-output` section `"diff"` for each turn lists only that turn's own file (stat view, `source:"opencode-snapshot"`, `completeness:"not-guaranteed"`), patch view returns that file's patch text, and a snapshot-id that does not match the live snapshot is rejected as `SNAPSHOT_EXPIRED`. |
| structured-output regression | A follow-up `opencode-reply` after a structured-output turn completes normally and the original turn's retained answer stays readable — the regression guard for 1.18.33's `format`-breaks-`GET /session/{id}/message` bug (never triggered here, since the bridge never sends `format`). |
| end-then-output | `opencode-end` followed by `opencode-output` on the same (turn, session) → `SESSION_NOT_FOUND`. |
| request-id | Two concurrent identical `opencode` calls sharing one request-id join a single operation: one session, one delegated prompt to the fake LLM, both results sharing the same `sessionId`/`turn`, exactly one carrying `request.replayed:true`; the same id with a different prompt → `REQUEST_ID_CONFLICT` (never reaching OpenCode); after `opencode-end`, the same id/args → `REQUEST_ENDED`; a duplicate `opencode-reply` with a shared request-id likewise never sends a second prompt. |
| opencode-info | Section `"server"` (the first call a fresh process makes) reports `connectionState:"not_started"` and never actually starts a managed `opencode serve` process; section `"models"` lists the fake provider's `fake/fake-model` id, which then works as `model` in a following `opencode` call; section `"agents"` includes `"build"`; section `"roots"` lists the allowed root; a sentinel `apiKey` planted in the fake provider config, and the fake LLM's own base URL, never appear anywhere in any of these results. |
| batch status | `opencode-status` `ids`/`wait-for` observes two `wait-seconds:0` turns of different durations: `wait-for:"any"` returns as soon as the shorter one finishes (`readyIds` has exactly that one, the other still `pendingIds`); `wait-for:"all"` then waits for both; an unknown id in `ids` yields a `SESSION_NOT_FOUND` item error without failing the batch; cancelling the batch call itself (`notifications/cancelled`) gets no response and only detaches its observers — the two turns it was watching keep running and complete naturally (proven by each one's answer still containing `SLOW_DONE`, which a real abort would have prevented). |

### Overload scenarios (`overload.test.mjs`, own `run-e2e.sh` step)

Real OpenCode 1.18.33 has no backoff/cap of its own on several malformed-response shapes (see
`docs/research/probe-overload/summary.md`); these scenarios prove opencode-mcp's own watchdog and
classification instead. "Scenario LLM requests" below counts only chat-completions requests that
carry a non-empty `tools` array (OpenCode's own title/summary calls never do).

| # | Proves |
|---|---|
| runaway-empty / runaway-html / runaway-bad-tool | `OVERLOAD_EMPTY_DONE` / `OVERLOAD_HTML_BODY` / `OVERLOAD_BAD_TOOL_JSON` each make real OpenCode hot-loop the LLM with no backoff of its own (probe rows 3, 8, 9). The response-loop watchdog contract catches all three: `status:"failed"`, `error.name:"UPSTREAM_RESPONSE_LOOP"`, `error.retryable:false`, `responseLoop.pattern` `"empty"` (first two) or `"invalid_tool"` (bad-tool), `isError:true` — confirmed within 20s (target 10s) of the first scenario LLM request, at most 32 scenario LLM requests total, no further scenario request for 5s after the result, exactly one root user message upstream throughout (verified via OpenCode's own resent message history — see `overload.test.mjs`'s header comment), and a follow-up `opencode-reply` on the same session still completes normally. |
| recover-empty / recover-bad-tool | `OVERLOAD_EMPTY_THEN_OK 5` / `OVERLOAD_BADTOOL_THEN_OK 5` (below the default `responseLoopLimit` of 6) followed by a normal reply completes normally — the watchdog never trips on a short, recovered streak. |
| tool-steps | `TOOL_STEPS 20` (20 sequential real `bash` tool calls) completes normally with `toolCallCount>=20` and no `UPSTREAM_RESPONSE_LOOP` — real tool activity (even a long agentic turn) is a barrier the watchdog never mistakes for a loop. |
| empty-stop / whitespace | `OVERLOAD_EMPTY_STOP` / `OVERLOAD_WHITESPACE` -> `status:"failed"`, `error.name:"EMPTY_RESPONSE"`, `error.retryable:true`, `isError:true` (probe rows 4-5 previously reported these as clean `completed` success). |
| finish-length | `OVERLOAD_FINISH_LENGTH` -> `status:"completed"` with a `TRUNCATED` warning and `output.partial:true` (probe row 11 previously reported this as clean success with no warning at all). |
| malformed-sse | `OVERLOAD_MALFORMED_SSE` -> whatever the outcome (failed `UnknownError` with the sanitized generic message, or a recovered `completed`), the raw malformed SSE chunk text never appears anywhere in the result. |
| 429-once | `OVERLOAD_429_ONCE_<nonce>` recovers via OpenCode's own bounded provider retry (`session.status:"retry"`) within ~30s, with no prompt-level retry from opencode-mcp itself. |
| 529-always | `OVERLOAD_529_ALWAYS` (`wait-seconds:0`, then polling `opencode-status`) surfaces at least one running snapshot with `upstreamRetry.attempt>=1` while OpenCode's own bounded backoff (2/4/8/16/30s, ~60-70s wall time) runs its course, then a final `status:"failed"`, `error.statusCode:529`, `error.condition:"MODEL_OVERLOADED"`, `isError:true` — with at most 6 scenario LLM requests total (1 initial + OpenCode's own capped 5 retries), proving opencode-mcp never amplifies the load itself. |
| slow-first-token | `OVERLOAD_SLOW_FIRST_TOKEN 40` completes normally; 40s of silence before the first token is never mistaken for a loop (there is no sequence of *completed* unproductive attempts). |

## Files

- `Dockerfile` — `node@sha256:...` (22.23.3) + `ripgrep` + `git` + `opencode-ai@1.18.33`
  (optionally `@anthropic-ai/claude-code@2.1.284` via `--build-arg WITH_CLAUDE=1`), plus the
  pre-built `dist/` and `e2e/`. Built and run only on gram; runs fine with `--network none`.
- `fake-llm-server.mjs` — dependency-free OpenAI-compatible chat-completions server. Scripted
  from the request content: `WRITE_FILE`, `RUN_BASH`, `CALL_TOOL <name> <json>`,
  `SLOW_REPLY <seconds>` (streams one chunk/second, for cancel/timeout/wait-seconds/progress
  tests; stops cleanly if the caller aborts), `FAIL500`/`FAIL400` (forced upstream errors),
  `LONG_REPLY <chars>` (deterministic long multi-byte text, `lib/long-text.mjs`),
  `STRUCTURED_VALID <json>` / `STRUCTURED_AMBIGUOUS` / `STRUCTURED_BADJSON` (scripted
  ```json-fenced replies for the structured-output scenario). Every recorded request (`GET
  /__requests`) also carries a full role+text `messages` projection, not just roles, so tests can
  assert exactly where a given piece of text did or did not appear.
- `lib/long-text.mjs` — deterministic long-text generator shared between `fake-llm-server.mjs` and
  `features.test.mjs`'s long-answer-paging scenario, so both sides compute the same text without
  ever sending it over the wire for comparison.
- `lib/mcp-client.mjs` — dependency-free newline-delimited JSON-RPC stdio client implementing
  Claude Code's legacy handshake (`docs/research/mcp-client.md` §3): `initialize`
  (`protocolVersion:"2025-11-25"`, `capabilities:{elicitation:{form:{}},roots:{listChanged:true}}`),
  `notifications/initialized`, `callTool` (with progress/timeout/cancellation support),
  `cancel(requestId)`, a configurable `elicitation/create` handler, and process lifecycle
  (`close()`, `kill()`, `waitForExit()`, captured stderr).
- `lib/stub-server.mjs` — a tiny hand-rolled MCP-ish server (no deps) used only to validate
  `mcp-client.mjs` in isolation before/without a real opencode-mcp build.
- `lib/harness.mjs` — shared scenario setup: temp git repos under `/work`, a fake-LLM instance
  per scenario, the `OPENCODE_CONFIG_CONTENT` fake-provider config, the `OPENCODE_MCP_*` env
  assembly, `waitForFakeLlmRequest` (poll the fake LLM's request log instead of a fixed sleep),
  and `startExternalOpencodeServer`/`pickFreePort` (spawn a real `opencode serve` directly, for
  the `attach` scenario).
- `lib/fake-anthropic-oc.mjs` — fake Anthropic Messages API for the stretch scenario: scripts a
  fixed `opencode` -> `opencode-end` -> text flow instead of a single directive.
- `scenarios.test.mjs` — scenarios a-i plus FAIL400/cancel-during-bash/timeout-during-bash/attach
  (`node --test`, plain JS).
- `features.test.mjs` — the F9 v0.3 feature scenarios (see the table above); `node --test`, plain
  JS, its own `run-e2e.sh` step so it never re-runs (or is re-run by) `scenarios.test.mjs`.
  Deliberately does not import `scenarios.test.mjs` (that would re-run its top-level `test(...)`
  registrations); the handful of setup helpers it needs are duplicated in its own header, in the
  same small shape phase 2 will extend.
- `overload.test.mjs` — the overload-robustness scenarios (see the table above); `node --test`, plain JS, its own `run-e2e.sh` step so it
  never re-runs (or is re-run by) `scenarios.test.mjs`/`features.test.mjs`. Deliberately does not
  import either (same reason); its own tiny setup-helper copies live in its own header.
- `bundle-smoke.mjs` — scenario j (plain script, run directly under node:20).
- `packaging-check.mjs` — the npm packaging check (plain script, run after `npm install -g` in a
  clean container; see the table above).
- `claude-stretch.test.mjs` — scenario k (`node --test`, gated on `E2E_WITH_CLAUDE=1`; a missing/
  broken `claude` binary FAILS the test, not skips it, once `E2E_WITH_CLAUDE=1` was explicitly
  set).
- `run-e2e.sh` — the gram-only orchestrator described above.

## Validating the harness itself, independent of the full server

Before the MCP entry point / engine existed (or if you suspect a harness bug rather than a
product bug), you can validate `lib/mcp-client.mjs` on its own, locally, with no Docker/OpenCode:

```
node -e "
import('./e2e/lib/mcp-client.mjs').then(async ({McpClient}) => {
  const c = await McpClient.connect({ command: 'node', args: ['e2e/lib/stub-server.mjs'] });
  console.log(await c.listTools());
  await c.closeAndWait();
});
"
```

This exercises the handshake, `tools/call`, progress, cancellation (no response after
`notifications/cancelled`) and the `elicitation/create` round trip (accept/decline/error) against
`lib/stub-server.mjs`, independent of OpenCode or the real server.

## Notes / known limitations

- `ps -eo pid,cmd` (scenario i/i2's "no orphaned `opencode serve` process" check, and the
  cancel/timeout-during-bash "no leftover `sleep` process" check) assumes a Linux container. If
  `ps` itself is unavailable, that is always logged via `t.diagnostic()` (never silently), and
  additionally FAILS the scenario when running inside the e2e container (where `ps` is expected to
  always be available — its absence there signals a real problem); outside the container (e.g.
  local/manual iteration on a host without `ps`) it only skips that one assertion.
- The stretch scenario (k) needs `claude` on `PATH` (built via `--with-claude` /
  `--build-arg WITH_CLAUDE=1`); it self-skips with a clear reason only when `E2E_WITH_CLAUDE` was
  never set at all. Once `E2E_WITH_CLAUDE=1` explicitly requests it, a missing/broken `claude`
  binary FAILS the test instead — a skip still exits 0, and `run-e2e.sh` would otherwise report an
  explicitly requested stretch run as PASS when it never actually ran.
- All temp repos live under `/work` inside the container (falls back to the OS temp dir if `/work`
  doesn't exist, e.g. when running scenarios outside the Docker image) and are deleted after each
  scenario unless `--keep` / `E2E_KEEP_TMP=1` is set.
- The `attach` scenario spawns a second, independent real `opencode serve` directly (not through
  opencode-mcp's own managed-server path) to prove `OPENCODE_MCP_SERVER_URL` wiring against a real
  process the MCP does not own; it is killed in the test's own `t.after`, not by the MCP shutdown
  being tested.
