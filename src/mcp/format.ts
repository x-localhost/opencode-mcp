// formatResult(result, opts) — the size budget and text rendering of design.md §4.6, extended by
// v0.3 features contract §§1/3/5/9 for `detail`/`max-output-chars`
// per-call presentation and the three new result kinds (`output`, `info`, `batch`).
//
// The engine never sees `detail`/`max-output-chars`: it always returns content already capped at
// the server `maxOutputChars`. Every per-call presentation choice — the effective content cap,
// compact-mode field omission, and the final hard-budget envelope fit — happens only in this file.
//
// Bounds every variable-length field first (content head+tail, error message, every display-only
// string field incl. session title/directory/status, path/title/pattern lengths, array sizes
// including patterns-per-approval), then — only if the serialized JSON is still >= 45,000 chars —
// applies a deterministic reduction order per kind until it fits. The final JSON string itself is
// never sliced; only field values are rebuilt smaller before re-serializing.
// `sessionId`/`threadId`/`turnId`, `status`, `error.name` and `truncated` are never touched by any
// reduction step — and neither is any other identifier (`request.id`, model/agent/root names,
// diff file paths): those are only ever dropped whole (never shortened), per §0's invariant.

import type {
  BatchResult,
  EndResult,
  ErrorResult,
  InfoResult,
  ListResult,
  OutputResult,
  TurnResult,
} from '../types.ts';
import { trimDanglingSurrogates } from '../core/text.ts';

const HARD_BUDGET = 45000;
const CONTENT_FLOOR = 200;
const ERROR_MESSAGE_MAX = 2000;
const SHORT_FIELD_MAX = 300;
const FILES_CHANGED_MAX = 200;
const TOOL_CALLS_MAX = 20;
const PENDING_APPROVALS_MAX = 10;
const PATTERNS_PER_APPROVAL_MAX = 20;
const SESSIONS_MAX = 100;

// v0.3 §1: per-call content-cap defaults (before intersecting with the server cap).
const COMPACT_CONTENT_DEFAULT = 2000;
const STANDARD_CONTENT_DEFAULT = 44000;
// v0.3 §3: batch's aggregate answer budget default (before intersecting with the server cap).
const BATCH_AGGREGATE_DEFAULT = 8000;
// v0.3 §5/§1: generous, fixed bounds for the mostly-engine-bounded `info`/`output` list/text
// fields — the engine already caps these (limit <= 100, section text limit <= 20000), so these
// exist only as this module's own defensive floor against an adversarial/buggy engine, matching
// the property-tested posture the rest of this file already takes for TurnResult/ListResult.
const INFO_CONTENT_MAX = 4000;
const INFO_LIST_MAX = 100;
const BATCH_TOP_CONTENT_MAX = 2000;

// overload design §B: upstream-derived free-text field bounds ("Bounds and lifecycle" —
// "finish display value: 64", "At most three warnings, each
// message at most 200 characters", "Retry message: one line, 200 characters").
const FINISH_MAX = 64;
const WARNING_MESSAGE_MAX = 200;
const WARNINGS_MAX = 3;
const RETRY_MESSAGE_MAX = 200;

// Last-resort fallback bounds (F4 review finding: the fallback itself must be provably bounded —
// a 50,000-char upstream error.name, copied unchanged, still produced 50,328 chars despite
// truncated=true). Every field the fallback can carry gets an explicit cap, including fields that
// are already short fixed strings today (kind/status/content/error.message) — defensive against a
// future edit accidentally making one of them dynamic/long again.
/** The one exception to "ids are never truncated" elsewhere in this module: the last-resort
 * fallback below, where the alternative is emitting something over HARD_BUDGET entirely. */
const FALLBACK_ID_MAX = 200;
const FALLBACK_STATUS_MAX = 100;
const FALLBACK_ERROR_NAME_MAX = 100;
const FALLBACK_MESSAGE_MAX = 500;
const FALLBACK_CONTENT_MAX = 1000;
const FALLBACK_CONTENT =
  '(output omitted: the result exceeded the maximum size even after every other reduction)';

/** Every kind this module can format. `formatResult` dispatches on `.kind`. */
export type FormattableResult = TurnResult | ListResult | EndResult | ErrorResult | OutputResult | InfoResult | BatchResult;

export interface FormatResultOptions {
  /** Server cap (config.maxOutputChars); always > 0 (src/config.ts:parsePositiveInt). */
  maxOutputChars: number;
  /** Per-call presentation (opencode/opencode-reply/single-session opencode-status only); never
   * persisted, never sent to the engine, never changes execution or retained output. */
  detail?: 'standard' | 'compact';
  /** Per-call `max-output-chars` override, 0..44000 (v0.3 §1). For a `batch` result this is the
   * AGGREGATE answer budget split across items (v0.3 §3), not a per-field content cap. */
  callMaxOutputChars?: number;
}

export interface FormattedResult {
  structuredContent: Record<string, unknown>;
  text: string;
  truncated: boolean;
}

function truncateEnd(s: string, max: number): { value: string; truncated: boolean } {
  // Mid-review finding 9: a cap smaller than the marker itself must never emit the whole marker
  // (the cap would be exceeded). truncateEnd's marker is 1 char, so this only bites at max <= 0.
  if (max <= 0) return { value: '', truncated: s.length > 0 };
  if (s.length <= max) return { value: s, truncated: false };
  const marker = '…'; // …
  const cut = Math.max(0, max - marker.length);
  const { head } = trimDanglingSurrogates(s.slice(0, cut), '');
  return { value: head + marker, truncated: true };
}

function truncateMiddle(s: string, max: number): { value: string; truncated: boolean } {
  // Mid-review finding 9: max-output-chars can legally be any integer 0..44000, including values
  // below the 15-char marker's own length — the old code always emitted the FULL marker in that
  // case (keep = max(0, max-15) = 0, tail = 0, value = '' + marker = 15 chars), exceeding the cap.
  if (max <= 0) return { value: '', truncated: s.length > 0 };
  if (s.length <= max) return { value: s, truncated: false };
  const marker = '\n…[truncated]…\n';
  if (max < marker.length) {
    // No room for the marker itself: degrade to a plain head cut, still respecting the cap
    // exactly (no truncation marker text is better than silently exceeding the caller's cap).
    const { head } = trimDanglingSurrogates(s.slice(0, max), '');
    return { value: head, truncated: true };
  }
  const keep = max - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const { head: headPiece, tail: tailPiece } = trimDanglingSurrogates(
    s.slice(0, head),
    tail > 0 ? s.slice(s.length - tail) : '',
  );
  const value = tail > 0 ? headPiece + marker + tailPiece : headPiece + marker;
  return { value, truncated: true };
}

/** Cuts to at most `max` UTF-16 code units from the head, with NO marker text (v0.3 §1: "no
 * truncation markers" for paged output/batch content) and never splitting a surrogate pair. */
function cutNoMarker(s: string, max: number): string {
  if (s.length <= max) return s;
  const { head } = trimDanglingSurrogates(s.slice(0, Math.max(0, max)), '');
  return head;
}

function computeSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Appends `name` to `working.omittedFields` (creating it if absent), de-duplicated. Called both
 * before the hard-budget measurement (compact-mode omissions) and from inside the emergency
 * shrink loop (so the field's own size is accounted for on the loop's next iteration — the same
 * "set the field before measuring" fix as `truncated` below, R6). */
function pushOmitted(working: Record<string, unknown>, name: string): void {
  const existing = Array.isArray(working.omittedFields) ? (working.omittedFields as string[]) : [];
  if (!existing.includes(name)) working.omittedFields = [...existing, name];
}

/** Truncates `record[key]` in place (end-truncation with a marker) if it is an oversized string.
 * No-op (and returns false) if the field is absent or not a string. Used for every display-only
 * variable-length field so no single field can dominate the size budget — ids that callers must
 * echo back verbatim (sessionId/threadId/turnId, per-item ids, request.id) are deliberately never
 * passed through this. */
