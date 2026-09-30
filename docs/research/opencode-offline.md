# OpenCode offline e2e spike (fake LLM, gram, network-none)

Date: 2026-09-29. Host: gram (`ssh gram`), Docker `node:22` (Debian 12, Node v22.23.3).
All containers (`ocmcp-research-offline`, `ocmcp-research-nonet`) and the temp image `ocmcp-research-offline:snap` were removed afterwards. Other `ocmcp-research-*` containers (api, api-airgap, mcpclient) belong to other units and were not touched.

Legend: **[RUN]** = observed in an actual run in this spike. **[SRC]** = read from source at tag `v1.18.33`. **[INF]** = inference.

## 1. Verdict

- **A hermetic e2e harness works.** OpenCode 1.18.33 ran a full session against a 150-line, dependency-free fake OpenAI-compatible server. The run covered a streamed text reply, a scripted `write`/`bash` tool call, a permission `ask`, `reply`, tool execution, a second LLM turn, the final text, `session.idle`, and `DELETE`. It works in a container started with `--network none`. **[RUN]**
- `@ai-sdk/openai-compatible` is **bundled** in the binary, so no download is needed. **[SRC+RUN]** Provider packages that are not bundled are installed at runtime from the npm registry. That install honors `NPM_CONFIG_REGISTRY` and `~/.npmrc` **[RUN]**.
- Network use seen without any flags **[RUN via logging CONNECT proxy]**:
  1. `models.opencode.ai` (model catalog) at startup.
  2. `registry.npmjs.org`: `@opencode-ai/plugin@<version>` plus about 25 dependencies are installed into every config dir (`~/.config/opencode`, `<proj>/.opencode`, `OPENCODE_CONFIG_DIR`) on first instance boot.
  3. `github.com` (ripgrep download) the first time `grep`/`glob` runs, if `rg` is not on PATH.

  Nothing else was contacted in the spike: no share, no autoupdate, no telemetry.
- These failure modes matter for the air-gapped deployment **[RUN]**:
  - With no registry reachable, the config-dir npm install stalls for **about 71 s** (npm fetch retries). This stall **blocks `POST /session`** whenever any plugin is configured, including a local `.opencode/plugins/*.js` file. With no plugin configured it only logs a WARN.
  - `grep`/`glob` tools fail with `ripgrep execution failed` if `rg` is missing. The failure is cached until the process restarts.
  - Non-bundled provider npm package → `Failed to initialize provider: <id>`.

## 2. Versions and sources

| Item | Value | Source |
|---|---|---|
| npm `opencode-ai` latest | 1.18.33 (`time.modified` 2026-09-28T23:20Z) | `npm view` [RUN] |
| Source | https://github.com/anomalyco/opencode tag `v1.18.33` = `51ef4be1d3c1…` (2026-09-28). `github.com/sst/opencode` 301-redirects to it | git ls-remote/clone [RUN] |
| Binary | `opencode-linux-x64` 1.18.33, 185 MB single executable, embeds Bun 1.3.14 | strings, UA header [RUN] |
| LLM UA seen by gateway | `opencode/1.18.33 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` | fake server log [RUN] |

`opencode-ai` is a thin wrapper. `postinstall.mjs` hard-links `bin/opencode.exe` from the platform optionalDependency (`opencode-linux-x64`, `-baseline`, `-musl` …). If that fails, it runs `npm install <platform-pkg>@<ver>`, which also goes through the npm config and registry. The binary needs no other npm packages at runtime. **[RUN]** (`node_modules/opencode-ai/postinstall.mjs`)

## 3. Reproducible setup

```bash
docker run -d --name ocmcp-research-offline node:22 sleep infinity
docker exec ocmcp-research-offline bash -lc 'mkdir -p /opt/oc && cd /opt/oc && npm init -y && npm install opencode-ai@1.18.33'
# binary: /opt/oc/node_modules/.bin/opencode  (→ node_modules/opencode-ai/bin/opencode.exe)
# project: /work/proj (git init + empty commit + README.md "# demo"), opencode.json below
node /work/fake-llm-server.mjs            # PORT=18080, LOG=/work/fake-llm.jsonl, DUMP_DIR=/work/dumps
cd /work/proj && HOME=/work/home-a opencode serve --port 4096 --hostname 127.0.0.1 --print-logs --log-level DEBUG
# offline copy: docker commit → docker run --network none … (loopback still works; fake LLM runs inside)
```

`opencode.json` (project root) as used. Saved as `opencode-sample-config.opencode.json`:

