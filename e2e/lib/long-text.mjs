// Deterministic long-text generator shared between e2e/fake-llm-server.mjs (the `LONG_REPLY
// <chars>` directive) and e2e/features.test.mjs, so both sides compute byte-for-byte the same
// text without ever needing to transmit it over the wire for comparison (the fake LLM only ever
// receives the requested length, never the text itself).
//
// Mixes CJK filler (each character is a single UTF-16 code unit) with an emoji (U+1F600, an
// astral-plane character encoded as a 2-code-unit surrogate pair) placed at two fixed anchor
// offsets — 255/256 and 3999/4000 — so that opencode-output's UTF-16 paging (v0.3 features
// contract §1: "offset must be on a character boundary ... chunks end
// on a character boundary") is exercised across a real surrogate-pair boundary on the very FIRST
// page for both limit:256 (naive end=256) and limit:4000 (naive end=4000). A few more emoji are
// scattered every 777 code units through the tail purely for extra multi-byte coverage; their
// exact placement is not load-bearing for any specific assertion.

const FILLER = '가나다라마바사아자차카타파하quick brown fox jumps 0123456789';
const EMOJI = '\u{1F600}'; // 😀, UTF-16 surrogate pair 😀

/** Deterministically builds a string of exactly `totalChars` UTF-16 code units. */
export function buildLongText(totalChars) {
  if (!Number.isInteger(totalChars) || totalChars < 4100) {
    throw new Error('buildLongText requires an integer totalChars >= 4100 (room for both anchor emoji)');
  }
  const out = [];
  let len = 0;
  let fillerIndex = 0;
  const pushFiller = () => {
    out.push(FILLER[fillerIndex % FILLER.length]);
    fillerIndex++;
    len++;
  };
  const pushEmoji = () => {
    out.push(EMOJI);
    len += EMOJI.length; // 2 UTF-16 code units
  };

  // Filler up to code-unit offset 255, then an emoji spanning code units [255,256] — straddles the
  // first limit:256 page boundary (opencode-output offset=0, limit=256 -> naive end=256).
  while (len < 255) pushFiller();
  pushEmoji();

  // Filler up to code-unit offset 3999, then an emoji spanning [3999,4000] — straddles the first
  // limit:4000 page boundary.
  while (len < 3999) pushFiller();
  pushEmoji();

  // Tail filler with a scattered emoji every 777 code units (only when it fits without overshoot).
  let nextScatteredEmoji = len + 777;
  while (len < totalChars) {
    if (len === nextScatteredEmoji && len + EMOJI.length <= totalChars) {
      pushEmoji();
      nextScatteredEmoji = len + 777;
      continue;
    }
    pushFiller();
  }

  const text = out.join('');
  if (text.length !== totalChars) {
    // Defensive: paging assertions below assume this generator is exact.
    throw new Error(`buildLongText produced length ${text.length}, expected ${totalChars}`);
  }
  return text;
}
