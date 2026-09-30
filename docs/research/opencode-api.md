# OpenCode headless server API: ground truth from a real install

- **Version tested:** `opencode-ai@1.18.33`, the npm `latest` tag, published 2026-09-28T04:23Z. I also used `@opencode-ai/sdk@1.18.33`.
- **Source repo:** `github.com/anomalyco/opencode`. The binary's own strings point there; the npm metadata has no `repository` field.
- **Where it ran:** gram in docker (`node:22`, x86_64). There were two containers:
  - `ocmcp-research-api` had internet. For opencode, egress went first through a logging proxy and then through a deny-all proxy.
  - `ocmcp-research-api-airgap` used `--network none` to simulate the air-gapped setup.
- **Cleanup:** I removed both containers and all temp files afterwards.
- **LLM:** no real LLM key was configured. For end-to-end turns I used a local mock OpenAI-compatible server (not retained) as a custom provider, which stands in for the "internal LLM gateway".
- **Evidence labels** used in this report:
  - [V-run] observed in an actual run.
  - [V-spec] read from the server's own OpenAPI document (`GET /doc`).
  - [V-code] read from shipped code (the SDK dist, the postinstall script, or strings in the binary).
  - [INF] inference.

Artifacts (produced during the research; only the ones below are committed):
- **Committed:** `docs/research/opencode-openapi-1.18.33.json`: raw OpenAPI 3.1 from `GET /doc` (478,968 bytes; 162 paths; 472 schemas).
- **Committed:** `docs/research/samples/opencode-sample-prompt-sync-text-response.json`: a real `POST /session/{id}/message` response.
- **Not retained:** the real `/event` SSE stream covering prompt, tool, permission, question, abort, retry and delete; the mock OpenAI-compatible LLM script and its config (keywords `TOOLCALL`, `QUESTION`, `SLOW`, `FAIL500`, `FAIL400` and `FAIL401` triggered the matching behaviours); the OpenAPI pretty-printer script.

---

## 0. What this means for opencode-mcp (recommendations)

1. **Use the v1 API only.** That means `/session`, `/session/{id}/message`, `/session/{id}/prompt_async`, `/event`, `/permission` and `/question`. Do not use `/api/*` (v2).
   - In 1.18.33, v2 `POST /api/session/{id}/wait` returns `503 "Session wait is not available yet"` [V-run].
   - The v2 prompt path ignores the config's `provider`, `disabled_providers`, `enabled_providers` and `model` settings. It always picked the built-in `opencode/longcat-2.5-preview-free` (OpenCode Zen, `https://opencode.ai/zen`) [V-run, twice]. That is a data-egress risk.
2. **Map Codex's tools onto the v1 API:**
   - `codex(prompt, cwd, model, …)` = `POST /session?directory=<cwd>` with a permission ruleset, then prompt.
   - `codex-reply(threadId, prompt)` = prompt again on the same `sessionID`.
   - "End session" = `POST /session/{id}/abort`, then reject any stale permissions and questions, then optionally `DELETE /session/{id}`.
3. **Prefer `prompt_async` (204) plus `/event` SSE (or polling `/session/status` and `/session/{id}/message`)** over the blocking `POST /session/{id}/message`.
   - The blocking call works and survived 45 s of idle [V-run].
   - But it blocks through permission waits and unbounded provider retries.
   - Node's fetch (undici) also has 300 s default `headersTimeout`/`bodyTimeout` [INF, undici defaults].
4. **Always send `?directory=<abs path>`**, or the `x-opencode-directory` header. Validate the path yourself: the server accepts non-existent directories with 200 [V-run].
5. **Enforce the policy per session** with `permission: PermissionRuleset` on `POST /session`. This is our equivalent of Codex's sandbox and approval-policy, and it works:
   - `deny` removes the tool entirely.
   - `allow` overrides a global `ask` [V-run].
   - Surface `permission.asked` to Claude, or auto-reject it, as `opencode run` does [V-run].
6. **Harden for the air-gapped enterprise setup:**
   - Set `disabled_providers:["opencode"]` or `enabled_providers:[<internal>]`.
   - Set `OPENCODE_DISABLE_MODELS_FETCH=1`, `share:"disabled"`, `autoupdate:false` and `OPENCODE_SERVER_PASSWORD`.
   - Put `rg` on PATH.
   - Point `~/.npmrc` at the internal registry.

   Details in §2.

---

## 1. Package and binary delivery [V-run / V-code]

- `opencode-ai@1.18.33` is a 4-file wrapper with a **`postinstall`** script (`node ./postinstall.mjs`).
  - It has **12 `optionalDependencies`** with platform binaries: `opencode-{linux,darwin,windows}-{x64,arm64}` plus the `-baseline`, `-musl` and `-baseline-musl` variants, all at the same exact version.
- **Install-time network fetches** (`npm i -g --loglevel http`):
  - Registry metadata for `opencode-ai` and all 12 platform packages.
  - Tarballs only for the matching ones: here `opencode-linux-x64` and `opencode-linux-x64-baseline`, about 5 s each.
  - **No GitHub or CDN downloads.** Everything comes from the npm registry, so an internal npm proxy registry is enough.