```json
{
  "model": "fake/fake-model",
  "small_model": "fake/fake-model",
  "enabled_providers": ["fake"],
  "autoupdate": false,
  "share": "disabled",
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake LLM",
      "options": { "baseURL": "http://127.0.0.1:18080/v1", "apiKey": "fake-key" },
      "models": { "fake-model": { "name": "Fake Model", "tool_call": true, "limit": { "context": 128000, "output": 4096 } } }
    }
  },
  "permission": { "edit": "ask", "bash": "ask" }
}
```

- `enabled_providers` hides the built-in `opencode` (Zen) provider. Without it, `opencode models` offline still lists `opencode/big-pickle` etc. from the bundled snapshot. **[RUN]**
- The same config also works as the only source through `OPENCODE_CONFIG_CONTENT='<json>'`, with no file on disk. **[RUN, O10]**

**Fake LLM** is at `fake-llm-server.mjs`: Node `http`, no dependencies.
- It serves `POST /v1/chat/completions` both as SSE (`stream:true`, including the `include_usage` chunk and `[DONE]`) and as plain JSON.
- `GET /v1/models`, `GET /__requests` and `POST /__reset` are also provided.
- It is stateless and scripted from the request:
  - no `tools` → `"Fake title"` (the title-generation call)
  - last message `role:"tool"` → `DONE: <tool output>`
  - `WRITE_FILE` → `write {filePath:"hello.txt",…}`
  - `RUN_BASH` → `bash {command:"echo fake-bash-ok"}`
  - `CALL_TOOL <name> <json>` → any tool
  - otherwise `FAKE_REPLY: <user text>`

**Helper scripts** (see §10 for what was committed):
- `drive-session.mjs`: the reference HTTP driver. It does SSE subscribe, create, `prompt_async`, the permission loop, messages and delete. Committed under `docs/research/samples/`.
- `abort-test.mjs`, `logging-proxy.mjs` (a CONNECT proxy that logs every outbound host), `fake-registry.mjs` (a pass-through or 404 npm registry that stands in for Nexus) — not retained.

## 4. HTTP flow observed (v1 routes) [RUN]

| Step | Call | Result |
|---|---|---|
| Events | `GET /event` (SSE, `data:` lines only, first `server.connected`, `server.heartbeat` every 10 s [SRC]) | see `opencode-sample-events-*.sse.txt` |
| Create | `POST /session` `{"title":"…"}` | Session JSON `{id:"ses_…",slug,projectID,directory,title,version,time}`. Setting a title **avoids an extra title-generation LLM call** (the calls with 0 tools in `opencode-sample-fake-llm-requests.txt` appear only for untitled sessions) |
| Prompt (sync) | `POST /session/{id}/message` `{"model":{"providerID":"fake","modelID":"fake-model"},"parts":[{"type":"text","text":"…"}]}` | Blocks until done and returns `{info:{role:"assistant",finish:"stop",tokens,…},parts:[step-start,text,step-finish]}` (`opencode-sample-prompt-sync-text-response.json`). **Keeps blocking while a permission is pending** and returns after the reply (3.8 s test, `…-sync-bash-after-permission.json`) |
| Prompt (async) | `POST /session/{id}/prompt_async` (same body) | `204` with an empty body |
| Permission | SSE `permission.asked` `{id:"per_…",sessionID,permission:"edit"/"bash",patterns,metadata:{filepath,diff}/{command},always:["*"]/["echo *"],tool:{messageID,callID}}`; also `GET /permission` | `opencode-sample-permission-asked-event.json`, `…-permission-list.json` |
| Reply | `POST /permission/{requestID}/reply` `{"reply":"once"\|"always"\|"reject","message"?}` → `200 true`; SSE `permission.replied` | legacy `POST /session/{sid}/permissions/{pid}` `{"response":…}` also exists [SRC openapi] |
| Done | SSE `session.status {type:"idle"}` + `session.idle`; `GET /session/{id}/message` for the full transcript | `opencode-sample-messages-write.json` |
| End | `DELETE /session/{id}` → `200 true`, SSE `session.deleted`; later `GET` → `404 NotFoundError` | `opencode-sample-session-delete.json` |
| Abort | `POST /session/{id}/abort` while a permission is pending → `200 true`; the assistant gets `error:{name:"MessageAbortedError"}`, the tool part `error:"Tool execution aborted"`, SSE `session.error` then `session.idle` | **the stale permission stays in `GET /permission` even after abort and delete** |

