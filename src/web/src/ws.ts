import type { EventFrame } from '../../core/api.js';
import type { BoardFrame } from './model.js';

/**
 * Reconnect delays in milliseconds, walked in order and then held at the last.
 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * How long the shared socket stays open after the last subscriber leaves.
 */
const IDLE_CLOSE_MS = 250;

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
 * Delay before the reconnect attempt with the given index.
 *
 * @param attempt - Number of attempts already made, starting at zero.
 * @returns The delay in milliseconds, held at the longest step once exhausted.
 */
export function reconnectDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
}

/**
 * Callbacks a caller of {@link subscribeEvents} supplies.
 */
export interface EventSubscriber {
  /** Called with each frame the server pushes, and with replayed board frames. */
  onFrame: (frame: EventFrame) => void;
  /** Called with the connection state on subscribe and on every change. */
  onConnected?: (connected: boolean) => void;
}

/**
 * Everyone currently listening to the shared stream.
 */
const subscribers = new Set<EventSubscriber>();

/**
 * The newest board frame seen per workspace, replayed to late subscribers.
 */
const latestBoards = new Map<string, BoardFrame>();

/**
 * The shared socket, or null while it is closed or reconnecting.
 */
let socket: WebSocket | null = null;

/**
 * Handle of the pending reconnect timer, or undefined when none is armed.
 */
let reconnectTimer: number | undefined;

/**
 * Handle of the pending idle-close timer, or undefined when none is armed.
 */
let idleTimer: number | undefined;

/**
 * Reconnect attempts made since the last successful open.
 */
let attempt = 0;

/**
 * Whether the shared socket is currently open.
 */
let connected = false;

/**
 * Reports the connection state to every subscriber.
 *
 * @param next - Whether the shared socket is open.
 * @returns Nothing.
 */
function announceConnected(next: boolean): void {
  connected = next;
  for (const subscriber of [...subscribers]) subscriber.onConnected?.(next);
}

/**
 * Fans one frame out to every subscriber, caching board frames for replay.
 *
 * @param frame - Frame the server pushed.
 * @returns Nothing.
 */
function dispatch(frame: EventFrame): void {
  if (frame.type === 'board') latestBoards.set(frame.workspaceId, frame);
  for (const subscriber of [...subscribers]) subscriber.onFrame(frame);
}

/**
 * Opens the shared socket unless one is already open or nobody is listening.
 *
 * @returns Nothing.
 */
function open(): void {
  if (socket !== null || subscribers.size === 0) return;
  const next = new WebSocket(socketUrl('/ws/events'));
  socket = next;
  next.onopen = () => {
    attempt = 0;
    announceConnected(true);
  };
  next.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== 'string') return;
    let frame: EventFrame;
    try {
      frame = JSON.parse(event.data) as EventFrame;
    } catch {
      // A malformed frame must not tear down a socket that is otherwise healthy.
      return;
    }
    dispatch(frame);
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    announceConnected(false);
    if (subscribers.size === 0) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, reconnectDelayMs(attempt));
    attempt += 1;
  };
  next.onerror = () => next.close();
}

/**
 * Closes the shared socket and forgets everything cached about the stream.
 *
 * @returns Nothing.
 */
function teardown(): void {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  attempt = 0;
  connected = false;
  latestBoards.clear();
  const closing = socket;
  socket = null;
  closing?.close();
}

/**
 * Joins the shared board event stream, which every hook multiplexes over one
 * socket rather than opening its own.
 *
 * The subscriber is told the current connection state immediately and replayed
 * the newest board frame per workspace, so a hook that mounts between pushes
 * renders without waiting for the next one.
 *
 * @param subscriber - Frame and connection-state callbacks.
 * @returns A function that leaves the stream.
 */
export function subscribeEvents(subscriber: EventSubscriber): () => void {
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  subscribers.add(subscriber);
  subscriber.onConnected?.(connected);
  for (const frame of latestBoards.values()) subscriber.onFrame(frame);
  open();

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    // Strict mode remounts every hook, so closing at once would churn a socket
    // per mount; the delay lets the remount reuse the one already open.
    idleTimer = window.setTimeout(() => {
      idleTimer = undefined;
      if (subscribers.size === 0) teardown();
    }, IDLE_CLOSE_MS);
  };
}
