// Fully in-memory fakes of startManagedServer/createOpencodeApi, for unit-testing
// src/opencode/connection.ts's own logic (generation bookkeeping, shared in-flight starts,
// onUnavailable, close()) without spawning any real process or opening any real socket.

import type { ManagedServer } from '../../../src/opencode/managed-server.ts';
import type { startManagedServer } from '../../../src/opencode/managed-server.ts';
import type { createOpencodeApi } from '../../../src/opencode/http.ts';
import type { OpencodeApi } from '../../../src/types.ts';

export interface FakeManagedServerHandle {
  server: ManagedServer;
  stopCalls: number;
  resolveExit(result: { code: number | null; signal: NodeJS.Signals | null }): void;
}

export function makeFakeManagedServer(url = 'http://127.0.0.1:1'): FakeManagedServerHandle {
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const handle: FakeManagedServerHandle = {
    stopCalls: 0,
    resolveExit,
    server: {
      url,
      pid: 4242,
      exited,
      async stop() {
        handle.stopCalls += 1;
      },
    },
  };
  return handle;
}

/** A stub satisfying OpencodeApi where only `.health()` is meaningful; every other method throws
 * if a test accidentally exercises it (connection.ts itself only ever calls `.health()`). */
export function makeStubApi(health: () => Promise<{ healthy: boolean; version: string }>): OpencodeApi {
  const notImplemented = (name: string) => async () => {
    throw new Error(`fake OpencodeApi.${name} should not be called by connection.ts`);
  };
  return {
    health,
    createSession: notImplemented('createSession'),
    getSession: notImplemented('getSession'),
    promptAsync: notImplemented('promptAsync'),
    abort: notImplemented('abort'),
    deleteSession: notImplemented('deleteSession'),
    archiveSession: notImplemented('archiveSession'),
    messages: notImplemented('messages'),
    sessionDiff: notImplemented('sessionDiff'),
    providerCatalog: notImplemented('providerCatalog'),
    agentCatalog: notImplemented('agentCatalog'),
    sessionStatus: notImplemented('sessionStatus'),
    listPermissions: notImplemented('listPermissions'),
    replyPermission: notImplemented('replyPermission'),
    listQuestions: notImplemented('listQuestions'),
    rejectQuestion: notImplemented('rejectQuestion'),
    warmInstance: notImplemented('warmInstance'),
    disposeInstance: notImplemented('disposeInstance'),
    subscribe: () => {
      throw new Error('fake OpencodeApi.subscribe should not be called by connection.ts');
    },
  } satisfies OpencodeApi;
}

export type StartManagedServerFn = typeof startManagedServer;
export type CreateOpencodeApiFn = typeof createOpencodeApi;
