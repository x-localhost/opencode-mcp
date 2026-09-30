// Spawns and supervises a private `opencode serve` child process (design.md §5.1, F15, F16, G21).
//
// mDNS-off flag: verified empirically on gram against real opencode-ai@1.18.33
// (`opencode serve --help`): `--mdns` is a yargs boolean flag, default `false`
// (`[boolean] [default: false]`), so mDNS is already off unless something enables it. Passing
// `--mdns=false` explicitly was accepted and the server started normally (confirmed: `opencode
// serve --hostname 127.0.0.1 --port <p> --mdns=false` printed the expected "listening on" line
// and answered `/global/health` with 200). We still pass it explicitly (belt-and-braces against
// a config file or env flipping the default — see F15/G21: `server.mdns` config can change the
// default hostname to 0.0.0.0), since it is accepted and harmless.

import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import type { Config, Logger } from '../types.ts';

export interface ManagedServer {
  url: string;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(graceMs?: number): Promise<void>;
}

export interface StartManagedServerOptions {
  bin: string;
  serveArgs: string[];
  cwd: string;
  env: Record<string, string>;
  startupTimeoutMs: number;
  logger: Logger;
  /** Aborts a pending startup: the spawned child (if any) is killed immediately (SIGTERM -> grace
   * -> SIGKILL of its process group) and the returned promise rejects promptly, instead of only
   * failing once startupTimeoutMs naturally elapses. Lets a concurrent close() reclaim a
   * mid-startup child right away (review finding: an un-cancellable startup left close() with
   * nothing to do until the full startup timeout ran out). */
  signal?: AbortSignal;
}

const MDNS_OFF_ARGS = ['--mdns=false'];
const MAX_STDERR_LINES = 20;
/** Per-line cap for both the stdout and stderr readers (critic Q2: an unbounded newline-less
 * write from a plugin/tool inside `opencode serve` must never grow this process's memory without
 * bound). Applies before AND after readiness — the same reader instance is kept alive for the
 * child's whole life (r1-connection-managed-3). */
const MAX_LINE_BYTES = 64 * 1024;

const WATCHDOG_PPID_ENV = 'OPENCODE_MCP_WATCHDOG_PPID';
const WATCHDOG_SHELL = '/bin/sh';

