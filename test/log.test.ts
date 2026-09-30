import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../src/log.ts';

function captured(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

test('createLogger: formats a line as "<ISO time> <LEVEL> <msg> <json fields>"', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('hello world', { a: 1 });

  assert.equal(lines.length, 1);
  const line = lines[0] as string;
  assert.match(line, ISO_PREFIX);
  assert.match(line, / INFO hello world \{"a":1\}$/);
});

test('createLogger: fields default to {} when omitted', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.warn('no fields here');

  assert.match(lines[0] as string, / WARN no fields here \{\}$/);
});

// ---------------------------------------------------------------------------
// Level filtering
// ---------------------------------------------------------------------------

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

test('createLogger: filters records below the configured level', () => {
  for (let i = 0; i < LEVELS.length; i += 1) {
    const threshold = LEVELS[i] as (typeof LEVELS)[number];
    const { lines, sink } = captured();
    const logger = createLogger(threshold, sink);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const expectedCount = LEVELS.length - i;
    assert.equal(lines.length, expectedCount, `threshold=${threshold}`);
    for (const line of lines) {
      const level = LEVELS.find((lvl) => line.includes(` ${lvl.toUpperCase()} `));
      assert.ok(level, `line should carry a known level: ${line}`);
      assert.ok(LEVELS.indexOf(level) >= i, `line below threshold leaked through: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('createLogger: redacts a top-level sensitive key regardless of value type', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('login', { password: 'hunter2', Authorization: 'Bearer abc', apiKey: 'k', api_key: 'k2', token: 't', secret: 's', Cookie: 'c' });

  const line = lines[0] as string;
  assert.ok(!line.includes('hunter2'));
  assert.ok(!line.includes('Bearer abc'));
  assert.match(line, /"password":"\[REDACTED\]"/);
  assert.match(line, /"Authorization":"\[REDACTED\]"/);
  assert.match(line, /"apiKey":"\[REDACTED\]"/);
  assert.match(line, /"api_key":"\[REDACTED\]"/);
  assert.match(line, /"token":"\[REDACTED\]"/);
  assert.match(line, /"secret":"\[REDACTED\]"/);
  assert.match(line, /"Cookie":"\[REDACTED\]"/);
});

test('createLogger: redacts sensitive keys nested inside objects and arrays', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('nested', {
    request: {
      headers: { authorization: 'Bearer nested-secret', 'Content-Type': 'application/json' },
      attempts: [{ password: 'p1' }, { password: 'p2' }],
    },
  });

  const line = lines[0] as string;
  assert.ok(!line.includes('nested-secret'));
  assert.ok(!line.includes('"p1"'));
  assert.ok(!line.includes('"p2"'));
  assert.match(line, /"authorization":"\[REDACTED\]"/);
  assert.match(line, /"Content-Type":"application\/json"/);
  assert.match(line, /"password":"\[REDACTED\]"/);
});

test('createLogger: redacts userinfo in URL-shaped strings, anywhere in the value', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('connecting', {
    url: 'https://alice:s3cr3t@opencode.internal:4096/path?x=1',
    note: 'see https://bob:pw@example.com for details',
  });

  const line = lines[0] as string;
  assert.ok(!line.includes('alice:s3cr3t'));
  assert.ok(!line.includes('bob:pw'));
  assert.match(line, /"url":"https:\/\/\[REDACTED\]@opencode\.internal:4096\/path\?x=1"/);
  assert.match(line, /see https:\/\/\[REDACTED\]@example\.com for details/);
});

test('createLogger: redacts userinfo embedded in the message string itself', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('fetching https://alice:s3cr3t@opencode.internal/health');

  const line = lines[0] as string;
  assert.ok(!line.includes('alice:s3cr3t'));
  assert.match(line, /fetching https:\/\/\[REDACTED\]@opencode\.internal\/health/);
});

test('createLogger: a URL without userinfo is left untouched', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  logger.info('ok', { url: 'https://opencode.internal:4096/health' });

  assert.match(lines[0] as string, /"url":"https:\/\/opencode\.internal:4096\/health"/);
});

test('createLogger: an Error field is reduced to name/message, with userinfo redacted', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  const err = new Error('failed for https://alice:s3cr3t@opencode.internal');
  logger.error('boom', { error: err });

  const line = lines[0] as string;
  assert.ok(!line.includes('s3cr3t'));
  assert.match(line, /"error":\{"name":"Error","message":"failed for https:\/\/\[REDACTED\]@opencode\.internal"\}/);
});

test('createLogger: circular objects do not throw', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;

  assert.doesNotThrow(() => logger.info('circular', { circular }));
  assert.equal(lines.length, 1);
});

test('createLogger: a non-circular object shared between two fields renders fully in both; a true self-reference still becomes "[Circular]"', () => {
  const { lines, sink } = captured();
  const logger = createLogger('debug', sink);

  const shared = { id: 1 };
  logger.warn('x', { request: shared, retryOf: shared });

  const line = lines[0] as string;
  assert.match(line, /"request":\{"id":1\}/, 'first reference to the shared object must render fully');
  assert.match(
    line,
    /"retryOf":\{"id":1\}/,
    'a second, sibling reference to the same non-circular object must also render fully, not "[Circular]"',
  );

  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  lines.length = 0;
  logger.warn('y', { circular });

  assert.match(
    lines[0] as string,
    /"circular":\{"a":1,"self":"\[Circular\]"\}/,
    'a genuine self-reference must still render as "[Circular]"',
  );
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

test('createLogger: a throwing sink is swallowed, never throws', () => {
  const logger = createLogger('debug', () => {
    throw new Error('sink is broken');
  });

  assert.doesNotThrow(() => logger.info('anything'));
});

test('createLogger: defaults to writing to stderr when no sink is given', () => {
  const original = process.stderr.write;
  let captured1 = '';
  process.stderr.write = ((chunk: string) => {
    captured1 += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const logger = createLogger('debug');
    logger.info('to stderr');
  } finally {
    process.stderr.write = original;
  }
  assert.match(captured1, / INFO to stderr \{\}\n$/);
});
