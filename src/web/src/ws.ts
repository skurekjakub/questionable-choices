import type { EventFrame } from '../../core/api.js';

/**
 * Reconnect delays in milliseconds, walked in order and then held at the last.
 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * Builds an absolute WebSocket URL for a path on the serving origin.
 *
 * @param path - Path below the origin, starting with `/ws`.
 * @returns The `ws:` or `wss:` URL to connect to.
 */
export function socketUrl(path: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${path}`;
}

/**
 * Callbacks a caller of {@link connectEvents} supplies.
 */
export interface EventStreamHandlers {
  /** Called with each frame the server pushes. */
  onFrame: (frame: EventFrame) => void;
  /** Called whenever the connection opens or drops. */
  onConnected?: (connected: boolean) => void;
}

/**
 * Opens the board event stream and keeps it open, reconnecting with backoff.
 *
 * Frames that do not parse as JSON are dropped rather than surfaced, because a
 * malformed frame must not tear down a socket that is otherwise healthy.
 *
 * @param handlers - Frame and connection-state callbacks.
 * @returns A function that closes the stream and stops reconnecting.
 */
export function connectEvents(handlers: EventStreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let attempt = 0;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    const next = new WebSocket(socketUrl('/ws/events'));
    socket = next;
    next.onopen = () => {
      attempt = 0;
      handlers.onConnected?.(true);
    };
    next.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      try {
        handlers.onFrame(JSON.parse(event.data) as EventFrame);
      } catch {
        return;
      }
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      handlers.onConnected?.(false);
      if (closed) return;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
      attempt += 1;
      timer = window.setTimeout(open, delay);
    };
    next.onerror = () => next.close();
  };

  open();

  return () => {
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
