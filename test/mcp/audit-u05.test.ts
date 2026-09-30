// U05 (MCP layer): buildElicit forwards the caller's real approval deadline as the MCP request's
// own timeout (not the SDK's 60 s default); a client that never declared the elicitation
// capability gets no elicitation/create at all; every non-"explicit allow" elicitation reply maps
// to a null decision, including the untested accept-with-no-content / unknown-decision / cancel
// shapes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { buildElicit } from '../../src/mcp/tools.ts';
import type { ApprovalRequest } from '../../src/types.ts';
import { spawnStubServer } from './support/spawn-server.ts';
import { JsonRpcClient } from './support/json-rpc-client.ts';
import type { SpawnedServer } from './support/spawn-server.ts';

interface CallToolResultShape {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// (h) buildElicit forwards the caller's deadline as the MCP request's own timeout.
// ---------------------------------------------------------------------------

test('U05h: buildElicit passes the approval deadline as elicitInput\'s own timeout/maxTotalTimeout, not the SDK default', async () => {
  let capturedOptions: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number } | undefined;
  const fakeServer = {
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  } as unknown as McpServer;
  const fakeMcpReq = {
    elicitInput: async (
      _params: unknown,
      options: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
    ) => {
      capturedOptions = options;
      return { action: 'decline' };
    },
  } as unknown as ServerContext['mcpReq'];

  const elicit = buildElicit(fakeServer, fakeMcpReq);
  assert.ok(elicit, 'expected buildElicit to return an elicit function when elicitation is declared');

  const controller = new AbortController();
  const req: ApprovalRequest = {
    requestId: 'per_1',
    sessionId: 'ses_1',
    turnId: 'ses_1#1',
    permission: 'bash',
    patterns: ['rm -rf /'],
    metadata: {},
    timeoutMs: 4321,
  };
  await elicit!(req, controller.signal);

  assert.ok(capturedOptions, 'expected elicitInput to have been called');
  assert.equal(capturedOptions!.timeout, req.timeoutMs);
  assert.equal(capturedOptions!.maxTotalTimeout, req.timeoutMs);
  assert.equal(capturedOptions!.signal, controller.signal);
});

test('U05h: buildElicit returns undefined when the client declares no elicitation capability', () => {
  const fakeServer = {
    server: { getClientCapabilities: () => ({}) },
  } as unknown as McpServer;
  const fakeMcpReq = {} as unknown as ServerContext['mcpReq'];
  assert.equal(buildElicit(fakeServer, fakeMcpReq), undefined);
});

// ---------------------------------------------------------------------------
// (i) A connection without the elicitation capability never sends elicitation/create.
// ---------------------------------------------------------------------------

test('U05i: a client initialized without elicitation never gets elicitation/create; decision is null', async () => {
  const spawned = spawnStubServer();
  try {
    const client = new JsonRpcClient(spawned.child);
    await client.initialize({});
    let sawElicitationCreate = false;
    client.onServerRequest((req) => {
      if (req.method === 'elicitation/create') sawElicitationCreate = true;
      client.respondError(req.id, -32601, 'unexpected server request');
    });
    const result = (await client.callTool('opencode', {
      prompt: JSON.stringify({ mode: 'elicit', permission: 'bash', patterns: ['rm -rf /'] }),
    })) as CallToolResultShape;
    assert.equal(sawElicitationCreate, false, 'expected no elicitation/create on a capability-less connection');
    assert.equal(result.structuredContent?.content, 'decision:null');
  } finally {
    spawned.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// (j) Every non-"explicit allow" elicitation reply maps to a null decision.
// ---------------------------------------------------------------------------

let spawned: SpawnedServer;
let client: JsonRpcClient;

before(async () => {
  spawned = spawnStubServer();
  client = new JsonRpcClient(spawned.child);
  await client.initializeLegacy();
});

after(async () => {
  spawned.child.kill('SIGKILL');
});

async function runElicitationScenario(
  responder: (req: { id: number | string; method: string; params: unknown }) => void,
): Promise<CallToolResultShape> {
  client.onServerRequest(responder);
  try {
    return (await client.callTool('opencode', {
      prompt: JSON.stringify({ mode: 'elicit', permission: 'bash', patterns: ['rm -rf /'] }),
    })) as CallToolResultShape;
  } finally {
    client.onServerRequest(() => {});
  }
}

test('U05j: accept with no content maps to a null decision', async () => {
  const result = await runElicitationScenario((req) => {
    client.respond(req.id, { action: 'accept' });
  });
  assert.equal(result.structuredContent?.content, 'decision:null');
});

test('U05j: accept with an unrecognized decision value maps to a null decision', async () => {
  const result = await runElicitationScenario((req) => {
    client.respond(req.id, { action: 'accept', content: { decision: 'yes' } });
  });
  assert.equal(result.structuredContent?.content, 'decision:null');
});

test('U05j: a cancel action maps to a null decision', async () => {
  const result = await runElicitationScenario((req) => {
    client.respond(req.id, { action: 'cancel' });
  });
  assert.equal(result.structuredContent?.content, 'decision:null');
});
