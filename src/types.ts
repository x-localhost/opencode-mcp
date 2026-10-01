// Shared contracts for opencode-mcp (see docs/design.md, v0.2).
// Erasable TypeScript only: no enums, namespaces, parameter properties or decorators,
// so `node --test` can run the sources directly with Node 22 type stripping.
// Use `import type` for type-only imports of this module.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'never' | 'on-request';
export type EndAction = 'delete' | 'archive';
export type OnExit = 'abort' | 'end';
export type ServerMode = 'managed' | 'attach';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ModelProfile { context?: number; input?: number; output?: number; maxRunning?: number }
export type ContextGuard = 'reject' | 'off';

export interface Config {
  mode: ServerMode;
  /** attach mode: base URL of an existing `opencode serve` (validated: no userinfo; https unless loopback or allowInsecureHttp). */
  serverUrl?: string;
  allowInsecureHttp: boolean;
  username: string;
  /** attach mode: from env. managed mode: undefined here, generated at spawn. */
  password?: string;
  /** managed mode */
  opencodeBin: string;
  /** extra `opencode serve` args; must not contain --hostname/--port/--mdns* (validated) */
  serveArgs: string[];
  airgapDefaults: boolean;
  /** managed mode: when non-empty, the child env contains only these names/prefixes (`FOO_*`) plus essentials */
  childEnvAllowlist: string[];
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  /** absolute, canonical */
  defaultCwd: string;
  /** absolute, canonical (realpath in local mode) */
  allowedRoots: string[];
  /** attach to a server on another host: skip local existence/realpath checks (POSIX lexical containment only) */
  remotePaths: boolean;
  /** "provider/model" */
  defaultModel?: string;
  defaultAgent?: string;
  defaultSandbox: Sandbox;
  defaultApprovalPolicy: ApprovalPolicy;
  turnTimeoutMs: number;
  maxTurnTimeoutMs: number;
  approvalTimeoutMs: number;
  heartbeatMs: number;
  statusPollMs: number;
  sseStallMs: number;
  /** bound for stop/cleanup waits (abort → idle, permission cleanup, delete) */
  cleanupTimeoutMs: number;
  maxOutputChars: number;
  /** OPENCODE_MCP_READ_RETRY_ATTEMPTS: bounded admission GET retries only (overload design §C);
   *  integer 1..3, counts the initial attempt. */
  readRetryAttempts: number;
  /** OPENCODE_MCP_RESPONSE_LOOP_LIMIT: consecutive unproductive assistant attempts (within a fixed
   *  10s window) before the response-loop watchdog stops the turn (see docs/design.md §12); integer
   *  3..20, or 0 to disable. Default 6. */
  responseLoopLimit: number;
  /** cap on concurrently tracked sessions (active + quarantined); a new `opencode` start beyond it
   *  is rejected (SESSION_CAPACITY) before any upstream mutation — existing sessions are never
   *  evicted to make room. */
  maxSessions: number;
  /** OPENCODE_MCP_MAX_RUNNING_TURNS: run slots; integer 0..256, 0 = unlimited. Default 4. */
  maxRunningTurns: number;
  /** OPENCODE_MCP_MAX_QUEUED_TURNS: queued run slots; integer 0..1024. Default 64. */
  maxQueuedTurns: number;
  /** OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS: 0 or 1..2147483 seconds; 0 = disabled. Default 0. */
  queueTimeoutMs: number;
  /** OPENCODE_MCP_MODEL_PROFILES: per-model limits and run caps. Default {}. */
  modelProfiles: Record<string, ModelProfile>;
  /** OPENCODE_MCP_CONTEXT_GUARD: prompt size guard; reject|off. Default reject. */
  contextGuard: ContextGuard;
  endAction: EndAction;
  onExit: OnExit;
  logLevel: LogLevel;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Injectable time source so tests run in milliseconds. */
export interface Clock {
  /** epoch ms (for timestamps shown to users / sent to OpenCode) */
  wallNow(): number;
  /** monotonic ms (for deadlines and elapsed time) */
  monotonicNow(): number;
  /** returns a cancel function */
  schedule(delayMs: number, callback: () => void): () => void;
}

/** Per-request options for every non-SSE OpencodeApi call. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** overrides config.requestTimeoutMs for this call */
  timeoutMs?: number;
  /** Shared monotonic deadline for multi-request operations and internal fallbacks. */
  deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// OpenCode wire types (v1 API, opencode-ai 1.18.x). Subset; unknown fields allowed.
// ---------------------------------------------------------------------------

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
}