Additional observations:
- **Reject.** The tool part becomes `status:"error"` with `error:"The user rejected permission to use this specific tool call."`. The loop stops with `finish:"tool-calls"` and no final text (`opencode-sample-messages-bash-reject.json`). The `experimental.continue_loop_on_deny` config key exists [SRC] but was not tested.
- **Basic auth.** With `OPENCODE_SERVER_PASSWORD` set, requests without auth get 401, including `/global/health`. Auth as `opencode:<pw>` gets 200.
- **Startup race.** A request that arrives while the listener is opening can hang (seen once for >2 min, and once for 3 s, both online and offline). Waiting for the stdout line `opencode server listening on http://…` first avoided it. **Always use request timeouts.**
- **Session create options.** `session.create` accepts `permission` (a per-session ruleset), `agent`, `model`, `parentID` and `workspaceID` [SRC openapi]. These were not exercised.
- **Headers sent to the LLM gateway:** `authorization: Bearer <apiKey>`, `x-session-id`, and `x-session-affinity` (= OpenCode session id). The request uses `stream:true` with `stream_options.include_usage:true`.
- **Tools offered.** `serve` offers `bash, edit, glob, grep, question, read, skill, task, todowrite, webfetch, write`. `run` offers the same without `question`.

## 5. `opencode run --format json` [RUN]

Samples are in `opencode-sample-run-json-*.txt`.
- The output is one JSON object per line: `{"type":"step_start"|"text"|"tool_use"|"step_finish"|("reasoning"|"error" [SRC]),"timestamp","sessionID","part":{…}}`.
- Standalone (`opencode run --format json -m fake/fake-model "…"`) takes about 3.9 s online and 4.4 s offline with a fresh HOME.
- **Non-interactive `run` auto-rejects every `ask` permission.** It prints `! permission requested: edit (hello.txt); auto-rejecting` to stderr and **still exits 0** [RUN; `cli/cmd/run.ts:800-820`].
- `--auto` approves with `once`.
- `--attach http://127.0.0.1:4096 --dir /work/proj` behaves the same way, because the auto-reject is done by the `run` client.
- `run` never deletes its session.
- Multi-word positional args reach the LLM wrapped in literal quotes (`FAKE_REPLY: "Say hello from run"`).
- **Consequence for opencode-mcp:** interactive approval is not possible through `run`/`--attach`. Approval must go through the HTTP API.

## 6. Network surface and switches

### Observed outbound connections (online, no flags, logging proxy) [RUN]

- `models.opencode.ai:443`: at server start. The default source changed from models.dev to `https://models.opencode.ai` (`packages/core/src/models-dev.ts:160`). It re-fetches every 60 min, with a 5-min freshness TTL [SRC].
- `registry.npmjs.org:443`: about 28 connects, about 72 metadata and tarball GETs. This is `@opencode-ai/plugin@1.18.33` and its dependencies (`effect`, `@opentui/*`, `msgpackr`…) going into `~/.config/opencode/node_modules` (63 MB) and `~/.npm` (95 MB). The trigger is `Npm.install(dir)` for each config dir (`packages/opencode/src/config/config.ts:437-470`). It also auto-creates `~/.config/opencode/opencode.jsonc` containing `{"$schema": …}`.
- Nothing else during create, prompt, permission, tools (`write`, `bash`) and delete.

### Switches and where each was verified

