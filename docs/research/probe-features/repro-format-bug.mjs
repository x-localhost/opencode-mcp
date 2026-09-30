#!/usr/bin/env node
// Focused repro: after a prompt_async with `format` set, does GET /session/{id}/message really
// fail, and does GET /session/{id}/message/{messageID} or the SSE stream still work?
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const RUN = "/probe/run2"
const OUT = "/probe/out2"
const REPO = path.join(RUN, "repo")
const HOME = path.join(RUN, "home")
const BASE = "http://127.0.0.1:4097"
for (const d of [RUN, OUT, HOME]) fs.mkdirSync(d, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), ...a)
function saveJSON(rel, data) {
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

fs.mkdirSync(REPO, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: REPO })
fs.writeFileSync(path.join(REPO, "seed.txt"), "seed\n")
execFileSync("git", ["add", "."], { cwd: REPO })
execFileSync("git", ["-c", "user.email=p@example.com", "-c", "user.name=p", "commit", "-q", "-m", "init"], { cwd: REPO })

function spawnLogged(name, cmd, args, env, cwd) {
  const so = fs.createWriteStream(path.join(RUN, `${name}.stdout.log`))
  const se = fs.createWriteStream(path.join(RUN, `${name}.stderr.log`))
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", (d) => so.write(d))
  child.stderr.on("data", (d) => se.write(d))
  return child
}
function waitForLine(child, regex, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = ""
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
    const onData = (d) => {
      buf += d.toString("utf8")
      const m = buf.match(regex)
      if (m) {
        clearTimeout(timer)
        child.stdout.off("data", onData)
        resolve(m[0])
      }
    }
    child.stdout.on("data", onData)
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`exited early ${code}`))
    })
  })
}

async function call(method, p, body, extraQuery = {}) {
  const params = { directory: REPO, ...extraQuery }
  const qs = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
  const sep = p.includes("?") ? "&" : "?"
  const url = `${BASE}${p}${sep}${qs}`
  const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

const events = []
let sseAc
async function startSSE(directory) {
  sseAc = new AbortController()
  const res = await fetch(`${BASE}/event?directory=${encodeURIComponent(directory)}`, { signal: sseAc.signal, headers: { accept: "text/event-stream" } })
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ""
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
          if (!data) continue
          try { const ev = JSON.parse(data); ev._recvAt = Date.now(); events.push(ev) } catch {}
        }
      }
    } catch (err) { log("sse ended", String(err)) }
  })()
}

async function main() {
  const llm = spawnLogged("fake-llm", "node", ["/probe/fake-llm-server-ext.mjs"], { ...process.env, PORT: "0", HOST: "127.0.0.1", LOG: path.join(RUN, "llm.jsonl"), DUMP_DIR: (() => { const d = path.join(RUN, "dumps"); fs.mkdirSync(d, { recursive: true }); return d })() }, RUN)
  const line = await waitForLine(llm, /fake-llm listening on (http:\/\/\S+)/)
  const llmBase = /fake-llm listening on (http:\/\/\S+)/.exec(line)[1]
  log("llm at", llmBase)

  const config = {
    model: "fake/fake-model", small_model: "fake/fake-model", enabled_providers: ["fake"], autoupdate: false, share: "disabled",
    provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake LLM", options: { baseURL: `${llmBase}/v1`, apiKey: "fake-key" }, models: { "fake-model": { name: "Fake Model", tool_call: true, limit: { context: 128000, output: 4096 } } } } },
  }
  const oc = spawnLogged("opencode-serve", "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4097"], { ...process.env, HOME, XDG_DATA_HOME: path.join(HOME, ".local/share"), XDG_CONFIG_HOME: path.join(HOME, ".config"), XDG_STATE_HOME: path.join(HOME, ".local/state"), XDG_CACHE_HOME: path.join(HOME, ".cache"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }, REPO)
  await waitForLine(oc, /opencode server listening on/, 30000)
  log("opencode ready")
  await sleep(300)
  await startSSE(REPO)
  await sleep(300)

  const created = await call("POST", "/session", { title: "repro" })
  const sid = created.json.id
  log("session", sid)

  const SCHEMA = { type: "object", properties: { answer: { type: "string" }, count: { type: "number" } }, required: ["answer", "count"] }
  const pa = await call("POST", `/session/${sid}/prompt_async`, {
    model: { providerID: "fake", modelID: "fake-model" },
    parts: [{ type: "text", text: "Answer in plain text only. Do not call any tool." }],
    format: { type: "json_schema", schema: SCHEMA },
  })
  log("prompt_async", pa.status, JSON.stringify(pa.json))

  // poll for idle via SSE, else timeout
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid)) break
    await sleep(200)
  }
  await sleep(500)

  const msgList = await call("GET", `/session/${sid}/message`)
  log("GET message list ->", msgList.status)
  saveJSON("message-list.json", msgList)

  const msgListRaw = await fetch(`${BASE}/session/${sid}/message?directory=${encodeURIComponent(REPO)}`)
  saveJSON("message-list-raw-status.json", { status: msgListRaw.status, statusText: msgListRaw.statusText })

  // find messageIDs from SSE events instead
  const messageEvents = events.filter((e) => /message/i.test(e.type))
  saveJSON("message-related-events.json", messageEvents)
  const msgIds = [...new Set(messageEvents.map((e) => e.properties?.info?.id || e.properties?.messageID).filter(Boolean))]
  saveJSON("discovered-message-ids.json", msgIds)

  for (const id of msgIds) {
    const single = await call("GET", `/session/${sid}/message/${id}`)
    saveJSON(`message-single-${id}.json`, single)
    log("GET single message", id, "->", single.status)
  }

  const sessionGet = await call("GET", `/session/${sid}`)
  saveJSON("session-get.json", sessionGet)
  log("GET session ->", sessionGet.status)

  saveJSON("all-events.json", events)
  saveJSON("llm-requests.json", await (await fetch(`${llmBase}/__requests`)).json())

  sseAc.abort()
  await sleep(300)
  oc.kill("SIGTERM")
  llm.kill("SIGTERM")
  await sleep(300)
  process.exit(0)
}
main().catch((err) => { console.error("FATAL", err); process.exit(1) })
