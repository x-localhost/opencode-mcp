// Model limit projection, OpenCode usable-budget math and context counting (context-concurrency
// design §5.2; docs/design.md §13). Formulas mirror OpenCode 1.18.33 session/overflow.ts:10-20 and
// provider/transform.ts:18,1481-1483.
import type { ModelProfile, OcTokens } from '../types.ts';

/** Known-finite OpenCode token limits for one model; any field may be unknown. */
export interface ModelLimit { context?: number; input?: number; output?: number }

/** A merged (profile-over-opencode) limit plus the derived usable budget and run cap. */
export interface ResolvedModelLimit {
  limit: ModelLimit;
  usableInputTokens?: number;
  limitSource: 'opencode' | 'profile' | 'mixed';
  maxRunning?: number;
}

/** Validates printable, bounded catalog identifiers. */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

const MAX_LIMIT_VALUE = 100_000_000;
const MAX_ENTRIES = 4096;
const OUTPUT_TOKEN_MAX = 32_000;
const COMPACTION_RESERVED_DEFAULT = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite integer limit field in OpenCode's accepted 1..100000000 range. */
function validLimitField(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) &&
    value >= 1 && value <= MAX_LIMIT_VALUE;
}

/**
 * Projects a raw `/provider` body into an allowlisted `provider/model` -> limit map: connected
 * providers only (same id rules as discovery.ts's projectModels), every model status kept (a
 * deprecated model can still be requested), only finite 1..100000000 limit fields kept, at most
 * 4096 entries. Never retains any other upstream data (options/apiKey/headers/api/cost/raw).
 */
export function projectModelLimits(providerResponse: unknown): Map<string, ModelLimit> {
  const limits = new Map<string, ModelLimit>();
  if (!isRecord(providerResponse)) return limits;
  const connected = providerResponse.connected;
  const all = providerResponse.all;
  if (!Array.isArray(connected) || !Array.isArray(all)) return limits;
  const connectedIds = new Set<string>();
  for (const id of connected) if (validId(id) && !id.includes('/')) connectedIds.add(id);
  for (const rawProvider of all) {
    if (limits.size >= MAX_ENTRIES) break;
    if (!isRecord(rawProvider)) continue;
    const providerId = rawProvider.id;
    if (!validId(providerId) || providerId.includes('/') || !connectedIds.has(providerId)) continue;
    const models = rawProvider.models;
    if (!isRecord(models)) continue;
    for (const [modelId, rawModel] of Object.entries(models)) {
      if (limits.size >= MAX_ENTRIES) break;
      if (!validId(modelId) || !isRecord(rawModel)) continue;
      const rawLimit = rawModel.limit;
      if (!isRecord(rawLimit)) continue;
      const limit: ModelLimit = {};
      if (validLimitField(rawLimit.context)) limit.context = rawLimit.context;
      if (validLimitField(rawLimit.input)) limit.input = rawLimit.input;
      if (validLimitField(rawLimit.output)) limit.output = rawLimit.output;
      if (limit.context === undefined && limit.input === undefined && limit.output === undefined) continue;
      limits.set(`${providerId}/${modelId}`, limit);
    }
  }
  return limits;
}

/**
 * OpenCode's usable input budget (overflow.ts:10-20), with `compaction.reserved` unknown (so the
 * default `min(20000, maxOut)` reservation always applies):
 *   maxOut = min(output ?? 0, 32000) || 32000
 *   usable = input > 0 ? max(0, input - min(20000, maxOut)) : context > 0 ? max(0, context - maxOut) : unknown
 * A result of 0 is reported as unknown (nothing fits, but 0 reads as "no data" everywhere else here).
 */
export function usableInputTokens(limit: ModelLimit): number | undefined {
  const maxOut = Math.min(limit.output ?? 0, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
  let usable: number | undefined;
  if (limit.input !== undefined && limit.input > 0) {
    usable = Math.max(0, limit.input - Math.min(COMPACTION_RESERVED_DEFAULT, maxOut));
  } else if (limit.context !== undefined && limit.context > 0) {
    usable = Math.max(0, limit.context - maxOut);
  }
  return usable ? usable : undefined;
}

/**
 * Per-field merge of an OpenCode-reported limit and an operator profile; the profile wins field by
 * field. `limitSource` is 'profile' only when every present limit field came from the profile,
 * 'opencode' when none did (including when no limit field is present at all — a profile that only
 * sets `maxRunning` never turns this into 'profile'), else 'mixed'. Returns undefined when there is
 * neither a limit field from either side nor a `maxRunning`.
 */
export function resolveModelLimit(
  model: string,
  upstream: ModelLimit | undefined,
  profile: ModelProfile | undefined,
): ResolvedModelLimit | undefined {
  void model; // not used in the merge itself; kept so callers can pass the model uniformly
  const limit: ModelLimit = {};
  let fromProfile = 0;
  let fromUpstream = 0;
  for (const field of ['context', 'input', 'output'] as const) {
    const profileValue = profile?.[field];
    const upstreamValue = upstream?.[field];
    if (profileValue !== undefined) { limit[field] = profileValue; fromProfile++; }
    else if (upstreamValue !== undefined) { limit[field] = upstreamValue; fromUpstream++; }
  }
  const totalPresent = fromProfile + fromUpstream;
  const maxRunning = profile?.maxRunning;
  if (totalPresent === 0 && maxRunning === undefined) return undefined;
  const limitSource: 'opencode' | 'profile' | 'mixed' =
    totalPresent === 0 ? 'opencode' : fromUpstream === 0 ? 'profile' : fromProfile === 0 ? 'opencode' : 'mixed';
  const result: ResolvedModelLimit = { limit, limitSource };
  const usable = usableInputTokens(limit);
  if (usable !== undefined) result.usableInputTokens = usable;
  if (maxRunning !== undefined) result.maxRunning = maxRunning;
  return result;
}

/**
 * OpenCode's overflow count (overflow.ts:22-34): `tokens.total` when it is a positive finite
 * number, else `input + output + cache.read + cache.write` when input/output are finite numbers.
 * Missing or non-finite/negative data is reported as unknown, never as 0.
 */
export function contextCount(tokens: OcTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  if (typeof tokens.total === 'number' && Number.isFinite(tokens.total) && tokens.total > 0) return tokens.total;
  const { input, output, cache } = tokens;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return undefined;
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return undefined;
  const read = cache?.read;
  if (read !== undefined && (typeof read !== 'number' || !Number.isFinite(read) || read < 0)) return undefined;
  const write = cache?.write;
  if (write !== undefined && (typeof write !== 'number' || !Number.isFinite(write) || write < 0)) return undefined;
  return input + output + (read ?? 0) + (write ?? 0);
}

/** Deliberately rough prompt-size estimate: ceil(asciiChars/4) + ceil(nonAsciiCodePoints/2). */
export function estimatePromptTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + Math.ceil(nonAscii / 2);
}

/** Shared wording for the prompt-size guard's rejection (context-concurrency design §5.4), used by
 * both the engine's synchronous pre-check and the turn's in-turn fallback so the two stay in sync. */
export function promptTooLargeMessage(model: string, estimatedTokens: number, usableTokens: number): string {
  return `Estimated prompt size (~${estimatedTokens} tokens, heuristic) exceeds ${model}'s input budget (${usableTokens} tokens). Nothing was submitted.`;
}