- **How `postinstall.mjs` works:**
  - It checks AVX2 (`/proc/cpuinfo`) and musl (`/etc/alpine-release`, `ldd --version`).
  - It picks the candidate package order, hard-links or copies `<pkg>/bin/opencode` to `opencode-ai/bin/opencode.exe`, and verifies it with `--version`.
  - If a platform package is missing, it falls back to spawning `npm install --ignore-scripts --no-save --prefix <tmp> <pkg>@<ver>`. That uses the npm CLI, so it honours `.npmrc` and the proxy registry.
  - If the proxy blocks install scripts (`--ignore-scripts`), the `bin/opencode.exe` placeholder is never replaced. Workaround [INF]: install `opencode-linux-x64` or `opencode-linux-x64-baseline` directly and use its `bin/opencode`.
- **The binary:** a single ELF of 185,354,368 bytes (a Bun-compiled executable), dynamically linked against glibc. It needs no Node at runtime.
- **First start and runtime network fetches** [V-run, via the logging and deny proxies and `--network none`]:

| When | Target | Effect when offline | Control |
|---|---|---|---|
| serve start | `GET https://models.opencode.ai/api.json` (models catalog, cached to `~/.cache/opencode/models.json`, 5.2 MB) | logs `ERROR "Failed to fetch models.dev"` and continues on a built-in snapshot (225 providers) | `OPENCODE_DISABLE_MODELS_FETCH=1` (no attempt, verified); `OPENCODE_MODELS_URL`, `OPENCODE_MODELS_PATH` exist [V-code, string only] |
| about 15–70 s after start (background) | npm install of `@opencode-ai/plugin@<ver>` into `~/.config/opencode/` (writes `package.json`, `package-lock.json`, `node_modules/`, 26 packages incl. `@opencode-ai/sdk`, `effect`, `zod`) | `WARN "background dependency install failed" … NpmInstallFailedError`; non-fatal | **honours `~/.npmrc registry=`** (verified: the error URL switched to the `.npmrc` registry), so point it at the internal proxy |
| first grep or `/find` use | download `ripgrep 15.1.0` musl tarball from `github.com/BurntSushi/ripgrep/releases` into `~/.cache/opencode/bin/rg` | `/find` returns 500 `Ripgrep.Error`; the failure is **memoized until restart** | lookup order is `rg` on PATH, then `~/.cache/opencode/bin/rg`, then download (V-code, and verified that `rg` on PATH is used) |
| prompt with no provider config | `https://opencode.ai/zen/v1/chat/completions` (built-in "OpenCode Zen" with `apiKey:"public"`, **connected by default**, default model `big-pickle`) | retries about 65 s, then `APIError "Cannot connect to API"` | `disabled_providers:["opencode"]` or `enabled_providers` |
| v2 `/api/session/*/prompt` | always `opencode.ai` (ignores config) | `HTTP transport failed` | do not use v2 |
| LSP / formatters | not triggered in these tests; logs say "all LSPs are disabled" | — | `OPENCODE_DISABLE_LSP_DOWNLOAD` exists [V-code, string only; INF that LSPs download on demand] |

- **Other env flags present in the binary** [V-code, strings only, behaviour not individually verified]:
  - `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` (verified: inline JSON config), `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`.
  - `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_EMBEDDED_WEB_UI`.
  - `OPENCODE_DISABLE_CLAUDE_CODE*` (it reads Claude Code prompts and skills).
  - `OPENCODE_PERMISSION`, `OPENCODE_ENABLE_QUESTION_TOOL`, `OPENCODE_PURE` (= `--pure`, no external plugins), `OPENCODE_DB`, `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` (verified).
- **Where state lives** (`opencode debug paths`):
  - data: `~/.local/share/opencode` (SQLite `opencode.db` with WAL, plus `snapshot/` git snapshots and `log/`)
  - config: `~/.config/opencode`
  - cache: `~/.cache/opencode`
  - state: `~/.local/state/opencode`
  - tmp: `/tmp/opencode`
  - **Sessions persist across server restarts** [V-run].
- **Git:** snapshots use git (`step-start.snapshot` hashes).
  - A plain `git init` with no commits gave `projectID:"global"`.
  - [INF] Keep git available on the host.

## 2. Air-gap install recipe [INF, built from the verified facts above]

1. `npm config set registry <internal>`, then `npm i -g opencode-ai@1.18.33`. This needs the 12 platform packages mirrored, or at least the matching one. Or install `opencode-linux-x64[-baseline]` and use its binary.
2. Put `rg` on PATH, or pre-seed `~/.cache/opencode/bin/rg`.
3. Pre-seed `~/.config/opencode/node_modules` (`@opencode-ai/plugin@<same ver>`), or let it install through `.npmrc`.
4. Start the server like this:

   ```
   OPENCODE_DISABLE_MODELS_FETCH=1
   OPENCODE_SERVER_PASSWORD=…
   OPENCODE_CONFIG_CONTENT='{"enabled_providers":["corp"],"disabled_providers":["opencode"],"share":"disabled","autoupdate":false,"provider":{"corp":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://llm-gw.corp/v1","apiKey":"{env:CORP_KEY}"},"models":{…}}},"model":"corp/<id>","small_model":"corp/<id>"}'
   opencode serve --hostname 127.0.0.1 --port <p>
   ```

   - `@ai-sdk/openai-compatible` is bundled. It worked with `--network none` [V-run].
   - `{env:VAR}` substitution is [INF] from OpenCode docs; not tested here.

