import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfig } from '../src/config.ts';

const FIXED_CWD = '/repo/workdir';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('loadConfig: defaults with an empty environment', () => {
  const config = loadConfig(env(), FIXED_CWD);

  assert.equal(config.mode, 'managed');
  assert.equal(config.serverUrl, undefined);
  assert.equal(config.allowInsecureHttp, false);
  assert.equal(config.username, 'opencode');
  assert.equal(config.password, undefined);
  assert.equal(config.opencodeBin, 'opencode');
  assert.deepEqual(config.serveArgs, []);
  assert.equal(config.airgapDefaults, true);
  assert.deepEqual(config.childEnvAllowlist, []);
  assert.equal(config.startupTimeoutMs, 60_000);
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.defaultCwd, path.resolve(FIXED_CWD));
  assert.deepEqual(config.allowedRoots, [path.resolve(FIXED_CWD)]);
  assert.equal(config.remotePaths, false);
  assert.equal(config.defaultModel, undefined);
  assert.equal(config.defaultAgent, undefined);
  assert.equal(config.defaultSandbox, 'workspace-write');
  assert.equal(config.defaultApprovalPolicy, 'never');
  assert.equal(config.turnTimeoutMs, 3_600_000);
  assert.equal(config.maxTurnTimeoutMs, 21_600_000);
  assert.equal(config.approvalTimeoutMs, 600_000);
  assert.equal(config.startupTimeoutMs, 60_000);
  assert.equal(config.heartbeatMs, 15_000);
  assert.equal(config.statusPollMs, 30_000);
  assert.equal(config.sseStallMs, 35_000);
  assert.equal(config.cleanupTimeoutMs, 15_000);
  assert.equal(config.maxOutputChars, 20_000);
  assert.equal(config.readRetryAttempts, 3);
  assert.equal(config.responseLoopLimit, 6);
  assert.equal(config.maxSessions, 256);
  assert.equal(config.maxRunningTurns, 4);
  assert.equal(config.maxQueuedTurns, 64);
  assert.equal(config.queueTimeoutMs, 0);
  assert.deepEqual(config.modelProfiles, {});
  assert.equal(config.contextGuard, 'reject');
  assert.equal(config.endAction, 'delete');
  assert.equal(config.onExit, 'abort');
  assert.equal(config.logLevel, 'info');
});

// ---------------------------------------------------------------------------
// mode / attach URL
// ---------------------------------------------------------------------------

test('loadConfig: mode defaults to attach when OPENCODE_MCP_SERVER_URL is set', () => {
  const config = loadConfig(env({ OPENCODE_MCP_SERVER_URL: 'https://opencode.internal:4000' }), FIXED_CWD);
  assert.equal(config.mode, 'attach');
  assert.equal(config.serverUrl, 'https://opencode.internal:4000');
});

test('loadConfig: explicit managed mode ignores a set OPENCODE_MCP_SERVER_URL', () => {
  const config = loadConfig(
    env({ OPENCODE_MCP_MODE: 'managed', OPENCODE_MCP_SERVER_URL: 'https://opencode.internal:4000' }),
    FIXED_CWD,
  );
  assert.equal(config.mode, 'managed');
  assert.equal(config.serverUrl, undefined);
});

test('loadConfig: attach mode without OPENCODE_MCP_SERVER_URL throws naming the var', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_MODE: 'attach' }), FIXED_CWD),
    /OPENCODE_MCP_SERVER_URL/,
  );
});

test('loadConfig: invalid OPENCODE_MCP_MODE throws naming the var', () => {
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_MODE: 'bogus' }), FIXED_CWD), /OPENCODE_MCP_MODE/);
});

test('loadConfig: OPENCODE_MCP_SERVER_URL must be a valid URL', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_SERVER_URL: 'not a url' }), FIXED_CWD),
    /OPENCODE_MCP_SERVER_URL/,
  );
});

test('loadConfig: OPENCODE_MCP_SERVER_URL rejects non-http(s) schemes', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_SERVER_URL: 'ftp://opencode.internal' }), FIXED_CWD),
    /OPENCODE_MCP_SERVER_URL/,
  );
});

test('loadConfig: OPENCODE_MCP_SERVER_URL rejects userinfo', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_SERVER_URL: 'https://user:pass@opencode.internal' }), FIXED_CWD),
    /OPENCODE_MCP_SERVER_URL/,
  );
});