function boundStringField(record: Record<string, unknown>, key: string, max: number): boolean {
  const v = record[key];
  if (typeof v !== 'string') return false;
  const t = truncateEnd(v, max);
  if (t.truncated) {
    record[key] = t.value;
  }
  return t.truncated;
}

// ---------------------------------------------------------------------------
// overload design §B: upstream-derived field bounding and sanitization
// ---------------------------------------------------------------------------

/** Removes ASCII control characters (including newlines/tabs) from an upstream-derived free-text
 * field, replacing each run with a single space — these strings ultimately come from a provider or
 * gateway response, never from this server's own fixed vocabulary, so they must never be echoed
 * back to the caller with embedded control characters. */
function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
}

/** Sanitizes (strips control chars) then end-truncates an upstream-derived string field in place.
 * No-op (returns false) if the field is absent or not a string. Reports `true` whenever the value
 * changed at all (stripped or truncated), so the caller can fold that into its own `truncated`
 * flag — unlike `boundStringField`, which only reports the length-truncation case (this module's
 * pre-existing display-only fields, e.g. `hint`/`directory`, never carry raw control characters
 * from an untrusted source, so they use the plain helper). */
function boundUpstreamString(record: Record<string, unknown>, key: string, max: number): boolean {
  const v = record[key];
  if (typeof v !== 'string') return false;
  const cleaned = stripControlChars(v);
  const t = truncateEnd(cleaned, max);
  record[key] = t.value;
  return t.truncated || cleaned !== v;
}

/** Bounds every overload-design (§B) upstream-derived field that can appear on a turn-like object
 * — `finish` (<=64 chars), each `warnings[].message` (<=200 chars, at most 3 entries) and
 * `upstreamRetry.message` (<=200 chars) — every one stripped of control characters/newlines first
 * (the overload design "Bounds and lifecycle"). `upstreamRead`/`responseLoop` carry no free-text fields
 * (only enums/numbers) and so need no bounding here. Shared by `formatTurnLike` (the top-level
 * TurnResult/ErrorResult/EndResult/ListResult object) and `formatBatchResult` (per item) so both
 * stay bounded identically (BatchItem carries the same optional fields, src/types.ts). Returns
 * true if anything was changed. */
function boundOverloadFields(working: Record<string, unknown>): boolean {
  let changed = false;
  if (boundUpstreamString(working, 'finish', FINISH_MAX)) changed = true;

  if (Array.isArray(working.warnings)) {
    let arr = working.warnings as Array<Record<string, unknown>>;
    if (arr.length > WARNINGS_MAX) {
      arr = arr.slice(0, WARNINGS_MAX);
      changed = true;
    }
    working.warnings = arr.map((w) => {
      const copy = { ...w };
      if (boundUpstreamString(copy, 'message', WARNING_MESSAGE_MAX)) changed = true;
      return copy;
    });
  }

  if (working.upstreamRetry && typeof working.upstreamRetry === 'object') {
    const ur = { ...(working.upstreamRetry as Record<string, unknown>) };
    if (boundUpstreamString(ur, 'message', RETRY_MESSAGE_MAX)) changed = true;
    working.upstreamRetry = ur;
  }

  return changed;
}

const JSON_PARSE_ERROR_PREFIX = 'JSON parsing failed:';
const JSON_PARSE_SANITIZED_MESSAGE = 'The model provider returned a malformed streaming response.';
// The response-loop watchdog design's exact recommended hint text for this case.
const JSON_PARSE_HINT =
  'OpenCode could not parse a response. Check the model/gateway response format; inspect partial ' +
  'effects before retrying.';

/** Response-loop watchdog design: "The observed error message embeds the malformed provider chunk. Replace
 * that public message with the bounded generic parsing explanation; do not copy the embedded
 * response excerpt into hints or diagnostics." Replaces an UnknownError "JSON parsing failed: ..."
 * message in place with a fixed, bounded, non-leaking sentence. Returns true if it applied, so the
 * caller can also surface JSON_PARSE_HINT (single-turn results only: a BatchItem's `error` has no
 * `hint` field of its own to append to). Idempotent: a no-op (false) once the message no longer
 * starts with the sentinel prefix — i.e. harmless if the engine already sanitized it. */
function sanitizeJsonParsingError(err: Record<string, unknown>): boolean {
  if (err.name !== 'UnknownError') return false;
  if (typeof err.message !== 'string' || !err.message.startsWith(JSON_PARSE_ERROR_PREFIX)) return false;
  err.message = JSON_PARSE_SANITIZED_MESSAGE;
  return true;
}

/** Appends `addition` to `working.hint` (creating it if absent, and never duplicating it if
 * already present) — used only for the JSON-parsing sanitization hint above, which is additional
 * guidance alongside whatever hint the engine/buildErrorResult already produced, never a
 * replacement for it. */
function appendHint(working: Record<string, unknown>, addition: string): void {
  const existing = typeof working.hint === 'string' ? working.hint : '';
  if (existing.includes(addition)) return;
  working.hint = existing.length > 0 ? `${existing} ${addition}` : addition;
}

/**
 * Repeatedly applies, in this fixed order, the cheapest reduction that still applies: drop
 * toolCalls entirely, halve filesChanged from the tail, halve sessions from the tail, halve
 * pendingApprovals from the tail (recording a true pendingApprovalCount the first time it is
 * touched, v0.3 §1 "shrink approval display details (keep counts)"), shrink the content window,
 * or — only once content is already at its floor — drop a valid `structuredOutput` WHOLE (never
 * altering its fields, v0.3 §6) and record it in `omittedFields`. Stops once the object is under
 * HARD_BUDGET or nothing more can be reduced.
 */
function shrinkToBudget(
  working: Record<string, unknown>,
  originalContent: string,
  initialContentBudget: number,
  originalPendingApprovalsCount: number | undefined,
  originalFilesChangedCount: number | undefined,
  originalSessionsCount: number | undefined,
): boolean {
  let truncated = false;
  let contentBudget = initialContentBudget;
  let guard = 0;
  while (computeSize(working) >= HARD_BUDGET && guard < 200) {
    guard += 1;
    if (Array.isArray(working.toolCalls) && working.toolCalls.length > 0) {
      working.toolCalls = [];
      pushOmitted(working, 'toolCalls');
      truncated = true;
      continue;
    }
    if (Array.isArray(working.filesChanged) && working.filesChanged.length > 0) {
      // Mid-review finding 10: record the true count / field name here too, the first time this
      // array is touched by ANY reduction step (the up-front cap may already have set it).
      if (working.filesChangedCount === undefined && originalFilesChangedCount !== undefined) {
        working.filesChangedCount = originalFilesChangedCount;
      }
      pushOmitted(working, 'filesChanged');
      const next = Math.floor(working.filesChanged.length / 2);
      working.filesChanged = (working.filesChanged as unknown[]).slice(0, next);
      truncated = true;
      continue;
    }
    if (Array.isArray(working.sessions) && working.sessions.length > 0) {
      if (working.sessionsCount === undefined && originalSessionsCount !== undefined) {
        working.sessionsCount = originalSessionsCount;
      }
      pushOmitted(working, 'sessions');
      const next = Math.floor(working.sessions.length / 2);
      working.sessions = (working.sessions as unknown[]).slice(0, next);
      truncated = true;
      continue;
    }
    if (Array.isArray(working.pendingApprovals) && working.pendingApprovals.length > 0) {
      if (working.pendingApprovalCount === undefined && originalPendingApprovalsCount !== undefined) {
        working.pendingApprovalCount = originalPendingApprovalsCount;
      }
      pushOmitted(working, 'pendingApprovals');
      const next = Math.floor(working.pendingApprovals.length / 2);
      working.pendingApprovals = (working.pendingApprovals as unknown[]).slice(0, next);
      truncated = true;
      continue;
    }
    if (contentBudget > CONTENT_FLOOR) {
      contentBudget = Math.max(CONTENT_FLOOR, Math.floor(contentBudget / 2));
      working.content = truncateMiddle(originalContent, contentBudget).value;
      truncated = true;
      continue;
    }
    if (working.structuredOutput !== undefined) {
      delete working.structuredOutput;
      pushOmitted(working, 'structuredOutput');
      truncated = true;
      continue;
    }
    break;
  }
  return truncated;
}