## 3. CLI surface (1.18.33) [V-run, `--help`]

- **Global options:**
  - `--print-logs`, `--log-level DEBUG|INFO|WARN|ERROR`, `--pure`
  - `--port` (default 0 = random), `--hostname` (default 127.0.0.1)
  - `--mdns`, `--mdns-domain`, `--cors <origins…>`
  - TUI only: `-m/--model provider/model`, `-c/--continue`, `-s/--session`, `--fork`, `--prompt`, `--agent`, `--auto` (auto-approve permissions that are not explicitly denied), `--mini`
- **`opencode serve`:** `--port --hostname --mdns --mdns-domain --cors --pure --print-logs --log-level`.
  - Prints `opencode server listening on http://127.0.0.1:<port>` to stdout. The SDK parses exactly this line.
  - Without a password it also prints the warning `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`
- **`opencode run [message..]`:**

  ```
  --command  -c/--continue  -s/--session  --fork  --share  -m/--model
  --agent  --format default|json  -f/--file  --title
  --attach <url>  -p/--password  -u/--username (default OPENCODE_SERVER_USERNAME or 'opencode')
  --dir (path on the remote server when attaching)  --port  --variant  --thinking
  -i/--interactive  --auto
  ```

  - `--format json` prints JSONL events [V-run]:

    ```
    {"type":"step_start"|"text"|"tool_use"|"step_finish"|…,"timestamp":…,"sessionID":…,"part":<Part>}
    ```

  - **Without `--auto`, run auto-rejects permission asks.** It printed `permission requested: bash (...); auto-rejecting`, and the tool part got `status:"error","error":"The user rejected permission to use this specific tool call."` [V-run].
  - With wrong or missing credentials against a password-protected server it printed the misleading error `Error: Session not found` [V-run].
  - It quotes positional args that contain spaces (`"hello from run"` arrived quoted) [V-run].
- **Other subcommands:**
  - `attach <url>` (`--dir -c -s --fork -p -u --mini`)
  - `acp` (Agent Client Protocol server: `--port --hostname --cors --cwd`)
  - `session list [--format json] [-n]`, `session delete <id>`
  - `export [sessionID] [--sanitize]`, `import <file>`
  - `models [provider] [--refresh --verbose]`
  - `providers list|login|logout`, `agent list|create`
  - `mcp add|list|auth|logout|debug`, `db [query] | db path`
  - `debug config|paths|agent|rg|…`, `stats`, `upgrade`, `web`, `github`, `pr`, `plugin`

## 4. Server basics

- **OpenAPI:** `GET /doc` returns `application/json`, OpenAPI 3.1.0, `info.version "1.0.0"`, with no `securitySchemes` declared. [V-run]
  - Any unknown path returns the embedded web UI HTML (200, `text/html`). So check `content-type` rather than status [V-run].
- **Two APIs share one server** [V-spec]:
  - **v1:** operationIds `session.*`, `permission.*`, `event.subscribe`, and so on. This is what the TUI and `opencode run` use (the SDK `v2` client still calls these same `/session/...` URLs).
  - **v2:** `/api/*`, operationIds `v2.*`. Not ready in 1.18.33 (§0).
- **Directory / instance selection** [V-run]:
  - Every instance-scoped v1 route takes `?directory=<path>` (and `?workspace=<wrk…>` for experimental workspaces).
  - The header `x-opencode-directory: <path or URI-encoded path>` also works.
  - Default is the server's cwd.
  - Relative paths resolve against the server cwd (`other` became `/work/proj/other`).
  - **A non-existent directory is accepted (200) with `worktree:"/"`.**
  - The SDK v2 client moves the header into the `directory` query param for GET/HEAD [V-code].
  - v2 routes use `?location[directory]=…` [V-spec, V-run].
  - Sessions are global by ID: `GET /session/{id}?directory=<other>` still returned the session. `GET /session` lists only the current directory's sessions [V-run].
  - Instances are created lazily per directory ("creating instance directory=…" in the log).
- **Auth** [V-run]:
  - With `OPENCODE_SERVER_PASSWORD` set, **every** route requires HTTP Basic, including `/global/health` and `/doc`. Unauthenticated requests get `401` with `WWW-Authenticate: Basic realm="Secure Area"` and an empty body (v2 routes return `{"_tag":"UnauthorizedError","message":"Authentication required"}`).
  - Username is `OPENCODE_SERVER_USERNAME`, default `opencode`. With `USERNAME=mcp` the user `opencode` was rejected.
  - Bearer tokens are not accepted.
  - The query param `?auth_token=<base64(user:pass)>` **is** accepted (useful for SSE/EventSource).
  - The SSE stream works with Basic auth.
  - CORS preflight `OPTIONS` is answered 204 **without** auth.
- **CORS** [V-run]:
  - Allowed by default: any `http://localhost:*` or `http://127.0.0.1:*`, `tauri://localhost`, `https://opencode.ai`, `https://app.opencode.ai`. Methods `GET, HEAD, PUT, PATCH, POST, DELETE`, `Max-Age 86400`, request headers echoed.
  - A foreign origin (`http://evil.example`) gets no `Access-Control-Allow-Origin`, but the server still executes simple GETs.
  - `--cors <origin>` or `server.cors` in config adds more.
  - [INF] Because any localhost origin is trusted, a local web page could drive an unauthenticated server. Always set a password.
