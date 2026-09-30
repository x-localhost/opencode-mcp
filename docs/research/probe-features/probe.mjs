#!/usr/bin/env node
// Orchestrator for the opencode-ai@1.18.33 HTTP API probe-features research spike.
// Runs entirely inside the ocmcp-e2e:local container on gram, --network none.
// Drives a real `opencode serve` against the extended fake LLM (fake-llm-server-ext.mjs) and
// records raw evidence for each of the 7 questions under OUT.

import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const RUN = "/probe/run"
const OUT = "/probe/out"
const REPO = path.join(RUN, "repo")
const REPO2 = path.join(RUN, "repo2") // dedicated clean repo for the worktree question (Q5)
const HOME = path.join(RUN, "home")
const BASE = "http://127.0.0.1:4096"
const errors = []

for (const d of [RUN, OUT, HOME]) fs.mkdirSync(d, { recursive: true })

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function saveJSON(relPath, data) {
  const p = path.join(OUT, relPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}
function saveText(relPath, text) {
  const p = path.join(OUT, relPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact)
  if (obj && typeof obj === "object") {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = /key|secret|token|password|authorization|bearer/i.test(k) ? "<redacted>" : redact(v)
    }
    return out
  }
  return obj
}

function initGitRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: dir })
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  execFileSync("git", ["add", "."], { cwd: dir })
  execFileSync(
    "git",
    ["-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-q", "-m", "init"],
    { cwd: dir },
  )
}

// ---------- process management ----------
function spawnLogged(name, cmd, args, env, cwd) {
  const stdoutLog = fs.createWriteStream(path.join(RUN, `${name}.stdout.log`))
  const stderrLog = fs.createWriteStream(path.join(RUN, `${name}.stderr.log`))
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", (d) => stdoutLog.write(d))
  child.stderr.on("data", (d) => stderrLog.write(d))
  return child
}

