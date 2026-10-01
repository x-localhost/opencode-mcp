import path from 'node:path';
import type { OcMessage, OcMessageError, OcPart, ToolCallSummary, TurnContextInfo, TurnResult, TurnStatus } from '../types.ts';
import { safeSlice, trimDanglingSurrogates } from './text.ts';
import type { RetainedToolCall } from './output-store.ts';
import { parseRetryAfterSeconds } from '../opencode/retry.ts';
import { contextCount } from './model-limits.ts';
import type { ResolvedModelLimit } from './model-limits.ts';

/** engine.ts's committed/keyed-fallback caches only ever need a handful of files to point someone
 * at what changed; unbounded like the interval itself would let one very large agentic turn keep an
 * ever-growing array alive in `entry.last` for the life of the session (README's documented cap). */
const MAX_FILES_CHANGED = 200;

/** Raw artifacts from the same final assistant used by classifyOutcome. */
export function extractOutputArtifacts(messages: OcMessage[]): {
  answer: string; toolCalls: RetainedToolCall[]; compacted: boolean; hasFinalAssistant: boolean;
  hasTerminalAssistant: boolean;
} {
  const final = messages.filter((message) => message.info.role === 'assistant' && message.info.summary !== true).at(-1);
  return {
    answer: final?.parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? '').join('\n') ?? '',
    hasFinalAssistant: final !== undefined,
    hasTerminalAssistant: final !== undefined && interpretFinish(final).terminal,
    compacted: messages.some((message) => message.info.summary === true ||
      (message.info.role === 'user' && (message.info.parentID !== undefined || message.info.summary !== undefined ||
        message.parts.some((part) => part.synthetic === true)))),
    toolCalls: messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool').map((part) => ({
      messageId: message.info.id,
      ...(typeof part.callID === 'string' ? { callId: part.callID } : {}),
      tool: typeof part.tool === 'string' ? part.tool : 'unknown',
      status: typeof part.state?.status === 'string' ? part.state.status : 'unknown',
      ...(typeof part.state?.title === 'string' && part.state.title ? { title: part.state.title } : {}),
    }))),
  };
}

/**
 * Return messages newer than the exclusive boundary. Pages arrive newest first;
 * when they overlap, the later fetched page replaces the entire earlier copy.
 *
 * U06 (r1-hostile-opencode-6): once the boundary message is actually located in a page, its
 * position is used as before — everything after it in fetched order is newer, which stays correct
 * even if some other message's id happens to repeat or isn't strictly monotonic. But a page that
 * does NOT contain the boundary is no longer treated as "take everything" (boundaryIndex -1 used
 * to mean that): every message in such a page is additionally required to have `info.id >
 * boundaryId` (OpenCode ids are lexically ascending; turn.ts's onEvent boundary check relies on
 * the same ordering, and this is verified against docs/research/samples). So a boundary that
 * vanishes from every fetched page can never widen the interval into earlier turns — only messages
 * a real, newer id could have produced are ever admitted — while genuinely newer content (e.g. the
 * next turn's own user/assistant messages) is still recognized once it exists.
 */
export function extractInterval(pages: OcMessage[][], boundaryId: string | undefined): OcMessage[] {
  const byId = new Map<string, OcMessage>();

  for (const page of pages) {
    const boundaryIndex =
      boundaryId === undefined ? -1 : page.findIndex((message) => message.info.id === boundaryId);
    const located = boundaryIndex >= 0;

    for (const message of page.slice(boundaryIndex + 1)) {
      if (!located && boundaryId !== undefined && !(message.info.id > boundaryId)) continue;
      const parts = new Map<string, OcPart>();
      for (const part of message.parts) parts.set(part.id, part);
      byId.set(message.info.id, { info: message.info, parts: [...parts.values()] });
    }

    if (located) break;
  }

  return [...byId.values()].sort((a, b) => {
    if (a.info.id < b.info.id) return -1;
    if (a.info.id > b.info.id) return 1;
    return 0;
  });
}