export interface OcSession {
  id: string;
  directory: string;
  parentID?: string;
  title: string;
  time: { created: number; updated: number; archived?: number };
  permission?: PermissionRule[];
  [key: string]: unknown;
}

export type OcSessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

export interface OcPermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export interface OcQuestionRequest {
  id: string;
  sessionID: string;
  questions: unknown[];
}

export interface OcMessageError {
  name: string;
  data?: { message?: string; [key: string]: unknown };
}

export interface OcTokens {
  input: number;
  output: number;
  reasoning: number;
  total?: number;
  cache?: { read: number; write: number };
}

export interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parentID?: string;
  time: { created: number; completed?: number };
  agent?: string;
  mode?: string;
  modelID?: string;
  providerID?: string;
  finish?: string;
  error?: OcMessageError;
  tokens?: OcTokens;
  cost?: number;
  /** assistant compaction summaries carry `summary: true`; user messages may carry an object */
  summary?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

export interface OcToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  title?: string;
  output?: string;
  error?: string;
  [key: string]: unknown;
}

export interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string; // 'text' | 'reasoning' | 'tool' | 'patch' | 'step-start' | 'step-finish' | 'compaction' | 'file' | ...
  text?: string; // type 'text' | 'reasoning'
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string; // type 'tool'
  callID?: string; // type 'tool'
  state?: OcToolState; // type 'tool'
  files?: string[]; // type 'patch'
  [key: string]: unknown;
}

export interface OcMessage {
  info: OcMessageInfo;
  parts: OcPart[];
}

export interface OcMessagePage {
  /** chronological order within this page */
  items: OcMessage[];
  /** from `X-Next-Cursor`; opaque; pass as `before` to get the previous (older) page */
  nextCursor?: string;
}

/** One SSE `data:` payload from `/event`. */
export interface OcEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface PromptBody {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
  // Deliberately absent: `tools` (replaces the permission ruleset, F4) and `messageID`.
}

/** Coarse (status, errorName) -> failure-family bucket, derived only from those two scalars —
 * never from response bodies or arbitrary message text (overload design §B). Used to auto-populate
 * `OpencodeHttpError.classification` and by the bounded read-retry helper
 * (src/opencode/retry.ts). */
export function classifyHttpFailure(status: number, errorName: string): 'overloaded' | 'degraded' | 'protocol' | undefined {
  if (status === 429 || status === 503 || status === 529) return 'overloaded';
  if (status === 408 || status === 500 || status === 502 || status === 504) return 'degraded';
  if (errorName === 'TimeoutError' || errorName === 'NetworkError') return 'degraded';
  if (errorName === 'ProtocolError') return 'protocol';
  return undefined;
}

/** Normalized HTTP failure from the OpenCode server. */
export class OpencodeHttpError extends Error {
  /** HTTP status; 0 for network/timeout/abort failures */
  status: number;
  /** OpenCode error name (`NotFoundError`, `SessionBusyError`, `PermissionNotFoundError`, ...) or `HttpError` | `TimeoutError` | `NetworkError` | `AbortError` | `RedirectError` | `ProtocolError`. */
  errorName: string;
  /** parsed JSON body when available (never includes request headers) */
  body: unknown;
  /** Bounded, validated seconds parsed from a well-formed upstream `Retry-After` header
   * (delta-seconds or HTTP-date, resolved against an injected wall clock — src/opencode/retry.ts's
   * `parseRetryAfterSeconds`). Undefined when the header was absent or unparseable. Never the raw
   * header string. */
  retryAfterSeconds?: number;
  /** Response headers arrived before a transport/body failure. */
  responseReceived?: boolean;
  /** Coarse bucket for the bounded read-retry helper and future engine mapping, auto-derived from
   * `(status, errorName)` by `classifyHttpFailure` unless explicitly overridden. */
  classification?: 'overloaded' | 'degraded' | 'protocol';
  constructor(message: string, status: number, errorName: string, body?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'OpencodeHttpError';
    this.status = status;
    this.responseReceived = status > 0;
    this.errorName = errorName;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    this.classification = classifyHttpFailure(status, errorName);
  }
}

