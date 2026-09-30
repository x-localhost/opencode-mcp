import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { OcMessage, OcPart } from '../../src/types.ts';
import { classifyAttempt, detectResponseLoop } from '../../src/core/response-loop.ts';

const samples = JSON.parse(readFileSync(new URL('../../docs/research/probe-overload/samples.json', import.meta.url), 'utf8')) as
  Record<string, { firstMessages: OcMessage[] }>;
const sample = (name: string): OcMessage[] => structuredClone(samples[name]!.firstMessages);
const root = (messages: OcMessage[]) => messages[0]!.info.id;
const copy = (message: OcMessage, index: number, completed: number): OcMessage => {
  const next = structuredClone(message);
  next.info.id = `msg_${String(index).padStart(4, '0')}`;
  next.info.time = { created: completed - 10, completed };
  next.parts = next.parts.map((part, partIndex) => ({ ...part, id: `p${index}_${partIndex}`, messageID: next.info.id }));
  return next;
};
const sequence = (pattern: OcMessage, count: number, gap = 100): OcMessage[] => {
  const user = sample('3-empty-done')[0]!;
  user.info.id = 'msg_0000';
  return [user, ...Array.from({ length: count }, (_, index) => {
    const value = copy(pattern, index + 1, 1_000 + index * gap);
    value.info.parentID = user.info.id;
    return value;
  })];
};

test('captured empty DONE, HTML, and invalid-tool shapes are the only candidates', () => {
  for (const key of ['3-empty-done', '8-html-body'])
    assert.equal(classifyAttempt(sample(key)[1]!), 'empty');
  assert.equal(classifyAttempt(sample('9-bad-tool-json')[1]!), 'invalid_tool');
  assert.equal(classifyAttempt(sample('4-empty-stop')[1]!), undefined);
  assert.equal(classifyAttempt(sample('5-whitespace')[1]!), undefined);
  assert.equal(classifyAttempt(sample('11-finish-length')[1]!), undefined);
});

test('threshold, 10 second window, newer assistant and disabled limit', () => {
  const pattern = sample('3-empty-done')[1]!;
  assert.equal(detectResponseLoop(sequence(pattern, 6), 'msg_0000', 6), undefined);
  assert.deepEqual(detectResponseLoop(sequence(pattern, 7), 'msg_0000', 6),
    { count: 6, windowMs: 10_000, pattern: 'empty' });
  assert.equal(detectResponseLoop(sequence(pattern, 7, 2_000), 'msg_0000', 6)?.count, 6);
  assert.equal(detectResponseLoop(sequence(pattern, 7, 2_100), 'msg_0000', 6), undefined);
  assert.equal(detectResponseLoop(sequence(pattern, 7), 'msg_0000', 0), undefined);
  const unfinished = sequence(pattern, 7);
  delete unfinished.at(-1)!.info.time.completed;
  delete unfinished.at(-1)!.info.finish;
  assert.equal(detectResponseLoop(unfinished, root(unfinished), 6)?.count, 6);
  assert.equal(detectResponseLoop([unfinished[0]!, unfinished.at(-1)!], root(unfinished), 6), undefined);
});

test('watchdog requires the current trailing suffix, not an earlier qualifying streak', () => {
  const empty = sample('3-empty-done')[1]!;
  const base = sequence(empty, 7);
  assert.equal(detectResponseLoop(base, root(base), 6)?.count, 6);
  for (const part of [
    { type: 'reasoning', text: 'productive thought' },
    { type: 'text', text: 'answer underway' },
    { type: 'tool', tool: 'bash', state: { status: 'completed' } },
    { type: 'mystery' },
  ] as Array<Partial<OcPart>>) {
    const messages = structuredClone(base);
    const newer = copy(empty, 8, 1_700);
    newer.info.parentID = root(messages);
    delete newer.info.time.completed;
    delete newer.info.finish;
    newer.parts = [{ id: 'newer-part', sessionID: messages[0]!.info.sessionID,
      messageID: newer.info.id, ...part } as OcPart];
    messages.push(newer);
    assert.equal(detectResponseLoop(messages, root(messages), 6), undefined, part.type);
  }
  const silent = structuredClone(base);
  const newer = copy(empty, 8, 1_700);
  newer.info.parentID = root(silent);
  delete newer.info.time.completed;
  delete newer.info.finish;
  silent.push(newer);
  assert.equal(detectResponseLoop(silent, root(silent), 6)?.count, 6);
  const productive = copy(empty, 9, 1_800);
  productive.info.parentID = root(silent);
  productive.parts.push({ id: 'reasoning', sessionID: productive.info.sessionID,
    messageID: productive.info.id, type: 'reasoning', text: 'now working' });
  silent.push(productive);
  assert.equal(detectResponseLoop(silent, root(silent), 6), undefined);
});

