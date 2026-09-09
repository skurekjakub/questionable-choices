import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateSessionRequest, EventFrame, TerminalServerFrame } from '../../src/core/api.js';
import { createApp } from '../../src/server/app.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { Store } from '../../src/server/store.js';
import {
  TERMINAL_BUFFER_LIMIT_BYTES,
  type UpgradeWebSocketFn,
} from '../../src/server/terminal-ws.js';
import { makeIssue } from '../core/helpers.js';
import {
  FakeIssueSource,
  FakeRepo,
  FakeRunner,
  FakeTerminal,
  RecordingLogger,
  makeConfig,
  makeRuntime,
} from './fakes.js';

const SESSION_ID = 'qc-DOC-1-implement';

const START: CreateSessionRequest = {
  playbookId: 'implement',
  prompt: 'Work on DOC-1',
  model: 'claude-fable-5-1',
  effort: 'high',
  permissionMode: 'acceptEdits',
};

/**
 * The three callbacks the adapter would drive from a real socket.
 */
interface SocketHandlers {
  /** Called once the upgrade completed. */
  onOpen?: ((event: Event, ws: WSContext<unknown>) => void) | undefined;
  /** Called for each frame the viewer sent. */
  onMessage?: ((event: MessageEvent, ws: WSContext<unknown>) => void) | undefined;
  /** Called when the socket errored. */
  onError?: ((event: Event, ws: WSContext<unknown>) => void) | undefined;
  /** Called when the socket closed. */
  onClose?: ((event: CloseEvent, ws: WSContext<unknown>) => void) | undefined;
}

/**
 * A viewer socket that records what the server sent it.
 */
class FakeSocket {
  /** Text frames the server sent, in order. */
  readonly texts: string[] = [];
  /** Binary frames the server sent, in order. */
  readonly binaries: Uint8Array[] = [];
  /** Every close the server asked for, in order. */
  readonly closes: Array<{ code: number; reason: string }> = [];
  /** Whether the socket is open; 1 is the WebSocket OPEN state. */
  readyState = 1;
  /** Adapter-level socket, whose queued byte count the server reads. */
  readonly raw = { bufferedAmount: 0 };

  /**
   * Records one frame.
   *
   * @param data - Text or bytes the server sent.
   * @returns Nothing.
   */
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.texts.push(data);
    else this.binaries.push(data);
  }

  /**
   * Records a close and marks the socket shut.
   *
   * @param code - Close code.
   * @param reason - Close reason.
   * @returns Nothing.
   */
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  /**
   * Reads the frames the server sent as parsed control frames.
   *
   * @returns One parsed frame per text frame.
   */
  frames(): Array<TerminalServerFrame | EventFrame> {
    return this.texts.map((text) => JSON.parse(text) as TerminalServerFrame | EventFrame);
  }

  /**
   * Presents the socket as the context the route callbacks take.
   *
   * @returns The socket, typed as the adapter's context.
   */
  asContext(): WSContext<unknown> {
    return this as unknown as WSContext<unknown>;
  }
}

