// Client on split v2 package (@modelcontextprotocol/client)
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const serverFile = process.argv[2];
const cwd = process.argv[3];
const mode = process.argv[4] ?? 'legacy';
const client = new Client({ name: 'probe-client-v2', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: mode === 'auto' ? 'auto' : 'legacy' } });
client.setRequestHandler('elicitation/create', async (req) => { console.log('ELICIT received (push):', JSON.stringify(req.params)); return { action: 'accept', content: { decision: 'allow' } }; });
const transport = new StdioClientTransport({ command: 'node', args: [serverFile], cwd, stderr: 'inherit' });
await client.connect(transport);
console.log('connected; era =', typeof client.getProtocolEra === 'function' ? client.getProtocolEra() : '(n/a)', 'server', JSON.stringify(client.getServerVersion?.()));
const progress = [];
const r1 = await client.callTool({ name: 'slow', arguments: { steps: 3, ms: 100 } }, { onprogress: (p) => progress.push(p) });
console.log('slow result:', JSON.stringify(r1), 'progress:', JSON.stringify(progress));
const ac = new AbortController(); setTimeout(() => ac.abort('esc'), 450);
try { await client.callTool({ name: 'slow', arguments: { steps: 20, ms: 100 } }, { signal: ac.signal }); console.log('cancel: completed?!'); } catch (e) { console.log('cancel error:', e.message); }
await new Promise(r => setTimeout(r, 600));
try { const r4 = await client.callTool({ name: 'ask', arguments: {} }); console.log('ask result:', JSON.stringify(r4)); } catch (e) { console.log('ask error:', e.message); }
try { const r5 = await client.callTool({ name: 'ask_mrtr', arguments: {} }); console.log('ask_mrtr result:', JSON.stringify(r5)); } catch (e) { console.log('ask_mrtr error:', e.message); }
await client.close();
