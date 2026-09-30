// v2-SDK stdio server (serveStdio) used to observe Claude Code era negotiation + MRTR.
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import fs from 'node:fs';
const LOG = process.env.PROBE_LOG || '/work/fake/server.log';
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`signal ${sig}`); process.exit(0); });
serveStdio(() => {
  const server = new McpServer({ name: 'cc-probe-v2', version: '0.0.1' });
  server.server.oninitialized = () => log(`legacy initialized client=${JSON.stringify(server.server.getClientVersion())} caps=${JSON.stringify(server.server.getClientCapabilities())}`);
  server.registerTool('work', { description: 'progress probe', inputSchema: z.object({ total_ms: z.number().int() }) }, async ({ total_ms }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    log(`work start id=${ctx.mcpReq.id} token=${JSON.stringify(token)} envelope=${JSON.stringify(ctx.mcpReq.envelope ?? null)} meta=${JSON.stringify(ctx.mcpReq._meta ?? null)}`);
    const t0 = Date.now(); let k = 0;
    while (Date.now() - t0 < total_ms && !ctx.mcpReq.signal.aborted) { await new Promise(r => setTimeout(r, 200)); if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++k } }); }
    return { content: [{ type: 'text', text: `work done k=${k}` }] };
  });
  server.registerTool('ask_mrtr', { description: 'MRTR elicitation probe', inputSchema: z.object({}) }, async (_a, ctx) => {
    log(`ask_mrtr round inputResponses=${JSON.stringify(ctx.mcpReq.inputResponses ?? null)} state=${JSON.stringify(ctx.mcpReq.requestState())} envelope=${JSON.stringify(ctx.mcpReq.envelope ?? null)}`);
    const resp = ctx.mcpReq.inputResponses?.approve;
    if (!resp) return inputRequired({ inputRequests: { approve: inputRequired.elicit({ message: 'Allow OpenCode to edit src/app.ts?', requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } }) }, requestState: 'job-42' });
    return { content: [{ type: 'text', text: 'decision=' + JSON.stringify(resp) }] };
  });
  return server;
});
log('serveStdio started');
