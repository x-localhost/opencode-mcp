# opencode-mcp: MCP-side constraints (SDK, spec, Claude Code as client, prior art)

Research date: 2026-09-29. Scope: what a TypeScript/Node stdio MCP server needs so that enterprise Claude Code can hand work to an internal OpenCode, get the result back, continue the session and close it. This is the same job `codex mcp-server` did with its `codex` and `codex-reply` tools.

## Evidence labels

- **[V-run]** Verified by running it on gram, inside the throwaway container `ocmcp-research-mcpclient` (node:22). The container has since been removed.
  - Claude Code runs were real: the linux-x64 binary v2.1.284, headless `claude -p`, pointed at a local fake Anthropic Messages API. No real model and no credentials were used.
  - The fake API makes Claude Code emit a `tool_use` for the probe MCP server. It then records the `tool_result` that Claude Code sends back to the "model".
  - Scripts: `docs/research/probe-mcpclient/` (`fake-anthropic.mjs`, `cc-probe-server.mjs`, `cc-probe-v2.mjs`, `run-cc.sh`, `v1-*.mjs`, `v2-*.mjs`). Raw run logs and tool-result captures were not retained.
- **[V-src]** Verified from open-source package or repository contents (for example the `@modelcontextprotocol/*` SDK sources, `npm view`/`npm pack` output, `.d.ts`/`.d.mts` files, or the `openai/codex` source tree).
- **[V-doc]** Verified from official documentation at code.claude.com (local copies were not retained).
- **[I]** Inference, not directly verified.
- **[2nd]** Secondary source, such as a blog or a third-party issue.

---

## 0. TL;DR: constraints the design must respect

1. **Pick SDK v2 (split packages).** `@modelcontextprotocol/server@2.2.0` needs only 3 npm packages (server, core, zod@4), about 16 MB, and Node ≥20. v1 `@modelcontextprotocol/sdk@1.31.0` pulls 94 packages, about 29 MB, including express, hono and jose, even for stdio.
   - v2's `serveStdio(factory)` serves both protocol eras on one binary: the legacy 2025-11-25 `initialize` handshake and the 2026-07-28 stateless era. [V-run]
   - Pin exact versions in the internal registry. v2.0.0 shipped 2026-07-27 and 2.2.0 shipped yesterday, 2026-09-28.
2. **Claude Code talks to stdio servers on the legacy handshake by default.** Its client capabilities there are `{"elicitation":{"form":{}},"roots":{"listChanged":true}}`. [V-run]
   - With `MCP_PROTOCOL_NEGOTIATION=auto` it probes stdio servers and speaks 2026-07-28. It then declares `elicitation:{form,url}` in the per-request `_meta` envelope. [V-run]
3. **MCP Tasks are not usable with Claude Code 2.1.284.**
   - The `tasks` capability and the `io.modelcontextprotocol/tasks` extension are never advertised by Claude Code 2.1.284 in the requests it sends. [V-run]
   - The spec forbids returning a task handle to a client that did not declare the extension.
   - Long jobs must therefore be ordinary blocking `tools/call`s (plus optional start/poll tools).
4. **Claude Code always sends a `progressToken`** in `tools/call._meta`, together with `claudecode/toolUseId`. [V-run]
5. **Send `notifications/progress` heartbeats.** Without them a stdio call is aborted after 30 minutes of silence. The default idle timeout is 30 minutes for stdio and 5 minutes for HTTP, and it is checked every 30 s. [V-doc][V-run]
   - Progress resets the idle timer. It does not extend the hard wall-clock limit (`MCP_TOOL_TIMEOUT` or the per-server `timeout`; default ~27.8 h — see §3.3). [V-run: progress resets the idle timer]
6. **An idle-timeout abort does not send `notifications/cancelled` to the server.** [V-run] The server must enforce its own maximum run time and clean up orphaned OpenCode sessions.
   - A hard timeout does send `notifications/cancelled`, which fires the handler's AbortSignal. [V-run]
7. **Interactive Claude Code (v2.1.212+) moves a main-conversation MCP call to a background task after 120 s.** [V-doc]
   - The model is expected to receive an explanatory "moved to the background" message immediately. The real result arrives later as a task notification, and the model can stop the call with `TaskStop`. (the exact interactive flow was not exercised by a run — see §6)
   - This does not happen in subagents or in `-p` / SDK sessions (unless `CLAUDE_AUTO_BACKGROUND_TASKS=1`). So a synchronous `opencode` tool is acceptable, but explicit start/poll tools are still useful for subagents and headless use.
8. **If a result has `structuredContent`, the model sees only `JSON.stringify(structuredContent)`.** Text blocks are dropped. [V-run] Whether image and resource blocks are still kept alongside was not exercised by a run. [I]
   - Put the human-readable final answer inside `structuredContent` (as Codex did: `{threadId, content}`), or do not declare `outputSchema` at all.
   - Declaring `outputSchema` without returning `structuredContent` becomes an error result on the SDK server side. [V-run]
9. **Output size limits:**
   - A text result over **50,000 characters** is written to a file under `~/.claude/projects/.../tool-results/`, and the model gets only a 2 KB preview plus the path. [V-run: 60k chars → persisted]
   - A tool can raise its own threshold with `_meta["anthropic/maxResultSizeChars"]`, up to 500,000. [V-doc]
   - `MAX_MCP_OUTPUT_TOKENS` defaults to 25,000 tokens, with a warning at 10,000. [V-doc]
10. **Elicitation:**
    - Interactive Claude Code shows a dialog for form and URL requests. [V-doc]
    - Headless `claude -p` declares elicitation but auto-answers `{"action":"cancel"}`. [V-run, both legacy push and 2026 MRTR]
    - v2's `inputRequired(...)` (multi-round-trip requests, MRTR) works in both eras: the SDK translates it into a push `elicitation/create` on the legacy era. [V-run]
    - `ctx.mcpReq.elicitInput` throws on 2026-07-28 requests. [V-run]
