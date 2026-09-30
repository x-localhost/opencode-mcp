import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSse } from '../../src/opencode/sse.ts';
import { streamFromBytes, streamFromChunks, utf8 } from './support/streams.ts';

import type { OcEvent } from '../../src/types.ts';

async function collect(body: ReadableStream<Uint8Array>, maxEventBytes?: number): Promise<OcEvent[]> {
  const events: OcEvent[] = [];
  for await (const evt of parseSse(body, maxEventBytes)) {
    events.push(evt);
  }
  return events;
}

const SAMPLE_PATH = fileURLToPath(
  new URL('../../docs/research/samples/opencode-sample-events-write-permission.sse.txt', import.meta.url),
);

test('parses a real sample file (single chunk)', async () => {
  const bytes = readFileSync(SAMPLE_PATH);
  const events = await collect(streamFromBytes(new Uint8Array(bytes), bytes.length));

  // The sample has 46 `data:` lines each terminated by a blank line (see wc -l / grep -c checks
  // done during research), so 46 events are expected, none dropped or duplicated.
  assert.equal(events.length, 46);
  assert.equal(events[0]?.type, 'server.connected');
  assert.deepEqual(events[0]?.properties, {});
  assert.equal(events[0]?.id, 'evt_0ebf62255001Y43EHQ6x6xcvPw');

  const permissionAsked = events.find((e) => e.type === 'permission.asked');
  assert.ok(permissionAsked, 'expected a permission.asked event');
  assert.equal(permissionAsked?.properties.permission, 'edit');
  assert.deepEqual(permissionAsked?.properties.patterns, ['hello.txt']);

  const permissionReplied = events.find((e) => e.type === 'permission.replied');
  assert.equal(permissionReplied?.properties.reply, 'once');
});

test('parses the same real sample chunked at every byte boundary', async () => {
  const bytes = readFileSync(SAMPLE_PATH);
  const events = await collect(streamFromBytes(new Uint8Array(bytes), 1));

  assert.equal(events.length, 46);
  assert.equal(events[0]?.type, 'server.connected');
  const permissionAsked = events.find((e) => e.type === 'permission.asked');
  assert.ok(permissionAsked);
  assert.equal(permissionAsked?.properties.sessionID, 'ses_f1409dd9bffeJ0F34e4hipAuXj');
});

test('parses a second real sample (bash reject) in one chunk', async () => {
  const path = fileURLToPath(
    new URL('../../docs/research/samples/opencode-sample-events-bash-reject.sse.txt', import.meta.url),
  );
  const bytes = readFileSync(path);
  const events = await collect(streamFromBytes(new Uint8Array(bytes), bytes.length));

  assert.ok(events.length > 0);
  assert.equal(events[0]?.type, 'server.connected');
  const rejected = events.find((e) => e.type === 'permission.replied');
  assert.equal(rejected?.properties.reply, 'reject');
});

test('CRLF line endings are accepted', async () => {
  const text =
    'data: {"type":"a","properties":{"x":1}}\r\n\r\n' + 'data: {"type":"b","properties":{}}\r\n\r\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'a');
  assert.equal(events[1]?.type, 'b');
});

test('LF line endings are accepted', async () => {
  const text = 'data: {"type":"a","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'a');
});

test('multi-line data fields are joined with "\\n" before JSON parsing', async () => {
  // JSON split across two `data:` lines must be rejoined with a newline in between before
  // JSON.parse; splitting exactly between the array items below only round-trips correctly if
  // the join character is a bare "\n" (matching the SSE spec), not "" or " ".
  const text = 'data: {"type":"multi","properties":{"lines":[1,\ndata: 2]}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'multi');
  assert.deepEqual(events[0]?.properties.lines, [1, 2]);
});

test('comment lines are ignored', async () => {
  const text = ': keep-alive\n\ndata: {"type":"a","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'a');
});

test('unknown SSE fields (event, id, retry) are ignored, data still parsed', async () => {
  const text = 'event: message\nid: 5\nretry: 3000\ndata: {"type":"a","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'a');
  // the SSE `id:` field is distinct from the JSON payload's own `id`; it must not leak through.
  assert.equal(events[0]?.id, undefined);
});

test('unparsable JSON payloads are skipped without throwing', async () => {
  const text = 'data: not-json\n\ndata: {"type":"a","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'a');
});

