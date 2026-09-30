import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionRulesFor } from '../../src/core/policy.ts';
import { resolveWorkingDirectory } from '../../src/core/paths.ts';
import { extractInterval, classifyOutcome, summarizeInterval } from '../../src/core/result.ts';
import type { Config, OcMessage } from '../../src/types.ts';
const config = (root: string, remotePaths = false) =>
  ({ defaultCwd: root, allowedRoots: [root], remotePaths, maxOutputChars: 20 }) as Config;
const msg = (id: string, role: 'user' | 'assistant', extra: Record<string, unknown> = {}) =>
  ({
    info: { id, sessionID: 's', role, time: { created: Number(id.replace(/\D/g, '')) || 0 }, ...extra },
    parts: [],
  }) as OcMessage;
test('deny-only policy profiles', () => {
  assert.deepEqual(
    sessionRulesFor('danger-full-access').map((x) => x.permission),
    ['task', 'question', 'plan_enter', 'plan_exit'],
  );
  assert.deepEqual(
    sessionRulesFor('workspace-write').map((x) => x.permission),
    ['task', 'question', 'plan_enter', 'plan_exit', 'external_directory'],
  );
  assert.deepEqual(
    sessionRulesFor('read-only').map((x) => x.permission),
    ['task', 'question', 'plan_enter', 'plan_exit', 'edit', 'bash', 'external_directory', 'webfetch', 'websearch'],
  );
  assert.ok(sessionRulesFor('read-only').every((x) => x.pattern === '*' && x.action === 'deny'));
});
test('local and remote paths use component containment and local realpath', async () => {
  const root = await mkdtemp(path.join(process.cwd(), 'test/core/oc-core-'));
  const sibling = root + 'x';
  try {
    await mkdir(path.join(root, 'sub'));
    await mkdir(sibling);
    await symlink(sibling, path.join(root, 'escape'));
    await writeFile(path.join(root, 'file'), 'x');
    assert.equal(await resolveWorkingDirectory('sub', config(root)), path.join(root, 'sub'));
    await assert.rejects(resolveWorkingDirectory('escape', config(root)), { code: 'PATH_NOT_ALLOWED' });
    await assert.rejects(resolveWorkingDirectory(sibling, config(root)), { code: 'PATH_NOT_ALLOWED' });
    await assert.rejects(resolveWorkingDirectory('missing', config(root)), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(resolveWorkingDirectory('file', config(root)), { code: 'INVALID_ARGUMENT' });
    assert.equal(await resolveWorkingDirectory('sub/..', config(root, true)), root);
    assert.equal(
      await resolveWorkingDirectory('/anything', { ...config(root, true), allowedRoots: ['/'] }),
      '/anything',
    );
    await assert.rejects(resolveWorkingDirectory('../' + path.basename(sibling), config(root, true)), {
      code: 'PATH_NOT_ALLOWED',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});
test('interval includes compaction, excludes summary answer, dedupes, classifies terminal evidence', () => {
  const u = msg('m1', 'user');
  const summary = msg('m2', 'assistant', {
    summary: true,
    finish: 'stop',
    time: { created: 2, completed: 2 },
  });
  summary.parts = [{ id: 'p1', sessionID: 's', messageID: 'm2', type: 'text', text: 'summary' }];
  const a = msg('m3', 'assistant', {
    parentID: 'm1',
    finish: 'stop',
    time: { created: 3, completed: 4 },
    tokens: { input: 2, output: 3, reasoning: 1 },
    cost: 0.1,
  });
  a.parts = [
    { id: 'p2', sessionID: 's', messageID: 'm3', type: 'text', text: 'finished answer which is long' },
    { id: 'p3', sessionID: 's', messageID: 'm3', type: 'patch', files: ['/repo/file.ts'] },
  ];
  const i = extractInterval([[u, summary, a], [a]], undefined);
  assert.equal(i.length, 3);
  assert.equal(classifyOutcome(i, true).status, 'completed');
  const r = summarizeInterval(i, '/repo', 20);
  assert.equal(r.filesChanged[0], 'file.ts');
  assert.equal(r.tokens?.input, 2);
  assert.equal(r.truncated, true);
  assert.ok(r.content.includes('truncated'));
  i[2]!.info.finish = 'tool-calls';
  assert.equal(classifyOutcome(i, true).error?.name, 'TURN_INCOMPLETE');
  i[2]!.info.error = { name: 'APIError', data: { message: 'bad' } };
  assert.equal(classifyOutcome(i, true).status, 'failed');
});
test('paged interval exceeds 100 messages and keeps only newer than boundary', () => {
  const old = msg('m000', 'assistant', { finish: 'stop', time: { created: 0, completed: 1 } });
  const messages = [
    old,
    ...Array.from({ length: 125 }, (_, i) =>
      msg(`m${String(i + 1).padStart(3, '0')}`, 'assistant', { finish: 'tool-calls' }),
    ),
  ];
  const pages = [messages.slice(26), messages.slice(0, 26)];
  const interval = extractInterval(pages, 'm000');
  assert.equal(interval.length, 125);
  assert.equal(interval[0]?.info.id, 'm001');
  assert.equal(interval.at(-1)?.info.id, 'm125');
});
test('aborted error and timeout reason classify, summary does not become final answer', () => {
  const user = msg('m1', 'user');
  const summary = msg('m2', 'assistant', {
    summary: true,
    finish: 'stop',
    time: { created: 2, completed: 3 },
  });
  summary.parts = [{ id: 'p1', sessionID: 's', messageID: 'm2', type: 'text', text: 'old summary' }];
  const final = msg('m3', 'assistant', {
    error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
  });
  final.parts = [{ id: 'p2', sessionID: 's', messageID: 'm3', type: 'text', text: 'partial' }];
  assert.equal(classifyOutcome([user, summary, final], true).status, 'cancelled');
  assert.equal(summarizeInterval([user, summary, final], '/repo', 100).content, 'partial');
});
test('result dedupes parts and keeps last 20 tool calls with total count', () => {
  const user = msg('m1', 'user');
  const assistant = msg('m2', 'assistant', { finish: 'stop', time: { created: 2, completed: 3 } });
  assistant.parts = Array.from({ length: 23 }, (_, i) => ({
    id: `p${i}`,
    sessionID: 's',
    messageID: 'm2',
    type: 'tool',
    tool: 'bash',
    state: { status: 'completed' as const, title: `call ${i}` },
  }));
  const copy = { info: { ...assistant.info }, parts: [...assistant.parts] };
  const interval = extractInterval([[user, assistant], [copy]], undefined);
  const summary = summarizeInterval(interval, '/repo', 200);
  assert.equal(summary.toolCallCount, 23);
  assert.equal(summary.toolCalls.length, 20);
  assert.equal(summary.toolCalls[0]?.title, 'call 3');
});
