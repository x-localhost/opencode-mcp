// Tool schemas and handlers for the five opencode-mcp tools (design.md §4).
//
// Every input schema is `z.strictObject` so unknown properties are rejected (verified in
// docs/sdk-notes.md: plain `z.object` silently strips them instead). All five tools share one
// output schema (design.md §4.6: a single object root with `kind`/`status`/`content` required
// and every other TurnResult/ListResult/EndResult/ErrorResult field optional).

import * as z from 'zod';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import type {
  ApprovalDecision,
  ApprovalRequest,
  BatchStatusInput,
  CallContext,
  Config,
  Engine,
  EngineErrorCode,
  ErrorResult,
  InfoInput,
  Logger,
  OutputInput,
  ReplyInput,
  StartInput,
} from '../types.ts';
import { EngineError } from '../types.ts';
import type { FormattableResult } from './format.ts';
import { formatResult } from './format.ts';

// ---------------------------------------------------------------------------
// Input schemas (design.md §4.1-§4.5)
// ---------------------------------------------------------------------------

// max(200): review finding R6 — an unbounded id is echoed back into both sessionId and threadId
// of an ErrorResult (e.g. "no such session: <id>" on opencode-end), and format.ts deliberately
// never truncates these fields (callers must be able to echo them back verbatim to continue a
// session), so an oversized id previously bypassed the whole output budget entirely (a 50,000-char
// id reproduced 100,360 chars). Rejecting it at the schema means the caller gets a clear
// "Input validation error" instead of ever reaching the engine or the formatter.
const idAliasShape = {
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Id of a session tracked by this server, from a prior opencode call. Exactly one of ' +
        'sessionId, threadId, conversationId is required to target a session; opencode-status ' +
        'may omit all three to list tracked sessions instead.',
    ),
  threadId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Alias for sessionId (Codex-compatible name), same session id value. Exactly one of ' +
        'sessionId, threadId, conversationId is required to target a session; opencode-status ' +
        'may omit all three to list tracked sessions instead.',
    ),
  conversationId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Deprecated alias for sessionId, same session id value. Exactly one of sessionId, ' +
        'threadId, conversationId is required to target a session; opencode-status may omit ' +
        'all three to list tracked sessions instead.',
    ),
};

const MODEL_DESCRIPTION =
  "Model to use, in the form 'provider/model' (e.g. 'my-gateway/coder-large'), not a bare " +
  'model name. Omit to use the server-configured default, or OpenCode\'s own resolution if none is set.';

const AGENT_DESCRIPTION =
  "OpenCode's primary agent for this session (e.g. 'build', 'plan', or a custom agent). Omit to " +
  'use the server-configured default, or OpenCode\'s own default agent.';

const TIMEOUT_SECONDS_DESCRIPTION =
  "This turn's hard run-time limit, in seconds. When it expires, the OpenCode run is stopped and " +
  "the result comes back with status 'timeout' — the work already done is not lost, but the turn " +
  'itself ends. This is not a call timeout: to stop waiting for a response while letting the turn ' +
  'keep running, use wait-seconds instead.';

const WAIT_SECONDS_DESCRIPTION =
  "Bounds only how long THIS call waits for a result, in seconds; it does not limit the turn " +
  "itself. On expiry this call returns a 'running' (or 'waiting_for_approval') snapshot while the " +
  'turn keeps executing on the server — continue observing it with opencode-status. Omit to block ' +
  'until the turn reaches a terminal state (subject to timeout-seconds); 0 returns immediately ' +
  'after admission — combine with opencode-status ids/wait-for to fan a batch of turns out in ' +
  'parallel and then observe them together.';

const REQUEST_ID_DESCRIPTION =
  'Idempotency key for this exact call (pattern: starts with a letter/digit, then up to 127 more ' +
  "letters/digits/'.'/'_'/':'/'-'). Retrying the same request-id after a network drop or client " +
  'retry joins the original operation instead of sending a second prompt to OpenCode; a different ' +
  'request-id (or omitting it) always starts a new one. Shared between opencode and opencode-reply.';

const OUTPUT_SCHEMA_DESCRIPTION =
  "Ask OpenCode's final message for THIS turn to be one JSON value matching this JSON Schema " +
  '(subset: object/array/string/number/integer/boolean/null; no $ref or unions; see README for ' +
  'the full list of supported keywords). Reported back as structuredOutput / ' +
  "structuredOutputStatus ('valid'/'missing'/'invalid'); still untrusted model output, and never " +
  'changes status, error or retry behaviour. Turn-local: never inherited by a later reply.';

const DETAIL_DESCRIPTION =
  "'compact' (default 'standard') drops toolCalls and filesChanged from this response (keeping " +
  'toolCallCount, filesChangedCount, pendingApprovalCount, and pendingApprovals itself) to save ' +
  'context; the full answer and tool-call log stay retrievable with opencode-output regardless of ' +
  'this setting.';

const MAX_OUTPUT_CHARS_DESCRIPTION =
  'Caps how many characters of the answer come back in THIS response only (0..44000; 0 returns no ' +
  "answer text at all). Never truncates the retained turn — read the rest with opencode-output. " +
  'Omit to use the default for the chosen detail level (44000 standard, 2000 compact).';

// v0.3 §4: pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ — a letter/digit, then up to 127 more
// letters/digits/'.'/'_'/':'/'-'.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const requestIdShape = {
  'request-id': z.string().regex(REQUEST_ID_PATTERN).optional().describe(REQUEST_ID_DESCRIPTION),
  'output-schema': z.record(z.string(), z.unknown()).optional().describe(OUTPUT_SCHEMA_DESCRIPTION),
};

const presentationShape = {
  detail: z.enum(['standard', 'compact']).optional().describe(DETAIL_DESCRIPTION),
  'max-output-chars': z.number().int().min(0).max(44000).optional().describe(MAX_OUTPUT_CHARS_DESCRIPTION),
};

const startInputSchema = z.strictObject({
  prompt: z.string().min(1).describe('The task or instructions to send to OpenCode for this turn.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory for this session. Relative paths resolve against the server default cwd; ' +
        'must be inside an allowed root. Omit to use the server default cwd.',
    ),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  agent: z.string().optional().describe(AGENT_DESCRIPTION),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .describe(
      "Cooperative permission profile for OpenCode's own tools (default 'workspace-write'). Not " +
        'OS-level isolation: OpenCode can still run arbitrary shell commands unless a rule denies ' +
        "it. Fixed for the life of the session once chosen. 'read-only' also denies file edits, bash, paths outside cwd and web fetch/search.",
    ),
  'approval-policy': z
    .enum(['never', 'on-request'])
    .optional()
    .describe(
      "How OpenCode permission prompts are handled (default 'never'): 'never' auto-denies them; " +
        "'on-request' asks interactively when the client supports it, otherwise also denies. Fixed " +
        'for the life of the session once chosen.',
    ),
  'base-instructions': z
    .string()
    .optional()
    .describe(
      "Extra system text sent before developer-instructions. OpenCode can't replace its own base " +
        'prompt per request, so this is added text, not a full override.',
    ),
  'developer-instructions': z
    .string()
    .optional()
    .describe('System-prompt text for this session; stored and re-sent on every turn, including replies.'),
  title: z
    .string()
    .optional()
    .describe('Session title shown by opencode-status. Defaults to the first line of prompt (up to 80 chars).'),
  'timeout-seconds': z.number().int().min(1).optional().describe(TIMEOUT_SECONDS_DESCRIPTION),
  'wait-seconds': z.number().int().min(0).optional().describe(WAIT_SECONDS_DESCRIPTION),
  ...requestIdShape,
  ...presentationShape,
});

