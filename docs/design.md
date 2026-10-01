# opencode-mcp — design (v0.4; release 0.4.0)

Status: reviewed · Date: 2026-09-29

## 0. 요약 (Korean summary)

(참고: 코드·테스트 주석과 일부 research/SDK 노트에는 개발 과정에서 쓰인 내부 리뷰·발견 항목 ID(예: U06, FY-2, P1-2, r1-…), 리뷰 라운드 표시(예: "review round 2"), 그리고 비공개 개발 노트의 절·문서 이름("v0.3 features contract §N", "overload design §A–§C", "response-loop watchdog contract", U-series unit report)이 인용되어 있습니다. 주석과 테스트 이름의 F#/R# 태그는 F4, F6, F7, F15, F16, F22처럼 본 문서 §2의 사실(F1–F22)이나 §10의 위험(R1–R6)을 가리키는 경우도 있지만, "v0.3 F2/F3", F5–F9 기능 단위, 리뷰 라운드의 F1·R1–R6처럼 별개의 채번인 경우도 있습니다. 해당 리뷰·설계 노트 자체는 공개되지 않으며, 공개 요약은 본 문서 §11/§12와 README를 기준으로 합니다.)

- 목적: 사내 엔터프라이즈 Claude Code가 사내 OpenCode에게 작업을 **위임 → 결과 수신 → 이어서 대화 → 세션 종료**할 수 있게 하는 stdio MCP 서버. OpenAI `codex mcp-server`(`codex`/`codex-reply`, 2026-09-09 제거됨)와 같은 사용 모델을 OpenCode로 제공한다.
- 기본 도구 5개: `opencode`(새 세션+첫 턴), `opencode-reply`(이어서), `opencode-status`(진행/결과 조회·대기, 목록), `opencode-cancel`(턴 중단, 세션 유지), `opencode-end`(세션 종료: 중단→보류 권한 거절→삭제/보관). v0.3은 여기에 `opencode-output`, `opencode-info`를 추가하고 status batch 관찰을 제공합니다.
- OpenCode 1.18.x의 v1 HTTP API(`opencode serve`)를 `prompt_async` + SSE(`/event`)로 구동. 기본은 MCP 프로세스가 전용 `opencode serve`를 127.0.0.1·임의 포트·임의 비밀번호로 띄우는 **managed** 모드, 사내 공용 서버에 붙는 **attach** 모드도 지원.
- 완료 판정은 "idle 이벤트"만 믿지 않고 **메시지 경계 이후의 실행 구간**(압축·페이지네이션 포함)을 읽어 판정한다. 세션마다 하나의 수명주기 게이트로 제출·취소·종료를 직렬화한다.
- v0.1 제한: OpenCode 내부 서브에이전트(`task`) 비활성, 외부 세션 채택 없음, 대화형 승인은 legacy MCP 프로토콜(Claude Code stdio 기본값)에서만.
- 폐쇄망: 런타임 의존성 3개(`@modelcontextprotocol/server`/`core`, `zod`), esbuild 단일 파일 번들, OpenCode 자동 다운로드 억제 플래그 기본 적용.

## 1. Goals / non-goals

Goals
1. Codex-MCP parity of the *usage model*: a blocking tool that starts an agent session and returns the final answer plus a session id; a reply tool that continues it. Argument names follow Codex (`prompt`, `cwd`, `model`, `sandbox`, `approval-policy`, `base-instructions`, `developer-instructions`) where OpenCode can honour them.
2. Explicit session end (`opencode-end`) — the user's primary flow is delegate → result → end.
3. Robust long runs under Claude Code: no 30-min idle abort, no 5-min fetch header timeout, cancellation honoured, never a wrong/stale answer, no orphaned turns or processes.
4. Enterprise / air-gapped deployment: tiny dependency set, internal npm proxy, single-file bundle, no outbound traffic from opencode-mcp itself, OpenCode automatic-fetch switches.
5. Fix the verified Codex MCP defects rather than copying them (docs/research/codex-mcp.md §10–11).

Non-goals (v0.1) — recorded tradeoffs
- MCP Tasks (Claude Code 2.1.284 does not declare the extension).
- OpenCode v2 `/api/*` routes (not ready in 1.18.33; ignores provider config → egress risk).
- Per-call OpenCode config overrides (Codex `config`, `compact-prompt`): `PATCH /config` is global and disposes all instances (G22).
- An OS sandbox. OpenCode has none (G14); `sandbox` maps to permission rules only (§6).
- **OpenCode-internal subagents** (`task` tool): denied in every profile. `task_id` can select an existing session without re-applying parent permissions and background tasks can restart the parent after idle. Delegation Claude Code → OpenCode is unaffected.
- **Adopting sessions not created by this MCP process**: unknown ids → `SESSION_NOT_FOUND`; `opencode-end` → `not_found` without upstream mutation. Cross-restart recovery would need persisted ownership + policy.
- **Interactive approvals on the 2026-07-28 (modern, MRTR) MCP era**: v0.1 uses legacy push elicitation (Claude Code's stdio default). Modern-era calls treat elicitation as unavailable → safe reject.

## 2. Verified facts this design depends on

All from docs/research/*.md (OpenCode 1.18.33 source+runs, Claude Code 2.1.284, MCP SDK v2.2.0), plus source citations (`OC:` = `packages/opencode/src/` at v1.18.33):

| # | Fact | Consequence |
|---|---|---|
| F1 | Blocking `POST /session/{id}/message` sends headers only at turn end; Node fetch aborts at 300 s; disconnect does not stop the turn | Use `prompt_async` (204) + SSE `/event` |
| F2 | `/event`, `/permission*`, `/question*`, `/session/status` are per-directory instance routes; must pass the **session's** directory; `/session/{id}/*` ignore directory | Every instance call carries `session.directory` |
| F3 | One `session.idle` covers all queued prompts; concurrent prompts from 2 processes → runaway loop | Serialize turns per session; one owning server per session |
| F4 | `tools` in prompt body *replaces* the session permission ruleset persistently | Never send `tools` |
| F5 | Subagents inherit only parent `deny` + `external_directory`; `task_id` can reuse an existing session without re-applying rules (`OC:tool/task.ts:136–172`); background tasks re-prompt the parent (`:227–253`) | Deny `task` in every profile (v0.1) |
| F6 | `always` approves the pattern for every session of the directory until restart | Never send `always` |
| F7 | `reject` rejects all other pending requests of the same session | Idempotent handling; skip already-replied |
| F8 | Permission/question waits have no timeout; abort leaves stale requests | MCP enforces deadlines; reject leftovers before next admission and at end |
| F9 | Rule evaluation is last-match-wins over `[agent, config, session]`, then the directory-wide approved list (`OC:permission/index.ts:72–80`) | Session `deny` beats config `allow`; we never send `allow`; previous `always` approvals by other clients can still relax asks (§6.3) |
| F10 | SSE: no `id:`/resume; heartbeat every 10 s; stream ends on `server.instance.disposed` | Watchdog + reconnect + reconcile |
| F11 | Claude Code aborts a stdio call after 30 min with "no response or progress notification" (documented); `notifications/progress` resets it (observed, per request); no other notification is relied on; idle abort sends **no** cancel; hard timeout (~27.8 h) does | Heartbeat every attached request; server-side max turn time |
| F12 | Claude Code shows the model only `JSON.stringify(structuredContent)`; >50,000 chars get persisted to a file | Answer lives inside structuredContent; budget < 45,000 chars |
| F13 | Claude Code always sends `progressToken`; interactive calls auto-background after 120 s; interactive elicitation dialogs; `-p` answers elicitation with `cancel`; modern era forbids push `elicitInput` | Blocking tools OK; elicitation optional with safe fallback |
| F14 | Claude Code sends SIGINT to stdio servers on exit | Trap SIGINT/SIGTERM/SIGHUP/stdin EOF |
| F15 | `opencode serve --port 0` tries 4096 first; readiness = stdout `opencode server listening on http://…`; early requests can hang; `server.mdns` config changes default host | Own free port; explicit `--hostname 127.0.0.1`; mdns off; wait for the line; timeouts everywhere |
| F16 | `OPENCODE_SERVER_PASSWORD` → Basic auth on every route (user `OPENCODE_SERVER_USERNAME`, default `opencode`) | Managed mode generates a random password |
| F17 | Delete while busy races the runner; safe order is abort → idle → reject leftovers → delete | `end` follows that order and only deletes after confirmed stop |
| F18 | Prompt `system` is appended; only the latest user message's `system` counts; compaction continuations may omit it | Re-send instructions every turn; they are guidance, not policy |
| F19 | Title given at create avoids an extra LLM title call | Always send a title |
| F20 | `prompt_async` returns 204 after forking; the user message is created later (`OC:session/prompt.ts:1055–1070`); abort with no runner emits idle (`OC:session/run-state.ts:77–85`); invalid agent fails before any user message (`:635–643`) | idle ≠ completion; completion needs terminal assistant evidence in the execution interval |
| F21 | Auto-compaction creates replay/synthetic continuation user messages; compaction assistants have `summary:true` (`OC:session/compaction.ts:393–547`); message list is paginated with `X-Next-Cursor` | Interval = everything after the pre-submission boundary; page backwards; skip summaries for the answer |
| F22 | `write`, `edit`, `apply_patch` all ask the `edit` permission (`OC:tool/write.ts:54`, `edit.ts:102`, `apply_patch.ts:206`; hiding map `OC:permission/index.ts:204–211`) | `edit:*:deny` covers stock file mutation tools (not custom/MCP tools) |

F22 is a source-code mapping, not a promise that every model gets all three tools: real OpenCode 1.18.33's default `build` agent does not advertise `apply_patch` to every provider/model — against the e2e fake provider's model it offers only `write`/`edit` (`"Model tried to call unavailable tool 'apply_patch'"`). §9's e2e coverage and `edit:*:deny` therefore only exercise `write`/`edit` end-to-end; `apply_patch` denial is verified by source mapping only (`e2e/README.md` scenario b).

## 3. Architecture

```
Claude Code ──stdio JSON-RPC──▶ opencode-mcp (Node ≥20)
                                 ├─ mcp/        tool schemas, per-request progress, legacy elicitation, result formatting
                                 ├─ core/       Engine: registry+lifecycle gate, turn runner, event hub, result builder, policy, paths
                                 └─ opencode/   HTTP client (fetch), SSE parser, managed `opencode serve`, connection leases
                                        │ HTTP Basic, 127.0.0.1 (managed) or internal URL (attach)
                                        ▼
                                 opencode serve (1.18.x) ──▶ internal LLM gateway
```

Module layout and exported signatures (contract — treat as a stable interface):

```
src/
  types.ts                   # shared contracts
  index.ts                   # entry: config → clock → connection → engine → serveStdio → signals
  config.ts                  # loadConfig(env: NodeJS.ProcessEnv, cwd: string): Config
  log.ts                     # createLogger(level: LogLevel, sink?: (line: string) => void): Logger
  mcp/server.ts              # createMcpServerFactory(engine: Engine, config: Config, logger: Logger): () => McpServer
  mcp/tools.ts               # zod schemas + handlers
  mcp/format.ts              # formatResult(result, maxChars): {structuredContent, text} (size budget)
  opencode/http.ts           # createOpencodeApi(opts: {baseUrl, username, password?, requestTimeoutMs, logger}): OpencodeApi
  opencode/sse.ts            # parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<OcEvent>
  opencode/managed-server.ts # startManagedServer(opts): Promise<ManagedServer>; buildServeEnv(base, cfg, password): Record<string,string>
  opencode/connection.ts     # createConnection(config: Config, logger: Logger, clock: Clock): Connection
  core/clock.ts              # realClock: Clock
  core/paths.ts              # resolveWorkingDirectory(cwd: string | undefined, config: Config): Promise<string>
  core/policy.ts             # sessionRulesFor(sandbox: Sandbox): Array<PermissionRule & {action:'deny'}>
  core/hub.ts                # EventHub: per-directory shared SSE with reconnect/watchdog
  core/turn.ts               # Turn: one submission → terminal state (phases)
  core/registry.ts           # tracked sessions + per-session lifecycle gate
  core/result.ts             # execution interval → TurnResult fields
  core/engine.ts             # createEngine(deps: EngineDeps): Engine
test/                        # node:test, package.json's test/**/*.test.ts glob; *.smoke.mjs is intentionally excluded
e2e/                         # docker (gram) harness: real opencode + fake LLM, --network none
```

Language/tooling rules (all modules):
- TypeScript, **erasable syntax only** (no `enum`, `namespace`, parameter properties, decorators); `import type` for type-only imports. Tests run with Node 22 type stripping (`node --test` on `.ts`). Type stripping is not type checking: `npm run typecheck` covers src, tests and fakes.
- Relative imports use explicit `.ts` extensions; `tsc` builds with `rewriteRelativeImportExtensions` to `dist/*.js` for the Node ≥20 runtime. Exact TypeScript version pinned.
- ESM. No runtime deps outside `src/mcp/**`, `src/index.ts`, `src/config.ts`, `src/log.ts`. `core/` and `opencode/` use Node built-ins only.
- Never write to stdout except MCP frames. Logs → stderr. Never log credentials, Authorization headers, full env objects, or credential-bearing URLs.
- All time-dependent code takes the injected `Clock` so tests run in milliseconds.

## 4. Tool surface (MCP)

Names use Codex's kebab style: `opencode`, `opencode-reply`, `opencode-status`, `opencode-cancel`, `opencode-end` (Claude Code: `mcp__opencode__opencode-reply`, …). Unknown input properties are rejected (Codex parity). Ids: `sessionId` preferred; `threadId` (Codex) and `conversationId` (deprecated) are aliases — **exactly one** id property must be present (even identical duplicates are rejected).

### 4.1 `opencode` — start a session and run the first turn
| Property | Type | Notes |
|---|---|---|
| `prompt` | string, required, non-empty | task for OpenCode |
| `cwd` | string | workspace; relative → resolved against default cwd; must be inside allowed roots (§5.8) |
| `model` | string `provider/model` | default `OPENCODE_MCP_DEFAULT_MODEL`, else OpenCode's resolution |
| `agent` | string | OpenCode primary agent (`build`, `plan`, custom); default `OPENCODE_MCP_DEFAULT_AGENT`, else OpenCode default |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | default `workspace-write`; permission-rule profile, **not OS isolation** (§6) |
| `approval-policy` | `never` \| `on-request` | default `never` (§6.2) |
| `base-instructions` | string | OpenCode cannot replace its base prompt per request: sent as extra system text before developer-instructions (documented) |
| `developer-instructions` | string | → prompt `system`; stored and re-sent on every turn |
| `title` | string | session title; default: first line of prompt, ≤ 80 chars |
| `timeout-seconds` | int ≥ 1 | max run time of this turn; default 3600, capped by `OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS` (21600) |
| `wait-seconds` | int ≥ 0 | observation bound after admission; omitted = until terminal (Codex behaviour); `0` = return right after admission (`running`). Connection/admission have their own bounded deadlines, so `0` is not zero latency |

### 4.2 `opencode-reply`
`prompt` (required) + exactly one id; optional `model`, `agent`, `developer-instructions` (each replaces the stored value for this and later turns; omitted → stored values re-sent), `timeout-seconds`, `wait-seconds`. `sandbox`/`approval-policy` are fixed per session. A reply while the session is not idle-and-clean → `SESSION_BUSY` (never "steer"; F3). A reply when `executionState` of the last turn is `unknown` → `SESSION_BUSY` with explanation.

### 4.3 `opencode-status` — observe / wait / list
Optional id, `wait-seconds` (default 0, max 600). With id: current or last `TurnResult` of a session tracked by this process; while running it blocks up to `wait-seconds` with heartbeats **and bridges approvals** (not read-only: `readOnlyHint:false`). Without id: `ListResult` of tracked sessions (bounded, `truncated` flag) and the OpenCode version. A tracked session with no finished turn yet returns its running snapshot. `wait-seconds` also bounds **admission** for this observer call (SSE connect, leftover rejection, warm-up, quarantine-recovery wait, the `prompt_async` POST), not only the running phase: a wait/detach that fires during admission returns the in-progress snapshot instead of blocking until the turn actually starts running (§5.4).

### 4.4 `opencode-cancel`
Exactly one id. Aborts the running turn through the lifecycle gate (§5.3), waits for confirmed stop (≤ cleanupTimeout), returns `TurnResult` (`cancelled`, or the existing terminal result if the turn had already committed). Idempotent when idle.

### 4.5 `opencode-end`
Exactly one id; `action` `delete` \| `archive` (default `OPENCODE_MCP_END_ACTION`, `delete`). Marks the session `ending` (no new admissions), stops the running turn, verifies quiescence, rejects leftover permissions/questions, then deletes/archives and forgets. If stop or cleanup cannot be confirmed within `cleanupTimeout`, the registry entry is **kept**, nothing is deleted, and the call returns `isError` `CLEANUP_UNCONFIRMED` (retry later). Unknown id → `EndResult{status:"not_found"}` without upstream mutation.

A failed end (the delete/archive request itself fails, or an earlier precondition above cannot be confirmed) marks the entry `quarantined` and records an `endFailure` reason; `opencode-status` and the session list surface it (`status:"quarantined"`), and the turn's `hint` says to retry `opencode-end` — a retry with a *different* `action` is rejected until the original action succeeds, since a stray mutation of the other kind may still be in flight. `OPENCODE_MCP_ON_EXIT=end` retries such sessions at shutdown once nothing else about them is ambiguous (§5.7).

### 4.6 Result contract
Every tool declares one root `type:"object"` `outputSchema` with a `kind` discriminant (`turn` | `sessions` | `end` | `error` | `output` | `info` | `batch`), required `["kind","status","content"]`, all other properties optional (legacy-era clients require an object root). Every result — success or `isError` — carries one object `structuredContent` (see `src/types.ts`), mirrored as one human-readable text block. Errors never fabricate ids. Input-schema violations rejected by the SDK before the handler runs are protocol/tool errors whose exact shape is documented in docs/sdk-notes.md.

Size budget (`mcp/format.ts`): after formatting, measure `JSON.stringify(structuredContent).length`; bound every variable-length field (content head+tail with marker at `maxOutputChars` 20,000; error message 2,000; each path/title/pattern 300; filesChanged 200 items; toolCalls last 20; pendingApprovals 10; sessions 100) and apply deterministic reductions (drop toolCalls → filesChanged tail → shrink content) until < 45,000 chars; always keep ids, status, error code and `truncated`. Never slice serialized JSON. Upstream error bodies/headers (`APIError.data.responseBody/responseHeaders`) are never copied — only `error.name` and `data.message`.

Server `instructions` (≤ 2,048 chars): delegate with `opencode`, read `structuredContent.content`, continue with `opencode-reply`, poll with `opencode-status` when `running`, finish with `opencode-end`; `sandbox` is a permission profile, not OS isolation.

## 5. Engine behaviour

### 5.1 Connection (`opencode/connection.ts`)
- **managed** (default): on first `acquire`, spawn `opencode serve --hostname 127.0.0.1 --port <free port> --mdns=false [serveArgs]` in `defaultCwd`, under a tiny, constant POSIX `/bin/sh` watchdog — the ONLY shell this module ever spawns: its script body is a fixed constant, never built from the binary path or args (those flow in only as inert `"$@"` positional parameters, never interpolated into the script text), so this remains effectively "no shell" from an injection standpoint. The watchdog stays the process-group leader (still `detached: true`), forwards TERM/INT/HUP to the real child, and — the reason it exists — polls whether opencode-mcp itself (`OPENCODE_MCP_WATCHDOG_PPID`) is still alive every 5s and terminates the child itself once the parent is gone, so a hard-killed/crashed/OOM-killed opencode-mcp no longer orphans the managed process (the exact mdns-off flag spelling was verified against 1.18.33 help; if `--mdns=false` is not accepted, omit it — hostname is explicit). `serveArgs` containing `--hostname`, `--port`, `--mdns*`, `--cors` are rejected by config. Child env = `buildServeEnv`: inherit (or `childEnvAllowlist` + essentials `PATH HOME USER LOGNAME LANG LC_ALL TMPDIR SHELL TERM`), **scrub** `ANTHROPIC_*`, `CLAUDE_*`, `CLAUDECODE`, `AI_AGENT`, `OPENCODE_MCP_*`, `OPENCODE_SERVER_*`; set `OPENCODE_SERVER_USERNAME` and a random 32-byte base64url `OPENCODE_SERVER_PASSWORD`; air-gap defaults (§7) only where unset. Ready when stdout prints `opencode server listening on http://127.0.0.1:<port>` matching the expected endpoint (else fail) and `/global/health` is healthy, within `startupTimeoutMs`: the health request's own timeout is capped to whatever remains of `startupTimeoutMs` (never more than `requestTimeoutMs`), so one `acquire()` stays within `startupTimeoutMs` end-to-end instead of the health check separately running out its own larger `requestTimeoutMs` on top. Startup failure kills the child in `finally`. Unexpected exit → `onUnavailable(generation, err, 'exited')`; next `acquire` starts a new generation. `close()`: SIGTERM process group → 5 s → SIGKILL. Managed mode's default `onExit=abort` starts this group kill in parallel with `engine.shutdown()`, not only after it: process exit is itself a stronger, faster execution fence than the per-turn HTTP abort/poll loop.
- **attach**: `OPENCODE_MCP_SERVER_URL` (+ `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`). URL must not contain userinfo; must be `https:` unless the host is loopback or `OPENCODE_MCP_ALLOW_INSECURE_HTTP=1`. Redirects are errors. Only one MCP process should drive a given session (F3) — documented; attach-mode cancellation/cleanup may be `unconfirmed`.
- **Lease invalidation**: a running turn that sees sustained upstream failures (repeated network/5xx/timeout errors for longer than `max(2× statusPollMs, requestTimeoutMs)`) re-probes `/global/health`; if that probe also fails, the connection is invalidated instead of heartbeating `running` indefinitely. In **attach** mode the lease is dropped immediately and `onUnavailable(generation, err, 'unreachable')` fires without waiting for the managed-only exit path — the affected turn ends `failed`/`OPENCODE_UNAVAILABLE` with `executionState:"unknown"`, and the *next* `acquire` reconnects under a newly incremented generation. In **managed** mode the child is stopped and its process group swept; only once the group is confirmed gone does `onUnavailable(generation, err, 'exited')` fire — `'exited'` remains the only signal that lets in-flight mutation markers clear (§5.2), so a still-alive-but-unresponsive managed child never falsely clears one.
- Every non-SSE request has a timeout (`requestTimeoutMs`, 30 s) and honours `RequestOptions.signal`. Cleanup requests use their own signal, never an already-aborted caller signal. Generation change invalidates old leases: the hub drops subscriptions of dead generations.

### 5.2 Registry and lifecycle gate (`core/registry.ts`)
- `TrackedSession {id, directory, title, sandbox, approvalPolicy, baseInstructions?, developerInstructions?, agent?, model?, turns, phase, current?: Turn, last?: TurnResult, generation}` — only sessions created by this process.
- A per-session **gate** (async mutex + state) serializes admission, cancellation, result construction and end. The reservation is taken synchronously before any await and held through cleanup and result construction. Session phases: `idle` → `admitting` → `running` → `stopping` → `idle`; plus `ending` → removed, and `quarantined`. There is no distinct post-`stopping` gate phase for result construction (`SessionPhase` in `registry.ts` has no such member): `Turn.finish()` builds the `TurnResult` synchronously before committing (§5.3.6), so it is never an externally observable gap. `quarantined` covers two cases: an unresolved execution outcome (`last.executionState:"unknown"`, re-verified by the next `status`/`cancel`/`end` call, §5.3.2) and a session whose `opencode-end` itself failed to confirm cleanup (`endFailure` set; §4.5) — both are surfaced to `opencode-status`/list as `status:"quarantined"`.
- `reply`/`end` racing: whoever enters the gate first wins; the other sees `SESSION_BUSY` (reply during end/turn) or waits for the gate (end during reply → end aborts the admitted turn). `ending` is marked before any upstream await.
- Terminal precedence: a cancellation accepted before terminal commitment wins; after commitment, cancel returns the committed result.

### 5.3 Turn phases (`core/turn.ts`)
1. **admitting**: acquire lease → ensure hub(D) connected (`server.connected` seen) → reconcile stale permissions/questions of this session (reject all; F8) → check `/session/status?directory=D` does not list the session → record the **history boundary** = id of the newest message (`messages({limit:1})`, may be none).
2. **submitting**: arm event capture, then `promptAsync({parts, model?, agent?, system?})` — never `tools`, never `messageID`. 204 → `running`. Ambiguous failure (timeout/network/5xx after send) → **never retry**; reconcile: page messages after the boundary; if a new root user message exists → treat as submitted (`running`); if not and status is idle after a grace period → `failed` `SUBMISSION_UNCONFIRMED` with `executionState:"unknown"` → session `quarantined` (no new admission, no delete) until a later status/cancel observes quiescence. A 4xx rejection → `failed` `UPSTREAM_ERROR`, `executionState:"stopped"`. The quarantine is **re-verified, not merely cleared**, by the next `opencode-status`, `opencode-cancel` or `opencode-end` call (`confirmQuiescence`/`inspectQuiescence`): if the interval later shows terminal evidence, the session is released with the *real* turn outcome and, when a user message did submit, a hint not to resend the prompt (`"The prompt did run; do not resend it. Use opencode-reply to continue."`); only a generation change (dead server/lease invalidation, §5.1) clears the marker without that re-verification.
3. **running**: identify the submitted user message = first root user message newer than the boundary (from `message.updated` events or paged history; never "the latest historical user message"). Handle `permission.asked` / `question.asked` for the root session (§6.2). Progress from events (tool running/completed + title, retry status, waiting for approval) and heartbeats.
4. **completion evidence**: `session.idle`, `session.status{idle}`, `session.error`, stall/reconnect, and the `statusPollMs` poll only **trigger reconciliation**. Reconciliation reads the execution interval (§5.5). The turn is terminal when the root is idle (absent from `/session/status`) **and** the interval contains terminal evidence: (a) a non-summary assistant with `time.completed` and `finish ∉ {tool-calls, unknown, undefined}` and no pending/running tool parts → `completed`; (b) an assistant `error` → `failed` (`MessageAbortedError` → `cancelled`/`timeout` per our abort reason); (c) root `session.error` with no submitted user message (e.g. invalid agent, no provider) → `failed` immediately without waiting for idle; (d) idle root without (a)/(b) → `failed` `TURN_INCOMPLETE` (e.g. permission rejected ended the loop with `finish:"tool-calls"`), partial text preserved. Busy need not have been observed.
5. **stopping** (cancel, timeout, end, shutdown, owning-call abort): mark stop reason first; if still `submitting`, wait for submission to resolve before aborting; `abort` → wait for idle + interval reconciliation (≤ cleanupTimeout) → reject leftover permissions/questions. Unconfirmed → `executionState:"unknown"`, `cleanup:"unconfirmed"`, session `quarantined`.
   - **Accepted trade-off, narrowed**: a timed-out `abort` request (this call's own deadline expired while the HTTP round trip was still in flight) may still land upstream later, after this process has moved on. OpenCode stops whatever is currently running for that session, so the abort can land on a **later** turn than the one it was issued for (e.g. after quarantine recovery admits a fresh reply) — that later turn then ends `cancelled`/`TURN_INCOMPLETE` even though this process never requested a stop *for it*. Tool effects executed before that abort are never undone. Turn.finish() detects this case (no `stopReason` recorded for that turn) and sets a dedicated hint instead of the ordinary continue-or-end hint; the turn is never reported `completed`.
6. **terminal**: `finish()` builds the `TurnResult` (§5.5) synchronously — no distinct gate phase for this step (§5.2) — then commits and releases the gate.

### 5.4 Calls, progress and approvals
- A Turn runs independently of MCP calls; calls attach: the owning call (`opencode`/`opencode-reply`) and observers (`opencode-status`). `wait-seconds` bounds observation; on expiry the call returns a snapshot (`running`/`waiting_for_approval`) and detaches; after returning, the MCP layer removes that request's abort listener so a later cancellation cannot touch the detached turn. For an **observer**, `wait-seconds` also bounds the turn's **admission** (SSE connect, leftover rejection, warm-up, quarantine-recovery wait, the `prompt_async` POST) — not only its running phase — so `opencode-status {wait-seconds:0}` returns promptly even while a parallel `opencode`/`opencode-reply` call on the same session is still being admitted; the **owning** call always waits out its own admission.
- If the **owning** call is still attached and its signal fires (MCP `notifications/cancelled`: Esc/TaskStop/hard timeout) → stop with reason `cancelled` (Codex parity). Observer cancellation only detaches.
- **Every** attached call gets its own heartbeat (`heartbeatMs`, 15 s) and activity messages; a failing sink is detached without affecting the turn.
- Approvals (`on-request`): asks are queued per turn and processed one at a time without blocking event handling. Each elicitation is bound to `(turnId, permissionId)` and an absolute deadline (`approvalTimeoutMs` from the ask); it goes to one attached call that has `elicit`; if none is attached the ask waits (status `waiting_for_approval`, `pendingApprovals`) until a call attaches or the deadline → `reject`. A connection whose declared capabilities omit `elicitation` entirely can never answer any ask (capabilities are fixed per connection, so a later attach on the same connection cannot help either); such an ask is rejected immediately instead of waiting out `approvalTimeoutMs` — the wait-for-a-capable-call behaviour above only applies while at least one attached call could still elicit, or none is attached yet. When an elicitation-capable call *is* attached, its `elicit()` is called with `timeoutMs` set to the remaining time to the ask's own `approvalTimeoutMs` deadline, so the MCP SDK's own default (60 s) never cuts the wait short. Before replying `once`, re-verify the request is still pending (`GET /permission?directory=D`) and the turn is still `running`; late decisions after stop/finalize are dropped (the stop path rejects leftovers). 404 on reply = already resolved (idempotent).

### 5.5 Execution interval and result (`core/result.ts`)
- Interval = all root-session messages newer than the history boundary (page backwards with `before` cursors, `limit` 100, until the boundary id is reached or pages end), deduplicated by message id and part id. Under exclusive ownership this includes OpenCode-generated compaction/continuation messages (F21).
- Final answer = text parts (not `synthetic`, not `ignored`) of the last **non-summary** assistant message that has text. If none → a short synthesized line (e.g. "OpenCode finished without a text answer; see toolCalls/filesChanged").
- Outcome per §5.3.4. Partial text is preserved on failure.
- `filesChanged` = union of `patch` part files in the interval, made relative when inside `directory` (best-effort). `toolCalls` = tool parts `{tool, status, title}` (last 20) + `toolCallCount`. Tokens/cost = sum over assistant `info.tokens/cost` once (not step parts).
- `hint` guides the next call: `opencode-reply`/`opencode-end` on a clean terminal result, `opencode-status` while running, `opencode-cancel` to confirm stop when `executionState` is `unknown`, and — after a failed `opencode-end` — a retry of `opencode-end` (the entry stays `quarantined` with an `endFailure` reason until that retry succeeds, §4.5).

### 5.6 EventHub (`core/hub.ts`)
- One SSE subscription per (directory, generation) while ≥1 listener; ref-counted.
- `connected()` resolves after `server.connected`. Watchdog: no event for `sseStallMs` (35 s; OpenCode heartbeats every 10 s), stream end/error, or `server.instance.disposed` → reconnect with an exponentially growing jittered backoff (starts at 0.5 s, doubles on each failed attempt, capped at 5 s; resets to 0.5 s once a reconnect stays live long enough) and emit a synthetic `hub.reconnected` so turns reconcile (status, permissions, interval). Unknown event types are passed through and ignored by consumers.

### 5.7 Shutdown
On SIGINT/SIGTERM/SIGHUP or stdin EOF (once): stop admission (`SHUTTING_DOWN` for new calls) → stop all running turns (parallel, bounded) → reject leftover permissions/questions → if `onExit=end`, end sessions created by this process → `connection.close()` in `finally` (also after failed startup) → exit. Cleanup failures are logged (stderr) and attach-mode leftovers reported. The whole sequence is bounded by `cleanupTimeoutMs`; `index.ts` derives its own outer bound for `engine.shutdown()` as `cleanupTimeoutMs` + a fixed 5 s (the managed SIGTERM→SIGKILL grace) + a fixed 5 s margin, and separately bounds the always-run `connection.close()` by `cleanupTimeoutMs`. The process exits `0` only if both `engine.shutdown()` and `connection.close()` complete within their bounds; a timeout or a thrown error in either — or an `uncaughtException`/`unhandledRejection` reaching the process during or before shutdown — forces exit code `1`.

### 5.8 Working directory
- Local mode: resolve `cwd` against `defaultCwd`, `realpath` it (must exist and be a directory), and check **component-aware** containment in realpath-canonicalized `allowedRoots` (not string prefix). Remote mode (`remotePaths`): POSIX lexical normalization + component containment only (documented: cannot detect remote symlink escapes).
- A `cwd` containing a literal `%` — in the raw input, the lexically resolved path, or (local mode) the `realpath`-resolved path — is rejected with `INVALID_ARGUMENT` before the allowed-roots check runs, closing a percent-escape (e.g. `%2E%2E`) bypass of the roots check that a double-`decodeURIComponent` on OpenCode's side could otherwise exploit.
- Allowed roots restrict selection of the working directory; they do not constrain all file access by OpenCode (its project boundary is the Git worktree, which can be broader than `cwd`; shell/plugins/MCP need separate controls) — documented.

## 6. Policy mapping

### 6.1 `sandbox` → session permission profile (only ever `deny`; F5, F9, F22)
Every profile: `task:*:deny`, `question:*:deny`, `plan_enter:*:deny`, `plan_exit:*:deny`.
- `read-only`: + `edit:*:deny` (covers stock `write`, `edit`, `apply_patch`), `bash:*:deny`, `external_directory:*:deny`, `webfetch:*:deny`, `websearch:*:deny` (OpenCode's own network tools are otherwise default-allow and would let a read-only session exfiltrate file contents it can still `read`).
- `workspace-write`: + `external_directory:*:deny`.
- `danger-full-access`: nothing extra (inherits OpenCode agent/config behaviour, still no subagents).

### 6.2 `approval-policy` → `permission.asked` handling (rules that are `ask` in OpenCode config/agent defaults, e.g. `doom_loop`, `.env` reads, admin `bash: ask`)
- `never`: reply `reject` with message `"Denied by opencode-mcp: approval-policy=never (no interactive approval available)"`.
- `on-request`: legacy elicitation, message `OpenCode wants permission "<permission>" for: <patterns> (session <id>)`, schema `{decision: enum["allow","reject"], feedback?: string}`; `accept`+`allow` → `once`; everything else (reject/decline/cancel/error/unsupported/modern era/deadline) → `reject` with feedback if any. A connection that never declares the `elicitation` capability gets an immediate `reject` per ask instead of waiting out the approval window; a connection that does declare it is honoured up to the remaining `OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS` for that ask, not the MCP SDK's own 60 s elicitation default (§5.4 for the exact mechanics).
- Never `always` (F6). `question.asked` (defensive; the tool is denied) → reject.

### 6.3 Honest limits (documented prominently)
The bridge adds only deny rules and never submits prompt `tools` or permission `always`, so it cannot directly relax policy. These rules restrict cooperative stock-tool execution; they are not an immutable administrative ceiling: shared attach servers may hold directory-wide approvals from other clients, custom/plugin/MCP tools implement their own checks, and `bash` can do anything the OS user can unless denied. Strong isolation requires an exclusively controlled OpenCode service plus OS/network controls. `OPENCODE_SERVER_PASSWORD` necessarily lives in the managed child's own environment (it is how the child authenticates to itself), so whenever `sandbox` is `workspace-write` or `danger-full-access` (i.e. `bash` is not denied), OpenCode's own `bash` tool can read that credential and call its own loopback API with it — this is inherent to a child process needing its own credentials, not something opencode-mcp mitigates further.

## 7. Air-gapped / enterprise deployment
- Runtime deps pinned exactly (see package.json): `@modelcontextprotocol/server@2.2.0` (+ `core@2.2.0`), `zod` exact. Dev: `typescript`, `@types/node`, `esbuild` exact. `.npmrc.example` for the internal registry. Publish under an internal scope (the public npm name `opencode-mcp` is taken — a proxy would pull a stranger's package).
- `npm run bundle` → `dist/opencode-mcp.mjs` single file (no `node_modules` on workstations). Verified on Node 20 and 22.
- Managed-mode air-gap defaults (`OPENCODE_MCP_AIRGAP=1`, default on; each only if unset): `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_SHARE=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, `OPENCODE_DISABLE_MODELS_FETCH=1` (skipped when `OPENCODE_MODELS_URL` is set), `NPM_CONFIG_FETCH_RETRIES=0`. These reduce automatic fetches; they do not enforce no-egress.
- Docs: OpenCode offline checklist (internal registry for OpenCode's runtime plugin install, `rg` on PATH, `enabled_providers`, `@ai-sdk/openai-compatible` gateway provider, managed config), Claude Code registration (`claude mcp add`, `.mcp.json`, `managed-mcp.json` + `allowedMcpServers`, per-server `timeout`, `CLAUDE_CODE_MCP_ALLOWLIST_ENV`), child-env exposure and the allowlist option.

## 8. Configuration (env)

| Env | Default |
|---|---|
| `OPENCODE_MCP_MODE` | `attach` if `OPENCODE_MCP_SERVER_URL` set, else `managed` |
| `OPENCODE_MCP_SERVER_URL` / `OPENCODE_MCP_ALLOW_INSECURE_HTTP` | — / `0` |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | `opencode` / (managed: random) |
| `OPENCODE_MCP_OPENCODE_BIN` | `opencode` |
| `OPENCODE_MCP_SERVE_ARGS` | `` (space separated, e.g. `--pure`) |
| `OPENCODE_MCP_AIRGAP` | `1` |
| `OPENCODE_MCP_CHILD_ENV_ALLOWLIST` | `` (comma separated names / `PREFIX_*`; empty = inherit minus scrub) |
| `OPENCODE_MCP_DEFAULT_CWD` | `CLAUDE_PROJECT_DIR` or process cwd |
| `OPENCODE_MCP_ALLOWED_ROOTS` | default cwd (path-delimiter separated); entries are trimmed and must be absolute; an explicitly set value that yields zero roots fails startup |
| `OPENCODE_MCP_REMOTE_PATHS` | `0` |
| `OPENCODE_MCP_DEFAULT_MODEL` / `_DEFAULT_AGENT` | — ; `_DEFAULT_MODEL`, if set, must be `provider/model` |
| `OPENCODE_MCP_DEFAULT_SANDBOX` / `_DEFAULT_APPROVAL_POLICY` | `workspace-write` / `never` |
| `OPENCODE_MCP_TURN_TIMEOUT_SECONDS` / `_MAX_TURN_TIMEOUT_SECONDS` | `3600` / `21600` |
| `OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS` | `600` |
| `OPENCODE_MCP_STARTUP_TIMEOUT_SECONDS` / `_REQUEST_TIMEOUT_SECONDS` / `_CLEANUP_TIMEOUT_SECONDS` | `60` / `30` / `15`; Node fetch/undici headers and body waits cap HTTP at 300 s |
| `OPENCODE_MCP_HEARTBEAT_SECONDS` / `_STATUS_POLL_SECONDS` / `_SSE_STALL_SECONDS` | `15` / `30` / `35`; `_HEARTBEAT_SECONDS` is additionally rejected above `600` (Claude Code's 30-min stdio idle abort makes a larger value pointless and undetectable) |
| `OPENCODE_MCP_READ_RETRY_ATTEMPTS` | `3` (integer 1–3, counts the initial attempt; overload design §C bounded admission GET retries only) |
| `OPENCODE_MCP_RESPONSE_LOOP_LIMIT` | `6` (integer 3–20, or `0` to disable; response-loop watchdog, §12) |
| `OPENCODE_MCP_MAX_OUTPUT_CHARS` | `20000` |
| `OPENCODE_MCP_MAX_SESSIONS` | `256` (positive integer ≤ 10000; a new `opencode` start beyond it is rejected `SESSION_CAPACITY` before any upstream mutation, never evicting a tracked session) |
| `OPENCODE_MCP_MAX_RUNNING_TURNS` | `4` (integer 0–256; `0` = unlimited run-slot cap, §13) |
| `OPENCODE_MCP_MAX_QUEUED_TURNS` | `64` (integer 0–1024; `0` = no queue) |
| `OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS` | `0` (disabled; or 1–2147483 seconds a queued turn may wait for a run slot) |
| `OPENCODE_MCP_MODEL_PROFILES` | `{}` (JSON object, `provider/model` → `{context?,input?,output?,maxRunning?}`; §13) |
| `OPENCODE_MCP_CONTEXT_GUARD` | `reject` (`reject` or `off`; prompt-size guard, §13) |
| `OPENCODE_MCP_END_ACTION` | `delete` |
| `OPENCODE_MCP_ON_EXIT` | `abort` (`end` also ends sessions) |
| `OPENCODE_MCP_LOG_LEVEL` | `info` |

Every `*_SECONDS` variable above converts to milliseconds and is rejected above `2147483` seconds (`ms > 2^31-1`, Node's `setTimeout` overflow ceiling — beyond it the timer would fire almost immediately instead of acting as an effectively-disabled bound).

## 9. Testing strategy
- Runtime: tests on the researched `node:22` image (22.23.x) on gram; dist/bundle smoke on `node:20` too. Tests are discovered by package.json's `test/**/*.test.ts` glob; `*.smoke.mjs` files are intentionally excluded. Dependency install/build on gram with registry access; hermetic e2e afterwards with `--network none`.
- Unit (node:test, no deps): sse parser; http client vs in-process `node:http` fake (auth, timeouts, abort, 404 mapping, pagination cursor, redirects rejected); managed server with a fake `opencode` script (readiness line, wrong endpoint, startup timeout kills child, unexpected exit → onUnavailable, close kills group, env scrub/allowlist); paths; policy; result builder; hub; turn/engine with a scripted fake `OpencodeApi` + fake clock.
- **Mandatory engine regressions**: delayed submission; idle before busy; abort before runner creation; accepted prompt with lost HTTP response (no duplicate POST); missing user event; SSE reconnect during permission wait; startup error without user message; > 100 messages; automatic compaction; `finish:"tool-calls"` + idle → `TURN_INCOMPLETE`; concurrent reply/reply and reply/end; late approval after cancellation; stale permission rejection before the next turn; two observers each receiving heartbeats; unexpected managed-process exit mid-turn; unconfirmed cleanup keeps the session.
- MCP integration (deps on gram): spawn the server over stdio with a stub Engine and a raw JSON-RPC client → tools/list schemas, alias validation, strict inputs, per-request progress with progressToken, cancellation → owning-call abort, legacy elicitation round trip (exactly one engine submission), error variants, size budget, shutdown on SIGINT/stdin EOF.
- E2E (gram docker `--network none`): real `opencode-ai@1.18.33` + `rg` + fake LLM (docs/research/samples/fake-llm-server.mjs + SLOW) → delegate → result → reply → status → end; read-only denies `write`/`edit` (`apply_patch` is not exercised — OpenCode's default `build` agent does not offer that tool to the fake provider's model at all; see the F22 footnote in §2 and `e2e/README.md` scenario b); on-request approval via elicitation (with admin `bash: ask`); `wait-seconds:0` + status; cancel; timeout; shutdown cleanup. Stretch: real Claude Code headless (`claude -p` + fake Anthropic API; docs/research/probe-mcpclient) calling `mcp__opencode__opencode`.

## 10. Open questions / risks
- R1 Target Claude Code/OpenCode versions in the target environment are unknown (G31). Legacy-handshake compatibility of SDK v2 `serveStdio` is verified; supported client versions still require testing.
- R2 The target environment's LLM gateway must support streaming chat-completions with tool calls (G34).
- R3 `on-request` needs Claude Code's interactive dialog on the legacy era; `-p`/SDK/modern era degrade to reject.
- R4 Windows workstations: process-group kill differs; v0.1 targets Linux/macOS.
- R5 OpenCode API churn: pin the tested version; `opencode-status` list reports the OpenCode version.
- R6 Instruction persistence across compaction is best-effort (F18).

## 11. v0.3 delegation features (release 0.2.0)

Implementation details and public behavior are documented in the README, the source modules, and the tests listed below.

- **Output presentation and retention:** per-call `detail`/`max-output-chars`, plus paged `opencode-output` for answer, tool calls, structured output and per-turn diff. Retained artifacts are immutable, captured before response truncation and bounded by time/size/count.
- **Per-turn diff:** lazy OpenCode snapshot reads anchored to the submitted user message, with stat and patch paging; they never determine execution completion.
- **Batch status:** `opencode-status` accepts up to 16 IDs and waits for any/all captured turns without retargeting or admitting work.
- **Request deduplication:** `request-id` reserves before mutation; matching retries observe/replay the original operation and conflicting inputs fail before mutation.
- **Discovery:** `opencode-info` projects server settings, connected models, visible agents and allowed roots through an allowlist; it does not start OpenCode.
- **Structured output:** turn-local schema subset is instructed and validated bridge-side; conformance does not alter turn status or retry behavior.

### Invariants

Every turn result describes one identified turn and its observed execution state. Presentation, retained artifacts, discovery, diffs, schema conformance and waits cannot establish completion, authorize admission, or clear quarantine; `executionState:"unknown"` remains quarantined. Never send OpenCode prompt `format`, prompt `tools`, permission `always`, or session `allow` rules. Inputs are strict, new argument names are kebab-case, and exactly one ID alias is accepted. Every result has object root `kind`/`status`/`content`; semantic failures are error-kind failed results. Serialized output stays below 45,000 characters. Never truncate usable identifiers or imply omitted arrays are empty; include counts and `omittedFields`. Observer cancellation detaches only the observer, progress uses one stream per request, and errors use the shared tool hints.

### Deferred

Worktree management, revert, fork, todos, attachments, summarize and cumulative usage remain deferred. Callers can provision their own git worktrees: OpenCode-created worktrees drop uncommitted/untracked changes. Revert can overwrite external edits to changed files and later become irreversible. Forks share the parent's directory, so they do not provide file isolation. The remaining items have no safe, verified bridge contract in the current probe.

## 12. Overload robustness (release 0.3.0)

사내 gateway 과부하 시의 빈 응답·비정상 응답·429/503/529·느린 읽기 대응. 사용자 관점 설명은 README "과부하·비정상 응답 대응"을 기준으로 한다.

- 동작 문서: README의 "과부하·비정상 응답 대응" 절, 구현 코드 `src/core/response-loop.ts`, `src/core/turn.ts`, `src/core/connection-health.ts`, `src/opencode/retry.ts`, 그리고 아래 테스트.
- 실측 근거: `docs/research/probe-overload/` (OpenCode 1.18.33 + 가짜 LLM; 요약표는 13개 형태를 모두 다루지만, 메시지·이벤트 샘플은 그중 일부(1b/3/4/5/7/8/9/11)만 보존됨).
- 불변식: prompt 자동 재전송 없음; 모호한 mutation(5xx·timeout·손실된 응답)은 재시도하지 않고 표식 유지; degraded 읽기는 turn을 실패시키지 않음; `error.retryable`은 재전송 허가가 아님(`resendSafety` 확인).
- 검증: 단위 테스트 `test/core/overload-3a.test.ts`, `overload-3b.test.ts`, `response-loop.test.ts`, `test/opencode/http-retry.test.ts`; 실제 OpenCode e2e `e2e/overload.test.mjs`(13 시나리오).

## 13. Context-aware assignment and run-slot cap (release 0.4.0)

Two additive features: per-model context-size reporting and a prompt-size guard (model assignment), and a
per-process run-slot cap with a FIFO queue (concurrency cap). Both default to conservative, opt-out behaviour
and degrade to today's behaviour when OpenCode reports no limit and the operator sets no profile or cap
override. README's "모델별 컨텍스트에 맞춘 작업 배분" and "병렬 실행과 최대 실행 개수" sections are the
caller-facing summary of this contract.

### 13.1 Decisions

- Queued turns are reported as `status:"running"` plus a `queue` object, not a new terminal-looking status, so
  existing pollers and the batch `ready()`/list logic keep working unmodified; `resendSafety` stays
  `"not_submitted"` and callers are told never to resend a queued turn.
- Default `OPENCODE_MCP_MAX_RUNNING_TURNS=4` (`0` = unlimited); default `OPENCODE_MCP_MAX_QUEUED_TURNS=64`;
  default `OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS=0` (disabled) — queued turns hold nothing upstream, so there is
  no inherent reason to time them out; running turns are already bounded by the turn timeout, and approvals by
  the approval timeout.
- A turn whose execution outcome is unknown (`executionState:"unknown"`) keeps its run slot (held, not
  released) until recovery proves quiescence, a managed-process exit fences the generation, or the session
  ends or is removed; exposed as `concurrency.heldUnknown` so operators can see slots that are not actually
  free.
- The run-slot queue grants the oldest eligible ticket first; a ticket blocked only by its own model's cap is
  skipped rather than blocking everyone behind it (no idle global capacity sits behind one saturated model),
  while tickets of the same model stay strictly FIFO.
- A turn with no `model` and no `OPENCODE_MCP_DEFAULT_MODEL` configured is counted only against the global
  cap — the per-model cap and the prompt guard both need a known target model before submission. If any
  `OPENCODE_MCP_MODEL_PROFILES` entry sets `maxRunning` while no default model is configured, startup logs a
  warning once.
- `OPENCODE_MCP_CONTEXT_GUARD` defaults to `reject` (no `warn` mode): a prompt whose heuristic estimate
  exceeds the model's usable input budget is rejected before any OpenCode mutation, because OpenCode's own
  compaction cannot shrink the prompt that produced the overflow. The guard never counts session history —
  OpenCode compacts proactively when it knows a limit, and reactively on gateway overflow even when it
  reports `limit.context === 0`.
- The guard runs synchronously before any reservation or mutation whenever the model's limit is already known
  (an operator profile, or a cached projection of a prior `/provider` read for the current generation and
  resolved directory); otherwise it falls back to an in-turn check after warm-up, immediately before the
  prompt POST, so a doomed prompt is never queued and no session is left orphaned in the common case.
- `TurnResult.model` keeps its existing meaning (the requested model); the model OpenCode actually used is
  reported separately as `context.model`, so no caller-visible field silently changes meaning.

### 13.2 Accounting

Mirrors OpenCode 1.18.33 exactly (`packages/opencode/src/session/overflow.ts` and
`packages/opencode/src/provider/transform.ts`; file:line references as cited by the internal source+runtime
probe of that tag):

- Usable input budget (`overflow.ts:10-20`, with `compaction.reserved` treated as unset):
  `maxOut = min(limit.output ?? 0, 32000) || 32000`; if `limit.input > 0`:
  `usable = max(0, limit.input - min(20000, maxOut))`; else if `limit.context > 0`:
  `usable = max(0, limit.context - maxOut)`; else usable is unknown. A result of `0` is also reported as
  unknown (nothing fits, but `0` would otherwise read as "no data" everywhere else in this contract).
- Context/overflow count (`overflow.ts:22-34`): `tokens.total` when it is a positive finite number, else
  `tokens.input + tokens.output + tokens.cache.read + tokens.cache.write`; missing or non-finite data is
  reported as unknown, never as `0`.
- A custom provider model with no `limit` block in OpenCode's config reports `limit:{context:0,output:0}`
  (`provider/provider.ts:1609-1613`). At `context===0`, OpenCode's own proactive compaction never triggers
  (`overflow.ts:12,29`), but reactive compaction on a gateway-reported context overflow still works
  (`session/processor.ts:621-631`). The request still asks the gateway for `max_tokens:32000`
  (`transform.ts:1481-1483`; an output limit of `0` counts as the `32000` ceiling).
- The prompt-size guard's estimate is deliberately rough and ASCII-biased: `ceil(asciiChars/4) +
  ceil(nonAsciiCodePoints/2)`, with no fixed overhead term and no session-history term.
- `opencode-info section:"models"` merges an operator `OPENCODE_MCP_MODEL_PROFILES` entry over the
  OpenCode-reported limit field by field (the profile wins per field); `limitSource` is `"profile"` only when
  every present limit field came from the profile, `"opencode"` when none did, else `"mixed"`. A profile that
  only sets `maxRunning` does not change `limitSource`.
- Per-turn `context.used` is taken from the last non-summary assistant message with usage in the turn's
  execution interval; `context.peakUsed` is the maximum of the same count over all of that turn's non-summary
  assistants, so a mid-turn compaction does not hide how large the task actually got. `ratio =
  round3(used / usableInputTokens)`; `CONTEXT_HIGH` is warned at an unrounded ratio ≥ 0.8.
- `/provider` catalog reads are capped at 32 MiB (was 2 MiB, §5.1/U0): OpenCode's bundled models.dev snapshot
  alone is about 6.15 MiB once `enabled_providers` does not restrict it, and the previous 2 MiB cap failed
  every turn and `opencode-info models` call on such a deployment.

### 13.3 Invariants

Every turn still describes one identified turn and its observed execution state; `queue`, `queuedMs` and
`context` are additive reporting and never themselves establish completion or admission. Queue waiting never
holds the per-session admission gate and is not counted against `timeout-seconds` (the turn timer arms after
submission); `wait-seconds` bounds queue wait together with the rest of admission, so `wait-seconds:0` returns
immediately even for a queued turn. `RUN_QUEUE_CAPACITY` and a pre-submission `PROMPT_TOO_LARGE` are
`EngineError`s raised before any reservation is kept — nothing is submitted, and a `start` creates no session
(a `reply`'s existing session is left untouched). An in-turn `PROMPT_TOO_LARGE` (the fallback path, used when
the limit became known only after warm-up) and `QUEUE_TIMEOUT` are turn-level `error.name`s on an otherwise
idle, still-usable session, never routed through `admissionFailure`. Shutdown closes the run-slot queue
synchronously first (queued tickets settle `cancelled`, their turns finish `cancelled`/not_submitted) before
the existing bounded stop of running turns.

### 13.4 Deferred

No automatic server-side model choice (Claude Code always chooses and passes `model` explicitly when sizing
matters); the prompt-size guard's token estimate is a heuristic, not a real tokenizer for any provider; the
run-slot cap and queue are per MCP process with no cross-process or cross-host coordination (an attach-mode
deployment where several opencode-mcp processes share one OpenCode server gets one independent cap per
process, not one shared cap).