test('loadConfig: OPENCODE_MCP_SERVER_URL rejects insecure http on a non-loopback host', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_SERVER_URL: 'http://opencode.internal' }), FIXED_CWD),
    /OPENCODE_MCP_SERVER_URL/,
  );
});

test('loadConfig: a malformed OPENCODE_MCP_SERVER_URL never echoes the value (it may itself carry credentials)', () => {
  const synthetic = 'https://user:SYNTHETIC_SECRET@[';
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_SERVER_URL: synthetic }), FIXED_CWD),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /OPENCODE_MCP_SERVER_URL/);
      assert.doesNotMatch(err.message, /SYNTHETIC_SECRET/);
      assert.doesNotMatch(err.message, /\[/, 'must not echo the raw value at all, not just redact the secret part');
      return true;
    },
  );
});

test('loadConfig: OPENCODE_MCP_SERVER_URL allows http on loopback hosts', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const url = host === '::1' ? `http://[${host}]:4096` : `http://${host}:4096`;
    const config = loadConfig(env({ OPENCODE_MCP_SERVER_URL: url }), FIXED_CWD);
    assert.equal(config.serverUrl, url);
  }
});

test('loadConfig: OPENCODE_MCP_ALLOW_INSECURE_HTTP=1 allows http on a non-loopback host', () => {
  const config = loadConfig(
    env({ OPENCODE_MCP_SERVER_URL: 'http://opencode.internal', OPENCODE_MCP_ALLOW_INSECURE_HTTP: '1' }),
    FIXED_CWD,
  );
  assert.equal(config.allowInsecureHttp, true);
  assert.equal(config.serverUrl, 'http://opencode.internal');
});

test('loadConfig: invalid OPENCODE_MCP_ALLOW_INSECURE_HTTP throws naming the var', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_ALLOW_INSECURE_HTTP: 'maybe' }), FIXED_CWD),
    /OPENCODE_MCP_ALLOW_INSECURE_HTTP/,
  );
});

// ---------------------------------------------------------------------------
// booleans
// ---------------------------------------------------------------------------

test('loadConfig: booleans accept 1/0/true/false/yes/no (case-insensitive)', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'YES']) {
    assert.equal(loadConfig(env({ OPENCODE_MCP_AIRGAP: v }), FIXED_CWD).airgapDefaults, true, v);
  }
  for (const v of ['0', 'false', 'FALSE', 'no', 'NO']) {
    assert.equal(loadConfig(env({ OPENCODE_MCP_AIRGAP: v }), FIXED_CWD).airgapDefaults, false, v);
  }
});

test('loadConfig: invalid boolean throws naming the var', () => {
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_AIRGAP: 'sure' }), FIXED_CWD), /OPENCODE_MCP_AIRGAP/);
});

test('loadConfig: OPENCODE_MCP_REMOTE_PATHS boolean parsing', () => {
  assert.equal(loadConfig(env({ OPENCODE_MCP_REMOTE_PATHS: '1' }), FIXED_CWD).remotePaths, true);
  assert.equal(loadConfig(env({ OPENCODE_MCP_REMOTE_PATHS: '0' }), FIXED_CWD).remotePaths, false);
});

// ---------------------------------------------------------------------------
// username / password / opencodeBin
// ---------------------------------------------------------------------------

test('loadConfig: username and password come from env', () => {
  const config = loadConfig(
    env({ OPENCODE_SERVER_USERNAME: 'alice', OPENCODE_SERVER_PASSWORD: 'secret-pw' }),
    FIXED_CWD,
  );
  assert.equal(config.username, 'alice');
  assert.equal(config.password, 'secret-pw');
});

test('loadConfig: OPENCODE_MCP_OPENCODE_BIN overrides the default binary name', () => {
  const config = loadConfig(env({ OPENCODE_MCP_OPENCODE_BIN: '/opt/opencode/bin/opencode' }), FIXED_CWD);
  assert.equal(config.opencodeBin, '/opt/opencode/bin/opencode');
});

// ---------------------------------------------------------------------------
// serveArgs
// ---------------------------------------------------------------------------