function waitForLine(child, regex, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = ""
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${regex} on ${child.spawnfile}`)), timeoutMs)
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
      reject(new Error(`${child.spawnfile} exited early with code ${code}`))
    })
  })
}

let fakeLlm, ocServe
async function startFakeLlm() {
  fakeLlm = spawnLogged(
    "fake-llm",
    "node",
    ["/probe/fake-llm-server-ext.mjs"],
    {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      LOG: path.join(RUN, "fake-llm-requests.jsonl"),
      DUMP_DIR: (() => {
        const d = path.join(RUN, "llm-dumps")
        fs.mkdirSync(d, { recursive: true })
        return d
      })(),
    },
    RUN,
  )
  const line = await waitForLine(fakeLlm, /fake-llm listening on (http:\/\/\S+)/, 10000)
  const m = /fake-llm listening on (http:\/\/\S+)/.exec(line)
  return m[1]
}

async function startOpencodeServe(cwd, llmBaseUrl) {
  const config = {
    model: "fake/fake-model",
    small_model: "fake/fake-model",
    enabled_providers: ["fake"],
    autoupdate: false,
    share: "disabled",
    provider: {
      fake: {
        npm: "@ai-sdk/openai-compatible",
        name: "Fake LLM",
        options: { baseURL: `${llmBaseUrl}/v1`, apiKey: "fake-key" },
        models: { "fake-model": { name: "Fake Model", tool_call: true, limit: { context: 128000, output: 4096 } } },
      },
    },
  }
  saveJSON("00-setup/opencode-config.json", config)
  const child = spawnLogged(
    "opencode-serve",
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    {
      ...process.env,
      HOME,
      XDG_DATA_HOME: path.join(HOME, ".local/share"),
      XDG_CONFIG_HOME: path.join(HOME, ".config"),
      XDG_STATE_HOME: path.join(HOME, ".local/state"),
      XDG_CACHE_HOME: path.join(HOME, ".cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      NPM_CONFIG_FETCH_RETRIES: "0",
    },
    cwd,
  )
  await waitForLine(child, /opencode server listening on/, 30000)
  return child
}

// ---------- HTTP + SSE helpers ----------
async function call(method, path_, body, { directory = REPO, ...extraQuery } = {}) {
  const params = { directory, ...extraQuery }
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
  const sep = path_.includes("?") ? "&" : "?"
  const url = qs ? `${BASE}${path_}${sep}${qs}` : `${BASE}${path_}`
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

async function llmRequests() {
  const res = await fetch(`${fakeLlmBase}/__requests`)
  return res.json()
}

const events = []
let sseAc
async function startSSE(directory) {
  sseAc = new AbortController()
  const url = `${BASE}/event?directory=${encodeURIComponent(directory)}`
  const raw = fs.createWriteStream(path.join(RUN, "events.sse.raw.txt"))
  const res = await fetch(url, { signal: sseAc.signal, headers: { accept: "text/event-stream" } })
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ""
    try {
      for await (const chunk of res.body) {
        const s = dec.decode(chunk, { stream: true })
        raw.write(s)
        buf += s
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n")
          if (!data) continue
          let ev
          try {
            ev = JSON.parse(data)
          } catch {
            continue
          }
          ev._recvAt = Date.now()
          events.push(ev)
        }
      }
    } catch (err) {
      log("SSE stream ended:", String(err))
    }
  })()
}

function eventsBetween(t0, t1, pred = () => true) {
  return events.filter((e) => e._recvAt >= t0 && e._recvAt <= t1 && pred(e))
}

async function waitIdle(sessionId, { timeoutMs = 60000 } = {}) {
  // IMPORTANT: only look at events received AFTER this call started, so a stale idle event left
  // over from a *previous* turn on the same session (still sitting in the global `events` array)
  // can't cause this call to return immediately before the new turn has actually gone idle.
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const answered = new Set()
  while (Date.now() < deadline) {
    const idleEv = events.find(
      (e) =>
        e._recvAt >= startedAt &&
        ((e.type === "session.idle" && e.properties?.sessionID === sessionId) ||
          (e.type === "session.status" &&
            e.properties?.sessionID === sessionId &&
            e.properties?.status?.type === "idle")),
    )
    if (idleEv) return idleEv
    const permEv = events.find(
      (e) =>
        e._recvAt >= startedAt &&
        /^permission\.(asked|updated)$/.test(e.type) &&
        e.properties?.sessionID === sessionId &&
        !answered.has(e.properties?.id),
    )
    if (permEv) {
      answered.add(permEv.properties.id)
      await call("POST", `/permission/${permEv.properties.id}/reply`, { reply: "once" })
      continue
    }
    await sleep(150)
  }
  throw new Error(`timeout waiting for session ${sessionId} to go idle`)
}

// ---------- generic arg builders ----------
function sampleValue(schema) {
  if (!schema) return "ok"
  switch (schema.type) {
    case "string":
      return "ok"
    case "number":
    case "integer":
      return 1
    case "boolean":
      return true
    case "array":
      return []
    case "object":
      return {}
    default:
      return "ok"
  }
}
function fillFromSchema(schema) {
  if (!schema || schema.type !== "object") return {}
  const keys = schema.required ?? Object.keys(schema.properties ?? {})
  const out = {}
  for (const k of keys) out[k] = sampleValue(schema.properties?.[k])
  return out
}

// ---------- SUMMARY accumulator ----------
const SUMMARY = {}

let fakeLlmBase

async function main() {
  log("setting up repos...")
  initGitRepo(REPO, {
    "README.md": "# probe repo\n",
    "file0.txt": "seed content\n",
  })

  log("starting fake LLM (extended)...")
  fakeLlmBase = await startFakeLlm()
  log("fake LLM at", fakeLlmBase)

  log("starting opencode serve...")
  ocServe = await startOpencodeServe(REPO, fakeLlmBase)
  log("opencode serve ready")
  await sleep(300)

  await startSSE(REPO)
  await sleep(300)

  try {
    await q1StructuredOutput()
  } catch (err) {
    errors.push({ q: 1, error: String(err?.stack || err) })
    log("Q1 FAILED:", err)
  }
  try {
    await q2PerTurnDiff()
  } catch (err) {
    errors.push({ q: 2, error: String(err?.stack || err) })
    log("Q2 FAILED:", err)
  }
  try {
    await q3Todos()
  } catch (err) {
    errors.push({ q: 3, error: String(err?.stack || err) })
    log("Q3 FAILED:", err)
  }
  try {
    await q4Revert()
  } catch (err) {
    errors.push({ q: 4, error: String(err?.stack || err) })
    log("Q4 FAILED:", err)
  }
  try {
    await q5Worktree()
  } catch (err) {
    errors.push({ q: 5, error: String(err?.stack || err) })
    log("Q5 FAILED:", err)
  }
  try {
    await q6Fork()
  } catch (err) {
    errors.push({ q: 6, error: String(err?.stack || err) })
    log("Q6 FAILED:", err)
  }
  try {
    await q7Discovery()
  } catch (err) {
    errors.push({ q: 7, error: String(err?.stack || err) })
    log("Q7 FAILED:", err)
  }

  saveJSON("00-setup/errors.json", errors)
  saveJSON("00-setup/message-list-bug-log.json", messageListBugLog)
  saveJSON("00-setup/summary.json", SUMMARY)
  saveText("00-setup/all-event-types.txt", events.map((e) => `${e._recvAt} ${e.type}`).join("\n") + "\n")
  saveJSON("00-setup/llm-requests-full.json", await llmRequests())
  log("done. errors:", errors.length, "message-list-bug hits:", messageListBugLog.length)
}

// ================= Q1: structured output =================
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, count: { type: "number" } },
  required: ["answer", "count"],
}

async function createSession(title) {
  const r = await call("POST", "/session", { title })
  if (r.status >= 300) throw new Error(`create session failed: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id
}

async function promptAsync(sessionId, body) {
  const t0 = Date.now()
  const r = await call("POST", `/session/${sessionId}/prompt_async`, {
    model: { providerID: "fake", modelID: "fake-model" },
    ...body,
  })
  return { ...r, t0 }
}

// PROBE FINDING: once any message in a session has a stored `format` (json_schema) field,
// GET /session/{id}/message (list) — and GET /session/{id}/message/{userMessageID} for that same
// user message — starts returning HTTP 400 "Expected OutputFormatJsonSchema, got {...}"
// (an Effect-schema read-side validation bug in opencode-ai@1.18.33: the object round-trips fine
// on write but fails a stricter decoder on read). This is permanent for that session (the corrupt
// message stays in history). GET /session/{id}/message/{assistantMessageID} for the *assistant*
// message (which never stores `format` itself) still returns 200. `messagesOf()` below transparently
// falls back to reconstructing the message list from already-received SSE `message.updated` /
// `message.part.updated` events (which include the full `info`/`part` objects inline and are
// unaffected by the read-side bug) whenever the list call 400s, and logs every such fallback into
// messageListBugLog for the report.
const messageListBugLog = []