/** Shared upstream-error shape (overload design §B) for TurnResult/ErrorResult/batch items.
 * `retryable` describes the failure's likely transience only — it never authorizes repeating a
 * mutation. `condition: 'MODEL_OVERLOADED'` is used for provider statuses 429/503/529. Every
 * field is a validated scalar; never a response body or a header map. See
 * src/opencode/retry.ts's `toUpstreamErrorDetail` for the HTTP-adapter-side normalizer. */
export interface UpstreamErrorDetail {
  /** <=200 chars */
  name: string;
  /** <=500 chars */
  message: string;
  /** integer 100..599 */
  statusCode?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  condition?: 'MODEL_OVERLOADED';
}

/**
 * Minimal OpenCode v1 client. Directory-scoped calls take the session's directory (F2).
 * Every non-SSE method accepts optional RequestOptions (timeout + abort).
 * Implementations: src/opencode/http.ts (real), test fakes.
 */
export interface OpencodeApi {
  health(req?: RequestOptions): Promise<{ healthy: boolean; version: string }>;
  createSession(directory: string, body: { title: string; permission?: PermissionRule[] }, req?: RequestOptions): Promise<OcSession>;
  /** null on 404 */
  getSession(sessionId: string, req?: RequestOptions): Promise<OcSession | null>;
  /** 204 → resolves. Callers must NOT retry automatically after an ambiguous failure. */
  promptAsync(sessionId: string, body: PromptBody, req?: RequestOptions): Promise<void>;
  abort(sessionId: string, req?: RequestOptions): Promise<boolean>;
  /** false on 404 */
  deleteSession(sessionId: string, req?: RequestOptions): Promise<boolean>;
  archiveSession(sessionId: string, archivedAtMs: number, req?: RequestOptions): Promise<OcSession>;
  /** newest `limit` messages (older than `before` if given) in chronological order, plus cursor */
  messages(sessionId: string, opts?: { limit?: number; before?: string }, req?: RequestOptions): Promise<OcMessagePage>;
  sessionDiff(sessionId: string, messageId: string, opts: { timeoutMs: number; maxBytes: number }): Promise<Array<{
    file?: string; status?: 'added' | 'deleted' | 'modified'; additions: number; deletions: number; patch?: string;
  }>>;
  providerCatalog(directory: string, opts: { timeoutMs: number; maxBytes: number }): Promise<unknown>;
  agentCatalog(directory: string, opts: { timeoutMs: number; maxBytes: number }): Promise<unknown>;
  /** only non-idle sessions appear */
  sessionStatus(directory: string, req?: RequestOptions): Promise<Record<string, OcSessionStatus>>;
  listPermissions(directory: string, req?: RequestOptions): Promise<OcPermissionRequest[]>;
  /** never called with 'always' (F6). 404 PermissionNotFoundError → resolves false (already resolved). */
  replyPermission(directory: string, requestId: string, reply: 'once' | 'reject', message?: string, req?: RequestOptions): Promise<boolean>;
  listQuestions(directory: string, req?: RequestOptions): Promise<OcQuestionRequest[]>;
  /** 404 → resolves false */
  rejectQuestion(directory: string, requestId: string, req?: RequestOptions): Promise<boolean>;
  /**
   * Initializes the directory instance's lazily cached provider and agent state outside any prompt
   * run (GET /provider and GET /agent with ?directory=). OpenCode 1.18.33 caches an interrupted
   * initialization, so an abort that lands during the first prompt's model resolution poisons the
   * whole directory instance (docs/research/upstream-issues.md U1). Callers must not abort this
   * early: use a generous timeout and no caller cancellation signal.
   */
  /** Resolves with the parsed `/provider` body it already reads (context-concurrency design §5.3),
   * so callers can project model limits from it without an extra request or re-parse. */
  warmInstance(directory: string, req?: RequestOptions): Promise<{ providerCatalog: unknown }>;
  /** POST /instance/dispose?directory= — drops the directory instance and its caches (recovery). */
  disposeInstance(directory: string, req?: RequestOptions): Promise<boolean>;
  /**
   * One SSE connection to `/event?directory=`. Yields parsed events (including `server.connected`
   * and `server.heartbeat`); completes when the server closes the stream; throws on network error.
   * Aborting `signal` closes the connection and ends the iteration without throwing.
   */
  subscribe(directory: string, signal: AbortSignal): AsyncIterable<OcEvent>;
}

