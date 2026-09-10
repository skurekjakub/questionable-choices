import type { upgradeWebSocket } from '@hono/node-server';
import type { WebSocketLike } from '@hono/node-server';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { EventFrame, TerminalClientFrame, TerminalServerFrame } from '../core/api.js';
import type { Runner, RunnerTerminal } from '../core/types.js';
import type { Logger, SessionManager } from './session-manager.js';
import { messageOf } from './util.js';

/**
 * The node adapter's `upgradeWebSocket`, taken as a dependency so an app can be
 * built without a WebSocket server.
 */
export type UpgradeWebSocketFn = typeof upgradeWebSocket;

/**
 * A live viewer socket, as the node adapter hands it to the event callbacks.
 */
type Socket = WSContext<WebSocketLike>;

/**
 * Columns assumed when a viewer connects without a `cols` query parameter.
 */
export const DEFAULT_COLS = 220;

/**
 * Rows assumed when a viewer connects without a `rows` query parameter.
 */
export const DEFAULT_ROWS = 50;

/**
 * Bytes a viewer's socket may have queued before pty output is dropped.
 */
export const TERMINAL_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * What the WebSocket routes need.
 */
export interface WebSocketRoutesDeps {
  /** Manager supplying boards and the fan-out subscription. */
  manager: SessionManager;
  /** Runner the terminal sockets attach through. */
  runner: Runner;
  /** The node adapter's WebSocket upgrade helper. */
  upgradeWebSocket: UpgradeWebSocketFn;
  /** Diagnostics sink. */
  logger: Logger;
}

/**
 * Reads a positive terminal dimension out of a query parameter.
 *
 * @param raw - The query parameter, or undefined when absent.
 * @param fallback - Value used when the parameter is absent or unusable.
 * @returns A dimension between 1 and 1000.
 */
function dimension(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return fallback;
  return parsed;
}

/**
 * Sends a JSON control frame if the socket is still open.
 *
 * @param ws - The viewer socket.
 * @param frame - The frame to send.
 * @returns Nothing.
 */
function sendJson(ws: Socket, frame: TerminalServerFrame | EventFrame): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(frame));
}

/**
 * Bytes a socket has accepted but not yet put on the wire.
 *
 * @param ws - The viewer socket.
 * @returns The queued byte count, or 0 when the adapter does not report one.
 */
function bufferedBytes(ws: Socket): number {
  const buffered = (ws.raw as { bufferedAmount?: unknown } | undefined)?.bufferedAmount;
  return typeof buffered === 'number' ? buffered : 0;
}

/**
 * Applies one text frame from a viewer.
 *
 * @param terminal - The attached terminal.
 * @param text - The frame's payload.
 * @returns Nothing.
 */
function applyClientFrame(terminal: RunnerTerminal, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const frame = parsed as Partial<TerminalClientFrame>;
  if (frame.type !== 'resize') return;
  const cols = dimension(String(frame.cols), 0);
  const rows = dimension(String(frame.rows), 0);
  if (cols === 0 || rows === 0) return;
  terminal.resize(cols, rows);
}

/**
 * Registers `/ws/terminal/:sessionId` and `/ws/events`.
 *
 * On the terminal socket, binary frames carry pty bytes in both directions and
 * text frames carry the client's `{"type":"resize"}` control frame. On the
 * events socket the server pushes one board frame per workspace on connect and
 * then every frame the manager fans out.
 *
 * @param app - App to register the routes on.
 * @param deps - Manager, runner, upgrade helper and logger.
 * @returns Nothing.
 */
