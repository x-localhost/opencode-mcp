// FY-2 #7: ERROR_HINTS entries for REQUEST_PENDING and SESSION_CAPACITY (src/mcp/tools.ts).
// No server spawn needed: buildErrorResult is a pure function of (code, message, sessionId).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorResult } from '../../src/mcp/tools.ts';

test('buildErrorResult: REQUEST_PENDING points the model back at the same request-id', () => {
  const result = buildErrorResult('REQUEST_PENDING', 'Original request admission is still pending', 'ses_1');
  assert.match(result.hint ?? '', /request-id/);
  assert.match(result.hint ?? '', /retry|poll/i);
  assert.match(result.hint ?? '', /opencode-status/);
});

test('buildErrorResult: SESSION_CAPACITY points the model at opencode-end and OPENCODE_MCP_MAX_SESSIONS', () => {
  const result = buildErrorResult('SESSION_CAPACITY', 'Too many tracked sessions');
  assert.match(result.hint ?? '', /opencode-end/);
  assert.match(result.hint ?? '', /OPENCODE_MCP_MAX_SESSIONS/);
});

test('buildErrorResult: every FY-2 error code carries a non-empty hint', () => {
  for (const code of ['REQUEST_PENDING', 'SESSION_CAPACITY'] as const) {
    const result = buildErrorResult(code, 'message', 'ses_x');
    assert.equal(typeof result.hint, 'string', `${code}: expected a hint`);
    assert.ok((result.hint ?? '').length > 0, `${code}: expected a non-empty hint`);
  }
});
