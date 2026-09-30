#!/usr/bin/env node
// Fake OpenAI-compatible chat-completions server for hermetic OpenCode e2e tests.
// No dependencies. Node >= 18.
//
//   PORT=18080 LOG=/tmp/fake-llm.jsonl node fake-llm-server.mjs
//
// Endpoints:
//   GET  /v1/models              -> one model ("fake-model")
//   POST /v1/chat/completions    -> stream:true (SSE) or non-stream JSON
//   GET  /__requests             -> recorded request summaries (for test assertions)
//   POST /__reset                -> clear recorded requests
//
// Scripted behaviour (decided from the request body, so it is stateless):
//   * Any message contains "FAIL500"          -> HTTP 500 with a JSON error body (no completion).
//   * Any message contains "FAIL400"          -> HTTP 400 with a JSON error body (no completion).
//   * Request has no `tools`                  -> "title/summary" call: short text "Fake title".
//   * Last message is a tool result           -> final text "DONE: <tool output first 200 chars>".
//   * OVERLOAD_* directives (last user message only, and only when tools are present): scripted
//     HTTP/SSE overload shapes; title/summary calls without tools always keep the "Fake title" reply.
//   * OVERLOAD_429_ONCE[_<nonce>] -> HTTP 429 with Retry-After: 2 once per nonce, then recovery text.
//   * OVERLOAD_429_ALWAYS -> HTTP 429 with Retry-After: 2 on every request.
//   * OVERLOAD_503_ONCE[_<nonce>] -> HTTP 503 once per nonce, then recovery text.
//   * OVERLOAD_529_ALWAYS -> HTTP 529 on every request.
//   * OVERLOAD_EMPTY_DONE -> HTTP 200 SSE with only the [DONE] terminator.
//   * OVERLOAD_EMPTY_STOP -> HTTP 200 SSE with empty assistant content and finish_reason "stop".
//   * OVERLOAD_WHITESPACE -> HTTP 200 SSE with whitespace-only content and finish_reason "stop".
//   * OVERLOAD_STREAM_CUT -> partial HTTP 200 SSE, then the socket is destroyed without completion.
//   * OVERLOAD_MALFORMED_SSE -> invalid JSON SSE event, then a continuing normal text stream.
//   * OVERLOAD_HTML_BODY -> HTTP 200 with a plain HTML gateway error body.
//   * OVERLOAD_BAD_TOOL_JSON -> bash tool-call stream with truncated invalid arguments.
//   * OVERLOAD_SLOW_FIRST_TOKEN [<seconds>] -> wait before sending the first SSE event (default 40 seconds).
//   * OVERLOAD_FINISH_LENGTH -> partial text SSE response ending with finish_reason "length".
//   * OVERLOAD_EMPTY_THEN_OK <n> <tag> / OVERLOAD_BADTOOL_THEN_OK <n> <tag> -> first n tagged requests
//     return empty-done / bad-tool JSON; later requests recover with a normal text reply.
//   * TOOL_STEPS <n> -> issue n sequential bash tool calls, then reply "TOOL_STEPS_DONE <n>".
//   * Last user text contains "WRITE_FILE"    -> tool call `write` {filePath:"hello.txt", content:"hello from fake llm\n"}.
//   * Last user text contains "CALL_TOOL <name> <json>" -> tool call <name> with <json> args (any tool).
//   * Last user text contains "RUN_BASH"      -> tool call `bash` {command:"echo fake-bash-ok", description:"echo"}.
//   * Last user text contains "SLOW_REPLY <seconds>" -> streams one text chunk per second for that
//     many seconds, then finishes with finish_reason "stop". Useful for exercising cancel/timeout/
//     wait-seconds/progress against a turn that is still "running" upstream. The stream stops
//     early (no error) if the client/OpenCode aborts the HTTP request.
//   * Last user text contains "LONG_REPLY <chars>" -> text reply of exactly <chars> UTF-16 code
//     units, deterministically built by e2e/lib/long-text.mjs (CJK + emoji, including two
//     surrogate-pair anchors at fixed offsets) — for e2e/features.test.mjs's output-paging scenario.
//   * Last user text contains "STRUCTURED_VALID <json>" -> text reply containing prose plus exactly
//     one fenced ```json block whose body is <json> verbatim — for the bridge-side structured-output
//     scenario (output-schema is never sent to us as OpenAI `response_format`/tools; the bridge
//     extracts this fenced block itself from the plain text reply).
//   * Last user text contains "STRUCTURED_AMBIGUOUS" -> text reply containing TWO ```json blocks.
//   * Last user text contains "STRUCTURED_BADJSON"   -> text reply containing one (properly closed)
//     ```json block whose body is not valid JSON.
//   * otherwise                               -> text "FAKE_REPLY: <echo of last user text (first 80 chars)>".

import http from "node:http"
import fs from "node:fs"
import { buildLongText } from "./lib/long-text.mjs"

