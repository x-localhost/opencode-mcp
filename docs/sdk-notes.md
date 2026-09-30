# `@modelcontextprotocol/server@2.2.0` — notes on the MCP SDK layer

Verified by installing the exact pinned deps on gram (Node 22), reading the published
`.d.mts`/runtime `.mjs`, and running small probe scripts against `@modelcontextprotocol/core/internal`'s
Zod schemas. Dist file names below are hashed chunk names as shipped; only the package-root import paths are stable.

## Imports

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod'; // zod@4.6.5 — top-level export is already v4 (has z.strictObject)
```

## `McpServer` construction

```ts
constructor(serverInfo: Implementation, options?: ServerOptions)
// Implementation = { name: string; version: string; title?; icons?; websiteUrl?; description? }
```
`ServerOptions` (`dist/createMcpHandler-*.d.mts`) fields we need: `capabilities?: ServerCapabilities` (`{ tools?: {listChanged?}, resources?, prompts?, logging?, completions?, tasks?, experimental?, extensions? }` — `registerTool` auto-registers `tools`, so `{}`/omit is fine for a tools-only server) and `instructions?: string` (server-level usage text; design caps it at 2,048 chars, the SDK does not). `jsonSchemaValidator?`, `cacheHints?`, `inputRequired?`, `requestState?` are not needed for v0.1 (no MRTR).

## `registerTool`

```ts
server.registerTool<OutputArgs, InputArgs>(name: string, config: {
  title?: string; description?: string;
  inputSchema?: InputArgs;   // Standard Schema, e.g. z.strictObject({...})
  outputSchema?: OutputArgs; // Standard Schema, e.g. z.object({...})
  annotations?: ToolAnnotations; // { title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? } (all optional booleans)
  icons?: Icon[];
  scopeChallenge?: ScopeChallengeHandler; // OAuth only, unused
  _meta?: Record<string, unknown>; // e.g. { 'anthropic/maxResultSizeChars': 200000 }
}, cb: ToolCallback<InputArgs>): RegisteredTool
```
`ToolCallback` = `(args, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>`. A raw-shape overload (`{a: z.string()}`) exists but is `@deprecated` — always wrap with `z.object`/`z.strictObject`.

## **Strict vs. loose input schemas — load-bearing finding**

`z.toJSONSchema()` emits `"additionalProperties": false` for **both** `z.object({...})` and `z.strictObject({...})` — the JSON Schema advertised in `tools/list` looks identical either way. But the SDK's actual runtime check (`McpServer.validateToolInput` → `validateStandardSchema(tool.inputSchema, args)` in `dist/src-*.mjs`) calls the schema's own `~standard.validate(data)`, i.e. real Zod parsing:

```js
async function validateStandardSchema(schema, data) {
  const result = await schema["~standard"].validate(data);
  if (result.issues?.length) return { success: false, error: ... };
  return { success: true, data: result.value };
}
```

Verified directly: `z.object({a:z.string()}).safeParse({a:'x',extra:1})` → `{success:true,data:{a:'x'}}` (unknown key **silently stripped**); `z.strictObject({a:z.string()}).safeParse({a:'x',extra:1})` → `{success:false,...}` (rejected). **Consequence for U3** (design §4, "Unknown input properties are rejected"): every tool's `inputSchema` MUST use `z.strictObject({...})` (or `.strict()`), not plain `z.object({...})`, or unknown properties are silently dropped instead of producing `INVALID_ARGUMENT`.

## `isError` results are **not** validated against `outputSchema`

`McpServer.validateToolOutput` (`dist/mcp-*.mjs`):
```js
async validateToolOutput(tool, result, toolName) {
  if (!tool.outputSchema) return;
  if (isInputRequiredResult(result)) return;
  if (result.isError) return;                     // <-- early return, no check at all
  if (result.structuredContent === void 0) throw new ProtocolError(...,
    `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
  const parseResult = await validateStandardSchema(tool.outputSchema, result.structuredContent);
  if (!parseResult.success) throw new ProtocolError(..., `Output validation error: Invalid structured content for tool ${toolName}: ${parseResult.error}`);
}
```
So an error result (`isError:true`) can carry `structuredContent` of any shape, or omit it, with zero validation. Design §4.6 is safe here — but still populate the same `TurnResult` shape for consistency, since Claude Code shows `JSON.stringify(structuredContent)` regardless of `isError`.

## Handler context (`ctx: ServerContext`, extends `BaseContext`)

```ts
ctx.sessionId?: string
ctx.mcpReq.id: RequestId
ctx.mcpReq.method: string
ctx.mcpReq._meta?: RequestMeta          // { progressToken?: string|number, 'io.modelcontextprotocol/related-task'?: {taskId} }
ctx.mcpReq.envelope?: Partial<RequestMetaEnvelope>  // 2026-07-28 era only
ctx.mcpReq.signal: AbortSignal          // fires on notifications/cancelled
ctx.mcpReq.notify: (n: Notification) => Promise<void>
ctx.mcpReq.send: (...) => Promise<...>
ctx.mcpReq.requestState: <T=unknown>() => T | undefined   // MRTR only
ctx.mcpReq.elicitInput: (params, options?) => Promise<ElicitResult>  // legacy era only; @deprecated but functional
ctx.mcpReq.requestSampling: (...) => Promise<...>  // legacy era only; @deprecated
ctx.mcpReq.log: (level, data, logger?) => Promise<void>  // @deprecated (SEP-2577); log to stderr instead
ctx.http?.authInfo  // HTTP transport only, undefined for stdio
```
Progress token: read `ctx.mcpReq._meta?.progressToken` (type `string | number`). Send heartbeats with:
```ts
await ctx.mcpReq.notify({ method: 'notifications/progress',
  params: { progressToken, progress, total?, message? } });
```
`ProgressNotificationParamsSchema` requires both `progress` and `progressToken`; the spec requires monotonic progress, but the SDK does not enforce it.

`ctx.mcpReq.elicitInput` throws on a 2026-07-28-era request with exactly: *"Server-to-client requests are not available on protocol revision \<rev\>: 'elicitation/create' cannot be sent while serving a request on that revision. Return inputRequired({ ... }) from the handler instead — the client fulfils the embedded requests and retries the original request (multi round-trip requests)."* Claude Code 2.1.284 speaks the legacy era by default, so `elicitInput` works there; guard the call anyway (try/catch) since `MCP_PROTOCOL_NEGOTIATION=auto` clients probe the modern era.

### `elicitInput`'s own request timeout — load-bearing finding (U05 / r1-mcp-tools-1)

`ctx.mcpReq.elicitInput(params, options?)` is itself just `Protocol.request({method:'elicitation/create', params}, ElicitResultSchema, options)` under the hood, so it inherits `Protocol.request`'s own timeout handling, entirely separate from any application-level "approval deadline": if `options` omits `timeout`, the SDK applies its own `DEFAULT_REQUEST_TIMEOUT_MSEC` (**60 000 ms**, i.e. 60 s). At 60 s it sends `notifications/cancelled` for that request (dismissing the client's dialog) and rejects the `elicitInput` call with a `RequestTimeout` error — regardless of how long this server's own configured `OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS` (default 600 s) window still has left. A human who takes longer than 60 s to answer a permission prompt is silently auto-rejected by the SDK, not by this server's own approval logic.

Fix (src/mcp/tools.ts `buildElicit`, src/core/turn.ts `processApprovals`): always pass an explicit `{ signal, timeout, maxTotalTimeout }`, both set to the caller's own remaining time to its real approval deadline (`ApprovalRequest.timeoutMs = max(1, deadline - now)`, recomputed on every elicit attempt, not a static config value), so the SDK's request-level timeout can never fire before the application-level one does. `elicitInput`'s own catch already turns any rejection (timeout, decline, client error) into a safe `null` (→ `reject`), so this only changes *when* that fallback can trigger, not its safety.

## Reading client capabilities (legacy era)

`McpServer.server` (the underlying `Server`, `readonly server: Server`) exposes:
```ts
server.server.getClientCapabilities(): ClientCapabilities | undefined  // @deprecated, still functional
```
`ClientCapabilities.elicitation` shape (from `z.toJSONSchema(ClientCapabilitiesSchema)`): `{ form?: { applyDefaults?: boolean, [x:string]: unknown }, url?: {...}, [x:string]: unknown }`. An empty `{}` object still means "form mode supported" (matches design/research §1.8). Prefer this over `ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities']`, which is only present on 2026-07-28 requests.

## `serveStdio` / shutdown

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const handle: StdioServerHandle = serveStdio(factory, {
  legacy?: 'serve' | 'reject';      // default 'serve': pin a 2025-era instance on an `initialize` opening
  transport?: Transport;             // default: new StdioServerTransport() over process stdio
  onerror?: (error: Error) => void;  // reporting only
  maxSubscriptions?: number;         // default 1024
});
await handle.close();                // tears down the pinned instance + transport
```
`factory: () => McpServer` — one instance is pinned per connection/era; register all tools inside it. `StdioServerTransport` default `maxBufferSize` is 10 MB; on stdin EOF it closes and "requests still in flight ... are aborted and not answered" (matches design §5.6: trap SIGINT/SIGTERM/SIGHUP/stdin EOF and abort turns proactively).

## Misc

- TypeScript ≥6 needs `"types": ["node"]` in `tsconfig` (`.d.mts` references `Buffer`) — already set. `fromJsonSchema(jsonSchema)` accepts a hand-written JSON Schema as a Standard Schema, if a zod shape is awkward.
- `inputRequired(...)`/`inputResponse`/`acceptedContent` exist for MRTR; out of scope for v0.1 (design §1 non-goals).

## Verified end-to-end behaviours (U3, confirmed against the real SDK/client)

- **Strict-schema violations never reach the handler.** A `z.strictObject` rejection (an
  unrecognized key) is turned into a tool result *before* our `ToolCallback` runs at all:
  ```json
  {"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool <name>: Unrecognized key: \"<key>\""}],"isError":true}
  ```
  with **no** `structuredContent` at all (not even an empty object) — do not assume every
  `isError:true` response has a parseable `structuredContent`; this one specifically does not.
- **`notifications/cancelled` gets no response, ever, for that request id** — this is
  protocol-correct behaviour of the SDK/transport, not a bug to work around: once the client sends
  `notifications/cancelled` for a request, the server must not (and the SDK does not) send any
  `tools/call` response for that id, success or error. The handler itself is **not** aborted by
  this alone — it keeps running to completion (our own code is what wires `ctx.mcpReq.signal` to
  actually stop the underlying turn); it just never gets to answer.
- **`registerTool`'s overload resolution is return-type-sensitive.** If a tool's callback is
  annotated to return a project-local interface shaped like `CallToolResult` instead of the SDK's
  own exported `CallToolResult` type, TypeScript silently falls back to the `@deprecated` raw-shape
  overload of `registerTool` instead of the intended `(config, cb)` overload — no error, just the
  wrong overload and a worse contract. Always import and return the SDK's `CallToolResult` type
  itself (as `src/mcp/tools.ts` does) at every point a tool handler's return value is constructed
  or cast, not a hand-rolled lookalike.
- **Claude Code 2.1.284 appends a `<system-reminder>` block after the JSON in the model-visible
  tool result text.** Observed in the e2e harness (`e2e/claude-stretch.test.mjs`): for a tool
  result carrying `structuredContent`, the `tool_result` content block's text that Claude Code
  actually sends to the model is `JSON.stringify(structuredContent)` followed by a trailing
  `<system-reminder>...</system-reminder>` block — i.e. only the **first line** of that text is the
  JSON payload; consumers parsing a Claude Code transcript's tool-result text must not assume the
  whole string is valid JSON, only its first line.
