#!/usr/bin/env node
// Research copy of e2e/fake-llm-server.mjs, extended with "overload" directives for a research
// spike (probe-overload). It is mounted into the ocmcp-probe-overload:local e2e image at runtime.
// Never edit the real e2e/fake-llm-server.mjs to add these directives.
//
// New behaviour: matching one of the OVERLOAD_* markers in the last user message's text switches
// the response to a scripted "gateway overload" shape instead of the normal text/tool reply. Every
// other marker (FAIL500, FAIL400, WRITE_FILE, CALL_TOOL, RUN_BASH, SLOW_REPLY, LONG_REPLY,
// STRUCTURED_*) still works exactly as in the original, unmodified, so directive scenarios can be
// combined with the harness's other helpers unmodified.
//
// OVERLOAD_* markers (all scoped to the *last user message* only, matching the original file's own
// FAIL500/FAIL400 scoping rationale — never "sticky" across a whole conversation history):
//
//   OVERLOAD_429_ONCE       -> HTTP 429, Retry-After: 2, OpenAI-style error body, ONCE per
//                              directive (module-level counter), then a normal text reply.
//   OVERLOAD_429_ALWAYS     -> HTTP 429, Retry-After: 2, always.
//   OVERLOAD_503_ONCE       -> HTTP 503, {"error":{"message":"overloaded"}}, ONCE then normal reply.
//   OVERLOAD_529_ALWAYS     -> HTTP 529, {"error":{"message":"overloaded"}}, always.
//   OVERLOAD_EMPTY_DONE     -> HTTP 200 SSE stream that sends ONLY "data: [DONE]\n\n" (no content
//                              chunk at all, no finish_reason chunk).
//   OVERLOAD_EMPTY_STOP     -> HTTP 200 SSE: one role chunk, one chunk with content:"" , then a
//                              finish_reason:"stop" chunk, then [DONE].
//   OVERLOAD_WHITESPACE     -> HTTP 200 SSE: content deltas that are whitespace only ("   \n\t  "),
//                              finish_reason:"stop".
//   OVERLOAD_STREAM_CUT     -> HTTP 200 SSE: role chunk + a few content chunks, then the socket is
//                              destroyed (no finish_reason chunk, no [DONE]).
//   OVERLOAD_MALFORMED_SSE  -> HTTP 200 SSE: a normal role chunk, then ONE raw `data: {not json`
//                              line (invalid JSON), then normal content chunks, finish_reason:
//                              "stop", [DONE] -- i.e. the stream *continues* after the bad chunk.
//   OVERLOAD_HTML_BODY      -> HTTP 200, content-type text/html, a plain HTML error page body (not
//                              SSE at all, no "data:" framing).
//   OVERLOAD_BAD_TOOL_JSON  -> HTTP 200 SSE: a tool_calls stream (tool "bash") whose accumulated
//                              `arguments` string is truncated/invalid JSON.
//   OVERLOAD_SLOW_FIRST_TOKEN <seconds> -> HTTP 200 SSE: sleeps <seconds> (default 40) BEFORE
//                              sending anything (not even the role chunk), then sends a normal
//                              short text reply.
//   OVERLOAD_FINISH_LENGTH  -> HTTP 200 SSE: partial text, then finish_reason:"length" (not "stop"),
//                              simulating a token-limit cutoff.
//
// All streaming directives close the request normally (200) except 429/503/529 (non-2xx, JSON
// error body, never SSE). Every directive is logged exactly like the original file's `record()`.

import http from "node:http"
import fs from "node:fs"
import { buildLongText } from "/work/e2e/lib/long-text.mjs"

const PORT = Number(process.env.PORT || 18080)
const HOST = process.env.HOST || "127.0.0.1"
const LOG = process.env.LOG || ""
const DELAY_MS = Number(process.env.CHUNK_DELAY_MS || 5)
const SLOW_CHUNK_MS = Number(process.env.SLOW_CHUNK_MS || 1000)
const requests = []
let seq = 0

// "once then success" counters, keyed by directive name: one per-directive counter in the fake.
// Persists for the whole process lifetime (one fake-LLM instance per scenario in the harness, so
// this is naturally reset per scenario).
const onceCounters = Object.create(null)
function firstCall(name) {
  onceCounters[name] = (onceCounters[name] || 0) + 1
  return onceCounters[name] === 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("")
  return ""
}