// Context-concurrency design §6: one-line text-mirror renderings of TurnQueueInfo/TurnContextInfo,
// shared by the top-level turn-like text (renderTurnLikeText) and each batch item
// (renderBatchText) so both stay worded identically. `queue` only appears while a turn is waiting
// for a run slot; the global-vs-model wording matches this server's own queued-turn heartbeat text
// ("Queued for an OpenCode run slot (position 3; 4/4 running)." / "... for corp/big
// (position 1; model 2/2 running).").
function renderQueueLine(queue: Record<string, unknown>): string {
  const position = typeof queue.position === 'number' ? queue.position : '?';
  if (queue.blockedBy === 'model' && typeof queue.model === 'string') {
    const modelRunning = typeof queue.modelRunning === 'number' ? queue.modelRunning : '?';
    const modelMaxRunning = typeof queue.modelMaxRunning === 'number' ? queue.modelMaxRunning : '?';
    return `queued: position ${position} for ${queue.model} (model ${modelRunning}/${modelMaxRunning} running)`;
  }
  const running = typeof queue.running === 'number' ? queue.running : '?';
  const maxRunning = queue.maxRunning === null ? 'unlimited' : typeof queue.maxRunning === 'number' ? queue.maxRunning : '?';
  return `queued: position ${position} (${running}/${maxRunning} running)`;
}

// design.md §3/§5.3: `84% of 123904 (model)` when a usable budget/ratio is known, else a plain
// `used N (model)` once only `used` is known (e.g. a profile-less, limit-less model).
function renderContextLine(context: Record<string, unknown>): string | undefined {
  const model = typeof context.model === 'string' ? context.model : undefined;
  if (!model) return undefined;
  if (typeof context.ratio === 'number' && typeof context.usableInputTokens === 'number') {
    return `context: ${Math.round(context.ratio * 100)}% of ${context.usableInputTokens} (${model})`;
  }
  if (typeof context.used === 'number') {
    return `context: used ${context.used} (${model})`;
  }
  return undefined;
}

function renderTurnLikeText(working: Record<string, unknown>, kind: string): string {
  const sessionId = typeof working.sessionId === 'string' ? working.sessionId : undefined;
  const status = typeof working.status === 'string' ? working.status : 'unknown';
  const lines: string[] = [`[opencode] ${kind}${sessionId ? ` ${sessionId}` : ''} status=${status}`];

  if (typeof working.content === 'string' && working.content.length > 0) {
    lines.push(working.content);
  }
  // Context-concurrency design §6: queue/context text mirrors, right after the answer so a
  // text-only client sees immediately why `content` is empty (queued) or how full the window is.
  if (working.queue && typeof working.queue === 'object') {
    lines.push(renderQueueLine(working.queue as Record<string, unknown>));
  }
  if (working.context && typeof working.context === 'object') {
    const contextLine = renderContextLine(working.context as Record<string, unknown>);
    if (contextLine) lines.push(contextLine);
  }
  if (typeof working.finish === 'string' && working.finish.length > 0) {
    lines.push(`finish: ${working.finish}`);
  }
  if (working.error && typeof working.error === 'object') {
    const err = working.error as Record<string, unknown>;
    if (typeof err.name === 'string') {
      lines.push(`error: ${err.name}: ${typeof err.message === 'string' ? err.message : ''}`);
    }
  }
  // overload design §B: short, one-line-per-field presentation of the new turn outcome/observation
  // metadata (response-loop watchdog design's "MCP presentation" examples: "warning: TRUNCATED — …",
  // "resend-safety: inspect_effects", "upstream: retrying model provider (attempt 3), next retry
  // in 8s", "reads: delayed (HTTP 503), next check at <ISO time>", "response-loop: 6 unusable responses
  // in 10s (empty)"). Durations are computed from the object's OWN paired timestamps
  // (nextAt/observedAt, nextAt/since), never from wall-clock "now" — this module has no clock.
  if (Array.isArray(working.warnings) && working.warnings.length > 0) {
    for (const w of working.warnings as Array<Record<string, unknown>>) {
      const code = typeof w.code === 'string' ? w.code : '?';
      const message = typeof w.message === 'string' ? w.message : '';
      lines.push(`warning: ${code} — ${message}`);
    }
  }
  if (typeof working.resendSafety === 'string') {
    lines.push(`resend-safety: ${working.resendSafety}`);
  }
  if (working.upstreamRetry && typeof working.upstreamRetry === 'object') {
    const ur = working.upstreamRetry as Record<string, unknown>;
    const attempt = typeof ur.attempt === 'number' ? ur.attempt : '?';
    const message = typeof ur.message === 'string' && ur.message.length > 0 ? ur.message : 'retrying model provider';
    let suffix = '';
    if (typeof ur.nextAt === 'number' && typeof ur.observedAt === 'number' && ur.nextAt >= ur.observedAt) {
      suffix = `, next retry in ${Math.round((ur.nextAt - ur.observedAt) / 1000)}s`;
    }
    lines.push(`upstream: ${message} (attempt ${attempt})${suffix}`);
  }
  if (working.upstreamRead && typeof working.upstreamRead === 'object') {
    const rd = working.upstreamRead as Record<string, unknown>;
    const detail =
      typeof rd.statusCode === 'number' ? `HTTP ${rd.statusCode}` : typeof rd.reason === 'string' ? rd.reason : 'degraded';
    // `since` is when reads became degraded, not when this snapshot was taken, so `nextAt - since`
    // is not a countdown; with no clock here, print the scheduled time itself.
    const suffix =
      typeof rd.nextAt === 'number' && Number.isFinite(rd.nextAt) ? `, next check at ${new Date(rd.nextAt).toISOString()}` : '';
    lines.push(`reads: delayed (${detail})${suffix}`);
  }
  if (working.responseLoop && typeof working.responseLoop === 'object') {
    const rl = working.responseLoop as Record<string, unknown>;
    const count = typeof rl.count === 'number' ? rl.count : '?';
    const windowSecs = typeof rl.windowMs === 'number' ? Math.round(rl.windowMs / 1000) : '?';
    const pattern = typeof rl.pattern === 'string' ? rl.pattern : '?';
    lines.push(`response-loop: ${count} unusable responses in ${windowSecs}s (${pattern})`);
  }
  if (Array.isArray(working.filesChanged) && working.filesChanged.length > 0) {
    lines.push(`files: ${(working.filesChanged as string[]).join(', ')}`);
  }
  if (Array.isArray(working.toolCalls) && working.toolCalls.length > 0) {
    const summary = (working.toolCalls as Array<Record<string, unknown>>)
      .map((tc) => `${tc.tool ?? '?'}:${tc.status ?? '?'}${tc.title ? ` ${tc.title}` : ''}`)
      .join(', ');
    lines.push(`tools: ${summary}`);
  }
  if (Array.isArray(working.pendingApprovals) && working.pendingApprovals.length > 0) {
    const summary = (working.pendingApprovals as Array<Record<string, unknown>>)
      .map((pa) => `${pa.permission ?? '?'} (${Array.isArray(pa.patterns) ? (pa.patterns as string[]).join(',') : ''})`)
      .join('; ');
    lines.push(`pendingApprovals: ${summary}`);
  }
  if (Array.isArray(working.sessions)) {
    const list = working.sessions as unknown[];
    const versionSuffix = typeof working.opencodeVersion === 'string' ? ` (opencode ${working.opencodeVersion})` : '';
    lines.push(`sessions: ${list.length}${versionSuffix}`);
  }
  if (typeof working.toolCallCount === 'number') lines.push(`toolCallCount: ${working.toolCallCount}`);
  if (typeof working.filesChangedCount === 'number') lines.push(`filesChangedCount: ${working.filesChangedCount}`);
  if (typeof working.pendingApprovalCount === 'number') lines.push(`pendingApprovalCount: ${working.pendingApprovalCount}`);
  if (typeof working.structuredOutputStatus === 'string') {
    lines.push(`structuredOutputStatus: ${working.structuredOutputStatus}`);
  }
  if (working.request && typeof working.request === 'object') {
    const req = working.request as Record<string, unknown>;
    if (typeof req.id === 'string') lines.push(`request: ${req.id}${req.replayed ? ' (replayed)' : ''}`);
  }
  if (Array.isArray(working.omittedFields) && working.omittedFields.length > 0) {
    lines.push(`omitted: ${(working.omittedFields as string[]).join(', ')}`);
  }
  if (typeof working.hint === 'string' && working.hint.length > 0) {
    lines.push(`hint: ${working.hint}`);
  }

  return lines.join('\n');
}