async function messagesOf(sessionId) {
  const r = await call("GET", `/session/${sessionId}/message`)
  if (r.status === 200 && Array.isArray(r.json)) return r.json
  messageListBugLog.push({ sessionId, status: r.status, body: r.json, fellBackTo: "sse-reconstruction" })
  return reconstructMessagesFromEvents(sessionId)
}

function reconstructMessagesFromEvents(sessionId) {
  const infoById = new Map()
  const partsByMsgId = new Map()
  for (const e of events) {
    if (e.type === "message.updated" && e.properties?.info?.sessionID === sessionId) {
      infoById.set(e.properties.info.id, e.properties.info) // last write wins -> final state
    }
    if (e.type === "message.part.updated" && e.properties?.part?.sessionID === sessionId) {
      const p = e.properties.part
      if (!partsByMsgId.has(p.messageID)) partsByMsgId.set(p.messageID, new Map())
      partsByMsgId.get(p.messageID).set(p.id, p)
    }
  }
  const ordered = [...infoById.values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  return ordered.map((info) => ({
    info,
    parts: [...(partsByMsgId.get(info.id)?.values() ?? [])].sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0)),
  }))
}

async function q1StructuredOutput() {
  const dir = "q1-structured-output"
  // --- baseline: no format, plain prompt -> discover the "normal" tool set for the build agent ---
  const before0 = (await llmRequests()).length
  const sBase = await createSession("q1 baseline (no format)")
  await promptAsync(sBase, { parts: [{ type: "text", text: "Say hi. No directives." }] })
  await waitIdle(sBase)
  const reqsBase = (await llmRequests()).slice(before0)
  saveJSON(`${dir}/baseline-requests.json`, reqsBase)
  saveJSON(`${dir}/baseline-messages.json`, await messagesOf(sBase))
  const baselineTools = reqsBase[0]?.tools ?? []

  // --- case C: format set, LLM answers with plain text, never calls the injected tool ---
  const beforeC = (await llmRequests()).length
  const sC = await createSession("q1 case C (format, plain text)")
  const tC0 = Date.now()
  await promptAsync(sC, {
    parts: [{ type: "text", text: "Answer in plain text only. Do not call any tool." }],
    format: { type: "json_schema", schema: SCHEMA },
  })
  await waitIdle(sC)
  const tC1 = Date.now()
  const reqsC = (await llmRequests()).slice(beforeC)
  saveJSON(`${dir}/caseC-requests.json`, reqsC)
  const msgsC = await messagesOf(sC)
  saveJSON(`${dir}/caseC-messages.json`, msgsC)
  saveJSON(`${dir}/caseC-events.json`, eventsBetween(tC0, tC1, (e) => e.properties?.sessionID === sC))
  // copy the relevant dump files (contain the exact tools[]/tool_choice/messages sent to the LLM)
  copyDumps(reqsC, `${dir}/caseC-dumps`)

  // Document the GET-message read-side bug precisely: single-message-by-ID for the user message
  // (which stores `format`) vs. the assistant message (which doesn't).
  {
    const cUser = lastUser(msgsC)
    const cAsst = lastAssistant(msgsC)
    const userSingle = cUser ? await call("GET", `/session/${sC}/message/${cUser.info.id}`) : undefined
    const asstSingle = cAsst ? await call("GET", `/session/${sC}/message/${cAsst.info.id}`) : undefined
    const listResp = await call("GET", `/session/${sC}/message`)
    saveJSON(`${dir}/caseC-get-message-bug-evidence.json`, {
      listStatus: listResp.status,
      listBody: listResp.json,
      userSingleStatus: userSingle?.status,
      userSingleBody: userSingle?.json,
      assistantSingleStatus: asstSingle?.status,
      assistantSingleBody: asstSingle?.json,
    })
  }

  const withFormatTools = reqsC[0]?.tools ?? []
  const extraToolNames = withFormatTools.filter((n) => !baselineTools.includes(n))
  saveJSON(`${dir}/discovery.json`, {
    baselineTools,
    withFormatTools,
    extraToolNames,
    tool_choice: reqsC[0]?.tool_choice,
    system_text_preview: reqsC[0]?.system_text_preview,
  })

  let structTool = extraToolNames[0]
  let structToolSchema
  if (structTool) {
    const dumpFile = dumpFileForSeq(reqsC[0]?.seq)
    if (dumpFile) {
      const body = JSON.parse(fs.readFileSync(dumpFile, "utf8"))
      const t = (body.tools ?? []).find((t) => t.function?.name === structTool)
      structToolSchema = t?.function?.parameters
    }
  }
  SUMMARY.q1 = { structTool, structToolSchema, extraToolNames, baselineTools, withFormatTools }
  saveJSON(`${dir}/struct-tool-schema.json`, { structTool, structToolSchema })

  if (!structTool) {
    log("Q1: could not discover an injected structured-output tool name; skipping cases A/B/persistence")
    return
  }

  const validArgs = fillFromSchema(structToolSchema) // e.g. {answer:"ok", count:1}
  const invalidArgs = { ...validArgs }
  const requiredKeys = structToolSchema?.required ?? Object.keys(structToolSchema?.properties ?? {})
  delete invalidArgs[requiredKeys[requiredKeys.length - 1]]

  const q1Errors = {}
  SUMMARY.q1.caseC = { finish: lastAssistant(msgsC)?.info?.finish, structured: lastAssistant(msgsC)?.info?.structured, error: lastAssistant(msgsC)?.info?.error, nLlmCalls: reqsC.length }

  // --- case A: valid tool call ---
  try {
    const beforeA = (await llmRequests()).length
    const sA = await createSession("q1 case A (valid tool call)")
    const tA0 = Date.now()
    await promptAsync(sA, {
      parts: [{ type: "text", text: `Call the tool. CALL_TOOL_STICKY ${structTool} ${JSON.stringify(validArgs)}` }],
      format: { type: "json_schema", schema: SCHEMA },
    })
    await waitIdle(sA)
    const tA1 = Date.now()
    const reqsA = (await llmRequests()).slice(beforeA)
    saveJSON(`${dir}/caseA-requests.json`, reqsA)
    const msgsA = await messagesOf(sA)
    saveJSON(`${dir}/caseA-messages.json`, msgsA)
    saveJSON(`${dir}/caseA-events.json`, eventsBetween(tA0, tA1, (e) => e.properties?.sessionID === sA))
    copyDumps(reqsA, `${dir}/caseA-dumps`)
    SUMMARY.q1.caseA = { finish: lastAssistant(msgsA)?.info?.finish, structured: lastAssistant(msgsA)?.info?.structured, error: lastAssistant(msgsA)?.info?.error, nLlmCalls: reqsA.length }
  } catch (err) {
    q1Errors.caseA = String(err?.stack || err)
    log("Q1 case A FAILED:", err)
  }

  // --- case B: invalid tool call (missing required field), kept sticky across retries ---
  try {
    const beforeB = (await llmRequests()).length
    const sB = await createSession("q1 case B (invalid tool call, default retryCount)")
    const tB0 = Date.now()
    await promptAsync(sB, {
      parts: [{ type: "text", text: `Call the tool. CALL_TOOL_STICKY ${structTool} ${JSON.stringify(invalidArgs)}` }],
      format: { type: "json_schema", schema: SCHEMA },
    })
    await waitIdle(sB, { timeoutMs: 90000 })
    const tB1 = Date.now()
    const reqsB = (await llmRequests()).slice(beforeB)
    saveJSON(`${dir}/caseB-requests.json`, reqsB)
    const msgsB = await messagesOf(sB)
    saveJSON(`${dir}/caseB-messages.json`, msgsB)
    saveJSON(`${dir}/caseB-events.json`, eventsBetween(tB0, tB1, (e) => e.properties?.sessionID === sB))
    copyDumps(reqsB, `${dir}/caseB-dumps`)
    SUMMARY.q1.caseB = { finish: lastAssistant(msgsB)?.info?.finish, structured: lastAssistant(msgsB)?.info?.structured, error: lastAssistant(msgsB)?.info?.error, nLlmCalls: reqsB.length }
  } catch (err) {
    q1Errors.caseB = String(err?.stack || err)
    log("Q1 case B FAILED:", err)
  }

  // --- case B2: invalid tool call, explicit retryCount:1 (compare call count vs default) ---
  try {
    const beforeB2 = (await llmRequests()).length
    const sB2 = await createSession("q1 case B2 (invalid tool call, retryCount=1)")
    const tB2_0 = Date.now()
    await promptAsync(sB2, {
      parts: [{ type: "text", text: `Call the tool. CALL_TOOL_STICKY ${structTool} ${JSON.stringify(invalidArgs)}` }],
      format: { type: "json_schema", schema: SCHEMA, retryCount: 1 },
    })
    await waitIdle(sB2, { timeoutMs: 90000 })
    const tB2_1 = Date.now()
    const reqsB2 = (await llmRequests()).slice(beforeB2)
    saveJSON(`${dir}/caseB2-requests.json`, reqsB2)
    saveJSON(`${dir}/caseB2-messages.json`, await messagesOf(sB2))
    saveJSON(`${dir}/caseB2-events.json`, eventsBetween(tB2_0, tB2_1, (e) => e.properties?.sessionID === sB2))
    SUMMARY.q1.caseB2 = { nLlmCalls: reqsB2.length }
  } catch (err) {
    q1Errors.caseB2 = String(err?.stack || err)
    log("Q1 case B2 FAILED:", err)
  }

  // --- persistence: does `format` survive to the next prompt in the same session without it? ---
  try {
    const sP = await createSession("q1 persistence")
    await promptAsync(sP, {
      parts: [{ type: "text", text: `Call the tool. CALL_TOOL_STICKY ${structTool} ${JSON.stringify(validArgs)}` }],
      format: { type: "json_schema", schema: SCHEMA },
    })
    await waitIdle(sP)
    const beforeP2 = (await llmRequests()).length
    await promptAsync(sP, { parts: [{ type: "text", text: "Second turn, no format this time, plain reply please." }] })
    await waitIdle(sP)
    const reqsP2 = (await llmRequests()).slice(beforeP2)
    saveJSON(`${dir}/persistence-turn2-requests.json`, reqsP2)
    copyDumps(reqsP2, `${dir}/persistence-turn2-dumps`)
    saveJSON(`${dir}/persistence-summary.json`, {
      turn2_tools: reqsP2[0]?.tools,
      turn2_tool_choice: reqsP2[0]?.tool_choice,
      structToolStillPresent: (reqsP2[0]?.tools ?? []).includes(structTool),
    })
  } catch (err) {
    q1Errors.persistence = String(err?.stack || err)
    log("Q1 persistence FAILED:", err)
  }

  if (Object.keys(q1Errors).length) SUMMARY.q1.errors = q1Errors
}