const replyInputSchema = z.strictObject({
  prompt: z.string().min(1).describe('The next message to send to OpenCode in this session.'),
  ...idAliasShape,
  model: z
    .string()
    .optional()
    .describe(`${MODEL_DESCRIPTION} Given here, it replaces the stored value for this and later turns.`),
  agent: z
    .string()
    .optional()
    .describe(`${AGENT_DESCRIPTION} Given here, it replaces the stored value for this and later turns.`),
  'developer-instructions': z
    .string()
    .optional()
    .describe(
      'System-prompt text for this session. Omitted: the stored value (if any) is re-sent; given: ' +
        'replaces the stored value for this and later turns.',
    ),
  'timeout-seconds': z.number().int().min(1).optional().describe(TIMEOUT_SECONDS_DESCRIPTION),
  'wait-seconds': z.number().int().min(0).optional().describe(WAIT_SECONDS_DESCRIPTION),
  ...requestIdShape,
  ...presentationShape,
});

const statusInputSchema = z.strictObject({
  ...idAliasShape,
  'wait-seconds': z
    .number()
    .int()
    .min(0)
    .max(600)
    .optional()
    .describe(
      'How long (seconds, max 600, default 0) to wait for the turn to reach a terminal or ' +
        "approval-waiting state before returning a snapshot; while waiting, this call also relays " +
        'pending approval prompts. With a single id: required id (sessionId/threadId/conversationId) ' +
        'or list mode is used instead. With ids: the batch wait bound (see wait-for).',
    ),
  ids: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(16)
    .optional()
    .describe(
      'Check up to 16 sessions at once instead of one (batch mode): each array entry is a session ' +
        'id, unique, 1-200 chars. Mutually exclusive with sessionId/threadId/conversationId. Each id ' +
        "captures that session's current (or pending) turn at call start; an unknown id comes back " +
        'as a per-item error, never failing the whole call. Pair with wait-seconds:0 on opencode/' +
        'opencode-reply to fan several turns out in parallel, then batch-check them all here.',
    ),
  'wait-for': z
    .enum(['any', 'all'])
    .optional()
    .describe(
      "Only with ids: 'any' (default) returns as soon as one item is ready; 'all' waits for every " +
        'item (bounded by wait-seconds) before returning. Invalid without ids.',
    ),
  ...presentationShape,
});

const cancelInputSchema = z.strictObject({
  ...idAliasShape,
});

const endInputSchema = z.strictObject({
  ...idAliasShape,
  action: z
    .enum(['delete', 'archive'])
    .optional()
    .describe(
      "Whether to delete or archive the session when ending it. Default is this server's " +
        'configured OPENCODE_MCP_END_ACTION (see this tool\'s description for the current default).',
    ),
});

// v0.3 §1/§2/§9. `limit`'s exact bounds are section-dependent (text 256..20000 default 4000;
// tool-calls/diff-stat 1..100 default 20/50) and enforced by the engine, which knows the selected
// section; this schema only bounds it to a section-independent range.
const outputInputSchema = z.strictObject({
  ...idAliasShape,
  turn: z.number().int().min(1).describe("The turn number to read (from a prior turn result's `turn` field)."),
  section: z
    .enum(['answer', 'tool-calls', 'structured-output', 'diff'])
    .optional()
    .describe(
      'Which retained artifact to page through (default "answer"): the full final answer text, the ' +
        'tool-call log, the structured-output JSON (when output-schema was used), or the ' +
        'OpenCode-reported file diff for this turn (see diff-view).',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Where to resume paging from (default 0): a UTF-16 code-unit offset for text sections, an ' +
        'item offset for tool-calls/diff-stat. Use the previous call\'s nextOffset; offset === total ' +
        'returns an empty final page.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe(
      'How much of this page to return: chars for answer/structured-output/diff-patch (256..20000, ' +
        'default 4000), items for tool-calls/diff-stat (1..100, default 20 for tool-calls, 50 for ' +
        'diff-stat). Also bounded by this server\'s configured output limit.',
    ),
  'diff-view': z
    .enum(['stat', 'patch'])
    .optional()
    .describe(
      'Only with section:"diff" (default "stat"): "stat" lists changed files with add/delete ' +
        'counts, "patch" returns one file\'s patch text (requires file-index).',
    ),
  'file-index': z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only with diff-view:"patch": which file (by its fileIndex from a prior "stat" page) to read the patch of.'),
  'snapshot-id': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Pins reads to one frozen diff snapshot (required for diff-view:"patch", and for diff "stat" ' +
        'continuation once offset > 0): the id returned by a prior opencode-output diff read. Omit ' +
        'to fetch (or refetch, if the prior snapshot expired) a fresh one.',
    ),
});

const infoInputSchema = z.strictObject({
  section: z
    .enum(['server', 'models', 'agents', 'roots'])
    .optional()
    .describe(
      'What to look up (default "server"): "server" for this server\'s version/mode/defaults/limits, ' +
        '"models"/"agents" for what OpenCode currently advertises, "roots" for the allowed ' +
        'working-directory roots. Pagination arguments (offset/limit/snapshot-id) are invalid for "server".',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'Only for models/agents: which OpenCode directory instance to query (same resolver as opencode\'s ' +
        'cwd). Omit to use the server default cwd.',
    ),
  provider: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f/]+$/u).optional().describe('Only for models: restrict the list to one provider id.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Only for models/agents/roots: item offset to resume a paginated read from (default 0).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Only for models/agents/roots: how many items to return in this page (1-100, default 50).'),
  'snapshot-id': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Only for models/agents/roots, required once offset > 0: the id from a prior page of the same ' +
        'read, so pagination stays consistent with one snapshot instead of a live-changing catalog.',
    ),
});