function renderOutputText(working: Record<string, unknown>): string {
  const sessionId = typeof working.sessionId === 'string' ? working.sessionId : undefined;
  const section = typeof working.section === 'string' ? working.section : 'answer';
  const turn = typeof working.turn === 'number' ? working.turn : undefined;
  const offset = typeof working.offset === 'number' ? working.offset : 0;
  const nextOffset = working.nextOffset === null ? 'null' : typeof working.nextOffset === 'number' ? working.nextOffset : '?';
  const hasMore = Boolean(working.hasMore);
  const total = typeof working.total === 'number' ? ` total=${working.total}` : '';
  // Mid-review finding 7: the text mirror must carry the SAME continuation data (nextOffset) that
  // structuredContent does — a text-only client re-reading this cursor must be able to resume
  // paging exactly as if it had read structuredContent.nextOffset.
  const lines: string[] = [
    `[opencode] output${sessionId ? ` ${sessionId}` : ''} turn=${turn ?? '?'} section=${section} offset=${offset} ` +
      `nextOffset=${nextOffset} hasMore=${hasMore}${total}`,
  ];
  if (typeof working.content === 'string' && working.content.length > 0) lines.push(working.content);
  if (Array.isArray(working.toolCalls) && working.toolCalls.length > 0) {
    const summary = (working.toolCalls as Array<Record<string, unknown>>)
      .map((tc) => `${tc.tool ?? '?'}:${tc.status ?? '?'}${tc.title ? ` ${tc.title}` : ''}`)
      .join(', ');
    lines.push(`tools: ${summary}`);
  }
  if (working.diff && typeof working.diff === 'object') {
    const diff = working.diff as Record<string, unknown>;
    if (typeof diff.snapshotId === 'string') lines.push(`snapshotId: ${diff.snapshotId}`);
    if (Array.isArray(diff.files) && diff.files.length > 0) {
      const summary = (diff.files as Array<Record<string, unknown>>)
        .map((f) => `${f.file ?? `#${f.fileIndex}`}${f.status ? ` (${f.status})` : ''} +${f.additions ?? 0}/-${f.deletions ?? 0}`)
        .join(', ');
      lines.push(`diff files: ${summary}`);
    }
    if (diff.patch && typeof diff.patch === 'object') {
      const patch = diff.patch as Record<string, unknown>;
      lines.push(`diff patch file: ${patch.file ?? `#${patch.fileIndex}`}`);
    }
  }
  if (working.partial === true) lines.push('partial: true');
  return lines.join('\n');
}

// Context-concurrency design §5.2/§6: `corp/coding-model ctx=128000 out=4096 usable=123904
// maxRunning=2`. Only fields actually present on this model's info item are rendered, in
// ModelLimit's own field order (context, input, output), then usableInputTokens/maxRunning, then
// a trailing " (server default)" when serverDefault is true. Identifiers (the model id itself) are
// never shortened by this line — the surrounding array-shrink logic below only ever drops whole
// entries.
function formatModelLine(m: Record<string, unknown>): string {
  const parts: string[] = [String(m.model ?? '?')];
  const limit = m.limit && typeof m.limit === 'object' ? (m.limit as Record<string, unknown>) : undefined;
  if (limit) {
    if (typeof limit.context === 'number') parts.push(`ctx=${limit.context}`);
    if (typeof limit.input === 'number') parts.push(`in=${limit.input}`);
    if (typeof limit.output === 'number') parts.push(`out=${limit.output}`);
  }
  if (typeof m.usableInputTokens === 'number') parts.push(`usable=${m.usableInputTokens}`);
  if (typeof m.maxRunning === 'number') parts.push(`maxRunning=${m.maxRunning}`);
  const line = parts.join(' ');
  return m.serverDefault === true ? `${line} (server default)` : line;
}

function renderInfoText(working: Record<string, unknown>): string {
  const section = typeof working.section === 'string' ? working.section : 'server';
  const lines: string[] = [`[opencode] info section=${section}`];
  if (typeof working.content === 'string' && working.content.length > 0) lines.push(working.content);
  if (typeof working.snapshotId === 'string') lines.push(`snapshotId: ${working.snapshotId}`);
  if (working.nextOffset === null) lines.push('nextOffset: null');
  else if (typeof working.nextOffset === 'number') lines.push(`nextOffset: ${working.nextOffset}`);
  if (working.server && typeof working.server === 'object') {
    const server = working.server as Record<string, unknown>;
    lines.push(`mcpVersion=${server.mcpVersion ?? '?'} mode=${server.mode ?? '?'} connectionState=${server.connectionState ?? '?'}`);
    // Context-concurrency design §4.4/§6: a live concurrency line plus the configured limits, only
    // when the engine actually supplied them (both optional on InfoResult.server).
    if (server.limits && typeof server.limits === 'object') {
      const l = server.limits as Record<string, unknown>;
      const parts: string[] = [];
      if (l.maxRunningTurns !== undefined) {
        parts.push(`maxRunningTurns=${l.maxRunningTurns === null ? 'unlimited' : l.maxRunningTurns}`);
      }
      if (l.maxQueuedTurns !== undefined) parts.push(`maxQueuedTurns=${l.maxQueuedTurns}`);
      if (l.queueTimeoutSeconds !== undefined) {
        parts.push(`queueTimeoutSeconds=${l.queueTimeoutSeconds === null ? 'disabled' : l.queueTimeoutSeconds}`);
      }
      if (parts.length > 0) lines.push(`limits: ${parts.join(' ')}`);
    }
    if (server.concurrency && typeof server.concurrency === 'object') {
      const c = server.concurrency as Record<string, unknown>;
      const limits = server.limits && typeof server.limits === 'object' ? (server.limits as Record<string, unknown>) : undefined;
      const maxRunning = limits && limits.maxRunningTurns !== undefined ? (limits.maxRunningTurns === null ? 'unlimited' : limits.maxRunningTurns) : '?';
      const running = typeof c.running === 'number' ? c.running : '?';
      const queued = typeof c.queued === 'number' ? c.queued : '?';
      const held = typeof c.heldUnknown === 'number' ? c.heldUnknown : '?';
      lines.push(`run slots: ${running}/${maxRunning} running, ${queued} queued, ${held} held`);
    }
  }
  // Mid-review finding 7: list the actual entries (model/agent names, root paths), not just a
  // count — a text-only client otherwise cannot act on this result at all.
  if (Array.isArray(working.models)) {
    const names = (working.models as Array<Record<string, unknown>>).map((m) => String(m.model ?? '?')).join(', ');
    lines.push(`models (${working.models.length}): ${names}`);
    for (const m of working.models as Array<Record<string, unknown>>) {
      lines.push(formatModelLine(m));
    }
  }
  if (Array.isArray(working.agents)) {
    const names = (working.agents as Array<Record<string, unknown>>).map((a) => String(a.name ?? '?')).join(', ');
    lines.push(`agents (${working.agents.length}): ${names}`);
  }
  if (Array.isArray(working.roots)) {
    lines.push(`roots (${working.roots.length}): ${(working.roots as string[]).join(', ')}`);
  }
  if (Array.isArray(working.omittedFields) && working.omittedFields.length > 0) {
    lines.push(`omitted: ${(working.omittedFields as string[]).join(', ')}`);
  }
  return lines.join('\n');
}

function renderBatchText(working: Record<string, unknown>): string {
  const status = typeof working.status === 'string' ? working.status : 'unknown';
  const waitFor = typeof working.waitFor === 'string' ? working.waitFor : '?';
  const readyCount = Array.isArray(working.readyIds) ? (working.readyIds as unknown[]).length : 0;
  const pendingCount = Array.isArray(working.pendingIds) ? (working.pendingIds as unknown[]).length : 0;
  const lines: string[] = [`[opencode] batch status=${status} wait-for=${waitFor} ready=${readyCount} pending=${pendingCount}`];
  if (typeof working.content === 'string' && working.content.length > 0) lines.push(working.content);
  // Mid-review finding 7: carry each item's actual answer or error, not just its status — a
  // text-only client otherwise gets no usable result from a batch call at all.
  if (Array.isArray(working.results)) {
    for (const item of working.results as Array<Record<string, unknown>>) {
      const sid = typeof item.sessionId === 'string' ? item.sessionId : '?';
      const st = typeof item.status === 'string' ? item.status : '?';
      let line: string;
      if (item.error && typeof item.error === 'object') {
        const err = item.error as Record<string, unknown>;
        line = `- ${sid}: ${st} error=${err.name ?? '?'}: ${typeof err.message === 'string' ? err.message : ''}`;
      } else {
        const content = typeof item.content === 'string' ? item.content : '';
        line = `- ${sid}: ${st}${content ? ` — ${content}` : ''}`;
      }
      // overload design §B: a compact per-item indicator when this item carries the new fields.
      // Kept terse: batch items are always compact, so this never repeats the full single-turn
      // presentation above.
      const extras: string[] = [];
      if (typeof item.finish === 'string' && item.finish.length > 0) extras.push(`finish=${item.finish}`);
      if (Array.isArray(item.warnings) && item.warnings.length > 0) {
        const codes = (item.warnings as Array<Record<string, unknown>>).map((w) => String(w.code ?? '?')).join(',');
        extras.push(`warnings=${codes}`);
      }
      if (typeof item.resendSafety === 'string') extras.push(`resend=${item.resendSafety}`);
      // Context-concurrency design §6: the same queue/context one-liners as a single-turn result,
      // kept inside the bracketed extras (batch items are always compact/terse).
      if (item.queue && typeof item.queue === 'object') extras.push(renderQueueLine(item.queue as Record<string, unknown>));
      if (item.context && typeof item.context === 'object') {
        const contextLine = renderContextLine(item.context as Record<string, unknown>);
        if (contextLine) extras.push(contextLine);
      }
      lines.push(extras.length > 0 ? `${line} [${extras.join(' ')}]` : line);
    }
  }
  return lines.join('\n');
}

function renderText(working: Record<string, unknown>, kind: string): string {
  if (kind === 'output') return renderOutputText(working);
  if (kind === 'info') return renderInfoText(working);
  if (kind === 'batch') return renderBatchText(working);
  return renderTurnLikeText(working, kind);
}

/** Last-resort fallback (R6/F4): a minimal, provably-bounded object — kind/status/content, ids
 * either kept verbatim (when they already fit within FALLBACK_ID_MAX) or omitted entirely (A11/
 * F-P3-5: never shortened — a truncated id is not a real, usable identifier, e.g. `sessionId +
 * "#" + turn` can exceed FALLBACK_ID_MAX even when sessionId alone does not, and slicing it would
 * silently produce a different, wrong turn's id), and error.name only (never the upstream
 * error.message, which is unbounded free text) — every field explicitly bounded, not just the
 * ones that happen to be short today. Used only when every other per-field bound plus the full
 * shrink order still left the object at or over HARD_BUDGET. Shared by every
 * turn-like/sessions/end/error/info/output kind: for `info` this necessarily drops
 * `models`/`agents`/`roots` entirely, which is an acceptable last resort only because it is
 * provably unreachable in practice (info caps at 100 items and a 4000-char content cap) — the
 * alternative is emitting something over HARD_BUDGET entirely. `batch` never reaches this path:
 * mid-review finding 2 gives it its own dedicated fallback, buildBatchTooLargeError, so that a
 * batch's requested ids are never silently reported as missing. */
function buildMinimalFallback(working: Record<string, unknown>): Record<string, unknown> {
  const minimal: Record<string, unknown> = {
    kind: typeof working.kind === 'string' ? truncateEnd(working.kind, FALLBACK_STATUS_MAX).value : working.kind,
    status: typeof working.status === 'string' ? truncateEnd(working.status, FALLBACK_STATUS_MAX).value : working.status,
    truncated: true,
    content: truncateEnd(FALLBACK_CONTENT, FALLBACK_CONTENT_MAX).value,
  };
  for (const key of ['sessionId', 'threadId', 'turnId']) {
    const value = working[key];
    if (typeof value !== 'string') continue;
    if (value.length <= FALLBACK_ID_MAX) {
      minimal[key] = value;
    } else {
      // Omit rather than truncate (A11/F-P3-5): a shortened id could be mistaken for a real,
      // different identifier instead of plainly saying this one could not be reported.
      pushOmitted(minimal, key);
    }
  }
  if (working.error && typeof working.error === 'object') {
    const err = working.error as Record<string, unknown>;
    if (typeof err.name === 'string') {
      minimal.error = {
        name: truncateEnd(err.name, FALLBACK_ERROR_NAME_MAX).value,
        message: truncateEnd(FALLBACK_CONTENT, FALLBACK_MESSAGE_MAX).value,
      };
    }
  }
  return minimal;
}

// ---------------------------------------------------------------------------
// kind: turn / sessions / end / error (design.md §4.6, extended by v0.3 §1/§6/§9)
// ---------------------------------------------------------------------------

function formatTurnLike(
  result: TurnResult | ListResult | EndResult | ErrorResult,
  opts: FormatResultOptions,
): FormattedResult {
  const compact = opts.detail === 'compact';
  // v0.3 §1: "effective content cap: min(serverCap, max-output-chars ?? (compact ? 2000 : 44000));
  // 0 -> empty content, everything else kept." Replaces the old `opts.maxOutputChars > 0 ? ... :
  // 20000` fallback and the 200-char floor for this initial cap (CONTENT_FLOOR still applies only
  // inside the emergency shrink loop below, an unrelated hard-budget-of-last-resort mechanism).
  const perCallDefault = compact ? COMPACT_CONTENT_DEFAULT : STANDARD_CONTENT_DEFAULT;
  const perCallCap = opts.callMaxOutputChars ?? perCallDefault;
  const maxOutputChars = Math.max(0, Math.min(opts.maxOutputChars, perCallCap));

  const working: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  let truncated = Boolean(working.truncated);

  // ListResult has no natural `status`; synthesize one so the single shared
  // outputSchema (kind/status/content all required) validates for every kind.
  if (working.kind === 'sessions' && typeof working.status !== 'string') {
    working.status = 'ok';
  }

  const originalContent = typeof working.content === 'string' ? working.content : '';
  // Captured from the untouched result, before any per-field capping below, so a compact-mode
  // count (or an emergency-shrink count, v0.3 §1 "shrink approval display details (keep counts)")
  // always reflects the TRUE original size, not what survived an earlier cap.
  const originalPendingApprovalsCount = Array.isArray(working.pendingApprovals)
    ? (working.pendingApprovals as unknown[]).length
    : undefined;
  const originalFilesChangedCount = Array.isArray(working.filesChanged)
    ? (working.filesChanged as unknown[]).length
    : undefined;
  const originalSessionsCount = Array.isArray(working.sessions) ? (working.sessions as unknown[]).length : undefined;

  if (maxOutputChars <= 0) {
    if (originalContent.length > 0) truncated = true;
    working.content = '';
  } else {
    const t = truncateMiddle(originalContent, maxOutputChars);
    working.content = t.value;
    if (t.truncated) truncated = true;
  }

  if (working.error && typeof working.error === 'object') {
    const err = { ...(working.error as Record<string, unknown>) };
    // response-loop watchdog design: an UnknownError "JSON parsing failed: ..." message embeds the
    // malformed provider chunk — replace it with a fixed, bounded sentence BEFORE the generic
    // length bound below (harmless no-op if the engine already sanitized it), and surface the
    // matching recovery hint alongside whatever hint this result already carries.
    const sanitizedJsonError = sanitizeJsonParsingError(err);
    if (typeof err.message === 'string') {
      const t = truncateEnd(err.message, ERROR_MESSAGE_MAX);
      err.message = t.value;
      if (t.truncated) truncated = true;
    }
    working.error = err;
    if (sanitizedJsonError) {
      truncated = true;
      appendHint(working, JSON_PARSE_HINT);
    }
  }

  // v0.3 §6: structuredOutputError.message is upstream-influenced free text; bound it the same
  // way as error.message. structuredOutputError.code and structuredOutput itself are never
  // touched here (a valid structuredOutput may only ever be omitted WHOLE, see shrinkToBudget).
  if (working.structuredOutputError && typeof working.structuredOutputError === 'object') {
    const soe = { ...(working.structuredOutputError as Record<string, unknown>) };
    if (typeof soe.message === 'string') {
      const t = truncateEnd(soe.message, ERROR_MESSAGE_MAX);
      soe.message = t.value;
      if (t.truncated) truncated = true;
    }
    working.structuredOutputError = soe;
  }

  // overload design §B: bound `finish`/`warnings[].message`/`upstreamRetry.message` (control-char
  // stripped + length-capped). Done before the generic `hint` bound below, so a hint this JSON-
  // parsing sanitization just appended is itself capped along with every other display field.
  if (boundOverloadFields(working)) truncated = true;

  // Every other display-only top-level string field (never sessionId/threadId/turnId/status,
  // which callers must be able to echo back verbatim to continue a session).
  for (const key of ['directory', 'agent', 'model', 'hint', 'action']) {
    if (boundStringField(working, key, SHORT_FIELD_MAX)) truncated = true;
  }

  if (Array.isArray(working.filesChanged)) {
    let arr = working.filesChanged as unknown[];
    if (arr.length > FILES_CHANGED_MAX) {
      arr = arr.slice(0, FILES_CHANGED_MAX);
      truncated = true;
      // Mid-review finding 10: every array reduction (not just detail:"compact") records the
      // true original count and the field name, so a partial array is never mistaken for the
      // whole thing (v0.3 §0's invariant, applied outside compact mode too).
      working.filesChangedCount = originalFilesChangedCount ?? arr.length;
      pushOmitted(working, 'filesChanged');
    }
    working.filesChanged = arr.map((p) => {
      if (typeof p !== 'string') return p;
      const t = truncateEnd(p, SHORT_FIELD_MAX);
      if (t.truncated) truncated = true;
      return t.value;
    });
  }

  if (Array.isArray(working.toolCalls)) {
    let arr = working.toolCalls as Array<Record<string, unknown>>;
    if (arr.length > TOOL_CALLS_MAX) {
      arr = arr.slice(arr.length - TOOL_CALLS_MAX);
      truncated = true;
      // Mid-review finding 10: name the field in omittedFields whenever it's not fully shown,
      // in standard mode too (toolCallCount already exists as the true original count on every
      // TurnResult, independent of this array, so no separate count field is needed here).
      pushOmitted(working, 'toolCalls');
    }
    working.toolCalls = arr.map((tc) => {
      const copy = { ...tc };
      if (boundStringField(copy, 'tool', SHORT_FIELD_MAX)) truncated = true;
      if (boundStringField(copy, 'status', SHORT_FIELD_MAX)) truncated = true;
      if (boundStringField(copy, 'title', SHORT_FIELD_MAX)) truncated = true;
      return copy;
    });
  }

  if (Array.isArray(working.pendingApprovals)) {
    let arr = working.pendingApprovals as Array<Record<string, unknown>>;
    if (arr.length > PENDING_APPROVALS_MAX) {
      arr = arr.slice(0, PENDING_APPROVALS_MAX);
      truncated = true;
      // Mid-review finding 10: record the true count and name the field, in standard mode too.
      working.pendingApprovalCount = originalPendingApprovalsCount ?? arr.length;
      pushOmitted(working, 'pendingApprovals');
    }
    working.pendingApprovals = arr.map((pa) => {
      const copy = { ...pa };
      if (boundStringField(copy, 'permission', SHORT_FIELD_MAX)) truncated = true;
      if (Array.isArray(copy.patterns)) {
        let patterns = copy.patterns as unknown[];
        // The number of patterns per approval is itself unbounded input (an OpenCode permission
        // request), independent of each pattern's own string length — capping only the string
        // length left a single approval with e.g. 10,000 one-char patterns able to blow the whole
        // budget on its own.
        if (patterns.length > PATTERNS_PER_APPROVAL_MAX) {
          patterns = patterns.slice(0, PATTERNS_PER_APPROVAL_MAX);
          truncated = true;
        }
        copy.patterns = patterns.map((p) => {
          if (typeof p !== 'string') return p;
          const t = truncateEnd(p, SHORT_FIELD_MAX);
          if (t.truncated) truncated = true;
          return t.value;
        });
      }
      return copy;
    });
  }

  if (Array.isArray(working.sessions)) {
    let arr = working.sessions as Array<Record<string, unknown>>;
    if (arr.length > SESSIONS_MAX) {
      arr = arr.slice(0, SESSIONS_MAX);
      truncated = true;
      // Mid-review finding 10: record the true original session count and name the field.
      working.sessionsCount = originalSessionsCount ?? arr.length;
      pushOmitted(working, 'sessions');
    }
    working.sessions = arr.map((s) => {
      const copy = { ...s };
      if (boundStringField(copy, 'title', SHORT_FIELD_MAX)) truncated = true;
      if (boundStringField(copy, 'directory', SHORT_FIELD_MAX)) truncated = true;
      if (boundStringField(copy, 'status', SHORT_FIELD_MAX)) truncated = true;
      return copy;
    });
  }

  // v0.3 §1: compact omits toolCalls and filesChanged (keeps toolCallCount, adds
  // filesChangedCount and pendingApprovalCount — pendingApprovals itself stays present), and
  // lists the omitted field names.
  if (compact && working.kind === 'turn') {
    if ('toolCalls' in working) {
      delete working.toolCalls;
      pushOmitted(working, 'toolCalls');
    }
    if ('filesChanged' in working) {
      working.filesChangedCount = originalFilesChangedCount ?? 0;
      delete working.filesChanged;
      pushOmitted(working, 'filesChanged');
    }
    if (originalPendingApprovalsCount !== undefined) {
      working.pendingApprovalCount = originalPendingApprovalsCount;
    }
  }

  // Set `truncated` BEFORE measuring/shrinking against HARD_BUDGET, not after: for EndResult and
  // ErrorResult (which have no `truncated` field of their own), this line adds a brand-new key,
  // and checking the budget beforehand let a borderline object (e.g. 44,999 chars) tip over the
  // limit (e.g. 45,017) once this field was appended afterward (review finding R6). Re-set after a
  // shrink too, in case shrinking itself is what flips `truncated` from false to true (harmless
  // either way: "true" is one character shorter than "false", so this can only ever shrink it).
  working.truncated = truncated;

  if (computeSize(working) >= HARD_BUDGET) {
    if (
      shrinkToBudget(
        working,
        originalContent,
        maxOutputChars,
        originalPendingApprovalsCount,
        originalFilesChangedCount,
        originalSessionsCount,
      )
    ) {
      truncated = true;
      working.truncated = true;
    }
  }

  // Last-resort safety net (R6): every field above is bounded, but an id (sessionId/threadId/
  // turnId) is deliberately never touched by any reduction step above, since callers must be able
  // to echo it back verbatim to continue a session — so a pathological id that somehow bypasses
  // the input-schema bound (src/mcp/tools.ts's max(200), for every path that isn't a plain schema
  // violation) could still blow the budget on its own. If the object is still at or over budget
  // after every other reduction, replace it entirely with a minimal, provably-bounded object
  // instead of ever emitting something >= HARD_BUDGET.
  let finalWorking = working;
  if (computeSize(finalWorking) >= HARD_BUDGET) {
    finalWorking = buildMinimalFallback(finalWorking);
    truncated = true;
  }

  const text = renderText(finalWorking, String(finalWorking.kind));
  return { structuredContent: finalWorking, text, truncated };
}

// ---------------------------------------------------------------------------
// kind: output (v0.3 §1/§2/§9)
// ---------------------------------------------------------------------------

/** Mid-review finding 4: a page (list, diff, or text) that cannot even fit ONE item/unit
 * alongside the rest of the envelope must never come back as a non-advancing "successful" empty
 * page (same nextOffset/offset, status "ok", hasMore true) — a caller retrying that would loop
 * forever. Return a bounded ErrorResult instead, so the caller sees an actionable failure. */
function buildOutputTooLargeError(result: OutputResult, opts: FormatResultOptions): FormattedResult {
  const message =
    `The retained output for turn ${result.turn}, section "${result.section}", could not be paged: ` +
    `even a single item at offset ${result.offset} does not fit this response's size budget.`;
  const errorResult: ErrorResult = {
    kind: 'error',
    status: 'failed',
    sessionId: result.sessionId,
    threadId: result.threadId,
    content: message,
    error: { name: 'OUTPUT_UNAVAILABLE', message },
    hint:
      'Try a different offset (e.g. skip ahead), a narrower diff-view/section, or fewer items per page; ' +
      'this single item/unit is too large for any response, not just this page.',
  };
  return formatTurnLike(errorResult, opts);
}

function formatOutputResult(result: OutputResult, opts: FormatResultOptions): FormattedResult {
  const working: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  let truncated = Boolean(working.truncated);

  // Per-field bounds on display-only metadata before measuring. Tool-call titles are display
  // text (never re-supplied by the caller), so they may be shortened; every identifier below
  // (messageId/callId/tool, and every diff file path) is left untouched here — an oversized
  // identifier is the engine's responsibility to cap or drop (v0.3 §5's "item dropped, never
  // shortened" posture), and this module never invents a shortened one.
  if (Array.isArray(working.toolCalls)) {
    working.toolCalls = (working.toolCalls as Array<Record<string, unknown>>).map((tc) => {
      const copy = { ...tc };
      if (boundStringField(copy, 'title', SHORT_FIELD_MAX)) truncated = true;
      return copy;
    });
  }

  working.truncated = truncated;

  const section = typeof working.section === 'string' ? working.section : 'answer';
  const diffView =
    working.diff && typeof working.diff === 'object' ? (working.diff as Record<string, unknown>).view : undefined;
  const isArrayPage = section === 'tool-calls' || (section === 'diff' && diffView === 'stat');

  // v0.3 §1/§2: "if the page does not fit, shorten the page text (never splitting a surrogate
  // pair), recompute nextOffset = offset + emitted length and hasMore, set truncated only for
  // information actually discarded (not for normal paging)." For array-shaped pages (tool-calls,
  // diff stat) the paging unit is items, not characters, so "emitted length" is the item count.
  // Mid-review finding 4: every reduction step below must make POSITIVE progress — halving a
  // 1-item (or already-empty-string) page down to nothing, while the object still doesn't fit, is
  // a dead end (the next call would see the identical problem at the identical offset) — that
  // case returns a bounded error instead of an empty "success" page.
  let guard = 0;
  while (computeSize(working) >= HARD_BUDGET && guard < 200) {
    guard += 1;
    const offset = typeof working.offset === 'number' ? working.offset : 0;
    const total = typeof working.total === 'number' ? working.total : undefined;

    if (isArrayPage) {
      if (section === 'tool-calls') {
        const arr = working.toolCalls;
        if (!Array.isArray(arr) || arr.length === 0) break;
        const nextLen = Math.floor(arr.length / 2);
        if (nextLen === 0) return buildOutputTooLargeError(result, opts);
        const emitted = (arr as unknown[]).slice(0, nextLen);
        working.toolCalls = emitted;
        working.nextOffset = offset + emitted.length;
        working.hasMore = total === undefined ? true : offset + emitted.length < total;
        working.truncated = true;
        truncated = true;
        continue;
      }
      const diff = working.diff && typeof working.diff === 'object' ? (working.diff as Record<string, unknown>) : undefined;
      const files = diff?.files;
      if (!diff || !Array.isArray(files) || files.length === 0) break;
      const nextLen = Math.floor(files.length / 2);
      if (nextLen === 0) return buildOutputTooLargeError(result, opts);
      const emitted = (files as unknown[]).slice(0, nextLen);
      working.diff = { ...diff, files: emitted };
      working.nextOffset = offset + emitted.length;
      working.hasMore = total === undefined ? true : offset + emitted.length < total;
      working.truncated = true;
      truncated = true;
      continue;
    }

    // Text page: answer / structured-output / diff patch view (v0.3 §2: "content = patch slice").
    const content = typeof working.content === 'string' ? working.content : '';
    if (content.length === 0) break;
    const nextLen = Math.floor(content.length / 2);
    if (nextLen === 0) return buildOutputTooLargeError(result, opts);
    const emitted = cutNoMarker(content, nextLen);
    working.content = emitted;
    working.nextOffset = offset + emitted.length;
    working.hasMore = total === undefined ? true : offset + emitted.length < total;
    working.truncated = true;
    truncated = true;
  }

  let finalWorking = working;
  if (computeSize(finalWorking) >= HARD_BUDGET) {
    finalWorking = buildMinimalFallback(finalWorking);
    truncated = true;
  }

  const text = renderText(finalWorking, 'output');
  return { structuredContent: finalWorking, text, truncated };
}

// ---------------------------------------------------------------------------
// kind: info (v0.3 §5/§9)
// ---------------------------------------------------------------------------

/** Mid-review findings 3/8: recomputes nextOffset from what was ACTUALLY kept (never leaves a
 * stale/null cursor a caller would use to skip the dropped entries), and prevents a dropped page
 * from being taken as "hasMore was already false" — the array itself is the only "more data"
 * signal InfoResult carries (it has no separate hasMore field). No-op if nothing was dropped. */
function shrinkInfoArray(working: Record<string, unknown>, key: 'models' | 'agents' | 'roots', newLength: number): void {
  const arr = working[key];
  if (!Array.isArray(arr) || newLength >= arr.length) return;
  working[key] = arr.slice(0, newLength);
  const offset = typeof working.offset === 'number' ? working.offset : 0;
  working.nextOffset = offset + newLength;
  pushOmitted(working, key);
}

function formatInfoResult(result: InfoResult, opts: FormatResultOptions): FormattedResult {
  void opts; // info has no per-call detail/max-output-chars (v0.3 §5); only the server cap applies.
  const working: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  let truncated = Boolean(working.truncated);
  const originalContent = typeof working.content === 'string' ? working.content : '';

  {
    const t = truncateMiddle(originalContent, INFO_CONTENT_MAX);
    working.content = t.value;
    if (t.truncated) truncated = true;
  }

  if (working.server && typeof working.server === 'object') {
    const server = { ...(working.server as Record<string, unknown>) };
    if (boundStringField(server, 'opencodeVersion', SHORT_FIELD_MAX)) truncated = true;
    if (server.defaults && typeof server.defaults === 'object') {
      // Mid-review finding 8: `cwd` is a usable path an operator/tool would act on — never
      // shorten it into a different, fake path. It is only ever preserved exactly or (in the
      // emergency loop below, if it still doesn't fit) omitted entirely and named in
      // omittedFields. No up-front bounding here at all.
      server.defaults = { ...(server.defaults as Record<string, unknown>) };
    }
    if (Array.isArray(server.capabilities)) {
      let caps = server.capabilities as unknown[];
      if (caps.length > INFO_LIST_MAX) {
        caps = caps.slice(0, INFO_LIST_MAX);
        truncated = true;
      }
      server.capabilities = caps.map((c) => {
        if (typeof c !== 'string') return c;
        const t = truncateEnd(c, SHORT_FIELD_MAX);
        if (t.truncated) truncated = true;
        return t.value;
      });
    }
    working.server = server;
  }

  // models/agents/roots carry identifiers (model/agent names, root paths) that must never be
  // shortened — only whole items may be dropped (v0.3 §5: "item dropped ... never shortened"),
  // both in this up-front cap (defensive against an oversized page from the engine) and in the
  // emergency loop below. Every drop recomputes nextOffset (findings 3/8).
  for (const key of ['models', 'agents', 'roots'] as const) {
    if (Array.isArray(working[key]) && (working[key] as unknown[]).length > INFO_LIST_MAX) {
      shrinkInfoArray(working, key, INFO_LIST_MAX);
      truncated = true;
    }
  }

  working.truncated = truncated;

  let guard = 0;
  while (computeSize(working) >= HARD_BUDGET && guard < 200) {
    guard += 1;
    let shrunkArray = false;
    for (const key of ['roots', 'models', 'agents'] as const) {
      const arr = working[key];
      if (Array.isArray(arr) && arr.length > 0) {
        shrinkInfoArray(working, key, Math.floor(arr.length / 2));
        shrunkArray = true;
        break;
      }
    }
    if (shrunkArray) {
      truncated = true;
      working.truncated = true;
      continue;
    }
    // Mid-review finding 8: once every array is exhausted, drop the one remaining unbounded
    // identifier-like field (server.defaults.cwd) WHOLE rather than shortening it.
    const server = working.server && typeof working.server === 'object' ? (working.server as Record<string, unknown>) : undefined;
    const defaults =
      server?.defaults && typeof server.defaults === 'object' ? (server.defaults as Record<string, unknown>) : undefined;
    if (defaults && 'cwd' in defaults) {
      delete defaults.cwd;
      pushOmitted(working, 'server.defaults.cwd');
      truncated = true;
      working.truncated = true;
      continue;
    }
    const current = typeof working.content === 'string' ? working.content : '';
    if (current.length > CONTENT_FLOOR) {
      const next = Math.max(CONTENT_FLOOR, Math.floor(current.length / 2));
      working.content = truncateMiddle(originalContent, next).value;
      truncated = true;
      working.truncated = true;
      continue;
    }
    break;
  }

  let finalWorking = working;
  if (computeSize(finalWorking) >= HARD_BUDGET) {
    finalWorking = buildMinimalFallback(finalWorking);
    truncated = true;
  }

  const text = renderText(finalWorking, 'info');
  return { structuredContent: finalWorking, text, truncated };
}

// ---------------------------------------------------------------------------
// kind: batch (v0.3 §3/§9)
// ---------------------------------------------------------------------------

/** Deterministic split of `total` chars across `n` items, in input order: base share each, with
 * the remainder distributed one-by-one starting from the first item. Same input -> same output. */
function splitBudget(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

const BATCH_ERROR_MESSAGE_FLOOR = 0;

/** Mid-review finding 2: when even every item's display fields, error messages and content have
 * been shrunk to nothing, membership (every requested id, and every item) still cannot fit —
 * never report a "ready"/"waiting" success silently missing items or ids. A bounded ErrorResult
 * takes its place instead (the analogue, for batch, of buildMinimalFallback dropping `results`
 * while still claiming kind:"batch" — this makes the failure explicit instead of silent). */
function buildBatchTooLargeError(result: BatchResult, opts: FormatResultOptions): FormattedResult {
  const count = Array.isArray(result.results) ? result.results.length : 0;
  const message =
    `The batch result for ${count} id(s) could not be reported: even after shrinking every ` +
    'item\'s content and error message to nothing, the ids alone exceed this response\'s size budget.';
  const errorResult: ErrorResult = {
    kind: 'error',
    status: 'failed',
    content: message,
    error: { name: 'INTERNAL', message },
    hint: 'Retry with fewer ids per opencode-status call (opencode-info reports maxBatchIds).',
  };
  return formatTurnLike(errorResult, opts);
}

function formatBatchResult(result: BatchResult, opts: FormatResultOptions): FormattedResult {
  const working: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  let truncated = Boolean(working.truncated);

  {
    const t = truncateMiddle(typeof working.content === 'string' ? working.content : '', BATCH_TOP_CONTENT_MAX);
    working.content = t.value;
    if (t.truncated) truncated = true;
  }

  const items = Array.isArray(working.results) ? (working.results as Array<Record<string, unknown>>) : [];
  // v0.3 §3: "max-output-chars = aggregate answer budget for the batch (default min(serverCap,
  // 8000)); batch items are always compact" — split deterministically, in input order.
  const aggregateBudget = Math.max(0, Math.min(opts.maxOutputChars, opts.callMaxOutputChars ?? BATCH_AGGREGATE_DEFAULT));
  const shares = splitBudget(aggregateBudget, items.length);

  working.results = items.map((item, i) => {
    const copy = { ...item };
    const original = typeof copy.content === 'string' ? copy.content : '';
    const share = shares[i] ?? 0;
    if (original.length > share) {
      copy.content = cutNoMarker(original, share);
      truncated = true;
    }
    if (copy.error && typeof copy.error === 'object') {
      const err = { ...(copy.error as Record<string, unknown>) };
      // See formatTurnLike's identical step: sanitize an UnknownError JSON-parsing message before
      // the generic length bound below (BatchItem has no `hint` field to append the matching hint
      // to, so only the message itself is sanitized here).
      sanitizeJsonParsingError(err);
      if (typeof err.message === 'string') {
        const t = truncateEnd(err.message, ERROR_MESSAGE_MAX);
        err.message = t.value;
        if (t.truncated) truncated = true;
      }
      copy.error = err;
    }
    // overload design §B: bound finish/warnings/upstreamRetry the same way as the top-level
    // TurnResult.
    if (boundOverloadFields(copy)) truncated = true;
    return copy;
  });

  working.truncated = truncated;

  // Emergency fit (mid-review finding 2): items and ids always stay present — never dropped, and
  // sessionId (the one identifier on a BatchItem) is never touched. Shrink display fields in this
  // order: every item's content share first (down to empty), THEN every item's error message
  // (down to empty) — a 16-item batch of mostly-control-character ids and error messages
  // previously exceeded the budget with every item's content already empty, at which point the
  // old code stopped shrinking (nothing left to touch) and fell straight to buildMinimalFallback,
  // which silently dropped `results` while still reporting kind:"batch" status:"ready".
  let guard = 0;
  while (computeSize(working) >= HARD_BUDGET && guard < 200) {
    guard += 1;
    const arr = working.results as Array<Record<string, unknown>>;

    let shrunkContent = false;
    const afterContent = arr.map((item) => {
      const content = typeof item.content === 'string' ? item.content : '';
      if (content.length === 0) return item;
      shrunkContent = true;
      return { ...item, content: cutNoMarker(content, Math.floor(content.length / 2)) };
    });
    if (shrunkContent) {
      working.results = afterContent;
      truncated = true;
      working.truncated = true;
      continue;
    }

    let shrunkError = false;
    const afterError = arr.map((item) => {
      if (item.error && typeof item.error === 'object') {
        const err = item.error as Record<string, unknown>;
        if (typeof err.message === 'string' && err.message.length > BATCH_ERROR_MESSAGE_FLOOR) {
          shrunkError = true;
          const next = Math.max(BATCH_ERROR_MESSAGE_FLOOR, Math.floor(err.message.length / 2));
          return { ...item, error: { ...err, message: cutNoMarker(err.message, next) } };
        }
      }
      return item;
    });
    if (shrunkError) {
      working.results = afterError;
      truncated = true;
      working.truncated = true;
      continue;
    }

    break;
  }

  if (computeSize(working) >= HARD_BUDGET) {
    // Every display field, error message and content share is already at its floor — the ids
    // (and other never-touched identifiers) alone exceed the budget. Never report a "batch"
    // success missing items (v0.3 §0's "never present a result as usable" invariant).
    return buildBatchTooLargeError(result, opts);
  }

  const text = renderText(working, 'batch');
  return { structuredContent: working, text, truncated };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function formatResult(result: FormattableResult, opts: FormatResultOptions): FormattedResult {
  if (result.kind === 'output') return formatOutputResult(result, opts);
  if (result.kind === 'info') return formatInfoResult(result, opts);
  if (result.kind === 'batch') return formatBatchResult(result, opts);
  return formatTurnLike(result, opts);
}