- **Error shapes** [V-run]. These are two families:
  - Legacy `{name, data}`:
    - `{"name":"NotFoundError","data":{"message":"Session not found: ses_x"}}` (404)
    - `{"name":"BadRequest","data":{"message":"Expected … at [\"parts\"][0]","kind":"Payload"}}` (400)
    - `{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_274cd4e0"}}` (500). The real cause is only in the server log under that `ref`, for example `ProviderModelNotFoundError: Model not found: nope/x`.
    - `{"name":"ConfigJsonError","data":{"path":"OPENCODE_CONFIG_CONTENT","message":…}}` (400) on every instance route when the config is invalid, while `/global/health` stays 200.
  - Effect-style `{_tag, …}`:
    - `{"_tag":"SessionBusyError","sessionID":…,"message":"Session is busy: ses_…"}` (409)
    - `{"_tag":"PermissionNotFoundError","requestID":…,"message":…}` (404)
    - `{"_tag":"InvalidRequestError",…}`, `{"_tag":"BadRequest"}`
  - Things that return 500 UnknownError: an unknown `providerID/modelID`, an unknown `agent`, a session ID not starting with `ses`, `/find` without rg, and share while `share:"disabled"`.
- **Pagination:** `GET /session/{id}/message?limit=N` returns the newest N in chronological order, plus the headers `Link: <…&before=<cursor>>; rel="next"` and `X-Next-Cursor`. Pass `before=<cursor>` for older pages [V-run].

## 5. v1 endpoint reference (relevant subset) [V-spec, with V-run notes]

All take `?directory&workspace` unless noted. IDs have prefixes: `ses_`, `msg_`, `prt_`, `per_`, `que_`, `evt_`.