| Switch | Effect | Verified |
|---|---|---|
| `OPENCODE_DISABLE_MODELS_FETCH=1` | No models.opencode.ai fetch; falls back to disk cache, then the **build-time bundled snapshot** (`OPENCODE_MODELS_DEV` define, `script/build.ts:195`) | [RUN] no connect in proxy log; offline `opencode models` still lists snapshot models |
| `OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH` | Point the catalog at an internal mirror or a local `api.json` | [SRC] `core/src/flag/flag.ts`, `models-dev.ts` |
| `NPM_CONFIG_REGISTRY=<nexus>` or `~/.npmrc registry=` | All runtime npm installs (config-dir `@opencode-ai/plugin`, non-bundled provider packages, npm plugins) use `@npmcli/config` + Arborist, so every npmrc/env key applies (auth, proxy, `strict-ssl`, `cafile` [INF]). Tarballs were also served by the fake registry (npm `replace-registry-host`) | [RUN] env and `~/.npmrc`: 0 hits to npmjs in proxy log. Note: the install dir is the cwd for npm config, so the *project's* `.npmrc` is not used for `~/.config/opencode` [SRC `core/src/npm-config.ts`] |
| `NPM_CONFIG_FETCH_RETRIES=0` | Offline config-dir install fails in 0.6 s instead of about 71 s | [RUN O14] |
| `OPENCODE_PURE=1` / `--pure` | Skips external plugins, so `waitForDependencies` is skipped. Fixes the hang, but local plugins are not loaded | [RUN O6] |
| `OPENCODE_DISABLE_AUTOUPDATE=1` / `"autoupdate": false` (**global** config; read via `getGlobal()`) | Update check (GitHub releases / brew / choco / npm) | [SRC] `cli/upgrade.ts`; only called from the **TUI worker**, not from `serve` or `run` |
| `OPENCODE_DISABLE_SHARE=1` / `"share":"disabled"` / `enterprise.url` | Share goes to `https://opncd.ai` unless `enterprise.url` is set; default mode is manual | [SRC] `share/share-next.ts:23,210`; no share traffic observed |
| `OPENCODE_DISABLE_LSP_DOWNLOAD=1` | Stops LSP binary downloads (GitHub, npm) | [SRC] `lsp/server.ts`; **LSP and formatters are off by default in 1.18.33** (`cfg.lsp`/`cfg.formatter` unset means disabled; log shows "all LSPs are disabled") [RUN] |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` | Skips built-in auth plugins (Codex, Copilot, GitLab…). They are compiled in, with no network at load | [SRC] `plugin/index.ts:66-86,170` |
| Telemetry | No telemetry endpoint found. OTEL export only happens if `OTEL_EXPORTER_OTLP_ENDPOINT` is set; `experimental.openTelemetry` only adds AI SDK spans | [SRC] `core/src/flag/flag.ts`, v1 config schema |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` / `OPENCODE_DISABLE_PROJECT_CONFIG` | Custom config file / inline JSON (merged after project config) / extra config dir (**also gets the npm install**) / ignore project config | CONFIG_CONTENT [RUN]; others [SRC] `config/config.ts`, `config/paths.ts` |
| Managed config `/etc/opencode/opencode.json[c]` (macOS: `/Library/Application Support/opencode`, MDM plist `ai.opencode.managed`) | Admin-enforced config, merged late (after project and CONTENT) | [SRC] `config/managed.ts`, `config.ts:530-548` |
| `OPENCODE_PERMISSION='<json>'` | Merged into `permission` last | [SRC] `config.ts:557` |
| `OPENCODE_SERVER_PASSWORD` / `_USERNAME` | Basic auth on `serve` | [RUN] |
| `OPENCODE_DISABLE_EMBEDDED_WEB_UI` | **Do not set offline.** It makes the web UI proxy to `https://app.opencode.ai` instead of the embedded copy | [SRC] `server/shared/ui.ts` |
| `OPENCODE_DISABLE_CLAUDE_CODE(_PROMPT/_SKILLS)`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` | Stop scanning `~/.claude` and `CLAUDE.md` style files; not network related | [SRC] `effect/runtime-flags.ts` |

Other network code paths, all [SRC] and not triggered in the spike:
- `webfetch` tool (arbitrary URLs).
- `websearch` (Exa/Parallel, off unless `OPENCODE_ENABLE_EXA`).
- Remote MCP servers from config.
- `wellknown` auth, which fetches `<url>/.well-known/opencode` remote config.
- Console account org config.
- `opencode github` / `pr` commands.

## 7. Offline runs (container `--network none`) [RUN]

| # | Setup | Result |
|---|---|---|
| O1 | Fresh HOME, no flags | Works: write + permission + delete, first prompt idle after 2.7 s. The log shows 2× ERROR "Failed to fetch models.dev" (non-fatal) and, **72 s after instance boot**, WARN "background dependency install failed … registry.npmjs.org … ECONNREFUSED" |
| O2 | All disable flags + `NPM_CONFIG_REGISTRY` → reachable 404 registry | Works; install WARN is immediate (fails fast) |
| O3 | `opencode run --format json` fresh HOME, no flags | Works, 4.4 s, exit 0 |
| O5/O9 | **Local plugin** `.opencode/plugins/hello.js`, no registry | **`POST /session` blocked for 71 s** until npm gave up, then succeeded. A client with a 60 s timeout fails |
| O6 | O5 + `OPENCODE_PURE=1` | Works, 3.5 s |
| O7 | O5 + reachable (404) registry | Works, 3.7 s (plugin loads, install WARN) |
| O8 | O5 with `package.json` + `package-lock.json` + `node_modules` **pre-copied** into `~/.config/opencode` and `.opencode/` | Works, 3.1 s, no install attempt |
| O10 | Provider `"npm":"@ai-sdk/deepseek"` (not bundled) via `OPENCODE_CONFIG_CONTENT` | Assistant message `error:{name:"UnknownError",data:{message:"Failed to initialize provider: fake2"}}`; registry log shows `GET /@ai-sdk%2fdeepseek` (`opencode-sample-offline-nonbundled-provider-error.json`) |
| O14 | O5 + `NPM_CONFIG_FETCH_RETRIES=0` | `POST /session` in 0.58 s |
| O15 | `grep`/`glob` tool, no `rg` on PATH | Log `downloading ripgrep url=https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz`; tool output `ripgrep execution failed`. Still failing after adding rg until a **server restart** (failure cached) |
| O16 | `rg` placed at `~/.cache/opencode/bin/rg` (or on PATH [SRC `core/src/ripgrep/binary.ts:94`]) + restart | grep → `Found 1 matches`, glob → `/work/proj/README.md` |

Samples: `opencode-sample-offline-events-write-permission.sse.txt`, `opencode-sample-offline-serve-errors.txt`.

## 8. Recommended air-gapped baseline

- **Registry.** Point npm at the internal proxy: `NPM_CONFIG_REGISTRY=https://nexus…/npm/` (or `~/.npmrc` of the service user), plus `NPM_CONFIG_FETCH_RETRIES=0` or a low value so failures are fast. As an alternative, pre-seed `node_modules` in `~/.config/opencode` (and in any `.opencode/` or `OPENCODE_CONFIG_DIR`) from an image, or run with `--pure` when no plugins are needed.
- **Models catalog.** Set `OPENCODE_DISABLE_MODELS_FETCH=1`, or `OPENCODE_MODELS_URL` pointing at an internal mirror.
- **Provider.** Use only bundled provider npm ids, for example `@ai-sdk/openai-compatible` for the internal gateway. Set `enabled_providers: ["<internal>"]`.
- **ripgrep.** Ship `rg` on PATH, installed through the internal apt/yum mirror.
- **Other switches.** Keep `share:"disabled"` and `autoupdate:false`. Set `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_SHARE=1` and `OPENCODE_DISABLE_LSP_DOWNLOAD=1` as belt-and-braces. Do not set `OPENCODE_DISABLE_EMBEDDED_WEB_UI`.
- **Admin policy.** Use `/etc/opencode/opencode.json` (managed config) for policy the admin enforces.