// ---------------------------------------------------------------------------
// Shared output schema (design.md §4.6; extended by v0.3 §9 for the `output`/`info`/`batch`
// kinds and the new TurnResult fields). One object root, kind/status/content required, every
// other field optional so it validates every kind this server can return. Some nested shapes
// below are deliberately loosened to the union of two real shapes (e.g. `toolCalls`, which is
// TurnResult's ToolCallSummary on a turn/batch-item result but OutputToolCall — with extra
// messageId/callId/titleShortened fields — on an `output` result), or left as an open record for
// server/diff/model/agent/batch-item internals whose own field-level types are already pinned by
// src/types.ts and don't need a second, parallel zod declaration here.
// ---------------------------------------------------------------------------

// Exported for unit tests (test/mcp/overload-presentation.test.ts) to validate structuredContent
// against the exact schema the SDK enforces, without spawning a server.
export const outputSchema = z.object({
  kind: z.enum(['turn', 'sessions', 'end', 'error', 'output', 'info', 'batch']),
  status: z.string(),
  content: z.string(),

  threadId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  turn: z.number().optional(),
  executionState: z.enum(['active', 'stopped', 'unknown']).optional(),
  cleanup: z.enum(['complete', 'unconfirmed']).optional(),
  directory: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  toolCalls: z
    .array(
      z.object({
        tool: z.string().optional(),
        status: z.string().optional(),
        title: z.string().optional(),
        messageId: z.string().optional(),
        callId: z.string().optional(),
        titleShortened: z.boolean().optional(),
      }),
    )
    .optional(),
  toolCallCount: z.number().optional(),
  pendingApprovals: z
    .array(
      z.object({
        id: z.string(),
        sessionId: z.string(),
        permission: z.string(),
        patterns: z.array(z.string()),
      }),
    )
    .optional(),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
      // overload design §B: validated upstream classification (the engine produces these on a
      // TurnResult's error; buildErrorResult in this file never sets them on an ErrorResult's
      // error today). All optional/additive.
      statusCode: z.number().optional(),
      retryable: z.boolean().optional(),
      retryAfterSeconds: z.number().optional(),
      condition: z.literal('MODEL_OVERLOADED').optional(),
    })
    .optional(),
  tokens: z.object({ input: z.number(), output: z.number(), reasoning: z.number() }).optional(),
  cost: z.number().optional(),
  elapsedMs: z.number().optional(),
  truncated: z.boolean().optional(),
  hint: z.string().optional(),

  // overload design §B (TurnResult v0.3-followup additions; src/types.ts). All optional/additive
  // so this schema keeps validating every pre-existing producer unchanged.
  finish: z.string().optional(),
  warnings: z
    .array(
      z.object({
        code: z.enum(['EMPTY_RESPONSE', 'TRUNCATED', 'NONSTANDARD_FINISH']),
        message: z.string(),
      }),
    )
    .optional(),
  resendSafety: z.enum(['not_submitted', 'no_observed_effects', 'inspect_effects', 'unknown']).optional(),
  upstreamRetry: z
    .object({
      attempt: z.number(),
      message: z.string(),
      nextAt: z.number().optional(),
      observedAt: z.number(),
    })
    .optional(),
  upstreamRead: z
    .object({
      state: z.literal('degraded'),
      reason: z.enum(['overloaded', 'timeout', 'network', 'protocol', 'server_error']),
      statusCode: z.number().optional(),
      since: z.number(),
      nextAt: z.number(),
    })
    .optional(),
  responseLoop: z
    .object({
      count: z.number(),
      windowMs: z.number(),
      pattern: z.enum(['empty', 'invalid_tool', 'mixed']),
    })
    .optional(),
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        title: z.string(),
        directory: z.string(),
        status: z.string(),
        turns: z.number(),
        updatedAt: z.number(),
      }),
    )
    .optional(),
  opencodeVersion: z.string().optional(),
  action: z.string().optional(),
  abortedRunningTurn: z.boolean().optional(),

  // v0.3 §1/§9: TurnResult additions, and detail:"compact"'s extra count/omission fields.
  output: z
    .object({
      state: z.enum(['pending', 'retained', 'unavailable']),
      reason: z.enum(['expired', 'evicted', 'too_large']).optional(),
      answerChars: z.number().optional(),
      toolCallCount: z.number(),
      structuredChars: z.number().optional(),
      partial: z.boolean(),
      expiresAt: z.number().optional(),
    })
    .optional(),
  structuredOutputStatus: z.enum(['valid', 'missing', 'invalid']).optional(),
  structuredOutput: z.record(z.string(), z.unknown()).optional(),
  structuredOutputError: z.object({ code: z.string(), message: z.string() }).optional(),
  request: z
    .object({
      id: z.string(),
      serverInstanceId: z.string(),
      replayed: z.boolean(),
      scope: z.literal('process'),
      expiresAt: z.number().optional(),
    })
    .optional(),
  omittedFields: z.array(z.string()).optional(),
  filesChangedCount: z.number().optional(),
  pendingApprovalCount: z.number().optional(),

  // v0.3 §1/§2/§9: `output` kind (opencode-output).
  section: z.string().optional(),
  offset: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  total: z.number().optional(),
  hasMore: z.boolean().optional(),
  partial: z.boolean().optional(),
  diff: z.record(z.string(), z.unknown()).optional(),

  // v0.3 §5/§9: `info` kind (opencode-info).
  server: z.record(z.string(), z.unknown()).optional(),
  models: z.array(z.record(z.string(), z.unknown())).optional(),
  agents: z.array(z.record(z.string(), z.unknown())).optional(),
  roots: z.array(z.string()).optional(),
  snapshotId: z.string().optional(),
  observedAt: z.number().optional(),
  availability: z.string().optional(),

  // v0.3 §3/§9: `batch` kind (opencode-status with `ids`).
  waitFor: z.string().optional(),
  reason: z.string().optional(),
  results: z.array(z.record(z.string(), z.unknown())).optional(),
  readyIds: z.array(z.string()).optional(),
  pendingIds: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Descriptions (each < 2048 chars; lead with when to use; mention structuredContent.content)
// ---------------------------------------------------------------------------

// One sentence, reused verbatim in the two owning-call descriptions and in SERVER_INSTRUCTIONS,
// on the model-facing consequence of cancelling/stopping the call itself (Esc, TaskStop on an
// auto-backgrounded call, or a client timeout): it cancels the underlying OpenCode turn, not just
// this call (design.md §5.4; turn.ts attach()) — but ONLY for the call that owns the turn.
// Mid-review finding 17: a call that only observed an existing turn (v0.3 §4: a duplicate
// request-id joins the original operation as an observer, never re-sending the prompt) detaches
// on cancellation without touching the turn at all, so this must not claim cancellation always
// stops the turn.
const CANCEL_SENTENCE =
  'Cancelling or stopping the call that OWNS this turn (Esc, TaskStop, a client timeout) cancels ' +
  'the OpenCode turn; a call that only joined an existing turn as an observer (e.g. a duplicate ' +
  'request-id) detaches without cancelling anything. To stop waiting but keep the turn running, ' +
  'pass wait-seconds and poll opencode-status.';

