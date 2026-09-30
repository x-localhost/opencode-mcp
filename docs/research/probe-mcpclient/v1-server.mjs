// Probe server on @modelcontextprotocol/sdk v1.x
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'probe-v1', version: '0.0.1' }, { capabilities: { logging: {} } });

server.registerTool('slow', {
  title: 'Slow',
  description: 'Emit progress + log notifications, honour cancellation',
  inputSchema: { steps: z.number().int().min(1).max(50), ms: z.number().int().default(200) },
  outputSchema: { done: z.number(), cancelled: z.boolean() },
}, async ({ steps, ms }, extra) => {
  const token = extra._meta?.progressToken;
  process.stderr.write(`[v1 server] progressToken=${JSON.stringify(token)} requestId=${extra.requestId}\n`);
  let i = 0;
  for (; i < steps; i++) {
    if (extra.signal.aborted) break;
    await new Promise(r => setTimeout(r, ms));
    if (token !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i + 1, total: steps, message: `step ${i + 1}` } });
    }
    await server.sendLoggingMessage({ level: 'info', data: `log step ${i + 1}` });
  }
  const out = { done: i, cancelled: extra.signal.aborted };
  process.stderr.write(`[v1 server] handler finished ${JSON.stringify(out)}\n`);
  return { content: [{ type: 'text', text: `human text: ${JSON.stringify(out)}` }], structuredContent: out };
});

server.registerTool('ask', { description: 'Form elicitation', inputSchema: {} }, async () => {
  const caps = server.server.getClientCapabilities();
  process.stderr.write(`[v1 server] client caps=${JSON.stringify(caps)} client=${JSON.stringify(server.server.getClientVersion())}\n`);
  if (!caps?.elicitation) return { content: [{ type: 'text', text: 'client lacks elicitation' }], isError: true };
  const r = await server.server.elicitInput({ message: 'Allow OpenCode to run `rm -rf build`?', requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } });
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
});

server.registerTool('bad_output', { description: 'outputSchema but no structuredContent', inputSchema: {}, outputSchema: { x: z.number() } }, async () => ({ content: [{ type: 'text', text: 'no structured' }] }));

await server.connect(new StdioServerTransport());
process.stderr.write('[v1 server] connected\n');
