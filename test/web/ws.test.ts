import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventFrame } from '../../src/core/api.js';
import { boardView, publicConfig } from './fixtures.js';

/**
 * A stand-in for the browser's WebSocket that a test drives by hand.
 */
class FakeSocket {
  /** Every socket the module under test has opened, in order. */
  static readonly opened: FakeSocket[] = [];
  /** URL the module asked to connect to. */
  readonly url: string;
  /** Whether `close()` has been called on this socket. */
  closed = false;
  /** Called once the socket is considered open. */
  onopen: (() => void) | null = null;
  /** Called with each frame delivered to the consumer. */
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Called when the socket closes. */
  onclose: (() => void) | null = null;
  /** Called when the socket errors. */
  onerror: (() => void) | null = null;

  /**
   * Records the connection attempt.
   *
   * @param url - URL the module asked to connect to.
   */
  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  /**
   * Closes the socket, telling the consumer once.
   *
   * @returns Nothing.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /**
   * Delivers one frame to the consumer.
   *
   * @param frame - Frame to deliver, serialised as the server would.
   * @returns Nothing.
   */
  deliver(frame: EventFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/**
 * Builds a board frame for one workspace.
 *
 * @param workspaceId - Workspace the board belongs to.
 * @returns The frame.
 */
function boardFrame(workspaceId: string): EventFrame {
  return { type: 'board', workspaceId, view: boardView(workspaceId) };
}

/**
 * Builds a config frame listing exactly the given workspaces.
 *
 * @param ids - Workspace ids the configuration still names.
 * @returns The frame.
 */
function configFrame(ids: string[]): EventFrame {
  return { type: 'config', config: publicConfig(ids) };
}

/**
 * Loads a fresh copy of the module, so one test's module state cannot leak into
 * the next.
 *
 * @returns The module's exports.
 */
async function loadWs(): Promise<typeof import('../../src/web/src/ws.js')> {
  vi.resetModules();
  FakeSocket.opened.length = 0;
  return import('../../src/web/src/ws.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    location: { protocol: 'http:', host: '127.0.0.1:5173' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reconnectDelayMs', () => {
  it('walks the backoff ladder one step per attempt', async () => {
    const { reconnectDelayMs } = await loadWs();
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 15000]);
  });

  it('holds at the longest step once the ladder is exhausted', async () => {
    const { reconnectDelayMs } = await loadWs();
    expect(reconnectDelayMs(6)).toBe(15000);
    expect(reconnectDelayMs(400)).toBe(15000);
  });
});

describe('socketUrl', () => {
  it('builds a ws: URL on the serving origin', async () => {
    const { socketUrl } = await loadWs();
    expect(socketUrl('/ws/events')).toBe('ws://127.0.0.1:5173/ws/events');
  });

  it('follows the page onto TLS', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { protocol: 'https:', host: 'dash.example' },
    });
    const { socketUrl } = await loadWs();
    expect(socketUrl('/ws/terminal/qc-1')).toBe('wss://dash.example/ws/terminal/qc-1');
  });
});