const PORT = Number(process.env.PORT || 18080)
const HOST = process.env.HOST || "127.0.0.1"
const LOG = process.env.LOG || ""
const DELAY_MS = Number(process.env.CHUNK_DELAY_MS || 5)
const SLOW_CHUNK_MS = Number(process.env.SLOW_CHUNK_MS || 1000)
const requests = []
let seq = 0
const onceCounters = Object.create(null)
const tagCounters = new Map()

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

  // Scoped to the last user turn only (like every other directive below), not the whole
  // conversation history: OpenCode resends the full message history on every turn, so matching
  // against the whole history here made FAIL500/FAIL400 "sticky" forever once sent once —
  // a follow-up opencode-reply in the *same* session (asserting the session was not left
  // quarantined; e2e/scenarios.test.mjs's FAIL400 scenario) kept re-triggering the same forced
  // error even though its own new prompt text never asked for one.
  if (/\bFAIL500\b/.test(userText)) return { kind: "fail", status: 500 }
  if (/\bFAIL400\b/.test(userText)) return { kind: "fail", status: 400 }

  if (toolNames.length === 0) return { kind: "text", text: "Fake title" }
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
  for (const [directive, kind] of [
    ["OVERLOAD_EMPTY_DONE", "overload-empty-done"],
    ["OVERLOAD_EMPTY_STOP", "overload-empty-stop"],
    ["OVERLOAD_WHITESPACE", "overload-whitespace"],
    ["OVERLOAD_STREAM_CUT", "overload-stream-cut"],
    ["OVERLOAD_MALFORMED_SSE", "overload-malformed-sse"],
    ["OVERLOAD_HTML_BODY", "overload-html-body"],
    ["OVERLOAD_FINISH_LENGTH", "overload-finish-length"],
  ]) {
    if (new RegExp(`\\b${directive}\\b`).test(userText)) return { kind }
  }
  const badToolJson = /\bOVERLOAD_BAD_TOOL_JSON\b/.test(userText)
  if (badToolJson) {
    const name = toolNames.find((n) => n === "bash") ?? toolNames[0] ?? "bash"
    return { kind: "overload-bad-tool-json", name }
  }
  const slowFirst = userText.match(/OVERLOAD_SLOW_FIRST_TOKEN(?:\s+(\d+))?/)
  if (slowFirst) return { kind: "overload-slow-first-token", seconds: Number(slowFirst[1] || 40) }
  const emptyThenOk = userText.match(/\bOVERLOAD_EMPTY_THEN_OK\s+(\d+)\s+(\S+)/)
  if (emptyThenOk) {
    const [, count, tag] = emptyThenOk
    const seen = (tagCounters.get(tag) || 0) + 1
    tagCounters.set(tag, seen)
    return seen <= Number(count)
      ? { kind: "overload-empty-done" }
      : { kind: "text", text: `OVERLOAD_RECOVERED: EMPTY_THEN_OK ${count}` }
  }
  const badToolThenOk = userText.match(/\bOVERLOAD_BADTOOL_THEN_OK\s+(\d+)\s+(\S+)/)
  if (badToolThenOk) {
    const [, count, tag] = badToolThenOk
    const seen = (tagCounters.get(tag) || 0) + 1
    tagCounters.set(tag, seen)
    if (seen <= Number(count)) {
      const name = toolNames.find((n) => n === "bash") ?? toolNames[0] ?? "bash"
      return { kind: "overload-bad-tool-json", name }
    }
    return { kind: "text", text: `OVERLOAD_RECOVERED: BADTOOL_THEN_OK ${count}` }
  }
  const toolSteps = userText.match(/\bTOOL_STEPS\s+(\d+)/)
  if (toolSteps) {
    const userIndex = msgs.lastIndexOf(lastUser)
    const count = msgs.slice(userIndex + 1).filter((m) => m.role === "tool").length
    const total = Number(toolSteps[1])
    if (count < total) {
      const name = toolNames.find((n) => n === "bash") ?? toolNames.find((n) => /bash|shell/i.test(n)) ?? "bash"
      return { kind: "tool", name, args: { command: `echo step-${count + 1}`, description: "step" } }
    }
    return { kind: "text", text: `TOOL_STEPS_DONE ${total}` }
  }
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
  // Generic directive: "CALL_TOOL <toolName> <json-args>" (json must be the rest of the line).
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
    // Full role+text projection of every message (not just roles), so tests can assert WHERE a
    // given piece of text (e.g. a bridge-injected system instruction) did or did not appear,
    // without needing OPENCODE_MCP's own internals — e.g. e2e/features.test.mjs's structured-
    // output scenario, which checks the output-schema instruction is present in this turn's
    // request and absent from a later reply's request (never inherited; the bridge never sends
    // OpenCode's own `format`, so nothing here depends on it).
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
  // Tracks whether the peer (OpenCode / the abort test) closed the connection early, e.g. via
  // POST /session/{id}/abort, so a SLOW_REPLY stream can stop cleanly instead of throwing on write.
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
    res.destroy()
    return
  }
  if (p.kind === "overload-malformed-sse") {
    send(chunk({ role: "assistant", content: "" }))
    await sleep(DELAY_MS)
    sendRaw("data: {this is not json,,, }}}\n\n")
    await sleep(DELAY_MS)
    send(chunk({ content: "recovered after malformed chunk" }))
    send(chunk({}, "stop"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-bad-tool-json") {
    const callId = `call_fake_${seq}`
    send(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.name, arguments: "" } }] }))
    for (const piece of ['{"command":"echo ', '\\"unterminated string, no closing brace']) {
      await sleep(DELAY_MS)
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
    }
    send(chunk({}, "tool_calls"))
    if (!aborted) { res.write("data: [DONE]\n\n"); res.end() }
    return
  }
  if (p.kind === "overload-slow-first-token") {
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
    // Non-streamed callers still get the full duration (no way to emit partial progress without
    // SSE); mainly here so the endpoint never silently misbehaves if stream:true is ever omitted.
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
      for (const key of Object.keys(onceCounters)) delete onceCounters[key]
      tagCounters.clear()
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
        return res.end(JSON.stringify({ error: { message: messageByStatus[p.status] || "overloaded", type: p.status === 429 ? "rate_limit_error" : "overloaded_error", code: p.status === 429 ? "rate_limit_exceeded" : "overloaded" } }))
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
