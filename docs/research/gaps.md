# opencode-mcp research: gaps, resolutions and corrections

Date: 2026-09-29. This is a completeness review of the four reports (codex-mcp, opencode-api, opencode-offline, mcp-client), plus new evidence gathered for it.

## Evidence labels

- **[SRC]**: `anomalyco/opencode` at tag `v1.18.33` (`51ef4be1d3c1`, 2026-09-28), read from a local sparse clone that was not retained. Paths below are relative to `packages/opencode/src/` unless noted.
- **[RUN]**: container `ocmcp-research-gaps` (node:22) on gram, running `opencode-ai@1.18.33` as two `opencode serve` processes that share one HOME and one DB.
  - Two fake OpenAI-compatible LLMs: `fake` (fast) and `slow` (1 s per chunk). No internet was used by opencode.
  - Probe scripts and raw output were not retained (see §5).
  - Container removed afterwards.
- **[GIT]**: a local clone of the openai/codex repository, not retained (see docs/research/codex-mcp.md §1).
- **[INF]**: inference, not verified.

---

## 0. Findings that change the design (read these first)

1. **Every request that is not a `/session/{id}/*` route must carry the session's own directory.**
   - `/session/{id}/*` routes always run in the stored `session.directory`. The server ignores `?directory=` and the `x-opencode-directory` header for them.
   - These routes are scoped to a per-directory, in-memory "instance": `/event`, `/permission`, `/question` and `/session/status`.
   - Called without the session's directory, they silently return nothing, or `404 PermissionNotFoundError` for a permission reply. [SRC][RUN P1]
2. **A per-session `permission` ruleset is not a security boundary.** Three separate holes, all verified:
   - **(a) The prompt's `tools` field overwrites the ruleset.** `tools:{…}` in a prompt body replaces the session's stored ruleset, and the replacement persists. [SRC][RUN P2]
   - **(b) Subagents inherit only part of it.** `task` child sessions get only the parent's `deny` and `external_directory` rules. A parent `ask` becomes the default `allow` in the child. [SRC][RUN P3]
   - **(c) "always" is shared.** A reply of `always` approves the pattern for **every** session of that directory until the server restarts. [SRC][RUN P4]
   - **(d) There is no OS sandbox at all.** [SRC]
3. **Do not use the blocking `POST /session/{id}/message` for long work.**
   - Response headers are sent only when the turn finishes. Node's `fetch` gives up after 300 s without headers.
   - Dropping the HTTP connection does **not** stop the turn. [SRC][RUN P5]
   - Use `prompt_async` plus SSE instead.
4. **Exactly one OpenCode process must own a session while it runs.**
   - Run state, abort, status, pending permissions and SSE are all in-memory per process.
   - Sending `abort` to another process that shares the DB returns `true` and does nothing.
   - Two processes prompting the same session at once caused a **runaway loop**: 96 LLM calls in about 3 min, until I aborted it on both processes. [RUN P13]
5. **One `session.idle` covers every queued prompt.**
   - Two `prompt_async` calls on one session were served by a single run and produced a single `session.idle`. [RUN P6]
   - The MCP must therefore serialize turns per session.
6. **Only `notifications/progress` is confirmed to reset Claude Code's 30-min stdio idle timer.** A custom notification such as `codex/event` is not confirmed to do so and should not be relied on for this. (unverified beyond the progress-notification case; behaviour assumed by the design — see G27)
7. **The npm name `opencode-mcp` is already taken on npmjs** (v3.0.0, AlaeddineMessadi, 2026-09-16). [RUN `npm view`]
   - Through a proxy registry, `npm i opencode-mcp` would pull the public package.
   - Publish internally under a scope, for example `@corp/opencode-mcp`.

---

## 1. Gap list (status and evidence)

### A. OpenCode server semantics

**G1. Which directory an existing session runs in: RESOLVED**
- `session.directory` always wins for `/session/{id}/...` routes.
  - Code: `server/routes/instance/httpapi/middleware/workspace-routing.ts:182` uses `session?.directory || defaultDirectory(...)`. The session id is taken from the path in `server/shared/workspace-routing.ts:20-29`.