function lastAssistant(msgs) {
  return [...msgs].reverse().find((m) => m.info?.role === "assistant")
}
function lastUser(msgs) {
  return [...msgs].reverse().find((m) => m.info?.role === "user")
}
function dumpFileForSeq(seq) {
  if (seq === undefined) return undefined
  const f = path.join(RUN, "llm-dumps", `req-${seq}.json`)
  return fs.existsSync(f) ? f : undefined
}
function copyDumps(reqs, relDir) {
  for (const r of reqs) {
    const f = dumpFileForSeq(r.seq)
    if (!f) continue
    const destDir = path.join(OUT, relDir)
    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(f, path.join(destDir, path.basename(f)))
  }
}

// ================= Q2: per-turn diff =================
async function q2PerTurnDiff() {
  const dir = "q2-per-turn-diff"
  const sD = await createSession("q2 diff")

  await promptAsync(sD, { parts: [{ type: "text", text: 'CALL_TOOL write {"filePath":"a.txt","content":"turn1 content\\n"}' }] })
  const t1_0 = Date.now()
  await waitIdle(sD)
  const t1_1 = Date.now()
  const msgs1 = await messagesOf(sD)
  const user1 = lastUser(msgs1)
  const asst1 = lastAssistant(msgs1)
  saveJSON(`${dir}/turn1-messages.json`, msgs1)
  const session1 = await call("GET", `/session/${sD}`)
  saveJSON(`${dir}/turn1-session.json`, session1.json)
  saveJSON(`${dir}/turn1-events.json`, eventsBetween(t1_0, t1_1, (e) => e.properties?.sessionID === sD))

  await promptAsync(sD, { parts: [{ type: "text", text: 'CALL_TOOL write {"filePath":"b.txt","content":"turn2 content\\n"}' }] })
  const t2_0 = Date.now()
  await waitIdle(sD)
  const t2_1 = Date.now()
  const msgs2 = await messagesOf(sD)
  const newAfterTurn2 = msgs2.slice(msgs1.length)
  const user2 = newAfterTurn2.find((m) => m.info?.role === "user") ?? lastUser(msgs2)
  saveJSON(`${dir}/turn2-messages.json`, msgs2)
  const session2 = await call("GET", `/session/${sD}`)
  saveJSON(`${dir}/turn2-session.json`, session2.json)
  saveJSON(`${dir}/turn2-events.json`, eventsBetween(t2_0, t2_1, (e) => e.properties?.sessionID === sD))

  const diffNoID = await call("GET", `/session/${sD}/diff`)
  const diffUser1 = await call("GET", `/session/${sD}/diff`, undefined, { messageID: user1.info.id })
  const diffAsst1 = await call("GET", `/session/${sD}/diff`, undefined, { messageID: asst1.info.id })
  const diffUser2 = await call("GET", `/session/${sD}/diff`, undefined, { messageID: user2.info.id })
  saveJSON(`${dir}/diff-noID.json`, diffNoID)
  saveJSON(`${dir}/diff-user1.json`, diffUser1)
  saveJSON(`${dir}/diff-assistant1.json`, diffAsst1)
  saveJSON(`${dir}/diff-user2.json`, diffUser2)

  // turn 3: bash-created file
  await promptAsync(sD, { parts: [{ type: "text", text: 'CALL_TOOL bash {"command":"echo x > viabash.txt","description":"w"}' }] })
  const t3_0 = Date.now()
  await waitIdle(sD)
  const t3_1 = Date.now()
  const msgs3 = await messagesOf(sD)
  const newAfterTurn3 = msgs3.slice(msgs2.length)
  const user3 = newAfterTurn3.find((m) => m.info?.role === "user") ?? lastUser(msgs3)
  saveJSON(`${dir}/turn3-messages.json`, msgs3)
  saveJSON(`${dir}/turn3-events.json`, eventsBetween(t3_0, t3_1, (e) => e.properties?.sessionID === sD))

  const diffNoID_afterBash = await call("GET", `/session/${sD}/diff`)
  const diffUser3 = await call("GET", `/session/${sD}/diff`, undefined, { messageID: user3.info.id })
  const diffUser2_afterBash = await call("GET", `/session/${sD}/diff`, undefined, { messageID: user2.info.id })
  saveJSON(`${dir}/diff-noID-after-bash.json`, diffNoID_afterBash)
  saveJSON(`${dir}/diff-user3-bash.json`, diffUser3)
  saveJSON(`${dir}/diff-user2-after-bash.json`, diffUser2_afterBash)

  const ls = execFileSync("ls", ["-la", REPO]).toString()
  saveText(`${dir}/repo-ls.txt`, ls)

  SUMMARY.q2 = {
    user1: user1.info.id,
    assistant1: asst1.info.id,
    user2: user2.info.id,
    user3: user3.info.id,
    diffNoID_files: diffNoID.json?.map((d) => d.file),
    diffUser1_files: diffUser1.json?.map((d) => d.file),
    diffAssistant1_files: diffAsst1.json?.map((d) => d.file),
    diffUser2_files: diffUser2.json?.map((d) => d.file),
    diffUser3_bash_files: diffUser3.json?.map((d) => d.file),
  }
  SUMMARY._q2SessionId = sD
  SUMMARY._q2User2Id = user2.info.id
}

