// createMcpServerFactory(engine, config, logger) — one McpServer per pinned connection/era
// (docs/sdk-notes.md: `serveStdio(factory)` calls `factory()` once per connection and reuses
// that instance for the connection's lifetime; register everything inside it).

import { McpServer } from '@modelcontextprotocol/server';

import type { Config, Engine, Logger } from '../types.ts';
import { registerTools, SERVER_INSTRUCTIONS } from './tools.ts';
import { SERVER_VERSION } from '../version.ts';

const SERVER_NAME = 'opencode-mcp';

export function createMcpServerFactory(engine: Engine, config: Config, logger: Logger): () => McpServer {
  return () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, engine, config, logger);
    return server;
  };
}
