#!/usr/bin/env node
// EXTENDED copy of opencode-mcp's e2e/fake-llm-server.mjs for the probe-features research spike.
// Base behaviour is unchanged; additions are marked "PROBE ADDITION". Never edits the repo file;
// this is a standalone copy kept for reproducibility.
//
// PROBE ADDITIONS:
//   * record() now also captures body.tool_choice and the system-message text (redacted-safe;
//     this is the fake config, no real secrets) so /__requests alone shows enough to answer
//     "is a special tool injected / is tool_choice forced / any system text added" without
//     opening every DUMP_DIR file.
//   * New directive `CALL_TOOL_STICKY <name> <json>` — like CALL_TOOL but matched BEFORE the
//     "last message is a tool result -> DONE" short-circuit, and matched on EVERY subsequent
//     request that still contains the directive text (which stays in the conversation because
//     the original user message is still part of history). This lets a single scripted prompt
//     drive a multi-round retry loop (e.g. repeatedly returning invalid structured-output tool
//     arguments) so we can observe OpenCode's retry behaviour instead of the loop terminating
//     after one round.

import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT || 18080)
const HOST = process.env.HOST || "127.0.0.1"
const LOG = process.env.LOG || ""
const DELAY_MS = Number(process.env.CHUNK_DELAY_MS || 5)
const SLOW_CHUNK_MS = Number(process.env.SLOW_CHUNK_MS || 1000)
const requests = []
let seq = 0
// PROBE ADDITION: bounds CALL_TOOL_STICKY so a runaway retry loop in the real server can never
// hang this probe forever; once a given (name,args) sticky directive has fired this many times in
// the same conversation it starts replying with plain "STICKY_EXHAUSTED" text instead. Seeing that
// text in a final message is itself evidence the server retried at least this many times.
const STICKY_MAX = Number(process.env.STICKY_MAX || 6)
const stickyCounts = new Map()

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
  const allText = msgs.map((m) => textOf(m.content)).join(" ")

  if (/\bFAIL500\b/.test(allText)) return { kind: "fail", status: 500 }
  if (/\bFAIL400\b/.test(allText)) return { kind: "fail", status: 400 }

  if (toolNames.length === 0) return { kind: "text", text: "Fake title" }

  // PROBE ADDITION: sticky directive, checked before the tool-result short-circuit so it keeps
  // firing across an entire retry loop (the directive text stays in `userText` because it lives
  // in the original user message, which stays in `messages` history across all follow-up calls).
  const sticky = userText.match(/CALL_TOOL_STICKY\s+(\S+)\s+(\{.*\})/)
  if (sticky) {
    const key = `${sticky[1]}::${sticky[2]}`
    const count = (stickyCounts.get(key) ?? 0) + 1
    stickyCounts.set(key, count)
    if (count <= STICKY_MAX) {
      let args = {}
      try { args = JSON.parse(sticky[2]) } catch {}
      return { kind: "tool", name: sticky[1], args, stickyCall: count }
    }
    return { kind: "text", text: `STICKY_EXHAUSTED after ${count - 1} tool calls` }
  }

  if (last?.role === "tool") {
    return { kind: "text", text: `DONE: ${textOf(last.content).slice(0, 200)}` }
  }
  const slow = userText.match(/SLOW_REPLY\s+(\d+)/)
  if (slow) {
    return { kind: "slow", seconds: Number(slow[1]) }
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
  const systemMsg = body?.messages?.find((m) => m.role === "system")
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
    // PROBE ADDITION:
    tool_choice: body?.tool_choice,
    system_text_preview: systemMsg ? textOf(systemMsg.content).slice(0, 4000) : undefined,
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