test('mixed patterns, duplicate reads, non-monotonic time, and retry fence', () => {
  const empty = sample('3-empty-done')[1]!;
  const invalid = sample('9-bad-tool-json')[1]!;
  const messages = sequence(empty, 7);
  for (const index of [2, 4, 6]) {
    const replacement = copy(invalid, index, 1_000 + (index - 1) * 100);
    replacement.info.parentID = root(messages);
    replacement.info.sessionID = messages[0]!.info.sessionID;
    messages[index] = replacement;
  }
  assert.equal(detectResponseLoop(messages, root(messages), 6)?.pattern, 'mixed');
  assert.equal(detectResponseLoop([...messages, ...messages], root(messages), 6)?.count, 6);
  assert.equal(detectResponseLoop(messages, root(messages), 6, messages[2]!.info.id), undefined);
  messages[3]!.info.time.completed = 1;
  assert.equal(detectResponseLoop(messages, root(messages), 6), undefined);
});

test('real tools, reasoning, unknown parts, compaction and later answer reset candidates', () => {
  const empty = sample('3-empty-done')[1]!;
  const base = sequence(empty, 7);
  const barrier = (part: Partial<OcPart>): OcPart => ({
    id: 'barrier', sessionID: base[0]!.info.sessionID, messageID: base[3]!.info.id,
    type: 'tool', ...part,
  });
  for (const part of [
    barrier({ type: 'tool', tool: 'bash', state: { status: 'completed' } }),
    barrier({ type: 'tool', tool: 'bash', state: { status: 'error' } }),
    barrier({ type: 'reasoning', text: 'thinking' }),
    barrier({ type: 'mystery' }),
    barrier({ type: 'compaction' }),
  ]) {
    const messages = structuredClone(base);
    messages[3]!.parts.push(part);
    assert.equal(detectResponseLoop(messages, root(messages), 6), undefined, part.type);
  }
  const answer = structuredClone(base);
  answer.at(-1)!.info.finish = 'stop';
  answer.at(-1)!.parts.push(barrier({ type: 'text', text: 'done' }));
  assert.equal(detectResponseLoop(answer, root(answer), 6), undefined);
  const longTools = sequence(empty, 25);
  for (const message of longTools.slice(1)) message.parts.push(barrier({
    id: `tool_${message.info.id}`, messageID: message.info.id, tool: 'bash', state: { status: 'completed' },
  }));
  assert.equal(detectResponseLoop(longTools, root(longTools), 6), undefined);
  const summary = structuredClone(base);
  summary[3]!.info.summary = true;
  assert.equal(detectResponseLoop(summary, root(summary), 6), undefined);
});

test('an in-progress newer attempt showing only a pending tool or the invalid sentinel keeps the loop current', () => {
  const invalid = sample('9-bad-tool-json')[1]!;
  const history = sequence(invalid, 7);
  history[0]!.info.sessionID = invalid.info.sessionID;
  assert.equal(detectResponseLoop(history, root(history), 6)?.pattern, 'invalid_tool');
  const newest = history.at(-1)!;
  delete newest.info.time.completed;
  delete newest.info.finish;
  const toolPart = newest.parts.find((part) => part.type === 'tool')!;
  for (const [tool, status, expected] of [
    ['bash', 'pending', 'invalid_tool'],
    ['invalid', 'running', 'invalid_tool'],
    ['bash', 'running', undefined],
  ] as const) {
    newest.parts = [{ ...toolPart, tool, state: { ...toolPart.state!, status } } as OcPart];
    assert.equal(detectResponseLoop(history, root(history), 6)?.pattern, expected, `${tool} ${status}`);
  }
});
