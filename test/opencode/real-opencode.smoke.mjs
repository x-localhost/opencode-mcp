#!/usr/bin/env node
// Real-OpenCode smoke check for U1 (opencode/http.ts, managed-server.ts, sse.ts), driven against a
// real `opencode serve` (opencode-ai@1.18.33) instead of the in-process fakes used by the
// node:test suite. Plain JS on purpose (`*.smoke.mjs`, not `*.test.ts`) so it is never picked up
// by `npm test`'s `test/**/*.test.ts` glob; it is meant to be run explicitly, in a throwaway
// container, e.g. on gram:
//
//   ssh gram docker run --rm --name ocmcp-u1-real-$$ -v /tmp/ocmcp/u1:/w -w /w node:22 \
//     bash -lc 'npm i -g opencode-ai@1.18.33 >/dev/null && node test/opencode/real-opencode.smoke.mjs'
//
// No LLM provider is configured or needed: OPENCODE_DISABLE_MODELS_FETCH=1 is set, and the smoke
// test never sends a prompt (that needs a working model; U1 owns the transport, not the engine).
//
// Node 22.23+ strips TypeScript type annotations from `.ts` imports natively (no build step, no
// flags needed — verified locally: `node script.mjs` importing a `.ts` file just works), so this
// script imports src/opencode/*.ts directly, exactly like the adapter's own node:test suite does.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startManagedServer, buildServeEnv } from '../../src/opencode/managed-server.ts';
import { createOpencodeApi } from '../../src/opencode/http.ts';

function log(...args) {
  console.log('[smoke]', ...args);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const logger = {
  debug(msg) {
    log('debug:', msg);
  },
  info(msg) {
    log('info:', msg);
  },
  warn(msg, fields) {
    log('warn:', msg, fields ?? '');
  },
  error(msg, fields) {
    log('error:', msg, fields ?? '');
  },
};

async function main() {
  // --- Record the --mdns help text and confirm --mdns=false is still accepted on this exact
  //     install, alongside the empirical finding already documented in managed-server.ts. ---
  const help = spawnSync('opencode', ['serve', '--help'], { encoding: 'utf-8' });
  // yargs prints --help to stderr when stdout is not a TTY (as it is here, under spawnSync).
  const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  const mdnsLines = helpText.split('\n').filter((line) => line.includes('mdns'));
  log('opencode serve --help (mdns-related lines):');
  for (const line of mdnsLines) {
    log(' ', line);
  }
  assert(mdnsLines.length > 0, 'expected --help to mention --mdns');

  // --- Temp git repo as the session directory (OpenCode expects a project directory). ---
  const dir = mkdtempSync(join(tmpdir(), 'ocmcp-u1-smoke-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: dir,
  });
  log('temp git repo:', dir);

  const password = randomBytes(32).toString('base64url');
  const cfg = {
    childEnvAllowlist: [],
    airgapDefaults: true,
    username: 'opencode',
  };
  const env = buildServeEnv(process.env, cfg, password);
  assert(env.OPENCODE_DISABLE_MODELS_FETCH === '1', 'expected air-gap defaults to disable the models fetch');
  assert(env.OPENCODE_SERVER_PASSWORD === password, 'expected the generated password to be set');

  log('starting managed opencode serve...');
  const server = await startManagedServer({
    bin: 'opencode',
    serveArgs: [],
    cwd: dir,
    env,
    startupTimeoutMs: 20_000,
    logger,
  });
  log('started:', server.url, 'pid', server.pid);

  let sessionId;
  try {
    const api = createOpencodeApi({
      baseUrl: server.url,
      username: 'opencode',
      password,
      requestTimeoutMs: 10_000,
      logger,
    });

    const health = await api.health();
    log('health:', health);
    assert(health.healthy === true, 'expected healthy:true');
    assert(typeof health.version === 'string' && health.version.length > 0, 'expected a version string');

    const session = await api.createSession(dir, { title: 'opencode-mcp U1 smoke test' });
    sessionId = session.id;
    log('created session:', session.id, session.directory);
    assert(session.id.startsWith('ses_'), 'expected a ses_ prefixed id');
    assert(session.directory === dir, `expected session.directory to be ${dir}, got ${session.directory}`);

    log('subscribing to /event until server.connected...');
    const controller = new AbortController();
    let sawConnected = false;
    const subscribeTimeout = setTimeout(() => controller.abort(), 10_000);
    try {
      for await (const evt of api.subscribe(dir, controller.signal)) {
        log('event:', evt.type);
        if (evt.type === 'server.connected') {
          sawConnected = true;
          controller.abort();
          break;
        }
      }
    } finally {
      clearTimeout(subscribeTimeout);
    }
    assert(sawConnected, 'expected to observe a server.connected event');
    log('subscribe ended cleanly after abort (no throw)');

    const status = await api.sessionStatus(dir);
    log('sessionStatus:', status);
    assert(typeof status === 'object' && status !== null, 'expected an object (idle sessions are simply absent)');

    const permissions = await api.listPermissions(dir);
    log('listPermissions:', permissions);
    assert(Array.isArray(permissions), 'expected an array');
    assert(permissions.length === 0, 'expected no pending permissions (no prompt was ever sent)');

    const page = await api.messages(session.id, { limit: 10 });
    log('messages page:', page);
    assert(Array.isArray(page.items), 'expected items to be an array');
    assert(page.items.length === 0, 'expected no messages (no prompt was ever sent)');
    assert(page.nextCursor === undefined, 'expected no next cursor for an empty session');

    const deleted = await api.deleteSession(session.id);
    log('deleteSession:', deleted);
    assert(deleted === true, 'expected deleteSession to return true');
    sessionId = undefined;

    const afterDelete = await api.getSession(session.id);
    assert(afterDelete === null, 'expected getSession to return null after delete');
  } finally {
    if (sessionId) {
      log('cleanup: deleting leftover session', sessionId);
      try {
        const api = createOpencodeApi({
          baseUrl: server.url,
          username: 'opencode',
          password,
          requestTimeoutMs: 10_000,
          logger,
        });
        await api.deleteSession(sessionId);
      } catch (err) {
        log('cleanup delete failed (non-fatal):', err.message);
      }
    }
    log('stopping managed opencode serve...');
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  log('PASS: all real-OpenCode smoke checks succeeded');
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err);
  process.exitCode = 1;
});
