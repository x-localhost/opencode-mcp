# OpenCode 1.18.33 feature probe (2026-09-30, gram, docker `--network none`, fake LLM)

Scripts: `docs/research/probe-features/{probe,fake-llm-server-ext,repro-format-bug,repro-worktree-uncommitted}.mjs` (run on gram inside `ocmcp-e2e:local`). Raw evidence (request dumps, SSE, per-question JSON) is not published.

## Headline surprises
1. Using `format` (json_schema) on any prompt makes `GET /session/{id}/message` (list) and `GET /session/{id}/message/{userMessageID}` fail permanently with HTTP 400 `Expected OutputFormatJsonSchema, got {...}` (read-side decoder bug; the write succeeds). `GET .../message/{assistantMessageID}` still works. Reproduced 4x.
2. Structured-output validation is shallow: a tool call missing a required field is stored verbatim (`finish:"tool-calls"`, no error, 1 LLM call). `retryCount` default is 2 but none of the tested failure modes triggered a retry.
3. `GET /session/{id}/diff` without `messageID` always returns `[]`; `session.summary` stays `{0,0,0}`; `session.diff` SSE events carry `diff: []`. Only `?messageID=<turn's USER message id>` returns the per-turn diff.
4. A tool-calling turn produces two assistant messages (tool call + wrap-up). Structured-output turns produce exactly one.

## Per question
- Q1 structured output: injected tool `StructuredOutput` with `parameters` = the schema, `tool_choice:"required"`, one system line appended. Does not persist to the next prompt. No tool call -> `error:{name:"StructuredOutputError", retries:0}`, `finish:"stop"`.
- Q2 per-turn diff: use the turn's user message id; bash-created files are included.
- Q3 todos: tool `todowrite` `{todos:[{content,status,priority}]}`, allowed for the default `build` agent, denied for `general`; `todo.updated` SSE carries the full list; `GET /session/{id}/todo` works.
- Q4 revert: removes/restores only the files in the reverted turn's diff (clobbering external edits to those files); reverted messages remain listed until a new prompt is sent, then they are dropped and `/unrevert` returns 200 but cannot restore them.
- Q5 worktree: created under `$XDG_DATA_HOME/opencode/worktree/<projectHash>/<name>`, branch `opencode/<name>`; sessions work in it; DELETE removes dir and branch; uncommitted/untracked changes are NOT carried into the new worktree.
- Q6 fork: fork at a user message id keeps messages strictly before it (new ids); the fork shares the parent's directory.
- Q7 discovery: `GET /agent` has `mode: primary|subagent|all` and `hidden`; `GET /provider` models have `capabilities.toolcall` and `status:"active"`; `apiKey` appears in provider config and must be redacted by the bridge.

## Implications for opencode-mcp
- Do not send OpenCode `format` while result building depends on the message list: it bricks the session's history reads. An `output-schema` feature must be implemented bridge-side (instructions + extraction + validation) or wait for an upstream fix.
- Per-turn diff = `GET /session/{id}/diff?messageID=<turn user message id>`; the bridge must record each turn's user message id (it already records the submitted user id for evidence).
- Revert is destructive for external edits and becomes irreversible after the next prompt: gate it (explicit confirm flag, only the latest turn, no running turn).
- OpenCode worktrees do not carry uncommitted work; a bridge-side worktree feature must say so or use its own `git worktree add` from a chosen base ref.