const OPENCODE_DESCRIPTION =
  'Use this to delegate a new coding task to OpenCode and run its first turn. Blocks until the ' +
  'turn finishes (or wait-seconds elapses, up to the turn timeout). The final answer and status are in ' +
  'structuredContent.content / structuredContent.status; the text response mirrors the same ' +
  'content. Returns a session id (also usable as threadId/conversationId) to continue with ' +
  'opencode-reply. `sandbox` selects a cooperative permission profile for OpenCode\'s own tools ' +
  '(read-only / workspace-write / danger-full-access) — it is not OS-level isolation, OpenCode ' +
  'can still run arbitrary shell commands unless a rule denies it. `approval-policy` controls ' +
  'permission prompts raised by OpenCode: `never` (default) auto-denies them, `on-request` asks ' +
  `interactively when the client supports it. ${CANCEL_SENTENCE} Use \`detail\`/\`max-output-chars\` ` +
  'to keep this response small (the full answer stays readable with opencode-output); `request-id` ' +
  'makes a retried call safe to repeat; `output-schema` asks the final message to be one JSON value ' +
  'matching a schema. To run several tasks in parallel, start each with wait-seconds:0 and check ' +
  'them together with opencode-status ids/wait-for.';

const OPENCODE_REPLY_DESCRIPTION =
  'Use this to continue an existing OpenCode session started with opencode, after reading its ' +
  'previous result from structuredContent.content. Requires exactly one of sessionId, threadId ' +
  'or conversationId, plus a new prompt. Blocks until the turn finishes (or wait-seconds ' +
  'elapses, up to the turn timeout); the answer is in structuredContent.content. `sandbox` and ' +
  `\`approval-policy\` stay fixed for the life of the session. ${CANCEL_SENTENCE} Same \`detail\`/` +
  '`max-output-chars`/`request-id`/`output-schema` options as opencode; `output-schema` applies ' +
  'only to this turn, never a stored default.';

const OPENCODE_STATUS_DESCRIPTION =
  'Use this to check on or wait for a running OpenCode turn, or — with no id — to list the ' +
  'sessions tracked by this server. With an id it can block up to wait-seconds (max 600) and ' +
  'will also relay any pending approval prompts to you, so it is not purely read-only: it can ' +
  'act on the session while waiting. Without an id it returns the tracked session list in ' +
  'structuredContent.sessions and structuredContent.content. Pass `ids` (up to 16, instead of a ' +
  'single sessionId/threadId/conversationId) to check several sessions in one call — pair with ' +
  'wait-seconds:0 on opencode/opencode-reply to fan work out in parallel, then `wait-for` "any" ' +
  '(default) or "all" here to collect the results; batch items are always compact and ' +
  '`max-output-chars` becomes the shared answer budget split across them. `detail`/`max-output-chars` ' +
  'shrink a single-session answer the same way as on opencode.';

const OPENCODE_OUTPUT_DESCRIPTION =
  "Page through a turn's full retained answer, tool-call log, structured output, or the " +
  'OpenCode-reported file diff for that turn. Use `detail`:"compact" and `max-output-chars` on ' +
  'opencode/opencode-reply/opencode-status to keep every normal answer small; come back here with ' +
  'the same turn number to read more of it, one page at a time (offset/limit), without paying for ' +
  "the full text on every call — useful together with wait-seconds:0 plus opencode-status " +
  "ids/wait-for fan-out, reading each turn's full output here only for the ones that need it. " +
  'Requires exactly one of sessionId, threadId or conversationId, plus `turn`; `section` defaults ' +
  'to "answer". Retained output expires (OUTPUT_UNAVAILABLE) and is dropped once opencode-end ' +
  'succeeds, so read what you need before ending the session. Read-only: never mutates OpenCode.';

const OPENCODE_INFO_DESCRIPTION =
  "Discover this server's configuration and OpenCode's current catalogs without starting a " +
  'session. `section` "server" (default) reports this server\'s version, mode, defaults and ' +
  'limits (maxOutputChars, maxBatchIds, output retention, request-id table size, …); "models" and ' +
  '"agents" list what OpenCode currently advertises for a given `cwd`; "roots" lists this ' +
  "server's allowed working-directory roots. \"models\"/\"agents\"/\"roots\" are paginated " +
  '(offset/limit) and return a `snapshot-id` to keep reading the same consistent snapshot; ' +
  'pagination arguments are invalid for "server". Read-only; the "server" section never starts ' +
  'OpenCode.';

const OPENCODE_CANCEL_DESCRIPTION =
  'Use this to stop the turn currently running on an OpenCode session without ending the ' +
  'session, so a new opencode-reply can be sent afterwards. Requires exactly one of sessionId, ' +
  'threadId or conversationId. Idempotent when the session is already idle; the result is in ' +
  'structuredContent.content.';

// Built inside registerTools (not a static constant) so the advertised default action always
// matches this server's actual configured OPENCODE_MCP_END_ACTION (design.md §4.5, the
// `parseEnum(env, 'OPENCODE_MCP_END_ACTION', ...)` call in src/config.ts)
// instead of hardcoding 'delete'.
function buildEndDescription(config: Config): string {
  return (
    'Use this to finish working with an OpenCode session: it stops any running turn, rejects any ' +
    'leftover permission prompts, then deletes or archives the session and forgets it (action, ' +
    `default '${config.endAction}' — this server's configured OPENCODE_MCP_END_ACTION). Requires ` +
    'exactly one of sessionId, threadId or conversationId. Idempotent: ending an unknown or ' +
    'already-ended session returns structuredContent.status "not_found" without contacting OpenCode.'
  );
}

// overload design §B: exact required sentence
// ("Server instructions must explicitly say:").
const RETRYABLE_SENTENCE =
  'error.retryable describes a transient fault, not permission to repeat a prompt. Check ' +
  'executionState, cleanup, and resendSafety first.';

const SERVER_INSTRUCTIONS =
  'Delegate a coding task with "opencode"; read the answer from structuredContent.content. ' +
  'Continue the conversation with "opencode-reply". Poll or wait with "opencode-status" while ' +
  'structuredContent.status is "running" or "waiting_for_approval" (it also lists sessions when ' +
  'called with no id). Stop a running turn without losing the session with "opencode-cancel". ' +
  'Finish with "opencode-end" to stop, clean up and delete or archive the session. `sandbox` is ' +
  `a cooperative permission profile for OpenCode's own tools, not OS-level process isolation. ` +
  `${CANCEL_SENTENCE} On SESSION_BUSY, poll "opencode-status"; on CLEANUP_UNCONFIRMED the session ` +
  `is still tracked, so retry "opencode-end" or "opencode-cancel". ${RETRYABLE_SENTENCE}`;

