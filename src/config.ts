// loadConfig(env, cwd) — see docs/design.md §8 for the exact env table this implements.
// Every validation error is a plain Error whose message names the offending env var, so a
// misconfigured deployment gets an actionable stderr line instead of a stack trace.

import * as path from 'node:path';
import * as fs from 'node:fs';

import type {
  ApprovalPolicy,
  Config,
  EndAction,
  LogLevel,
  OnExit,
  Sandbox,
  ServerMode,
} from './types.ts';

const MODES: readonly ServerMode[] = ['managed', 'attach'];
const SANDBOXES: readonly Sandbox[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['never', 'on-request'];
const END_ACTIONS: readonly EndAction[] = ['delete', 'archive'];
const ON_EXITS: readonly OnExit[] = ['abort', 'end'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const TRUE_VALUES = new Set(['1', 'true', 'yes']);
const FALSE_VALUES = new Set(['0', 'false', 'no']);

/** `--flag` and `--flag=value` both count as uses of `--flag`. `--mdns*` matches any mdns flag. */
const SERVE_ARGS_EXACT_OR_EQUALS = ['--hostname', '--port', '--cors'] as const;
const SERVE_ARGS_PREFIX_BLOCKED = ['--mdns'] as const;

function raw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

function configError(name: string, detail: string): Error {
  return new Error(`${name}: ${detail}`);
}

function parseEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw configError(name, `must be one of ${allowed.join('|')}, got "${v}"`);
}

function parseBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  const norm = v.trim().toLowerCase();
  if (TRUE_VALUES.has(norm)) return true;
  if (FALSE_VALUES.has(norm)) return false;
  throw configError(name, `must be one of 1/0/true/false/yes/no, got "${v}"`);
}

/** A positive integer count (no unit conversion), e.g. maxOutputChars. */
function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw configError(name, `must be a positive integer, got "${v}"`);
  }
  return n;
}

/** An integer within [min, max] (inclusive), e.g. OPENCODE_MCP_READ_RETRY_ATTEMPTS. */
function parseIntInRange(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw configError(name, `must be an integer between ${min} and ${max}, got "${v}"`);
  }
  return n;
}

/** OPENCODE_MCP_RESPONSE_LOOP_LIMIT: an integer 3..20, or 0 to disable (see docs/design.md §12). */
function parseResponseLoopLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || (n !== 0 && (n < 3 || n > 20))) {
    throw configError(name, `must be 0 (disabled) or an integer between 3 and 20, got "${v}"`);
  }
  return n;
}

/** A positive integer number of seconds, converted to milliseconds. */
function parseSecondsToMs(env: NodeJS.ProcessEnv, name: string, fallbackSeconds: number): number {
  const v = raw(env, name);
  if (v === undefined) return fallbackSeconds * 1000;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw configError(name, `must be a positive integer (seconds), got "${v}"`);
  }
  const milliseconds = n * 1000;
  if (milliseconds > 2_147_483_647) {
    throw configError(name, 'must not exceed 2147483 seconds');
  }
  return milliseconds;
}