// ================= Q3: todos =================
async function q3Todos() {
  const dir = "q3-todos"
  // Find todowrite's exact schema from Q1's baseline discovery dump (default build agent, no format).
  const baselineReqs = JSON.parse(fs.readFileSync(path.join(OUT, "q1-structured-output/baseline-requests.json"), "utf8"))
  const baselineDumpFile = dumpFileForSeq(baselineReqs[0]?.seq)
  let todoToolName, todoToolSchema
  if (baselineDumpFile) {
    const body = JSON.parse(fs.readFileSync(baselineDumpFile, "utf8"))
    saveJSON(`${dir}/build-agent-full-tools.json`, body.tools?.map((t) => t.function?.name))
    const t = (body.tools ?? []).find((t) => /todo.?write/i.test(t.function?.name ?? ""))
    todoToolName = t?.function?.name
    todoToolSchema = t?.function?.parameters
  }
  saveJSON(`${dir}/todowrite-schema.json`, { todoToolName, todoToolSchema })
  SUMMARY.q3 = { todoToolName, todoToolSchema, availableToBuildAgentByDefault: Boolean(todoToolName) }

  if (!todoToolName) {
    log("Q3: todowrite tool not found in build agent's tool list; skipping call")
    return
  }

  const arrKey = Object.entries(todoToolSchema?.properties ?? {}).find(([, v]) => v.type === "array")?.[0] ?? "todos"
  const todos = [
    { content: "Task 1", status: "pending", priority: "high" },
    { content: "Task 2", status: "in_progress", priority: "medium" },
    { content: "Task 3", status: "completed", priority: "low" },
  ]
  const args = { [arrKey]: todos }

  const before = (await llmRequests()).length
  const sT = await createSession("q3 todos")
  const t0 = Date.now()
  await promptAsync(sT, { parts: [{ type: "text", text: `CALL_TOOL ${todoToolName} ${JSON.stringify(args)}` }] })
  await waitIdle(sT)
  const t1 = Date.now()
  const reqs = (await llmRequests()).slice(before)
  saveJSON(`${dir}/requests.json`, reqs)
  copyDumps(reqs, `${dir}/dumps`)
  saveJSON(`${dir}/messages.json`, await messagesOf(sT))
  const sessionEvents = eventsBetween(t0, t1, (e) => e.properties?.sessionID === sT)
  saveJSON(`${dir}/events.json`, sessionEvents)
  const todoUpdatedEvents = sessionEvents.filter((e) => e.type === "todo.updated")
  saveJSON(`${dir}/todo-updated-events.json`, todoUpdatedEvents)
  const permEvents = sessionEvents.filter((e) => /^permission\./.test(e.type))
  saveJSON(`${dir}/permission-events.json`, permEvents)

  const todoList = await call("GET", `/session/${sT}/todo`)
  saveJSON(`${dir}/todo-get.json`, todoList)

  SUMMARY.q3.args = args
  SUMMARY.q3.todoUpdatedEventCount = todoUpdatedEvents.length
  SUMMARY.q3.permissionEventCount = permEvents.length
  SUMMARY.q3.finalTodoList = todoList.json
}