**E2E harness pattern for opencode-mcp CI:**
1. Build a `node:22` image with `opencode-ai@<pinned>`, `rg`, `fake-llm-server.mjs`, and a pre-seeded `~/.config/opencode/node_modules`.
2. Run it with `--network none`.
3. Spawn `opencode serve --port 0`.
4. Parse the `listening on` line.
5. Drive the session over HTTP with `CALL_TOOL` prompts, and assert on `/__requests` of the fake LLM.

## 9. Open or unverified

- The v2 `/api/session/{id}/prompt|wait|event|permission/...` routes (51 paths in `packages/sdk/openapi.json`) were not exercised.
- Per-session `permission` in `session.create` was not exercised.
- `continue_loop_on_deny` was not exercised.
- The effect of `OPENCODE_MODELS_URL`/`_PATH` was not tested at runtime.
- Behavior behind a firewall that silently drops packets, as opposed to the fast ECONNREFUSED/DNS failure seen with `--network none`, is untested. Stalls could be longer [INF].
- The startup-race hang root cause was not investigated. It was only observed and avoided.

## 10. Files

Committed under `docs/research/samples/` (with an `opencode-sample-` prefix on the sample files below):
- Scripts: `fake-llm-server.mjs`, `drive-session.mjs`
- Config: `opencode-sample-config.opencode.json`
- `opencode-sample-session-create.json`, `-prompt-sync-text-response.json`, `-prompt-sync-bash-after-permission.json`
- `opencode-sample-permission-asked-event.json`, `-permission-list.json`, `-permission-reply.json`
- `opencode-sample-messages-write.json`, `-messages-bash-reject.json`, `-session-delete.json`
- `opencode-sample-events-write-permission.sse.txt`, `-events-bash-reject.sse.txt`, `-offline-events-write-permission.sse.txt`
- `opencode-sample-run-json-text.txt`, `-run-json-write-auto.txt`, `-run-json-write-autoreject.txt`, `-run-json-attach.txt`, `-run-json-attach-write-autoreject.txt`
- `opencode-sample-llm-request-after-tool.json` (the chat-completions request structure OpenCode sends; long built-in texts — the system prompt and tool descriptions — are elided, see THIRD_PARTY_NOTICES.md), `-fake-llm-requests.txt`
- `opencode-sample-offline-nonbundled-provider-error.json`, `-offline-serve-errors.txt`

**Not retained:** `abort-test.mjs`, `logging-proxy.mjs`, `fake-registry.mjs`.
