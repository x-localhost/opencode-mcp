// Bootstrap smoke test: proves Node's type stripping runs our TypeScript sources
// directly under `node --test` (no loaders, no ts-node, no build step).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError, OpencodeHttpError } from '../src/types.ts';

test('EngineError carries code, message and optional sessionId', () => {
  const err = new EngineError('SESSION_NOT_FOUND', 'no such session', 'ses_123');

  assert.equal(err.name, 'EngineError');
  assert.equal(err.code, 'SESSION_NOT_FOUND');
  assert.equal(err.message, 'no such session');
  assert.equal(err.sessionId, 'ses_123');
  assert.ok(err instanceof Error);
});

test('EngineError sessionId is optional', () => {
  const err = new EngineError('INVALID_ARGUMENT', 'bad input');

  assert.equal(err.sessionId, undefined);
});

test('OpencodeHttpError carries status, errorName, message and optional body', () => {
  const body = { message: 'not found' };
  const err = new OpencodeHttpError('request failed', 404, 'NotFoundError', body);

  assert.equal(err.name, 'OpencodeHttpError');
  assert.equal(err.status, 404);
  assert.equal(err.errorName, 'NotFoundError');
  assert.equal(err.message, 'request failed');
  assert.deepEqual(err.body, body);
  assert.ok(err instanceof Error);
});

test('OpencodeHttpError body is optional', () => {
  const err = new OpencodeHttpError('timed out', 0, 'TimeoutError');

  assert.equal(err.body, undefined);
});
