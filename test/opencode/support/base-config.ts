import type { Config } from '../../../src/types.ts';

/** A complete, valid Config for tests to override piecemeal with `{ ...baseConfig(), foo: 1 }`. */
export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: 'managed',
    allowInsecureHttp: false,
    username: 'opencode',
    opencodeBin: 'opencode',
    serveArgs: [],
    airgapDefaults: false,
    childEnvAllowlist: [],
    startupTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    defaultCwd: '/tmp',
    allowedRoots: ['/tmp'],
    remotePaths: false,
    defaultSandbox: 'workspace-write',
    defaultApprovalPolicy: 'never',
    turnTimeoutMs: 3600_000,
    maxTurnTimeoutMs: 21_600_000,
    approvalTimeoutMs: 600_000,
    heartbeatMs: 15_000,
    statusPollMs: 30_000,
    sseStallMs: 35_000,
    cleanupTimeoutMs: 15_000,
    maxOutputChars: 20_000,
    readRetryAttempts: 3,
    responseLoopLimit: 6,
    maxSessions: 256,
    endAction: 'delete',
    onExit: 'abort',
    logLevel: 'info',
    ...overrides,
  };
}
