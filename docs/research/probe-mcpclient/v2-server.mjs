// Probe server on split v2 packages (@modelcontextprotocol/server)
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'probe-v2', version: '0.0.1' }, { capabilities: { logging: {} } });
  server.registerTool('slow', {
    title: 'Slow',
    description: 'Emit progress notifications, honour cancellation',
    inputSchema: z.object({ steps: z.number().int().min(1).max(50), ms: z.number().int().default(200) }),
    outputSchema: z.object({ done: z.number(), cancelled: z.boolean() }),
  }, async ({ steps, ms }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    process.stderr.write(`[v2 server] progressToken=${JSON.stringify(token)} id=${ctx.mcpReq.id} envelope=${JSON.stringify(ctx.mcpReq.envelope ?? null)}\n`);
    let i = 0;
    for (; i < steps; i++) {
      if (ctx.mcpReq.signal.aborted) break;
      await new Promise(r => setTimeout(r, ms));
      if (token !== undefined) {
        await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: i + 1, total: steps, message: `step ${i + 1}` } });
      }
      try { await ctx.mcpReq.log('info', `log step ${i + 1}`); } catch (e) { if (i === 0) process.stderr.write(`[v2 server] log failed: ${e.message}\n`); }
    }
    const out = { done: i, cancelled: ctx.mcpReq.signal.aborted };
    process.stderr.write(`[v2 server] handler finished ${JSON.stringify(out)}\n`);
    return { content: [{ type: 'text', text: `human text: ${JSON.stringify(out)}` }], structuredContent: out };
  });
  server.registerTool('ask', { description: 'Form elicitation', inputSchema: z.object({}) }, async (_a, ctx) => {
    try {
      const r = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Allow OpenCode to run `rm -rf build`?', requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } });
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `elicitInput threw: ${e.message}` }], isError: true };
    }
  });
  server.registerTool('ask_mrtr', { description: 'MRTR elicitation (2026-07-28)', inputSchema: z.object({}) }, async (_a, ctx) => {
    const resp = ctx.mcpReq.inputResponses?.approve;
    process.stderr.write(`[v2 server] ask_mrtr round: inputResponses=${JSON.stringify(ctx.mcpReq.inputResponses ?? null)} state=${JSON.stringify(ctx.mcpReq.requestState())}\n`);
    if (!resp) {
      return inputRequired({ inputRequests: { approve: inputRequired.elicit({ message: 'MRTR: allow edit?', requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } }) }, requestState: 'job-123' });
    }
    return { content: [{ type: 'text', text: 'MRTR got ' + JSON.stringify(resp) }] };
  });
  return server;
});
process.stderr.write('[v2 server] serveStdio started\n');