test('payloads without a string `type` are skipped', async () => {
  const text = 'data: {"properties":{}}\n\ndata: {"type":42}\n\ndata: {"type":"a","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'a');
});

test('heartbeat-shaped unknown event types are still yielded (unknown types tolerated)', async () => {
  const text = 'data: {"id":"evt_1","type":"server.heartbeat","properties":{}}\n\n';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'server.heartbeat');
});

test('a stream that ends without a trailing blank line still dispatches the pending event', async () => {
  const text = 'data: {"type":"a","properties":{}}\n\ndata: {"type":"b","properties":{}}';
  const events = await collect(streamFromBytes(utf8(text), text.length));
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, 'b');
});

test('a multi-byte UTF-8 character split across a chunk boundary decodes correctly', async () => {
  // "café 커피" mixes a 2-byte and 3-byte UTF-8 sequence; chunking at every single byte forces
  // the decoder to hold partial code units across `reader.read()` calls.
  const text = 'data: {"type":"a","properties":{"text":"café 커피"}}\n\n';
  const bytes = utf8(text);
  const events = await collect(streamFromBytes(bytes, 1));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.properties.text, 'café 커피');
});

test('multiple events split arbitrarily across chunk boundaries (not aligned to lines)', async () => {
  const text =
    'data: {"type":"a","properties":{"n":1}}\n\ndata: {"type":"b","properties":{"n":2}}\n\n' +
    'data: {"type":"c","properties":{"n":3}}\n\n';
  const bytes = utf8(text);
  // split into a few uneven chunks that land mid-line
  const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 23), bytes.subarray(23, 50), bytes.subarray(50)];
  const events = await collect(streamFromChunks(chunks));
  assert.deepEqual(
    events.map((e) => e.properties.n),
    [1, 2, 3],
  );
});

test('an empty stream yields no events', async () => {
  const events = await collect(streamFromChunks([]));
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// A6: streaming byte limits (line/event size)
// ---------------------------------------------------------------------------

/** A stream that emits `chunks` in order and records whether/how it was cancelled, so overflow
 * tests can prove `parseSse` actually stops consuming instead of draining the rest anyway. */
function trackedStream(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: { called: boolean; reason?: unknown } } {
  const cancelled: { called: boolean; reason?: unknown } = { called: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
    cancel(reason) {
      cancelled.called = true;
      cancelled.reason = reason;
    },
  });
  return { stream, cancelled };
}

test('a single line that never terminates with a newline, exceeding the configured limit, is rejected and the reader is cancelled', async () => {
  // No trailing "\n": the whole thing sits unconsumed in the internal buffer, exercising the
  // "unterminated line" bound directly, not the per-event accumulated-data-lines one below.
  const text = `data: ${'x'.repeat(200)}`;
  const { stream, cancelled } = trackedStream([utf8(text)]);
  await assert.rejects(collect(stream, 50), /exceeds 50 bytes/);
  assert.equal(cancelled.called, true);
});

test('many small data lines whose accumulated total exceeds the event-byte limit are rejected before the blank line ever arrives', async () => {
  // Ten small, individually-tiny, newline-terminated `data:` lines that together exceed the cap —
  // must not be missed just because no single line is large.
  const lines = Array.from({ length: 10 }, (_, i) => `data: chunk-${i}\n`).join('');
  const { stream, cancelled } = trackedStream([utf8(lines)]);
  await assert.rejects(collect(stream, 50), /exceeds 50 bytes/);
  assert.equal(cancelled.called, true);
});

test('a burst of many small, well-formed, complete events within one chunk is not falsely rejected even though their combined size exceeds the limit', async () => {
  // Five complete (blank-line-terminated) events in a single chunk, each individually well under
  // the cap; their combined size exceeds it. Only a single event's own size may ever trigger the
  // limit, never the backlog of already-dispatched events.
  const text = Array.from({ length: 5 }, (_, i) => `data: {"type":"a","properties":{"n":${i}}}\n\n`).join('');
  const { stream } = trackedStream([utf8(text)]);
  const events = await collect(stream, 40);
  assert.equal(events.length, 5);
});

test('the default event-byte limit rejects an oversized event without the caller specifying one', async () => {
  const text = `data: ${'x'.repeat(2 * 1024 * 1024)}\n\n`;
  const { stream, cancelled } = trackedStream([utf8(text)]);
  await assert.rejects(collect(stream), /exceeds \d+ bytes/);
  assert.equal(cancelled.called, true);
});
