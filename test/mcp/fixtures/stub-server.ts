// Spawned as a real child process by test/mcp/*.test.ts (never imported in-process): runs the
// real src/index.ts `main()` wiring (config -> logger -> serveStdio -> signals) with a scripted
// StubEngine injected in place of the real opencode connection/engine, so the tests exercise the
// genuine stdio transport, signal handling and shutdown path end to end.

import { main } from '../../../src/index.ts';
import { createStubEngine } from '../support/stub-engine.ts';
import type { Connection, Engine, EngineDeps } from '../../../src/types.ts';

const engine = createStubEngine();

const stubConnection: Connection = {
  acquire: async () => {
    throw new Error('stub-server fixture: connection.acquire should never be called');
  },
  current: () => undefined,
  invalidate: async () => {},
  onUnavailable: () => () => {},
  close: async () => {},
};

void main({
  createConnection: async (): Promise<Connection> => stubConnection,
  createEngine: async (_deps: EngineDeps): Promise<Engine> => engine,
});