test('loadConfig: OPENCODE_MCP_SERVE_ARGS is space-separated', () => {
  const config = loadConfig(env({ OPENCODE_MCP_SERVE_ARGS: '--pure   --log-level=debug' }), FIXED_CWD);
  assert.deepEqual(config.serveArgs, ['--pure', '--log-level=debug']);
});

for (const bad of ['--hostname', '--hostname=0.0.0.0', '--port', '--port=1234', '--cors', '--cors=*', '--mdns', '--mdns=false']) {
  test(`loadConfig: OPENCODE_MCP_SERVE_ARGS rejects "${bad}"`, () => {
    assert.throws(
      () => loadConfig(env({ OPENCODE_MCP_SERVE_ARGS: `--pure ${bad}` }), FIXED_CWD),
      /OPENCODE_MCP_SERVE_ARGS/,
    );
  });
}

// ---------------------------------------------------------------------------
// childEnvAllowlist
// ---------------------------------------------------------------------------

test('loadConfig: OPENCODE_MCP_CHILD_ENV_ALLOWLIST is a trimmed comma list', () => {
  const config = loadConfig(env({ OPENCODE_MCP_CHILD_ENV_ALLOWLIST: 'FOO, BAR_*,, BAZ ' }), FIXED_CWD);
  assert.deepEqual(config.childEnvAllowlist, ['FOO', 'BAR_*', 'BAZ']);
});

// ---------------------------------------------------------------------------
// defaultCwd / CLAUDE_PROJECT_DIR
// ---------------------------------------------------------------------------

test('loadConfig: default cwd falls back to the process cwd argument', () => {
  const config = loadConfig(env(), FIXED_CWD);
  assert.equal(config.defaultCwd, path.resolve(FIXED_CWD));
});

test('loadConfig: OPENCODE_MCP_DEFAULT_CWD must be absolute', () => {
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_DEFAULT_CWD: 'relative/path' }), FIXED_CWD),
    /OPENCODE_MCP_DEFAULT_CWD/,
  );
});

test('loadConfig: OPENCODE_MCP_DEFAULT_CWD wins over CLAUDE_PROJECT_DIR', () => {
  const config = loadConfig(
    env({ OPENCODE_MCP_DEFAULT_CWD: '/from/env', CLAUDE_PROJECT_DIR: '/from/claude' }),
    FIXED_CWD,
  );
  assert.equal(config.defaultCwd, path.resolve('/from/env'));
});

test('loadConfig: CLAUDE_PROJECT_DIR is used when OPENCODE_MCP_DEFAULT_CWD is unset', () => {
  const config = loadConfig(env({ CLAUDE_PROJECT_DIR: '/from/claude' }), FIXED_CWD);
  assert.equal(config.defaultCwd, path.resolve('/from/claude'));
});

test('loadConfig: CLAUDE_PROJECT_DIR must be absolute', () => {
  assert.throws(
    () => loadConfig(env({ CLAUDE_PROJECT_DIR: 'relative/claude' }), FIXED_CWD),
    /CLAUDE_PROJECT_DIR/,
  );
});

// ---------------------------------------------------------------------------
// allowedRoots
// ---------------------------------------------------------------------------

test('loadConfig: allowedRoots defaults to [defaultCwd]', () => {
  const config = loadConfig(env({ OPENCODE_MCP_DEFAULT_CWD: '/from/env' }), FIXED_CWD);
  assert.deepEqual(config.allowedRoots, [path.resolve('/from/env')]);
});

