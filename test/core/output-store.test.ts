import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../fakes/fake-clock.ts';
import {
  OutputStore,
  DEFAULT_OUTPUT_STORE_LIMITS,
  type TurnArtifactInput,
  type RetainedToolCall,
  type TextPage,
  type ItemPage,
  type StoreError,
} from '../../src/core/output-store.ts';

function isError(x: unknown): x is StoreError {
  return typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
}

function artifact(overrides: Partial<TurnArtifactInput> = {}): TurnArtifactInput {
  return {
    sessionId: 'ses_1',
    turnId: 'ses_1#1',
    turn: 1,
    partial: false,
    answer: 'hello world',
    toolCalls: [],
    ...overrides,
  };
}

/** Reads every page of `section` with a fixed `limit` and concatenates the text. */
function collectText(
  store: OutputStore,
  sessionId: string,
  turn: number,
  section: 'answer' | 'structured-output',
  limit: number,
): string {
  let offset = 0;
  let out = '';
  let guard = 0;
  while (true) {
    guard++;
    if (guard > 100000) throw new Error('page loop did not terminate');
    const page = store.readText(sessionId, turn, section, offset, limit);
    assert.ok(!isError(page), `unexpected error at offset ${offset}: ${isError(page) ? page.message : ''}`);
    const p = page as TextPage;
    out += p.text;
    if (p.nextOffset === null) {
      assert.equal(p.hasMore, false);
      break;
    }
    assert.equal(p.hasMore, true);
    offset = p.nextOffset;
  }
  return out;
}

test('put/meta/readText round trip', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  const meta = store.put(artifact({ answer: 'the answer' }));
  assert.equal(meta.state, 'retained');
  if (meta.state === 'retained') {
    assert.equal(meta.answerChars, 'the answer'.length);
    assert.equal(meta.toolCallCount, 0);
    assert.equal(meta.expiresAt, DEFAULT_OUTPUT_STORE_LIMITS.ttlMs);
    assert.equal(meta.partial, false);
  }
  assert.deepEqual(store.meta('ses_1', 1), meta);
  const page = store.readText('ses_1', 1, 'answer', 0, 100);
  assert.ok(!isError(page));
  const p = page as TextPage;
  assert.equal(p.text, 'the answer');
  assert.equal(p.offset, 0);
  assert.equal(p.nextOffset, null);
  assert.equal(p.total, 10);
  assert.equal(p.hasMore, false);
  assert.equal(p.partial, false);
});

test('exact reconstruction of a long mixed-Unicode answer across page boundaries', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  const emoji = '😀'; // surrogate pair
  const music = '𝄞'; // surrogate pair
  const cjk = '中文测试字符串';
  const answer =
    'Hello world, this is plain ASCII text. ' +
    emoji.repeat(7) +
    ' mixed with ' +
    cjk.repeat(5) +
    ' and more ' +
    music.repeat(4) +
    emoji +
    cjk +
    ' tail ascii padding to make this long enough for many pages.'.repeat(3);
  store.put(artifact({ answer }));

  for (const limit of [1, 2, 3, 4, 5, 7, 11, 64, answer.length, answer.length + 1000]) {
    const rebuilt = collectText(store, 'ses_1', 1, 'answer', limit);
    assert.equal(rebuilt, answer, `mismatch at limit=${limit}`);
    assert.equal(rebuilt.length, answer.length);
  }
});

test('offset inside a surrogate pair is INVALID_ARGUMENT', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  const answer = 'ab😀cd'; // emoji at index 2-3 (surrogate pair)
  store.put(artifact({ answer }));
  const page = store.readText('ses_1', 1, 'answer', 3, 10);
  assert.ok(isError(page));
  assert.equal((page as StoreError).code, 'INVALID_ARGUMENT');
  // offset 2 (start of the pair) is fine
  const ok = store.readText('ses_1', 1, 'answer', 2, 10);
  assert.ok(!isError(ok));
});