/** Evidence that the submitted root user has settled after an abort. */
export function submissionEvidence(messages: OcMessage[]): {
  userId?: string;
  assistant: 'absent' | 'pending' | 'terminal';
} {
  const userIndex = messages.findIndex((message) => message.info.role === 'user' && !message.info.parentID);
  if (userIndex < 0) return { assistant: 'absent' };
  const userId = messages[userIndex]!.info.id;
  const last = messages
    .slice(userIndex + 1)
    .filter((message) => message.info.role === 'assistant' && message.info.summary !== true)
    .at(-1);
  if (!last) return { userId, assistant: 'absent' };
  return {
    userId,
    assistant: interpretFinish(last).terminal ? 'terminal' : 'pending',
  };
}

const transient = new Set([408, 429, 500, 502, 503, 504, 529]);
export const MALFORMED_STREAM_MESSAGE = 'The model provider returned a malformed streaming response.';

export function providerError(error: OcMessageError, nowMs = Date.now()): NonNullable<TurnResult['error']> {
  const data = error.data;
  const rawStatus = data?.statusCode;
  const statusCode = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus : undefined;
  const rawRetry = data?.isRetryable;
  const retryable = typeof rawRetry === 'boolean' ? rawRetry : statusCode !== undefined && transient.has(statusCode) ? true : undefined;
  const headers = data?.responseHeaders;
  const retryHeader = headers && typeof headers === 'object' && !Array.isArray(headers)
    ? (headers as Record<string, unknown>)['retry-after'] : undefined;
  const retryAfterSeconds = typeof retryHeader === 'string' ? parseRetryAfterSeconds(retryHeader, nowMs) : undefined;
  const name = safeSlice(error.name, 200);
  const malformed = name === 'UnknownError' && typeof data?.message === 'string' && data.message.startsWith('JSON parsing failed:');
  return {
    name,
    message: malformed ? MALFORMED_STREAM_MESSAGE : safeSlice(typeof data?.message === 'string' ? data.message : name, 500),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(statusCode !== undefined && [429, 503, 529].includes(statusCode) ? { condition: 'MODEL_OVERLOADED' as const } : {}),
  };
}

export function observedActivity(messages: OcMessage[]): boolean {
  return messages.some((message) => message.parts.some((part) => part.type === 'tool' || part.type === 'patch'));
}

/** Termination and answer success are independent: an idle, completed assistant may have failed. */
export function interpretFinish(message: OcMessage, messages: OcMessage[] = [message], nowMs?: number, activityObserved = false): {
  terminal: boolean; successful: boolean; status?: TurnStatus; error?: TurnResult['error'];
  warnings?: TurnResult['warnings']; partial: boolean; finish?: string;
} {
  const finish = typeof message.info.finish === 'string' ? message.info.finish : undefined;
  const display = finish === undefined ? {} : { finish: safeSlice(finish, 64) };
  const activeTool = message.parts.some((part) => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status ?? ''));
  const completed = typeof message.info.time.completed === 'number' &&
    Number.isFinite(message.info.time.completed) && message.info.time.completed >= 0;
  if (message.info.error) return { terminal: true, successful: false,
    status: message.info.error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
    error: providerError(message.info.error, nowMs), partial: true, ...display };
  if (activeTool || finish === 'tool-calls' || finish === 'unknown' || !completed)
    return { terminal: false, successful: false, partial: true, ...display };
  const text = message.parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .some((part) => typeof part.text === 'string' && part.text.trim().length > 0);
  const activity = activityObserved || observedActivity(messages);
  const empty = { code: 'EMPTY_RESPONSE' as const, message: 'OpenCode finished without answer text.' };
  const truncated = { code: 'TRUNCATED' as const, message: 'The provider truncated the answer.' };
  if (finish === 'stop' || finish === 'length') {
    const warnings: NonNullable<TurnResult['warnings']> = [];
    if (finish === 'length') warnings.push(truncated);
    if (!text) {
      if (activity) warnings.push(empty);
      else return { terminal: true, successful: false, status: 'failed',
        error: { name: 'EMPTY_RESPONSE', message: empty.message, retryable: true },
        warnings: finish === 'length' ? warnings : undefined, partial: true, ...display };
    }
    return { terminal: true, successful: true, status: 'completed',
      warnings: warnings.length ? warnings : undefined, partial: warnings.length > 0, ...display };
  }
  if (finish === 'content-filter') return { terminal: true, successful: false, status: 'failed',
    error: { name: 'ContentFilterError', message: 'The provider filtered the answer.', retryable: false }, partial: true, ...display };
  return { terminal: true, successful: false, status: 'failed',
    error: { name: 'TURN_INCOMPLETE', message: 'OpenCode finished without a standard terminal answer.' },
    warnings: [{ code: 'NONSTANDARD_FINISH', message: 'OpenCode reported a nonstandard finish.' }], partial: true, ...display };
}

