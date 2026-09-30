// Shared helpers for e2e/scenarios.test.mjs: temp git repos, a fake-LLM instance per scenario,
// the OpenCode config fed to opencode-mcp's managed `opencode serve`, and env-var assembly.
// No third-party deps: node:child_process, node:fs, node:os, node:path, node:readline only.
//
// docs/research/opencode-offline.md §3 documents the sample config this mirrors, and
// docs/design.md §8 documents the OPENCODE_MCP_* env vars this assembles.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_LLM_PATH = join(HERE, '..', 'fake-llm-server.mjs');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true when the caller asked to keep temp dirs around (run-e2e.sh --keep). */
export function shouldKeepTmp() {
  return process.env.E2E_KEEP_TMP === '1';
}

/** Prefers /work (the harness's container working area); falls back to the OS temp dir so this
 * also works when validating locally without the e2e Docker image. */
export function resolveWorkDir() {
  const preferred = process.env.E2E_WORKDIR || '/work';
  try {
    if (existsSync(preferred)) {
      accessSync(preferred, fsConstants.W_OK);
      return preferred;
    }
  } catch {
    // fall through to tmpdir()
  }
  return tmpdir();
}

let repoCounter = 0;

/** Creates a fresh git repo (init + one commit) under resolveWorkDir(), for use as an
 * OPENCODE_MCP_DEFAULT_CWD / ALLOWED_ROOTS session directory. */
export function createTempRepo(label = 'repo') {
  const base = resolveWorkDir();
  const dir = mkdtempSync(join(base, `ocmcp-e2e-${label}-${process.pid}-${++repoCounter}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: dir,
  });
  return {
    dir,
    cleanup() {
      if (shouldKeepTmp()) return;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Spawns e2e/fake-llm-server.mjs on an OS-assigned loopback port and waits for its readiness
 * line, mirroring the readiness-line pattern src/opencode/managed-server.ts uses for `opencode
 * serve` itself. */
export async function startFakeLlm({ label = 'llm', env = {} } = {}) {
  const child = spawn('node', [FAKE_LLM_PATH], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8');
  });

  const baseUrl = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`fake-llm (${label}) did not report readiness in time; stderr: ${stderr}`));
    }, 10_000);
    rl.on('line', (line) => {
      const m = /fake-llm listening on (http:\/\/\S+)/.exec(line);
      if (m) {
        clearTimeout(timer);
        rl.close();
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake-llm (${label}) exited early with code ${code}; stderr: ${stderr}`));
    });
  });

  return {
    baseUrl,
    chatUrl: `${baseUrl}/v1`,
    async requests() {
      const res = await fetch(`${baseUrl}/__requests`);
      return res.json();
    },
    async reset() {
      await fetch(`${baseUrl}/__reset`, { method: 'POST' });
    },
    stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000).then(() => child.kill('SIGKILL')),
      ]);
    },
  };
}

/**
 * Builds OPENCODE_CONFIG_CONTENT (docs/research/opencode-offline.md §3): a single fake provider
 * routed to the fake LLM, enabled_providers restricted to it, share/autoupdate off.
 * @param {object} opts
 * @param {string} opts.baseUrl fake LLM's http://host:port (no /v1 suffix)
 * @param {Record<string,string>} [opts.permission] e.g. {bash:"ask"} for the approval scenarios
 * @param {string} [opts.apiKey] default 'fake-key'; override with a sentinel value to assert it
 *   never leaks into an MCP-facing result (e.g. e2e/features.test.mjs's opencode-info scenario).
 */
export function buildOpencodeConfig({ baseUrl, permission, apiKey = 'fake-key' } = {}) {
  const config = {
    model: 'fake/fake-model',
    small_model: 'fake/fake-model',
    enabled_providers: ['fake'],
    autoupdate: false,
    share: 'disabled',
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake LLM',
        options: { baseURL: `${baseUrl}/v1`, apiKey },
        models: { 'fake-model': { name: 'Fake Model', tool_call: true, limit: { context: 128000, output: 4096 } } },
      },
    },
  };
  if (permission) {
    config.permission = permission;
  }
  return JSON.stringify(config);
}

/**
 * Assembles the opencode-mcp process env for one scenario (docs/design.md §8).
 * @param {object} opts
 * @param {string} opts.cwd the temp repo directory (default cwd == the only allowed root)
 * @param {string} opts.configContent from buildOpencodeConfig()
 * @param {number} [opts.heartbeatSeconds] default 2 (small, so progress/heartbeats are observable
 *   quickly in tests without waiting out the production default of 15s)
 * @param {Record<string,string>} [opts.extra] additional/overriding env entries
 */