export function registerWebSocketRoutes(app: Hono, deps: WebSocketRoutesDeps): void {
  const { manager, runner, logger } = deps;

  app.get(
    '/ws/terminal/:sessionId',
    deps.upgradeWebSocket((c) => {
      // The upgrade helper hands over an untyped context, so the path
      // parameter is optional here even though the route always supplies it.
      const sessionId = c.req.param('sessionId') ?? '';
      const cols = dimension(c.req.query('cols'), DEFAULT_COLS);
      const rows = dimension(c.req.query('rows'), DEFAULT_ROWS);
      let terminal: RunnerTerminal | null = null;
      let closed = false;
      // Frames can arrive before the pty exists, so every action is chained on
      // the attach promise: chaining also keeps the writes in arrival order.
      let queue: Promise<void> = Promise.resolve();

      // A rejected link would make every later `.then` skip its work, so the
      // socket would silently accept no more input for the rest of its life.
      const chain = (work: () => void | Promise<void>): void => {
        queue = queue.then(work).catch((cause: unknown) => {
          logger.warn(`terminal socket for ${sessionId} dropped a frame: ${messageOf(cause)}`);
        });
      };

      const withTerminal = (action: (attached: RunnerTerminal) => void): void => {
        chain(() => {
          // `teardown` nulls the terminal in the same statement that closes the
          // socket, so a non-null terminal is by itself proof it is still open.
          if (terminal !== null) action(terminal);
        });
      };

      const teardown = (): void => {
        closed = true;
        const attached = terminal;
        terminal = null;
        // Disposing detaches this viewer only; tmux keeps the session running.
        if (attached !== null) attached.dispose();
      };

      return {
        onOpen(_event, ws) {
          // Through `chain` like every other link: an unguarded attach that
          // rejected would leave the queue rejected, so the first frame after
          // it would be dropped by the guard the other links share.
          chain(async () => {
            if (!manager.hasSession(sessionId)) {
              const message = `unknown session '${sessionId}'`;
              logger.warn(`terminal socket for ${message}`);
              sendJson(ws, { type: 'error', message });
              ws.close(1008, 'unknown session');
              return;
            }
            let attached: RunnerTerminal;
            try {
              attached = await runner.attach(sessionId, cols, rows);
            } catch (cause) {
              const message = messageOf(cause);
              logger.error(`cannot attach to ${sessionId}: ${message}`);
              sendJson(ws, { type: 'error', message });
              ws.close(1011, 'attach failed');
              return;
            }
            if (closed) {
              attached.dispose();
              return;
            }
            terminal = attached;
            attached.onData((chunk) => {
              if (ws.readyState !== 1) return;
              // A viewer that stops reading must not let the pty's output grow
              // in the server's heap; a terminal repaints itself anyway.
              if (bufferedBytes(ws) > TERMINAL_BUFFER_LIMIT_BYTES) return;
              ws.send(encoder.encode(chunk));
            });
            attached.onExit((exitCode) => {
              sendJson(ws, { type: 'exit', exitCode });
              ws.close(1000, 'terminal exited');
            });
          });
        },

        onError(_event, ws) {
          logger.warn(`terminal socket for ${sessionId} errored`);
          teardown();
          ws.close(1011, 'socket error');
        },

        onMessage(event) {
          const data = event.data;
          if (typeof data === 'string') {
            withTerminal((attached) => applyClientFrame(attached, data));
            return;
          }
          if (data instanceof Blob) {
            chain(async () => {
              const buffer = await data.arrayBuffer();
              if (terminal !== null && !closed) terminal.write(decoder.decode(buffer));
            });
            return;
          }
          const text = decoder.decode(new Uint8Array(data));
          withTerminal((attached) => attached.write(text));
        },

        onClose() {
          teardown();
        },
      };
    }),
  );

  app.get(
    '/ws/events',
    deps.upgradeWebSocket(() => {
      let unsubscribe: (() => void) | null = null;
      const drop = (): void => {
        if (unsubscribe !== null) unsubscribe();
        unsubscribe = null;
      };
      return {
        onOpen(_event, ws) {
          for (const workspaceId of manager.workspaceIds()) {
            sendJson(ws, { type: 'board', workspaceId, view: manager.board(workspaceId) });
          }
          unsubscribe = manager.subscribe((frame) => {
            sendJson(ws, frame);
          });
        },
        onError() {
          logger.warn('events socket errored');
          drop();
        },
        onClose() {
          drop();
        },
      };
    }),
  );
}
