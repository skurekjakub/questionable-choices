import type { upgradeWebSocket } from '@hono/node-server';
import type { WebSocketLike } from '@hono/node-server';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { EventFrame, TerminalServerFrame } from '../core/api.js';
import type { Runner, RunnerTerminal } from '../core/types.js';
import type { Logger, SessionManager } from './session-manager.js';

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
  const frame = parsed as Record<string, unknown>;
  if (frame['type'] !== 'resize') return;
  const cols = dimension(String(frame['cols']), 0);
  const rows = dimension(String(frame['rows']), 0);
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

      const withTerminal = (action: (attached: RunnerTerminal) => void): void => {
        queue = queue.then(() => {
          if (terminal !== null && !closed) action(terminal);
        });
      };

      return {
        onOpen(_event, ws) {
          queue = (async () => {
            let attached: RunnerTerminal;
            try {
              attached = await runner.attach(sessionId, cols, rows);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
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
              if (ws.readyState === 1) ws.send(encoder.encode(chunk));
            });
            attached.onExit((exitCode) => {
              sendJson(ws, { type: 'exit', exitCode });
              ws.close(1000, 'terminal exited');
            });
          })();
        },

        onMessage(event) {
          const data = event.data;
          if (typeof data === 'string') {
            withTerminal((attached) => applyClientFrame(attached, data));
            return;
          }
          if (data instanceof Blob) {
            queue = queue.then(async () => {
              const buffer = await data.arrayBuffer();
              if (terminal !== null && !closed) terminal.write(decoder.decode(buffer));
            });
            return;
          }
          const text = decoder.decode(new Uint8Array(data));
          withTerminal((attached) => attached.write(text));
        },

        onClose() {
          closed = true;
          const attached = terminal;
          terminal = null;
          // Disposing detaches this viewer only; tmux keeps the session running.
          if (attached !== null) attached.dispose();
        },
      };
    }),
  );

  app.get(
    '/ws/events',
    deps.upgradeWebSocket(() => {
      let unsubscribe: (() => void) | null = null;
      return {
        onOpen(_event, ws) {
          for (const workspaceId of manager.workspaceIds()) {
            sendJson(ws, { type: 'board', workspaceId, view: manager.board(workspaceId) });
          }
          unsubscribe = manager.subscribe((frame) => {
            sendJson(ws, frame);
          });
        },
        onClose() {
          if (unsubscribe !== null) unsubscribe();
          unsubscribe = null;
        },
      };
    }),
  );
}
