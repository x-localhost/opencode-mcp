import type { OcMessage, TurnResult } from '../types.ts';

export type LoopPattern = NonNullable<TurnResult['responseLoop']>['pattern'];
export type LoopEvidence = NonNullable<TurnResult['responseLoop']>;
type Attempt = { completed: number; pattern: Exclude<LoopPattern, 'mixed'> };

/** Only the two unusable assistant shapes captured from OpenCode 1.18.33 count. */
export function classifyAttempt(message: OcMessage): Attempt['pattern'] | undefined {
  const info = message.info;
  if (info.role !== 'assistant' || info.summary === true || info.error ||
      typeof info.time.completed !== 'number' || !Number.isFinite(info.time.completed) || info.time.completed < 0) return undefined;
  let tools = 0;
  for (const part of message.parts) {
    if (part.type === 'step-start' || part.type === 'step-finish') continue;
    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string' || part.text.trim()) return undefined;
      continue;
    }
    if (part.type === 'tool') {
      const input = part.state?.input;
      if (part.tool !== 'invalid' || part.state?.status !== 'completed' ||
          !input || typeof input !== 'object' || Array.isArray(input) ||
          typeof (input as Record<string, unknown>).tool !== 'string' ||
          typeof (input as Record<string, unknown>).error !== 'string') return undefined;
      tools++;
      continue;
    }
    return undefined;
  }
  if (tools) return info.finish === 'tool-calls' ? 'invalid_tool' : undefined;
  return info.finish === undefined || info.finish === 'unknown' ? 'empty' : undefined;
}

/** History must be chronological and complete for this root; a newer assistant proves continuation. */
export function detectResponseLoop(
  messages: OcMessage[], rootId: string, limit: number, fencedThroughId?: string,
): LoopEvidence | undefined {
  if (limit === 0) return undefined;
  const root = messages.find((message) => message.info.id === rootId && message.info.role === 'user' && !message.info.parentID);
  if (!root) return undefined;
  const seen = new Set<string>();
  let streak: Attempt[] = [];
  let previousTime = -1;
  let candidate: LoopEvidence | undefined;
  for (const message of messages) {
    if (message.info.id <= rootId || (fencedThroughId && message.info.id <= fencedThroughId)) continue;
    if (message.info.sessionID !== root.info.sessionID || message.info.role !== 'assistant' ||
        message.info.parentID !== rootId || message.info.summary === true ||
        message.parts.some((part) => part.type === 'compaction')) {
      streak = [];
      previousTime = -1;
      candidate = undefined;
      continue;
    }
    if (seen.has(message.info.id)) continue;
    seen.add(message.info.id);
    const newestTime = message.info.time.created;
    const newerPattern = classifyAttempt(message);
    // An in-progress newer attempt that has shown nothing usable yet. OpenCode 1.18.33 streams a
    // malformed tool call as `bash` pending, then `invalid` running/completed, so a pending tool
    // part or the invalid sentinel does not make the attempt productive; a running real tool does.
    const silentNewer = typeof message.info.time.completed !== 'number' && message.info.finish === undefined &&
      !message.info.error &&
      message.parts.every((part) => part.type === 'step-start' || part.type === 'step-finish' ||
        ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && !part.text.trim()) ||
        (part.type === 'tool' && (part.tool === 'invalid' || part.state?.status === 'pending')));
    if (streak.length >= limit && (newerPattern || silentNewer) &&
        Number.isFinite(newestTime) && newestTime > streak[streak.length - 1]!.completed &&
        streak[streak.length - 1]!.completed - streak[streak.length - limit]!.completed <= 10_000) {
      const qualifying = streak.slice(-limit);
      candidate = { count: limit, windowMs: 10_000,
        pattern: qualifying.every((item) => item.pattern === 'empty') ? 'empty' :
          qualifying.every((item) => item.pattern === 'invalid_tool') ? 'invalid_tool' : 'mixed' };
    } else candidate = undefined;
    const pattern = newerPattern;
    const completed = message.info.time.completed;
    if (!pattern || completed === undefined || completed <= previousTime) {
      streak = [];
      previousTime = typeof completed === 'number' && Number.isFinite(completed) ? completed : -1;
      continue;
    }
    previousTime = completed;
    streak.push({ completed, pattern });
    if (streak.length > limit) streak = streak.slice(-limit);
    if (streak.length > 1 && completed - streak[0]!.completed > 10_000) {
      while (streak.length > 1 && completed - streak[0]!.completed > 10_000) streak.shift();
    }
  }
  return candidate;
}