for (const [name, desc] of [
  ['opencode', OPENCODE_DESCRIPTION],
  ['opencode-reply', OPENCODE_REPLY_DESCRIPTION],
  ['opencode-status', OPENCODE_STATUS_DESCRIPTION],
  ['opencode-output', OPENCODE_OUTPUT_DESCRIPTION],
  ['opencode-info', OPENCODE_INFO_DESCRIPTION],
  ['opencode-cancel', OPENCODE_CANCEL_DESCRIPTION],
] as const) {
  if (desc.length >= 2048) throw new Error(`tool description for ${name} exceeds 2048 chars`);
}
if (SERVER_INSTRUCTIONS.length >= 2048) throw new Error('server instructions exceed 2048 chars');

export { SERVER_INSTRUCTIONS };

// ---------------------------------------------------------------------------
// Id alias resolution (design.md §4: "exactly one id property must be present")
// ---------------------------------------------------------------------------

interface IdArgs {
  sessionId?: string;
  threadId?: string;
  conversationId?: string;
}

type IdResolution = { kind: 'none' } | { kind: 'one'; id: string } | { kind: 'invalid'; message: string };

const ID_KEYS = ['sessionId', 'threadId', 'conversationId'] as const;

function resolveIdArgs(args: IdArgs): IdResolution {
  const present = ID_KEYS.filter((k) => args[k] !== undefined);
  if (present.length === 0) return { kind: 'none' };
  if (present.length > 1) {
    return {
      kind: 'invalid',
      message: `exactly one of sessionId, threadId, conversationId is allowed, got ${present.length}: ${present.join(', ')}`,
    };
  }
  const key = present[0] as (typeof ID_KEYS)[number];
  return { kind: 'one', id: args[key] as string };
}

function requireOneId(args: IdArgs): { id: string } | { error: string } {
  const r = resolveIdArgs(args);
  if (r.kind === 'one') return { id: r.id };
  if (r.kind === 'none') {
    return { error: 'exactly one of sessionId, threadId, conversationId is required' };
  }
  return { error: r.message };
}

// ---------------------------------------------------------------------------
// Result -> CallToolResult
// ---------------------------------------------------------------------------

// v0.3 §1/§3 per-call presentation, threaded from the tool args to formatResult. Never sent to
// the engine (src/types.ts's OutputInput/StartInput/etc. carry no such fields).
interface Presentation {
  detail?: 'standard' | 'compact';
  /** For a `batch` result this is the aggregate answer budget (v0.3 §3), not a per-field cap. */
  callMaxOutputChars?: number;
}

// `formatResult`'s structuredContent is `Record<string, unknown>` (its own fixed contract),
// which is not structurally a `JSONObject`, so it needs one explicit, narrow cast at this
// boundary. It is genuinely JSON-safe at runtime: every field formatResult builds comes from
// TurnResult/ListResult/EndResult/ErrorResult/OutputResult/InfoResult/BatchResult strings,
// numbers, booleans, arrays and plain objects. The cast is also what keeps `registerTool`
// resolving its non-deprecated overload — see docs/sdk-notes.md.
// A10: `isError` is derived from the FINAL formatted envelope below (`structuredContent.kind ===
// 'error'`), never taken as a separate caller-supplied flag — a formatter-generated kind:'error'
// (e.g. formatOutputResult/formatBatchResult's own last-resort "even one item does not fit"
// substitution, on an engine call that otherwise succeeded and never threw) must still be reported
// as isError:true. Every existing caller already only ever passes a result whose own `kind` is
// already 'error' (via buildErrorResult) when it means to signal an error, so deriving the flag
// this way is equivalent for every pre-existing call site and additionally correct for the new one.
//
// overload design §B / response-loop watchdog contract "Failed/timeout isError: true": a single-turn
// (`kind: 'turn'`) result whose `status` is `'failed'` or `'timeout'` is ALSO reported as
// isError:true, even though the engine call itself returned normally (no throw, no formatter
// fallback) — the turn's own outcome is the failure. `completed` (including one carrying
// `warnings`), `cancelled`, `running` and `waiting_for_approval` stay non-error envelopes: a
// warning or a user/caller-initiated cancellation is not itself a tool-call failure. A `batch`
// envelope (opencode-status with `ids`) is never flagged this way — its own `kind`/`status` never
// become 'turn'/'failed'/'timeout', so a per-item failure inside `results` never flips the whole
// call to isError (design: "Batch results retain per-item failure information"). Never drops the
// turn/session identity, partial output or structuredContent when adding isError — this only ever
// ADDS the flag to an otherwise-unchanged envelope built by formatResult above.
function isErrorEnvelope(structuredContent: Record<string, unknown>): boolean {
  if (structuredContent.kind === 'error') return true;
  if (structuredContent.kind === 'turn') {
    const status = structuredContent.status;
    return status === 'failed' || status === 'timeout';
  }
  return false;
}

function toCallToolResult(
  result: FormattableResult,
  config: Config,
  presentation: Presentation = {},
): CallToolResult {
  const { structuredContent, text } = formatResult(result, {
    maxOutputChars: config.maxOutputChars,
    detail: presentation.detail,
    callMaxOutputChars: presentation.callMaxOutputChars,
  });
  const isError = isErrorEnvelope(structuredContent);
  const safeStructuredContent = structuredContent as CallToolResult['structuredContent'];
  return isError
    ? { content: [{ type: 'text', text }], structuredContent: safeStructuredContent, isError: true }
    : { content: [{ type: 'text', text }], structuredContent: safeStructuredContent };
}

