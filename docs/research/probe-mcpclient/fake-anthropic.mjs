// Minimal fake Anthropic Messages API for driving Claude Code headless (no real model, no secrets).
// The user prompt must contain: TOOL=<full tool name> ARGS=<json>. First turn -> tool_use, next turn -> text.
import http from 'node:http';
import fs from 'node:fs';
const PORT = Number(process.env.FAKE_PORT || 18080);
const LOG = process.env.FAKE_LOG || '/work/fake';
fs.mkdirSync(LOG, { recursive: true });
let n = 0;
function textOf(content) { if (typeof content === 'string') return content; return (content || []).map(b => b.type === 'text' ? b.text : '').join(''); }
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
function msgStart(id) { return ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fake-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]; }
http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const i = ++n;
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    fs.writeFileSync(`${LOG}/req-${String(i).padStart(3, '0')}.json`, JSON.stringify({ method: req.method, url: req.url, body: j }, null, 1));
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 100 })); }
      res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake' } }));
    }
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1] || {};
    const hasToolResult = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result');
    const firstUser = msgs.find(m => m.role === 'user');
    const allText = msgs.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n');
    const m = /TOOL=(\S+) ARGS=(\{.*?\})(?:\s|$)/.exec(allText);
    const id = `msg_fake_${i}`;
    if (m && !hasToolResult) {
      const tools = (j.tools || []).map(t => t.name);
      fs.writeFileSync(`${LOG}/tools-${String(i).padStart(3, '0')}.json`, JSON.stringify(j.tools || [], null, 1));
      const ev = [msgStart(id),
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${i}`, name: m[1], input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: m[2] } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }]];
      if (j.stream) return sse(res, ev);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id: `toolu_fake_${i}`, name: m[1], input: JSON.parse(m[2]) }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    if (hasToolResult) fs.writeFileSync(`${LOG}/toolresult-${String(i).padStart(3, '0')}.json`, JSON.stringify(last.content, null, 1));
    const text = hasToolResult ? 'FAKE: got tool result' : 'FAKE: ok';
    const ev = [msgStart(id),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }]];
    if (j.stream) return sse(res, ev);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
  });
}).listen(PORT, '127.0.0.1', () => console.error(`fake anthropic on ${PORT}`));
