// Streaming SSE parser for OpenCode's `/event` endpoint (docs/research/opencode-api.md §7).
//
// Wire format observed and specified: `data: <json>\n\n` (one event per blank-line-terminated
// block). This parser follows the relevant subset of the WHATWG EventSource field-parsing
// algorithm: lines are split on LF, an optional trailing CR is stripped (so both LF and CRLF
// line endings work); lines starting with `:` are comments and ignored; only the `data` field is
// used (unknown/other fields such as `event:`, `id:`, `retry:` are read and ignored, since OcEvent
// carries its own `id`/`type` inside the JSON payload); consecutive `data:` lines before a blank
// line are joined with "\n" (per spec); a blank line dispatches the accumulated data as one event.
//
// UTF-8 can be split across chunk boundaries (including mid-codepoint); we decode with
// `TextDecoder` in streaming mode (`{ stream: true }`) so partial multi-byte sequences are held
// internally by the decoder until the rest arrives, then flush it once the stream ends.

import type { OcEvent } from '../types.ts';

// A6: default cap on a single SSE event's accumulated `data:` payload (and on any single
// unterminated line still sitting in the internal buffer), so a misbehaving or compromised
// upstream cannot grow either without bound. 1 MiB comfortably covers any real OpenCode event
// (tool output embedded in an event is already bounded upstream of this).
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

function parsePayload(raw: string): OcEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return null;
  }
  const properties =
    typeof obj.properties === 'object' && obj.properties !== null
      ? (obj.properties as Record<string, unknown>)
      : {};
  const id = typeof obj.id === 'string' ? obj.id : undefined;
  return { id, type: obj.type, properties };
}

/**
 * Parses a raw SSE byte stream into OpenCode events. Skips payloads that are not valid JSON, and
 * JSON payloads that lack a string `type` field. Never throws on malformed input; propagates
 * errors from reading `body` itself (network failures).
 *
 * A6: `maxEventBytes` (default DEFAULT_MAX_EVENT_BYTES) bounds both (a) a single line that never
 * terminates with `\n` (checked against the pending internal buffer — a still-growing line is
 * caught even before a newline ever arrives) and (b) one event's total accumulated `data:` content
 * across however many already-newline-terminated lines precede its dispatching blank line (reset
 * on every dispatch, so already-completed earlier events are never counted against a later one, or
 * vice versa). On overflow the reader is cancelled and an Error is thrown — the hub's existing
 * reconnect/backoff path (like any other stream failure) handles it from there.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  maxEventBytes: number = DEFAULT_MAX_EVENT_BYTES,
): AsyncIterable<OcEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];
  let dataBytes = 0;

  function handleLine(line: string): OcEvent | null {
    if (line.length === 0) {
      if (dataLines.length === 0) {
        return null;
      }
      const raw = dataLines.join('\n');
      dataLines = [];
      dataBytes = 0;
      return parsePayload(raw);
    }
    if (line.startsWith(':')) {
      // comment line; ignored
      return null;
    }
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }
    if (field === 'data') {
      // +1 accounts for the "\n" join separator between accumulated data lines, so the check
      // mirrors the actual joined payload size, not just the sum of each line's own bytes.
      dataBytes += Buffer.byteLength(value, 'utf8') + 1;
      if (dataBytes > maxEventBytes) {
        throw new Error(`SSE event exceeds ${maxEventBytes} bytes`);
      }
      dataLines.push(value);
    }
    // other fields (event, id, retry, ...) are recognized-but-unused per the SSE spec subset we
    // need; anything else is an unknown field and is likewise ignored.
    return null;
  }

  function consumeLinesFromBuffer(): OcEvent[] {
    const events: OcEvent[] = [];
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      const evt = handleLine(line);
      if (evt) {
        events.push(evt);
      }
    }
    return events;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const evt of consumeLinesFromBuffer()) {
        yield evt;
      }
      // Checked *after* draining every complete line out of `buffer`: a burst of many small,
      // already-complete, well-formed events arriving in one chunk must never be flagged just
      // because their combined size (before draining) exceeded the bound — only a single
      // still-unterminated line sitting in the remainder may trigger this.
      if (Buffer.byteLength(buffer, 'utf8') > maxEventBytes) {
        throw new Error(`SSE line exceeds ${maxEventBytes} bytes`);
      }
    }

    // Flush any pending multi-byte sequence held by the decoder, then process whatever is left
    // in the buffer as a final (possibly unterminated) line.
    buffer += decoder.decode();
    for (const evt of consumeLinesFromBuffer()) {
      yield evt;
    }
    if (buffer.length > 0) {
      let line = buffer;
      buffer = '';
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      const evt = handleLine(line);
      if (evt) {
        yield evt;
      }
    }
    // A stream that ends mid-event (no trailing blank line) still gets its accumulated data
    // dispatched, so a server-side close right after the last `data:` line is not silently lost.
    if (dataLines.length > 0) {
      const raw = dataLines.join('\n');
      dataLines = [];
      const evt = parsePayload(raw);
      if (evt) {
        yield evt;
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
