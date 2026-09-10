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
import { fatalExit, isProcessEntry, messageOf } from './util.js';

/**
 * Loads the configuration, printing the issue list and exiting on failure.
 *
 * @param path - Absolute path of the configuration file.
 * @param home - Home directory used to expand `~`.
 * @returns The validated configuration, or a promise that never settles once
 *   the exit has been scheduled, so the failure is reported exactly once.
 * @throws {Error} When loading fails for a reason that is not a `ConfigError`.
 */
async function loadOrExit(path: string, home: string): Promise<Config> {
  try {
    return loadConfig(path, { home });
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    console.error(cause.message);
    console.error(formatConfigIssues(cause.issues));
    // A long zod issue list is the one output that can exceed the pipe buffer,
    // and it is the whole reason the process is exiting.
    fatalExit(1);
    // `fatalExit` schedules the exit behind a stream drain and returns, so the
    // boot has to stop here rather than fall through or re-throw: the caller's
    // own catch would print the same failure underneath the issue list.
    return new Promise<never>(() => undefined);
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
 * Milliseconds a shutdown waits for the store's write queue before exiting.
 */
export const FLUSH_DEADLINE_MS = 2000;

/**
 * A socket a shutdown has to drop before the HTTP server can close.
 */
interface TerminableSocket {
  /** Drops the connection without waiting for a close handshake. */
  terminate: () => void;
}

/**
 * Everything a shutdown closes, drains or ends.
 */
export interface ShutdownTargets {
  /** Manager whose refresh timers stop first. */
  manager: { stop: () => void };
  /** Store whose queued writes are drained before the process ends. */
  store: { flush: () => Promise<void> };
  /** The listening HTTP server. */
  server: {
    /** Stops accepting connections and calls back once the last one is gone. */
    close: (callback: () => void) => void;
    /** Drops idle keep-alive sockets; absent on the HTTP/2 server. */
    closeAllConnections?: (() => void) | undefined;
  };
  /** WebSocket server whose clients would otherwise hold the close open. */
  websocketServer: { clients: Iterable<TerminableSocket>; close: () => void };
  /** How to end the process; replaceable in tests. */
  exit?: ((code: number) => void) | undefined;
  /** How long to wait for the store's queue, in milliseconds. */
  flushDeadlineMs?: number | undefined;
}

/**
 * Closes the server, drains the store's write queue and ends the process.
 *
 * The drain is bounded: a write wedged on a slow filesystem would otherwise
 * hold the process open indefinitely, and both signals that could interrupt the
 * wait are handled, so nothing short of SIGKILL would end it.
 *
 * @param targets - The manager, store, HTTP server and WebSocket server to
 *   close, plus the exit function and flush deadline to use.
 * @returns Nothing, once the exit has been requested.
 */
export async function shutdown(targets: ShutdownTargets): Promise<void> {
  const { manager, store, server, websocketServer } = targets;
  const exit = targets.exit ?? ((code: number) => process.exit(code));
  const flushDeadlineMs = targets.flushDeadlineMs ?? FLUSH_DEADLINE_MS;

  manager.stop();
  // `server.close` waits for every open connection, and an attached browser
  // holds its event socket — plus one terminal socket per open session view —
  // for as long as the tab lives, so without this the process never exits.
  for (const client of websocketServer.clients) client.terminate();
  websocketServer.close();
  // Idle keep-alive sockets hold the close open too, and only the HTTP/1
  // member of the adapter's server union offers a way to drop them.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  // A hook answered 204 has its write on the store's queue; exiting before the
  // queue drains loses the record change it was answered for.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    store.flush().then(
      () => true,
      (cause: unknown) => {
        console.error(`a queued write did not finish: ${messageOf(cause)}`);
        return true;
      },
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, flushDeadlineMs);
    }),
  ]);
  clearTimeout(timer);
  if (!drained) {
    console.error(
      `queued writes did not drain within ${String(flushDeadlineMs)} ms; exiting anyway`,
    );
  }
  exit(0);
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
  const config = await loadOrExit(configPath, home);
  for (const warning of checkEnvironment(config, process.env)) {
    console.warn(`warning: ${warning}`);
  }

  const store = new Store(config.dataDir, (message) => {
    consoleLogger.warn(message);
  });
  await store.load();

  const { runner, repos, workspaces } = buildConnectors(config, home, (sessionId) =>
    store.sessionDir(sessionId),
  );
  const claudeSettingsPath = join(home, '.claude', 'settings.json');
  const manager = new SessionManager({
    config,
    configPath,
    store,
    runner,
    workspaces,
    createRuntime: (next, workspaceId) => buildWorkspaceRuntime(next, workspaceId, repos),
    derivedCacheTtlSeconds: readDerivedCacheTtlSeconds(claudeSettingsPath),
    claudeSettingsPath,
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

  const onSignal = (): void => {
    void shutdown({ manager, store, server, websocketServer });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (isProcessEntry(import.meta.url)) {
  // A boot that never gets as far as listening must exit non-zero: the
  // unhandledRejection handler would otherwise print "still serving" about a
  // process that serves nothing and then exit 0 for a supervisor to read as ok.
  await main().catch((cause: unknown) => {
    console.error(`questionable-choices failed to start: ${messageOf(cause)}`);
    fatalExit(1);
  });
}