test('loadConfig: allowedRoots splits on path.delimiter, realpaths existing local entries, keeps missing ones lexical', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmcp-config-test-'));
  try {
    const real = path.join(tmpRoot, 'real');
    fs.mkdirSync(real);
    const link = path.join(tmpRoot, 'link');
    fs.symlinkSync(real, link, 'dir');
    const missing = path.join(tmpRoot, 'does-not-exist');

    const config = loadConfig(
      env({ OPENCODE_MCP_ALLOWED_ROOTS: [link, missing].join(path.delimiter) }),
      FIXED_CWD,
    );

    assert.deepEqual(config.allowedRoots, [fs.realpathSync(real), missing]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadConfig: remotePaths=1 keeps allowed roots lexical even when they exist locally', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmcp-config-test-'));
  try {
    const real = path.join(tmpRoot, 'real');
    fs.mkdirSync(real);
    const link = path.join(tmpRoot, 'link');
    fs.symlinkSync(real, link, 'dir');

    const config = loadConfig(
      env({ OPENCODE_MCP_ALLOWED_ROOTS: link, OPENCODE_MCP_REMOTE_PATHS: '1' }),
      FIXED_CWD,
    );

    assert.deepEqual(config.allowedRoots, [link]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

test('loadConfig: defaultModel and defaultAgent pass through', () => {
  const config = loadConfig(
    env({ OPENCODE_MCP_DEFAULT_MODEL: 'anthropic/claude', OPENCODE_MCP_DEFAULT_AGENT: 'build' }),
    FIXED_CWD,
  );
  assert.equal(config.defaultModel, 'anthropic/claude');
  assert.equal(config.defaultAgent, 'build');
});

for (const [name, value] of [
  ['OPENCODE_MCP_REQUEST_TIMEOUT_SECONDS', '2147484'],
  ['OPENCODE_MCP_HEARTBEAT_SECONDS', '601'],
  ['OPENCODE_MCP_DEFAULT_MODEL', 'coding-model'],
  ['OPENCODE_SERVER_USERNAME', 'corp:mcp'],
  ['OPENCODE_SERVER_USERNAME', 'corp\u0007mcp'],
  ['OPENCODE_MCP_ALLOWED_ROOTS', ':'],
  ['OPENCODE_MCP_ALLOWED_ROOTS', 'relative/path'],
  ['OPENCODE_MCP_ALLOWED_ROOTS', '~/repos'],
] as const) {
  test(`loadConfig: rejects ${name}=${value} with env name`, () => {
    assert.throws(() => loadConfig(env({ [name]: value }), FIXED_CWD), new RegExp(name));
  });
}

test('loadConfig: accepts timer and model ceilings and trims absolute allowed roots', () => {
  const config = loadConfig(
    env({
      OPENCODE_MCP_REQUEST_TIMEOUT_SECONDS: '2147483',
      OPENCODE_MCP_HEARTBEAT_SECONDS: '600',
      OPENCODE_MCP_DEFAULT_MODEL: 'corp/m',
      OPENCODE_MCP_ALLOWED_ROOTS: ` ${path.resolve('/srv/a')} ${path.delimiter} ${path.resolve('/srv/b')} `,
      OPENCODE_MCP_REMOTE_PATHS: '1',
    }),
    FIXED_CWD,
  );
  assert.equal(config.requestTimeoutMs, 2147483000);
  assert.equal(config.heartbeatMs, 600000);
  assert.equal(config.defaultModel, 'corp/m');
  assert.deepEqual(config.allowedRoots, [path.resolve('/srv/a'), path.resolve('/srv/b')]);
});

test('loadConfig: defaultSandbox accepts every Sandbox value and rejects others', () => {
  for (const v of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.equal(loadConfig(env({ OPENCODE_MCP_DEFAULT_SANDBOX: v }), FIXED_CWD).defaultSandbox, v);
  }
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_DEFAULT_SANDBOX: 'bogus' }), FIXED_CWD),
    /OPENCODE_MCP_DEFAULT_SANDBOX/,
  );
});

test('loadConfig: defaultApprovalPolicy accepts every ApprovalPolicy value and rejects others', () => {
  for (const v of ['never', 'on-request']) {
    assert.equal(loadConfig(env({ OPENCODE_MCP_DEFAULT_APPROVAL_POLICY: v }), FIXED_CWD).defaultApprovalPolicy, v);
  }
  assert.throws(
    () => loadConfig(env({ OPENCODE_MCP_DEFAULT_APPROVAL_POLICY: 'bogus' }), FIXED_CWD),
    /OPENCODE_MCP_DEFAULT_APPROVAL_POLICY/,
  );
});

test('loadConfig: endAction accepts delete/archive and rejects others', () => {
  assert.equal(loadConfig(env({ OPENCODE_MCP_END_ACTION: 'archive' }), FIXED_CWD).endAction, 'archive');
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_END_ACTION: 'bogus' }), FIXED_CWD), /OPENCODE_MCP_END_ACTION/);
});

test('loadConfig: onExit accepts abort/end and rejects others', () => {
  assert.equal(loadConfig(env({ OPENCODE_MCP_ON_EXIT: 'end' }), FIXED_CWD).onExit, 'end');
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_ON_EXIT: 'bogus' }), FIXED_CWD), /OPENCODE_MCP_ON_EXIT/);
});