// Short, model-facing recovery guidance per error code (README.md's operator-facing recovery
// table never reaches the calling model; this is the model-visible equivalent — Finding
// critic-c-client-abandonment-contract-5). Codes not listed here (e.g. UPSTREAM_ERROR,
// SHUTTING_DOWN, INTERNAL) get no hint: their message is already the actionable detail.
// OPENCODE_OVERLOADED is deliberately absent from this static map — its hint is built dynamically
// by buildErrorHint below (overload design §B "Recommended exact hint themes"), since its exact
// wording depends on whether a retry delay and/or a session id are available for this call.
const ERROR_HINTS: Partial<Record<EngineErrorCode, string>> = {
  INVALID_ARGUMENT: 'Check the arguments (including the id alias) and retry.',
  PATH_NOT_ALLOWED: 'Choose a cwd inside an allowed root, or ask an operator to widen the allowed roots.',
  SESSION_NOT_FOUND: 'This session is no longer tracked by this server; start a new one with opencode.',
  SESSION_BUSY:
    'A turn on this session is still active or unconfirmed: call opencode-status (with wait-seconds) ' +
    'to observe it, or opencode-cancel to stop it, then retry.',
  OPENCODE_UNAVAILABLE: "Check the OpenCode executable/server URL and its health, then retry.",
  SUBMISSION_UNCONFIRMED:
    'Whether the prompt reached OpenCode is unclear: do not resubmit yet; call opencode-status to ' +
    'check for a new turn first.',
  CLEANUP_UNCONFIRMED: 'The session is still tracked; retry opencode-end or opencode-cancel later.',
  TURN_INCOMPLETE:
    'The turn went idle without a final answer: check opencode-status for partial output, then retry ' +
    'with clearer instructions if needed.',
  // v0.3 §1/§2/§4 (v0.3 features contract §9's new EngineErrorCode values).
  TURN_NOT_FOUND:
    'This turn is not tracked (wrong turn number, or the session ended); call opencode-status for the current turn number.',
  OUTPUT_NOT_READY: 'The turn is still running; wait (opencode-status wait-seconds) before reading its retained output.',
  OUTPUT_UNAVAILABLE: "The retained output for this turn expired or was evicted; it cannot be recovered.",
  OUTPUT_LIMIT_TOO_SMALL:
    "This server's configured output limit (OPENCODE_MCP_MAX_OUTPUT_CHARS) is below the minimum " +
    "this section needs — the caller's limit argument cannot fix this; ask an operator to raise " +
    'the server configuration instead.',
  SNAPSHOT_EXPIRED: 'Retry with offset 0 and no snapshot-id to fetch a fresh snapshot.',
  UPSTREAM_RESPONSE_TOO_LARGE:
    'OpenCode returned a response larger than this server accepts; narrow the request or retry later.',
  INVALID_OUTPUT_SCHEMA: "Fix output-schema to the supported subset (see this tool's description) and retry.",
  REQUEST_ID_CONFLICT: 'A different call already used this request-id; choose a new request-id or omit it.',
  REQUEST_UNCONFIRMED:
    "Whether this request-id's call reached OpenCode is unclear: do not retry yet; call opencode-status to check first.",
  REQUEST_ENDED: "This request-id's turn already ended; use a new request-id to start another.",
  REQUEST_CAPACITY: "This server's request-id table is full; retry without request-id or wait for old entries to expire.",
  // FY-2
  REQUEST_PENDING:
    'The original call with this request-id is still being admitted; retry the same request-id shortly or poll opencode-status.',
  SESSION_CAPACITY:
    'Too many tracked sessions; end finished sessions with opencode-end, or ask an operator to raise OPENCODE_MCP_MAX_SESSIONS.',
};

// overload design §B "Recommended exact hint themes": the OPENCODE_OVERLOADED hint quotes
// `retryAfterSeconds` when one is available, and (only when this call already created/knows a
// session) points the caller at opencode-reply instead of another opencode start (see
// retryAfterSecondsFrom below for where the delay comes from).
function overloadedHint(sessionId: string | undefined, retryAfterSeconds: number | undefined): string {
  const wait =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? `Wait ${Math.max(0, Math.round(retryAfterSeconds))}s before retrying once.`
      : 'Wait a short while before retrying once.';
  const base = `OpenCode is temporarily busy or unavailable. No prompt was submitted. ${wait}`;
  return sessionId !== undefined
    ? `${base} A session already exists for this call; use opencode-reply with that session instead of starting a new one.`
    : base;
}

function buildErrorHint(
  code: EngineErrorCode,
  sessionId: string | undefined,
  retryAfterSeconds: number | undefined,
): string | undefined {
  if (code === 'OPENCODE_OVERLOADED') return overloadedHint(sessionId, retryAfterSeconds);
  return ERROR_HINTS[code];
}

// Exported for unit tests (test/mcp/audit-u13.test.ts, test/mcp/overload-presentation.test.ts) to
// check the hint map directly, without spawning a server and forcing every EngineErrorCode through
// the stub engine. `retryAfterSeconds` is only meaningful for OPENCODE_OVERLOADED (see
// overloadedHint above); every other code ignores it, so existing 3-argument callers are unaffected.
export function buildErrorResult(
  code: EngineErrorCode,
  message: string,
  sessionId?: string,
  retryAfterSeconds?: number,
): ErrorResult {
  const hint = buildErrorHint(code, sessionId, retryAfterSeconds);
  return {
    kind: 'error',
    status: 'failed',
    sessionId,
    threadId: sessionId,
    content: message,
    error: { name: code, message },
    ...(hint !== undefined ? { hint } : {}),
  };
}

// overload design §B: EngineError.retryAfterSeconds (set only for OPENCODE_OVERLOADED when the
// upstream gave a Retry-After). Validated again here because it originates from an HTTP header;
// absent or invalid values fall back to OPENCODE_OVERLOADED's number-less hint wording.
function retryAfterSecondsFrom(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object' || !('retryAfterSeconds' in err)) return undefined;
  const value = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function runEngineCall<T extends FormattableResult>(
  logger: Logger,
  config: Config,
  knownSessionId: string | undefined,
  fn: () => Promise<T>,
  presentation: Presentation = {},
): Promise<CallToolResult> {
  try {
    const result = await fn();
    return toCallToolResult(result, config, presentation);
  } catch (err) {
    if (err instanceof EngineError) {
      const sessionId = err.sessionId ?? knownSessionId;
      const retryAfterSeconds = retryAfterSecondsFrom(err);
      logger.warn('engine call failed', { code: err.code, message: err.message, sessionId });
      return toCallToolResult(
        buildErrorResult(err.code, err.message, sessionId, retryAfterSeconds),
        config,
        presentation,
      );
    }
    logger.error('unexpected error handling tool call', {
      error: err instanceof Error ? err : String(err),
      sessionId: knownSessionId,
    });
    return toCallToolResult(buildErrorResult('INTERNAL', 'internal error', knownSessionId), config, presentation);
  }
}

// ---------------------------------------------------------------------------
// CallContext (design.md §5.4; docs/sdk-notes.md for the exact SDK surface)
// ---------------------------------------------------------------------------

function createCallSignal(mcpSignal: AbortSignal): { signal: AbortSignal; detach: () => void } {
  const controller = new AbortController();
  if (mcpSignal.aborted) {
    controller.abort((mcpSignal as { reason?: unknown }).reason);
    return { signal: controller.signal, detach: () => {} };
  }
  const onAbort = () => controller.abort((mcpSignal as { reason?: unknown }).reason);
  mcpSignal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    detach: () => mcpSignal.removeEventListener('abort', onAbort),
  };
}

const PROGRESS_THROTTLE_MS = 1000;

type NotifyFn = ServerContext['mcpReq']['notify'];