export interface ConnectionLease {
  api: OpencodeApi;
  /** increments on every managed-server (re)start or successful attach reacquisition; stale leases must not be reused */
  generation: number;
  /** OpenCode server version from /global/health */
  version: string;
}

/** Lazily started (managed) or attached OpenCode server. createConnection(config, logger, clock). */
export interface Connection {
  /** Starts the managed server on first use; restarts it if it died. Throws EngineError('OPENCODE_UNAVAILABLE'). */
  acquire(req?: RequestOptions): Promise<ConnectionLease>;
  /** The live lease if a server is currently connected; never starts or restarts one (cleanup/shutdown paths). */
  current(): ConnectionLease | undefined;
  /** Invalidates only the current generation. Managed mode waits for child termination; attach mode drops its lease. */
  invalidate(generation: number, reason: 'unreachable' | 'hung'): Promise<void>;
  /** 'exited' proves a managed execution fence; 'unreachable' does not prove an attached runner stopped. */
  onUnavailable(listener: (generation: number, error: Error, kind: 'exited' | 'unreachable') => void): () => void;
  /** Stops the managed child (SIGTERM → grace → SIGKILL of the process group). Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine contract (consumed by src/mcp, implemented by src/core/engine.ts)
// ---------------------------------------------------------------------------

export type TurnStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'timeout';
/** whether OpenCode may still be executing this turn */
export type ExecutionState = 'active' | 'stopped' | 'unknown';

export interface ToolCallSummary {
  tool: string;
  status: string;
  title?: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
}

export interface TurnResult {
  kind: 'turn';
  threadId: string;
  sessionId: string;
  /** stable id of this turn inside this MCP process, e.g. `${sessionId}#${turn}` */
  turnId: string;
  turn: number;
  status: TurnStatus;
  executionState: ExecutionState;
  cleanup: 'complete' | 'unconfirmed';
  content: string;
  directory: string;
  agent?: string;
  model?: string;
  /** best-effort, from OpenCode patch parts; empty does not prove no files changed */
  filesChanged: string[];
  toolCalls: ToolCallSummary[];
  toolCallCount: number;
  pendingApprovals: PendingApproval[];
  /** `name` is the OpenCode/provider error name, or one of this server's own synthetic turn error
   *  names — 'EMPTY_RESPONSE' (a terminal 'stop'/'length' finish with no usable answer text and no
   *  observed tool/patch activity) and 'UPSTREAM_RESPONSE_LOOP' (the response-loop watchdog
   *  stopped the turn after `responseLoopLimit` consecutive unusable model attempts; overload
   *  design, summarized in docs/design.md §12). Never an `EngineErrorCode`. The optional fields
   *  carry validated upstream classification (overload design §B) — `retryable` describes a
   *  transient fault, never permission to resend. */
  error?: {
    name: string;
    message: string;
    statusCode?: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
    condition?: 'MODEL_OVERLOADED';
  };
  /** sum of assistant-message usage in this turn's execution interval */
  tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } };
  queue?: TurnQueueInfo;
  queuedMs?: number;
  context?: TurnContextInfo;
  cost?: number;
  elapsedMs: number;
  truncated: boolean;
  hint: string;
  // v0.3 (§9): all optional so existing producers (the stub engine, and the real engine until
  // F5-F7 land) stay valid without change.
  output?: TurnOutputMeta;
  structuredOutputStatus?: StructuredOutputStatus;
  /** only present when structuredOutputStatus === 'valid' */
  structuredOutput?: Record<string, unknown>;
  structuredOutputError?: { code: string; message: string };
  request?: RequestReceipt;
  // overload design §B: additive outcome/observation metadata (all optional; unit 3 wires
  // producers — src/core/turn.ts, engine.ts, result.ts — this file only carries the contract).
  /** Raw OpenCode finish string for the turn's terminal assistant, classified before bounding
   *  (<=64 chars for display). */
  finish?: string;
  /** At most 3 entries; each `message` <=200 chars. */
  warnings?: Array<{
    code: 'EMPTY_RESPONSE' | 'TRUNCATED' | 'NONSTANDARD_FINISH' | 'CONTEXT_HIGH';
    message: string;
  }>;
  /** See overload design §B for exact meanings; `no_observed_effects` is intentionally weaker than
   *  "safe" or "nothing ran". */
  resendSafety?: 'not_submitted' | 'no_observed_effects' | 'inspect_effects' | 'unknown';
  /** OpenCode's own provider-retry state (session.status `type: 'retry'`), one line, <=200 chars. */
  upstreamRetry?: {
    attempt: number;
    message: string;
    /** Unix epoch milliseconds */
    nextAt?: number;
    /** Unix epoch milliseconds */
    observedAt: number;
  };
  /** A degraded admission/read state (design §C "Degraded versus unreachable"). */
  upstreamRead?: {
    state: 'degraded';
    reason: 'overloaded' | 'timeout' | 'network' | 'protocol' | 'server_error';
    statusCode?: number;
    /** Unix epoch milliseconds */
    since: number;
    /** Unix epoch milliseconds; next scheduled read */
    nextAt: number;
  };
  /** docs/design.md §12: response-loop watchdog evidence, present only when the turn was
   *  stopped for cause 'response_loop' (unit 3 wires the stop; `error.name` is then
   *  'UPSTREAM_RESPONSE_LOOP'). */
  responseLoop?: {
    /** confirmed threshold-sized consecutive-unproductive-attempt sequence length */
    count: number;
    /** fixed detection window in ms; currently always 10000 */
    windowMs: number;
    pattern: 'empty' | 'invalid_tool' | 'mixed';
  };
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  directory: string;
  /** 'quarantined' added by U04 (recovery: an unknown-outcome turn stays quarantined) */
  status: TurnStatus | 'idle' | 'ending' | 'quarantined';
  turns: number;
  updatedAt: number;
  queue?: TurnQueueInfo;
}