// ================= Q4: revert =================
async function q4Revert() {
  const dir = "q4-revert"
  const sR = await createSession("q4 revert")

  await promptAsync(sR, { parts: [{ type: "text", text: 'CALL_TOOL write {"filePath":"r1.txt","content":"revert turn1\\n"}' }] })
  await waitIdle(sR)
  const msgs1 = await messagesOf(sR)
  const user1 = lastUser(msgs1)
  const r1ExistsAfterTurn1 = fs.existsSync(path.join(REPO, "r1.txt"))

  await promptAsync(sR, { parts: [{ type: "text", text: 'CALL_TOOL write {"filePath":"r2.txt","content":"revert turn2\\n"}' }] })
  await waitIdle(sR)
  const msgs2 = await messagesOf(sR)
  const user2 = msgs2.slice(msgs1.length).find((m) => m.info?.role === "user") ?? lastUser(msgs2)
  const r2ExistsAfterTurn2 = fs.existsSync(path.join(REPO, "r2.txt"))

  // Modify things OUTSIDE opencode between turn 2 and revert.
  fs.writeFileSync(path.join(REPO, "outside.txt"), "manual file created after turn2, outside opencode\n")
  fs.writeFileSync(path.join(REPO, "r2.txt"), "manually edited after turn2, before revert\n")

  const beforeRevertState = {
    r1: fs.existsSync(path.join(REPO, "r1.txt")) ? fs.readFileSync(path.join(REPO, "r1.txt"), "utf8") : null,
    r2: fs.existsSync(path.join(REPO, "r2.txt")) ? fs.readFileSync(path.join(REPO, "r2.txt"), "utf8") : null,
    outside: fs.existsSync(path.join(REPO, "outside.txt")) ? fs.readFileSync(path.join(REPO, "outside.txt"), "utf8") : null,
  }
  saveJSON(`${dir}/before-revert-fs-state.json`, beforeRevertState)

  const revertResp = await call("POST", `/session/${sR}/revert`, { messageID: user2.info.id })
  saveJSON(`${dir}/revert-response.json`, revertResp)

  const afterRevertState = {
    r1: fs.existsSync(path.join(REPO, "r1.txt")) ? fs.readFileSync(path.join(REPO, "r1.txt"), "utf8") : null,
    r2: fs.existsSync(path.join(REPO, "r2.txt")) ? fs.readFileSync(path.join(REPO, "r2.txt"), "utf8") : null,
    outside: fs.existsSync(path.join(REPO, "outside.txt")) ? fs.readFileSync(path.join(REPO, "outside.txt"), "utf8") : null,
  }
  saveJSON(`${dir}/after-revert-fs-state.json`, afterRevertState)

  const sessionAfterRevert = await call("GET", `/session/${sR}`)
  saveJSON(`${dir}/session-after-revert.json`, sessionAfterRevert)
  const msgsAfterRevert = await messagesOf(sR)
  saveJSON(`${dir}/messages-after-revert.json`, msgsAfterRevert)

  // Send a new prompt after revert; see if the reverted (turn2) messages get dropped.
  await promptAsync(sR, { parts: [{ type: "text", text: "post-revert message, no directives" }] })
  await waitIdle(sR)
  const msgsAfterNewPrompt = await messagesOf(sR)
  saveJSON(`${dir}/messages-after-post-revert-prompt.json`, msgsAfterNewPrompt)
  const fsAfterNewPrompt = {
    r1: fs.existsSync(path.join(REPO, "r1.txt")),
    r2: fs.existsSync(path.join(REPO, "r2.txt")),
    outside: fs.existsSync(path.join(REPO, "outside.txt")),
  }
  saveJSON(`${dir}/fs-after-post-revert-prompt.json`, fsAfterNewPrompt)

  const unrevertResp = await call("POST", `/session/${sR}/unrevert`)
  saveJSON(`${dir}/unrevert-response.json`, unrevertResp)
  const sessionAfterUnrevert = await call("GET", `/session/${sR}`)
  saveJSON(`${dir}/session-after-unrevert.json`, sessionAfterUnrevert)
  const msgsAfterUnrevert = await messagesOf(sR)
  saveJSON(`${dir}/messages-after-unrevert.json`, msgsAfterUnrevert)
  const fsAfterUnrevert = {
    r1: fs.existsSync(path.join(REPO, "r1.txt")),
    r2: fs.existsSync(path.join(REPO, "r2.txt")),
    r2content: fs.existsSync(path.join(REPO, "r2.txt")) ? fs.readFileSync(path.join(REPO, "r2.txt"), "utf8") : null,
    outside: fs.existsSync(path.join(REPO, "outside.txt")),
  }
  saveJSON(`${dir}/fs-after-unrevert.json`, fsAfterUnrevert)

  SUMMARY.q4 = {
    user2MessageID: user2.info.id,
    r1ExistsAfterTurn1,
    r2ExistsAfterTurn2,
    beforeRevertState,
    afterRevertState,
    revertField: sessionAfterRevert.json?.revert,
    messagesCountBeforeRevert: msgs2.length,
    messagesCountAfterRevert: msgsAfterRevert.length,
    messagesCountAfterNewPrompt: msgsAfterNewPrompt.length,
    fsAfterNewPrompt,
    fsAfterUnrevert,
    unrevertStatus: unrevertResp.status,
    revertFieldAfterUnrevert: sessionAfterUnrevert.json?.revert,
  }
}