11. **Environment handed to the stdio server:**
    - By default it inherits Claude Code's entire environment, including `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and proxy variables. Claude Code also adds `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE`, and sets cwd to the project directory. [V-run]
    - With `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` (documented: "spawn stdio MCP servers with only a safe baseline environment plus the server's configured `env`" [V-doc env-vars]) the server gets only `HOME`, `PATH`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` plus its configured `env`. Proxy and `NODE_EXTRA_CA_CERTS` variables must then be set explicitly. [V-run]
    - The server should scrub `ANTHROPIC_*` before it spawns `opencode`.
12. **Shutdown:** when Claude Code exits, it sends **SIGINT** to the stdio server. [V-run: every `-p` run logged `signal SIGINT`] The server must trap SIGINT, SIGTERM and stdin EOF, then abort or delete the OpenCode sessions and child processes it owns (the "end the session" requirement).
13. **Enterprise registration:**
    - `managed-mcp.json` gives exclusive control and supports stdio. Paths: `/etc/claude-code/managed-mcp.json` (Linux/WSL), `/Library/Application Support/ClaudeCode/managed-mcp.json` (macOS), `C:\Program Files\ClaudeCode\managed-mcp.json` (Windows).
    - Alternatively, use `allowedMcpServers:[{serverCommand:[...exact argv...]}]` together with `allowManagedMcpServersOnly:true`.
    - `managedMcpServers` in managed settings accepts **only http/sse**. [V-doc]
14. **Codex parity target is now historical.** OpenAI removed `codex mcp-server` in Codex rust-v0.154.0 (2026-09-09, PR #42993). The official replacement for Claude Code is the app-server-based `codex-plugin-cc`. [V-src GitHub API / release notes] The last source (commit `942af8447b`) still documents the exact tool surface to mirror (§4.1).

---

## 1. MCP TypeScript SDK (npm, checked 2026-09-29)

### 1.1 Versions and packages [V-src: `npm view` inside the container]

| Package | Latest | Published | Runtime deps | engines |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` (v1, monolithic) | **1.31.0** | 2026-09-28 | ajv, zod `^3.25 \|\| ^4.0` (also a required peer), express 5, hono, @hono/node-server, cors, jose, eventsource, cross-spawn, pkce-challenge, zod-to-json-schema … | node ≥18 |
| `@modelcontextprotocol/server` (v2) | **2.2.0** | 2026-09-28 (2.0.0 on 2026-07-27) | `@modelcontextprotocol/core@2.2.0`, zod `^4.2.0` | node ≥20 |
| `@modelcontextprotocol/client` (v2) | 2.2.0 | 2026-09-28 | core, zod, jose, cross-spawn, eventsource… | node ≥20 |
| `@modelcontextprotocol/core` (v2) | 2.2.0 | 2026-09-28 | zod ^4.2.0; exports only the Zod `*Schema` constants | node ≥20 |
| `@modelcontextprotocol/node` / `express` / `hono` / `fastify` | 2.1.0 / 2.0.1 / … | — | HTTP adapters, not needed for stdio | — |
| `@modelcontextprotocol/ext-tasks` | 0.1.0 | 2026-09-17 | **Client-side** Tasks requester plus a 2025-11-25 receiver for sampling/elicitation. No server helper for tool tasks. | peer client ^2 |

- Install footprint [V-run]:
  - `npm i @modelcontextprotocol/server@2.2.0 zod@4` → 3 packages, 16 MB.
  - `npm i @modelcontextprotocol/sdk@1.31.0 zod@4` → 94 packages, 29 MB.
  - The current zod is 4.6.5.
  - The v2 set is much easier to mirror through a Nexus or Artifactory proxy.
- What the protocol constants say [V-src]:
  - v1: `LATEST_PROTOCOL_VERSION='2025-11-25'`, `SUPPORTED_PROTOCOL_VERSIONS=[2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]`.
  - v2 core keeps the same legacy list and adds `MODERN_PROTOCOL_VERSION='2026-07-28'`.
  - v2 README: "v2 is the stable release line, implementing the 2026-07-28 MCP spec".
- The v2 README warns that TypeScript ≥6 no longer auto-includes `@types/*`, so add `"types":["node"]` to tsconfig.
- The v2 packages ship both ESM and CJS.

### 1.2 Recommended server API

**v2** (the `McpServer.registerTool(name, config, cb)` config shape is taken from `createMcpHandler-*.d.mts`) [V-src][V-run]:

```ts
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';                      // zod >= 4.2 (Standard Schema + JSON Schema)

serveStdio(() => {                             // factory: one instance pinned per connection/era
  const server = new McpServer({ name: 'opencode-mcp', version: '0.1.0' },
                               { instructions: '...', capabilities: {} });
  server.registerTool('opencode', {
    title: 'OpenCode', description: '...',
    inputSchema:  z.object({ prompt: z.string(), cwd: z.string().optional() }),
    outputSchema: z.object({ sessionId: z.string(), status: z.string(), content: z.string() }),
    annotations: { destructiveHint: true, openWorldHint: true },
    _meta: { 'anthropic/maxResultSizeChars': 200000 },       // Claude Code specific, optional
  }, async (args, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;            // progress token
    ctx.mcpReq.signal;                                        // AbortSignal (cancellation)
    await ctx.mcpReq.notify({ method: 'notifications/progress',
      params: { progressToken: token, progress: n, message: 'OpenCode: running tests' } });
    return { content: [{ type: 'text', text }], structuredContent: { sessionId, status, content: text } };
  });
  return server;
});
```

- Handler context in v2 is `ServerContext`:
  - `ctx.mcpReq` holds `id`, `method`, `_meta`, `envelope` (2026 `_meta` keys), `inputResponses`, `requestState()`, `signal`, `send()` and `notify()`.
  - It also has `log()` (deprecated) and `elicitInput()` / `requestSampling()` (legacy era only).
  - `ctx.http?.authInfo` is set only for HTTP transports. [V-src]
- `registerTool` takes Standard-Schema objects (`z.object(...)`). The raw-shape form `{a: z.string()}` still works but is `@deprecated` in v2.
  - `fromJsonSchema(jsonSchema)` accepts a hand-written JSON Schema instead. [V-src]
- v2 emits JSON Schema **2020-12** in `tools/list` (`"$schema":"https://json-schema.org/draft/2020-12/schema"`). v1 emits draft-07. [V-run]
- **v1 equivalent** [V-src][V-run]:
  - `new McpServer(info, { capabilities: { logging: {} } })`.
  - `server.registerTool(name, { title, description, inputSchema: rawShapeOrZod, outputSchema, annotations, _meta }, async (args, extra) => …)`.
  - `extra` holds `{ signal, requestId, _meta, sendNotification, sendRequest, sessionId, authInfo, taskId?, taskStore? }`.
  - Transport: `server.connect(new StdioServerTransport())` from `@modelcontextprotocol/sdk/server/stdio.js`.
  - The older `server.tool(...)` is deprecated in favour of `registerTool`.

