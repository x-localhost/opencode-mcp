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
//   * Request has no `tools`                  -> "title/summary" call: short text "Fake title".
//   * Last message is a tool result           -> final text "DONE: <tool output first 200 chars>".
//   * Last user text contains "WRITE_FILE"    -> tool call `write` {filePath:"hello.txt", content:"hello from fake llm\n"}.
//   * Last user text contains "CALL_TOOL <name> <json>" -> tool call <name> with <json> args (any tool).
//   * Last user text contains "RUN_BASH"      -> tool call `bash` {command:"echo fake-bash-ok", description:"echo"}.
//   * otherwise                               -> text "FAKE_REPLY: <echo of last user text (first 80 chars)>".

import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT || 18080)
const HOST = process.env.HOST || "127.0.0.1"
const LOG = process.env.LOG || ""
const DELAY_MS = Number(process.env.CHUNK_DELAY_MS || 5)
const requests = []
let seq = 0

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

  if (toolNames.length === 0) return { kind: "text", text: "Fake title" }
  if (last?.role === "tool") {
    return { kind: "text", text: `DONE: ${textOf(last.content).slice(0, 200)}` }
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
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
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
  if (p.kind === "text") {
    send(chunk({ role: "assistant", content: "" }))
    for (const piece of p.text.match(/.{1,8}/gs) ?? [""]) {
      await sleep(DELAY_MS)
      send(chunk({ content: piece }))
    }
    send(chunk({}, "stop"))
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
      await sleep(DELAY_MS)
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
    }
    send(chunk({}, "tool_calls"))
  }
  if (body.stream_options?.include_usage) {
    send({ id, object: "chat.completion.chunk", created, model, choices: [], usage })
  }
  res.write("data: [DONE]\n\n")
  res.end()
}

function jsonResponse(res, body, p) {
  const message =
    p.kind === "text"
      ? { role: "assistant", content: p.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call_fake_${seq}`, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args) } },
          ],
        }
  const out = {
    id: `chatcmpl-fake-${seq}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "fake-model",
    choices: [{ index: 0, message, finish_reason: p.kind === "text" ? "stop" : "tool_calls" }],
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

server.listen(PORT, HOST, () => console.log(`fake-llm listening on http://${HOST}:${PORT}`))
