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
  resolveConfigPath,
} from '../core/config.js';
import type { Config } from '../core/types.js';
import { createApp } from './app.js';
import { loadConfig } from './config-file.js';
import { buildConnectors, buildWorkspaceRuntime } from './connectors.js';
import { SessionManager, consoleLogger, readDerivedCacheTtlSeconds } from './session-manager.js';
import { Store } from './store.js';
import { messageOf } from './util.js';

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
 * Installs the process-wide handler of last resort.
 *
 * A failure that arrives outside the request that caused it — an async spawn
 * error, a socket handler's throw — would otherwise end every session's state
 * tracking at once, and no reconciler can recover a record whose events were
 * never received. Keeping the process up is worth more than the stack trace an
 * unhandled rejection would print on the way out.
 *
 * @returns Nothing.
 */
function guardTheProcess(): void {
  process.on('uncaughtException', (cause) => {
    console.error(`uncaught exception, still serving: ${messageOf(cause)}`);
    if (cause instanceof Error && cause.stack !== undefined) console.error(cause.stack);
  });
  process.on('unhandledRejection', (cause) => {
    console.error(`unhandled rejection, still serving: ${messageOf(cause)}`);
  });
}

/**
 * Boots the dashboard: configuration, store, connectors, manager and server.
 *
 * @returns Nothing, once the server is listening.
 * @throws {Error} When the store or a connector cannot be built.
 */
async function main(): Promise<void> {
  guardTheProcess();
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
  server.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EADDRINUSE') throw cause;
    console.error(`port ${config.port} is already in use; stop the other server or change 'port'`);
    process.exit(1);
  });

  // The first refresh talks to the tracker, so it runs behind the listening
  // socket: an unreachable tracker must delay a banner, never the dashboard.
  void manager.start().catch((cause: unknown) => {
    console.error(`the first refresh failed: ${messageOf(cause)}`);
  });

  const shutdown = (): void => {
    manager.stop();
    // `server.close` waits for every open connection, and an attached browser
    // holds its event socket — plus one terminal socket per open session view —
    // for as long as the tab lives, so without this the process never exits.
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    // Idle keep-alive sockets hold the close open too, and only the HTTP/1
    // member of the adapter's server union offers a way to drop them.
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