// P2 audit finding (r2/g1): `detached: true` alone gives the managed child its own process
// group, but nothing makes it exit when opencode-mcp itself is hard-killed (SIGKILL, OOM, a
// native crash) — every other termination path in this file (killGroup/terminateProcessGroup,
// the graceful shutdown ordering in index.ts) only ever runs from opencode-mcp's own
// still-running code. The fix: the real `opencode serve` binary is never spawned directly.
// Instead it runs under this tiny, constant POSIX sh watchdog, which stays the process-group
// LEADER (still spawned with detached:true below, so the existing group-kill/verification logic
// in this file needs no changes): it starts the real binary in the background, polls whether
// opencode-mcp (OPENCODE_MCP_WATCHDOG_PPID) is still alive, and terminates the child itself once
// the parent is confirmed gone. It also forwards TERM/INT/HUP to the child for a normal graceful
// stop (in addition to whatever direct group-wide signal the parent sends), and exits with the
// child's own status.
//
// This is the ONLY shell opencode-mcp ever spawns: its body is a fixed constant, never built
// from opts.bin/args (those flow in only as inert "$@" positional parameters — see the `spawn()`
// call below — and are never interpolated into the script text itself), and it is written in
// POSIX sh only (no bashisms) so it runs correctly under both dash (Linux) and the BSD /bin/sh
// (macOS).
const WATCHDOG_SCRIPT = `
set -u

"$@" &
child=$!

watch() {
  while kill -0 "$OPENCODE_MCP_WATCHDOG_PPID" 2>/dev/null; do
    sleep 5
  done
  # opencode-mcp is gone: nothing else will ever signal this child, so this watchdog is the only
  # thing standing between it and running forever.
  kill -TERM "$child" 2>/dev/null
  i=0
  while [ "$i" -lt 3 ]; do
    kill -0 "$child" 2>/dev/null || return 0
    sleep 1
    i=$((i + 1))
  done
  kill -KILL "$child" 2>/dev/null
}

watch &
watcher=$!

on_signal() {
  kill -TERM "$child" 2>/dev/null
}
trap on_signal TERM INT HUP
trap 'kill "$watcher" 2>/dev/null' 0

status=0
wait "$child"
status=$?
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done

exit "$status"
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Like `delay`, but the timer is ref'd (not unref'd) and cancellable: for a grace period inside a
 * real cleanup/shutdown chain that a caller genuinely awaits (killAndWait's grace race,
 * terminateProcessGroup's grace wait — both now reachable from connection.ts's close(), which
 * must actually observe them finishing). An unref'd timer can simply never fire if the process's
 * event loop has nothing else keeping it busy at that moment, silently hanging that await forever
 * instead of completing after its bound — the opposite of what a *bounded* grace period promises.
 * `cancel()` matters just as much as ref'ing: a ref'd timer that *loses* a `Promise.race` (e.g. the
 * child already exited well before the grace period) must be cleared, or it dangles ref'd for the
 * rest of its full duration for no reason, needlessly delaying process/test exit. */
function delayRef(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Finds a free loopback TCP port by briefly binding to port 0 and closing again (F15/G21: the
 * child must be given an explicit port, since `--port 0` tries 4096 first, not a random port). */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to determine a free port'));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

/** `groupOnly`: never fall back to signalling the bare pid on ESRCH/EPERM from the group-wide
 * signal — for callers that already know the direct child has been reaped (terminateProcessGroup's
 * post-exit sweep, r1-connection-managed-2): at that point `pid` is immediately reusable (POSIX
 * keeps a pid tied up only while its process group still has members), so a positive-pid fallback
 * could only ever land on an unrelated, since-recycled process. */
function killGroup(pid: number, signal: NodeJS.Signals, groupOnly = false): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH (already dead) or EPERM (never had a group) — nothing more to do.
    if (groupOnly) {
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // already dead; ignore.
    }
  }
}

const execFileAsync = promisify(execFile);

/** Parse `ps` without a shell; Z, Z+, etc. cannot execute further mutations. */
export function processGroupHasLiveMembersFromPs(output: string, pgid: number): boolean {
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || Number(fields[1]) !== pgid) continue;
    if (!fields[2]?.startsWith('Z')) return true;
  }
  return false;
}

/** A signal-0 probe checks existence; `ps` then distinguishes live members from zombies.
 * Conservative on probe failure: an unverified group is never considered gone. */
export async function processGroupGone(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 500,
    });
    const sawGroup = stdout.split('\n').some((line) => Number(line.trim().split(/\s+/)[1]) === pid);
    if (!sawGroup) {
      // The group may have vanished between signal-0 and `ps`; confirm that rather than
      // treating an empty/incomplete process table as proof of a safe fence.
      try { process.kill(-pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    return !processGroupHasLiveMembersFromPs(stdout, pid);
  } catch {
    return false;
  }
}

async function groupHasMembers(pid: number): Promise<boolean> {
  return !(await processGroupGone(pid));
}

async function killAndWait(
  pid: number | undefined,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  graceMs: number,
  /** True once the direct child is confirmed reaped (P3 audit findings r1-connection-managed-2 /
   * r2/g1, loc 99 & 168): re-checked at every killGroup call, not snapshotted once, since the
   * child can be reaped in between the initial SIGTERM and a later SIGKILL fallback. Once true,
   * `pid` is immediately reusable (its process group has emptied), so killGroup must never fall
   * back to signalling the bare pid — that could only ever land on an unrelated, since-recycled
   * process. */
  isReaped?: () => boolean,
): Promise<void> {
  if (pid === undefined) {
    // spawn never produced a valid pid (e.g. ENOENT) — nothing to signal. `exited` is already
    // settled in that case (see the 'error'/'close' handling in startManagedServer), so this
    // never hangs.
    await exited;
    return;
  }
  killGroup(pid, 'SIGTERM', isReaped?.() ?? false);
  // Race the *direct* child's own exit against the grace period, but always re-check group
  // membership afterwards regardless of which side of the race won: a descendant that ignores
  // SIGTERM can outlive the direct child, so the child exiting first must not skip the SIGKILL
  // sweep of whatever remains in the group.
  const grace = delayRef(graceMs);
  await Promise.race([exited, grace.promise]);
  grace.cancel(); // the child exiting first must not leave this ref'd timer dangling for graceMs.
  if (await groupHasMembers(pid)) {
    killGroup(pid, 'SIGKILL', isReaped?.() ?? false);
  }
  await exited;
}

export interface TerminateProcessGroupOptions {
  graceMs?: number;
  /** The direct child at `pid` is already known to have exited and been reaped (e.g. the caller
   * awaited its `exited` promise first): never fall back to signalling the bare pid on ESRCH
   * (r1-connection-managed-2 — that pid is immediately reusable once its group is empty, so the
   * fallback could only ever hit a recycled, unrelated process). */
  childReaped?: boolean;
}

/** Best-effort group-wide termination sweep (SIGTERM -> grace -> SIGKILL if anything remains),
 * for callers that only have a pid and no `exited` promise of their own to race against — e.g.
 * connection.ts cleaning up after the immediate child already exited unexpectedly, when a
 * descendant it spawned (a tool subprocess, say) may still be alive. Never throws. */
export async function terminateProcessGroup(pid: number, opts: TerminateProcessGroupOptions = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 5000;
  const groupOnly = opts.childReaped === true;
  // Probe first: if the group already has no members (the common post-crash case — the direct
  // child left no descendants behind), there is nothing to signal and no grace period worth
  // waiting out.
  if (!(await groupHasMembers(pid))) {
    return;
  }
  killGroup(pid, 'SIGTERM', groupOnly);
  await delayRef(graceMs).promise;
  if (await groupHasMembers(pid)) {
    killGroup(pid, 'SIGKILL', groupOnly);
  }
}

function redactSecret(line: string, secret: string | undefined): string {
  if (!secret) {
    return line;
  }
  return line.split(secret).join('[REDACTED]');
}

/** Newline-delimited reader with a per-line byte cap (critic Q2), used in place of
 * `readline.createInterface` for both the child's stdout and stderr. Unlike readline, which
 * buffers a partial line without bound until it sees '\n', this drops the overflow past
 * MAX_LINE_BYTES and keeps only the capped prefix as "the line" once the terminating '\n'
 * eventually arrives — memory stays bounded even if the child (or a plugin/tool it runs) writes
 * an arbitrarily large blob with no newline. A StringDecoder (not plain chunk.toString()) handles
 * multi-byte UTF-8 sequences split across chunk boundaries, matching readline's own robustness. */
function createLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): { close: () => void } {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let dropping = false;
  const onData = (chunk: Buffer): void => {
    const text = decoder.write(chunk);
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '\n') continue;
      if (!dropping) buf += text.slice(start, i);
      start = i + 1;
      let line = buf;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
      buf = '';
      dropping = false;
    }
    if (!dropping) {
      buf += text.slice(start);
      if (buf.length > MAX_LINE_BYTES) {
        buf = buf.slice(0, MAX_LINE_BYTES);
        dropping = true;
      }
    }
  };
  stream.on('data', onData);
  return {
    close: () => {
      stream.off('data', onData);
    },
  };
}

export async function startManagedServer(opts: StartManagedServerOptions): Promise<ManagedServer> {
  if (opts.signal?.aborted) {
    throw new Error('startup aborted before it began');
  }
  // r1-connection-managed-5: a stale/misconfigured OPENCODE_MCP_DEFAULT_CWD (or CLAUDE_PROJECT_DIR)
  // is never validated upstream in every code path, and libuv reports a missing spawn cwd with the
  // same ENOENT as a missing binary — surfacing as a misleading "failed to spawn opencode: spawn
  // <bin> ENOENT" that points the operator at the binary instead of the actual cwd. Check explicitly
  // first so the error names the real cause.
  let cwdStat;
  try {
    cwdStat = await stat(opts.cwd);
  } catch {
    cwdStat = undefined;
  }
  if (!cwdStat || !cwdStat.isDirectory()) {
    throw new Error(
      `managed OpenCode cwd does not exist or is not a directory: ${opts.cwd} (check OPENCODE_MCP_DEFAULT_CWD / CLAUDE_PROJECT_DIR)`,
    );
  }
  // An absolute opencodeBin is checked upfront for the same reason as cwd above: the watchdog
  // wrapper below (Fix P2/g1-1) always spawns successfully (it is `/bin/sh`, not `opts.bin`), so a
  // bad absolute bin path would otherwise only surface later, indirectly, as a generic sh "exited
  // before becoming ready" — this keeps the fast, actionable "failed to spawn opencode" error for
  // the common absolute-path misconfiguration. A bare/relative bin (e.g. the default "opencode",
  // meant to be resolved via PATH) is intentionally left to the watchdog's own `"$@"` exec, exactly
  // like a real shell would resolve it — this process does not duplicate PATH search logic.
  if (isAbsolute(opts.bin)) {
    try {
      await access(opts.bin, fsConstants.X_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'ENOENT';
      throw new Error(`failed to spawn opencode: spawn ${opts.bin} ${code}`);
    }
  }
  const port = await pickFreePort();
  const hostname = '127.0.0.1';
  const expectedUrl = `http://${hostname}:${port}`;
  const expectedLine = `opencode server listening on ${expectedUrl}`;
  const password = opts.env.OPENCODE_SERVER_PASSWORD;

  const args = ['serve', '--hostname', hostname, '--port', String(port), ...MDNS_OFF_ARGS, ...opts.serveArgs];

  // Spawn the watchdog (Fix P2/g1-1), not opts.bin directly: opts.bin and args reach the script
  // only as positional parameters ("$@") — see WATCHDOG_SCRIPT's own comment. `detached: true`
  // still makes the *watchdog* (sh) the process-group leader, so every existing group-kill /
  // verification helper in this file (killGroup, processGroupGone, terminateProcessGroup) keeps
  // working unchanged against `child.pid`.
  const watchdogEnv: Record<string, string> = { ...opts.env, [WATCHDOG_PPID_ENV]: String(process.pid) };
  const child = spawn(
    WATCHDOG_SHELL,
    ['-c', WATCHDOG_SCRIPT, 'opencode-mcp-watchdog', opts.bin, ...args],
    {
      cwd: opts.cwd,
      env: watchdogEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Synchronously observable once the watchdog (the direct child Node spawned) is confirmed
  // reaped — unlike `exited` itself (a Promise, whose `.then()` callbacks only ever run as a
  // microtask, never in the same tick as settlement). killAndWait needs this to decide, at the
  // exact moment it signals, whether `pid` might already be a recycled/reused pid (P3 audit
  // findings r1-connection-managed-2 / r2/g1, loc 99 & 168).
  let childExited = false;

  // A spawn failure (bad bin, ENOENT, EACCES, ...) emits 'error' and 'close' but — unlike a
  // process that actually started — never emits 'exit' and never gets a pid. Settling `exited`
  // from whichever of 'exit'/'close' fires first (instead of 'exit' alone) means a spawn failure
  // still resolves this promise, so callers awaiting it (killAndWait's final `await exited`) are
  // never left hanging forever.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      childExited = true;
      resolve({ code, signal });
    };
    child.on('exit', (code, signal) => settle(code, signal));
    child.on('close', (code, signal) => settle(code, signal));
  });
  // The readiness race below has its own 'error' listener that rejects `ready` with a clear
  // message; this listener only exists so Node never treats an unhandled 'error' event on the
  // child as an uncaught exception (ChildProcess is an EventEmitter; 'error' with zero listeners
  // throws).
  child.on('error', () => {});

  const stderrLines: string[] = [];
  // Kept open for the child's whole life (never closed), same as before.
  createLineReader(child.stderr!, (line) => {
    const redacted = redactSecret(line, password);
    stderrLines.push(redacted);
    if (stderrLines.length > MAX_STDERR_LINES) {
      stderrLines.shift();
    }
    opts.logger.debug(redacted, { stream: 'stderr' });
  });

  let stopPromise: Promise<void> | undefined;
  function stop(graceMs = 5000): Promise<void> {
    if (!stopPromise) {
      stopPromise = killAndWait(child.pid, exited, graceMs, () => childExited);
    }
    return stopPromise;
  }

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;

    function fail(message: string): void {
      if (settled) {
        return;
      }
      settled = true;
      outReader.close();
      // The recent stderr tail (already password-redacted per line) goes to the structured log
      // for an operator to inspect — never into the thrown Error's message, which can become
      // model-visible (it flows into EngineError -> the tool's ErrorResult.error.message). Raw
      // opencode/OS diagnostics (paths, other env leakage, stack-shaped text, ...) have no place
      // in a response the model reads.
      const tail = stderrLines.slice(-5).join(' | ');
      if (tail.length > 0) {
        opts.logger.warn(`opencode startup failed: ${message}`, { recentStderr: tail });
      }
      reject(new Error(tail.length > 0 ? `${message} (see server log for recent stderr)` : message));
    }

    const outReader = createLineReader(child.stdout!, (line) => {
      opts.logger.debug(redactSecret(line, password), { stream: 'stdout' });
      if (settled) {
        return;
      }
      if (line === expectedLine) {
        settled = true;
        // Deliberately does NOT close outReader here (r1-connection-managed-3): closing it would
        // pause child.stdout for the rest of the child's life with no reader, so any later stdout
        // output (a plugin, a custom tool, ...) would fill the Node buffer and then the OS pipe,
        // eventually blocking the child's own writes. Keep the reader alive so stdout keeps being
        // drained and forwarded to logger.debug above (`if (settled) return;` above already stops
        // it from re-matching readiness or calling `fail()` again).
        resolve();
        return;
      }
      if (line.startsWith('opencode server listening on ')) {
        fail(`opencode server listened on an unexpected URL: got "${line}", expected "${expectedLine}"`);
      }
    });

    child.on('error', (err) => {
      fail(`failed to spawn opencode: ${err.message}`);
    });

    exited.then((result) => {
      fail(`opencode exited before becoming ready (code=${result.code}, signal=${result.signal})`);
    });
  });

  const timeoutController = { timedOut: false };
  const timeout = delay(opts.startupTimeoutMs).then(() => {
    timeoutController.timedOut = true;
  });

  const aborted = new Promise<never>((_, reject) => {
    if (!opts.signal) return;
    if (opts.signal.aborted) {
      reject(new Error('startup aborted'));
      return;
    }
    opts.signal.addEventListener('abort', () => reject(new Error('startup aborted')), { once: true });
  });

  try {
    await Promise.race([ready, timeout, aborted]);
    if (timeoutController.timedOut) {
      throw new Error(`opencode did not report readiness within ${opts.startupTimeoutMs}ms`);
    }
  } catch (err) {
    await killAndWait(child.pid, exited, 2000, () => childExited);
    throw err instanceof Error ? err : new Error(String(err));
  }

  return {
    url: expectedUrl,
    pid: child.pid!,
    exited,
    stop,
  };
}