function parseCommaList(env: NodeJS.ProcessEnv, name: string): string[] {
  const v = raw(env, name);
  if (v === undefined) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseSpaceList(env: NodeJS.ProcessEnv, name: string): string[] {
  const v = raw(env, name);
  if (v === undefined) return [];
  return v
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

function violatesServeArgs(token: string): boolean {
  if (SERVE_ARGS_PREFIX_BLOCKED.some((prefix) => token.startsWith(prefix))) return true;
  return SERVE_ARGS_EXACT_OR_EQUALS.some((flag) => token === flag || token.startsWith(`${flag}=`));
}

function validateServeArgs(args: string[]): void {
  const bad = args.find(violatesServeArgs);
  if (bad !== undefined) {
    throw configError(
      'OPENCODE_MCP_SERVE_ARGS',
      `must not contain --hostname/--port/--mdns*/--cors (found "${bad}")`,
    );
  }
}

function resolveDefaultCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  const fromDefaultCwd = raw(env, 'OPENCODE_MCP_DEFAULT_CWD');
  if (fromDefaultCwd !== undefined) {
    if (!path.isAbsolute(fromDefaultCwd)) {
      throw configError('OPENCODE_MCP_DEFAULT_CWD', `must be an absolute path, got "${fromDefaultCwd}"`);
    }
    return path.resolve(fromDefaultCwd);
  }
  const fromProjectDir = raw(env, 'CLAUDE_PROJECT_DIR');
  if (fromProjectDir !== undefined) {
    if (!path.isAbsolute(fromProjectDir)) {
      throw configError('CLAUDE_PROJECT_DIR', `must be an absolute path, got "${fromProjectDir}"`);
    }
    return path.resolve(fromProjectDir);
  }
  return path.resolve(cwd);
}

function resolveAllowedRoots(env: NodeJS.ProcessEnv, defaultCwd: string, remotePaths: boolean): string[] {
  const v = raw(env, 'OPENCODE_MCP_ALLOWED_ROOTS');
  const entries = v === undefined ? [defaultCwd] : v.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  if (v !== undefined && entries.length === 0) {
    throw configError('OPENCODE_MCP_ALLOWED_ROOTS', 'must contain at least one absolute path');
  }
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) {
      throw configError('OPENCODE_MCP_ALLOWED_ROOTS', `entries must be absolute paths, got "${entry}"`);
    }
  }
  return entries.map((entry) => {
    const lexical = path.resolve(defaultCwd, entry);
    if (remotePaths) return lexical;
    try {
      return fs.realpathSync(lexical);
    } catch {
      return lexical;
    }
  });
}

// Never echoes `serverUrl` in any thrown message: it can itself carry credentials (e.g. a
// malformed `https://user:pass@[` that fails URL parsing), and that value would otherwise be
// printed verbatim to stderr by main()'s top-level config-load catch.
function validateAttachUrl(env: NodeJS.ProcessEnv, serverUrl: string, allowInsecureHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw configError('OPENCODE_MCP_SERVER_URL', 'must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw configError('OPENCODE_MCP_SERVER_URL', `must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw configError('OPENCODE_MCP_SERVER_URL', 'must not contain userinfo (user:pass@)');
  }
  if (parsed.protocol === 'http:') {
    const isLoopback =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (!isLoopback && !allowInsecureHttp) {
      throw configError(
        'OPENCODE_MCP_SERVER_URL',
        'must use https unless the host is loopback or OPENCODE_MCP_ALLOW_INSECURE_HTTP=1',
      );
    }
  }
  void env;
}

