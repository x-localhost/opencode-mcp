#!/usr/bin/env node
// Research spike driver (probe-overload): for each simulated LLM-gateway-overload behaviour,
// drives TWO independent sessions against the SAME real `opencode serve` (opencode-ai@1.18.33)
// and the SAME extended fake LLM (fake-llm-overload-server.mjs, a research copy of
// e2e/fake-llm-server.mjs):
//   (A) "raw"     — direct HTTP against opencode serve's own REST/SSE API (no opencode-mcp in the
//                   loop at all), to observe OpenCode's own behaviour in isolation: number/timing of
//                   its own provider retries (session.status {type:"retry"} / `retry` parts), the
//                   final assistant message shape, and time to session.idle.
//   (B) "bridged" — through the real dist/opencode-mcp.mjs bundle (attach mode, pointed at the same
//                   opencode serve) via e2e/lib/mcp-client.mjs, calling the `opencode` tool and then
//                   `opencode-reply`, to observe what opencode-mcp 0.2.0 reports.
//
// Never edits e2e/fake-llm-server.mjs or e2e/lib/*; only imports from them (absolute /work paths,
// this script runs inside the ocmcp-probe-overload:local container). Network is disabled at the
// container level (--network none); everything here talks only to 127.0.0.1.
//
// Output: one <directive>.json per directive under OUT_DIR (raw evidence: every SSE event, every
// fake-LLM request, every raw message, the MCP tool result), plus summary.json + a printed table.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

import { McpClient } from '/work/e2e/lib/mcp-client.mjs';
import {
  createTempRepo,
  buildOpencodeConfig,
  sleep,
  startExternalOpencodeServer,
} from '/work/e2e/lib/harness.mjs';

const OUT_DIR = process.env.PROBE_OUT_DIR || '/work/probe-out';
mkdirSync(OUT_DIR, { recursive: true });

const nowIso = () => new Date().toISOString();
const nonce = () => randomBytes(4).toString('hex');

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}

/** Spawns the research copy of the fake LLM (extended with OVERLOAD_* directives), mirroring
 * e2e/lib/harness.mjs's startFakeLlm() but pointed at our own file instead of e2e/fake-llm-server.mjs
 * (which stays untouched). */
async function startFakeLlmOverload({ label = 'overload-llm' } = {}) {
  const child = spawn('node', ['/work/probe/fake-llm-overload-server.mjs'], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const baseUrl = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { rl.close(); reject(new Error(`fake-llm-overload (${label}) not ready; stderr=${stderr}`)); }, 10_000);
    rl.on('line', (line) => {
      const m = /fake-llm listening on (http:\/\/\S+)/.exec(line);
      if (m) { clearTimeout(timer); rl.close(); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`fake-llm-overload exited early code=${code} stderr=${stderr}`)); });
  });
  return {
    baseUrl,
    async requests() { return (await fetch(`${baseUrl}/__requests`)).json(); },
    async reset() { await fetch(`${baseUrl}/__reset`, { method: 'POST' }); },
    stderr() { return stderr; },
    async stop() {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000).then(() => child.kill('SIGKILL'))]);
    },
  };
}

/** Raw SSE subscriber against opencode serve's own GET /event?directory=, Basic-auth'd. Collects
 * every decoded event (bounded) until stop(). Mirrors docs/research/samples/drive-session.mjs's own
 * SSE parsing (data:...\n\n framing), with Basic auth added (that sample ran unauthenticated). */
function subscribeRawEvents({ baseUrl, username, password, directory }) {
  const events = [];
  const controller = new AbortController();
  const url = new URL('event', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('directory', directory);
  const MAX_EVENTS = 2000;
  const donePromise = (async () => {
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: 'text/event-stream', authorization: basicAuth(username, password) },
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name !== 'AbortError') events.push({ t: Date.now(), subscribeError: String(err) });
      return;
    }
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          if (events.length >= MAX_EVENTS) continue;
          try { events.push({ t: Date.now(), event: JSON.parse(data) }); }
          catch { events.push({ t: Date.now(), unparsed: data }); }
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') events.push({ t: Date.now(), readError: String(err) });
    }
  })();
  return {
    events,
    async stop() { controller.abort(); await donePromise.catch(() => {}); },
  };
}

