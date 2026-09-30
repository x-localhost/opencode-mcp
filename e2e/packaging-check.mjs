#!/usr/bin/env node
// npm packaging check (review finding B3). Verifies the ACTUAL npm-installed CLI works end to
// end, exercising the real npm `bin` symlink path — not `node dist/index.js` directly. This is
// what caught the entry-point-guard/symlink bug fixed in this unit: `npm install -g` makes
// `opencode-mcp` a symlink, and the OS's shebang exec passes that symlink path (unresolved) as
// `process.argv[1]`, while Node's ESM loader resolves `import.meta.url` to the symlink's real
// target — src/index.ts's entry guard must account for that (see its comment) or the installed
// CLI silently does nothing and exits, which `node dist/index.js` in bundle-smoke.mjs can never
// reproduce.
//
// Must run AFTER `opencode-mcp` has been `npm install -g`'d onto PATH in this container — see
// e2e/run-e2e.sh, which does `npm pack` + the install step (offline, from the pre-populated
// ocmcp-npm-cache volume — see that script's comment for why no network is needed for install)
// before invoking this script. Plain script, not node:test:
//
//   node e2e/packaging-check.mjs
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
  console.log(`[packaging-check] node ${process.version}`);
  const client = await McpClient.connect({ command: 'opencode-mcp', args: [], initializeTimeoutMs: 15_000 });
  try {
    console.log('[packaging-check] initialize OK:', JSON.stringify(client.serverInfo), 'protocol', client.protocolVersion);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log('[packaging-check] tools/list ->', names.join(', '));
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), `expected exactly ${EXPECTED_TOOLS.join(', ')}`);

    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name}: missing inputSchema`);
      assert.ok(tool.outputSchema, `${tool.name}: missing outputSchema`);
    }

    await client.closeAndWait(10_000);
    console.log('[packaging-check] clean shutdown, exitCode', client.exitCode);
    console.log('[packaging-check] PASS');
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
  console.error('[packaging-check] FAIL:', err);
  process.exitCode = 1;
});