test('offset === total returns an empty final page; offset > total is INVALID_ARGUMENT', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  store.put(artifact({ answer: 'abcde' }));
  const atEnd = store.readText('ses_1', 1, 'answer', 5, 10) as TextPage;
  assert.ok(!isError(atEnd));
  assert.equal(atEnd.text, '');
  assert.equal(atEnd.nextOffset, null);
  assert.equal(atEnd.hasMore, false);
  assert.equal(atEnd.total, 5);
  const beyond = store.readText('ses_1', 1, 'answer', 6, 10);
  assert.ok(isError(beyond));
  assert.equal((beyond as StoreError).code, 'INVALID_ARGUMENT');
});

test('tool-call paging and title cut with titleShortened', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTitleChars: 5 });
  const longTitle = 'a'.repeat(10);
  const emojiTitle = 'abcd😀e'; // pair at index 4-5: cutting at maxTitleChars=5 lands inside it
  const toolCalls: RetainedToolCall[] = [
    { messageId: 'm1', callId: 'c1', tool: 'bash', status: 'completed', title: longTitle },
    { messageId: 'm2', tool: 'read', status: 'completed', title: 'short' },
    { messageId: 'm3', tool: 'edit', status: 'completed', title: emojiTitle },
  ];
  store.put(artifact({ toolCalls }));

  const page1 = store.readToolCalls('ses_1', 1, 0, 2) as ItemPage<RetainedToolCall>;
  assert.ok(!isError(page1));
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 2);
  assert.equal(page1.items[0]!.title, 'aaaaa');
  assert.equal(page1.items[0]!.titleShortened, true);
  assert.equal(page1.items[1]!.title, 'short');
  assert.equal(page1.items[1]!.titleShortened, undefined);

  const page2 = store.readToolCalls('ses_1', 1, 2, 2) as ItemPage<RetainedToolCall>;
  assert.ok(!isError(page2));
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextOffset, null);
  assert.equal(page2.hasMore, false);
  // Cutting at 5 would split the surrogate pair (index 4-5); the cut must drop back to 4 chars.
  assert.equal(page2.items[0]!.title, 'abcd');
  assert.equal(page2.items[0]!.titleShortened, true);
  assert.ok(page2.items[0]!.title!.length < 5);
});

test('structured-output section present and absent', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  store.put(artifact({ turn: 1, turnId: 'ses_1#1', structured: '{"a":1}' }));
  store.put(artifact({ turn: 2, turnId: 'ses_1#2' }));

  const present = store.readText('ses_1', 1, 'structured-output', 0, 100) as TextPage;
  assert.ok(!isError(present));
  assert.equal(present.text, '{"a":1}');

  const absent = store.readText('ses_1', 2, 'structured-output', 0, 100);
  assert.ok(isError(absent));
  assert.equal((absent as StoreError).code, 'OUTPUT_UNAVAILABLE');
});

test('put is idempotent per (sessionId, turn); artifacts are immutable', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  const first = store.put(artifact({ answer: 'first answer' }));
  const second = store.put(artifact({ answer: 'second answer, totally different' }));
  assert.deepEqual(second, first);
  const page = store.readText('ses_1', 1, 'answer', 0, 100) as TextPage;
  assert.equal(page.text, 'first answer');
});

test('immutability: mutating input after put, and mutating returned pages/items, does not affect later reads', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  const toolCalls: RetainedToolCall[] = [{ messageId: 'm1', tool: 'bash', status: 'completed', title: 'orig' }];
  const input = artifact({ toolCalls });
  store.put(input);

  // Mutate the caller's array/object after put().
  input.toolCalls.push({ messageId: 'm2', tool: 'edit', status: 'completed' });
  toolCalls[0]!.title = 'mutated';

  const readBack1 = store.readToolCalls('ses_1', 1, 0, 10) as ItemPage<RetainedToolCall>;
  assert.equal(readBack1.total, 1);
  assert.equal(readBack1.items[0]!.title, 'orig');

  // Mutate the returned array/items.
  readBack1.items.push({ messageId: 'm3', tool: 'x', status: 'y' });
  readBack1.items[0]!.title = 'also mutated';

  const readBack2 = store.readToolCalls('ses_1', 1, 0, 10) as ItemPage<RetainedToolCall>;
  assert.equal(readBack2.total, 1);
  assert.equal(readBack2.items[0]!.title, 'orig');
});

