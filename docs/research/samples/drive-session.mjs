// Drives one OpenCode session over the HTTP API (v1 routes) the way opencode-mcp would.
// Usage: BASE=http://127.0.0.1:4096 OUT=/work/out PROMPT="WRITE_FILE please" REPLY=once node drive-session.mjs
// Records: raw SSE (/event) text, permission request + reply, final messages, delete result.
import fs from "node:fs"

const BASE = process.env.BASE || "http://127.0.0.1:4096"
const OUT = process.env.OUT || "/work/out"
const PROMPT = process.env.PROMPT || "Say hi"
const REPLY = process.env.REPLY || "once" // once | always | reject
const DIRECTORY = process.env.DIRECTORY // optional ?directory=
const DELETE = process.env.DELETE !== "0"
const MODEL = { providerID: process.env.PROVIDER || "fake", modelID: process.env.MODEL || "fake-model" }
fs.mkdirSync(OUT, { recursive: true })
const q = DIRECTORY ? `?directory=${encodeURIComponent(DIRECTORY)}` : ""
const log = (...a) => console.log(new Date().toISOString(), ...a)

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "" : q}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

// 1. subscribe to SSE before doing anything
const sseRaw = fs.createWriteStream(`${OUT}/events.sse.txt`)
const events = []
const waiters = []
const ac = new AbortController()
const sseRes = await fetch(`${BASE}/event${q}`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
;(async () => {
  const dec = new TextDecoder()
  let buf = ""
  try {
    for await (const chunk of sseRes.body) {
      const s = dec.decode(chunk, { stream: true })
      sseRaw.write(s)
      buf += s
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
        if (!data) continue
        let ev
        try { ev = JSON.parse(data) } catch { continue }
        events.push(ev)
        for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev) }
      }
    }
  } catch {}
})()
const waitFor = (pred, ms = 60000) =>
  new Promise((resolve, reject) => {
    const hit = events.find(pred)
    if (hit) return resolve(hit)
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => reject(new Error("timeout waiting for event")), ms)
  })
await waitFor((e) => e.type === "server.connected", 10000).catch(() => log("no server.connected event"))

// 2. create session
const created = await call("POST", "/session", { title: `spike ${new Date().toISOString()}` })
fs.writeFileSync(`${OUT}/session-create.json`, JSON.stringify(created, null, 2))
const sid = created.json.id
log("session", created.status, sid)

// 3. prompt async
const t0 = Date.now()
const pa = await call("POST", `/session/${sid}/prompt_async`, { model: MODEL, parts: [{ type: "text", text: PROMPT }] })
log("prompt_async", pa.status, JSON.stringify(pa.json))
fs.writeFileSync(`${OUT}/prompt_async.json`, JSON.stringify(pa, null, 2))

// 4. loop: answer permission requests until the session goes idle
const idle = (e) =>
  (e.type === "session.idle" && e.properties?.sessionID === sid) ||
  (e.type === "session.status" && e.properties?.sessionID === sid && e.properties?.status?.type === "idle")
const permAsked = (e) => /^permission\.(asked|updated)$/.test(e.type) && (e.properties?.sessionID === sid)
let answered = new Set()
while (true) {
  const ev = await Promise.race([waitFor(idle, 120000), waitFor((e) => permAsked(e) && !answered.has(e.properties.id), 120000)])
  if (idle(ev)) { log("idle after", Date.now() - t0, "ms"); break }
  const reqID = ev.properties.id
  answered.add(reqID)
  fs.writeFileSync(`${OUT}/permission-event.json`, JSON.stringify(ev, null, 2))
  const pending = await call("GET", "/permission")
  fs.writeFileSync(`${OUT}/permission-list.json`, JSON.stringify(pending, null, 2))
  const r = await call("POST", `/permission/${reqID}/reply`, { reply: REPLY })
  fs.writeFileSync(`${OUT}/permission-reply.json`, JSON.stringify({ request: { reply: REPLY }, response: r }, null, 2))
  log("permission", ev.type, ev.properties.permission ?? ev.properties.type, "->", REPLY, r.status, JSON.stringify(r.json))
}

// 5. collect result
const msgs = await call("GET", `/session/${sid}/message`)
fs.writeFileSync(`${OUT}/messages.json`, JSON.stringify(msgs.json, null, 2))
const lastAssistant = [...msgs.json].reverse().find((m) => m.info.role === "assistant")
const finalText = lastAssistant?.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
log("final assistant text:", JSON.stringify(finalText), "finish:", lastAssistant?.info?.finish)
const status = await call("GET", "/session/status")
fs.writeFileSync(`${OUT}/session-status.json`, JSON.stringify(status, null, 2))

// 6. end session
if (DELETE) {
  const del = await call("DELETE", `/session/${sid}`)
  fs.writeFileSync(`${OUT}/session-delete.json`, JSON.stringify(del, null, 2))
  log("delete", del.status, JSON.stringify(del.json))
  await new Promise((r) => setTimeout(r, 300))
  const after = await call("GET", `/session/${sid}`)
  log("get after delete", after.status, JSON.stringify(after.json).slice(0, 200))
}
await new Promise((r) => setTimeout(r, 300))
ac.abort()
sseRaw.end()
fs.writeFileSync(`${OUT}/event-types.txt`, events.map((e) => e.type).join("\n") + "\n")
log("event types:", [...new Set(events.map((e) => e.type))].join(","))
process.exit(0)