/** Classify only the final non-summary assistant after the root becomes idle. */
export function classifyOutcome(
  messages: OcMessage[],
  idle: boolean,
  nowMs?: number,
  activityObserved = false,
): { status: TurnStatus; error?: TurnResult['error']; warnings?: TurnResult['warnings']; partial?: boolean; finish?: string } {
  if (!idle) return { status: 'running' };

  const last = messages
    .filter((message) => message.info.role === 'assistant' && message.info.summary !== true)
    .at(-1);

  if (last) {
    const facts = interpretFinish(last, messages, nowMs, activityObserved);
    if (facts.terminal && facts.status) return { status: facts.status,
      ...(facts.error ? { error: facts.error } : {}),
      ...(facts.warnings ? { warnings: facts.warnings } : {}), partial: facts.partial,
      ...(facts.finish ? { finish: facts.finish } : {}) };
  }

  return {
    status: 'failed',
    error: {
      name: 'TURN_INCOMPLETE',
      message: 'OpenCode became idle without a terminal assistant answer',
    },
  };
}

/** No assistant text was produced yet — the placeholder depends on why, not just that it's absent
 * (design.md scopes "OpenCode finished..." to an actual completed answer; a running snapshot or a
 * turn that failed before OpenCode ran must say so instead). */
function noAnswerText(outcome: { status: TurnStatus; error?: { name: string; message: string } }): string {
  if (outcome.status === 'running' || outcome.status === 'waiting_for_approval')
    return 'No answer text yet; the turn is still running.';
  if (outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'timeout')
    return `No answer text; turn ${outcome.status}${outcome.error ? ` (${outcome.error.name})` : ''}.`;
  return 'OpenCode finished without a text answer; see toolCalls/filesChanged.';
}

/** Observed context usage from this interval's NON-summary assistants (context-concurrency design
 * §5.3): `model` is `providerID/modelID` of the LAST non-summary assistant that reported both ids;
 * `used` is OpenCode's own overflow count (model-limits.ts's `contextCount`) for THAT SAME
 * assistant only — a later assistant without usage never falls back to an earlier one; `peakUsed`
 * is the max of the same count over every non-summary assistant in the interval. */
export interface ContextUsage {
  model: string;
  used?: number;
  peakUsed?: number;
}

export interface IntervalSummary {
  content: string;
  truncated: boolean;
  filesChanged: string[];
  toolCalls: ToolCallSummary[];
  toolCallCount: number;
  tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } };
  cost?: number;
  contextUsage?: ContextUsage;
}

/** Build the public answer and compact usage details from one execution interval. `outcome` is
 * this interval's status/error (finish() passes the terminal outcome, snapshot() passes
 * `{ status: 'running' }`) so the no-answer-yet placeholder never contradicts it. */