test('loadConfig: logLevel accepts debug/info/warn/error and rejects others', () => {
  for (const v of ['debug', 'info', 'warn', 'error']) {
    assert.equal(loadConfig(env({ OPENCODE_MCP_LOG_LEVEL: v }), FIXED_CWD).logLevel, v);
  }
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_LOG_LEVEL: 'bogus' }), FIXED_CWD), /OPENCODE_MCP_LOG_LEVEL/);
});

// ---------------------------------------------------------------------------
// timeouts (seconds -> ms) and positive-integer validation
// ---------------------------------------------------------------------------

const SECONDS_VARS: Array<[string, keyof ReturnType<typeof loadConfig>]> = [
  ['OPENCODE_MCP_TURN_TIMEOUT_SECONDS', 'turnTimeoutMs'],
  ['OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS', 'approvalTimeoutMs'],
  ['OPENCODE_MCP_STARTUP_TIMEOUT_SECONDS', 'startupTimeoutMs'],
  ['OPENCODE_MCP_REQUEST_TIMEOUT_SECONDS', 'requestTimeoutMs'],
  ['OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS', 'cleanupTimeoutMs'],
  ['OPENCODE_MCP_HEARTBEAT_SECONDS', 'heartbeatMs'],
  ['OPENCODE_MCP_STATUS_POLL_SECONDS', 'statusPollMs'],
  ['OPENCODE_MCP_SSE_STALL_SECONDS', 'sseStallMs'],
];

for (const [envVar, field] of SECONDS_VARS) {
  test(`loadConfig: ${envVar} converts seconds to milliseconds`, () => {
    const config = loadConfig(env({ [envVar]: '7' }), FIXED_CWD);
    assert.equal(config[field], 7000);
  });

  for (const bad of ['0', '-1', '1.5', 'abc']) {
    test(`loadConfig: ${envVar}="${bad}" throws naming the var`, () => {
      assert.throws(() => loadConfig(env({ [envVar]: bad }), FIXED_CWD), new RegExp(envVar));
    });
  }
}

test('loadConfig: OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS must be >= OPENCODE_MCP_TURN_TIMEOUT_SECONDS', () => {
  assert.throws(
    () =>
      loadConfig(
        env({ OPENCODE_MCP_TURN_TIMEOUT_SECONDS: '100', OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS: '50' }),
        FIXED_CWD,
      ),
    /OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS/,
  );
});

test('loadConfig: equal turn/max-turn timeouts are allowed', () => {
  const config = loadConfig(
    env({ OPENCODE_MCP_TURN_TIMEOUT_SECONDS: '100', OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS: '100' }),
    FIXED_CWD,
  );
  assert.equal(config.turnTimeoutMs, 100_000);
  assert.equal(config.maxTurnTimeoutMs, 100_000);
});

for (const bad of ['0', '-1', '1.5', 'abc']) {
  test(`loadConfig: OPENCODE_MCP_MAX_OUTPUT_CHARS="${bad}" throws naming the var`, () => {
    assert.throws(
      () => loadConfig(env({ OPENCODE_MCP_MAX_OUTPUT_CHARS: bad }), FIXED_CWD),
      /OPENCODE_MCP_MAX_OUTPUT_CHARS/,
    );
  });
}

test('loadConfig: OPENCODE_MCP_MAX_OUTPUT_CHARS accepts a positive integer', () => {
  const config = loadConfig(env({ OPENCODE_MCP_MAX_OUTPUT_CHARS: '12345' }), FIXED_CWD);
  assert.equal(config.maxOutputChars, 12345);
});

// ---------------------------------------------------------------------------
// OPENCODE_MCP_MAX_SESSIONS (FY-2 #1)
// ---------------------------------------------------------------------------

for (const bad of ['0', '-1', '1.5', 'abc', '10001']) {
  test(`loadConfig: OPENCODE_MCP_MAX_SESSIONS="${bad}" throws naming the var`, () => {
    assert.throws(
      () => loadConfig(env({ OPENCODE_MCP_MAX_SESSIONS: bad }), FIXED_CWD),
      /OPENCODE_MCP_MAX_SESSIONS/,
    );
  });
}