export function baseServerEnv({ cwd, configContent, heartbeatSeconds = 2, extra = {} } = {}) {
  return {
    OPENCODE_MCP_DEFAULT_CWD: cwd,
    OPENCODE_MCP_ALLOWED_ROOTS: cwd,
    OPENCODE_CONFIG_CONTENT: configContent,
    OPENCODE_MCP_HEARTBEAT_SECONDS: String(heartbeatSeconds),
    // Keep managed `opencode serve` startup snappy and air-gap-safe in the container.
    OPENCODE_MCP_STARTUP_TIMEOUT_SECONDS: '30',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    NPM_CONFIG_FETCH_RETRIES: '0',
    ...extra,
  };
}

export function fileExists(path) {
  return existsSync(path);
}

/** Finds a free loopback TCP port (mirrors src/opencode/managed-server.ts's own picker, duplicated
 * here since e2e/ never imports src/**: `--port 0` was observed to try a fixed port first, not a
 * random one, so the caller must pick and pass an explicit port instead). */
export function pickFreePort() {
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
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Spawns a real `opencode serve` directly — NOT through opencode-mcp's own managed-server path —
 * for the e2e attach-mode scenario (r2-r-tests-8): proves `OPENCODE_MCP_SERVER_URL` / attach-mode
 * wiring against a real, externally-owned OpenCode process that opencode-mcp must never kill.
 * Mirrors src/opencode/managed-server.ts's spawn args and stdout readiness-line contract.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.configContent from buildOpencodeConfig()
 * @param {string} opts.password required: the shared secret the MCP process will also be given
 * @param {string} [opts.username] default 'opencode' (matches src/config.ts's own default, and
 *   real OpenCode's own `-u/--username` default — see the `opencode run` flag list in
 *   docs/research/opencode-api.md)
 * @param {string} [opts.bin] default 'opencode'
 */
export async function startExternalOpencodeServer({ cwd, configContent, password, username = 'opencode', bin = 'opencode' } = {}) {
  if (!password) throw new Error('startExternalOpencodeServer requires a password');
  const port = await pickFreePort();
  const hostname = '127.0.0.1';
  const url = `http://${hostname}:${port}`;
  const expectedLine = `opencode server listening on ${url}`;
  const args = ['serve', '--hostname', hostname, '--port', String(port), '--mdns=false'];
  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: configContent,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    NPM_CONFIG_FETCH_RETRIES: '0',
  };

  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8');
  });
  // Never let an unheard 'error' (e.g. ENOENT for a bad `bin`) become an uncaught exception that
  // crashes the whole test process — the readiness race below has its own failure handling, fed by
  // a second listener registered there.
  child.on('error', () => {});

  const exited = new Promise((resolve) => {
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.on('exit', (code, signal) => settle(code, signal));
    child.on('close', (code, signal) => settle(code, signal));
  });

  /** Kills the child (if still alive) and waits for it to actually exit, so a failed/aborted
   * startup never leaves an orphaned `opencode serve` process running, or its stdio pipes open,
   * keeping the test process alive (mid-review finding 12: the child used to be leaked — and its
   * pipes never closed — on every readiness failure, since the caller's `await
   * startExternalOpencodeServer(...)` throws before ever receiving a `stop()` to call). */
  async function killAndWait(graceMs = 3000) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(graceMs)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    await exited;
  }

  let rl;
  try {
    await new Promise((resolve, reject) => {
      rl = createInterface({ input: child.stdout });
      const timer = setTimeout(() => {
        reject(new Error(`external opencode serve did not report readiness in time; stderr: ${stderr}`));
      }, 20_000);
      rl.on('line', (line) => {
        if (line === expectedLine) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`external opencode serve exited before becoming ready (code=${code}, signal=${signal}); stderr: ${stderr}`));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn external opencode serve (${bin}): ${err.message}`));
      });
    });
  } catch (err) {
    // Every failure path above (readiness timeout, exit-before-ready, spawn 'error') lands here:
    // release the read side first (so it can never keep this process's event loop alive), then
    // make sure the child is actually gone before the caller ever sees the rejection — a caller
    // that never receives a `stop()` handle has no other way to clean this up.
    rl?.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
    await killAndWait();
    throw err;
  }

  return {
    url,
    pid: child.pid,
    exited,
    /** True while the process is still alive (existence probe only; signal 0 is never delivered). */
    isAlive() {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        process.kill(child.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async stop() {
      await killAndWait();
    },
  };
}

/** Polls fakeLlm.requests() until one matches `predicate`, for scenarios that must not race the
 * fake LLM actually receiving the expected chat-completions POST (e.g. an owning-call cancel sent
 * before the request is even dispatched takes a different, pre-dispatch code path and would prove
 * nothing about abort of a running turn — r1-tests-quality-12). */
export async function waitForFakeLlmRequest(fakeLlm, predicate, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reqs = await fakeLlm.requests();
    const match = reqs.find(predicate);
    if (match) return match;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for a matching fake-LLM request`);
    }
    await sleep(intervalMs);
  }
}