test('a turn above maxTurnBytes is not stored: too_large tombstone', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurnBytes: 50 });
  const meta = store.put(artifact({ answer: 'x'.repeat(100) }));
  assert.equal(meta.state, 'unavailable');
  if (meta.state === 'unavailable') {
    assert.equal(meta.reason, 'too_large');
    assert.equal(meta.answerChars, 100);
  }
  assert.deepEqual(store.meta('ses_1', 1), meta);
  const page = store.readText('ses_1', 1, 'answer', 0, 10);
  assert.ok(isError(page));
  assert.equal((page as StoreError).code, 'OUTPUT_UNAVAILABLE');
  assert.equal((page as StoreError).reason, 'too_large');
});

test('FIFO eviction by maxTurns leaves evicted tombstones', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurns: 2 });
  store.put(artifact({ turn: 1, turnId: 'ses_1#1', answer: 'one' }));
  store.put(artifact({ turn: 2, turnId: 'ses_1#2', answer: 'two' }));
  store.put(artifact({ turn: 3, turnId: 'ses_1#3', answer: 'three' }));

  assert.equal(store.stats().turns, 2);
  const meta1 = store.meta('ses_1', 1);
  assert.equal(meta1?.state, 'unavailable');
  if (meta1?.state === 'unavailable') assert.equal(meta1.reason, 'evicted');
  assert.equal(store.meta('ses_1', 2)?.state, 'retained');
  assert.equal(store.meta('ses_1', 3)?.state, 'retained');
});

test('FIFO eviction by maxBytes leaves evicted tombstones', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurns: 100, maxBytes: 300, maxTurnBytes: 300 });
  store.put(artifact({ turn: 1, turnId: 'ses_1#1', answer: 'a'.repeat(150) }));
  store.put(artifact({ turn: 2, turnId: 'ses_1#2', answer: 'b'.repeat(150) }));
  // Admitting turn 3 must evict turn 1 (oldest) to fit the 300-byte budget.
  store.put(artifact({ turn: 3, turnId: 'ses_1#3', answer: 'c'.repeat(150) }));

  const meta1 = store.meta('ses_1', 1);
  assert.equal(meta1?.state, 'unavailable');
  if (meta1?.state === 'unavailable') assert.equal(meta1.reason, 'evicted');
  assert.equal(store.meta('ses_1', 2)?.state, 'retained');
  assert.equal(store.meta('ses_1', 3)?.state, 'retained');
  assert.ok(store.stats().bytes <= 300);
});

test('ttl expiry marks an artifact expired', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { ttlMs: 1000 });
  store.put(artifact({ answer: 'will expire' }));
  assert.equal(store.meta('ses_1', 1)?.state, 'retained');
  clock.tick(999);
  assert.equal(store.meta('ses_1', 1)?.state, 'retained');
  clock.tick(2);
  const meta = store.meta('ses_1', 1);
  assert.equal(meta?.state, 'unavailable');
  if (meta?.state === 'unavailable') assert.equal(meta.reason, 'expired');
  const page = store.readText('ses_1', 1, 'answer', 0, 10);
  assert.ok(isError(page));
  assert.equal((page as StoreError).reason, 'expired');
});

test('tombstones are bounded, dropping the oldest', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurns: 1, maxTombstones: 2 });
  // Each new put beyond maxTurns=1 evicts the previous turn, producing a tombstone.
  store.put(artifact({ turn: 1, turnId: 'ses_1#1' }));
  store.put(artifact({ turn: 2, turnId: 'ses_1#2' })); // evicts 1 -> tombstone for 1
  store.put(artifact({ turn: 3, turnId: 'ses_1#3' })); // evicts 2 -> tombstone for 1,2
  store.put(artifact({ turn: 4, turnId: 'ses_1#4' })); // evicts 3 -> tombstones bounded to 2: drops 1, keeps 2,3

  assert.equal(store.meta('ses_1', 1), undefined);
  assert.equal(store.meta('ses_1', 2)?.state, 'unavailable');
  assert.equal(store.meta('ses_1', 3)?.state, 'unavailable');
  assert.equal(store.meta('ses_1', 4)?.state, 'retained');
});

