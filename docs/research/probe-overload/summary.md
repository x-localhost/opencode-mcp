# Real-binary overload probe (opencode-ai 1.18.33, gram, --network none, fake overloaded LLM) — observed
Each directive: raw drive (direct HTTP/SSE to opencode serve) + bridged drive (opencode-mcp 0.2.0 bundle, attach mode, opencode then opencode-reply). Evidence (subset): `docs/research/probe-overload/samples.json` covers directives 1b, 3, 4, 5, 7, 8, 9 and 11; the other rows' raw output was not retained.

| # | LLM behaviour | OpenCode | opencode-mcp 0.2.0 | Problem |
|---|---|---|---|---|
| 1a | 429 + Retry-After:2 once, then OK | 2 calls, 1 session.status{retry}, idle 4.6 s | completed, correct answer | no |
| 1b | 429 + Retry-After:2 always | 6 calls (5 retries), gives up, idle 10.6 s | failed APIError, session replyable | no (Retry-After honoured per attempt, 5-attempt cap kept) |
| 2a | 503 once | 2 calls, idle 2.6 s | completed | no |
| 2b | 529 always | 6 calls, backoff 2/4/8/16/30 s, idle 70.9 s | failed APIError after 68 s; replyable | blocking call waits ~71 s with no visible retry state |
| 3 | 200 stream with only [DONE] (no content, no finish_reason) | NO backoff/no cap: 224 calls in 30 s (~7.5 req/s), new assistant message each time, never idle | status timeout only when timeout-seconds expires (then aborts); 237 gateway calls | YES: runaway loop amplifies gateway overload until the turn timeout (default 1 h) |
| 4 | empty content + finish stop | 1 call, finish stop | completed, content "OpenCode finished without a text answer…", answerChars 0 | status completed for an empty answer |
| 5 | whitespace-only content + stop | 1 call | completed, content "   \n\t  ", no error | YES: meaningless answer reported as success |
| 6 | stream cut mid-way (socket destroyed) | 5 retries with backoff, APIError "Connection reset by server" (ECONNRESET, isRetryable) after 65.9 s | failed APIError, partial output, replyable | no (slow) |
| 7 | one malformed SSE data line then valid chunks | 1 call, no retry, UnknownError, idle 321 ms | failed UnknownError | generic hint; not retried by OpenCode |
| 8 | 200 text/html body | NO backoff/no cap: 624 calls in 90 s (~6.9 req/s), never idle | timeout only at timeout-seconds; 444 gateway calls | YES: worst runaway loop |
| 9 | tool call with invalid JSON args | NO backoff: 124 calls in 30 s, finish briefly tool-calls | timeout at timeout-seconds; toolCallCount 95 | YES: runaway loop |
| 10 | 40 s silent first byte then normal | 1 call, idle 40.6 s | completed | no |
| 11 | partial text + finish length | 1 call, finish length | completed with the cut-off text, no warning | YES: truncated answer reported as clean success |
Also: opencode-mcp never hung beyond its own timeout and never left a session quarantined in these runs; the runaway loops stop only when opencode-mcp's turn timeout aborts the session.