export function summarizeInterval(
  messages: OcMessage[],
  directory: string,
  maxOutputChars: number,
  outcome: { status: TurnStatus; error?: { name: string; message: string } } = { status: 'completed' },
): IntervalSummary {
  const assistants = messages.filter((message) => message.info.role === 'assistant');
  // Match extractOutputArtifacts: an earlier answer cannot stand in for a later final assistant.
  const answer = assistants.filter((message) => message.info.summary !== true).at(-1);

  const full =
    answer?.parts
      .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? '')
      .join('\n') || noAnswerText(outcome);
  const marker = '\n...[truncated]...\n';
  const limit = Math.max(0, maxOutputChars);
  const contentTruncated = full.length > limit;
  const head = Math.max(0, Math.ceil((limit - marker.length) / 2));
  const tail = Math.max(0, limit - marker.length - head);
  const content = !contentTruncated
    ? full
    : limit <= marker.length
      ? marker.slice(0, limit)
      : (() => {
          const trimmed = trimDanglingSurrogates(full.slice(0, head), tail ? full.slice(-tail) : '');
          return trimmed.head + marker + trimmed.tail;
        })();

  const files = new Set<string>();
  const calls: ToolCallSummary[] = [];
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cost = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawCache = false;

  for (const message of messages) {
    if (message.info.role === 'assistant') {
      input += message.info.tokens?.input ?? 0;
      output += message.info.tokens?.output ?? 0;
      reasoning += message.info.tokens?.reasoning ?? 0;
      cost += message.info.cost ?? 0;
      if (message.info.tokens?.cache) {
        sawCache = true;
        cacheRead += message.info.tokens.cache.read ?? 0;
        cacheWrite += message.info.tokens.cache.write ?? 0;
      }
    }

    for (const part of message.parts) {
      if (part.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) {
          if (typeof file !== 'string') continue;
          const relative = path.relative(directory, file);
          const inside = path.isAbsolute(file) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
          files.add(inside ? relative : file);
        }
      }

      if (part.type === 'tool') {
        const title = part.state?.title;
        calls.push({
          tool: typeof part.tool === 'string' ? part.tool : 'unknown',
          status: part.state?.status ?? 'unknown',
          ...(typeof title === 'string' && title ? { title } : {}),
        });
      }
    }
  }

  let contextUsage: ContextUsage | undefined;
  {
    let peak: number | undefined;
    let lastModel: string | undefined;
    let lastUsed: number | undefined;
    for (const message of messages) {
      if (message.info.role !== 'assistant' || message.info.summary === true) continue;
      const count = contextCount(message.info.tokens);
      if (count !== undefined) peak = peak === undefined ? count : Math.max(peak, count);
      const providerID = message.info.providerID;
      const modelID = message.info.modelID;
      if (typeof providerID === 'string' && providerID && typeof modelID === 'string' && modelID) {
        lastModel = `${providerID}/${modelID}`;
        lastUsed = count;
      }
    }
    if (lastModel !== undefined)
      contextUsage = { model: lastModel, ...(lastUsed !== undefined ? { used: lastUsed } : {}),
        ...(peak !== undefined ? { peakUsed: peak } : {}) };
  }

  const allFiles = [...files];
  const filesChangedTruncated = allFiles.length > MAX_FILES_CHANGED;
  return {
    content,
    truncated: contentTruncated || calls.length > 20 || filesChangedTruncated,
    filesChanged: filesChangedTruncated ? allFiles.slice(0, MAX_FILES_CHANGED) : allFiles,
    toolCalls: calls.slice(-20),
    toolCallCount: calls.length,
    tokens: assistants.some((message) => message.info.tokens)
      ? { input, output, reasoning, ...(sawCache ? { cache: { read: cacheRead, write: cacheWrite } } : {}) }
      : undefined,
    cost: assistants.some((message) => message.info.cost !== undefined) ? cost : undefined,
    ...(contextUsage ? { contextUsage } : {}),
  };
}

/**
 * Combines a context-usage observation with this turn's compaction flag and a resolved model
 * limit into the public `TurnContextInfo`, and — when the UNROUNDED ratio reaches 0.8 — appends a
 * `CONTEXT_HIGH` warning (last, keeping at most 3 total; existing codes are kept first) and a hint
 * suffix (context-concurrency design §5.3). `baseHint`'s own selection/precedence is never changed
 * by this function — the suffix is only ever appended to whichever hint the caller already chose
 * (e.g. a response-loop or SUBMISSION_UNCONFIRMED hint keeps its own wording, with the suffix
 * tacked on the end).
 */
