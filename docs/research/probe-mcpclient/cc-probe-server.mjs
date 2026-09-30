// stdio MCP server used to observe Claude Code's MCP client behaviour.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import fs from 'node:fs';
const LOG = process.env.PROBE_LOG || '/work/fake/server.log';
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
const server = new McpServer({ name: 'cc-probe', version: '0.0.1' }, { capabilities: { logging: {} } });
server.server.oninitialized = () => log(`initialized client=${JSON.stringify(server.server.getClientVersion())} caps=${JSON.stringify(server.server.getClientCapabilities())}`);
server.registerTool('work', {
  description: 'Sleep total_ms, optionally sending progress every progress_ms; returns structured and text content',
  inputSchema: { total_ms: z.number().int(), progress_ms: z.number().int().default(0), big_chars: z.number().int().default(0), structured: z.boolean().default(true) },
  outputSchema: { status: z.string(), elapsed_ms: z.number(), cancelled: z.boolean(), note: z.string() },
}, async ({ total_ms, progress_ms, big_chars, structured }, extra) => {
  const t0 = Date.now();
  const token = extra._meta?.progressToken;
  log(`work start id=${extra.requestId} progressToken=${JSON.stringify(token)} meta=${JSON.stringify(extra._meta ?? {})} args=${JSON.stringify({ total_ms, progress_ms, big_chars, structured })}`);
  extra.signal.addEventListener('abort', () => log(`work id=${extra.requestId} ABORTED after ${Date.now() - t0}ms reason=${String(extra.signal.reason)}`));
  let k = 0;
  while (Date.now() - t0 < total_ms && !extra.signal.aborted) {
    await new Promise(r => setTimeout(r, Math.min(progress_ms || 250, 250)));
    if (progress_ms && token !== undefined && Date.now() - t0 >= (k + 1) * progress_ms) {
      k++; await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: k, message: `heartbeat ${k}` } });
    }
  }
  const out = { status: extra.signal.aborted ? 'cancelled' : 'done', elapsed_ms: Date.now() - t0, cancelled: extra.signal.aborted, note: big_chars ? 'x'.repeat(big_chars) : 'structured-note' };
  log(`work end id=${extra.requestId} ${JSON.stringify({ ...out, note: out.note.slice(0, 30) })}`);
  return { content: [{ type: 'text', text: `TEXT-BLOCK: status=${out.status} elapsed=${out.elapsed_ms}` + (big_chars ? ' ' + 'y'.repeat(big_chars) : '') }], ...(structured ? { structuredContent: out } : {}) };
});
server.registerTool('plain', { description: 'text-only result', inputSchema: { chars: z.number().int().default(10) } }, async ({ chars }) => ({ content: [{ type: 'text', text: 'P'.repeat(chars) }] }));
server.registerTool('ask', { description: 'form elicitation', inputSchema: {} }, async () => {
  const caps = server.server.getClientCapabilities();
  log(`ask caps=${JSON.stringify(caps)}`);
  try {
    const r = await server.server.elicitInput({ message: 'Allow OpenCode to edit src/app.ts?', requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } });
    log(`ask result=${JSON.stringify(r)}`);
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } catch (e) { log(`ask error=${e.message}`); return { content: [{ type: 'text', text: 'elicitation failed: ' + e.message }], isError: true }; }
});
process.stdin.on('end', () => log('stdin EOF (client closed)'));
process.on('exit', () => log('process exit'));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { log(`signal ${sig}`); process.exit(0); });
process.stdin.on('close', () => log('stdin close'));
await server.connect(new StdioServerTransport());
log(`connected cwd=${process.cwd()} CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR} envKeys=${Object.keys(process.env).sort().join(',')}`);