| Method / path | opId | Request | Response (200 unless noted) | Notes |
|---|---|---|---|---|
| GET `/global/health` | global.health | — | `{healthy:true, version}` | no directory; `{"healthy":true,"version":"1.18.33"}` |
| GET `/global/event` | global.event | — | SSE `GlobalEvent = {directory, project?, workspace?, payload: Event}` | all instances; also emits `payload.type:"sync"` wrappers [V-run] |
| POST `/global/dispose` | global.dispose | — | `boolean` | server stays up; state persists [V-run] |
| POST `/instance/dispose` | instance.dispose | — | `boolean` | disposes the one directory instance |
| GET `/path` | path.get | — | `{home,state,config,worktree,directory}` | |
| GET `/config` · PATCH `/config` | config.get/update | `Config` | `Config` | top keys: `$schema, shell, logLevel, server, command, skills, references, reference, watcher, snapshot, plugin, share, autoshare, autoupdate, disabled_providers, enabled_providers, model, small_model, default_agent, subagent_depth, username, mode, agent, provider, mcp, formatter, lsp, instructions, layout, permission, tools, attachment, enterprise, tool_output, compaction, experimental` |
| GET `/config/providers` | config.providers | — | `{providers: Provider[], default: {providerID: modelID}}` | **returns provider `options` incl. `apiKey` in clear**. Never relay raw to the model |
| GET `/provider` | provider.list | — | `{all: Provider[], default, connected: string[]}` | |
| GET `/agent` | app.agents | — | `Agent[] = {name, description?, mode:"primary"\|"subagent"\|"all", native?, hidden?, permission: PermissionRuleset, model?, variant?, prompt?, options, steps?, …}` | built-ins: build, plan (primary); explore, general (subagents); compaction, summary, title (hidden) |
| GET `/command` | command.list | — | `Command[]` | |
| GET `/session` | session.list | query `scope?:"project", path?, roots?, start?, search?, limit?` | `Session[]` (newest first) | per directory |
| GET `/experimental/session` | experimental.session.list | `roots, start, cursor, search, limit, archived` | `GlobalSession[]` | cross-project |
| POST `/session` | session.create | `{parentID?:"ses…", title?, agent?, model?:{id, providerID, variant?}, metadata?, permission?: PermissionRuleset, workspaceID?}` (additionalProperties false) | `Session` | `permission` is enforced per session [V-run] |
| GET `/session/status` | session.status | — | `Record<sessionID, SessionStatus>` | **only non-idle sessions appear**; `{}` = all idle |
| GET `/session/{id}` | session.get | — | `Session` / 404 NotFoundError | |
| PATCH `/session/{id}` | session.update | `{title?, metadata?, permission?, time?:{archived?}}` | `Session` | |
| DELETE `/session/{id}` | session.delete | — | `true` / 404 | emits `session.deleted`; see §8 for busy-delete |
| GET `/session/{id}/children` | session.children | — | `Session[]` | only sessions created with `parentID` (a fork is **not** a child) [V-run] |
| POST `/session/{id}/message` | session.prompt | PromptBody (§6) | `{info: AssistantMessage, parts: Part[]}`; with `noReply:true` returns the **user** message | blocks until the turn loop ends |
| POST `/session/{id}/prompt_async` | session.prompt_async | PromptBody | **204** "Prompt accepted" | accepted even while busy (queued) |
| POST `/session/{id}/abort` | session.abort | — | `true` (also when idle) | |
| GET `/session/{id}/message` | session.messages | `limit?, before?` | `{info: Message, parts: Part[]}[]` | |
| GET `/session/{id}/message/{mid}` | session.message | — | `{info, parts}` | |
| DELETE `/session/{id}/message/{mid}` · PATCH/DELETE `…/part/{pid}` | session.deleteMessage / part.update / part.delete | | | |
| POST `/session/{id}/fork` | session.fork | `{messageID?}` | `Session` (title "… (fork #1)", no parentID) | |
| POST `/session/{id}/revert` | session.revert | `{messageID, partID?}` | `Session` / 409 SessionBusyError | |
| POST `/session/{id}/unrevert` | session.unrevert | — | `Session` / 409 | |
| POST `/session/{id}/shell` | session.shell | `{messageID?, agent (required), model?:{providerID,modelID}, command}` | `{info: Message, parts}` / 409 | |
| POST `/session/{id}/command` | session.command | `{messageID?, agent?, model?: "provider/model" string, arguments, command, variant?, parts?: FilePartInput[]}` | `{info: AssistantMessage, parts}` | slash commands |
| POST `/session/{id}/summarize` | session.summarize | `{providerID, modelID, auto?}` | `boolean` | compaction |
| POST `/session/{id}/init` | session.init | `{modelID, providerID, messageID}` | `boolean` | writes AGENTS.md |
| GET `/session/{id}/diff` | session.diff | `messageID?` | `SnapshotFileDiff[] = {file?, patch?, additions, deletions, status?}` | |
| GET `/session/{id}/todo` | session.todo | — | `Todo[] = {content, status, priority}` | |
| POST/DELETE `/session/{id}/share` | session.share/unshare | — | `Session` | 500 when share disabled [V-run] |
| POST `/experimental/session/{id}/background` | experimental.session.background | — | `boolean` | detach blocking subagents |
| GET `/permission` | permission.list | — | `PermissionRequest[]` | **all sessions**; works with or without directory [V-run] |
| POST `/permission/{requestID}/reply` | permission.reply | `{reply:"once"\|"always"\|"reject", message?}` | `true` / 404 PermissionNotFoundError | `message` is fed back to the model as feedback [V-run] |
| POST `/session/{id}/permissions/{permissionID}` | permission.respond | `{response:"once"\|"always"\|"reject"}` | `true` | legacy alias |
| GET `/question` | question.list | — | `QuestionRequest[]` | |
| POST `/question/{requestID}/reply` | question.reply | `{answers: string[][]}` (one array of selected labels per question) | `true` | verified with `[["B"]]` |
| POST `/question/{requestID}/reject` | question.reject | — | `true` | |
| GET `/event` | event.subscribe | — | SSE `data: <Event JSON>` | one directory instance |
| GET `/vcs/diff` | vcs.diff | `mode: "git"\|"branch"` (required), `context?` | `VcsFileDiff[]` | |
| GET `/find`, `/find/file`, `/find/symbol`, `/file`, `/file/content`, `/file/status` | find.* / file.* | | | `/find` needs rg |
| PUT/DELETE `/auth/{providerID}` | auth.set/remove | `Auth` | `boolean` | stores provider credentials. Avoid from MCP |
| `/experimental/worktree` (GET/POST/DELETE/reset) | worktree.* | | | per-task git worktrees [V-spec only] |
| `/tui/*`, `/pty/*`, `/mcp/*`, `/sync/*`, `/experimental/workspace*` | | | | not needed |

**Schemas used above** [V-spec]:
- `Session = {id, slug, projectID, workspaceID?, directory, path?, parentID?, summary?:{additions, deletions, files, diffs?}, cost?, tokens?:{input, output, reasoning, cache:{read, write}}, share?:{url}, title, agent?, model?:{id, providerID, variant?}, version, metadata?, time:{created, updated, compacting?, archived?}, permission?, revert?:{messageID, partID?, snapshot?, diff?}}`
- `SessionStatus = {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, action?:{reason, provider, title, message, label, link?}, next: <epoch ms>}`
- `PermissionRequest = {id:"per…", sessionID, permission:"bash"|"edit"|…, patterns: string[], metadata: object, always: string[], tool?:{messageID, callID}}`
  - Example [V-run]:

    ```json
    {"permission":"bash","patterns":["echo hello-from-tool > out.txt","cat out.txt"],"metadata":{"command":"…"},"always":["echo *","cat *"]}
    ```