export function buildContextResult(
  usage: ContextUsage | undefined,
  compacted: boolean,
  resolved: ResolvedModelLimit | undefined,
  baseWarnings: TurnResult['warnings'],
  baseHint: string,
): { context?: TurnContextInfo; warnings?: TurnResult['warnings']; hint: string } {
  if (!usage) return { warnings: baseWarnings, hint: baseHint };
  const usable = resolved?.usableInputTokens;
  const context: TurnContextInfo = {
    model: usage.model,
    ...(usage.used !== undefined ? { used: usage.used } : {}),
    ...(usage.peakUsed !== undefined ? { peakUsed: usage.peakUsed } : {}),
    ...(usable !== undefined ? { usableInputTokens: usable } : {}),
    ...(resolved && Object.keys(resolved.limit).length > 0 ? { limitSource: resolved.limitSource } : {}),
    compacted,
  };
  if (usage.used === undefined || usable === undefined) return { context, warnings: baseWarnings, hint: baseHint };
  const ratio = usage.used / usable;
  context.ratio = Math.round(ratio * 1000) / 1000;
  if (ratio < 0.8) return { context, warnings: baseWarnings, hint: baseHint };
  const pct = Math.round(ratio * 100);
  const warning = {
    code: 'CONTEXT_HIGH' as const,
    message: safeSlice(
      `Last reported context usage is ${pct}% of ${usage.model}'s budget (${usage.used} of ${usable} tokens).`,
      200,
    ),
  };
  const warnings = [...(baseWarnings ?? []).slice(0, 2), warning];
  const hint = `${baseHint} Context is nearly full; continue in a new opencode session with a self-contained prompt and opencode-end this one.` +
    (resolved?.limitSource === 'profile'
      ? ' If OpenCode itself has no context limit configured for this model, it will not compact proactively.'
      : '');
  return { context, warnings, hint };
}

/** `ContextOverflowError` final-failure hint (context-concurrency design §5.3): a prompt or
 * session history that genuinely exceeded the model's context window (as opposed to a transient
 * overflow OpenCode recovered from by reactive compaction, which keeps the turn completed). */
export function contextOverflowHint(model: string): string {
  return `The prompt or session history exceeded ${model}'s context window. Split the task, start a new session, or choose a larger-context model (opencode-info section "models").`;
}

/**
 * Bound one TurnResult for a long-lived replay cache (engine.ts's committed-results and keyed
 * request-id fallback maps): every variable-length field gets the same 200/20-item caps the README
 * documents, with two invariants no ordinary truncation may break:
 *  - identifiers (approval id, approval sessionId) are never shortened into something that no
 *    longer matches anything upstream — an over-long one is omitted entirely, not sliced;
 *  - every other string slice is surrogate-safe (`text.ts#safeSlice`), so a cut can never leave a
 *    lone surrogate that `JSON.stringify` would re-escape as a bare `\udXXX`.
 * `truncated` and the (possibly shorter) array lengths are how a caller learns detail was omitted;
 * there is no separate "how many were dropped" counter.
 */
export function compactResult(result: TurnResult): TurnResult {
  const { structuredOutput: _structuredOutput, ...copy } = result;
  const content = safeSlice(result.content, 4096);
  const boundedApprovals = result.pendingApprovals
    .filter((approval) => approval.id.length <= 200 && approval.sessionId.length <= 200)
    .slice(0, 20);
  const omitted =
    content.length !== result.content.length ||
    result.structuredOutput !== undefined ||
    result.filesChanged.length > 20 ||
    result.toolCalls.length > 20 ||
    result.pendingApprovals.length > boundedApprovals.length;
  return {
    ...copy,
    content,
    truncated: result.truncated || omitted,
    directory: safeSlice(result.directory, 4096),
    ...(result.agent ? { agent: safeSlice(result.agent, 200) } : {}),
    ...(result.model ? { model: safeSlice(result.model, 200) } : {}),
    filesChanged: result.filesChanged.slice(0, 20).map((file) => safeSlice(file, 200)),
    toolCalls: result.toolCalls.slice(0, 20).map((call) => ({
      tool: safeSlice(call.tool, 200),
      status: safeSlice(call.status, 200),
      ...(call.title ? { title: safeSlice(call.title, 200) } : {}),
    })),
    pendingApprovals: boundedApprovals.map((approval) => ({
      id: approval.id,
      sessionId: approval.sessionId,
      permission: safeSlice(approval.permission, 200),
      patterns: approval.patterns.slice(0, 20).map((p) => safeSlice(p, 200)),
    })),
    hint: `${safeSlice(result.hint, 400)}${omitted ? ' Some replay detail is omitted; use opencode-output where available.' : ''}`,
    ...(result.error ? { error: { ...result.error, name: safeSlice(result.error.name, 200), message: safeSlice(result.error.message, 500) } } : {}),
    ...(result.structuredOutputError
      ? {
          structuredOutputError: {
            code: safeSlice(result.structuredOutputError.code, 200),
            message: safeSlice(result.structuredOutputError.message, 200),
          },
        }
      : {}),
  };
}