// ================= Q5: worktree =================
async function q5Worktree() {
  const dir = "q5-worktree"
  initGitRepo(REPO2, { "README.md": "# repo2\n", "seed.txt": "seed\n" })

  const createResp = await call("POST", "/experimental/worktree", { name: "probe-wt" }, { directory: REPO2 })
  saveJSON(`${dir}/create-response.json`, createResp)

  const parentLs = execFileSync("ls", ["-la", path.dirname(REPO2)]).toString()
  saveText(`${dir}/parent-dir-ls.txt`, parentLs)
  const worktreeListGit = execFileSync("git", ["-C", REPO2, "worktree", "list"]).toString()
  saveText(`${dir}/git-worktree-list.txt`, worktreeListGit)
  const branchList = execFileSync("git", ["-C", REPO2, "branch", "--list"]).toString()
  saveText(`${dir}/git-branch-list-after-create.txt`, branchList)

  const listResp = await call("GET", "/experimental/worktree", undefined, { directory: REPO2 })
  saveJSON(`${dir}/list-response.json`, listResp)

  const wtDir = createResp.json?.directory
  SUMMARY.q5 = { createResp: createResp.json, listResp: listResp.json }

  if (wtDir && fs.existsSync(wtDir)) {
    // Can a session be created against the worktree directory, and does it work normally?
    const sW = await createSession2(wtDir, "q5 session in worktree")
    const t0 = Date.now()
    const pr = await callPrompt(sW, wtDir, { parts: [{ type: "text", text: "hello from the worktree session" }] })
    await waitIdleGeneric(sW, wtDir)
    const t1 = Date.now()
    const msgsW = await call("GET", `/session/${sW}/message`, undefined, { directory: wtDir })
    saveJSON(`${dir}/worktree-session-messages.json`, msgsW)
    SUMMARY.q5.worktreeSessionWorked = Boolean(lastAssistant(msgsW.json ?? [])?.parts?.some((p) => p.type === "text"))
  }

  if (wtDir) {
    const delResp = await call("DELETE", "/experimental/worktree", { directory: wtDir }, { directory: REPO2 })
    saveJSON(`${dir}/delete-response.json`, delResp)
    const branchListAfterDelete = execFileSync("git", ["-C", REPO2, "branch", "--list"]).toString()
    saveText(`${dir}/git-branch-list-after-delete.txt`, branchListAfterDelete)
    const dirExistsAfterDelete = fs.existsSync(wtDir)
    SUMMARY.q5.delResp = delResp.json
    SUMMARY.q5.branchListAfterDelete = branchListAfterDelete
    SUMMARY.q5.dirExistsAfterDelete = dirExistsAfterDelete
  }

  // uncommitted-changes case
  fs.appendFileSync(path.join(REPO2, "seed.txt"), "uncommitted extra line\n")
  const createResp2 = await call("POST", "/experimental/worktree", { name: "probe-wt-2" }, { directory: REPO2 })
  saveJSON(`${dir}/create-with-uncommitted-response.json`, createResp2)
  SUMMARY.q5.createWithUncommitted = createResp2.json
  const wtDir2 = createResp2.json?.directory
  if (wtDir2 && fs.existsSync(wtDir2)) {
    const seedInWt2 = fs.existsSync(path.join(wtDir2, "seed.txt")) ? fs.readFileSync(path.join(wtDir2, "seed.txt"), "utf8") : null
    saveText(`${dir}/wt2-seed-content.txt`, seedInWt2 ?? "<missing>")
    SUMMARY.q5.seedContentInWt2 = seedInWt2
    await call("DELETE", "/experimental/worktree", { directory: wtDir2 }, { directory: REPO2 })
  }
}

