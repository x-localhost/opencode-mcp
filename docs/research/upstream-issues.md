# Upstream OpenCode issues found while building opencode-mcp

## U1 — An early abort poisons the whole directory instance (opencode-ai 1.18.33)

**Symptom.** After `POST /session/{id}/abort` lands while the first prompt of a directory
instance is still resolving its model, every later prompt in that directory fails immediately
with `UnknownError: Error: All fibers interrupted without error` (stack: `SessionPrompt.getModel`
→ `SessionRunState.ensureRunning` → `SessionPrompt.loop`), including prompts in **new**
sessions of the same directory, until the instance is disposed or the server restarts.

**Cause (source).** `Provider.getModel` reads per-directory state via `InstanceState.get(state)`
(`packages/opencode/src/provider/provider.ts:1894`), which is a lazily evaluated
`ScopedCache` lookup (`packages/opencode/src/effect/instance-state.ts`). The first lookup runs
inside the prompt runner fiber; the abort interrupts that fiber mid-lookup and the cache keeps
the interrupted `Exit`. `SessionPrompt.getModel` squashes it into the error above
(`packages/opencode/src/session/prompt.ts:594–611`). Provider initialization took about 1.3 s
in the fake-LLM setup, so the vulnerable window is real.

**Reproduction (2026-09-29, gram, docker `--network none`, fake OpenAI-compatible LLM).**
Script (not retained): create session → `prompt_async` → wait N ms → abort → prompt again;
then a new session B:

| Variant | A (same session) | B (new session) |
|---|---|---|
| no warm-up, abort after 0 ms (runner not yet started) | ok | ok |
| no warm-up, abort after 300 ms | **UnknownError** | **UnknownError** |
| no warm-up, abort after 700 ms | **UnknownError** | **UnknownError** |
| no warm-up, abort after 1500 ms (init finished) | ok | ok |
| `GET /provider?directory=` warm-up first, abort after 300 / 700 ms | ok | ok |
| poisoned, then `POST /instance/dispose?directory=` | ok | ok (and new session C ok) |

The e2e scenario `e` (cancel right after `wait-seconds: 0`, then reply) hit this reliably.

**Mitigation in opencode-mcp.**
1. Warm the directory instance (`OpencodeApi.warmInstance`: `GET /provider` + `GET /agent`)
   before every turn's submission, with a generous timeout and without the caller's cancellation
   signal. Concurrent warm-ups for the same directory and connection generation share one request;
   settled warm-ups are not cached because another client can dispose the instance between turns.
2. Recovery: when a turn fails with this signature, dispose the directory instance
   (`POST /instance/dispose?directory=`) in managed mode when no other turn owned by this process
   or in-flight abort/delete/archive mutation is active in that directory, and tell the caller to retry.
   If an active turn blocks disposal, record the pending poison and start recovery when it finishes;
   a new turn cannot dispatch until recovery succeeds. Idle quarantined siblings do not block disposal.
   Their execution state stays unknown until status/cancel observes terminal evidence.

Worth reporting upstream (anomalyco/opencode): lazily cached instance state should not cache
interruption exits.

## U2 — `format` (`json_schema`) makes message reads fail permanently (opencode-ai 1.18.33)

**Symptom.** After a prompt using `format: {type:"json_schema", ...}` completes, both `GET /session/{id}/message` and `GET /session/{id}/message/{userMessageID}` return HTTP 400: `Expected OutputFormatJsonSchema, got …`. The write succeeds, but message history reads remain broken for the session.

**Reproduction.** `docs/research/probe-features/repro-format-bug.mjs` submits a schema-formatted prompt and reads the message list and individual message routes. The probe reproduced the failure four times; see also [the feature probe](opencode-features-probe.md#headline-surprises).

**Impact and workaround.** opencode-mcp builds turn outcomes from message history, so the feature would prevent reliable result construction and later replies. The bridge never sends OpenCode's prompt `format`; it implements `output-schema` with per-turn instructions, extraction and validation instead. This workaround preserves the model response as untrusted output and does not claim OpenCode schema enforcement.

Worth reporting upstream (anomalyco/opencode): a successful JSON-schema prompt must not poison subsequent message reads.
