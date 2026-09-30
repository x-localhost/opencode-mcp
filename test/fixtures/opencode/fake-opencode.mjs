#!/usr/bin/env node
// Fake `opencode` binary for managed-server.test.ts. Understands just enough of
// `opencode serve --hostname <h> --port <p> [--mdns=false] [...serveArgs]` to exercise
// startManagedServer(): readiness line, health endpoint with Basic auth, and a handful of
// scripted failure modes selected by FAKE_OC_MODE.
//
// Modes (env FAKE_OC_MODE, default "ready"):
//   ready        - prints the correct listening line, then serves GET /global/health.
//   wrong-url    - prints a listening line for a different port than requested (never ready).
//   never-ready  - prints nothing and just hangs (until killed).
//   exit-early   - writes a couple of stderr lines (one leaking the password, to test
//                  redaction) then exits(3) before printing anything.
//   crash-after  - behaves like "ready", then after FAKE_OC_CRASH_AFTER_MS exits(1) unprompted
//                  (simulates the child dying unexpectedly while otherwise healthy).
//   chatty-stdout - behaves like "ready", then writes >256 KiB of extra lines to stdout after the
//                  listening line (simulates an in-process plugin/tool logging to stdout post-
//                  readiness; see r1-connection-managed-3).
//   huge-line-stdout - behaves like "ready", then writes one 200,000-char line with no newline for
//                  a while before finally terminating it (simulates a plugin/tool writing a large
//                  newline-less blob; see critic Q2 / the per-line byte cap).
//
// FAKE_OC_DUMP_ENV_PATH, if set, gets the full received process.env written as JSON before
// anything else, so tests can assert on exactly what a real spawn received (end-to-end check of
// buildServeEnv, complementing the direct unit tests of buildServeEnv itself).

import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) {
    return undefined;
  }
  return args[idx + 1];
}

const hostname = flag('--hostname') ?? '127.0.0.1';
const port = flag('--port') ?? '0';
const mode = process.env.FAKE_OC_MODE ?? 'ready';

if (process.env.FAKE_OC_SELF_PID_PATH) {
  // Written immediately, regardless of mode, so tests can confirm this exact process is really
  // gone after a startup failure (startManagedServer does not expose a pid on rejection).
  writeFileSync(process.env.FAKE_OC_SELF_PID_PATH, String(process.pid));
}

if (process.env.FAKE_OC_DUMP_ENV_PATH) {
  writeFileSync(process.env.FAKE_OC_DUMP_ENV_PATH, JSON.stringify(process.env));
}

if (process.env.FAKE_OC_DUMP_ARGV_PATH) {
  writeFileSync(process.env.FAKE_OC_DUMP_ARGV_PATH, JSON.stringify(args));
}

