#!/usr/bin/env node
// Entry point: config -> logger -> connection -> engine -> serveStdio -> signal wiring
// (design.md §3 layout, §5.7 shutdown).
//
// All side effects live behind `main(deps?)` so tests can inject a stub engine/connection
// factory (and stub signal/stdin/exit sources) without touching the real modules or process.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio as sdkServeStdio } from '@modelcontextprotocol/server/stdio';

import type { Clock, Config, Connection, Engine, EngineDeps, Logger } from './types.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createMcpServerFactory } from './mcp/server.ts';
import { realClock } from './core/clock.ts';
import { createEngine as createRealEngine } from './core/engine.ts';
import { createConnection as createRealConnection } from './opencode/connection.ts';

export interface StdioHandleLike {
  close(): Promise<void>;
}

/** Returned by a `MainDeps.keepAlive` factory: `clear()` releases the ref'd handle. */
export interface KeepAliveHandle {
  clear(): void;
}

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clock?: Clock;
  /** Defaults to the real `createConnection` from ./opencode/connection.ts. */
  createConnection?: (config: Config, logger: Logger, clock: Clock) => Connection | Promise<Connection>;
  /** Defaults to the real `createEngine` from ./core/engine.ts. */
  createEngine?: (deps: EngineDeps) => Engine | Promise<Engine>;
  createServerFactory?: (engine: Engine, config: Config, logger: Logger) => () => McpServer;
  serveStdio?: (factory: () => McpServer) => StdioHandleLike;
  /** Source of SIGINT/SIGTERM/SIGHUP; defaults to the real `process`. */
  signals?: NodeJS.EventEmitter;
  /** Source of stdin 'end'/'close'; defaults to the real `process.stdin`. */
  stdin?: NodeJS.EventEmitter;
  /** Source of 'uncaughtException'/'unhandledRejection'; defaults to the real `process`. */
  errors?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
  writeStderr?: (line: string) => void;
  /**
   * Bound for engine.shutdown() before closing the transport anyway (design.md §5.7). Defaults to
   * `config.cleanupTimeoutMs + MANAGED_SIGTERM_GRACE_MS + SHUTDOWN_MARGIN_MS` (computed after
   * `loadConfig`, so it always fits the configured cleanup window plus the managed-mode
   * SIGTERM-grace sweep, instead of a fixed bound that can trip mid-cleanup for a larger
   * `OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS`).
   */
  shutdownTimeoutMs?: number;
  /**
   * Bound for connection.close() — always run after engine.shutdown, even if engine.shutdown
   * itself hung or never reached its own connection cleanup — covering SIGTERM -> grace ->
   * SIGKILL of a managed `opencode serve` process group. Defaults to config.cleanupTimeoutMs.
   */
  connectionCloseTimeoutMs?: number;
  /**
   * Creates a ref'd keep-alive handle when shutdown() starts, cleared just before exit(). Every
   * timer on the cleanup path (Clock.schedule) is unref'd, so in attach mode — no managed child
   * process to hold a ref'd handle — the event loop can otherwise drain between cleanup requests
   * and Node exits mid-shutdown. Defaults to a ref'd `setInterval(() => {}, 1000)`.
   */
  keepAlive?: () => KeepAliveHandle;
  /**
   * Source of process.stdout 'error' events; a no-op listener is attached so an EPIPE after the
   * client's pipe closes is inert instead of becoming an uncaughtException. Defaults to
   * `process.stdout`.
   */
  stdout?: NodeJS.EventEmitter;
  /** Same as `stdout`, for `process.stderr`. */
  stderr?: NodeJS.EventEmitter;
}

function defaultWriteStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function defaultExit(code: number): void {
  process.exit(code);
}

/** Managed mode's SIGTERM -> grace -> SIGKILL sweep (opencode/managed-server.ts's default
 * `graceMs`) that connection.close() may still need after engine.shutdown's own
 * cleanupTimeoutMs-bounded window ends (docs/design.md §5.7). */