test('loadConfig: OPENCODE_MCP_MAX_SESSIONS accepts a positive integer up to 10000', () => {
  assert.equal(loadConfig(env({ OPENCODE_MCP_MAX_SESSIONS: '1' }), FIXED_CWD).maxSessions, 1);
  assert.equal(loadConfig(env({ OPENCODE_MCP_MAX_SESSIONS: '10000' }), FIXED_CWD).maxSessions, 10000);
});

// ---------------------------------------------------------------------------
// OPENCODE_MCP_READ_RETRY_ATTEMPTS (the overload design, docs/design.md §12, unit 1)
// ---------------------------------------------------------------------------

test('loadConfig: OPENCODE_MCP_READ_RETRY_ATTEMPTS defaults to 3 and accepts 1..3', () => {
  assert.equal(loadConfig(env(), FIXED_CWD).readRetryAttempts, 3);
  assert.equal(loadConfig(env({ OPENCODE_MCP_READ_RETRY_ATTEMPTS: '1' }), FIXED_CWD).readRetryAttempts, 1);
  assert.equal(loadConfig(env({ OPENCODE_MCP_READ_RETRY_ATTEMPTS: '2' }), FIXED_CWD).readRetryAttempts, 2);
  assert.equal(loadConfig(env({ OPENCODE_MCP_READ_RETRY_ATTEMPTS: '3' }), FIXED_CWD).readRetryAttempts, 3);
});

for (const bad of ['0', '4', '-1', '1.5', 'abc', '']) {
  test(`loadConfig: OPENCODE_MCP_READ_RETRY_ATTEMPTS="${bad || '(empty, treated as unset)'}" ${bad ? 'throws naming the var' : 'falls back to the default'}`, () => {
    if (bad === '') {
      // parseIntInRange (like every other env parser here) treats an empty string as unset.
      assert.equal(loadConfig(env({ OPENCODE_MCP_READ_RETRY_ATTEMPTS: bad }), FIXED_CWD).readRetryAttempts, 3);
      return;
    }
    assert.throws(
      () => loadConfig(env({ OPENCODE_MCP_READ_RETRY_ATTEMPTS: bad }), FIXED_CWD),
      /OPENCODE_MCP_READ_RETRY_ATTEMPTS/,
    );
  });
}

// ---------------------------------------------------------------------------
// OPENCODE_MCP_RESPONSE_LOOP_LIMIT (docs/design.md §12)
// ---------------------------------------------------------------------------

test('loadConfig: OPENCODE_MCP_RESPONSE_LOOP_LIMIT defaults to 6, accepts 3..20, and 0 disables it', () => {
  assert.equal(loadConfig(env(), FIXED_CWD).responseLoopLimit, 6);
  assert.equal(loadConfig(env({ OPENCODE_MCP_RESPONSE_LOOP_LIMIT: '3' }), FIXED_CWD).responseLoopLimit, 3);
  assert.equal(loadConfig(env({ OPENCODE_MCP_RESPONSE_LOOP_LIMIT: '20' }), FIXED_CWD).responseLoopLimit, 20);
  assert.equal(loadConfig(env({ OPENCODE_MCP_RESPONSE_LOOP_LIMIT: '0' }), FIXED_CWD).responseLoopLimit, 0);
});

// ---------------------------------------------------------------------------
// Context concurrency configuration
// ---------------------------------------------------------------------------

test('loadConfig: run-slot settings accept their boundaries and disabled timeout', () => {
  const config = loadConfig(env({
    OPENCODE_MCP_MAX_RUNNING_TURNS: '0', OPENCODE_MCP_MAX_QUEUED_TURNS: '1024',
    OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS: '2147483', OPENCODE_MCP_CONTEXT_GUARD: 'off',
  }), FIXED_CWD);
  assert.equal(config.maxRunningTurns, 0);
  assert.equal(config.maxQueuedTurns, 1024);
  assert.equal(config.queueTimeoutMs, 2_147_483_000);
  assert.equal(loadConfig(env({ OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS: '0' }), FIXED_CWD).queueTimeoutMs, 0);
  assert.equal(config.contextGuard, 'off');
  assert.equal(loadConfig(env({ OPENCODE_MCP_MAX_RUNNING_TURNS: '256', OPENCODE_MCP_MAX_QUEUED_TURNS: '0' }), FIXED_CWD).maxRunningTurns, 256);
  assert.equal(loadConfig(env({ OPENCODE_MCP_MAX_QUEUED_TURNS: '0' }), FIXED_CWD).maxQueuedTurns, 0);
});