- Run: `prompt_async` with no directory, on a session created in `/work/projA` while the server's cwd was `/work/projB`, ran `pwd` → `/work/projA`. [RUN P1]

**G2. Instance scope of events, permissions, questions and status: RESOLVED**
- `/event` filters on `event.location.directory === instance.directory` (`handlers/event.ts:37`).
- Permission, question and status state lives in `InstanceState` (`permission/index.ts:46`, `question/index.ts:68`, `session/status.ts`).
- Run P1, with no directory given:
  - `GET /permission` returned 0 items (1 with `?directory=A`).
  - `GET /session/status` returned `{}` (busy with A).
  - `/event?directory=B` saw 0 of the session's events.
  - `POST /permission/{id}/reply` returned **404**; the same call with A returned 200.
- Alternative: `GET /global/event` (wrapped `{directory, payload}`) covers every directory. [opencode-api report]

**G3. How to wait for completion robustly: RESOLVED (recipe below; the parts are verified)**
- SSE facts [SRC `handlers/event.ts`]:
  - The listener is registered eagerly, so nothing published after connect is lost.
  - Frames carry no SSE `id:`, so there is **no `Last-Event-ID` resume**.
  - Heartbeat every 10 s.
  - The stream **ends** on `server.instance.disposed` (line 61).
