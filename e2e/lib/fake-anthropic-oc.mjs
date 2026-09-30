#!/usr/bin/env node
// Minimal fake Anthropic Messages API driving headless Claude Code through a fixed two-call
// script against opencode-mcp (scenario k, stretch): adapted from
// docs/research/probe-mcpclient/fake-anthropic.mjs, specialized for this exact flow instead of
// the generic single-TOOL=/ARGS= probe:
//
//   turn 1 (no tool_result yet)                -> tool_use mcp__opencode__opencode {prompt:...}
//   turn 2 (tool_result for that opencode call) -> tool_use mcp__opencode__opencode-end {sessionId}
//   turn 3 (tool_result for that opencode-end)  -> final text
//
// No third-party deps (node:http, node:fs only). Dummy API key only; no real network.
//
//   FAKE_PORT=18080 FAKE_LOG=/work/fake-anthropic node fake-anthropic-oc.mjs
//
// Writes every request body and the two tool_result payloads it observes under FAKE_LOG, so the
// test can assert on them after the `claude -p` run exits.

import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.FAKE_PORT || 18080);
const LOG = process.env.FAKE_LOG || '/work/fake-anthropic';
const OPENCODE_TOOL = process.env.OPENCODE_TOOL_NAME || 'mcp__opencode__opencode';
const OPENCODE_END_TOOL = process.env.OPENCODE_END_TOOL_NAME || 'mcp__opencode__opencode-end';
const WRITE_PROMPT = process.env.OPENCODE_PROMPT || 'WRITE_FILE please create hello.txt';

fs.mkdirSync(LOG, { recursive: true });
let n = 0;

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return '';
}

// Claude Code 2.1.284 was observed (docker on gram, this scenario) to append its own
// `<system-reminder><total_tokens>N tokens left</total_tokens></system-reminder>` block after the
// MCP tool_result content when relaying it to the model — *in addition to* the plain
// JSON.stringify(structuredContent) text docs/research/mcp-client.md §3.6 documented. Since
// JSON.stringify never emits a literal newline, the actual JSON payload is always exactly the
// first line; anything after the first blank line is Claude Code's own added context, not ours.
function extractJsonPrefix(text) {
  return text.split('\n', 1)[0];
}

function findToolUseName(msgs, toolUseId) {
  for (const m of msgs) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id === toolUseId) return b.name;
    }
  }
  return null;
}

function lastToolResult(msgs) {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b.type === 'tool_result') ?? null;
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function msgStart(id) {
  return [
    'message_start',
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fake-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  ];
}

function toolUseEvents(id, callId, name, args) {
  const argsJson = JSON.stringify(args);
  return [
    msgStart(id),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argsJson } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function textEvents(id, text) {
  return [
    msgStart(id),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function toolUseJson(id, callId, name, args) {
  return { id, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id: callId, name, input: args }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
}

function textJson(id, text) {
  return { id, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}

const server = http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const i = ++n;
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* ignore */ }
      fs.writeFileSync(`${LOG}/req-${String(i).padStart(3, '0')}.json`, JSON.stringify({ method: req.method, url: req.url, body: j }, null, 1));

      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        if (req.url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ input_tokens: 100 }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake' } }));
      }

      const msgs = j.messages || [];
      const id = `msg_fake_${i}`;
      const tr = lastToolResult(msgs);

      let plan;
      if (!tr) {
        plan = { kind: 'tool', name: OPENCODE_TOOL, args: { prompt: WRITE_PROMPT, sandbox: 'workspace-write' }, callId: `toolu_fake_${i}` };
      } else {
        const toolName = findToolUseName(msgs, tr.tool_use_id);
        const resultText = toolResultText(tr);
        if (toolName === OPENCODE_TOOL) {
          fs.writeFileSync(`${LOG}/toolresult-opencode.json`, resultText);
          let sessionId;
          try { sessionId = JSON.parse(extractJsonPrefix(resultText)).sessionId; } catch { sessionId = undefined; }
          plan = { kind: 'tool', name: OPENCODE_END_TOOL, args: { sessionId }, callId: `toolu_fake_${i}` };
        } else if (toolName === OPENCODE_END_TOOL) {
          fs.writeFileSync(`${LOG}/toolresult-opencode-end.json`, resultText);
          plan = { kind: 'text', text: 'FAKE: opencode delegation complete' };
        } else {
          plan = { kind: 'text', text: `FAKE: unexpected tool result from ${toolName}` };
        }
      }

      if (plan.kind === 'tool') {
        if (j.stream) return sse(res, toolUseEvents(id, plan.callId, plan.name, plan.args));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(toolUseJson(id, plan.callId, plan.name, plan.args)));
      }
      if (j.stream) return sse(res, textEvents(id, plan.text));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(textJson(id, plan.text)));
    });
  });
server.listen(PORT, '127.0.0.1', () => console.error(`fake-anthropic-oc listening on http://127.0.0.1:${server.address().port}`));