### 1.3 zod

- v1.31 declares zod `^3.25 || ^4.0` as a required peer and imports `zod/v4` internally. Application code can use `zod/v3` or `zod/v4`. [V-src README/package.json]
- v2 has zod `^4.2.0` as a regular dependency and exposes a zod-free public surface based on Standard Schema. Use zod ≥4.2 for `z.object` → JSON Schema conversion. [V-src]

### 1.4 stdio transport

- v2 `serveStdio(factory, { legacy: 'serve' | 'reject' })` decides the era from the opening message:
  - An `initialize` request → pinned legacy 2025 instance.
  - A `server/discover` or `_meta`-enveloped request → modern era.
  - [V-src d.ts][V-run with a v1 client, a v2 legacy client and a v2 auto client]
- `StdioServerTransport` has a default `maxBufferSize` of 10 MB. On stdin EOF it closes, and "requests still in flight when stdin ends are aborted and not answered". [V-src]
- Never write to stdout except protocol frames. Log to stderr; Claude Code captures stderr into its MCP logs [I].

### 1.5 Progress from inside a tool handler [V-run]

- v1: `await extra.sendNotification({ method:'notifications/progress', params:{ progressToken, progress, total?, message? } })`.
- v2: `await ctx.mcpReq.notify({...same...})`.
- The SDK client uses the JSON-RPC request id as the progress token (observed `progressToken=2` for request id 2).
- Claude Code also uses the SDK client (observed `progressToken=2`, `_meta:{"progressToken":2,"claudecode/toolUseId":"toolu_…"}`).
- `progress` must increase monotonically. `total` is optional. `message` is expected to be surfaced to the user by Claude Code's UI. (unverified by a run; not independently confirmed here)

### 1.6 Logging notifications

- v1: `server.sendLoggingMessage({level, data, logger})`. It requires `capabilities.logging` and respects `logging/setLevel`. The v1 probe client received 3 `notifications/message` in the run. [V-run]
- v2: `ctx.mcpReq.log(level, data)` is `@deprecated` (SEP-2577).
  - In 2026-07-28 the server "MUST NOT emit `notifications/message` for requests that did not include" `io.modelcontextprotocol/logLevel`. [V-doc spec changelog]
- **Recommendation:** log to stderr or a file, and use progress `message` for user-visible status. [I]

### 1.7 Cancellation [V-run]

- Both SDK generations abort the handler's `AbortSignal` (`extra.signal` / `ctx.mcpReq.signal`) when `notifications/cancelled` arrives. In the probe the loop stopped at step 5 of 20, with `cancelled:true`.
- A client-side request timeout in the SDK also sends `notifications/cancelled`. The server saw an abort with reason `SdkError: Request timed out`.
- Under 2026-07-28, cancellation on stdio is still `notifications/cancelled`. On Streamable HTTP, closing the SSE response stream is the cancel signal. [V-doc]

### 1.8 Elicitation from the server

**Legacy era, push style**:
- v1: `server.server.elicitInput({ mode?: 'form', message, requestedSchema })`. v2: `ctx.mcpReq.elicitInput(...)`. Both return `{action:'accept'|'decline'|'cancel', content?}`. [V-run]
- URL mode also exists (`mode:'url'`, plus `createElicitationCompletionNotifier` on 2025-11-25). [V-src]

**2026-07-28 era, MRTR**:
- The handler returns `inputRequired({ inputRequests: { key: inputRequired.elicit({...}) }, requestState })`.
- The client fulfils the requests and retries the original `tools/call`. On re-entry the handler reads `ctx.mcpReq.inputResponses.key` and `ctx.mcpReq.requestState()`.
- `inputRequired.elicitUrl()`, `.createMessage()` and `.listRoots()` exist too. [V-src]
- `requestState` comes back from the client and must be HMAC- or AEAD-protected if it influences authorization or logic. The SDK offers `createRequestStateCodec`. [V-src]
- **Verified:** with v2 `serveStdio`, returning `inputRequired` works for a legacy client too. The SDK shim sends a push `elicitation/create` and re-invokes the handler with `inputResponses` and `requestState`.
  - Tested against v1 and v2 SDK clients, and against Claude Code 2.1.284 in both default and `MCP_PROTOCOL_NEGOTIATION=auto` modes. [V-run]
  - The handler must therefore be **re-entrant**. Keep the OpenCode job keyed by `requestState` and do not restart work on retry. [I]
- `ctx.mcpReq.elicitInput` on a 2026-07-28 request throws: "Server-to-client requests are not available on protocol revision 2026-07-28 … Return inputRequired(...)". [V-run]

**Detecting client support**:
- v1 or v2 legacy: `server.server.getClientCapabilities()?.elicitation`. An empty `{}` means form mode for backward compatibility; `url` must be declared explicitly. v2 client exports `getSupportedElicitationModes()`.
- v2 modern: `ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities'].elicitation`.
- The SDK raises `MissingRequiredClientCapabilityError` (-32021 in 2026-07-28) when a capability is missing. [V-src]
- **Caveat:** Claude Code declares elicitation even in headless `-p` mode, where every elicitation is auto-answered `{"action":"cancel"}`. [V-run] Treat `cancel` as "no human available" and fall back to a policy such as deny, then report the pending permission in the tool result.

### 1.9 outputSchema and structuredContent enforcement [V-run]

- The v1.31 server returns `isError:true` with the message "MCP error -32602: Output validation error: Tool X has an output schema but no structured content was provided" when `outputSchema` is declared and `structuredContent` is missing.
- The spec (2025-06-18+) requires `structuredContent` when `outputSchema` is present.
- 2026-07-28 loosened `structuredContent` to allow any JSON value and allows any JSON Schema 2020-12 keywords (SEP-2106). [V-doc]

### 1.10 Tasks in the SDK

- v1.31 has `server.experimental.tasks.registerToolTask(...)` (2025-11-25 experimental tasks, with a `taskStore` in `extra`). [V-src]
- The v2 server has no tasks-extension helper. The extension's client side is `@modelcontextprotocol/ext-tasks@0.1.0`. [V-src]
- `opencode-mcp@3.0.0` (prior art, §4.2) hand-rolls the tasks extension on the wire in `dist/task-transport.js`. [V-src]
- None of this matters for Claude Code 2.1.284 (§3.2).

