// createLogger(level, sink) — structured stderr logging that never throws.
// Format: `<ISO time> <LEVEL> <msg> <json fields>`. See docs/design.md §3
// ("Never log credentials, Authorization headers, full env objects, or
// credential-bearing URLs") for why this redacts recursively.

import type { LogLevel, Logger } from './types.ts';

const LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Keys whose value is always fully redacted, regardless of type. */
const SENSITIVE_KEY_RE = /pass(word)?|authorization|token|secret|api[-_]?key|cookie/i;

/** Matches `<scheme>://<userinfo>@` inside any string, not just whole URLs. */
const URL_USERINFO_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/?#@]+)@/g;

function redactUrlUserinfo(value: string): string {
  return value.replace(URL_USERINFO_RE, '$1[REDACTED]@');
}

// `seen` tracks ancestors of the node currently being visited (added before recursing into its
// children, removed once its subtree is done), not every node ever visited — a shared reference
// between two sibling fields (or two elements of an array) is not an ancestor of itself, so it is
// rendered fully each time it is reached; only a true cycle (a node reachable from itself through
// its own descendants) is replaced by '[Circular]'.
function redactDeep(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'string') return redactUrlUserinfo(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactUrlUserinfo(value.message),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return value.map((v) => redactDeep(v, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redactDeep(v, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const seen = new Set<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redactDeep(v, seen);
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '"[unserializable]"';
  }
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createLogger(level: LogLevel, sink: (line: string) => void = defaultSink): Logger {
  const threshold = LEVEL_ORDER.indexOf(level);

  function emit(recordLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    try {
      if (LEVEL_ORDER.indexOf(recordLevel) < threshold) return;
      const time = new Date().toISOString();
      const safeMsg = redactUrlUserinfo(String(msg));
      const safeFields = redactFields(fields ?? {});
      const line = `${time} ${recordLevel.toUpperCase()} ${safeMsg} ${safeStringify(safeFields)}`;
      sink(line);
    } catch {
      // never throw
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