const SCRUB_EXACT_NAMES = new Set(['CLAUDECODE', 'AI_AGENT']);
const SCRUB_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENCODE_MCP_', 'OPENCODE_SERVER_'];
const ESSENTIAL_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM'];

function isScrubbed(name: string): boolean {
  return SCRUB_EXACT_NAMES.has(name) || SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function matchesAllowlistEntry(entry: string, name: string): boolean {
  if (entry.endsWith('*')) {
    return name.startsWith(entry.slice(0, -1));
  }
  return name === entry;
}

function setIfUnset(env: Record<string, string>, key: string, value: string): void {
  if (env[key] === undefined) {
    env[key] = value;
  }
}

/** Builds the child process env for a managed `opencode serve` (design.md §5.1, §7). */
export function buildServeEnv(base: NodeJS.ProcessEnv, cfg: Config, password: string): Record<string, string> {
  const selected: Record<string, string | undefined> = {};

  if (cfg.childEnvAllowlist.length > 0) {
    for (const [name, value] of Object.entries(base)) {
      const allowed = ESSENTIAL_ENV_NAMES.includes(name) || cfg.childEnvAllowlist.some((entry) => matchesAllowlistEntry(entry, name));
      if (allowed) {
        selected[name] = value;
      }
    }
  } else {
    Object.assign(selected, base);
  }

  for (const name of Object.keys(selected)) {
    if (isScrubbed(name)) {
      delete selected[name];
    }
  }

  selected.OPENCODE_SERVER_USERNAME = cfg.username;
  selected.OPENCODE_SERVER_PASSWORD = password;

  if (cfg.airgapDefaults) {
    setIfUnset(selected as Record<string, string>, 'OPENCODE_DISABLE_AUTOUPDATE', '1');
    setIfUnset(selected as Record<string, string>, 'OPENCODE_DISABLE_SHARE', '1');
    setIfUnset(selected as Record<string, string>, 'OPENCODE_DISABLE_LSP_DOWNLOAD', '1');
    setIfUnset(selected as Record<string, string>, 'NPM_CONFIG_FETCH_RETRIES', '0');
    if (!selected.OPENCODE_MODELS_URL) {
      setIfUnset(selected as Record<string, string>, 'OPENCODE_DISABLE_MODELS_FETCH', '1');
    }
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(selected)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