const MANAGED_SIGTERM_GRACE_MS = 5000;
/** Extra margin so index.ts's own engine.shutdown() bound doesn't trip at the exact moment the
 * engine's internal cleanup deadline does. */
const SHUTDOWN_MARGIN_MS = 5000;

function defaultKeepAlive(): KeepAliveHandle {
  const timer = setInterval(() => {}, 1000);
  return { clear: () => clearInterval(timer) };
}

function noop(): void {}

/** True for a Node errno error carrying `code: 'EPIPE'` (write to a closed pipe, e.g. the
 * client's stdio after it dies) — inert, never a reason to shut down. */
function isEpipeError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EPIPE';
}

function withTimeout<T>(promise: Promise<T>, ms: number, clock: Clock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = clock.schedule(ms, () => reject(new Error(`timed out after ${ms}ms`)));
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (err: unknown) => {
        cancel();
        reject(err);
      },
    );
  });
}

export async function main(deps: MainDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const clock = deps.clock ?? realClock;
  const writeStderr = deps.writeStderr ?? defaultWriteStderr;
  const exit = deps.exit ?? defaultExit;

  let config: Config;
  try {
    config = loadConfig(env, cwd);
  } catch (err) {
    writeStderr(`opencode-mcp: ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
    return;
  }

  // Derived after loadConfig so a configured OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS above the old
  // fixed 20 s can no longer be truncated mid-cleanup: the engine's own cleanup deadline is
  // cleanupTimeoutMs (+ a small margin), followed by connection.close()'s managed-mode
  // SIGTERM -> grace -> SIGKILL sweep, so this bound must cover both.
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? config.cleanupTimeoutMs + MANAGED_SIGTERM_GRACE_MS + SHUTDOWN_MARGIN_MS;

  const logger = createLogger(config.logLevel);
  const connectionCloseTimeoutMs = deps.connectionCloseTimeoutMs ?? config.cleanupTimeoutMs;
  const keepAlive = deps.keepAlive ?? defaultKeepAlive;

  // A dead client pipe (e.g. Claude Code was killed) otherwise turns every subsequent write into
  // an EPIPE 'error' event with no listener, which Node re-raises as an uncaughtException.
  const stdoutSource = deps.stdout ?? process.stdout;
  const stderrSource = deps.stderr ?? process.stderr;
  stdoutSource.on('error', noop);
  stderrSource.on('error', noop);

  const connectionFactory = deps.createConnection ?? createRealConnection;
  const engineFactory = deps.createEngine ?? createRealEngine;
  const buildServerFactory = deps.createServerFactory ?? createMcpServerFactory;
  const serve = deps.serveStdio ?? ((factory: () => McpServer) => sdkServeStdio(factory));

  const connection = await connectionFactory(config, logger, clock);
  const engine = await engineFactory({ config, connection, logger, clock });

  const handle = serve(buildServerFactory(engine, config, logger));

  let shuttingDown = false;
  // Any engine or connection cleanup failure, or a fatal error, makes shutdown unsuccessful.
  let exitCode = 0;
  const shutdown = async (reason: string, opts: { forceExitCode?: number } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (opts.forceExitCode !== undefined) exitCode = opts.forceExitCode;
    // Every wait on this path (withTimeout here, plus the engine/hub/turn poll timers it awaits
    // transitively) rests on an unref'd Clock.schedule timer. In attach mode there is no managed
    // child to hold the event loop open, so between HTTP requests Node can otherwise drain the
    // loop and exit mid-shutdown. This ref'd handle is held for the duration and cleared just
    // before exit() below (design.md §5.7).
    const alive = keepAlive();

    // Managed mode's default onExit=abort: process exit is itself a stronger and faster
    // execution fence ('exited') than engine.shutdown()'s HTTP abort-POST-and-poll loop, which
    // can take up to ~cleanupTimeoutMs + a margin (design.md §5.7) per running turn. Start
    // terminating the managed process group in parallel with engine.shutdown() instead of only
    // after it settles, so a client SIGKILL arriving before that HTTP-based cleanup finishes
    // never orphans the child (P2 audit finding r2/g1). Turns still in flight when the group
    // dies settle through connection.close()'s synchronous lease drop -> engine.shutdown()'s
    // existing "OpenCode has no live lease" -> Turn.connectionLost() path (stopped), never as
    // completed. Attach mode has no process to kill (the order is moot), and onExit=end still
    // needs the server alive to delete/archive sessions, so both keep the original sequential
    // order (connection.close() only after engine.shutdown settles).
    const earlyClose =
      config.mode === 'managed' && config.onExit === 'abort'
        ? withTimeout(connection.close(), connectionCloseTimeoutMs, clock)
        : undefined;
    // `earlyClose` can settle (in particular, reject on its own timeout) well before the `await`
    // below ever reaches it — engine.shutdown() is awaited first, in program order. Without this,
    // a rejection landing in that window has no handler attached yet and surfaces as an
    // unhandledRejection, even though it IS still properly awaited/caught just below.
    earlyClose?.catch(() => {});

    try {
      await withTimeout(engine.shutdown(reason), shutdownTimeoutMs, clock);
    } catch (err) {
      exitCode = 1;
      logger.error('engine shutdown failed', { error: err instanceof Error ? err : String(err), reason });
    }
    // Always run connection.close() (idempotent) with its own bound, even if engine.shutdown
    // hung or never reached its own connection cleanup — otherwise a managed `opencode serve`
    // child (and its process group) can be orphaned once this process exits below. Reuses
    // `earlyClose` (already started above) instead of issuing a second, redundant call.
    try {
      await (earlyClose ?? withTimeout(connection.close(), connectionCloseTimeoutMs, clock));
    } catch (err) {
      logger.error('connection close failed', { error: err instanceof Error ? err : String(err), reason });
      exitCode = 1;
    }
    try {
      await handle.close();
    } catch (err) {
      logger.error('stdio handle close failed', { error: err instanceof Error ? err : String(err) });
    }
    alive.clear();
    exit(exitCode);
  };

  const errorsSource = deps.errors ?? process;
  const handleFatalError = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    // A no-op 'error' listener is attached to stdout/stderr above; this is a defensive second
    // layer in case an EPIPE reaches here by some other path — it must never trigger a shutdown.
    if (isEpipeError(err)) return;
    logger.error(kind, { error: err instanceof Error ? err : String(err) });
    if (shuttingDown) {
      exitCode = 1;
      return;
    }
    void shutdown(kind, { forceExitCode: 1 });
  };
  errorsSource.on('uncaughtException', (err: unknown) => handleFatalError('uncaughtException', err));
  errorsSource.on('unhandledRejection', (reason: unknown) => handleFatalError('unhandledRejection', reason));

  const signalSource = deps.signals ?? process;
  const stdinSource = deps.stdin ?? process.stdin;

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    signalSource.on(signal, () => {
      void shutdown(`signal:${signal}`);
    });
  }
  stdinSource.on('end', () => {
    void shutdown('stdin:end');
  });
  stdinSource.on('close', () => {
    void shutdown('stdin:close');
  });
}

// Guarded top-level side effect: only runs when this module is the process entry point, both
// under `node --test`-style type stripping and after esbuild bundles it to dist/opencode-mcp.mjs
// (there `import.meta.url` and `process.argv[1]` both point at the bundle file). `process.argv[1]`
// is resolved through `realpathSync` before comparing: `npm install -g` makes the `opencode-mcp`
// bin a symlink, the OS's shebang exec passes that *symlink* path as argv[1] unresolved, but
// Node's ESM loader resolves `import.meta.url` to the symlink's *real* target — without this
// realpath step the two never match, the guard never fires, and the installed CLI silently does
// nothing and exits (caught by the npm-pack packaging check, not by any in-repo test, since every
// other invocation path here uses a real file, never a symlink).
const entryArg = process.argv[1];
if (entryArg !== undefined) {
  let resolvedEntry: string;
  try {
    resolvedEntry = realpathSync(entryArg);
  } catch {
    resolvedEntry = entryArg;
  }
  if (import.meta.url === pathToFileURL(resolvedEntry).href) {
    void main();
  }
}