- `session.idle` is published whenever status becomes idle (`session/status.ts` `set`). This covers normal completion, errors after a run, and abort.
- `session.error` precedes idle on failure or abort. [RUN P7, offline report]
- Recipe:
  1. Subscribe to `/event?directory=<session.directory>` and wait for `server.connected`.
  2. Send `prompt_async`.
  3. Track the root session plus descendants (a child's `parentID` chain).
  4. Answer `permission.asked` and `question.asked` from any of them.
  5. Finish on `session.idle` whose `sessionID` equals the root.
     - Children emit their own `session.idle` first [RUN P3: `["child","parent"]`].
  6. On an SSE gap longer than 30 s, or a stream end: reconnect, then reconcile with `GET /session/status?directory=` (absent means idle) and `GET /session/{id}/message?limit=N`.
  7. Result: the last assistant message whose `parentID` equals our user message id.
     - A non-`tool-calls` finish means completed.
     - `error.name` distinguishes the failures: `MessageAbortedError` means cancelled; `APIError`, `ProviderAuthError` or `UnknownError` mean failed.

**G4. A second prompt while busy: RESOLVED**
- `Runner.ensureRunning` returns the *existing* run's `done` (`effect/runner.ts`). The loop picks up the new user message at the next step boundary.
- Run: two `prompt_async` calls 200 ms apart were both answered in order, with **one** `session.idle` at the end. [RUN P6]
- Mid-turn this acts like Codex "steer" [INF].
- Design: refuse `reply` while a turn is busy, or abort first.

**G5. Headers and timeouts on the blocking prompt: RESOLVED**
- `handlers/session.ts:295-310` awaits `promptSvc.prompt(...)` *then* builds the response. Any failure is also mapped to a bare `400 BadRequest`.
- Run: a 6.3 s turn had headers at 6277 ms and body at 6278 ms. [RUN P5]
- Node 22.23.3 bundles undici 6.28.1, with the defaults `headersTimeout` = `bodyTimeout` = `3e5` ms. [RUN: strings in the node binary]
- See §4 for the 310 s run.

**G6. Client disconnect during the blocking prompt: RESOLVED**
- The work is `forkIn(scope)` in the instance-scoped runner, so aborting the HTTP request only interrupts the waiter.
- Run: after the fetch was aborted at 1.5 s, the turn kept running and finished with `finish:"stop"`. [SRC `effect/runner.ts` `startRun`][RUN P5]

**G7. What the blocking prompt returns when aborted: RESOLVED**
- `/abort` while the blocking call is pending gives `200` with `info.error = {name:"MessageAbortedError", data:{message:"Aborted"}}` and the partial parts (`onInterrupt` is `lastAssistant`). [RUN P5]

**G8. Abort with a pending permission; replying to it later: RESOLVED**
- The stale `per_…` request stays in `GET /permission` after abort.
- A new prompt on the same session works normally.
- Replying to the stale request later returns `200 true` and has no effect (0 new messages).
- The aborted assistant message has no `finish` and `error: MessageAbortedError`. [RUN P7]
- Timeouts: neither permission nor question waits have one (`Deferred.await`, no timeout) [SRC], so the MCP must enforce its own.

**G9. Permission reply semantics: RESOLVED** [SRC `permission/index.ts:113-165`][RUN P4]
- `reject` also rejects **all other pending requests of the same session**. With a `message`, it becomes `CorrectedError` feedback to the model.
- `always` pushes `{permission, pattern: each of request.always, action:"allow"}` into the instance-wide `approved` list.
  - Run: an "always" for `echo *` in session S1 auto-approved `echo leak-test` in a **new** session S2 in the same directory.
  - A session in another directory still asked.
- MCP rule: never send `always` unless the user chose it knowingly. It is directory-wide and lasts until restart.

**G10. Rule evaluation order: RESOLVED**
- `findLast` over `[agent rules…, config rules…, session rules…, approved]`, so the **last matching rule wins**. [SRC `permission/index.ts:32`; composition in `session/tools.ts:87`]
- A tool is hidden from the LLM only when its last matching rule is `pattern:"*"` + `deny` (`disabled()`, line 210).

**G11. `tools` in the prompt body: RESOLVED, and it is dangerous**
- `session/prompt.ts:1060-1067` turns `tools:{t:bool}` into rules and **replaces** `session.permission`, persistently.
- Run:
  - The session was created with `bash: deny`.
  - A prompt with `tools:{webfetch:false}` changed the stored ruleset to `[{webfetch deny}]`.
  - bash was then asked for and executed. [RUN P2]
- MCP rule:
  - Never forward `tools`.
  - Use `PATCH /session/{id}` with `permission` instead. It *appends* via `Permission.merge`, and last-wins makes appended rules effective (`handlers/session.ts:193-198`).

**G12. Permission inheritance for subagents (`task` tool): RESOLVED, and it is a hole**
- `agent/subagent-permissions.ts`: a child gets only the parent's `external_directory` rules and `deny` rules, plus `task` and `todowrite` denies.
- Run P3a: the parent had `bash: allow` and config had `bash: ask`. The child asked for bash, and `permission.asked.sessionID` was the child's id (`parentID` = parent).
- Run P3b: the parent had `webfetch: ask`. A direct call asked; the child's webfetch ran **without asking**.
- MCP rules:
  - Handle permissions of descendant sessions.
  - Express hard policy as `deny`, or in config / `OPENCODE_PERMISSION`, or deny `task` outright. Never rely on a session-level `ask`.

**G13. Events for child sessions: RESOLVED**
- Children share the instance event stream. Their permission, idle and message events carry the child's `sessionID`.
- `GET /session/{child}` gives `parentID`. [RUN P3]

**G14. OS sandbox (Codex `sandbox` parity): RESOLVED, there is none**
- No landlock, seatbelt or bwrap anywhere in `opencode/src` or `core/src`.
- `bash` runs as a plain child process gated only by pattern permissions on the parsed command, plus `external_directory` checks (`tool/shell.ts:262-291`). [SRC]
- `read-only`, `workspace-write` and `danger-full-access` can only be approximated with rules, or enforced outside OpenCode (container or separate OS user) [INF].

**G15. Provider retries: RESOLVED, bounded**
- `session/retry.ts`: `RETRY_MAX_RETRIES=5`. Delays are 2, 4, 8, 16, then a 30 s cap, with jitter (about 60–75 s total).
- **But** `retry-after` / `retry-after-ms` headers are honoured up to 2^31 ms, so a gateway 429 can park a session for days.
- Retries apply to 5xx, 429 and network error messages; not to 400/401 or context overflow.

**G16. Runaway protection inside OpenCode: RESOLVED, weak**
- `maxSteps = agent.steps ?? Infinity` (`session/prompt.ts:1178`).
- `doom_loop` asks after 3 identical consecutive tool calls (`session/processor.ts:29`).
- The MCP needs its own wall-clock and step budget. `agent.<name>.steps` can be set in config.

**G17. Mapping `base-instructions` / `developer-instructions`: RESOLVED**
- The prompt `system` string is **appended** after the agent or provider prompt, environment and instructions. Only the **latest user message's** `system` is used (`session/llm/request.ts:57-66`).
- So `system` maps to Codex `developer-instructions`, and must be re-sent on every reply.
- Codex `base-instructions` (replace) has no per-request equivalent. It needs a config agent with `prompt`, then `agent:<name>`. [SRC]

**G18. Model parameter shapes: RESOLVED**
- `POST /session` takes `model:{id, providerID, variant?}`.
- A prompt takes `model:{providerID, modelID}` plus a separate `variant`.
- Resolution order is `input.model ?? agent.model ?? session's current model`, and a prompt's model is persisted onto the session (`session/prompt.ts:646-684`). [SRC][spec]

**G19. Ending a session: RESOLVED**
- `DELETE` cascades to children (`session/session.ts:606-627`). It cancels background jobs but **not the active runner**, which explains the "busy for 5 s + DB error" seen in the opencode-api report.
- The safe sequence is:
  1. abort
  2. wait for `session.idle`
  3. reject leftover permissions and questions (same directory)
  4. `DELETE`, or archive with `PATCH /session/{id} {time:{archived:<ms>}}`
- Archived sessions still appear in `GET /session`, with `time.archived` set. [RUN P4]

**G20. Several processes and a shared server: RESOLVED**
- Sessions are visible across processes (shared SQLite).
- Continuing a session *sequentially* from a second process works (1 LLM call).
- `status` and `abort` are per process: process 2 saw a running session as idle, and its abort was a no-op. [RUN P13b]
- Concurrent prompts from 2 processes on one session gave the runaway loop. [RUN P13]
- MCP rule:
  - Own a private `opencode serve` (or one shared server) and route **all** calls for a session to it.
  - Never let the TUI or `opencode run --session` touch MCP-owned sessions while they run.
  - Consider `OPENCODE_DB` to isolate the store [INF: flag string only].

**G21. `serve --port 0`: RESOLVED**
- Default 0 means **try 4096 first, then a random port** (`server/server.ts:119-121`).
- Global config `server.port`, `server.hostname` or `server.mdns` override unless the flag is explicit. `mdns:true` changes the default hostname to `0.0.0.0` (`cli/network.ts`).
- Run: server 1 got 4096, server 2 got 46453.
- MCP rule:
  - Always pass explicit `--hostname 127.0.0.1 --port <n>`.
  - Parse `opencode server listening on http://…` from stdout.

**G22. What kills running turns besides abort: RESOLVED**
- `PATCH /global/config` with a change disposes **all instances** (`handlers/global.ts:78-81`). Disposal cancels every runner, rejects pending permissions and closes `/event` streams.
- The MCP must never call the config-mutation routes. Any other client of a shared server could do it [INF].

**G23. Question tool in `serve`: RESOLVED**
- It is enabled when `OPENCODE_CLIENT` is `cli` (the default) and permitted for build and plan (`tool/registry.ts:207`, `agent/agent.ts`).
- `opencode run` removes it by creating the session with `question`, `plan_enter` and `plan_exit` set to `deny` (`cli/cmd/run.ts:430-445`). The MCP can do the same, or bridge it.

**G24. Client-supplied `messageID`: RESOLVED**
- The server only checks the `msg` prefix (`id/id.ts`). Ordering relies on ascending ids: 6 bytes of `ms*4096+counter` in hex, plus 14 base62 characters.
- Either generate ids with the same algorithm and the current time, or read the user message id from the `message.updated` (role user) event. Serializing per session makes the latter unambiguous.

**G25. `OPENCODE_MODELS_PATH` / `_URL`: RESOLVED [SRC], not run**
- `core/src/models-dev.ts:160,184,222`: `_URL` replaces `https://models.opencode.ai`, and `_PATH` is read instead of the cache file.
- `OPENCODE_DISABLE_MODELS_FETCH` makes refresh a no-op.

**G26. Snapshots on large repos: PARTIAL**
- `"snapshot": false` disables git snapshots (`snapshot/index.ts:169`, `session/summary.ts:115`) [SRC].
- The cost on a large corporate monorepo, and the effect on `/session/{id}/diff` when snapshots are off, are OPEN [INF: diff likely empty].

### B. Claude Code and the MCP protocol

**G27. Do custom notifications reset the idle timer? NOT INDEPENDENTLY VERIFIED**
- Documented: `notifications/progress` resets the idle timer (mcp-client.md §3.3 run evidence). Whether custom notifications such as `codex/event` also reset it was not tested.
- If custom notifications do not reset it, Codex's `codex/event` stream would **not** have kept a Codex call alive past 30 min, which would resolve codex-mcp report §6.2 — but this remains untested, not a resolved finding. [INF]

**G28. Elicitation after the call is auto-backgrounded (120 s): OPEN**
- The docs say backgrounding is skipped *while a dialog is open*. Whether a dialog can open *after* backgrounding is untested; it needs an interactive TTY.

**G29. Esc / `TaskStop` → `notifications/cancelled`: OPEN**
- Not verified end-to-end; only the SDK's behaviour once `notifications/cancelled` is sent was run (see mcp-client.md §1.7, cancellation run evidence, and §3.4, the TaskStop/Esc statement). Not run interactively.

**G30. Which form fields Claude Code's elicitation dialog renders (enum, boolean): OPEN**
- For approvals, design with a single enum field or a boolean [INF].

**G31. Target environment's Claude Code version, managed settings and allowlist: OPEN**
- This is the user's input. It decides the runtime (v1 or v2), the idle and auto-background defaults, and `CLAUDE_CODE_MCP_ALLOWLIST_ENV`.

### C. Codex parity

**G32. Which Codex commit is the "last state", and when was it deprecated: RESOLVED** [GIT]
- `942af8447b` (mcp-client report) is PR #39630, 2026-08-20. `2bd71f96` (codex-mcp report) is the parent of removal commit `531f3836` (#42993, 2026-09-05).
- Between them, `mcp-server/` changed by one line in `message_processor.rs` (`codex_core::passthrough_image_store()`) plus tests. The tool surface is identical.
- The deprecation warning, PR #39657 (commit `5e3a6fe4`), is contained in tag **`rust-v0.149.0`**. The mcp-client report's "0.149.1 [2nd]" is imprecise.

**G33. Mapping Codex arguments to OpenCode: RESOLVED (mapping only)**

| Codex argument | OpenCode equivalent | Source |
|---|---|---|
| `prompt` | text part | G3 |
| `cwd` | `POST /session?directory=` (then fixed per session) | G1 |
| `model` `"p/m"` | prompt `model:{providerID, modelID}` | G18 |
| `developer-instructions` | `system`, re-sent on every turn | G17 |
| `base-instructions` | config agent `prompt` | G17 |
| `approval-policy` `never` | session rules plus auto-reply policy | G9–G12 |
| `approval-policy` `on-request` | bridge via elicitation | G9–G12 |
| `sandbox` | no native equivalent | G14 |
| `config` | **no per-session override**; `PATCH /config` is global and disposes instances | G22 |
| `compact-prompt` | no request field [INF] | — |

### D. Environment

**G34. Target environment's LLM gateway compatibility: OPEN**
- Needs streaming chat-completions, `tool_calls`, and `stream_options.include_usage`, as the fake LLM served.
- OpenCode sends `x-session-affinity` and `x-session-id` headers. [offline report]

**G35. Target environment's workstation OS (Windows or macOS binaries, `pwsh` shell path): OPEN**

**G36. A firewall that silently drops packets instead of refusing (longer stalls): OPEN** [offline §9]

**G37. Shared team OpenCode server or per-user private server: OPEN (design decision)**
- G20 and G22 favour one private `serve` per MCP process with a random password [INF].

**G38. Node fetch 300 s header timeout: RESOLVED**
- Constant: [RUN]. Behaviour: see §4.

---

## 2. Claims in the reports that are wrong or incomplete

**W1. opencode-api §3 and §10: "`--port` default 0 = random"**
- Wrong: 0 tries **4096 first**, then random (`server/server.ts:121`). [RUN G21]
- Config `server.*` can also silently change the host and port.

**W2. opencode-api §0.3: "blocks through … unbounded provider retries"**
- Wrong: at most 5 retries, about 60–75 s (`session/retry.ts:31,193`).
- Only a server-sent `retry-after` makes the wait effectively unbounded. [SRC]

**W3. opencode-api §0.4 / §4: "Always send `?directory`"**
- Incomplete. For `/session/{id}/*` it is ignored, since `session.directory` wins.
- For `/event`, `/permission*`, `/question*` and `/session/status` it must be **the session's** directory, or the call silently misses or 404s. [RUN P1]

**W4. opencode-api §0.5 and §8: "Enforce the policy per session with a permission ruleset … this is our sandbox/approval-policy equivalent … and it works"**
- Unsafe as stated. It is overwritten by the prompt `tools` field (G11), inherited only for deny rules by subagents (G12), and weakened by directory-wide `always` (G9). There is no OS sandbox (G14). [RUN P2–P4]

**W5. opencode-api §8: "`agent`, `system` and `tools` in the prompt body are honoured"**
- True, but `tools` persistently **replaces** the session ruleset.
- `system` is appended, not a replacement, and applies only to the latest turn. [SRC][RUN P2]

**W6. opencode-api §10: "codex-reply = same steps on the existing session; abort first if it is busy"**
- If the MCP does not abort, a reply merges into the running loop, and one `session.idle` covers both. [RUN P6]
- Serialize explicitly; do not rely on the idle event per prompt.

**W7. opencode-api §8 [INF]: "If the last matching rule wins…"**
- Confirmed: `findLast` (`permission/index.ts:32`).
- A global `edit: allow` in config **does** override plan mode's `edit: deny`, because user rules are merged after the agent rules (`agent/agent.ts` `Permission.merge(defaults, {...}, user)`). [SRC]

**W8. codex-mcp §6.2 [INF]: "unknown whether `codex/event` resets Claude Code's idle timer"**
- Not verified by a run. See G27. [INF]

**W9. mcp-client §0.14 / §4.1**
- "Last source commit `942af8447b`" is an Aug-20 commit, not the final state. It is functionally identical to the final state for tool schemas.
- "Deprecation reportedly 0.149.1" should be **0.149.0**. [GIT G32]

**W10. mcp-client §5.1: "Node 22 LTS (matches OpenCode 1.18.x's Node ≥22 ecosystem)"**
- Misleading. OpenCode ships a Bun-compiled ELF that needs no Node (opencode-api §1).
- The Node version constraint comes only from MCP SDK v2 (≥20) and from our own code.

**W11. opencode-offline §4 and opencode-api §8: "stale permission stays after abort"**
- Correct, and extended here. Replying to it later returns `200 true` and has no effect.
- `reject` of one pending request auto-rejects the session's other pending ones. [RUN P7][SRC]

**W12. opencode-api §0.1: "`POST /session/{id}/message` … survived 45 s of idle"**
- True, but misleading for design. Headers arrive only at completion, so Node `fetch` fails at 300 s (§4). Disconnecting does not abort the turn (G6).

---

## 3. Still OPEN (need the user, the target environment or an interactive TTY)

G26 (snapshot cost), G28–G31 (Claude Code interactive behaviour and the target version), G34–G37 (gateway, OS, firewall, server topology). Also not re-verified here:
- v2 `/api/*` routes (both OpenCode reports skip them).
- `OPENCODE_DB` runtime behaviour.
- `experimental.continue_loop_on_deny`.

## 4. Undici header-timeout run (Node 22.23.3, server delays headers by 310 s)

Result: `fetch` failed after **300 785 ms** with `UND_ERR_HEADERS_TIMEOUT` [RUN]. Consequences:

- A blocking `POST /session/{id}/message` turn longer than 5 min fails on the client side.
- The turn keeps running on the server anyway (G6).
- Workarounds: use `prompt_async` + SSE (the heartbeat keeps `bodyTimeout` from firing), or `node:http`, or an undici `Agent({headersTimeout:0})`, which needs the `undici` package.

## 5. Files and cleanup

- Probe scripts and raw output were not retained. They covered: directory scope, `tools` override and subagents; headers and disconnect, queueing and abort, always-leak and archive; cross-process behaviour; and the runaway loop.
- The OpenCode source (a local sparse clone of v1.18.33) was not retained.
- Cleanup on gram: the container `ocmcp-research-gaps` and its working directory were removed. No other containers were touched.