function plan(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const toolNames = tools.map((t) => t?.function?.name).filter(Boolean)
  const last = msgs[msgs.length - 1]
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")
  const userText = textOf(lastUser?.content)

  if (/\bFAIL500\b/.test(userText)) return { kind: "fail", status: 500 }
  if (/\bFAIL400\b/.test(userText)) return { kind: "fail", status: 400 }

  // --- OVERLOAD_* directives (probe-overload spike only) ---
  // ONCE variants accept an optional trailing nonce (OVERLOAD_429_ONCE_<nonce>) so two independent
  // drives (e.g. a raw-HTTP probe and a separate opencode-mcp-bridged probe of the very same
  // directive) each get their own fresh "fail once then succeed" cycle instead of sharing one
  // process-lifetime counter and racing each other's first call.
  const once429 = userText.match(/\bOVERLOAD_429_ONCE(?:_(\S+))?\b/)
  if (once429) {
    if (firstCall(`429_ONCE:${once429[1] || ""}`)) return { kind: "overload-error", status: 429, retryAfter: 2 }
    return { kind: "text", text: "OVERLOAD_RECOVERED: 429_ONCE" }
  }
  if (/\bOVERLOAD_429_ALWAYS\b/.test(userText)) return { kind: "overload-error", status: 429, retryAfter: 2 }
  const once503 = userText.match(/\bOVERLOAD_503_ONCE(?:_(\S+))?\b/)
  if (once503) {
    if (firstCall(`503_ONCE:${once503[1] || ""}`)) return { kind: "overload-error", status: 503 }
    return { kind: "text", text: "OVERLOAD_RECOVERED: 503_ONCE" }
  }
  if (/\bOVERLOAD_529_ALWAYS\b/.test(userText)) return { kind: "overload-error", status: 529 }
  if (/\bOVERLOAD_EMPTY_DONE\b/.test(userText)) return { kind: "overload-empty-done" }
  if (/\bOVERLOAD_EMPTY_STOP\b/.test(userText)) return { kind: "overload-empty-stop" }
  if (/\bOVERLOAD_WHITESPACE\b/.test(userText)) return { kind: "overload-whitespace" }
  if (/\bOVERLOAD_STREAM_CUT\b/.test(userText)) return { kind: "overload-stream-cut" }
  if (/\bOVERLOAD_MALFORMED_SSE\b/.test(userText)) return { kind: "overload-malformed-sse" }
  if (/\bOVERLOAD_HTML_BODY\b/.test(userText)) return { kind: "overload-html-body" }
  if (/\bOVERLOAD_BAD_TOOL_JSON\b/.test(userText)) {
    const name = toolNames.find((n) => n === "bash") ?? toolNames[0] ?? "bash"
    return { kind: "overload-bad-tool-json", name }
  }
  const slowFirst = userText.match(/OVERLOAD_SLOW_FIRST_TOKEN(?:\s+(\d+))?/)
  if (slowFirst) return { kind: "overload-slow-first-token", seconds: Number(slowFirst[1] || 40) }
  if (/\bOVERLOAD_FINISH_LENGTH\b/.test(userText)) return { kind: "overload-finish-length" }
  // --- end OVERLOAD_* directives ---

  if (toolNames.length === 0) return { kind: "text", text: "Fake title" }
  if (last?.role === "tool") {
    return { kind: "text", text: `DONE: ${textOf(last.content).slice(0, 200)}` }
  }
  const slow = userText.match(/SLOW_REPLY\s+(\d+)/)
  if (slow) {
    return { kind: "slow", seconds: Number(slow[1]) }
  }
  const long = userText.match(/LONG_REPLY\s+(\d+)/)
  if (long) {
    return { kind: "text", text: buildLongText(Number(long[1])) }
  }
  if (userText.includes("STRUCTURED_AMBIGUOUS")) {
    return {
      kind: "text",
      text:
        "Here is the result, in two blocks by mistake:\n\n" +
        '```json\n{"answer":"first","confidence":0.1}\n```\n\n' +
        "and also:\n\n" +
        '```json\n{"answer":"second","confidence":0.2}\n```\n',
    }
  }
  if (userText.includes("STRUCTURED_BADJSON")) {
    return {
      kind: "text",
      text: "Here is the (broken) result:\n\n```json\n{\"answer\": \"42\", \"confidence\":}\n```\n",
    }
  }
  const structured = userText.match(/STRUCTURED_VALID\s+(\{.*\})/)
  if (structured) {
    return {
      kind: "text",
      text: `Here is the structured result.\n\n\`\`\`json\n${structured[1]}\n\`\`\`\n\nDone.`,
    }
  }
  if (userText.includes("WRITE_FILE")) {
    const name = toolNames.find((n) => n === "write") ?? toolNames.find((n) => /write/i.test(n)) ?? "write"
    return {
      kind: "tool",
      name,
      args: { filePath: "hello.txt", content: "hello from fake llm\n" },
    }
  }
  const generic = userText.match(/CALL_TOOL\s+(\S+)\s+(\{.*\})/)
  if (generic) {
    let args = {}
    try { args = JSON.parse(generic[2]) } catch {}
    return { kind: "tool", name: generic[1], args }
  }
  if (userText.includes("RUN_BASH")) {
    const name = toolNames.find((n) => n === "bash") ?? toolNames.find((n) => /bash|shell/i.test(n)) ?? "bash"
    return { kind: "tool", name, args: { command: "echo fake-bash-ok", description: "echo" } }
  }
  return { kind: "text", text: `FAKE_REPLY: ${userText.replace(/\s+/g, " ").slice(0, 80)}` }
}

