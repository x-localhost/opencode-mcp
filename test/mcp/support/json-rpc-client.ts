// A minimal, dependency-free newline-delimited JSON-RPC client for driving a spawned MCP stdio
// server directly, the way Claude Code does on the legacy (2025-11-25) handshake era. No MCP
// client library is used on purpose (design.md §9 / this unit's test plan).

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface NotificationMessage {
  method: string;
  params: unknown;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class JsonRpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/** Legacy (2025-11-25) capabilities Claude Code declares by default over stdio. */
export const CLAUDE_CODE_LEGACY_CAPABILITIES = {
  elicitation: { form: {} },
  roots: { listChanged: true },
};

export class JsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private serverRequestHandler: ((req: ServerRequest) => void) | undefined;

  readonly notifications: NotificationMessage[] = [];
  /** Every raw line seen on stdout, whether or not it parsed as JSON-RPC. */
  readonly rawStdoutLines: string[] = [];
  readonly stderrLines: string[] = [];

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdoutData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.length > 0) this.stderrLines.push(line);
      }
    });
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');
      if (line.trim().length === 0) continue;
      this.rawStdoutLines.push(line);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // recorded in rawStdoutLines regardless, for the "stdout is pure JSON-RPC" check
    }
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const id = msg.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if ('error' in msg) {
        const err = msg.error as { code: number; message: string; data?: unknown };
        entry.reject(new JsonRpcError(err.code, err.message, err.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if ('id' in msg && 'method' in msg) {
      this.serverRequestHandler?.({ id: msg.id as number | string, method: msg.method as string, params: msg.params });
      return;
    }
    if ('method' in msg) {
      this.notifications.push({ method: msg.method as string, params: msg.params });
    }
  }

  /** Handles server-initiated requests, e.g. `elicitation/create`. Only one handler at a time. */
  onServerRequest(handler: (req: ServerRequest) => void): void {
    this.serverRequestHandler = handler;
  }

  private writeLine(frame: unknown): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params?: unknown): { id: number; result: Promise<unknown> } {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.writeLine({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return { id, result };
  }

  notify(method: string, params?: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Responds to a server-initiated request (e.g. answers `elicitation/create`). */
  respond(id: number | string, result: unknown): void {
    this.writeLine({ jsonrpc: '2.0', id, result });
  }

  /** Responds to a server-initiated request with a JSON-RPC error. */
  respondError(id: number | string, code: number, message: string): void {
    this.writeLine({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** U05: lets a test connect with arbitrary (e.g. empty, no-elicitation) capabilities instead of
   *  the hardcoded legacy set below. */
  async initialize(capabilities: Record<string, unknown>): Promise<unknown> {
    const { result } = this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities,
      clientInfo: { name: 'ocmcp-test-client', version: '0.0.0' },
    });
    const initResult = await result;
    this.notify('notifications/initialized');
    return initResult;
  }

  async initializeLegacy(): Promise<unknown> {
    return this.initialize(CLAUDE_CODE_LEGACY_CAPABILITIES);
  }

  async callTool(name: string, args: Record<string, unknown>, progressToken?: number | string): Promise<unknown> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (progressToken !== undefined) params._meta = { progressToken };
    const { result } = this.request('tools/call', params);
    return result;
  }

  /** Like `callTool`, but also returns the request id before awaiting the response. */
  callToolAsync(
    name: string,
    args: Record<string, unknown>,
    progressToken?: number | string,
  ): { id: number; result: Promise<unknown> } {
    const params: Record<string, unknown> = { name, arguments: args };
    if (progressToken !== undefined) params._meta = { progressToken };
    return this.request('tools/call', params);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