async function rawCall(baseUrl, { username, password, directory }, method, path, body) {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('directory', directory);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: basicAuth(username, password),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

/** Extracts retry evidence (both the session.status{type:"retry"} event shape and the `retry`
 * message-part shape documented in docs/research/opencode-api.md §6) from a raw event list. */
function extractRetryEvidence(events) {
  const statusRetries = events
    .filter((e) => e.event?.type === 'session.status' && e.event?.properties?.status?.type === 'retry')
    .map((e) => ({ t: e.t, ...e.event.properties.status }));
  const partRetries = events
    .filter((e) => e.event?.type === 'message.part.updated' && e.event?.properties?.part?.type === 'retry')
    .map((e) => ({ t: e.t, ...e.event.properties.part }));
  return { statusRetries, partRetries };
}

function finalAssistant(messages) {
  if (!Array.isArray(messages)) return undefined;
  return [...messages].reverse().find((m) => m.info?.role === 'assistant');
}

/** Drive (A): raw HTTP against opencode serve directly, no opencode-mcp involved. Returns evidence
 * for the report's "What OpenCode does" column. */
async function driveRaw({ baseUrl, username, password, directory, prompt, idleTimeoutMs }) {
  const sub = subscribeRawEvents({ baseUrl, username, password, directory });
  await sleep(150); // let the SSE subscription actually attach before we create the session
  const t0 = Date.now();
  const created = await rawCall(baseUrl, { username, password, directory }, 'POST', '/session', { title: `probe-overload ${nowIso()}` });
  const sid = created.json?.id;
  let idleEvent, idleTimedOut = false;
  if (sid) {
    const pa = await rawCall(baseUrl, { username, password, directory }, 'POST', `/session/${sid}/prompt_async`, {
      model: { providerID: 'fake', modelID: 'fake-model' },
      parts: [{ type: 'text', text: prompt }],
    });
    const deadline = Date.now() + idleTimeoutMs;
    for (;;) {
      idleEvent = sub.events.find(
        (e) =>
          (e.event?.type === 'session.idle' && e.event.properties?.sessionID === sid) ||
          (e.event?.type === 'session.status' && e.event.properties?.sessionID === sid && e.event.properties?.status?.type === 'idle') ||
          (e.event?.type === 'session.error' && e.event.properties?.sessionID === sid),
      );
      if (idleEvent) break;
      if (Date.now() >= deadline) { idleTimedOut = true; break; }
      await sleep(250);
    }
  }
  const t1 = Date.now();
  // ALWAYS abort before returning, even when idle was reached quickly ("abort on an idle session
  // also returns true" per docs/research/opencode-api.md §8) -- critical when idleTimedOut: without
  // this, an OpenCode turn that never reaches session.idle (e.g. a tight zero-backoff retry loop)
  // keeps running server-side after this probe moves on, silently polluting every later directive's
  // fake-LLM request count (same process, same fake LLM, same marker-text matching).
  let abortResult;
  if (sid) {
    abortResult = await rawCall(baseUrl, { username, password, directory }, 'POST', `/session/${sid}/abort`);
    // Give the abort a moment to actually land before we snapshot messages/status.
    await sleep(400);
  }
  await sleep(300);
  await sub.stop();
  let messages, sessionStatus;
  if (sid) {
    messages = (await rawCall(baseUrl, { username, password, directory }, 'GET', `/session/${sid}/message`)).json;
    sessionStatus = (await rawCall(baseUrl, { username, password, directory }, 'GET', 'session/status')).json;
  }
  const retryEvidence = extractRetryEvidence(sub.events);
  const last = finalAssistant(messages);
  return {
    sessionId: sid,
    createHttpStatus: created.status,
    idleTimedOut,
    abortResult,
    elapsedToIdleMs: t1 - t0,
    finalAssistant: last
      ? {
          finish: last.info?.finish,
          error: last.info?.error,
          timeCompleted: last.info?.time?.completed,
          textParts: last.parts?.filter((p) => p.type === 'text').map((p) => p.text),
          toolParts: last.parts?.filter((p) => p.type === 'tool').map((p) => ({ tool: p.tool, status: p.state?.status })),
        }
      : undefined,
    sessionStatus,
    retryEvidence,
    eventTypes: [...new Set(sub.events.map((e) => e.event?.type).filter(Boolean))],
    rawEvents: sub.events,
    rawMessages: messages,
  };
}

/** Drive (B): through the real opencode-mcp bundle (attach mode -> the same opencode serve), via
 * the dependency-free MCP client. Returns evidence for the "What opencode-mcp returns" column. */
async function driveBridged({ client, prompt, timeoutSeconds, clientTimeoutMs }) {
  const t0 = Date.now();
  let result, toolError;
  try {
    result = await client.callTool('opencode', { prompt, 'timeout-seconds': timeoutSeconds }, { timeoutMs: clientTimeoutMs });
  } catch (err) {
    toolError = { name: err.name, message: err.message, code: err.code, data: err.data };
  }
  const t1 = Date.now();
  const structured = result?.structuredContent;
  let replyResult, replyError, replyElapsedMs;
  if (structured?.sessionId) {
    const rt0 = Date.now();
    try {
      const r2 = await client.callTool(
        'opencode-reply',
        { sessionId: structured.sessionId, prompt: 'PROBE_FOLLOWUP still there?' },
        { timeoutMs: 30_000 },
      );
      replyResult = { isError: r2.isError, structuredContent: r2.structuredContent };
    } catch (err) {
      replyError = { name: err.name, message: err.message, code: err.code, data: err.data };
    }
    replyElapsedMs = Date.now() - rt0;
  }
  return {
    elapsedMs: t1 - t0,
    isError: result?.isError,
    content: result?.content,
    structuredContent: structured,
    toolError,
    replyResult,
    replyError,
    replyElapsedMs,
  };
}

async function main() {
  const repo = createTempRepo('probe-overload');
  const fakeLlm = await startFakeLlmOverload();
  const password = randomBytes(24).toString('base64url');
  const username = 'opencode';
  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl });
  console.log(`${nowIso()} starting external opencode serve (attach mode target)…`);
  const externalServer = await startExternalOpencodeServer({ cwd: repo.dir, configContent, password, username });
  console.log(`${nowIso()} opencode serve up at ${externalServer.url}, pid=${externalServer.pid}`);

  const env = {
    OPENCODE_MCP_SERVER_URL: externalServer.url,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_MCP_DEFAULT_CWD: repo.dir,
    OPENCODE_MCP_ALLOWED_ROOTS: repo.dir,
    OPENCODE_MCP_HEARTBEAT_SECONDS: '2',
  };
  const client = await McpClient.connect({ cwd: repo.dir, env, initializeTimeoutMs: 20_000 });
  console.log(`${nowIso()} opencode-mcp connected: ${JSON.stringify(client.serverInfo)}`);

  // marker: base OVERLOAD_* text (nonce appended per-drive for ONCE variants so raw/bridged never
  // share a counter). idleTimeoutMs bounds the RAW drive's wait for session.idle; timeoutSeconds/
  // clientTimeoutMs bound the BRIDGED drive's blocking `opencode` call.
  const directives = [
    { name: '1a-429-once', marker: 'OVERLOAD_429_ONCE', nonced: true, idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '1b-429-always', marker: 'OVERLOAD_429_ALWAYS', idleTimeoutMs: 45_000, timeoutSeconds: 40, clientTimeoutMs: 50_000 },
    { name: '2a-503-once', marker: 'OVERLOAD_503_ONCE', nonced: true, idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '2b-529-always', marker: 'OVERLOAD_529_ALWAYS', idleTimeoutMs: 90_000, timeoutSeconds: 90, clientTimeoutMs: 100_000 },
    { name: '3-empty-done', marker: 'OVERLOAD_EMPTY_DONE', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '4-empty-stop', marker: 'OVERLOAD_EMPTY_STOP', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '5-whitespace', marker: 'OVERLOAD_WHITESPACE', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '6-stream-cut', marker: 'OVERLOAD_STREAM_CUT', idleTimeoutMs: 90_000, timeoutSeconds: 90, clientTimeoutMs: 100_000 },
    { name: '7-malformed-sse', marker: 'OVERLOAD_MALFORMED_SSE', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '8-html-body', marker: 'OVERLOAD_HTML_BODY', idleTimeoutMs: 90_000, timeoutSeconds: 90, clientTimeoutMs: 100_000 },
    { name: '9-bad-tool-json', marker: 'OVERLOAD_BAD_TOOL_JSON', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
    { name: '10-slow-first-token', marker: 'OVERLOAD_SLOW_FIRST_TOKEN 40', idleTimeoutMs: 60_000, timeoutSeconds: 60, clientTimeoutMs: 70_000 },
    { name: '11-finish-length', marker: 'OVERLOAD_FINISH_LENGTH', idleTimeoutMs: 30_000, timeoutSeconds: 30, clientTimeoutMs: 40_000 },
  ];

  const only = process.env.PROBE_ONLY ? new Set(process.env.PROBE_ONLY.split(',').map((s) => s.trim())) : undefined;
  const selected = only ? directives.filter((d) => only.has(d.name)) : directives;
  console.log(`${nowIso()} running ${selected.length}/${directives.length} directive(s): ${selected.map((d) => d.name).join(', ')}`);

  const summary = [];

  for (const d of selected) {
    console.log(`\n${'='.repeat(70)}\n${nowIso()} DIRECTIVE ${d.name} (${d.marker})\n${'='.repeat(70)}`);

    // --- (A) raw HTTP drive ---
    const rawMarker = d.nonced ? `${d.marker}_${nonce()}` : d.marker;
    await fakeLlm.reset();
    console.log(`${nowIso()}   [raw] prompt="${rawMarker} please" idleTimeoutMs=${d.idleTimeoutMs}`);
    let raw;
    try {
      raw = await driveRaw({ baseUrl: externalServer.url, username, password, directory: repo.dir, prompt: `${rawMarker} please`, idleTimeoutMs: d.idleTimeoutMs });
    } catch (err) {
      raw = { driveError: String(err?.stack || err) };
    }
    const rawLlmRequests = await fakeLlm.requests();
    console.log(`${nowIso()}   [raw] done: idleTimedOut=${raw?.idleTimedOut} elapsedToIdleMs=${raw?.elapsedToIdleMs} finish=${raw?.finalAssistant?.finish} llmCalls=${rawLlmRequests.length} retries(status)=${raw?.retryEvidence?.statusRetries?.length ?? 0} retries(part)=${raw?.retryEvidence?.partRetries?.length ?? 0}`);

    // --- (B) opencode-mcp bridged drive ---
    const bridgedMarker = d.nonced ? `${d.marker}_${nonce()}` : d.marker;
    await fakeLlm.reset();
    console.log(`${nowIso()}   [bridged] prompt="${bridgedMarker} please" timeout-seconds=${d.timeoutSeconds}`);
    let bridged;
    try {
      bridged = await driveBridged({ client, prompt: `${bridgedMarker} please`, timeoutSeconds: d.timeoutSeconds, clientTimeoutMs: d.clientTimeoutMs });
    } catch (err) {
      bridged = { driveError: String(err?.stack || err) };
    }
    const bridgedLlmRequests = await fakeLlm.requests();
    console.log(`${nowIso()}   [bridged] done: status=${bridged?.structuredContent?.status} executionState=${bridged?.structuredContent?.executionState} errorName=${bridged?.structuredContent?.error?.name} elapsedMs=${bridged?.elapsedMs} llmCalls=${bridgedLlmRequests.length} replyStatus=${bridged?.replyResult?.structuredContent?.status ?? bridged?.replyError?.message}`);

    const record = {
      directive: d.name,
      marker: d.marker,
      raw: { ...raw, llmRequestCount: rawLlmRequests.length, llmRequestTimings: rawLlmRequests.map((r) => ({ seq: r.seq, time: r.time })) },
      bridged: { ...bridged, llmRequestCount: bridgedLlmRequests.length, llmRequestTimings: bridgedLlmRequests.map((r) => ({ seq: r.seq, time: r.time })) },
    };
    writeFileSync(join(OUT_DIR, `${d.name}.json`), JSON.stringify(record, null, 2));

    summary.push({
      directive: d.name,
      raw_llmCalls: rawLlmRequests.length,
      raw_elapsedToIdleMs: raw?.elapsedToIdleMs,
      raw_idleTimedOut: raw?.idleTimedOut,
      raw_finish: raw?.finalAssistant?.finish,
      raw_errorName: raw?.finalAssistant?.error?.name,
      raw_textEmpty: raw?.finalAssistant?.textParts ? raw.finalAssistant.textParts.join('') === '' : undefined,
      raw_statusRetries: raw?.retryEvidence?.statusRetries?.length ?? 0,
      raw_partRetries: raw?.retryEvidence?.partRetries?.length ?? 0,
      bridged_llmCalls: bridgedLlmRequests.length,
      bridged_elapsedMs: bridged?.elapsedMs,
      bridged_status: bridged?.structuredContent?.status,
      bridged_executionState: bridged?.structuredContent?.executionState,
      bridged_errorName: bridged?.structuredContent?.error?.name,
      bridged_toolErrorName: bridged?.toolError?.name,
      bridged_contentPreview: (bridged?.structuredContent?.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
      bridged_replyStatus: bridged?.replyResult?.structuredContent?.status,
      bridged_replyErrorName: bridged?.replyResult?.structuredContent?.error?.name,
      bridged_replyError: bridged?.replyError?.message,
    });
  }

  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n\n${nowIso()} === SUMMARY ===`);
  console.log(JSON.stringify(summary, null, 2));

  await client.closeAndWait(15_000).catch(() => client.kill('SIGKILL'));
  await externalServer.stop();
  await fakeLlm.stop();
  repo.cleanup();
  console.log(`${nowIso()} probe complete. OUT_DIR=${OUT_DIR}`);
}

main().catch((err) => {
  console.error('PROBE FAILED', err);
  process.exitCode = 1;
});