async function createSession2(directory, title) {
  const r = await call("POST", "/session", { title }, { directory })
  if (r.status >= 300) throw new Error(`create session (directory=${directory}) failed: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id
}
async function callPrompt(sessionId, directory, body) {
  return call("POST", `/session/${sessionId}/prompt_async`, { model: { providerID: "fake", modelID: "fake-model" }, ...body }, { directory })
}
async function waitIdleGeneric(sessionId, directory, { timeoutMs = 60000 } = {}) {
  // Same polling strategy as waitIdle(), but events are on the single global SSE stream keyed only
  // by directory=REPO; a worktree session's events may not appear on that stream, so poll GET
  // /session/{id} 'time.updated'-style status via message list instead (simplest robust proxy: poll
  // until the last assistant message has a `time.completed`).
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await call("GET", `/session/${sessionId}/message`, undefined, { directory })
    const asst = lastAssistant(r.json ?? [])
    if (asst?.info?.time?.completed) return
    await sleep(300)
  }
  throw new Error(`timeout waiting for worktree session ${sessionId} to complete`)
}

// ================= Q6: fork =================
async function q6Fork() {
  const dir = "q6-fork"
  const sD = SUMMARY._q2SessionId
  const user2Id = SUMMARY._q2User2Id
  if (!sD || !user2Id) throw new Error("Q6 depends on Q2 having run successfully")

  const origSession = await call("GET", `/session/${sD}`)
  saveJSON(`${dir}/original-session.json`, origSession)
  const origMsgs = await messagesOf(sD)
  saveJSON(`${dir}/original-messages.json`, origMsgs)

  const forkResp = await call("POST", `/session/${sD}/fork`, { messageID: user2Id })
  saveJSON(`${dir}/fork-response.json`, forkResp)
  const forkedId = forkResp.json?.id
  SUMMARY.q6 = { forkResp: forkResp.json }

  if (forkedId) {
    const forkedMsgs = await messagesOf(forkedId)
    saveJSON(`${dir}/forked-messages.json`, forkedMsgs)
    const forkedSession = await call("GET", `/session/${forkedId}`)
    saveJSON(`${dir}/forked-session.json`, forkedSession)
    const ls = execFileSync("ls", ["-la", REPO]).toString()
    saveText(`${dir}/repo-ls.txt`, ls)

    SUMMARY.q6.parentID = forkResp.json?.parentID
    SUMMARY.q6.origDirectory = origSession.json?.directory
    SUMMARY.q6.forkedDirectory = forkedSession.json?.directory
    SUMMARY.q6.sameDirectory = origSession.json?.directory === forkedSession.json?.directory
    SUMMARY.q6.origMessageCount = origMsgs.length
    SUMMARY.q6.forkedMessageCount = forkedMsgs.length
    SUMMARY.q6.forkedMessageIds = forkedMsgs.map((m) => m.info?.id)
    SUMMARY.q6.includesUser2 = forkedMsgs.some((m) => m.info?.id === user2Id)
  }
}

// ================= Q7: discovery =================
async function q7Discovery() {
  const dir = "q7-discovery"
  const providers = await call("GET", "/config/providers")
  const provider = await call("GET", "/provider")
  const agent = await call("GET", "/agent")
  saveJSON(`${dir}/config-providers.json`, redact(providers.json))
  saveJSON(`${dir}/provider.json`, redact(provider.json))
  saveJSON(`${dir}/agent.json`, redact(agent.json))
  SUMMARY.q7 = {
    configProvidersStatus: providers.status,
    providerStatus: provider.status,
    agentStatus: agent.status,
    agentNames: (agent.json ?? []).map((a) => ({ name: a.name, mode: a.mode, native: a.native, hidden: a.hidden })),
    providerIds: (provider.json?.all ?? []).map((p) => p.id),
    connected: provider.json?.connected,
  }
}

// ---------- run + cleanup ----------
process.on("unhandledRejection", (err) => log("unhandledRejection:", err))

main()
  .catch((err) => {
    log("FATAL:", err)
    errors.push({ q: "fatal", error: String(err?.stack || err) })
    saveJSON("00-setup/errors.json", errors)
  })
  .finally(async () => {
    try {
      sseAc?.abort()
    } catch {}
    await sleep(300)
    for (const child of [ocServe, fakeLlm]) {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM")
    }
    await sleep(500)
    process.exit(0)
  })
