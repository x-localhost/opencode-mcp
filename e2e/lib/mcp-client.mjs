// Dependency-free newline-delimited JSON-RPC stdio client for the MCP legacy handshake
// (2025-11-25), shaped to match how Claude Code talks to a stdio server
// (docs/research/mcp-client.md §3): initialize with protocolVersion "2025-11-25" and
// capabilities {elicitation:{form:{}}, roots:{listChanged:true}}, then
// notifications/initialized.
//
// No third-party deps: only node:child_process, node:readline, node:fs, node:url.
//
// Usage:
//   import { McpClient } from './lib/mcp-client.mjs';
//   const client = await McpClient.connect({ cwd, env });
//   const result = await client.callTool('opencode', { prompt: 'WRITE_FILE' }, {
//     onProgress: (p) => console.log(p),
//   });
//   await client.close();
//
// Server command resolution (in priority order):
//   1. opts.command / opts.args, given explicitly.
//   2. env E2E_SERVER_CMD, a full shell-ish command string (simple quoting supported).
//   3. `node <opts.serverPath>`, where serverPath defaults to the repo's bundle,
//      resolved relative to this file: ../../dist/opencode-mcp.mjs.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_SERVER_PATH = fileURLToPath(new URL('../../dist/opencode-mcp.mjs', import.meta.url));
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_CLIENT_CAPABILITIES = { elicitation: { form: {} }, roots: { listChanged: true } };