function maybeSpawnTermIgnoringGrandchild() {
  const pidPath = process.env.FAKE_OC_TERM_IGNORING_GRANDCHILD_PID_PATH;
  if (!pidPath) {
    return;
  }
  // Deliberately ignores SIGTERM (writes a marker proving it was received, but does not exit) so
  // tests can prove the SIGKILL fallback runs even though the *direct* child (this process) dies
  // promptly via the default SIGTERM disposition. Also writes a continuously-incrementing
  // heartbeat file: since SIGKILL cannot be caught, the only way to observe "this process is
  // truly dead" without depending on kill(pid, 0) (unreliable against an unreaped zombie in a
  // container whose PID 1 never reaps orphans) is to see the heartbeat stop advancing.
  const termReceivedPath = `${pidPath}.term-received`;
  const heartbeatPath = `${pidPath}.heartbeat`;
  const grandchildScript = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(termReceivedPath)}, 'received');
      // no process.exit(): deliberately ignored.
    });
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    let counter = 0;
    setInterval(() => {
      counter += 1;
      fs.writeFileSync(${JSON.stringify(heartbeatPath)}, String(counter));
    }, 20);
  `;
  spawn(process.execPath, ['-e', grandchildScript], { stdio: 'ignore' });
}

function maybeSpawnGrandchild() {
  const pidPath = process.env.FAKE_OC_GRANDCHILD_PID_PATH;
  if (!pidPath) {
    return;
  }
  // Not detached: inherits this process's process group, so a group-kill (`kill(-pid)`) of the
  // parent must also reach it. Used to prove stop() kills the whole group, not just one pid.
  //
  // The grandchild writes a "terminated" marker from its own SIGTERM handler rather than relying
  // on the caller polling `kill(pid, 0)`: in a container whose PID 1 never reaps re-parented
  // orphans, a killed grandchild can sit as an unreaped zombie indefinitely, and `kill(pid, 0)`
  // keeps succeeding on a zombie's still-present table entry even though it is no longer running.
  //
  // The grandchild writes `pidPath` itself, only *after* registering the SIGTERM handler, and the
  // caller waits for that file. Writing it from the parent immediately after spawn() (before the
  // grandchild's own Node process has finished starting up and registered the handler) would be a
  // race: the group SIGTERM can arrive before the handler exists, killing the grandchild via the
  // default (unhandled) disposition and never producing the "terminated" marker.
  const terminatedPath = `${pidPath}.terminated`;
  const grandchildScript = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(terminatedPath)}, 'terminated');
      process.exit(0);
    });
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {}, 1 << 30);
  `;
  spawn(process.execPath, ['-e', grandchildScript], { stdio: 'ignore' });
}

function serveHealth(boundHost, boundPort) {
  const username = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
  const password = process.env.OPENCODE_SERVER_PASSWORD;

  const server = http.createServer((req, res) => {
    if (req.url === '/global/health') {
      if (password !== undefined) {
        const header = req.headers.authorization;
        const expected = `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
        if (header !== expected) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
          res.end();
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: '1.18.33-fake' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'NotFoundError', data: { message: 'not found' } }));
  });
  server.listen(Number(boundPort), boundHost, () => {
    maybeSpawnGrandchild();
    maybeSpawnTermIgnoringGrandchild();
    console.log(`opencode server listening on http://${boundHost}:${boundPort}`);
    if (mode === 'crash-after') {
      const ms = Number(process.env.FAKE_OC_CRASH_AFTER_MS ?? '200');
      setTimeout(() => {
        console.error('fake-opencode: simulated crash');
        process.exit(1);
      }, ms);
    }
    if (mode === 'huge-line-stdout') {
      // No newline for a long stretch (critic Q2): proves the per-line byte cap kicks in instead
      // of buffering without bound, and that the reader resyncs cleanly on the next '\n'.
      process.stdout.write('X'.repeat(200_000));
      process.stdout.write('\n');
      console.log('huge-line-done');
    }
    if (mode === 'chatty-stdout') {
      // >256 KiB across many distinct lines (not one giant write), so a test can assert on
      // individual post-readiness lines actually reaching the parent's logger (proof stdout keeps
      // being drained/forwarded, not just that the process survives a single big write).
      const lineCount = 1000;
      for (let i = 0; i < lineCount; i += 1) {
        console.log(`post-readiness stdout line ${i}: ${'x'.repeat(280)}`);
      }
    }
  });
}

switch (mode) {
  case 'wrong-url': {
    const wrongPort = String(Number(port) + 1 || 65000);
    console.log(`opencode server listening on http://${hostname}:${wrongPort}`);
    // Stay alive (but never actually bind the real port) until killed.
    setInterval(() => {}, 1 << 30);
    break;
  }
  case 'never-ready': {
    setInterval(() => {}, 1 << 30);
    break;
  }
  case 'exit-early': {
    console.error('fake-opencode: about to fail');
    console.error(`fake-opencode: leaking OPENCODE_SERVER_PASSWORD=${process.env.OPENCODE_SERVER_PASSWORD ?? ''}`);
    process.exit(3);
    break;
  }
  case 'crash-after':
  case 'ready':
  default: {
    serveHealth(hostname, port);
    break;
  }
}