// Exported for a direct unit test (test/mcp/audit-u13.test.ts) that stubs Date.now() to prove the
// throttle no longer depends on it — this function takes no injected Clock (an exception to
// design.md §3's injected-Clock rule: MCP-layer per-call plumbing, not engine/turn logic), so it
// uses the global performance.now() monotonic clock directly, the same source src/core/clock.ts's
// real Clock uses for monotonicNow(). A wall-clock step (NTP, manual, DST) cannot move it
// backwards or forwards.
export function createProgressSink(
  notify: NotifyFn,
  progressToken: string | number,
  sessionIdRef: { current: string | undefined },
): { send: (message: string) => void; dispose: () => void } {
  let counter = 0;
  // -Infinity (not 0): guarantees the very first send() always goes through immediately,
  // regardless of how performance.now() happens to be seeded (it is time-since-process-start, not
  // an epoch, so a plain 0 could itself be less than PROGRESS_THROTTLE_MS above 0 this early).
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let disposed = false;

  function doSend(message: string): void {
    counter += 1;
    lastSentAt = performance.now();
    const prefixed = sessionIdRef.current ? `${sessionIdRef.current}: ${message}` : message;
    try {
      const notification = {
        method: 'notifications/progress',
        params: { progressToken, progress: counter, message: prefixed },
      } as unknown as Parameters<NotifyFn>[0];
      const result = notify(notification);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {
          disposed = true;
        });
      }
    } catch {
      disposed = true;
    }
  }

  return {
    send(message: string) {
      if (disposed) return;
      const now = performance.now();
      const elapsed = now - lastSentAt;
      if (elapsed >= PROGRESS_THROTTLE_MS) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        pending = undefined;
        doSend(message);
        return;
      }
      pending = message;
      if (!timer) {
        // Clamped to [0, PROGRESS_THROTTLE_MS]: `elapsed` is always in (-Infinity, PROGRESS_THROTTLE_MS)
        // here, but defensively bounding it keeps this arithmetic safe even if that invariant ever
        // changes, so the timer can never be armed for longer than one throttle window.
        const delay = Math.min(PROGRESS_THROTTLE_MS, Math.max(0, PROGRESS_THROTTLE_MS - elapsed));
        timer = setTimeout(() => {
          timer = undefined;
          if (disposed) return;
          const msg = pending;
          pending = undefined;
          if (msg !== undefined) doSend(msg);
        }, delay);
        timer.unref?.();
      }
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function elicitationMessage(req: ApprovalRequest): string {
  return `OpenCode wants permission "${req.permission}" for: ${req.patterns.join(', ')} (session ${req.sessionId})`;
}

// U05 (r1-mcp-tools-1): whether the connected client's declared capabilities include elicitation
// at all. Shared by buildElicit (whether to build an elicit function) and createCallContext
// (whether to flag the call as elicitationUnsupported), so both always agree.
function hasElicitationCapability(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  return !!capabilities && capabilities.elicitation !== undefined;
}

// Exported for a direct unit test (test/mcp/audit-u05.test.ts) that the SDK's own 60 s
// DEFAULT_REQUEST_TIMEOUT_MSEC (docs/sdk-notes.md) is overridden with the caller's real approval
// deadline, without spawning a server.
export function buildElicit(server: McpServer, mcpReq: ServerContext['mcpReq']): CallContext['elicit'] | undefined {
  if (!hasElicitationCapability(server)) return undefined;

  return async (req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | null> => {
    try {
      const result = await mcpReq.elicitInput(
        {
          mode: 'form',
          message: elicitationMessage(req),
          requestedSchema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['allow', 'reject'], title: 'Decision' },
              feedback: { type: 'string', title: 'Reason (optional)' },
            },
            required: ['decision'],
          },
        },
        // U05 (r1-mcp-tools-1): without an explicit timeout, the SDK's Protocol.request applies its
        // own DEFAULT_REQUEST_TIMEOUT_MSEC (60 s) and auto-rejects any approval left open longer
        // than that, regardless of the configured (typically 600 s) approvalTimeoutMs window
        // (docs/sdk-notes.md). req.timeoutMs is the Turn's own remaining time to that deadline.
        { signal, timeout: req.timeoutMs, maxTotalTimeout: req.timeoutMs },
      );
      if (result.action !== 'accept') return null;
      const content = result.content as { decision?: unknown; feedback?: unknown } | undefined;
      if (content?.decision === 'allow') return { decision: 'allow' };
      if (content?.decision === 'reject') {
        return { decision: 'reject', feedback: typeof content.feedback === 'string' ? content.feedback : undefined };
      }
      return null;
    } catch {
      return null;
    }
  };
}