describe('subscribeEvents', () => {
  it('opens one socket for every subscriber to share', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    subscribeEvents({ onFrame: () => {} });
    subscribeEvents({ onFrame: () => {} });
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.opened[0]?.url).toBe('ws://127.0.0.1:5173/ws/events');
  });

  it('fans every frame out to every subscriber', async () => {
    const { subscribeEvents } = await loadWs();
    const first: EventFrame[] = [];
    const second: EventFrame[] = [];
    subscribeEvents({ onFrame: (frame) => first.push(frame) });
    subscribeEvents({ onFrame: (frame) => second.push(frame) });
    FakeSocket.opened[0]?.deliver(boardFrame('docs'));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('reports the connection state on subscribe and on every change', async () => {
    const { subscribeEvents } = await loadWs();
    const seen: boolean[] = [];
    subscribeEvents({ onFrame: () => {}, onConnected: (state) => seen.push(state) });
    expect(seen).toEqual([false]);
    FakeSocket.opened[0]?.onopen?.();
    expect(seen).toEqual([false, true]);
    FakeSocket.opened[0]?.close();
    expect(seen).toEqual([false, true, false]);
  });

  it('replays the newest board per workspace to a subscriber that mounts later', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.deliver(boardFrame('docs'));
    FakeSocket.opened[0]?.deliver(boardFrame('migration'));
    const late: EventFrame[] = [];
    subscribeEvents({ onFrame: (frame) => late.push(frame) });
    expect(late.map((frame) => (frame.type === 'board' ? frame.workspaceId : ''))).toEqual([
      'docs',
      'migration',
    ]);
  });

  it('stops replaying the board of a workspace the configuration no longer lists', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.deliver(boardFrame('docs'));
    FakeSocket.opened[0]?.deliver(boardFrame('migration'));
    FakeSocket.opened[0]?.deliver(configFrame(['docs']));
    const late: EventFrame[] = [];
    subscribeEvents({ onFrame: (frame) => late.push(frame) });
    expect(late.map((frame) => (frame.type === 'board' ? frame.workspaceId : ''))).toEqual([
      'docs',
    ]);
  });

  it('ignores a frame that is not JSON rather than tearing the socket down', async () => {
    const { subscribeEvents } = await loadWs();
    const seen: EventFrame[] = [];
    subscribeEvents({ onFrame: (frame) => seen.push(frame) });
    FakeSocket.opened[0]?.onmessage?.({ data: '{ not json' });
    FakeSocket.opened[0]?.onmessage?.({ data: 42 });
    expect(seen).toEqual([]);
    expect(FakeSocket.opened[0]?.closed).toBe(false);
  });

  it('reconnects on the ladder while anyone is still listening', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    FakeSocket.opened[0]?.close();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('waits a longer rung after a second failed reconnect', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    FakeSocket.opened[0]?.close();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.opened).toHaveLength(2);

    // The second socket never opens, so the ladder must not restart at its
    // first rung: a server that is down stays hammered at 2/second otherwise.
    FakeSocket.opened[1]?.close();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.opened).toHaveLength(3);
  });

  it('arms one reconnect timer when a socket closes during a pending backoff', async () => {
    const { subscribeEvents } = await loadWs();
    subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    FakeSocket.opened[0]?.close();
    vi.advanceTimersByTime(100);

    // A second subscriber opens a socket while the first one's backoff is still
    // pending, and that socket can close before the pending timer fires.
    subscribeEvents({ onFrame: () => {} });
    expect(FakeSocket.opened).toHaveLength(2);
    FakeSocket.opened[1]?.close();
    expect(vi.getTimerCount()).toBe(1);

    // The orphaned first timer would fire 400 ms from here and open a socket
    // the newly armed one then opens a second time.
    vi.advanceTimersByTime(400);
    expect(FakeSocket.opened).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.opened).toHaveLength(3);
  });

  it('ignores a close reported by a socket it has already replaced', async () => {
    const { subscribeEvents } = await loadWs();
    const seen: boolean[] = [];
    subscribeEvents({ onFrame: () => {}, onConnected: (state) => seen.push(state) });
    const first = FakeSocket.opened[0];
    first?.onopen?.();
    first?.close();
    vi.advanceTimersByTime(100);
    subscribeEvents({ onFrame: () => {} });
    expect(FakeSocket.opened).toHaveLength(2);

    first?.onclose?.();
    vi.advanceTimersByTime(20_000);
    // Acting on the stale close would drop the reference to the live socket,
    // leaving it open and unreachable while a third one is dialled.
    expect(FakeSocket.opened).toHaveLength(2);
    expect(seen).toEqual([false, true, false]);
  });

  it('keeps the socket open across a remount, and closes it once nobody is left', async () => {
    const { subscribeEvents } = await loadWs();
    const leave = subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    leave();
    vi.advanceTimersByTime(200);
    expect(FakeSocket.opened[0]?.closed).toBe(false);
    subscribeEvents({ onFrame: () => {} });
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.opened[0]?.closed).toBe(false);
  });

  it('closes the idle socket and forgets the boards it cached', async () => {
    const { subscribeEvents } = await loadWs();
    const leave = subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    FakeSocket.opened[0]?.deliver(boardFrame('docs'));
    leave();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.opened[0]?.closed).toBe(true);

    const late: EventFrame[] = [];
    subscribeEvents({ onFrame: (frame) => late.push(frame) });
    expect(late).toEqual([]);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('does not reconnect after the last subscriber has left', async () => {
    const { subscribeEvents } = await loadWs();
    const leave = subscribeEvents({ onFrame: () => {} });
    FakeSocket.opened[0]?.onopen?.();
    leave();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.opened).toHaveLength(1);
  });
});