---

## 2. MCP specification: latest revision and long-running features

**Latest revision: 2026-07-28** (final, published 2026-07-28). The previous one is 2025-11-25. [V-doc https://modelcontextprotocol.io/specification/2026-07-28/changelog, blog https://blog.modelcontextprotocol.io/posts/2026-07-28/]

### 2.1 2026-07-28 changes that affect opencode-mcp [V-doc changelog]

- **Stateless core.**
  - No `initialize` handshake and no `Mcp-Session-Id`.
  - Every request carries `_meta` keys `io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities` and `…/clientInfo`.
  - `server/discover` is mandatory for servers.
  - Cross-call state uses server-minted handles passed as ordinary tool arguments (SEP-2567, SEP-2575). An OpenCode `sessionId` argument is exactly this pattern.
- **MRTR (SEP-2322)** replaces server-initiated `elicitation/create`, `sampling/createMessage` and `roots/list`.
  - Results carry `resultType: "complete" | "input_required"`.
  - `notifications/elicitation/complete` and URL-mode `elicitationId` are removed.
- **Tasks moved out of core** into the official extension `io.modelcontextprotocol/tasks` (SEP-2663).
  - Polling uses `tasks/get` plus a new `tasks/update` for input. `tasks/result` and `tasks/list` are removed.
  - Servers may return task handles without per-request opt-in, but only to clients that declared the extension on that request.
  - "A server MUST NOT return CreateTaskResult to a client that did not include the extension capability on its request." [V-doc ext-tasks spec]
- **Deprecated:** Roots, Sampling and Logging (SEP-2577). Log to stderr or use OpenTelemetry instead. `ping` and `logging/setLevel` are removed.
- **Error codes renumbered:** `MissingRequiredClientCapability` -32021, `UnsupportedProtocolVersion` -32022, `HeaderMismatch` -32020.
- **Other:** `tools/list` SHOULD have a deterministic order and carries `ttlMs` and `cacheScope`. SSE resumability is removed on HTTP, so a broken stream loses the in-flight request.

### 2.2 Progress (unchanged in substance) [V-doc …/2026-07-28/basic/utilities/progress]

- The token comes from the request's `_meta.progressToken`.
- `progress` MUST increase; `total` and `message` are optional.
- Notifications may only reference active requests and MUST stop after completion. Both sides SHOULD rate-limit.
- Request-scoped notifications flow on the request's response stream, not on `subscriptions/listen`.

### 2.3 Cancellation [V-doc …/2026-07-28/basic/utilities/cancellation]

- stdio: the client MUST send `notifications/cancelled {requestId, reason}`. The server SHOULD stop, free resources and not respond. Races must be tolerated.
- Timeouts: senders SHOULD enforce them. Implementations MAY reset the clock on progress but SHOULD always enforce a maximum. Claude Code behaves exactly this way (§3.3).

### 2.4 Tasks

- **2025-11-25 (experimental)** [V-doc …/2025-11-25/basic/utilities/tasks]:
  - Capability `tasks.requests.tools.call` and per-tool `execution.taskSupport: forbidden | optional | required`.
  - The client augments `tools/call` with `params.task {ttl}`. The server returns `CreateTaskResult {task:{taskId,status,pollInterval,ttl,createdAt,lastUpdatedAt}}`.
  - Methods: `tasks/get`, blocking `tasks/result`, `tasks/list`, `tasks/cancel`. Notification: `notifications/tasks/status`.
  - Statuses: `working`, `input_required`, `completed`, `failed`, `cancelled`.
  - The `_meta` key `io.modelcontextprotocol/model-immediate-response` lets a host return control to the model.
- **2026-07-28 extension (SEP-2663)** [V-doc]:
  - A `resultType:"task"` handle with `taskId`, `status`, `pollIntervalMs` and `ttlMs`.
  - `tasks/get` returns the final `result` or `error` embedded. `tasks/update` delivers `inputResponses`. `tasks/cancel` is cooperative.
- **Claude Code does not support either form today** (§3.2).
  - GitHub issues #18617 and #52137 were closed "not planned". #76571 (2026-07-11) was closed as a duplicate. [V-doc github.com/anthropics/claude-code/issues/76571]

---

## 3. Claude Code as the MCP client (latest 2.1.284, 2026-09-28; `stable` tag = 2.1.277)

Versions come from `npm view @anthropic-ai/claude-code dist-tags`: `latest` 2.1.284, `stable` 2.1.277. The npm package is now a thin wrapper around native per-platform binaries (`@anthropic-ai/claude-code-linux-x64` and others), so an air-gapped install needs the platform package mirrored too. [V-src]

### 3.1 Client runtimes and protocol era

- Claude Code has two runtimes: v1 (built on TS SDK 1.x) and v2 (built on TS SDK 2.0).
  - v2 is the default on 2.1.232+ when flags are fetched.
  - It is also the default on 2.1.274+ when flags are not fetched: Bedrock, Vertex/Agent Platform, Foundry, a Claude apps gateway, or `DISABLE_TELEMETRY`.
  - Pin with `MCP_SDK_GENERATION=v1|v2`. [V-doc mcp.md "MCP client runtimes"]
- **stdio servers are not probed by default.** They connect on the legacy `initialize` handshake. `MCP_PROTOCOL_NEGOTIATION=auto` also probes stdio servers; `legacy` disables all probing. [V-doc env-vars][V-run: the default run logged `legacy initialized`; with `auto` the requests carried the 2026-07-28 envelope]

### 3.2 Capabilities Claude Code advertises [V-run]

- **Legacy (default, stdio):** `{"elicitation":{"form":{}},"roots":{"listChanged":true}}`.
  - URL mode is not present on legacy by default — the observed capabilities show only `elicitation:{form:{}}`. [V-run]
- **2026-07-28 (`auto`):** envelope `clientCapabilities = {"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}`.
  - `clientInfo = {name:"claude-code", title:"Claude Code", version:"2.1.284", …}`.
- **No `tasks` capability and no `extensions["io.modelcontextprotocol/tasks"]`** in either capability set observed above. [V-run]
  - Consequence: **do not return task handles.** Use normal `CallToolResult`s.

### 3.3 Timeouts [V-doc mcp.md, env-vars.md][V-run]

| Knob | Default | Semantics |
|---|---|---|
| `MCP_TIMEOUT` | 30,000 ms | Server startup/connect timeout. |
| `MCP_TOOL_TIMEOUT` | **100,000,000 ms (~27.8 h)** | Hard wall-clock limit per tool call: the per-server `timeout` overrides it when set, otherwise `MCP_TOOL_TIMEOUT`, otherwise the ~27.8 h default. Not extended by progress. [V-run: `MCP_TOOL_TIMEOUT=3000` with progress every 500 ms → "timed out after 3s", and the server received cancel] |
| per-server `"timeout"` (in `.mcp.json` or `~/.claude.json`) | — | Overrides `MCP_TOOL_TIMEOUT` for that server. |
| `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | **1,800,000 ms stdio** (verified); 300,000 ms for network servers [V-doc env-vars] | Aborts when there is "no response or progress notification" for this long. A watchdog checks every **30 s**, so granularity is 30 s. `0` disables it. Paused while an elicitation dialog is open. [V-run: idle=5000 with no progress → aborted at ~30 s; idle=5000 with progress every 2 s → completed at 40 s] |
| HTTP per-request timer | 60 s | For HTTP/SSE/connector servers only; raised by setting `MCP_TOOL_TIMEOUT` or the per-server `timeout` above 60000. **stdio has no per-request timer.** [V-doc] |
| `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | 120,000 ms | See §3.4. |

- **Verified caveat:** an idle-timeout abort ends the call on the client side, but **no `notifications/cancelled` reaches the server** (run `t2b`).
  - The server logged no abort and was only killed by SIGINT when `claude -p` exited.
  - In an interactive session the OpenCode job would keep running unobserved. [V-run + I]
- The error text shown to the model on an idle abort reads: `MCP server "probe" tool "work" sent no response or progress for 30s; aborting. If this server is configured in your MCP settings, set a per-server "timeout" …`. [V-run]

### 3.4 Automatic backgrounding of long calls (v2.1.212+) [V-doc]

- Main-conversation calls still running after 120 s become a background task.
- The model is expected to receive an explanatory message when this happens, including a task id and instructions to stop the call with `TaskStop`; the real result later arrives as a task notification. (unverified by a run; not exercised interactively — see §6)
- The call is still bound by the wall-clock and idle timeouts, so heartbeats remain necessary.
- It is **not** applied to:
  - subagent calls,
  - IDE servers,
  - non-interactive `-p` runs (unless `CLAUDE_AUTO_BACKGROUND_TASKS=1`),
  - calls with an open elicitation dialog,
  - sessions with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- `TaskStop` or Esc is expected to cancel the call (not exercised). When a client sends `notifications/cancelled`, the SDK aborts the handler's signal. [V-run]

### 3.5 Result size limits [V-doc][V-run]

- `MAX_MCP_OUTPUT_TOKENS`: default **25,000** tokens, with a warning at 10,000. [V-doc]
  - Over the limit, the result is saved to a file or truncated; the exact token-counting and truncation behaviour was not exercised by a run. [I]
- Separate **persist-to-disk threshold of 50,000 characters** for tool results.
  - Beyond it the model sees `<persisted-output> Output too large (58.6KB). Full output saved to: ~/.claude/projects/<proj>/<session>/tool-results/<toolu>.json  Preview (first 2KB): …`. [V-run with a 60,000-char text result]
- `_meta["anthropic/maxResultSizeChars"]` on the tool definition raises that threshold, with a hard ceiling of 500,000. Image results remain bound by `MAX_MCP_OUTPUT_TOKENS`.
- **Implication:** return a concise final answer (well under 50 k chars). Expose diffs and full logs through separate paginated calls, or as files or resource links.

### 3.6 How results reach the model [V-run t1]

- **`structuredContent` present** → the model receives `JSON.stringify(structuredContent)` only.
  - Probe: the server returned text `"TEXT-BLOCK: status=done…"` plus `structuredContent {status,…}`. The `tool_result` sent to the API was `"{\"status\":\"done\",\"elapsed_ms\":1507,…}"`, and the text block was gone.
  - Whether non-text blocks (image, resource) are still kept alongside was not exercised by a run. [I]
- **Only `content`:**
  - Text blocks pass through. [V-run]
  - How images, `resource`, `resource_link`, audio and binary blocks are rendered to the model was not exercised by a run; none of the published probes return those content types. [I]
- `outputSchema` is not sent to the model. Only `name`, `description` and `input_schema` appear in the API `tools` array. [V-run: `tools-002.json`, raw capture not published]
- `isError:true` becomes `tool_result.is_error:true`.
- Errors thrown by the SDK, such as timeouts, are also delivered as `is_error` text. [V-run]

### 3.7 Elicitation in Claude Code [V-doc][V-run]

- **Interactive:**
  - Form mode shows a dialog with fields.
  - URL mode asks whether to open the browser.
  - No configuration is needed.
- **Hooks:** the `Elicitation` hook can auto-respond without a dialog, and `ElicitationResult` can observe, modify or block the response. [V-doc hooks.md]
- **Headless `-p`:** auto-answers `{"action":"cancel"}` immediately. [V-run: legacy push (`t6`) and MRTR on both eras (`u3`, `u4`)]
- The idle watchdog is paused while an elicitation is pending, and the call is not auto-backgrounded while a dialog is open. [V-doc]

### 3.8 Registering the stdio server

**CLI** [V-run on 2.1.284]:

```bash
claude mcp add --env OPENCODE_URL=http://127.0.0.1:4096 --transport stdio opencode \
  -- node /opt/opencode-mcp/dist/index.js
```

- Put another option between `--env` and the server name. `--transport stdio --env K=V opencode …` fails with `Invalid environment variable format: probe …`, a documented gotcha that the run reproduced.
- Scopes:
  - `local` is the default, stored in `~/.claude.json` under the project path.
  - `--scope project` writes `.mcp.json` in the repo; those servers show "Pending approval" until approved interactively.
  - `--scope user` stores the server in `~/.claude.json` for all projects.
- Also available: `claude mcp add-json <name> '{"type":"stdio","command":…,"args":[…],"env":{…},"timeout":…}'`, and `claude mcp list|get|remove`.
- Server entry fields: `type: "stdio"`, `command`, `args`, `env`, `timeout` (ms), `alwaysLoad`.

**`.mcp.json` variable expansion:**
- `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url` and `headers`.
- `CLAUDE_PROJECT_DIR` is only available inside the spawned server's environment. To use it in `.mcp.json` args, write `${CLAUDE_PROJECT_DIR:-.}`. [V-doc]

**Enterprise** [V-doc managed-mcp.md]:
- **`managed-mcp.json`** (exclusive control) has the same format as `.mcp.json` and may contain **stdio** entries.
  - Linux/WSL: `/etc/claude-code/managed-mcp.json`. macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`. Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`.
  - Users cannot add other servers, and `--mcp-config` then exits with an error on workstations.
  - Do not put secrets in its `env` (it is world-readable). Use `${VAR}` expansion instead.
- **`managedMcpServers`** (managed settings; v2.1.259+) takes only **http/sse** `https://` entries, with no `command`, `env` or `${VAR}`. It cannot deliver a stdio opencode-mcp.
- **Policy allowlist:** `allowedMcpServers: [{ "serverCommand": ["node","/opt/opencode-mcp/dist/index.js"] }]` plus `allowManagedMcpServersOnly: true`.
  - Commands must match the **exact argv**, and `serverName` entries are not a security control.
  - `deniedMcpServers` always applies.
- Other routes: distribute as a plugin through a managed marketplace, or lock things down with `strictPluginOnlyCustomization`.

**Permissions:**
- Allow rules take the forms `mcp__opencode`, `mcp__opencode__*` and `mcp__opencode__opencode_reply`.
- `_meta["anthropic/requiresUserInteraction"]: true` on a tool forces a prompt on every call, even in bypass or auto modes, and results in a deny in `dontAsk` or `-p` mode (v2.1.199+). [V-doc]

### 3.9 Environment and working directory of the spawned server [V-run t8/t9]

- **Default:** full inheritance of Claude Code's environment, including the name `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and any proxy variables.
  - Claude Code adds `CLAUDE_PROJECT_DIR=<project root>`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN` and `AI_AGENT`.
  - `cwd` is the project root.
- **With `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`:** only `HOME`, `PATH`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` and the configured `env` reach the server.
  - In a corporate network, `HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` and the OpenCode URL/credentials must then go in `env`.
- Claude Code answers `roots/list` with the launch directory plus `--add-dir` directories and sends `roots/list_changed`. Roots are deprecated in 2026-07-28, so prefer a `cwd` argument that defaults to `CLAUDE_PROJECT_DIR`. [V-doc]

### 3.10 Process lifecycle [V-run]

- In every `-p` run the server logged `signal SIGINT` right after Claude Code finished. No stdin-EOF was logged first.
- opencode-mcp should install SIGINT, SIGTERM and SIGHUP handlers and also watch stdin EOF. On shutdown it should abort or delete the OpenCode sessions it created and stop any `opencode serve` it spawned.
- Interactive `/mcp` reconnects and disconnects presumably behave the same way. [I]

### 3.11 Naming, descriptions, tool search

- The callable name is `mcp__<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` in the server and tool segments are replaced with `_`. [V-doc]
  - Plugin-bundled servers become `mcp__plugin_<plugin>_<server>__<tool>`.
  - The Anthropic API limits tool names to 64 characters, so keep `mcp__opencode__opencode_reply`-style names short. [I]
- Each tool description and the server `instructions` are truncated at **2,048 characters** (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`). [V-doc]
- **Tool search:**
  - It defers MCP tool definitions by default, loading only names and server instructions.
  - It is **disabled when `ANTHROPIC_BASE_URL` points to a non-first-party host**, which is likely for an enterprise LLM gateway. All tools then load upfront, which argues for a small tool count. [V-doc]
  - `_meta["anthropic/alwaysLoad"]: true` or server `alwaysLoad` forces a tool to load upfront.
- **Input schema rules:**
  - Top-level property names must be 1–64 characters of `[A-Za-z0-9_.-]`.
  - Schemas with no `$schema` or with 2020-12 are validated against the 2020-12 meta-schema. v2 emits 2020-12 and v1 emits draft-07, which skips the check.
  - Root-level `anyOf`/`oneOf`/`allOf` are flattened.
  - [V-doc mcp.md "Tools with invalid input schemas"]

---

## 4. Prior art

### 4.1 OpenAI Codex `codex mcp-server`, the parity reference [V-src]

Source is commit `942af8447b` of `openai/codex`, `codex-rs/mcp-server/src/{codex_tool_config.rs,codex_tool_runner.rs,exec_approval.rs}`. The command was removed by PR #42993 (merged 2026-09-05). The rust-v0.154.0 release notes (2026-09-09) say: "The deprecated `codex mcp-server` entry point is no longer available." The deprecation itself reportedly came in 0.149.1 [2nd: codex.danielvaughan.com].

OpenAI's page https://learn.chatgpt.com/docs/mcp-server now says to use the Codex **app server**, which "is not an MCP server". The Claude Code integration moved to the plugin `openai/codex-plugin-cc`.

- **Tool `codex`** (title "Codex"). Input:
  - `prompt` (required),
  - `model`,
  - `cwd`,
  - `approval-policy` (`on-request` | `never`),
  - `sandbox` (`read-only` | `workspace-write` | `danger-full-access`),
  - `config` (a map overriding `config.toml`),
  - `base-instructions`, `developer-instructions`, `compact-prompt`.
- **Tool `codex-reply`**. Input: `threadId` (plus the deprecated `conversationId`) and `prompt`.
- **Output of both:** `outputSchema {threadId: string, content: string}`. Results carry `content:[text]` **and** `structuredContent:{threadId, content}`.
  - The source comment explains why: "Some MCP clients ignore `content` when `structuredContent` is present, so mirror the text there as well". Claude Code is one of them (§3.6).
  - Errors are returned as `isError:true` with the `threadId`, so the conversation can resume.
- **Behaviour:**
  - Calls block until the turn completes.
  - Every internal event streams as a **non-standard** notification `codex/event` with `_meta {requestId, threadId}`. Claude Code ignores it; it is not a progress notification.
  - `ExecApprovalRequest` and `ApplyPatchApprovalRequest` are forwarded to the client as **`elicitation/create`** with a custom `codex_elicitation: "exec-approval"` field.
  - Model-originated elicitations were not forwarded (a TODO in the source).
  - There was no explicit "end session" tool; sessions lived in-process.

### 4.2 Existing OpenCode MCP bridges (GitHub/npm, checked 2026-09-29)

OpenCode itself: npm `opencode-ai` latest **1.18.33**. The repo now lives at `anomalyco/opencode` (per npm repository links).

| Project (stars, last push) | Approach | Tool surface | Strengths | Weaknesses / notes |
|---|---|---|---|---|
| **AlaeddineMessadi/opencode-mcp** (npm `opencode-mcp@3.0.0`, 2026-09-16; 139★) [V-src package] | HTTP client of `opencode serve` via `@opencode-ai/sdk ^1.18.31`; MCP SDK **v2** split packages; Node ≥22; optional `OPENCODE_AUTO_SERVE` | ~90 tools, including `opencode_ask`/`reply` (sync), `opencode_run` (sync with job id; `maxDurationSeconds`, default 600), `opencode_fire` + `opencode_check`/`opencode_wait` (async), `opencode_job_list/get/cancel/input`, permission/question tools, session CRUD/abort/diff/revert, file/find, TUI control; `OPENCODE_TOOL_PROFILE=essential` | Durable local job store (24 h), hand-rolled Tasks-extension support, MRTR `inputRequired.elicit` for permissions and questions ("permissions are never silently approved"), structured outputs, multi-project `directory` | Far too many tools for an upfront-loaded gateway setup; **no `notifications/progress` heartbeats** ("Poll jobs/tasks for updates"); tasks support is irrelevant for Claude Code today |
| **Guipegoraro/opencode-bridge** (2026-08) | stdio MCP → `opencode serve` over HTTP/SSE; Windows-first supervision | `delegate_task` (sync), `continue_task`, `task_progress`, `abort_task`, `end_task` (delete session), `list_tasks`, `list_models`, `bridge_health` | Closest to the requested lifecycle (delegate → result → continue → end); explicit health check | PowerShell/Task Scheduler supervision; Windows-only ops |
| **alejandro-technology/opencode-mcp** (npm `mcp-server-opencode`, 2026-08) | Spawns/attaches `opencode serve` instances | `opencode_start_server/stop_server`, `list_agents`, `start_task` (async), `continue_task`, `cancel_task`, `get_task_status`, `get_task_result`, `wait_for_task` (long-poll, any/all), plus a `delegate_task` prompt | Parallel fan-out by design, long-poll wait | More round-trips for the model |
| **Traves-Theberge/opencode-mcp** (2026-03) | HTTP to `opencode serve`; stdio and HTTP transports | 21 tools: `opencode_run`, `session_create/prompt/list/abort`, file/find, model/config/agent, MCP management | Broad and well documented | Config-mutation tools are risky in an enterprise |
| **nosolosoft/opencode-mcp** (Python FastMCP, 2026-08) | Spawns `opencode run` and parses JSON-lines | `opencode_run`, `opencode_continue_session`, `execute_opencode_command`, `list_models`, `export_session`, `get_status`; timeout default 300 s, max 600 s | Simple, no server process | Blocking CLI plus hard timeouts; Python |
| **tomasweigenast/opencode-mcp** (2026-08) | Spawns `opencode` CLI; optional warm `opencode serve` (`OPENCODE_MCP_SERVE=1`) | `opencode_start_explore`, `wait_for_explore`, `cancel_explore`, `explore` (blocking) | Read-only permission map injected via `OPENCODE_CONFIG_CONTENT`; concurrency, TTL and caching | Explore-only |
| **gilby125/opencode-mcp-tool** (2025-12) | Spawns `opencode run` | ask-style tools with a model/fallback model | Tiny | Old; single-shot |
| **klutometis/opencode-mcp** (2026-03) | Discovers many `opencode --port` TUIs over SSH reverse tunnels | `instances`, `send` (abort flag), `read` | Remote multi-instance | Niche |
| **shreeraman96/mcp-coding-agents** (`mcp-orchestrate`, sibling `mcp-opencode`) | Spawns CLIs (opencode, codex, claude, grok, pi) | `route(tier, …)` with safe fallback | Fallback only when the git tree is untouched | A router, not an OpenCode bridge |
| **nmt3325/opencode-mcp-bridge** (2026-09) | Vendors OpenCode's *tool* implementations (read/edit/bash…), not the agent | Tools plus `opencode_job_result` (`wait_seconds` 0–50), `job_cancel`, `job_list` | Pattern: initial wait ≤45 s, then a job handle | Not delegation to an OpenCode agent |

### 4.3 Sync vs async patterns seen in Codex-style wrappers

- **Sync (blocking) calls** return the final message: Codex `mcp-server`, `kky42/codex-as-mcp` (`spawn_agent`, `spawn_agents_parallel` via `codex exec`), `tuannvm/codex-mcp-server`, `PyYoshi/codex-app-mcp`.
  - The common failure was client-side ~60 s timeouts. kky42's README tells Codex users to set `tool_timeout_sec = 600`, and suggests `MCP_REQUEST_TIMEOUT_RESET_ON_PROGRESS=true` for the inspector.
  - Claude Code does not have this problem any more: its default wall-clock is ~27.8 h, there is no stdio per-request timer, and calls auto-background at 120 s. Only the 30-minute idle timeout remains, so heartbeats are required.
- **Async (start/poll):** `mcp-server-opencode`, `opencode-mcp` `fire/check/wait`, `nmt3325` bounded waits.
  - This suits clients with short timeouts, subagents and headless runs.
  - It costs extra model turns and relies on the model remembering to poll.
- **Hybrid (recommended for Claude Code):**
  - A blocking `opencode` / `opencode_reply` that heartbeats progress and returns `sessionId` early in `_meta`/progress messages. Interactive Claude Code backgrounds it natively.
  - Plus `opencode_status` / `opencode_wait(sessionId, max_wait_s)` for recovery, subagents and `-p`.
  - Plus `opencode_close(sessionId)` to end the session.

---

## 5. Implications and recommendations for opencode-mcp (MCP side only)

1. **SDK and runtime.**
   - `@modelcontextprotocol/server@2.2.0` + `zod@^4.2` (4.6.5 today), `serveStdio(factory)`, Node 22 LTS (matches OpenCode 1.18.x's Node ≥22 ecosystem [I]).
   - Mirror these exact tarballs in the internal proxy registry. The v2 set is 3 packages; add `@opencode-ai/sdk` if the HTTP API is used.
   - Keep a v1.31 fallback plan only if internal policy blocks v2.
2. **Tool surface.** Keep it small (4–5 tools; they load upfront behind a gateway):
   - `opencode` — `{prompt, cwd?(default CLAUDE_PROJECT_DIR), model?("provider/model"), agent?, title?, max_minutes?}`.
   - `opencode_reply` — `{sessionId, prompt}`.
   - `opencode_status` or `opencode_wait` — `{sessionId, wait_seconds?}`.
   - `opencode_cancel` — abort the running turn and keep the session.
   - `opencode_close` — abort if running, delete or archive the session, release resources.
   - The first two mirror `codex` / `codex-reply`.
3. **Result contract.**
   - Declare `outputSchema` and return `structuredContent` = `{sessionId, status: completed|failed|cancelled|needs_permission|timeout, content: <final assistant text>, filesChanged?: [...], error?}`.
   - Mirror the same text in `content[0].text` for other clients.
   - Keep `content` under 50 k characters (or set `anthropic/maxResultSizeChars`). Put large diffs and logs behind a separate call or a `resource_link`.
4. **Long runs.**
   - Always send `notifications/progress` when `progressToken` is present, e.g. every 10–20 s and on every OpenCode tool or step event.
   - Use monotonically increasing `progress`, and a `message` such as `"step 7: bash npm test"` plus the `sessionId` early on.
   - Enforce a server-side maximum run time and treat a missing cancel as possible (§3.3 caveat).
   - Recommend configuring per-server `"timeout"` in `managed-mcp.json`, e.g. 3,600,000 ms, as a documented upper bound.
5. **Cancellation and cleanup.**
   - Wire `ctx.mcpReq.signal` → OpenCode session abort.
   - Trap SIGINT, SIGTERM and stdin EOF → abort or delete owned sessions and stop spawned `opencode serve`.
   - Keep a registry keyed by Claude Code's `CLAUDE_CODE_SESSION_ID` or the `claudecode/toolUseId` `_meta` value for correlation.
6. **OpenCode permission requests.**
   - Bridge them with `inputRequired(...)`: MRTR on 2026-07-28, SDK-shimmed push elicitation on legacy.
   - Keep the handler re-entrant, with `requestState` = HMAC(jobId).
   - On `cancel`/`decline`, or in headless mode, deny by policy and report `status: needs_permission` with details.
   - Never auto-approve silently. Optionally mark a dangerous "yolo" tool with `anthropic/requiresUserInteraction`.
7. **Do not implement MCP Tasks for Claude Code now.** The client does not declare the extension, so the spec forbids returning task handles.
8. **Environment hygiene.**
   - Do not pass `ANTHROPIC_*` or Claude credentials through to OpenCode.
   - Read OpenCode endpoint and credentials from explicit `env` (`OPENCODE_BASE_URL`, `OPENCODE_SERVER_PASSWORD`, …) so the server also works under `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`.
9. **Descriptions and instructions.** Keep each under 2,048 characters, lead with when to use the tool, and document that results come back in `structuredContent.content`.

---

## 6. Open questions / not verified

- The interactive auto-background path, and Esc/`TaskStop` → `notifications/cancelled`, were not exercised end-to-end. That needs an interactive TTY; the evidence is docs plus SDK runs.
- Whether Claude Code's v1 runtime (`MCP_SDK_GENERATION=v1`) differs in any of the observed behaviours. All runs used the default runtime, which was v2 under `DISABLE_TELEMETRY`.
- How Claude Code surfaces server `notifications/message` (logging) to the user. Not traced; assume debug-log only.
- Whether enterprise or air-gapped builds (no telemetry / Bedrock / Vertex) use different defaults for auto-background timing, the persist-to-disk threshold or URL elicitation on legacy stdio is untested. [I]
- The 64-character tool-name limit is taken from the Anthropic API contract; it was not re-tested here.

## 7. Sources

- **npm registry:**
  - `@modelcontextprotocol/sdk`, `/server`, `/client`, `/core`, `/node`, `/ext-tasks`; `@anthropic-ai/claude-code` and `-linux-x64@2.1.284`; `opencode-ai`; `opencode-mcp@3.0.0`; `@openai/codex` (0.158.0 latest).
  - Queried with `npm view` / `npm pack` on gram.
- **MCP TS SDK:**
  - https://github.com/modelcontextprotocol/typescript-sdk
  - https://ts.sdk.modelcontextprotocol.io/v2/
  - Package READMEs and `.d.mts` files (server 2.2.0, sdk 1.31.0).
- **MCP spec:**
  - https://modelcontextprotocol.io/specification/2026-07-28/changelog
  - …/2026-07-28/basic/utilities/progress and …/cancellation
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
  - https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html
  - https://blog.modelcontextprotocol.io/posts/2026-07-28/
- **Claude Code docs** (public pages; local copies were not retained):
  - https://code.claude.com/docs/en/mcp
  - https://code.claude.com/docs/en/managed-mcp
  - https://code.claude.com/docs/en/env-vars
  - https://code.claude.com/docs/en/hooks (Elicitation / ElicitationResult)
  - https://code.claude.com/docs/en/permissions
- **Claude Code issues:**
  - https://github.com/anthropics/claude-code/issues/76571
  - https://github.com/anthropics/claude-code/issues/52137
  - https://github.com/anthropics/claude-code/issues/18617
- **Codex:**
  - https://github.com/openai/codex/pull/42993
  - Release `rust-v0.154.0` notes.
  - Source at `942af8447b` (`codex-rs/mcp-server/src/codex_tool_config.rs`, `codex_tool_runner.rs`, `exec_approval.rs`); local copies were not retained.
  - https://learn.chatgpt.com/docs/mcp-server
  - [2nd] https://codex.danielvaughan.com/2026/08/25/codex-mcp-server-deprecated-app-server-migration-claude-code-plugin-v0149/
- **Prior-art READMEs** (read from each project's public repository; local copies were not retained):
  - github.com/AlaeddineMessadi/opencode-mcp
  - Guipegoraro/opencode-bridge
  - alejandro-technology/opencode-mcp
  - Traves-Theberge/opencode-mcp
  - nosolosoft/opencode-mcp
  - tomasweigenast/opencode-mcp
  - gilby125/opencode-mcp-tool
  - klutometis/opencode-mcp
  - shreeraman96/mcp-coding-agents
  - nmt3325/opencode-mcp-bridge
  - JaimeJunr/polyagent-mcp
  - kky42/codex-as-mcp
  - tuannvm/codex-mcp-server
  - PyYoshi/codex-app-mcp
- **Run evidence:** raw server logs and tool-result captures for tests t1–t9, t2b and u1–u4 were not retained. The probe scripts that produced them are committed at `docs/research/probe-mcpclient/`.
