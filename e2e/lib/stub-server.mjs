#!/usr/bin/env node
// Tiny raw JSON-RPC stdio MCP-ish server, used only to validate e2e/lib/mcp-client.mjs
// before the real opencode-mcp entry point (src/index.ts) exists. No third-party deps.
// Not a real MCP server: no schema validation, no outputSchema/structuredContent
// enforcement — just enough wire protocol to exercise the client: initialize handshake,
// tools/list, tools/call, notifications/progress, notifications/cancelled and a
// server-initiated elicitation/create round trip.
//
// Tools:
//   echo  {text}                          -> immediate result echoing the input
//   slow  {ms, progressEveryMs?}          -> waits `ms`, emitting progress every
//                                            progressEveryMs (if a progressToken was
//                                            sent); sends NO response if cancelled
//   ask   {message?}                      -> sends elicitation/create to the client and
//                                            returns whatever it answered
//   boom  {}                              -> always returns isError:true

import { createInterface } from 'node:readline';

const LOG = process.env.STUB_LOG ? (s) => process.stderr.write(`[stub] ${s}\n`) : () => {};

const TOOLS = [
  { name: 'echo', description: 'echoes input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  {
    name: 'slow',
    description: 'sleeps ms, emitting progress',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' }, progressEveryMs: { type: 'number' } } },
  },
  { name: 'ask', description: 'elicitation round trip', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  { name: 'boom', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
];

const cancelled = new Set();
let nextServerRequestId = -1; // negative ids so they never collide with client-issued positive ids
const pendingServerRequests = new Map();

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function toolResult(structuredContent, { isError = false } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendServerRequest(method, params) {
  const id = nextServerRequestId--;
  const promise = new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject });
  });
  write({ jsonrpc: '2.0', id, method, params });
  return promise;
}

async function handleToolCall(msg) {
  const { id, params } = msg;
  const name = params?.name;
  const args = params?.arguments ?? {};
  const token = params?._meta?.progressToken;
  LOG(`tools/call id=${id} name=${name} args=${JSON.stringify(args)} token=${JSON.stringify(token)}`);

  try {
    if (name === 'echo') {
      respond(id, toolResult({ kind: 'echo', text: args.text ?? null }));
      return;
    }

    if (name === 'slow') {
      const ms = Number(args.ms ?? 3000);
      const step = Number(args.progressEveryMs ?? 500);
      const start = Date.now();
      let n = 0;
      while (Date.now() - start < ms) {
        if (cancelled.has(id)) {
          cancelled.delete(id);
          LOG(`tools/call id=${id} cancelled mid-flight, sending no response`);
          return;
        }
        await sleep(Math.max(1, Math.min(step, ms - (Date.now() - start))));
        n++;
        if (token !== undefined) {
          notify('notifications/progress', { progressToken: token, progress: n, message: `tick ${n}` });
        }
      }
      if (cancelled.has(id)) {
        cancelled.delete(id);
        return;
      }
      respond(id, toolResult({ kind: 'slow', elapsedMs: Date.now() - start, ticks: n }));
      return;
    }

    if (name === 'ask') {
      const answer = await sendServerRequest('elicitation/create', {
        message: args.message ?? 'Allow this action?',
        requestedSchema: {
          type: 'object',
          properties: { decision: { type: 'string', enum: ['allow', 'reject'] } },
          required: ['decision'],
        },
      });
      respond(id, toolResult({ kind: 'ask', answer }));
      return;
    }

    if (name === 'boom') {
      respond(id, toolResult({ kind: 'boom' }, { isError: true }));
      return;
    }

    respondError(id, -32602, `unknown tool: ${name}`);
  } catch (err) {
    respondError(id, -32000, `handler error: ${err?.message ?? err}`);
  }
}

function onMessage(msg) {
  if (msg.method === 'notifications/cancelled') {
    LOG(`notifications/cancelled requestId=${msg.params?.requestId}`);
    cancelled.add(msg.params?.requestId);
    return;
  }

  if (msg.method === 'notifications/initialized') {
    LOG('client initialized');
    return;
  }

  if (msg.id !== undefined && msg.method === undefined) {
    // Response to one of our server-initiated requests (e.g. elicitation/create).
    const pending = pendingServerRequests.get(msg.id);
    if (pending) {
      pendingServerRequests.delete(msg.id);
      if ('error' in msg) pending.reject(new Error(msg.error?.message ?? 'client error'));
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'stub-mcp-server', version: '0.0.1' },
      instructions: 'stub-mcp-server: for e2e/lib/mcp-client.mjs self-test only.',
    });
    return;
  }

  if (msg.method === 'tools/list') {
    respond(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === 'tools/call') {
    handleToolCall(msg);
    return;
  }

  if (msg.id !== undefined) {
    respondError(msg.id, -32601, `stub-mcp-server: method not found: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stderr.write(`stub-mcp-server: bad JSON line: ${err}\n`);
    return;
  }
  onMessage(msg);
});

process.stdin.on('end', () => {
  LOG('stdin EOF, exiting');
  process.exit(0);
});

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    LOG(`signal ${sig}, exiting`);
    process.exit(0);
  });
}

LOG('stub-mcp-server ready');
