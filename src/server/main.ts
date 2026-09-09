import { serve, upgradeWebSocket } from '@hono/node-server';
import type { WebSocketServerLike } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  ConfigError,
  checkEnvironment,
  formatConfigIssues,
  loadConfig,
  resolveConfigPath,
} from '../core/config.js';
import type { Config } from '../core/types.js';
import { createApp } from './app.js';
import { buildConnectors, buildWorkspaceRuntime } from './connectors.js';
import { SessionManager, consoleLogger, readDerivedCacheTtlSeconds } from './session-manager.js';
import { Store } from './store.js';

/**
 * Loads the configuration, printing the issue list and exiting on failure.
 *
 * @param path - Absolute path of the configuration file.
 * @param home - Home directory used to expand `~`.
 * @returns The validated configuration.
 * @throws {Error} When loading fails for a reason that is not a `ConfigError`.
 */
function loadOrExit(path: string, home: string): Config {
  try {
    return loadConfig(path, { home });
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    console.error(cause.message);
    console.error(formatConfigIssues(cause.issues));
    return process.exit(1);
  }
}

/**
 * Boots the dashboard: configuration, store, connectors, manager and server.
 *
 * @returns Nothing, once the server is listening.
 * @throws {Error} When the store or a connector cannot be built.
 */
async function main(): Promise<void> {
  const home = homedir();
  const configPath = resolveConfigPath(process.env, home);
  const config = loadOrExit(configPath, home);
  for (const warning of checkEnvironment(config, process.env)) {
    console.warn(`warning: ${warning}`);
  }

  const store = new Store(config.dataDir);
  await store.load();

  const { runner, repos, workspaces } = buildConnectors(config, home);
  const manager = new SessionManager({
    config,
    configPath,
    store,
    runner,
    workspaces,
    createRuntime: (next, workspaceId) => buildWorkspaceRuntime(next, workspaceId, repos),
    derivedCacheTtlSeconds: readDerivedCacheTtlSeconds(join(home, '.claude', 'settings.json')),
    logger: consoleLogger,
  });
  await manager.start();

  const app = createApp({
    manager,
    logger: consoleLogger,
    upgradeWebSocket,
    webRoot: fileURLToPath(new URL('../web', import.meta.url)),
  });

  const websocketServer = new WebSocketServer({ noServer: true });
  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: '127.0.0.1',
      // 'ws' declares noServer as 'boolean | undefined', which the adapter's own
      // 'noServer?: boolean' rejects under exactOptionalPropertyTypes.
      websocket: { server: websocketServer as unknown as WebSocketServerLike },
    },
    (info) => {
      console.log(`questionable-choices listening on http://127.0.0.1:${info.port}`);
    },
  );

  const shutdown = (): void => {
    manager.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