export interface TurnQueueInfo {
  /** 1-based position among queued tickets (oldest first); ordering hint, not a dispatch promise */
  position: number;
  /** turns holding a run slot right now (incl. heldUnknown) */
  running: number;
  /** null = unlimited */
  maxRunning: number | null;
  blockedBy: 'global' | 'model';
  /** the submitted model this ticket is counted against, when known */
  model?: string;
  modelRunning?: number;
  modelMaxRunning?: number;
  /** milliseconds spent queued so far */
  queuedMs: number;
}

export interface TurnContextInfo {
  /** observed 'providerID/modelID' of the last non-summary assistant with usage */
  model: string;
  /** OpenCode overflow count of that assistant: tokens.total || input+output+cache.read+cache.write */
  used?: number;
  /** max of the same count over this turn's non-summary assistants */
  peakUsed?: number;
  /** OpenCode's usable input budget for that model (see §5.2); absent when the limit is unknown */
  usableInputTokens?: number;
  /** used / usableInputTokens rounded to 3 decimals; absent when either is absent */
  ratio?: number;
  limitSource?: 'opencode' | 'profile' | 'mixed';
  /** compaction observed in this turn's interval (existing flag, result.ts:23-25) */
  compacted: boolean;
}

export interface ListResult {
  kind: 'sessions';
  content: string;
  sessions: SessionSummary[];
  opencodeVersion?: string;
  truncated: boolean;
}