export function loadConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const serverUrl = raw(env, 'OPENCODE_MCP_SERVER_URL');
  const mode = parseEnum(env, 'OPENCODE_MCP_MODE', MODES, serverUrl !== undefined ? 'attach' : 'managed');
  const allowInsecureHttp = parseBool(env, 'OPENCODE_MCP_ALLOW_INSECURE_HTTP', false);

  let resolvedServerUrl: string | undefined;
  if (mode === 'attach') {
    if (serverUrl === undefined) {
      throw configError('OPENCODE_MCP_SERVER_URL', 'is required when OPENCODE_MCP_MODE=attach');
    }
    validateAttachUrl(env, serverUrl, allowInsecureHttp);
    resolvedServerUrl = serverUrl;
  }

  const username = raw(env, 'OPENCODE_SERVER_USERNAME') ?? 'opencode';
  if (username.includes(':') || /[\u0000-\u001f\u007f]/.test(username)) {
    throw configError('OPENCODE_SERVER_USERNAME', 'must not contain ":" or control characters');
  }
  const password = raw(env, 'OPENCODE_SERVER_PASSWORD');

  const opencodeBin = raw(env, 'OPENCODE_MCP_OPENCODE_BIN') ?? 'opencode';
  const serveArgs = parseSpaceList(env, 'OPENCODE_MCP_SERVE_ARGS');
  validateServeArgs(serveArgs);

  const airgapDefaults = parseBool(env, 'OPENCODE_MCP_AIRGAP', true);
  const childEnvAllowlist = parseCommaList(env, 'OPENCODE_MCP_CHILD_ENV_ALLOWLIST');

  const defaultCwd = resolveDefaultCwd(env, cwd);
  const remotePaths = parseBool(env, 'OPENCODE_MCP_REMOTE_PATHS', false);
  const allowedRoots = resolveAllowedRoots(env, defaultCwd, remotePaths);

  const defaultModel = raw(env, 'OPENCODE_MCP_DEFAULT_MODEL');
  if (defaultModel !== undefined) {
    const separator = defaultModel.indexOf('/');
    if (separator <= 0 || separator === defaultModel.length - 1) {
      throw configError('OPENCODE_MCP_DEFAULT_MODEL', 'must use provider/model format');
    }
  }
  const defaultAgent = raw(env, 'OPENCODE_MCP_DEFAULT_AGENT');
  const defaultSandbox = parseEnum(env, 'OPENCODE_MCP_DEFAULT_SANDBOX', SANDBOXES, 'workspace-write');
  const defaultApprovalPolicy = parseEnum(
    env,
    'OPENCODE_MCP_DEFAULT_APPROVAL_POLICY',
    APPROVAL_POLICIES,
    'never',
  );

  const turnTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_TURN_TIMEOUT_SECONDS', 3600);
  const maxTurnTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS', 21600);
  if (maxTurnTimeoutMs < turnTimeoutMs) {
    throw configError(
      'OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS',
      'must be >= OPENCODE_MCP_TURN_TIMEOUT_SECONDS',
    );
  }

  const approvalTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS', 600);
  const startupTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_STARTUP_TIMEOUT_SECONDS', 60);
  const requestTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_REQUEST_TIMEOUT_SECONDS', 30);
  const cleanupTimeoutMs = parseSecondsToMs(env, 'OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS', 15);
  const heartbeatMs = parseSecondsToMs(env, 'OPENCODE_MCP_HEARTBEAT_SECONDS', 15);
  if (heartbeatMs > 600_000) {
    throw configError('OPENCODE_MCP_HEARTBEAT_SECONDS', 'must not exceed 600 seconds');
  }
  const statusPollMs = parseSecondsToMs(env, 'OPENCODE_MCP_STATUS_POLL_SECONDS', 30);
  const sseStallMs = parseSecondsToMs(env, 'OPENCODE_MCP_SSE_STALL_SECONDS', 35);

  const maxOutputChars = parsePositiveInt(env, 'OPENCODE_MCP_MAX_OUTPUT_CHARS', 20000);

  // overload design §C "HTTP retry policy": bounded admission GET retries only; counts the
  // initial attempt (1 = no retries, 3 = up to two retries).
  const readRetryAttempts = parseIntInRange(env, 'OPENCODE_MCP_READ_RETRY_ATTEMPTS', 3, 1, 3);

  // Response-loop watchdog (see docs/design.md §12): consecutive unproductive assistant attempts
  // (within a fixed 10s detection window) before the turn is stopped as UPSTREAM_RESPONSE_LOOP.
  const responseLoopLimit = parseResponseLoopLimit(env, 'OPENCODE_MCP_RESPONSE_LOOP_LIMIT', 6);

  const maxSessions = parsePositiveInt(env, 'OPENCODE_MCP_MAX_SESSIONS', 256);
  if (maxSessions > 10000) throw configError('OPENCODE_MCP_MAX_SESSIONS', 'must not exceed 10000');

  const endAction = parseEnum(env, 'OPENCODE_MCP_END_ACTION', END_ACTIONS, 'delete');
  const onExit = parseEnum(env, 'OPENCODE_MCP_ON_EXIT', ON_EXITS, 'abort');
  const logLevel = parseEnum(env, 'OPENCODE_MCP_LOG_LEVEL', LOG_LEVELS, 'info');

  const config: Config = {
    mode,
    serverUrl: resolvedServerUrl,
    allowInsecureHttp,
    username,
    password,
    opencodeBin,
    serveArgs,
    airgapDefaults,
    childEnvAllowlist,
    startupTimeoutMs,
    requestTimeoutMs,
    defaultCwd,
    allowedRoots,
    remotePaths,
    defaultModel,
    defaultAgent,
    defaultSandbox,
    defaultApprovalPolicy,
    turnTimeoutMs,
    maxTurnTimeoutMs,
    approvalTimeoutMs,
    heartbeatMs,
    statusPollMs,
    sseStallMs,
    cleanupTimeoutMs,
    maxOutputChars,
    readRetryAttempts,
    responseLoopLimit,
    maxSessions,
    endAction,
    onExit,
    logLevel,
  };

  return config;
}
