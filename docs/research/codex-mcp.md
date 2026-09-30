# OpenAI Codex MCP server (`codex mcp-server`): the spec opencode-mcp has to match

Research date: 2026-09-29. Evidence tags:
- **[SRC]**: read in the openai/codex source at a named commit or tag.
- **[RUN]**: seen on the wire when I ran `codex-cli 0.153.4` (the last release that shipped it) in a disposable container on gram, against a mock Responses API.
- **[DOC]**: taken from official docs or release notes.
- **[INF]**: my own inference, not verified.

## 0. Summary

1. **It no longer exists.** `codex mcp-server` got a deprecation warning in **0.149.0** (2026-08-20, PR #39657). It was removed in **0.154.0** (2026-09-09, PR #42993, commit `531f3836`, 2026-09-05). The last release that has it is **0.153.4** (2026-09-04). [SRC][DOC][RUN]
   - OpenAI says to move to the **Codex app-server**. That server speaks its own JSON-RPC, is not MCP, and is labelled "experimental, not for production".
   - For using Codex from Claude Code specifically, OpenAI points to the **Codex plugin for Claude Code** (openai/codex-plugin-cc). The plugin wraps the app-server. [DOC]
2. **Two tools only:** `codex` (start a thread and run one turn) and `codex-reply` (run another turn on an existing thread). [SRC][RUN]
   - Neither tool is annotated.
   - There is no end, close, status, list or cancel tool. A close tool was requested (#29151) and closed as won't-fix because of the deprecation.
3. **Every tool call blocks until the turn finishes.** The only streaming is a custom `codex/event` notification.
   - The server ignores `progressToken` and never sends `notifications/progress`. [SRC][RUN]
4. **Result shape:**
   `{content:[{type:"text",text:<last agent message>}], structuredContent:{threadId, content:<same text>}}`
   - An `outputSchema` was declared from 0.87.0 on.
   - Errors come back as `isError:true` tool results.
   - The `threadId` is only in `structuredContent`, never in the text. [SRC][RUN]
5. **Approvals use `elicitation/create`, but not in the MCP-spec way.**
   - The server expects the reply `{"decision":"approved"|"approved_for_session"|{"denied":{...}}|"abort"|...}`.
   - A spec-compliant elicitation reply such as `{"action":"accept","content":{}}` is treated as **denied**. [RUN]
   - A JSON-RPC error reply, or no reply at all, **hangs the tool call forever**. [RUN][SRC]
6. **Several bugs confirmed by running it:** [RUN]
   - `resources/list` and `prompts/list` are never answered.
   - Cancelling a call leaves an orphaned event loop. The next `codex-reply` on that thread is answered under the *cancelled* request's id, and the new request never gets a response.

## 1. Sources and method

- **Repository:** github.com/openai/codex. I made a local blobless clone of `origin/main` at `c248f6d4` (2026-09-29); it was not retained.
- **Last code state:** the parent of the removal commit, `2bd71f96d41809b95ea881429a1b68eb48d089b6`. The files below were read from a local extraction that was not retained; use the permalink form to fetch them directly:
  - `mcp-server/src/{lib.rs, main.rs, message_processor.rs, codex_tool_config.rs, codex_tool_runner.rs, exec_approval.rs, patch_approval.rs, outgoing_message.rs, active_turn_registry.rs, extension_event_sink.rs}`
  - `mcp-server/tests/suite/codex_tool.rs`, `tests/common/mcp_process.rs`
  - `docs/codex_mcp_interface.md`
  - Permalink form: `https://github.com/openai/codex/blob/2bd71f96d41809b95ea881429a1b68eb48d089b6/codex-rs/mcp-server/src/<file>`
  - Release tag `rust-v0.153.4` differs from `2bd71f96` in `mcp-server/` by one line in `message_processor.rs`. [SRC]
- **Historical states:** tags `rust-v0.9.0`, `0.20.0`, `0.30.0`, `0.36.0`, `0.42.0`, `0.47.0`, `0.48.0`, `0.80.0`, `0.81.0`, `0.87.0`, `0.133.0`, `0.153.4`.
- **Official docs:**
  - https://learn.chatgpt.com/docs/mcp-server. The old URL, developers.openai.com/codex/guides/agents-sdk, now redirects there (308). It is now a removal notice.
  - The old "Use Codex with the Agents SDK" guide, via Wayback snapshot `20260706183755`.
  - https://learn.chatgpt.com/docs/app-server
  - GitHub release notes for rust-v0.81.0, 0.87.0 and 0.154.0.
- **Ground-truth run:**
  - Container `ocmcp-research-codexmcp` (node:22) on gram, removed afterwards.
  - `npm i -g @openai/codex@0.153.4`, then `codex mcp-server` driven by a Node stdio client.
  - The model was a mock `/v1/responses` SSE server (same approach as the upstream tests).
  - Probe scripts and captured output (transcript, tools/list, initialize, notifications) were not retained.
  - I also installed 0.158.0 (current npm `latest`) to confirm the subcommand is gone.

## 2. Version timeline (`rust-vX` = npm `@openai/codex@X`)

| Version (date) | Change | Evidence |
|---|---|---|
| 0.0.2505061740 (2025-05-06) | First MCP server (#811). Command was `codex mcp`. Only the `codex` tool. | [SRC] |
| 0.9.0 (2025-07-22) | Added `codex-reply` (#1643), taking `sessionId` + `prompt`. Added interrupt on `notifications/cancelled` (#1646). Added `base-instructions` (#1645). | [SRC] |
| 0.11.0 | Added `include-plan-tool` (#1726). | [SRC] |
| 0.21.0 | `approval-policy` gains `on-request` (#2187). Enum becomes `untrusted \| on-failure \| on-request \| never`. | [SRC] |
| 0.36.0 (2025-09-15) | `codex-reply` param renamed `sessionId` → `conversationId`. | [SRC] |
| 0.43.0 (2025-09-30) | `codex mcp` split into `codex mcp-server` (MCP) and `codex app-server` (#4471). `codex mcp` became server management. | [SRC] |
| 0.48.0 | `include-plan-tool` removed; the plan tool is on by default (#5384). | [SRC] |
| 0.51.0 / 0.53.0 | Added `compact-prompt` (#5959) and `developer-instructions` (#5897). | [SRC] |
| **0.81.0 (2026-01-14)** | Tool result gets `structuredContent:{threadId}` (#9192). `codex-reply` takes `threadId`; `conversationId` kept as a deprecated alias. Fixes #3712. | [SRC][DOC] |
| **0.87.0 (2026-01-16)** | `structuredContent` also mirrors the text (`content`). `outputSchema` declared (#9338). | [SRC][DOC] |
| 0.134.0 (2026-05-26) | `profile` removed; unknown fields rejected (`additionalProperties:false`) (#24059). | [SRC] |
| 0.143.0 (2026-07-07) | `on-failure` removed from `approval-policy` (#28418). | [SRC] |
| **0.149.0 (2026-08-20)** | Removed `untrusted` (#39630). Prints a deprecation warning to stderr (#39657). | [SRC][RUN] |
| **0.153.4 (2026-09-04)** | Last release that ships it. | [SRC][RUN] |
| **0.154.0 (2026-09-09)** | Subcommand, crate, tests and `codex_mcp_interface.md` deleted (#42993). Release note: "The deprecated `codex mcp-server` entry point is no longer available." | [SRC][DOC] |

## 3. Transport and handshake (0.153.4)

- **Transport:** stdio, newline-delimited JSON-RPC 2.0. Logs go to stderr.
  - The process exits when stdin reaches EOF (the reader, processor and writer tasks shut down in turn). [SRC `lib.rs`]
- **Startup:** it prints `warning: \`codex mcp-server\` is deprecated and will be removed in a future release.` to stderr (0.149.0 and later). [RUN]
- **Flags:** `codex mcp-server [--strict-config]`. Root `-c key=value` overrides are applied. [SRC `cli/src/main.rs`]
- **`initialize` response** [RUN]:
  ```json
  {"protocolVersion":"2025-06-18",
   "capabilities":{"tools":{"listChanged":true}},
   "serverInfo":{"name":"codex-mcp-server","title":"Codex","version":"0.153.4",
                 "user_agent":"codex_cli_rs/0.153.4 (Debian 12.0.0; x86_64) unknown (ocmcp-probe; 0.0.1)"}}
  ```
  - `protocolVersion` simply echoes whatever the client sent. The `user_agent` field is non-standard.
  - A second `initialize` gets the error `initialize called more than once`.
  - `listChanged:true` is advertised but never sent. [SRC]
- **Methods handled:**

  | Method | Behaviour |
  |---|---|
  | `ping` | `{}` [RUN] |
  | `tools/list` | See §4. |
  | `tools/call` | See §4 and §6. |
  | `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `prompts/list`, `prompts/get`, `logging/setLevel`, `completion/complete` | Logged and **never answered**. [SRC][RUN: `resources/list` and `prompts/list` got no reply within 3 s.] This is the root cause of #6664: Codex CLI hung when it used itself as an MCP server. |
  | `tasks/get`, `tasks/cancel`, custom and other methods | `-32601 method not found`. [SRC] |

- **Notifications handled:**
  - `notifications/cancelled`: see §7.
  - `notifications/progress`, `notifications/initialized` and `roots/list_changed`: logged only. [SRC]
- **Client capabilities are never checked.** `elicitation/create` is sent even when the client did not declare `capabilities.elicitation`. [RUN probe2]

## 4. Tool schemas

### 4.1 Final schema (0.153.4, `tools/list` as captured) [RUN][SRC `codex_tool_config.rs`]

`codex`: title "Codex", description "Run a Codex session. Accepts configuration parameters matching the Codex Config struct."

| Property (kebab-case) | Type | Required | Description (verbatim) / semantics |
|---|---|---|---|
| `prompt` | string | **yes** | "The *initial user prompt* to start the Codex conversation." |
| `model` | string | no | "Optional override for the model name (e.g. 'gpt-5.2', 'gpt-5.2-codex')." |
| `cwd` | string | no | "Working directory for the session. If relative, it is resolved against the server process's current working directory." |
| `approval-policy` | enum `on-request \| never` | no | "Approval policy for shell commands generated by the model: `on-request`, `never`." |
| `sandbox` | enum `read-only \| workspace-write \| danger-full-access` | no | "Sandbox mode: …" |
| `config` | object (`additionalProperties:true`) | no | "Individual config settings that will override what is in CODEX_HOME/config.toml." Keys are dotted config paths; values are converted from JSON to TOML and applied like CLI `-c` overrides. |
| `base-instructions` | string | no | "The set of instructions to use instead of the default ones." Replaces the system instructions. |
| `developer-instructions` | string | no | "Developer instructions that should be injected as a developer role message." |
| `compact-prompt` | string | no | "Prompt used when compacting the conversation." |

- **Schema-level:** `additionalProperties:false` (0.134.0 and later).
- **Defaults:** there are none in the schema. Every omitted field falls back to `CODEX_HOME/config.toml` (plus `-c` given at server launch), then to Codex built-in defaults. The server process's cwd is used when `cwd` is omitted. [SRC `into_config`, via `ConfigBuilder.cli_overrides(...).harness_overrides(...)`]

`codex-reply`: title "Codex Reply", description "Continue a Codex conversation by providing the thread id and prompt."

| Property | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | **yes** | "The *next user prompt* to continue the Codex conversation." |
| `threadId` | string (UUID) | effectively yes | "The thread id for this Codex session. This field is required, but we keep it optional here for backward compatibility for clients that still use conversationId." |
| `conversationId` | string | no | "DEPRECATED: use threadId instead." |

- The only schema-level `required` is `["prompt"]`. There is no `additionalProperties:false` on this tool.
- `threadId` wins if both are given.
- If neither is given, the call fails (see §6.2).
- No per-reply overrides are accepted: model, cwd, sandbox and so on are fixed per thread through this interface. [SRC]

Both tools declare `outputSchema: {type:object, properties:{threadId:string, content:string}, required:[threadId, content]}`.

### 4.2 Historical properties (for clients built against older builds) [SRC]

| Property | Lifetime | Notes |
|---|---|---|
| `profile` (string) | 0.x → 0.133 | "Configuration profile from config.toml to specify default options." Since 0.134.0 it is rejected with `unknown field \`profile\``. [RUN] |
| `include-plan-tool` (boolean) | 0.11 → 0.47 | "Whether to include the plan tool in the conversation." The plan tool is always on from 0.48. The official guide still listed it in July 2026, which is a stale doc. |
| `approval-policy` values | `untrusted \| on-failure \| never` (up to 0.20); plus `on-request` (0.21 to 0.142); `on-failure` gone in 0.143; `untrusted` gone in 0.149 | Passing `untrusted` to 0.153.4 fails with `unknown variant \`untrusted\`, expected \`on-request\` or \`never\``. [RUN] |
| `codex-reply` id field | `sessionId` (0.9 to 0.35) → `conversationId` (0.36 to 0.80, required) → `threadId` + deprecated `conversationId` (0.81 and later) | |

The widely copied "classic" schema, from the developers.openai.com guide (2025-10 to 2026-07), listed:

- `codex`: `prompt`\*, `approval-policy`, `base-instructions`, `config`, `cwd`, `include-plan-tool`, `model`, `profile`, `sandbox`
- `codex-reply`: `prompt`\*, `threadId`\*, `conversationId` (deprecated)

[DOC]

## 5. Output format

### 5.1 Success [RUN]

```json
{"jsonrpc":"2.0","id":13,"result":{
  "structuredContent":{"threadId":"01a0ebfc-05a9-74f1-b308-12883f212e49","content":"Hi from mock (turn 1)"},
  "content":[{"type":"text","text":"Hi from mock (turn 1)"}]}}
```

- The text is `TurnComplete.last_agent_message`: only the **final** agent message of the turn. It becomes `""` when there is none.
  - Tool outputs, diffs, reasoning and intermediate messages are **not** included. [SRC `codex_tool_runner.rs`]
- `isError` is omitted on success. The server strips rmcp's `resultType:"complete"` to keep the old wire shape. [SRC `outgoing_message.rs`]
- **Why `structuredContent` mirrors the text** (source comment): "Some MCP clients ignore `content` when `structuredContent` is present." The old guide said: "modern MCP clients generally report only structuredContent … the server also returns content for older clients." [DOC]
- Before 0.81 there was no `structuredContent`, and the thread id could only be read from the `session_configured` `codex/event` notification. MCP clients that drop custom notifications, such as Claude Code, could therefore never call `codex-reply` (#3712, #8388, #5660, #4651). [SRC][DOC]

### 5.2 Errors: always a tool result with `isError:true`, never a JSON-RPC error [SRC][RUN]

| Situation | Result |
|---|---|
| Unknown tool | `{"isError":true,"content":[{"type":"text","text":"Unknown tool 'nope'"}]}` |
| Bad args or schema violation | `Failed to parse configuration for Codex tool: missing field \`prompt\`` / `unknown field \`profile\`, expected one of …` |
| No arguments | `Missing arguments for codex tool-call; the \`prompt\` field is required.` |
| Config build failure | `Failed to load Codex configuration from overrides: …` |
| Thread start failure | `Failed to start Codex session: …` (no `structuredContent`) |
| `codex-reply` without an id | `Failed to parse thread_id: either threadId or conversationId must be provided` |
| Id is not a UUID | `Failed to parse thread_id: invalid character: …` |
| Unknown or unloaded thread | `isError:true`, text `Session not found for thread_id: <id>`, **plus** `structuredContent:{threadId, content}` |
| Turn not accepted | `Failed to submit initial prompt: …` / `Failed to submit user input: …` (with threadId) |
| `EventMsg::Error` during a turn (model or API failure) | `isError:true` + `structuredContent.threadId`, text = the error message. The thread stays usable with `codex-reply`. |
| Event stream failure | `Codex runtime error: …` (isError, with threadId) |

- Rows after "Bad args" in the table above are [SRC] only; rows before are [RUN] or both.
- Before 0.81, an `Error` event produced a non-conforming result `{"error": "<msg>"}`. [SRC `rust-v0.80.0`]
- Warnings, stream errors and similar events do **not** end the call. They are only forwarded as `codex/event`.

## 6. Streaming and progress

### 6.1 `codex/event` notification [SRC `outgoing_message.rs`][RUN]

Every Codex core `Event` is forwarded while a `codex` or `codex-reply` call is running. The event is flattened into `params` and a `_meta` object is added:

```json
{"jsonrpc":"2.0","method":"codex/event","params":{
  "_meta":{"requestId":13,"threadId":"01a0ebfc-05a9-…"},
  "id":"<turn id; empty string for session_configured>",
  "msg":{"type":"task_complete","turn_id":"…","last_agent_message":"Hi from mock (turn 1)",
         "started_at":1790665557,"completed_at":1790665557,"duration_ms":116,"time_to_first_token_ms":110}}}
```

- **Event order for one simple `codex` call** [RUN]:
  `session_configured` → `mcp_startup_complete` → `warning` → `task_started` → `raw_response_item`×3 → `item_started` / `item_completed` (UserMessage) → `user_message` → `item_started` / `item_completed` (AgentMessage) → `agent_message` → `raw_response_item` → `raw_response_completed` → `token_count` → `task_complete` → *then* the `tools/call` response.
  - `codex-reply` sends the same sequence without `session_configured` or `mcp_startup_complete`.
- **`session_configured.msg`** carries:
  - `session_id` and `thread_id` (identical)
  - `model`, `model_provider_id`, `approval_policy`, `approvals_reviewer`, `permission_profile`, `cwd`, `reasoning_effort`
  - `rollout_path` (for example `$CODEX_HOME/sessions/2026/09/29/rollout-…-<threadId>.jsonl`)
- **Other event types seen:** `exec_approval_request`, `exec_command_begin`, `exec_command_end`, `turn_aborted` (`reason:"interrupted"`). [RUN]
- **Event types the server special-cases** (all are still forwarded first):
  - Acted on: `ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `TurnComplete`, `Error`.
  - `PlanDelta` is not acted on.
  - `ElicitationRequest`, a nested MCP elicitation from an MCP tool Codex itself uses, is **dropped** (`TODO`).
  - Everything else passes through as-is. [SRC]
- On the wire the names are the legacy `task_started` and `task_complete`, although the Rust types are `TurnStarted` and `TurnComplete`. [RUN]
- Extension warnings (for example a skills context budget warning) are also sent as `codex/event` `warning` messages, routed by request id. [SRC `extension_event_sink.rs`]

### 6.2 What it does not do [SRC][RUN]

- No `notifications/progress`. `params._meta.progressToken` is ignored.
- No `notifications/message` logging.
- No MCP tasks support: `tasks/*` returns method not found.
- No partial results.
- Clients that drop unknown notifications see nothing until the call ends. Claude Code is one of them [INF, consistent with #8388].
- **Effect on Claude Code** [INF]: its stdio idle timeout is 30 min with "no response and no progress notification". It is unknown whether custom `codex/event` notifications reset that timer, so a very long Codex turn may be aborted under recent Claude Code.

## 7. Approvals (exec and patch) [SRC `exec_approval.rs`, `patch_approval.rs`][RUN]

**When an approval happens:** the thread's approval policy is `on-request` and the model asks for a command outside the sandbox (escalation) or an unapproved patch. The server then does two things:

1. Forwards the `exec_approval_request` / `apply_patch_approval_request` event as `codex/event`.
2. Sends a **server→client request** `elicitation/create`, with its own integer ids starting at 0.

**Exec approval request** [RUN]:

```json
{"jsonrpc":"2.0","id":0,"method":"elicitation/create","params":{
 "message":"Allow Codex to run `/bin/bash -lc 'touch f1_created.txt'` in `/tmp/work-4TY1c0`?",
 "requestedSchema":{"type":"object","properties":{}},
 "threadId":"01a0ebfc-06d0-…",
 "codex_elicitation":"exec-approval",
 "codex_mcp_tool_call_id":"16",
 "codex_event_id":"<turn id>",
 "codex_call_id":"call-f1",
 "codex_command":["/bin/bash","-lc","touch f1_created.txt"],
 "codex_cwd":"/tmp/work-4TY1c0",
 "codex_parsed_cmd":[{"type":"unknown","cmd":"touch f1_created.txt"}]}}
```

**Patch approval request:** the same envelope, with these fields:

- `message`: an optional reason line, then "Allow Codex to apply proposed code changes?"
- `codex_elicitation:"patch-approval"`
- optional `codex_reason`, optional `codex_grant_root`
- `codex_changes: {<path>: {"type":"add","content"} | {"type":"delete","content"} | {"type":"update","unified_diff","move_path"}}`

**Expected response:** `{"decision": ReviewDecision}`, where the enum is snake_case:

- `"approved"`
- `"approved_for_session"`
- `{"approved_execpolicy_amendment":{"proposed_execpolicy_amendment":[…]}}`
- `"approved_mcp_policy_amendment"`
- `{"network_policy_amendment":{…}}`
- `{"denied":{"rejection":"…"}}`
- `"timed_out"`
- `"abort"`

The event's `available_decisions` lists the allowed ones, for example `["approved", {approved_execpolicy_amendment…}, "abort"]`. [RUN]

A code comment admits this response "does not conform to ElicitResult. … It should have 'action' and 'content' fields." [SRC]

**Behaviour by reply:**

| Client reply | Exec approval | Patch approval | Evidence |
|---|---|---|---|
| `{"decision":"approved"}` | runs the command, turn continues | applies the patch | [RUN F2] file created |
| Spec-compliant `{"action":"accept","content":{}}` (what an MCP-compliant client such as Claude Code sends [INF]) | fails to deserialize; treated as **denied** ("approval request failed"). The turn continues and the model is told it was rejected. | same, denied | [RUN F1] file not created; stderr `failed to deserialize ExecApprovalResponse: missing field \`decision\`` |
| `{"decision":{"denied":{…}}}` / decline | denied, turn continues | denied | [SRC tests] |
| JSON-RPC **error** reply (for example a client without elicitation support) | only logged. The pending callback is never resolved, so the **turn and tool call hang forever** | same (the error is not routed to the callback) | [RUN F3] no response after 20 s; [SRC] `process_error` only logs |
| No reply | hangs indefinitely; **no timeout** anywhere | same | [SRC][RUN probe2] |

**Practical consequence:** through Claude Code the approval flow cannot grant anything [INF]. Every published integration therefore used `approval-policy: "never"` plus `sandbox: "workspace-write"`. The official Agents SDK guide says: "Always call codex with \"approval-policy\": \"never\" and \"sandbox\": \"workspace-write\"". [DOC]

**Doc inconsistency:** `codex_mcp_interface.md` describes `applyPatchApproval` / `execCommandApproval` requests with `{decision:"allow"|"deny"}` replies, plus app-server `thread/*` and `turn/*` RPCs. That describes the **app-server**, not this MCP server. The MCP server answers any custom method with `method not found` [SRC]. Treat that document as stale.

## 8. Sessions, cancellation and concurrency

### 8.1 Thread storage and end of session [SRC][RUN]

- One `ThreadManager` per server process. `codex` calls `start_thread(config)`; the thread lives **in memory until the process exits**.
  - The server never calls `remove_thread` or shuts a thread down.
  - There is no idle expiry, no end tool and no close tool.
- A rollout JSONL is written to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` (the `rollout_path` in `session_configured`).
- `codex-reply` looks the thread up **only in memory** (`get_thread`). After a server restart it returns "Session not found", even though the rollout is on disk.
  - Resume from a rollout was requested in #24833 and #6168. The PR (#10117) was closed.
- **"Ending the session" in practice** means one of:
  - stop calling `codex-reply` (resources held until the process exits);
  - kill or close stdin of the whole server;
  - archive or delete via the regular CLI (`codex archive` / `codex delete`).
- #28361: the server leaks child processes on Windows (and app-server on macOS), because threads and their MCP children are never reaped.

### 8.2 Cancellation (`notifications/cancelled`) [SRC][RUN]

- The server looks the request id up in `ActiveTurnRegistry`, sends `Op::Interrupt` to the thread, then unregisters the request.
- The core emits `turn_aborted {reason:"interrupted"}` (forwarded as `codex/event`). **No response is ever sent** for the cancelled request, which is compliant.
- **Verified bug:** the spawned loop for the cancelled request keeps reading that thread's single event queue.
  - When I then sent `codex-reply` (id 20) on the same thread, both loops consumed its events.
  - The orphaned loop took the `task_complete` event and answered **with id 19**, the cancelled request.
  - Request 20 **never got a response**. [RUN scenario G]
- The thread itself stays usable. [RUN]

### 8.3 Concurrency

- Incoming messages are handled one at a time, but each tool run is a `tokio::spawn`ed task.
- **Several concurrent `codex` calls on one connection work.** Each gets its own thread and events are tagged with `_meta.requestId` and `threadId` (verified: two parallel calls both returned). [RUN H]
- `codex-reply` against a thread whose turn is still running calls `start_or_steer_turn`.
  - This **steers the active turn** instead of queueing a new one.
  - Two runner loops then share one event stream, the same failure mode as §8.2. [SRC][INF]
- There is no per-thread lock, queue limit or cap on concurrent threads. [SRC]

## 9. What replaced it (current state, 2026-09-29)

### 9.1 Deprecation and removal

- **Local `codex-cli 0.156.1`:** `codex mcp-server` is parsed as an interactive prompt "mcp-server".
- **0.158.0** (npm `latest`; git also has tag 0.159.0): help lists `exec`, `mcp` (manage external servers), `app-server`, `exec-server`, `remote-control`, `agents`, with no `mcp-server`. `codex mcp-server` fails with `Error: stdin is not a terminal`. [RUN]
- **Why it was removed:** the maintainer comment on #29151 and #30566 (2026-08-26) says the mcp-server is deprecated in favour of "the app server interface", and bug fixes are no longer prioritised. The docs page says integrations must migrate before upgrading.
  - Removal commit #42993 message: "Remove the `codex mcp-server` subcommand and the standalone `codex-mcp-server` crate, including its tests, interface documentation, …". [DOC][SRC]

### 9.2 Recommended replacements [DOC]

**`codex app-server`** (learn.chatgpt.com/docs/app-server):

- JSON-RPC 2.0 without the `"jsonrpc"` field. Transports: stdio JSONL (default), `ws://` (experimental), `unix://`.
- Lifecycle:
  1. `initialize` / `initialized`
  2. `thread/start` / `thread/resume` / `thread/fork`
  3. `turn/start` and `turn/steer`
  4. streamed notifications: `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`
  5. `turn/interrupt`
- Thread management: `thread/unsubscribe` (the thread unloads after 30 min with no subscribers and no activity, then emits `thread/closed`), `thread/archive`, `thread/delete`, `thread/list`, `thread/read`, `thread/loaded/list`.
- Approvals are proper server requests:
  - `item/commandExecution/requestApproval` → `accept | acceptForSession | decline | cancel | {acceptWithExecpolicyAmendment}`
  - `item/fileChange/requestApproval`
  - followed by `serverRequest/resolved`
- Schemas can be generated with `codex app-server generate-json-schema` / `generate-ts`.
- It is "experimental and isn't supported for production workloads", and it is not MCP.

**Codex SDK / `codex exec`:** for CI and automation, including `codex exec resume <id>`. [DOC app-server page]

**Codex plugin for Claude Code** (github.com/openai/codex-plugin-cc, v1.0.6 2026-07-08, "wraps the Codex app server"):

- Slash commands: `/codex:rescue` (flags `--background`, `--wait`, `--resume`, `--fresh`, `--model`, `--effort`), `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:review`, `/codex:adversarial-review`, `/codex:transfer`.
- **Job model:** start, then check status, then fetch result, then cancel. It is not a blocking MCP tool.

### 9.3 Mapping of Codex MCP concepts to app-server (for reference)

| Codex MCP concept | app-server equivalent |
|---|---|
| `codex` | `thread/start` + `turn/start` + wait for `turn/completed` |
| `codex-reply` | `turn/start {threadId}` (or `thread/resume` first if the thread is unloaded) |
| cancel | `turn/interrupt` |
| (missing) end | `thread/unsubscribe` / `thread/archive` / `thread/delete` |
| `elicitation/create` | `item/*/requestApproval` |

## 10. Known limitations and user workarounds

- **Timeouts.** MCP clients' default request timeouts are far below Codex run times.
  - OpenAI Agents SDK `MCPServerStdio.client_session_timeout_seconds` defaults to **5 s** [SRC openai-agents-python main, v0.22.3]. The official guide sets `client_session_timeout_seconds=360000`. [DOC]
  - MCP Inspector: docs said to raise the Request and Total timeouts to 600000 ms. [DOC docs/advanced.md]
  - Codex itself as a client: `tool_timeout_sec` defaults to 300 s in 0.153.4 (`DEFAULT_TOOL_TIMEOUT`). Earlier versions used 60 s, which community wrappers cite. [SRC][DOC]
  - Claude Code [DOC code.claude.com/docs/en/mcp and env-vars]:
    - `MCP_TOOL_TIMEOUT` defaults to about 28 h, and a per-server `timeout` can be set in `.mcp.json`.
    - A **stdio idle timeout of 30 min** applies if there is "no response and no progress notification" (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, v2.1.203 and later).
    - Calls still running after 2 min are auto-backgrounded (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, v2.1.212 and later).
    - Output is capped at 25k tokens (`MAX_MCP_OUTPUT_TOKENS`).
  - Workarounds users adopted:
    - raise the client timeouts;
    - wrap `codex exec` in their own MCP server (for example tuannvm/codex-mcp-server);
    - build async job servers with start / status / result tools (for example wyrd-company/async-codex-mcp and thomaswitt/mcp-agents, which now drive `codex app-server`).
- **Missing thread id before 0.81.** `codex-reply` could not be used from Claude Code (#3712, #8388). The workaround was to parse `~/.codex/sessions/.../rollout-*-<id>.jsonl` filenames.
- **Approvals unusable from standard clients** (§7). Everyone ran with `approval-policy: never` and a sandbox.
- **No close, list, status or goal tools** (#29151, #30566, both closed won't-fix). No resume after restart (#24833).
- **Unanswered `resources/list` and `prompts/list`** hung Codex CLI when it used itself as an MCP server (#6664).
- **Process and child leaks** on long-lived servers (#28361).
- **Only the final message comes back.** Callers had to inspect the repo (git diff) themselves to see what changed.
- **Stale docs:** the guide listed `include-plan-tool` and `profile` long after they were removed. The multi-agent example used `args: ["mcp"]`. `codex_mcp_interface.md` described app-server RPCs. [DOC]

## 11. What this means for opencode-mcp (recommendations, not facts)

**Parity target.** Two tools with the same argument names, so existing prompts and agents keep working:

- `codex`-like start: `prompt`, optional `model`, `cwd`, `approval-policy`, `sandbox`, `config`, `base-instructions`, `developer-instructions`, `compact-prompt`.
- `reply`: `threadId` (accept `conversationId` as an alias), `prompt`.
- Same result shape: `content` text + `structuredContent {threadId, content}` + `outputSchema`, errors as `isError:true`.
- Stream progress as custom notifications with `_meta {requestId, threadId}`.
- Cancel on `notifications/cancelled`.

**The user's "end the session" requirement goes beyond Codex.** Add an explicit close tool, for example `opencode-end {threadId}`, that aborts any running turn and deletes or archives the OpenCode session.

**Fix the verified Codex defects rather than copying them:**

- Answer `resources/*` and `prompts/*`, or leave them undeclared and return method-not-found.
- Do not leave an orphan loop after cancel. Serialize or refuse `reply` while a turn is active.
- Put the thread/session id in the **text** content too.
- Honour `progressToken`, since Claude Code's 30-min idle timer counts progress notifications.
- Never hang on a failed or unsupported elicitation: use a timeout and deny by default.
- Use spec-compliant ElicitResult (`action` / `content`) if approvals are bridged.
- Add optional status and result tools for long jobs, the same pattern as codex-plugin-cc and async wrappers.
