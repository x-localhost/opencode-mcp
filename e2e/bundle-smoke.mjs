#!/usr/bin/env node
// Scenario (j): bundle smoke test on Node 20 (design.md §9: "Verified on Node 20 and 22").
// Only checks that dist/opencode-mcp.mjs starts under Node 20 and answers `tools/list` with the
// five expected tools — no OpenCode installation is needed (`opencode serve` is only spawned
// lazily on the first `engine.start`, which this script never triggers). Plain script, not
// node:test, so it can be run directly under a node:20 image:
//
//   node e2e/bundle-smoke.mjs
//
// Exit code 0 on success, 1 on failure (message on stderr).

import assert from 'node:assert/strict';
import { McpClient } from './lib/mcp-client.mjs';

// Kept in sync with the MCP server's actual tool set (mid-review round added opencode-info and
// opencode-output; a stale list here was observed to make this step FAIL, harmlessly, on its own
// — see the leak note below for why a fail here used to hang instead).
const EXPECTED_TOOLS = [
  'opencode',
  'opencode-reply',
  'opencode-status',
  'opencode-cancel',
  'opencode-end',
  'opencode-info',
  'opencode-output',
];

async function main() {
  console.log(`[bundle-smoke] node ${process.version}`);
  const client = await McpClient.connect({ initializeTimeoutMs: 15_000 });
  try {
    console.log('[bundle-smoke] initialize OK:', JSON.stringify(client.serverInfo), 'protocol', client.protocolVersion);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log('[bundle-smoke] tools/list ->', names.join(', '));
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), `expected exactly ${EXPECTED_TOOLS.join(', ')}`);

    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name}: missing inputSchema`);
      assert.ok(tool.outputSchema, `${tool.name}: missing outputSchema`);
    }

    await client.closeAndWait(10_000);
    console.log('[bundle-smoke] clean shutdown, exitCode', client.exitCode);
    console.log('[bundle-smoke] PASS');
  } catch (err) {
    // Observed during mid-review-fix verification (not one of that review's own findings, but the
    // same leak pattern as its harness.mjs finding): a thrown assertion above left the spawned
    // opencode-mcp child's stdio pipes open, hanging this whole script forever instead of just
    // failing it (a stale EXPECTED_TOOLS made this trivially reproducible). Force it closed before
    // propagating so a failure here is a fast, clean FAIL, never a hang.
    client.kill('SIGKILL');
    throw err;
  }
}

main().catch((err) => {
  console.error('[bundle-smoke] FAIL:', err);
  process.exitCode = 1;
});