test('putDiff/currentDiff/readDiffStat/readPatch with patch paging', () => {
  const clock = new FakeClock();
  clock.now = 5000;
  const store = new OutputStore(clock);
  store.put(artifact());
  const items = [
    { file: 'a.ts', status: 'modified' as const, additions: 3, deletions: 1, patch: 'diff --git a/a.ts...\n+added line\n' },
    { file: 'b.ts', status: 'added' as const, additions: 10, deletions: 0, patch: undefined },
  ];
  const snap = store.putDiff('ses_1', 1, 'msg_user_1', items);
  assert.ok(!isError(snap));
  const s = snap as Exclude<typeof snap, StoreError>;
  assert.equal(s.sourceMessageId, 'msg_user_1');
  assert.equal(s.observedAt, 5000);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0]!.fileIndex, 0);
  assert.equal(s.items[1]!.fileIndex, 1);

  const current = store.currentDiff('ses_1', 1);
  assert.deepEqual(current, s);

  const stat = store.readDiffStat('ses_1', 1, s.snapshotId, 0, 10);
  assert.ok(!isError(stat));
  const statPage = stat as ItemPage<{ fileIndex: number; file?: string; status?: string; additions: number; deletions: number; patchChars?: number }>;
  assert.equal(statPage.total, 2);
  assert.equal(statPage.items[0]!.file, 'a.ts');
  assert.equal(statPage.items[0]!.patchChars, items[0]!.patch!.length);
  assert.equal(statPage.items[1]!.patchChars, undefined);

  const patchText = items[0]!.patch!;
  const p1 = store.readPatch('ses_1', 1, s.snapshotId, 0, 0, 10) as TextPage;
  assert.ok(!isError(p1));
  assert.equal(p1.text, patchText.slice(0, 10));
  assert.equal(p1.hasMore, true);
  const full = collectText2(store, 'ses_1', 1, s.snapshotId, 0, 6);
  assert.equal(full, patchText);

  // patch read for a file with no patch content is an empty, fully-paged text.
  const p2 = store.readPatch('ses_1', 1, s.snapshotId, 1, 0, 10) as TextPage;
  assert.ok(!isError(p2));
  assert.equal(p2.text, '');
  assert.equal(p2.total, 0);
  assert.equal(p2.nextOffset, null);

  function collectText2(st: OutputStore, sid: string, turn: number, snapshotId: string, fileIndex: number, limit: number): string {
    let offset = 0;
    let out = '';
    while (true) {
      const page = st.readPatch(sid, turn, snapshotId, fileIndex, offset, limit) as TextPage;
      out += page.text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return out;
  }
});

test('a second putDiff makes the old snapshotId SNAPSHOT_EXPIRED', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  store.put(artifact());
  const first = store.putDiff('ses_1', 1, 'msg_1', [{ additions: 1, deletions: 0 }]);
  assert.ok(!isError(first));
  const firstId = (first as { snapshotId: string }).snapshotId;
  const second = store.putDiff('ses_1', 1, 'msg_2', [{ additions: 2, deletions: 2 }]);
  assert.ok(!isError(second));
  const secondId = (second as { snapshotId: string }).snapshotId;
  assert.notEqual(firstId, secondId);

  const staleRead = store.readDiffStat('ses_1', 1, firstId, 0, 10);
  assert.ok(isError(staleRead));
  assert.equal((staleRead as StoreError).code, 'SNAPSHOT_EXPIRED');

  const freshRead = store.readDiffStat('ses_1', 1, secondId, 0, 10);
  assert.ok(!isError(freshRead));

  const current = store.currentDiff('ses_1', 1);
  assert.equal(current?.snapshotId, secondId);
});

