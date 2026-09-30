// Spawned as a real child process (never imported in-process), like fixtures/stub-server.ts, but
// the injected engine deliberately lacks output/info/statusMany — proving src/mcp/tools.ts's
// "the engine lacks a method" fallback (INTERNAL "not available in this build") without needing a
// second hand-written fake Engine implementation.

import { main } from '../../../src/index.ts';
import { createStubEngine } from '../support/stub-engine.ts';
import type { Connection, Engine, EngineDeps } from '../../../src/types.ts';

const fullEngine = createStubEngine();
const { output: _output, info: _info, statusMany: _statusMany, ...rest } = fullEngine;
// Deliberately model a legacy runtime implementation for the missing-method fallback test.
const engine = rest as unknown as Engine;

const stubConnection: Connection = {
  acquire: async () => {
    throw new Error('stub-server-no-v03 fixture: connection.acquire should never be called');
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