- `QuestionRequest = {id:"que…", sessionID, questions: {question, header, options:{label, description}[], multiple?, custom?}[], tool?:{messageID, callID}}`
- `PermissionRuleset = {permission: string, pattern: string, action:"allow"|"deny"|"ask"}[]`
- Config `permission` keys: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill`. Each takes `"ask"|"allow"|"deny"` or a pattern map.

## 6. Prompt request and response (exact) [V-spec + V-run]

**Request body** for `POST /session/{id}/message` and `/prompt_async` (additionalProperties false; `parts` required):

```ts
{
  messageID?: string /^msg/;                      // client-chosen id (idempotency / ordering)
  model?: { providerID: string; modelID: string }; // NOTE: modelID here, but session.create uses {id, providerID, variant?}
  agent?: string;                                  // "build" | "plan" | custom; unknown -> 500
  noReply?: boolean;                               // append context only, returns the user message
  tools?: Record<string, boolean>;                 // e.g. {"bash": false}
  format?: {type:"text"} | {type:"json_schema", schema: JSONSchema, retryCount?: int}; // structured output -> AssistantMessage.structured
  system?: string;                                 // extra system prompt
  variant?: string;                                // reasoning effort variant
  parts: Array<
    | {type:"text", text, id?, synthetic?, ignored?, time?, metadata?}
    | {type:"file", mime, url, filename?, source?: FileSource|SymbolSource|ResourceSource, id?}  // url: data: or file:
    | {type:"agent", name, source?:{value,start,end}, id?}
    | {type:"subtask", prompt, description, agent, model?:{providerID,modelID}, command?, id?}
  >;
}
```

**Response** `{info: AssistantMessage, parts: Part[]}` (a real one is at `docs/research/samples/opencode-sample-prompt-sync-text-response.json`):

```ts
AssistantMessage = { id, sessionID, role:"assistant", time:{created, completed?}, parentID /*user msg id*/, modelID, providerID,
  mode, agent, path:{cwd, root}, summary?, cost, tokens:{total?, input, output, reasoning, cache:{read, write}},
  structured?, variant?, finish?: "stop"|"tool-calls"|…,
  error?: ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|StructuredOutputError|ContextOverflowError|ContentFilterError|APIError }