function record(req, body, p) {
  const entry = {
    seq: ++seq,
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, /authorization|api-key/i.test(k) ? "<redacted>" : v]),
    ),
    model: body?.model,
    stream: body?.stream,
    stream_options: body?.stream_options,
    n_messages: body?.messages?.length,
    roles: body?.messages?.map((m) => m.role),
    messages: body?.messages?.map((m) => ({ role: m.role, text: textOf(m.content) })),
    tools: body?.tools?.map((t) => t?.function?.name),
    plan: p,
  }
  requests.push(entry)
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + "\n")
}

const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }

async function streamResponse(res, body, p) {
  const id = `chatcmpl-fake-${seq}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model || "fake-model"
  let aborted = false
  res.once("close", () => { aborted = true })
  const send = (obj) => {
    if (aborted || res.writableEnded) return false
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
      return true
    } catch {
      aborted = true
      return false
    }
  }
  const sendRaw = (line) => {
    if (aborted || res.writableEnded) return false
    try {
      res.write(line)
      return true
    } catch {
      aborted = true
      return false
    }
  }
  const chunk = (delta, finish_reason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  })
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  if (p.kind === "overload-empty-done") {
    // No content chunk, no finish_reason chunk -- only the terminator.
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-empty-stop") {
    send(chunk({ role: "assistant", content: "" }))
    await sleep(DELAY_MS)
    send(chunk({ content: "" }))
    await sleep(DELAY_MS)
    send(chunk({}, "stop"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-whitespace") {
    send(chunk({ role: "assistant", content: "" }))
    for (const piece of ["   ", "\n\t", "  "]) {
      await sleep(DELAY_MS)
      send(chunk({ content: piece }))
    }
    send(chunk({}, "stop"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-stream-cut") {
    send(chunk({ role: "assistant", content: "" }))
    await sleep(DELAY_MS)
    send(chunk({ content: "partial before the socket dies" }))
    await sleep(DELAY_MS)
    // Destroy the socket directly (no finish_reason chunk, no [DONE], not even a clean res.end()).
    res.destroy()
    return
  }
  if (p.kind === "overload-malformed-sse") {
    send(chunk({ role: "assistant", content: "" }))
    await sleep(DELAY_MS)
    // One raw, deliberately-invalid `data:` line (not valid JSON) -- then the stream continues.
    sendRaw("data: {this is not json,,, }}}\n\n")
    await sleep(DELAY_MS)
    send(chunk({ content: "recovered after malformed chunk" }))
    send(chunk({}, "stop"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-bad-tool-json") {
    const callId = `call_fake_${seq}`
    send(
      chunk({
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.name, arguments: "" } }],
      }),
    )
    // Deliberately truncated/invalid JSON arguments (missing closing brace/quote).
    const badArgsPieces = ['{"command":"echo ', '\\"unterminated string, no closing brace']
    for (const piece of badArgsPieces) {
      await sleep(DELAY_MS)
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
    }
    send(chunk({}, "tool_calls"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-slow-first-token") {
    // Sleep BEFORE sending anything at all -- not even the role chunk -- then a normal short reply.
    await sleep(p.seconds * 1000)
    if (aborted) return
    send(chunk({ role: "assistant", content: "" }))
    for (const piece of "OVERLOAD_SLOW_FIRST_TOKEN_DONE".match(/.{1,8}/g) ?? []) {
      if (aborted) break
      await sleep(DELAY_MS)
      send(chunk({ content: piece }))
    }
    send(chunk({}, "stop"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-finish-length") {
    send(chunk({ role: "assistant", content: "" }))
    for (const piece of "This answer got cut off by the token lim".match(/.{1,8}/g) ?? []) {
      if (aborted) break
      await sleep(DELAY_MS)
      send(chunk({ content: piece }))
    }
    // finish_reason "length", not "stop" -- a real token-limit cutoff, not a normal completion.
    send(chunk({}, "length"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }

  if (p.kind === "slow") {
    send(chunk({ role: "assistant", content: "" }))
    for (let i = 1; i <= p.seconds && !aborted; i++) {
      await sleep(SLOW_CHUNK_MS)
      send(chunk({ content: `slow-chunk-${i} ` }))
    }
    if (!aborted) send(chunk({ content: "SLOW_DONE" }, null))
    if (!aborted) send(chunk({}, "stop"))
  } else if (p.kind === "text") {
    send(chunk({ role: "assistant", content: "" }))
    for (const piece of p.text.match(/.{1,8}/gs) ?? [""]) {
      if (aborted) break
      await sleep(DELAY_MS)
      send(chunk({ content: piece }))
    }
    if (!aborted) send(chunk({}, "stop"))
  } else {
    const callId = `call_fake_${seq}`
    send(
      chunk({
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.name, arguments: "" } }],
      }),
    )
    const args = JSON.stringify(p.args)
    for (const piece of args.match(/.{1,16}/gs)) {
      if (aborted) break
      await sleep(DELAY_MS)
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
    }
    if (!aborted) send(chunk({}, "tool_calls"))
  }
  if (!aborted && body.stream_options?.include_usage) {
    send({ id, object: "chat.completion.chunk", created, model, choices: [], usage })
  }
  if (!aborted) {
    res.write("data: [DONE]\n\n")
    res.end()
  }
}

async function jsonResponse(res, body, p) {
  if (p.kind === "slow") {
    await sleep(p.seconds * SLOW_CHUNK_MS)
  }
  const message =
    p.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call_fake_${seq}`, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args) } },
          ],
        }
      : { role: "assistant", content: p.kind === "slow" ? "SLOW_DONE" : p.text }
  const out = {
    id: `chatcmpl-fake-${seq}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "fake-model",
    choices: [{ index: 0, message, finish_reason: p.kind === "tool" ? "tool_calls" : "stop" }],
    usage,
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(out))
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString("utf8")
    const path = (req.url || "").split("?")[0]

    if (req.method === "GET" && path === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(requests, null, 2))
    }
    if (req.method === "POST" && path === "/__reset") {
      requests.length = 0
      res.writeHead(204)
      return res.end()
    }
    if (req.method === "GET" && /\/models$/.test(path)) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] }))
    }
    if (req.method === "POST" && /\/chat\/completions$/.test(path)) {
      const body = raw ? JSON.parse(raw) : {}
      const p = plan(body)
      record(req, body, p)
      if (process.env.DUMP_DIR) fs.writeFileSync(`${process.env.DUMP_DIR}/req-${seq}.json`, JSON.stringify(body, null, 2))

      if (p.kind === "fail") {
        res.writeHead(p.status, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: `fake-llm: forced ${p.status}`, type: "fake_error" } }))
      }
      if (p.kind === "overload-error") {
        const headers = { "content-type": "application/json" }
        if (p.retryAfter !== undefined) headers["retry-after"] = String(p.retryAfter)
        res.writeHead(p.status, headers)
        const messageByStatus = { 429: "Too Many Requests", 503: "Service Unavailable", 529: "overloaded" }
        return res.end(JSON.stringify({
          error: {
            message: messageByStatus[p.status] || "overloaded",
            type: p.status === 429 ? "rate_limit_error" : "overloaded_error",
            code: p.status === 429 ? "rate_limit_exceeded" : "overloaded",
          },
        }))
      }
      if (p.kind === "overload-html-body") {
        res.writeHead(200, { "content-type": "text/html" })
        return res.end("<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1><p>The gateway is overloaded.</p></body></html>")
      }
      return body.stream ? streamResponse(res, body, p) : jsonResponse(res, body, p)
    }
    record(req, null, { kind: "unhandled" })
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `fake-llm: no route for ${req.method} ${path}` } }))
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: String(err) } }))
  }
})

server.listen(PORT, HOST, () => console.log(`fake-llm listening on http://${HOST}:${server.address().port}`))