for (const [name, values] of [
  ['OPENCODE_MCP_MAX_RUNNING_TURNS', ['-1', '257', '1.5', 'bad']],
  ['OPENCODE_MCP_MAX_QUEUED_TURNS', ['-1', '1025', '1.5', 'bad']],
  ['OPENCODE_MCP_QUEUE_TIMEOUT_SECONDS', ['-1', '2147484', '1.5', 'bad']],
  ['OPENCODE_MCP_CONTEXT_GUARD', ['warn', 'true']],
] as const) {
  for (const value of values) {
    test(`loadConfig: ${name} rejects ${value}`, () => {
      assert.throws(() => loadConfig(env({ [name]: value }), FIXED_CWD), new RegExp(name));
    });
  }
}

test('loadConfig: model profiles accept limits and maxRunning-only profiles', () => {
  const profiles = { 'acme/large': { context: 200000, input: 150000, output: 32000 }, 'acme/fast': { maxRunning: 2 } };
  assert.deepEqual(loadConfig(env({ OPENCODE_MCP_MODEL_PROFILES: JSON.stringify(profiles) }), FIXED_CWD).modelProfiles, profiles);
});

test('loadConfig: model profile token fields accept their lower and upper bounds', () => {
  const config = loadConfig(env({
    OPENCODE_MCP_MODEL_PROFILES: '{"acme/model":{"context":100000000,"input":1,"output":1}}',
  }), FIXED_CWD);
  assert.deepEqual(config.modelProfiles['acme/model'], { context: 100000000, input: 1, output: 1 });
});

for (const profiles of [
  '{', '[]', 'null', '"string"', '5', '{"acme/model":{"extra":1}}',
  '{"/model":{"maxRunning":1}}', '{"acme/":{"maxRunning":1}}',
  '{"acmemodel":{"maxRunning":1}}', '{"acme/model":[]}',
  '{"acme/mo\\u0001del":{"maxRunning":1}}',
  JSON.stringify({ [`acme/${'m'.repeat(201)}`]: { maxRunning: 1 } }),
  '{"acme/model":{"context":0,"output":1}}',
  '{"acme/model":{"context":100000001,"output":1}}',
  '{"acme/model":{"context":1.5,"output":1}}',
  '{"acme/model":{"context":100,"input":101,"output":1}}',
  '{"acme/model":{"context":100}}',
  '{"acme/model":{"output":100}}',
  '{"acme/model":{"maxRunning":5}}',
]) {
  test('loadConfig: OPENCODE_MCP_MODEL_PROFILES rejects invalid profile data', () => {
    assert.throws(() => loadConfig(env({ OPENCODE_MCP_MODEL_PROFILES: profiles }), FIXED_CWD), /OPENCODE_MCP_MODEL_PROFILES/);
  });
}

test('loadConfig: profile maxRunning can reach 256 when global cap is unlimited', () => {
  const config = loadConfig(env({
    OPENCODE_MCP_MAX_RUNNING_TURNS: '0',
    OPENCODE_MCP_MODEL_PROFILES: '{"acme/model":{"maxRunning":256}}',
  }), FIXED_CWD);
  assert.equal(config.modelProfiles['acme/model']?.maxRunning, 256);
});

test('loadConfig: model profiles reject more than 256 keys', () => {
  const entries = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p/m${i}`, { maxRunning: 1 }]));
  assert.throws(() => loadConfig(env({ OPENCODE_MCP_MODEL_PROFILES: JSON.stringify(entries) }), FIXED_CWD), /OPENCODE_MCP_MODEL_PROFILES/);
});

for (const bad of ['1', '2', '21', '-1', '1.5', 'abc']) {
  test(`loadConfig: OPENCODE_MCP_RESPONSE_LOOP_LIMIT="${bad}" throws naming the var`, () => {
    assert.throws(
      () => loadConfig(env({ OPENCODE_MCP_RESPONSE_LOOP_LIMIT: bad }), FIXED_CWD),
      /OPENCODE_MCP_RESPONSE_LOOP_LIMIT/,
    );
  });
}
