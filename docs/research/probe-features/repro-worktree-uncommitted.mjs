#!/usr/bin/env node
// Focused repro: does POST /experimental/worktree succeed when the repo has uncommitted changes,
// and if so, does the new worktree directory actually appear on disk (with what content)?
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const RUN = "/probe/run3"
const OUT = "/probe/out3"
const REPO = path.join(RUN, "repo")
const HOME = path.join(RUN, "home")
const BASE = "http://127.0.0.1:4098"
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
      if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolve(m[0]) }
    }
    child.stdout.on("data", onData)
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited early ${code}`)) })
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

async function main() {
  const llm = spawnLogged("fake-llm", "node", ["/probe/fake-llm-server-ext.mjs"], { ...process.env, PORT: "0", HOST: "127.0.0.1" }, RUN)
  const line = await waitForLine(llm, /fake-llm listening on (http:\/\/\S+)/)
  const llmBase = /fake-llm listening on (http:\/\/\S+)/.exec(line)[1]
  const config = { model: "fake/fake-model", small_model: "fake/fake-model", enabled_providers: ["fake"], autoupdate: false, share: "disabled", provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake LLM", options: { baseURL: `${llmBase}/v1`, apiKey: "fake-key" }, models: { "fake-model": { name: "Fake Model", tool_call: true, limit: { context: 128000, output: 4096 } } } } } }
  const oc = spawnLogged("opencode-serve", "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4098"], { ...process.env, HOME, XDG_DATA_HOME: path.join(HOME, ".local/share"), XDG_CONFIG_HOME: path.join(HOME, ".config"), XDG_STATE_HOME: path.join(HOME, ".local/state"), XDG_CACHE_HOME: path.join(HOME, ".cache"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }, REPO)
  await waitForLine(oc, /opencode server listening on/, 30000)
  log("ready")
  await sleep(300)

  // baseline: clean create
  const r1 = await call("POST", "/experimental/worktree", { name: "clean-wt" })
  log("clean create ->", r1.status, JSON.stringify(r1.json))
  saveJSON("clean-create.json", r1)
  await sleep(300)
  const dir1 = r1.json?.directory
  saveJSON("clean-dir-exists-immediately", { exists: dir1 ? fs.existsSync(dir1) : null })
  if (dir1) {
    for (let i = 0; i < 10 && !fs.existsSync(dir1); i++) await sleep(200)
    const exists = fs.existsSync(dir1)
    const seed = exists && fs.existsSync(path.join(dir1, "seed.txt")) ? fs.readFileSync(path.join(dir1, "seed.txt"), "utf8") : null
    log("clean dir exists (after poll):", exists, "seed:", JSON.stringify(seed))
    saveJSON("clean-dir-state.json", { dir: dir1, exists, seed, lsParent: (() => { try { return execFileSync("ls", ["-la", path.dirname(dir1)]).toString() } catch (e) { return String(e) } })() })
  }

  // now make an uncommitted change and create a second worktree
  fs.appendFileSync(path.join(REPO, "seed.txt"), "uncommitted extra line\n")
  fs.writeFileSync(path.join(REPO, "untracked.txt"), "untracked new file\n")
  const gitStatus = execFileSync("git", ["-C", REPO, "status", "--porcelain"]).toString()
  saveJSON("git-status-before-dirty-create.json", { gitStatus })
  const r2 = await call("POST", "/experimental/worktree", { name: "dirty-wt" })
  log("dirty create ->", r2.status, JSON.stringify(r2.json))
  saveJSON("dirty-create.json", r2)
  const dir2 = r2.json?.directory
  if (dir2) {
    for (let i = 0; i < 15 && !fs.existsSync(dir2); i++) await sleep(200)
    const exists = fs.existsSync(dir2)
    const seed = exists && fs.existsSync(path.join(dir2, "seed.txt")) ? fs.readFileSync(path.join(dir2, "seed.txt"), "utf8") : null
    const untracked = exists && fs.existsSync(path.join(dir2, "untracked.txt")) ? fs.readFileSync(path.join(dir2, "untracked.txt"), "utf8") : null
    const ls = exists ? execFileSync("ls", ["-la", dir2]).toString() : null
    log("dirty dir exists (after poll):", exists, "seed:", JSON.stringify(seed), "untracked:", JSON.stringify(untracked))
    saveJSON("dirty-dir-state.json", { dir: dir2, exists, seed, untracked, ls })
  } else {
    saveJSON("dirty-dir-state.json", { note: "no directory in response", resp: r2.json })
  }

  const listResp = await call("GET", "/experimental/worktree")
  saveJSON("list-final.json", listResp)
  const worktreeListGit = execFileSync("git", ["-C", REPO, "worktree", "list"]).toString()
  saveJSON("git-worktree-list-final.json", { worktreeListGit })

  oc.kill("SIGTERM"); llm.kill("SIGTERM")
  await sleep(300)
  process.exit(0)
}
main().catch((err) => { console.error("FATAL", err); process.exit(1) })
