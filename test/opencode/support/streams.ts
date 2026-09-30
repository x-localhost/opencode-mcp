// Test-only helpers for building ReadableStream<Uint8Array> sources with controlled chunking.

/** One ReadableStream that emits `bytes` split into `chunkSize`-byte pieces (last piece may be shorter). */
export function streamFromBytes(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be positive');
  }
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** One ReadableStream that emits each provided chunk as-is, in order. */
export function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