export interface EndResult {
  kind: 'end';
  threadId: string;
  sessionId: string;
  status: 'ended' | 'not_found';
  action: EndAction | 'none';
  abortedRunningTurn: boolean;
  cleanup: 'complete' | 'unconfirmed';
  content: string;
}

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  /** U05: remaining ms until this request's absolute approval deadline (`max(1, deadline - now)`),
   *  computed by Turn.processApprovals. src/mcp/tools.ts's buildElicit forwards this as the MCP
   *  SDK request's own `timeout`/`maxTotalTimeout`, so the SDK's 60 s DEFAULT_REQUEST_TIMEOUT_MSEC
   *  never auto-rejects an approval before the real (typically 600 s) window elapses. Optional so
   *  callers that build an ApprovalRequest without a Turn-owned deadline (e.g. test/mcp fixtures)
   *  still type-check; every real approval sets it. */
  timeoutMs?: number;
}

export interface ApprovalDecision {
  decision: 'allow' | 'reject';
  feedback?: string;
}

/** Per MCP call. Built by src/mcp from the SDK request context. */
export interface CallContext {
  /** Aborted on MCP notifications/cancelled for this request (the MCP layer removes its listener after the call returns). */
  signal: AbortSignal;
  /** Progress sink for THIS call; the MCP layer adds progressToken, a per-request monotonic counter and throttling. Never throws. */
  progress?: (message: string) => void;
  /**
   * Ask the human via MCP elicitation (legacy protocol era only in v0.1). Resolves null when there is
   * no usable answer (declined, cancelled, unsupported, failed, aborted). Must not throw.
   */
  elicit?: (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision | null>;
  /** U05: true when this call's MCP connection declared no `elicitation` client capability at all,
   *  so `elicit` is undefined and can never answer on this connection (design.md §6.2's
   *  "unsupported → reject"). Only meaningful when `elicit` is undefined; lets Turn.processApprovals
   *  reject immediately instead of waiting out the full approval deadline for a call that could
   *  never have answered. */
  elicitationUnsupported?: boolean;
  /** Lets the engine surface a session id it created mid-call (e.g. a start call) to this call's
   *  own progress sink, once it exists. Must not throw. */
  setSessionId?(id: string): void;
}

export interface StartInput {
  prompt: string;
  cwd?: string;
  model?: string;
  agent?: string;
  sandbox?: Sandbox;
  approvalPolicy?: ApprovalPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  title?: string;
  timeoutSeconds?: number;
  /** undefined = wait for the terminal state */
  waitSeconds?: number;
  /** v0.3 §4: request-id deduplication key; pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ */
  requestId?: string;
  /** v0.3 §6: turn-local structured-output contract; never inherited across turns */
  outputSchema?: Record<string, unknown>;
}

export interface ReplyInput {
  sessionId: string;
  prompt: string;
  /** omitted → the session's stored model/agent/instructions are re-sent; given → replaces the stored value */
  model?: string;
  agent?: string;
  developerInstructions?: string;
  timeoutSeconds?: number;
  waitSeconds?: number;
  /** v0.3 §4: request-id deduplication key; pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ */
  requestId?: string;
  /** v0.3 §6: turn-local structured-output contract; never inherited across turns */
  outputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// v0.3 delegation features: engine <-> MCP interface (frozen; v0.3 features contract §9).
// F8 (this file, src/mcp/*) and the engine-wiring units (F5-F7) both
// code against these exact types.
// ---------------------------------------------------------------------------

export type StructuredOutputStatus = 'valid' | 'missing' | 'invalid';

export interface RequestReceipt {
  id: string;
  serverInstanceId: string;
  replayed: boolean;
  scope: 'process';
  expiresAt?: number;
}

export interface TurnOutputMeta {
  state: 'pending' | 'retained' | 'unavailable';
  reason?: 'expired' | 'evicted' | 'too_large';
  answerChars?: number;
  toolCallCount: number;
  structuredChars?: number;
  partial: boolean;
  expiresAt?: number;
}

export interface OutputInput {
  sessionId: string;
  turn: number;
  section?: 'answer' | 'tool-calls' | 'structured-output' | 'diff';
  offset?: number;
  limit?: number;
  diffView?: 'stat' | 'patch';
  fileIndex?: number;
  snapshotId?: string;
}

export interface OutputToolCall {
  messageId: string;
  callId?: string;
  tool: string;
  status: string;
  title?: string;
  titleShortened?: boolean;
}

export interface OutputDiffFile {
  fileIndex: number;
  file?: string;
  status?: string;
  additions: number;
  deletions: number;
  patchChars?: number;
}

export interface OutputResult {
  kind: 'output';
  status: 'ok';
  content: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  turn: number;
  section: 'answer' | 'tool-calls' | 'structured-output' | 'diff';
  offset: number;
  nextOffset: number | null;
  total: number;
  hasMore: boolean;
  partial: boolean;
  truncated: boolean;
  toolCalls?: OutputToolCall[];
  diff?: {
    source: 'opencode-snapshot';
    scope: 'user-message';
    sourceMessageId: string;
    snapshotId: string;
    observedAt: number;
    completeness: 'not-guaranteed';
    compacted: boolean;
    view: 'stat' | 'patch';
    files?: OutputDiffFile[];
    patch?: { fileIndex: number; file?: string };
  };
}

export type InfoSection = 'server' | 'models' | 'agents' | 'roots';

export interface InfoInput {
  section?: InfoSection;
  cwd?: string;
  provider?: string;
  offset?: number;
  limit?: number;
  snapshotId?: string;
}

export interface InfoResult {
  kind: 'info';
  status: 'ok';
  content: string;
  section: InfoSection;
  truncated: boolean;
  server?: {
    mcpVersion: string;
    serverInstanceId: string;
    mode: 'managed' | 'attach';
    remotePaths: boolean;
    connectionState: 'not_started' | 'connected' | 'unavailable';
    opencodeVersion: string | null;
    defaults: {
      cwd: string;
      model: string | null;
      agent: string | null;
      sandbox: Sandbox;
      approvalPolicy: ApprovalPolicy;
      turnTimeoutSeconds: number;
      maxTurnTimeoutSeconds: number;
      contextGuard?: ContextGuard;
    };
    limits: {
      maxOutputChars: number;
      structuredContentBudget: 45000;
      maxWaitSeconds: 600;
      maxBatchIds: 16;
      outputRetention: { ttlSeconds: number; maxTurns: number; maxBytes: number };
      requestIds: { maxRecords: number; ttlSeconds: number };
      maxSessions?: number;
      maxRunningTurns?: number | null;
      maxQueuedTurns?: number;
      queueTimeoutSeconds?: number | null;
    };
    concurrency?: {
      running: number;
      queued: number;
      heldUnknown: number;
      available: number | null;
      perModel: Array<{ model: string; maxRunning: number; running: number; queued: number }>;
      perModelTotal: number;
      perModelTruncated: boolean;
    };
    capabilities: string[];
    sandboxEnforcement: 'permission-profile';
  };
  models?: Array<{
    model: string; providerId: string; modelId: string; defaultForProvider: boolean; toolcall?: boolean;
    limit?: { context?: number; input?: number; output?: number };
    usableInputTokens?: number;
    limitSource?: 'opencode' | 'profile' | 'mixed';
    maxRunning?: number;
    serverDefault?: boolean;
  }>;
  agents?: Array<{ name: string; mode: 'primary' | 'all' }>;
  roots?: string[];
  snapshotId?: string;
  observedAt?: number;
  availability?: 'advertised';
  offset?: number;
  nextOffset?: number | null;
  total?: number;
}

export interface BatchStatusInput {
  ids: string[];
  waitFor?: 'any' | 'all';
  waitSeconds?: number;
}

export interface BatchItem {
  sessionId: string;
  status: TurnStatus | 'idle' | 'error';
  turnId?: string;
  turn?: number;
  model?: string;
  queue?: TurnQueueInfo;
  queuedMs?: number;
  context?: TurnContextInfo;
  executionState?: ExecutionState;
  cleanup?: 'complete' | 'unconfirmed';
  /** engine content (server-capped); MCP applies the aggregate budget */
  content: string;
  error?: TurnResult['error'];
  toolCallCount?: number;
  filesChangedCount?: number;
  pendingApprovalCount?: number;
  output?: TurnOutputMeta;
  structuredOutputStatus?: StructuredOutputStatus;
  // overload design §B: the same outcome/observation metadata as the item's TurnResult.
  finish?: TurnResult['finish'];
  warnings?: TurnResult['warnings'];
  resendSafety?: TurnResult['resendSafety'];
  upstreamRetry?: TurnResult['upstreamRetry'];
  upstreamRead?: TurnResult['upstreamRead'];
  responseLoop?: TurnResult['responseLoop'];
}

export interface BatchResult {
  kind: 'batch';
  status: 'ready' | 'waiting';
  content: string;
  waitFor: 'any' | 'all';
  reason: 'condition' | 'deadline';
  results: BatchItem[];
  readyIds: string[];
  pendingIds: string[];
  truncated: boolean;
}

export interface EngineDeps {
  config: Config;
  connection: Connection;
  logger: Logger;
  clock: Clock;
}

/** createEngine(deps: EngineDeps): Engine — src/core/engine.ts */
export interface Engine {
  start(input: StartInput, ctx: CallContext): Promise<TurnResult>;
  reply(input: ReplyInput, ctx: CallContext): Promise<TurnResult>;
  status(input: { sessionId: string; waitSeconds?: number }, ctx: CallContext): Promise<TurnResult>;
  list(): Promise<ListResult>;
  cancel(input: { sessionId: string }, ctx: CallContext): Promise<TurnResult>;
  end(input: { sessionId: string; action?: EndAction }, ctx: CallContext): Promise<EndResult>;
  /** Idempotent. Stops admission, aborts running turns, rejects leftover permissions, ends sessions when onExit === 'end', closes the connection (in finally). */
  shutdown(reason: string): Promise<void>;

