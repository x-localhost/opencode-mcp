// Client on SDK v1 (what Claude Code's v1 runtime / legacy negotiation looks like)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const serverFile = process.argv[2];
const cwd = process.argv[3];
const client = new Client({ name: 'probe-client-v1', version: '0.0.1' }, { capabilities: { elicitation: {}, roots: { listChanged: true } } });
client.setRequestHandler(ElicitRequestSchema, async (req) => { console.log('ELICIT received:', JSON.stringify(req.params)); return { action: 'accept', content: { decision: 'deny' } }; });
let logs = 0; client.setNotificationHandler(LoggingMessageNotificationSchema, () => { logs++; });
const transport = new StdioClientTransport({ command: 'node', args: [serverFile], cwd, stderr: 'inherit' });
await client.connect(transport);
console.log('server version/caps:', JSON.stringify(client.getServerVersion()), JSON.stringify(client.getServerCapabilities()), 'protocol', transport._protocolVersion ?? '(n/a)');
const tools = await client.listTools();
for (const t of tools.tools) console.log('tool', t.name, 'input', JSON.stringify(t.inputSchema), 'output', JSON.stringify(t.outputSchema ?? null));
// 1. progress
const progress = [];
const r1 = await client.callTool({ name: 'slow', arguments: { steps: 3, ms: 100 } }, undefined, { onprogress: (p) => progress.push(p) });
console.log('slow result:', JSON.stringify(r1), 'progress events:', JSON.stringify(progress), 'log notifications:', logs);
// 2. cancellation via AbortSignal -> notifications/cancelled
const ac = new AbortController();
setTimeout(() => ac.abort('user pressed esc'), 450);
try { await client.callTool({ name: 'slow', arguments: { steps: 20, ms: 100 } }, undefined, { signal: ac.signal }); console.log('cancel: unexpectedly completed'); }
catch (e) { console.log('cancel: client-side error =', e.name, e.message); }
await new Promise(r => setTimeout(r, 600));
// 3. timeout with resetTimeoutOnProgress
try { const r = await client.callTool({ name: 'slow', arguments: { steps: 6, ms: 300 } }, undefined, { timeout: 500, resetTimeoutOnProgress: true, onprogress: () => {} }); console.log('resetTimeoutOnProgress: completed ok', JSON.stringify(r.structuredContent)); }
catch (e) { console.log('resetTimeoutOnProgress: error', e.message); }
try { await client.callTool({ name: 'slow', arguments: { steps: 6, ms: 300 } }, undefined, { timeout: 500, onprogress: () => {} }); console.log('hard timeout: completed?!'); }
catch (e) { console.log('hard timeout (no reset): error =', e.message); }
await new Promise(r => setTimeout(r, 2000));
// 4. elicitation
const r4 = await client.callTool({ name: 'ask', arguments: {} });
console.log('ask result:', JSON.stringify(r4));
// 5. outputSchema violation
try { const r5 = await client.callTool({ name: 'bad_output', arguments: {} }); console.log('bad_output result:', JSON.stringify(r5)); } catch (e) { console.log('bad_output client error:', e.message); }
await client.close();
