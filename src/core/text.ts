/** UTF-16 surrogate range boundaries. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * `head`/`tail` are UTF-16 code-unit slices of a larger string (e.g. either side of a truncation
 * marker). A cut can land inside a surrogate pair, leaving `head` ending with a lone high surrogate
 * or `tail` starting with a lone low surrogate; either one makes the reassembled string ill-formed
 * (JSON.stringify emits it as a bare `\udXXX` escape). Drop that one dangling code unit from each
 * side so the pieces recombine into a well-formed string. Each side loses at most one character.
 */
export function trimDanglingSurrogates(head: string, tail: string): { head: string; tail: string } {
  let h = head;
  if (h.length > 0) {
    const code = h.charCodeAt(h.length - 1);
    if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) h = h.slice(0, -1);
  }
  let t = tail;
  if (t.length > 0) {
    const code = t.charCodeAt(0);
    if (code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) t = t.slice(1);
  }
  return { head: h, tail: t };
}

/**
 * Slice `value` to at most `maxLen` UTF-16 code units without ever leaving a dangling half of a
 * surrogate pair at the cut point (plain `String.prototype.slice` can do that, and
 * `JSON.stringify` then re-escapes the lone code unit as a bare `\udXXX`). Loses at most one extra
 * character versus a raw slice. Never use this for identifiers that must round-trip exactly
 * (session/approval/turn ids): those must be kept whole or omitted, never shortened.
 */
export function safeSlice(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return trimDanglingSurrogates(value.slice(0, maxLen), '').head;
}