  // v0.3 (§9): output, info and statusMany are required. The MCP layer keeps a fallback
  // for legacy runtime implementations that lack a newer method.
  output(input: OutputInput, ctx: CallContext): Promise<OutputResult>;
  info(input: InfoInput, ctx: CallContext): Promise<InfoResult>;
  statusMany(input: BatchStatusInput, ctx: CallContext): Promise<BatchResult>;
}

export type EngineErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PATH_NOT_ALLOWED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'OPENCODE_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  // overload design §B: admission/read failures with HTTP 429/503/529 (provider back-pressure or
  // temporary unavailability). 502/504 stay transient UPSTREAM_ERROR — a gateway failure is not
  // necessarily overload.
  | 'OPENCODE_OVERLOADED'
  | 'SUBMISSION_UNCONFIRMED'
  | 'CLEANUP_UNCONFIRMED'
  | 'TURN_INCOMPLETE'
  | 'SHUTTING_DOWN'
  | 'INTERNAL'
  // v0.3 (§9)
  | 'TURN_NOT_FOUND'
  | 'OUTPUT_NOT_READY'
  | 'OUTPUT_UNAVAILABLE'
  | 'OUTPUT_LIMIT_TOO_SMALL'
  | 'SNAPSHOT_EXPIRED'
  | 'UPSTREAM_RESPONSE_TOO_LARGE'
  | 'INVALID_OUTPUT_SCHEMA'
  | 'REQUEST_ID_CONFLICT'
  | 'REQUEST_UNCONFIRMED'
  | 'REQUEST_PENDING'
  | 'REQUEST_ENDED'
  | 'REQUEST_CAPACITY'
  // FY-2 (v0.3 features contract follow-up fixes)
  | 'SESSION_CAPACITY'
  // Context concurrency design: run queue capacity and a prompt that exceeds known usable context.
  | 'RUN_QUEUE_CAPACITY'
  | 'PROMPT_TOO_LARGE';

export class EngineError extends Error {
  code: EngineErrorCode;
  sessionId?: string;
  /** OPENCODE_OVERLOADED only: the upstream Retry-After delay (seconds), when one was given. */
  retryAfterSeconds?: number;
  constructor(code: EngineErrorCode, message: string, sessionId?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.sessionId = sessionId;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** structuredContent for isError results of every tool. */
export interface ErrorResult {
  kind: 'error';
  status: 'failed';
  sessionId?: string;
  threadId?: string;
  content: string;
  error: { name: EngineErrorCode; message: string };
  /** short recovery guidance for the calling model, keyed by error.name (src/mcp/tools.ts) */
  hint?: string;
}