test('diff too large for the turn: OUTPUT_UNAVAILABLE too_large, artifact stays readable', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurnBytes: 200 });
  store.put(artifact({ answer: 'x'.repeat(50) }));
  const hugePatch = 'y'.repeat(1000);
  const result = store.putDiff('ses_1', 1, 'msg_1', [{ file: 'big.ts', additions: 1, deletions: 0, patch: hugePatch }]);
  assert.ok(isError(result));
  assert.equal((result as StoreError).code, 'OUTPUT_UNAVAILABLE');
  assert.equal((result as StoreError).reason, 'too_large');

  // Artifact itself is untouched and still readable.
  const meta = store.meta('ses_1', 1);
  assert.equal(meta?.state, 'retained');
  const page = store.readText('ses_1', 1, 'answer', 0, 100) as TextPage;
  assert.ok(!isError(page));
  assert.equal(page.text, 'x'.repeat(50));
  assert.equal(store.currentDiff('ses_1', 1), undefined);
});

test('a diff needing process-budget room evicts other turns but never the target', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurns: 100, maxBytes: 400, maxTurnBytes: 400 });
  store.put(artifact({ turn: 1, turnId: 'ses_1#1', answer: 'a'.repeat(150) }));
  store.put(artifact({ turn: 2, turnId: 'ses_1#2', answer: 'b'.repeat(150) }));
  assert.equal(store.stats().turns, 2);

  // Turn 2's diff needs ~100 more bytes than the remaining budget; turn 1 (oldest, not the
  // target) must be evicted to make room, never turn 2.
  const patch = 'z'.repeat(90);
  const result = store.putDiff('ses_1', 2, 'msg_1', [{ file: 'f.ts', additions: 1, deletions: 0, patch }]);
  assert.ok(!isError(result));

  assert.equal(store.meta('ses_1', 1)?.state, 'unavailable');
  assert.equal(store.meta('ses_1', 2)?.state, 'retained');
  assert.equal(store.currentDiff('ses_1', 2)?.items[0]!.file, 'f.ts');
});

test('dropSession removes everything for that session only', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock, { maxTurnBytes: 50 });
  // too_large tombstone in ses_a
  store.put(artifact({ sessionId: 'ses_a', turn: 1, turnId: 'ses_a#1', answer: 'x'.repeat(100) }));
  store.put(artifact({ sessionId: 'ses_a', turn: 2, turnId: 'ses_a#2', answer: 'small' }));
  store.put(artifact({ sessionId: 'ses_b', turn: 1, turnId: 'ses_b#1', answer: 'small' }));

  assert.equal(store.meta('ses_a', 1)?.state, 'unavailable');
  assert.equal(store.meta('ses_a', 2)?.state, 'retained');
  assert.equal(store.meta('ses_b', 1)?.state, 'retained');

  store.dropSession('ses_a');

  assert.equal(store.meta('ses_a', 1), undefined);
  assert.equal(store.meta('ses_a', 2), undefined);
  assert.equal(store.meta('ses_b', 1)?.state, 'retained');
  assert.equal(store.stats().turns, 1);
});

test('stats() reports turn count and total bytes', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  assert.deepEqual(store.stats(), { turns: 0, bytes: 0 });
  store.put(artifact({ answer: 'hello' }));
  const after = store.stats();
  assert.equal(after.turns, 1);
  assert.ok(after.bytes >= 5);
  store.dropSession('ses_1');
  assert.deepEqual(store.stats(), { turns: 0, bytes: 0 });
});

test('unknown turn is TURN_NOT_FOUND for every read', () => {
  const clock = new FakeClock();
  const store = new OutputStore(clock);
  assert.equal(store.meta('nope', 1), undefined);
  const text = store.readText('nope', 1, 'answer', 0, 10);
  assert.ok(isError(text));
  assert.equal((text as StoreError).code, 'TURN_NOT_FOUND');
  const calls = store.readToolCalls('nope', 1, 0, 10);
  assert.ok(isError(calls));
  assert.equal((calls as StoreError).code, 'TURN_NOT_FOUND');
  const diffPut = store.putDiff('nope', 1, 'm', []);
  assert.ok(isError(diffPut));
  assert.equal((diffPut as StoreError).code, 'TURN_NOT_FOUND');
});