UserMessage = { id, sessionID, role:"user", time:{created}, format?, summary?:{title?, body?, diffs}, agent, model:{providerID, modelID, variant?}, system?, tools? }
```

**Part union** (all parts carry `{id, sessionID, messageID}`):
- `text {text, synthetic?, ignored?, time?, metadata?}`
- `reasoning {text, time, metadata?}`
- `tool {callID, tool, state, metadata?}`, where `state` is one of:
  - `{status:"pending", input, raw}`
  - `{status:"running", input, title?, metadata?, time:{start}}`
  - `{status:"completed", input, output, title, metadata, time:{start, end, compacted?}, attachments?: FilePart[]}`
  - `{status:"error", input, error, metadata?, time:{start, end}}`
- `step-start {snapshot?}`
- `step-finish {reason, snapshot?, cost, tokens}`
- `patch {hash, files: string[]}`
- `file {mime, filename?, url, source?}`
- `agent {name, source?}`
- `subtask {prompt, description, agent, model?, command?}`
- `snapshot {snapshot}`
- `retry {attempt, error: APIError, time:{created}}`
- `compaction {auto, overflow?, tail_start_id?}`

**What a real turn looks like** [V-run]:
- A tool turn produces **two assistant messages** for one user message:
  - msg 1: `step-start`, `tool` (bash, completed, `output:"hello-from-tool\n"`, `metadata:{output, exit:0, truncated:false}`), `step-finish(reason:"tool-calls")`, `patch(files:["/work/proj/out.txt"])`, with `finish:"tool-calls"`.
  - msg 2: `step-start`, `text`, `step-finish(reason:"stop")`, with `finish:"stop"`.
  - The sync response returns **only the last assistant message**. So for a full transcript, or for "final text = last text part of the last assistant message", call `GET /session/{id}/message`.
- `APIError.data` includes `responseHeaders` and `responseBody` from the upstream gateway (§8), so truncate or redact it before relaying.

## 7. SSE events [V-spec union + V-run observations]

- **Wire format:** `data: {"id":"evt_…","type":"<type>","properties":{…}}` followed by a blank line. The first event is `server.connected`.
- **`server.heartbeat` arrives every 10 s** (measured 10.1 / 20.1 / 30.1 s). It is **not listed in the OpenAPI Event union**, so the parser must tolerate unknown types.
- `/global/event` wraps each event as `{directory, project?, workspace?, payload}`.
- **The OpenAPI `Event` union has 89 members:**
  - Session and message:
    - `session.created`, `session.updated`, `session.deleted` (`{sessionID, info: Session}`)
    - `session.status {sessionID, status}`, `session.idle {sessionID}`
    - `session.error {sessionID?, error?}`, `session.diff {sessionID, diff}`, `session.compacted`
    - `message.updated {sessionID, info: Message}`, `message.removed`
    - `message.part.updated {sessionID, part, time}`
    - `message.part.delta {sessionID, messageID, partID, field:"text", delta}` (streaming text), `message.part.removed`
  - Permissions and questions:
    - `permission.asked` (same shape as PermissionRequest), `permission.replied {sessionID, requestID, reply}`
    - `question.asked`, `question.replied {sessionID, requestID, answers}`, `question.rejected`
  - v2 variants: `permission.v2.*`, `question.v2.*`, and 32 `session.next.*` events (`prompted`, `step.started/ended/failed`, `text.*`, `reasoning.*`, `tool.*`, `retried`, `compaction.*`, `revert.*`, …). These are emitted only for v2 prompts [V-run].
  - Misc: `todo.updated`, `file.edited`, `file.watcher.updated`, `command.executed`, `project.updated`, `vcs.branch.updated`, `lsp.updated`, `mcp.tools.changed`, `pty.*`, `tui.*`, `installation.update-available`, `worktree.*`, `workspace.*`, `plugin.added` (about 45 on each lazy catalog boot), `catalog.updated`, `integration.updated`, `reference.updated`, `global.disposed`, `server.instance.disposed`.
- **Observed order for an async tool turn with permission ask, then "once"** [V-run, sample log]:

  ```
  message.updated(user) → message.part.updated(text) → session.updated → session.status{busy}
  → message.updated(assistant) → session.diff → step-start part → tool part {pending}
  → tool part {running, input} → permission.asked … [reply] → permission.replied{reply:"once"}
  → tool part {running, metadata.output streaming} → tool part {completed}
  → step-finish(tool-calls) → message.updated → patch part → session.status{busy}
  → message.updated(assistant #2) → step-start → text part("") → message.part.delta×N
  → text part(final) → message.updated(user with summary.diffs) → step-finish(stop)
  → message.updated(assistant completed) → session.status{idle} → session.idle → session.updated → session.diff
  ```

- **Completion signal:** `session.idle`, or `session.status {type:"idle"}`.
- **Failure signal:** `session.error` (also emitted for async prompts that fail before any message, for example with no providers).

## 8. Behaviours verified by running [V-run]

- **No provider available** (`disabled_providers:["opencode"]`, nothing else):
  - Sync prompt returns `500 UnknownError`. The log shows `ProviderNoProvidersError: No providers are available`.
  - `prompt_async` returns 204, then `session.error {error:{name:"UnknownError", data:{message:"ProviderNoProvidersError: No providers are available\n at …"}}}`. No messages are stored.
- **Default config offline:** the prompt goes to `opencode/big-pickle`. The provider retries for about 65 s, then the sync call returns 200 with `info.error = {"name":"APIError","data":{"message":"Cannot connect to API: …","isRetryable":true,"metadata":{"url":"https://opencode.ai/zen/v1/chat/completions"}}}` and `parts:[]`.
- **Bad model ID** (`nope/x`): 500 UnknownError. The log shows `ProviderModelNotFoundError`. **The user message is still persisted.**
- **Upstream 400/401:** 200 with `info.error = {name:"APIError", data:{message, statusCode, isRetryable:false, responseHeaders, responseBody, metadata:{url}}}` and `parts:[]`, plus a `session.error` event. There is no `ProviderAuthError` for an openai-compatible 401.
- **Upstream 500:** retried with exponential backoff (attempts at about +0, 5, 10, 20, 40 s…).
  - `session.status = {type:"retry", attempt:N, message:"mock upstream failure", next:<epoch ms>}`.
  - It was still retrying at attempt 4 after 24 s. The MCP must cap this with its own timeout and abort.
  - Abort during retry leaves an assistant message with no parts and no error.
- **Abort:**
  - `POST /abort` returns true within about 75 ms. The assistant message gets `error:{name:"MessageAbortedError", data:{message:"Aborted"}}` and keeps its partial text.
  - A running tool becomes `state.status:"error","error":"Tool execution aborted"`.
  - The sync prompt returns 200 with that aborted message.
  - Abort on an idle session also returns true.
  - Upstream streaming is closed (the mock saw the client close).
- **Abort does not clear pending permission requests.** The `per_…` stayed in `GET /permission` for 20+ s after abort. Replying to it returns true and clears it, and the session stays idle. So when the MCP closes a session it should reject that session's pending permissions and questions.
- **Busy session:**
  - `prompt_async` while busy is accepted (204) and queued as a user message.
  - After abort, the queued message is **not** processed (an orphan user message is left).
  - `shell` and `revert` while busy return `409 SessionBusyError`.
- **Delete while busy:** returns `true` immediately.
  - `/session/status` still showed `busy` about 2 s later.
  - The run was aborted about 5 s later and the log showed `"prompt_async failed" … EffectDrizzleQueryError: insert into "part" …`.
  - The safe order is abort, wait for idle, then delete.
- **Permission reply:**
  - `reject` with `message` makes the tool error text reach the model as `"The user rejected permission to use this specific tool call with the following feedback: not allowed by policy"`, and the turn continues.
  - `once` runs the tool.
  - `always` [V-spec] adds the `always` patterns.
- **Question tool:** it is enabled in `serve` (the `question` tool was in the tool list).
  - `GET /question` shows the request.
  - `POST /question/{id}/reply {"answers":[["B"]]}` gives the tool output `User has answered your questions: "Which option?"="B". …`.
- **Per-session permission ruleset:** `POST /session {"permission":[{"permission":"bash","pattern":"*","action":"deny"}]}` means **bash is removed from the tool list entirely**. The model got `Model tried to call unavailable tool 'bash'`, and `{"action":"allow"}` bypassed the global `bash: ask`.
- **Default agent permissions** (build): `*=allow, doom_loop=ask, external_directory=ask, read(*.env|*.env.*)=ask, read(*.env.example)=allow`. So **bash and edit are allowed by default.**
  - Config `permission` rules are appended after the agent defaults. Global `edit: allow` also showed up after `plan`'s `edit(*)=deny` [V-run]. [INF] Rules are last-match-wins, so a global allow can undo plan mode's read-only guard.
- **`agent:"plan"` plus `tools:{bash:false}` plus `system`:** honoured. `info.mode`/`agent` became `plan`, bash was absent from the tools sent to the LLM, and a plan-mode system reminder was injected.
- **Tools sent to the LLM** (build, default): `bash, edit, glob, grep, question, read, skill, task, todowrite, webfetch, write`. The system prompt was about 9.5 k chars.
- **Sync prompt connection:** stayed open through a 45 s idle permission wait and returned 200. There is no server idle timeout at that scale.
- **Title:** giving `title` on create avoids the `small_model` title-generation call [INF: not separately measured].
- **Accidental egress, disclosed:** during the no-provider test, one v2 `POST /api/session/{id}/prompt` ("hi3") went to the OpenCode Zen free model on opencode.ai, because v2 ignores `disabled_providers`. After that I switched opencode's proxy to deny-all. No secrets were involved.

## 9. v2 API (`/api/*`): not usable in 1.18.33 [V-run]

- **Endpoints** [V-spec]:
  - `POST /api/session` `{id?, agent?, model?:ModelRef, location?}` returns `{data: SessionV2Info}`
  - `POST /api/session/{id}/prompt` `{id?, prompt:{text, files?, agents?}, delivery?:"steer"|"queue", resume?}` returns `{data: SessionInputAdmitted}`
  - `/wait`, `/interrupt`, `/message` (cursor paging), `/history`, `/event` (durable replay with `after=<seq>`), `/permission`, and `/api/event`
- **Why it is unusable:**
  - `wait` returns 503.
  - Prompts ignore config providers (`/api/model` listed 34 models, all `opencode`).
  - v1 and v2 permission queues are separate: `/api/session/{id}/permission` showed `[]` while a v1 permission was pending.
  - Calling any v2 route triggers a lazy catalog boot (a burst of about 45 `plugin.added` events).
- **Worth watching:** the design (durable event log with sequence replay and a server-side wait) is attractive once it ships.

## 10. `@opencode-ai/sdk@1.18.33` [V-code + V-run]

- **Package:** ESM only (`"type":"module"`), MIT, 79 files, about 777 KB unpacked.
  - **The only dependency is `cross-spawn@7.0.6`**, which installs 7 packages total. It is used only by `createOpencodeServer` and `createOpencodeTui`.
  - The version is lock-stepped with the CLI.
- **Exports:** `.`, `./client`, `./server`, `./v2`, `./v2/client`, `./v2/server`, `./v2/types`, `./v2/gen/client`.
  - `createOpencodeClient({baseUrl, directory?, headers?, fetch?, experimental_workspaceID?})` (v2 variant).
  - `createOpencodeServer({hostname="127.0.0.1", port=4096, timeout=5000, config, signal})` spawns `opencode serve --hostname=… --port=…` with `OPENCODE_CONFIG_CONTENT=JSON.stringify(config)`. It parses the "listening" stdout line and exposes `close()`. It has no password support; pass env yourself.
  - Also `createOpencode()` (server plus client) and `createOpencodeTui()`.
- **The generated client (hey-api) has two styles:**
  - v2 client: flattened params, e.g. `client.session.prompt({sessionID, parts, model, agent, …})`, `client.session.promptAsync(...)`, `client.permission.reply(...)`, `client.event.subscribe({directory})`. This returns an SSE async iterator with reconnect (default retry 3000 ms, exponential backoff capped at 30 s, optional `sseMaxRetryAttempts`).
  - Root (v1) client: `{path:{id}, body, query}` style.
  - Results are `{data, error, response}`.
- **Live test:** `createOpencodeClient({baseUrl, directory, headers:{Authorization:"Basic …"}})` handled create, prompt, status, delete, and a 404 error object (`{name:"NotFoundError",…}`).
- **Verdict:** it is safe and small, and useful for types. But the MCP only needs about 12 endpoints, and raw `fetch` plus a hand-written SSE parser avoids hey-api churn across releases.
  - [INF] Options are to vendor the types from `/doc` or depend on the SDK pinned to the exact CLI version.
  - Either way, pin the version: the API moves fast (1.18.29 to 1.18.33 in 24 days).

## 11. Suggested Codex-MCP-parity mapping [INF, design suggestion]

| Codex MCP | opencode-mcp over the v1 API |
|---|---|
| `codex` {prompt, cwd, model, approval-policy, sandbox, base-instructions, …} | 1. `POST /session?directory=cwd` `{title, permission:<ruleset from policy>, agent?}`<br>2. `POST /session/{id}/prompt_async` `{parts:[{type:"text", text}], model:{providerID, modelID}, agent, system}`<br>3. Follow `/event` until `session.idle` or `session.error`, handling `permission.asked` and `question.asked` via policy (auto-reject, or return a pending state to Claude)<br>4. Result = last assistant text, plus tool summary, patch files, `/session/{id}/diff`, tokens and cost<br>5. Return `sessionID` as `threadId` |
| `codex-reply` {threadId, prompt} | Steps 2–4 on the same session. If busy, return 409-like "busy" (or abort first) |
| end or close | `POST /abort`, then reply `reject` to that session's pending `/permission` and `/question`, wait for idle, then `DELETE /session/{id}` (optional; keeping it preserves history) |
| server lifecycle | spawn `opencode serve --port 0` per MCP process (parse the stdout URL), random `OPENCODE_SERVER_PASSWORD`, kill on MCP exit; or attach to a shared internal server by URL plus credentials |
