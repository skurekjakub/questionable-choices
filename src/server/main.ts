import { serve, upgradeWebSocket } from '@hono/node-server';
import type { WebSocketServerLike } from '@hono/node-server';
import { realpathSync } from 'node:fs';
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
 * Installs the process-wide handlers of last resort.
 *
 * A rejection that arrives outside the request that caused it — an async spawn
 * error, a socket handler's throw — would otherwise end every session's state
 * tracking at once, and no reconciler can recover a record whose events were
 * never received, so it is logged and swallowed. An uncaught *exception* is
 * different: the process may be mid-invariant, and the reconciler recovers
 * every live record on the next boot, so it is logged and the process exits
 * non-zero for a supervisor to see.
 *
 * @param exit - How to end the process; replaceable in tests.
 * @returns Nothing.
 */
export function guardTheProcess(exit: (code: number) => void = fatalExit): void {
  process.on('uncaughtException', (cause) => {
    console.error(`uncaught exception, exiting: ${messageOf(cause)}`);
    if (cause instanceof Error && cause.stack !== undefined) console.error(cause.stack);
    exit(1);
  });
  process.on('unhandledRejection', (cause) => {
    console.error(`unhandled rejection, still serving: ${messageOf(cause)}`);
  });
}

/**
 * Ends the process after giving stderr a chance to drain.
 *
 * `process.exit` discards buffered output when stderr is a pipe rather than a
 * TTY, which is exactly how a supervisor runs the server, so the message that
 * explains the exit would be the thing lost.
 *
 * @param code - Exit status.
 * @returns Nothing.
 */
export function fatalExit(code: number): void {
  process.exitCode = code;
  process.stderr.write('', () => {
    process.exit(code);
  });
}

/**
 * Builds the handler that answers a failure of the listening socket.
 *
 * @param port - Port the server was asked to listen on, named in the message.
 * @param exit - How to end the process; replaceable in tests.
 * @returns The handler.
 */
export function listenErrorHandler(
  port: number,
  exit: (code: number) => void = fatalExit,
): (cause: NodeJS.ErrnoException) => void {
  return (cause) => {
    // Every listen error is fatal: without a socket the process serves nothing,
    // and the signal handlers below keep the event loop referenced, so a
    // re-throw would leave a live process a supervisor cannot detect.
    const detail =
      cause.code === 'EADDRINUSE'
        ? `port ${String(port)} is already in use; stop the other server or change 'port'`
        : `cannot listen on 127.0.0.1:${String(port)}: ${messageOf(cause)}`;
    console.error(detail);
    exit(1);
  };
}

/**
 * Boots the dashboard: configuration, store, connectors, manager and server.
 *
 * @returns Nothing, once the server is listening.
 * @throws {Error} When the store or a connector cannot be built.
 */
export async function main(): Promise<void> {
  guardTheProcess();
  const home = homedir();
  const configPath = resolveConfigPath(process.env, home);
  const config = loadOrExit(configPath, home);
  for (const warning of checkEnvironment(config, process.env)) {
    console.warn(`warning: ${warning}`);
  }

  const store = new Store(config.dataDir);
  await store.load();

  const { runner, repos, workspaces } = buildConnectors(config, home, (sessionId) =>
    store.sessionDir(sessionId),
  );
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
  server.on('error', listenErrorHandler(config.port));

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

/**
 * Reports whether this module is the one the process was started with.
 *
 * Importing the module — which a test must do to reach anything in it — has to
 * be free of side effects, so the boot below is gated on being the entry point
 * rather than running on every import.
 *
 * @returns True when `process.argv[1]` resolves to this file.
 */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isProcessEntry()) await main();