function createCallContext(
  server: McpServer,
  ctx: ServerContext,
  knownSessionId: string | undefined,
): { callCtx: CallContext; cleanup: () => void } {
  const { signal, detach: detachSignal } = createCallSignal(ctx.mcpReq.signal);

  const sessionIdRef = { current: knownSessionId };
  const progressToken = ctx.mcpReq._meta?.progressToken as string | number | undefined;
  let progressSink: ReturnType<typeof createProgressSink> | undefined;
  let progress: CallContext['progress'];
  if (progressToken !== undefined) {
    progressSink = createProgressSink(ctx.mcpReq.notify, progressToken, sessionIdRef);
    progress = (message: string) => progressSink?.send(message);
    // B1 (review): dispose as soon as the client drops this call (notifications/cancelled), not
    // only once the handler eventually finishes in `cleanup()` below. The handler is not itself
    // aborted by this signal alone (a running turn keeps going after cancellation by design), so
    // without this, notifications/progress would keep being sent for a request the client already
    // discarded and will never read a response for.
    if (signal.aborted) {
      progressSink.dispose();
    } else {
      signal.addEventListener('abort', () => progressSink?.dispose(), { once: true });
    }
  }

  const elicit = buildElicit(server, ctx.mcpReq);
  // U05 (r1-hostile-client-1): elicit is undefined exactly when this connection's declared
  // capabilities omit elicitation, i.e. no call on this connection could ever answer an approval —
  // lets Turn.processApprovals reject immediately instead of waiting out the full deadline.
  const elicitationUnsupported = elicit === undefined;

  // Only fills in an id this call did not already know, so a reply's known sessionId is never
  // overwritten (and never double-prefixed) by a later call from the engine.
  const setSessionId = (id: string) => {
    if (sessionIdRef.current === undefined) sessionIdRef.current = id;
  };

  const callCtx: CallContext = { signal, progress, elicit, elicitationUnsupported, setSessionId };

  return {
    callCtx,
    cleanup: () => {
      detachSignal();
      progressSink?.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Arg mapping (kebab-case wire names -> camelCase Engine inputs)
// ---------------------------------------------------------------------------

function toStartInput(args: z.infer<typeof startInputSchema>): StartInput {
  return {
    prompt: args.prompt,
    cwd: args.cwd,
    model: args.model,
    agent: args.agent,
    sandbox: args.sandbox,
    approvalPolicy: args['approval-policy'],
    baseInstructions: args['base-instructions'],
    developerInstructions: args['developer-instructions'],
    title: args.title,
    timeoutSeconds: args['timeout-seconds'],
    waitSeconds: args['wait-seconds'],
    requestId: args['request-id'],
    outputSchema: args['output-schema'],
  };
}

function toPresentation(args: { detail?: 'standard' | 'compact'; 'max-output-chars'?: number }): Presentation {
  return { detail: args.detail, callMaxOutputChars: args['max-output-chars'] };
}

function toOutputInput(sessionId: string, args: z.infer<typeof outputInputSchema>): OutputInput {
  return {
    sessionId,
    turn: args.turn,
    section: args.section,
    offset: args.offset,
    limit: args.limit,
    diffView: args['diff-view'],
    fileIndex: args['file-index'],
    snapshotId: args['snapshot-id'],
  };
}

function toInfoInput(args: z.infer<typeof infoInputSchema>): InfoInput {
  return {
    section: args.section,
    cwd: args.cwd,
    provider: args.provider,
    offset: args.offset,
    limit: args.limit,
    snapshotId: args['snapshot-id'],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, engine: Engine, config: Config, logger: Logger): void {
  server.registerTool(
    'opencode',
    {
      title: 'OpenCode',
      description: OPENCODE_DESCRIPTION,
      inputSchema: startInputSchema,
      outputSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args, ctx) => {
      const { callCtx, cleanup } = createCallContext(server, ctx, undefined);
      try {
        return await runEngineCall(
          logger,
          config,
          undefined,
          () => engine.start(toStartInput(args), callCtx),
          toPresentation(args),
        );
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    'opencode-reply',
    {
      title: 'OpenCode Reply',
      description: OPENCODE_REPLY_DESCRIPTION,
      inputSchema: replyInputSchema,
      outputSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args, ctx) => {
      const resolved = requireOneId(args);
      if ('error' in resolved) {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', resolved.error), config);
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, resolved.id);
      try {
        const replyInput: ReplyInput = {
          sessionId: resolved.id,
          prompt: args.prompt,
          model: args.model,
          agent: args.agent,
          developerInstructions: args['developer-instructions'],
          timeoutSeconds: args['timeout-seconds'],
          waitSeconds: args['wait-seconds'],
          requestId: args['request-id'],
          outputSchema: args['output-schema'],
        };
        return await runEngineCall(
          logger,
          config,
          resolved.id,
          () => engine.reply(replyInput, callCtx),
          toPresentation(args),
        );
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    'opencode-status',
    {
      title: 'OpenCode Status',
      description: OPENCODE_STATUS_DESCRIPTION,
      inputSchema: statusInputSchema,
      outputSchema,
      annotations: { readOnlyHint: false },
    },
    async (args, ctx) => {
      const resolution = resolveIdArgs(args);
      if (resolution.kind === 'invalid') {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', resolution.message), config);
      }

      // v0.3 §3: `ids` is mutually exclusive with the id aliases; batch mode.
      if (args.ids !== undefined) {
        if (resolution.kind === 'one') {
          return toCallToolResult(
            buildErrorResult('INVALID_ARGUMENT', 'ids is mutually exclusive with sessionId/threadId/conversationId'),
            config,
          );
        }
        const unique = new Set(args.ids);
        if (unique.size !== args.ids.length) {
          return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', 'ids must not contain duplicates'), config);
        }
        if (!engine.statusMany) {
          return toCallToolResult(buildErrorResult('INTERNAL', 'not available in this build'), config);
        }
        const { callCtx, cleanup } = createCallContext(server, ctx, undefined);
        try {
          const batchInput: BatchStatusInput = { ids: args.ids, waitFor: args['wait-for'], waitSeconds: args['wait-seconds'] };
          return await runEngineCall(
            logger,
            config,
            undefined,
            () => engine.statusMany!(batchInput, callCtx),
            { callMaxOutputChars: args['max-output-chars'] },
          );
        } finally {
          cleanup();
        }
      }

      // v0.3 §3: `wait-for` only makes sense with `ids`.
      if (args['wait-for'] !== undefined) {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', 'wait-for requires ids'), config);
      }

      if (resolution.kind === 'none') {
        // r1-mcp-tools-3: with no id this is list mode, which has no turn to bound a wait on —
        // silently discarding wait-seconds here previously let a caller believe a list response
        // reflected up to wait-seconds of observation. Reject instead of ignoring it.
        if (args['wait-seconds'] !== undefined) {
          return toCallToolResult(
            buildErrorResult('INVALID_ARGUMENT', 'wait-seconds requires a session id'),
            config,
          );
        }
        return await runEngineCall(logger, config, undefined, () => engine.list(), toPresentation(args));
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, resolution.id);
      try {
        return await runEngineCall(
          logger,
          config,
          resolution.id,
          () => engine.status({ sessionId: resolution.id, waitSeconds: args['wait-seconds'] }, callCtx),
          toPresentation(args),
        );
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    'opencode-cancel',
    {
      title: 'OpenCode Cancel',
      description: OPENCODE_CANCEL_DESCRIPTION,
      inputSchema: cancelInputSchema,
      outputSchema,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (args, ctx) => {
      const resolved = requireOneId(args);
      if ('error' in resolved) {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', resolved.error), config);
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, resolved.id);
      try {
        return await runEngineCall(logger, config, resolved.id, () =>
          engine.cancel({ sessionId: resolved.id }, callCtx),
        );
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    'opencode-output',
    {
      title: 'OpenCode Output',
      description: OPENCODE_OUTPUT_DESCRIPTION,
      inputSchema: outputInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, ctx) => {
      const resolved = requireOneId(args);
      if ('error' in resolved) {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', resolved.error), config);
      }
      if (!engine.output) {
        return toCallToolResult(buildErrorResult('INTERNAL', 'not available in this build', resolved.id), config);
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, resolved.id);
      try {
        return await runEngineCall(logger, config, resolved.id, () =>
          engine.output!(toOutputInput(resolved.id, args), callCtx),
        );
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    'opencode-info',
    {
      title: 'OpenCode Info',
      description: OPENCODE_INFO_DESCRIPTION,
      inputSchema: infoInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, ctx) => {
      if (!engine.info) {
        return toCallToolResult(buildErrorResult('INTERNAL', 'not available in this build'), config);
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, undefined);
      try {
        return await runEngineCall(logger, config, undefined, () => engine.info!(toInfoInput(args), callCtx));
      } finally {
        cleanup();
      }
    },
  );

  const endDescription = buildEndDescription(config);
  if (endDescription.length >= 2048) throw new Error('tool description for opencode-end exceeds 2048 chars');

  server.registerTool(
    'opencode-end',
    {
      title: 'OpenCode End',
      description: endDescription,
      inputSchema: endInputSchema,
      outputSchema,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (args, ctx) => {
      const resolved = requireOneId(args);
      if ('error' in resolved) {
        return toCallToolResult(buildErrorResult('INVALID_ARGUMENT', resolved.error), config);
      }
      const { callCtx, cleanup } = createCallContext(server, ctx, resolved.id);
      try {
        return await runEngineCall(logger, config, resolved.id, () =>
          engine.end({ sessionId: resolved.id, action: args.action }, callCtx),
        );
      } finally {
        cleanup();
      }
    },
  );
}
