// Scenario (k), stretch: real headless Claude Code (2.1.284) driving opencode-mcp for real, with
// a fake Anthropic Messages API standing in for the model (docs/research/probe-mcpclient,
// docs/research/mcp-client.md §3). Dummy API key only; no real network or credentials.
//
// Gated behind E2E_WITH_CLAUDE=1 (set by `e2e/run-e2e.sh --with-claude`, which also builds the
// image with `--build-arg WITH_CLAUDE=1` so the `claude` binary is actually installed).
//
//   claude -p "..." --mcp-config <tmp>/mcp.json --strict-mcp-config \
//     --allowedTools mcp__opencode__opencode,mcp__opencode__opencode-end
//
// The fake model (e2e/lib/fake-anthropic-oc.mjs) always: calls mcp__opencode__opencode with a
// WRITE_FILE prompt, then mcp__opencode__opencode-end with the sessionId it got back, then
// answers with plain text. We assert on the two tool_result payloads Claude Code sent back to the
// "model" (recorded by the fake API) and on the file OpenCode actually wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createTempRepo, startFakeLlm, buildOpencodeConfig, baseServerEnv, sleep } from './lib/harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_ANTHROPIC_PATH = join(HERE, 'lib', 'fake-anthropic-oc.mjs');
const BUNDLE_PATH = join(HERE, '..', 'dist', 'opencode-mcp.mjs');

const ENABLED = process.env.E2E_WITH_CLAUDE === '1';
// Only "not requested at all" is a skip. Once E2E_WITH_CLAUDE=1 explicitly asks for this stretch
// scenario, a missing/broken `claude` binary must FAIL the test, not silently skip it — a skip
// still exits 0, so run-e2e.sh (and whoever reads its summary/handoff) would otherwise record an
// explicitly requested stretch run as "verified" when it never actually ran (r1-tests-quality-3).
const skipReason = ENABLED ? false : 'set E2E_WITH_CLAUDE=1 (and build with --build-arg WITH_CLAUDE=1) to run this stretch scenario';
let claudeMissingError;
if (ENABLED) {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch (err) {
    claudeMissingError = err;
  }
}

async function startFakeAnthropic(logDir) {
  const child = spawn('node', [FAKE_ANTHROPIC_PATH], {
    env: { ...process.env, FAKE_PORT: '0', FAKE_LOG: logDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stderr });
    const timer = setTimeout(() => { rl.close(); reject(new Error('fake-anthropic-oc did not report readiness')); }, 10_000);
    rl.on('line', (line) => {
      const m = /fake-anthropic-oc listening on (http:\/\/\S+)/.exec(line);
      if (m) { clearTimeout(timer); rl.close(); resolve(m[1]); }
    });
  });
  return { baseUrl, stop: () => child.kill('SIGTERM') };
}

test('k: headless Claude Code delegates to opencode-mcp end-to-end', { timeout: 120_000, skip: skipReason }, async (t) => {
  if (claudeMissingError) {
    throw new Error(
      `E2E_WITH_CLAUDE=1 was set but the 'claude' binary was not usable (--version failed): ${claudeMissingError.message}`,
    );
  }
  const repo = createTempRepo('k');
  const fakeLlm = await startFakeLlm({ label: 'k' });
  const fakeAnthropicLog = mkdtempSync(join(tmpdir(), 'ocmcp-e2e-k-log-'));
  const fakeAnthropic = await startFakeAnthropic(fakeAnthropicLog);
  const claudeHome = mkdtempSync(join(tmpdir(), 'ocmcp-e2e-k-home-'));
  const mcpConfigDir = mkdtempSync(join(tmpdir(), 'ocmcp-e2e-k-cfg-'));

  t.after(async () => {
    fakeAnthropic.stop();
    await fakeLlm.stop();
    repo.cleanup();
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(mcpConfigDir, { recursive: true, force: true });
    if (process.env.E2E_KEEP_TMP !== '1') rmSync(fakeAnthropicLog, { recursive: true, force: true });
  });

  const configContent = buildOpencodeConfig({ baseUrl: fakeLlm.baseUrl });
  const serverEnv = baseServerEnv({ cwd: repo.dir, configContent });

  const mcpConfigPath = join(mcpConfigDir, 'mcp.json');
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        opencode: { type: 'stdio', command: 'node', args: [BUNDLE_PATH], env: serverEnv },
      },
    }),
  );

  const claudeEnv = {
    ...process.env,
    HOME: claudeHome,
    ANTHROPIC_BASE_URL: fakeAnthropic.baseUrl,
    ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-real-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ENABLE_TOOL_SEARCH: 'false',
  };

  const args = [
    '-p',
    'Delegate a task to OpenCode, then end the OpenCode session.',
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__opencode__opencode,mcp__opencode__opencode-end',
    '--output-format',
    'json',
    '--model',
    'claude-sonnet-4-5',
  ];

  const result = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: repo.dir, env: claudeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude -p timed out')); }, 100_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  assert.equal(result.code, 0, `claude -p exited ${result.code}; stderr:\n${result.stderr}`);

  const openCodeResultPath = join(fakeAnthropicLog, 'toolresult-opencode.json');
  const openCodeEndResultPath = join(fakeAnthropicLog, 'toolresult-opencode-end.json');
  assert.ok(existsSync(openCodeResultPath), `expected ${openCodeResultPath} to exist (mcp__opencode__opencode was never called)`);
  assert.ok(existsSync(openCodeEndResultPath), `expected ${openCodeEndResultPath} to exist (mcp__opencode__opencode-end was never called)`);

  // Claude Code 2.1.284 was observed to append its own `<system-reminder><total_tokens>...
  // </total_tokens></system-reminder>` block after the tool_result content it relays to the
  // model, in addition to the plain JSON.stringify(structuredContent) text docs/research/
  // mcp-client.md §3.6 documented. JSON.stringify never emits a literal newline, so the actual
  // payload is always exactly the first line of the recorded file.
  const firstJsonLine = (text) => text.split('\n', 1)[0];

  const openCodeResult = JSON.parse(firstJsonLine(readFileSync(openCodeResultPath, 'utf8')));
  assert.equal(openCodeResult.kind, 'turn');
  assert.equal(openCodeResult.status, 'completed', `expected completed, got ${JSON.stringify(openCodeResult)}`);
  assert.ok(openCodeResult.sessionId);

  const openCodeEndResult = JSON.parse(firstJsonLine(readFileSync(openCodeEndResultPath, 'utf8')));
  assert.equal(openCodeEndResult.kind, 'end');
  assert.equal(openCodeEndResult.status, 'ended');

  assert.ok(existsSync(join(repo.dir, 'hello.txt')), 'expected OpenCode to have actually written hello.txt');
});