/**
 * Lets every queued microtask and timer-free promise settle.
 *
 * @returns Nothing.
 */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WebSocket routes', () => {
  let dir: string;
  let app: Hono;
  let runner: FakeRunner;
  let manager: SessionManager;
  let logger: RecordingLogger;
  let handlers: SocketHandlers;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qc-ws-'));
    const config = makeConfig(dir);
    const store = new Store(dir);
    await store.load();
    logger = new RecordingLogger();
    runner = new FakeRunner();
    const source = new FakeIssueSource('ws', [makeIssue()]);
    const repo = new FakeRepo('app', {
      cwd: '/repos/worktrees/DOC-1',
      branch: 'DOC-1-document-the-thing',
      needsBootstrap: false,
    });
    manager = new SessionManager({
      config,
      configPath: join(dir, 'config.json'),
      store,
      runner,
      workspaces: [makeRuntime(config, 'ws', source, repo)],
      createRuntime: (next, workspaceId) => makeRuntime(next, workspaceId, source, repo),
      derivedCacheTtlSeconds: 300,
      logger,
    });
    await manager.refresh('ws');
    await manager.startSession('ws', 'DOC-1', START);

    handlers = {};
    // The adapter's upgrade helper is the seam: capturing the callbacks it is
    // handed is what lets a test drive a socket with no socket.
    const upgradeWebSocket = ((createEvents: (c: unknown) => SocketHandlers) => (c: unknown) => {
      handlers = createEvents(c);
      return new Response(null, { status: 101 });
    }) as unknown as UpgradeWebSocketFn;
    app = createApp({ manager, logger, upgradeWebSocket });
  });

  afterEach(async () => {
    manager.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Runs the upgrade of one route so its callbacks are captured.
   *
   * @param path - Route to open.
   * @returns The socket the callbacks are driven with.
   */
  async function open(path: string): Promise<FakeSocket> {
    await app.request(path);
    const socket = new FakeSocket();
    handlers.onOpen?.(new Event('open'), socket.asContext());
    await flush();
    return socket;
  }

  describe('/ws/terminal/:sessionId', () => {
    it('attaches a pty sized from the query and pipes its output out', async () => {
      const socket = await open(`/ws/terminal/${SESSION_ID}?cols=100&rows=30`);
      const terminal = runner.terminals[0] as FakeTerminal;

      expect(terminal.resizes[0]).toEqual({ cols: 100, rows: 30 });
      terminal.emitData('hello');
      expect(new TextDecoder().decode(socket.binaries[0])).toBe('hello');
    });

    it('refuses a session id no record has', async () => {
      const socket = await open('/ws/terminal/qc-nope');

      expect(runner.terminals).toHaveLength(0);
      expect(socket.frames()[0]).toEqual({ type: 'error', message: "unknown session 'qc-nope'" });
      expect(socket.closes[0]?.code).toBe(1008);
    });

    it('reports an attach that failed and closes', async () => {
      runner.attachError = new Error('no server running');
      const socket = await open(`/ws/terminal/${SESSION_ID}`);

      expect(socket.frames()[0]).toEqual({ type: 'error', message: 'no server running' });
      expect(socket.closes[0]?.code).toBe(1011);
      expect(logger.lines.some((line) => line.includes('no server running'))).toBe(true);
    });

    it('writes binary frames into the pty and applies a resize frame', async () => {
      const socket = await open(`/ws/terminal/${SESSION_ID}`);
      const terminal = runner.terminals[0] as FakeTerminal;

      handlers.onMessage?.(
        new MessageEvent('message', { data: new TextEncoder().encode('ls\r').buffer }),
        socket.asContext(),
      );
      handlers.onMessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'resize', cols: 80, rows: 24 }),
        }),
        socket.asContext(),
      );
      await flush();

      expect(terminal.writes).toEqual(['ls\r']);
      expect(terminal.resizes.at(-1)).toEqual({ cols: 80, rows: 24 });
    });

    it('ignores a text frame that is not a resize', async () => {
      const socket = await open(`/ws/terminal/${SESSION_ID}`);
      const terminal = runner.terminals[0] as FakeTerminal;
      const before = terminal.resizes.length;

      handlers.onMessage?.(new MessageEvent('message', { data: 'not json' }), socket.asContext());
      handlers.onMessage?.(
        new MessageEvent('message', { data: JSON.stringify({ type: 'resize', cols: 0, rows: 0 }) }),
        socket.asContext(),
      );
      await flush();

      expect(terminal.resizes).toHaveLength(before);
      expect(terminal.writes).toEqual([]);
    });

    it('drops pty output while the viewer is not reading it', async () => {
      const socket = await open(`/ws/terminal/${SESSION_ID}`);
      const terminal = runner.terminals[0] as FakeTerminal;

      socket.raw.bufferedAmount = TERMINAL_BUFFER_LIMIT_BYTES + 1;
      terminal.emitData('flood');

      expect(socket.binaries).toHaveLength(0);
    });

    it('tells the viewer the terminal exited', async () => {
      const socket = await open(`/ws/terminal/${SESSION_ID}`);
      const terminal = runner.terminals[0] as FakeTerminal;

      terminal.emitExit(0);

      expect(socket.frames()[0]).toEqual({ type: 'exit', exitCode: 0 });
      expect(socket.closes[0]?.code).toBe(1000);
    });

    it('detaches the viewer on a close and on a socket error', async () => {
      const closed = await open(`/ws/terminal/${SESSION_ID}`);
      handlers.onClose?.(new CloseEvent('close'), closed.asContext());
      expect((runner.terminals[0] as FakeTerminal).disposed).toBe(true);

      const errored = await open(`/ws/terminal/${SESSION_ID}`);
      handlers.onError?.(new Event('error'), errored.asContext());
      expect((runner.terminals[1] as FakeTerminal).disposed).toBe(true);
      expect(errored.closes[0]?.code).toBe(1011);
    });
  });

  describe('/ws/events', () => {
    it('pushes one board per workspace on connect and every later frame', async () => {
      const socket = await open('/ws/events');

      const first = socket.frames()[0];
      expect(first).toMatchObject({ type: 'board', workspaceId: 'ws' });

      await manager.setSessionDone(SESSION_ID, true);
      expect(socket.frames().some((frame) => frame.type === 'session')).toBe(true);
    });

    it('stops pushing to a socket that closed or errored', async () => {
      const socket = await open('/ws/events');
      handlers.onClose?.(new CloseEvent('close'), socket.asContext());
      const after = socket.frames().length;

      await manager.setSessionDone(SESSION_ID, true);

      expect(socket.frames()).toHaveLength(after);
    });
  });
});