/** Very small shell-word splitter: supports single/double quotes, no escapes beyond that. */
function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function resolveSpawnSpec(opts) {
  if (opts.command) {
    return { command: opts.command, args: opts.args ?? [] };
  }
  const envCmd = process.env.E2E_SERVER_CMD;
  if (envCmd) {
    const parts = splitCommand(envCmd);
    return { command: parts[0], args: parts.slice(1) };
  }
  const serverPath = opts.serverPath ? path.resolve(opts.serverPath) : DEFAULT_SERVER_PATH;
  return { command: 'node', args: [serverPath] };
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.command] explicit command (overrides E2E_SERVER_CMD/default)
   * @param {string[]} [opts.args]
   * @param {string} [opts.serverPath] path to the server entry (default: dist/opencode-mcp.mjs)
   * @param {string} [opts.cwd] child process cwd
   * @param {Record<string,string>} [opts.env] merged over process.env
   * @param {object} [opts.clientInfo]
   * @param {object} [opts.capabilities] overrides DEFAULT_CLIENT_CAPABILITIES
   * @param {string[]} [opts.roots] uris answered for a server-initiated roots/list
   */
  constructor(opts = {}) {
    const { command, args } = resolveSpawnSpec(opts);
    this.command = command;
    this.args = args;
    this.clientInfo = opts.clientInfo ?? { name: 'opencode-mcp-e2e-client', version: '0.1.0' };
    this.capabilities = opts.capabilities ?? DEFAULT_CLIENT_CAPABILITIES;
    this.roots = opts.roots ?? [];

    this._nextRequestId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._progressHandlers = new Map(); // token -> onProgress
    this.notifications = [];
    this.stderr = '';
    this.exitCode = null;
    this.exitSignal = null;
    this.unhandledElicitations = [];
    this._elicitationHandler = async () => {
      this.unhandledElicitations.push(Date.now());
      return { action: 'cancel' };
    };

    this.child = spawn(this.command, this.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;

    this._exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        resolve({ code, signal });
        // Any exit (crash, placeholder entry point, deliberate shutdown, ...) must not leave a
        // pending request hanging until its own timeout (or forever, if none was given): fail
        // fast with a clear message instead.
        if (this._pending.size > 0) {
          this._rejectAllPending(new Error(`server process exited (code=${code}, signal=${signal}) with a request still pending`));
        }
      });
    });

    this._rlOut = createInterface({ input: this.child.stdout });
    this._rlOut.on('line', (line) => this._onLine(line));

    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });

    this.child.on('error', (err) => {
      // Reject every still-pending request so callers never hang on a spawn failure.
      this._rejectAllPending(new Error(`server process error: ${err.message}`));
    });

    this._closed = false;
  }

  /** Spawns the server and performs the legacy initialize handshake. */
  static async connect(opts = {}) {
    const client = new McpClient(opts);
    await client._handshake(opts.initializeTimeoutMs ?? 20_000);
    return client;
  }

  /** Overrides how server -> client `elicitation/create` requests are answered.
   * `handler(request)` receives `{message, requestedSchema, mode?, ...}` and must
   * return an ElicitResult-shaped object (e.g. `{action:'accept', content:{...}}`,
   * `{action:'decline'}`, `{action:'cancel'}`), or throw to make the client answer
   * with a JSON-RPC error instead of a result (simulates a broken/erroring client). */
  setElicitationHandler(handler) {
    this._elicitationHandler = handler;
  }

  async _handshake(timeoutMs) {
    const result = await this._sendRequest(
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: this.capabilities,
        clientInfo: this.clientInfo,
      },
      { timeoutMs },
    );
    this.serverInfo = result?.serverInfo;
    this.serverCapabilities = result?.capabilities;
    this.protocolVersion = result?.protocolVersion;
    this.instructions = result?.instructions;
    this._writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return result;
  }

  _writeMessage(msg) {
    if (this._closed || this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  _nextId() {
    return this._nextRequestId++;
  }

  _sendRequest(method, params, { id, timeoutMs } = {}) {
    const reqId = id ?? this._nextId();
    const promise = new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this._pending.delete(reqId);
          // Best-effort: tell the server we are no longer interested (mirrors a real
          // client's timeout behaviour, docs/research/mcp-client.md §3.3).
          this.cancel(reqId, 'client-timeout');
          reject(new TimeoutError(`request ${method} (id=${reqId}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this._pending.set(reqId, { resolve, reject, timer });
    });
    this._writeMessage({ jsonrpc: '2.0', id: reqId, method, params });
    promise.requestId = reqId;
    return Object.assign(promise, { requestId: reqId });
  }

  /** Generic JSON-RPC request (rarely needed directly; prefer callTool/listTools). */
  request(method, params, opts) {
    return this._sendRequest(method, params, opts);
  }

  async listTools() {
    return this._sendRequest('tools/list', {});
  }

  /**
   * @param {string} name
   * @param {object} args
   * @param {object} [opts]
   * @param {number|string} [opts.progressToken] explicit token; default = the request id when onProgress is set
   * @param {(params: object) => void} [opts.onProgress]
   * @param {number} [opts.timeoutMs]
   * @param {(id:number) => void} [opts.onRequestId] called synchronously with the JSON-RPC request id,
   *   before any I/O completes — use this to capture the id for a later `cancel()` (scenario f/g).
   */
  callTool(name, args, opts = {}) {
    const id = this._nextId();
    if (opts.onRequestId) opts.onRequestId(id);
    let token = opts.progressToken;
    if (token === undefined && opts.onProgress) token = id;
    const meta = token !== undefined ? { progressToken: token } : undefined;
    if (opts.onProgress && token !== undefined) {
      this._progressHandlers.set(token, opts.onProgress);
    }
    const promise = this._sendRequest(
      'tools/call',
      { name, arguments: args, _meta: meta },
      { id, timeoutMs: opts.timeoutMs },
    );
    const cleanup = () => {
      if (opts.onProgress && token !== undefined) this._progressHandlers.delete(token);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  /** Sends notifications/cancelled for a previously issued request id. */
  cancel(requestId, reason) {
    this._writeMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } });
  }

  /** Sends SIGINT/SIGTERM/etc to the child (for shutdown-signal scenarios). */
  kill(signal = 'SIGTERM') {
    this.child.kill(signal);
  }

  /** Resolves once the child has exited, or rejects after timeoutMs. */
  async waitForExit(timeoutMs = 20_000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`server did not exit within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this._exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends stdin (as Claude Code does on normal shutdown) without killing the process. */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // already closed; ignore.
    }
  }

  /** close() + wait for exit, killing the process if it does not exit in time. */
  async closeAndWait(timeoutMs = 20_000) {
    this.close();
    try {
      return await this.waitForExit(timeoutMs);
    } catch (err) {
      this.kill('SIGKILL');
      throw err;
    } finally {
      this._rejectAllPending(new Error('client closed'));
    }
  }

  _rejectAllPending(err) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this._pending.delete(id);
    }
  }

  _respond(id, result) {
    this._writeMessage({ jsonrpc: '2.0', id, result });
  }

  _respondError(id, code, message) {
    this._writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async _handleServerRequest(msg) {
    if (msg.method === 'elicitation/create') {
      try {
        const result = await this._elicitationHandler(msg.params ?? {});
        this._respond(msg.id, result);
      } catch (err) {
        this._respondError(msg.id, -32000, err?.message ?? String(err));
      }
      return;
    }
    if (msg.method === 'roots/list') {
      this._respond(msg.id, { roots: this.roots.map((uri) => ({ uri })) });
      return;
    }
    if (msg.method === 'ping') {
      this._respond(msg.id, {});
      return;
    }
    this._respondError(msg.id, -32601, `e2e mcp-client: no handler for server-initiated method ${msg.method}`);
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.notifications.push({ type: '__unparseable_line__', line, error: String(err) });
      return;
    }

    // Response to a request we sent (has an id we are tracking, and result/error, no method).
    if (msg.method === undefined && msg.id !== undefined) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        if ('error' in msg) {
          const err = new Error(msg.error?.message ?? 'MCP error');
          err.code = msg.error?.code;
          err.data = msg.error?.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server -> client request (has id and method): elicitation/create, roots/list, ...
    if (msg.method !== undefined && msg.id !== undefined) {
      this._handleServerRequest(msg);
      return;
    }

    // Notification (has method, no id).
    if (msg.method !== undefined) {
      this.notifications.push(msg);
      if (msg.method === 'notifications/progress') {
        const token = msg.params?.progressToken;
        const handler = this._progressHandlers.get(token);
        if (handler) handler(msg.params);
      }
      return;
    }
  }
}

export { TimeoutError };
