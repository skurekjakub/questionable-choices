import { useEffect, useRef, type JSX } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as Xterm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerFrame } from '../../../core/api.js';
import { reconnectDelayMs, socketUrl } from '../ws.js';

/**
 * ANSI palette and chrome colours, matching the dashboard's own surfaces.
 */
const THEME = {
  background: '#0e1418',
  foreground: '#e8e3d7',
  cursor: '#5ec8d8',
  cursorAccent: '#0e1418',
  selectionBackground: 'rgba(94, 200, 216, 0.28)',
  black: '#182228',
  red: '#e2664b',
  green: '#8fae6a',
  yellow: '#f0a52e',
  blue: '#6f9fd8',
  magenta: '#c08cc0',
  cyan: '#5ec8d8',
  white: '#c9c3b6',
  brightBlack: '#66757c',
  brightRed: '#f08a72',
  brightGreen: '#a9c98a',
  brightYellow: '#f7c163',
  brightBlue: '#92bbe6',
  brightMagenta: '#d6a9d6',
  brightCyan: '#8adfeb',
  brightWhite: '#f3efe6',
};

/**
 * Unattended reconnect attempts made before the owner has to ask for one.
 */
const MAX_RETRIES = 6;

/**
 * Attaches a terminal to a session's tmux window over a WebSocket.
 *
 * The attach URL carries `?cols=` and `?rows=` because the pty is spawned at
 * that size before the first byte is written; a `resize` frame follows on open
 * and on every layout change, but it arrives too late to spare the TUI one
 * redraw at the wrong width. Both are the fitted xterm's own dimensions.
 *
 * Reconnects walk the shared backoff and stop once the session is no longer
 * live, once the server names an error, or after {@link MAX_RETRIES}, so a
 * killed session does not paint a red line every three seconds forever.
 *
 * @param props - Component props.
 * @param props.sessionId - Id of the session to attach to.
 * @param props.reconnectSignal - Changing this value forces a fresh attach.
 * @param props.live - Whether the session is still in a running state.
 * @param props.onAttached - Called with the attachment state on every change.
 * @returns The terminal host element.
 */
export function SessionTerminal({
  sessionId,
  reconnectSignal,
  live,
  onAttached,
}: {
  sessionId: string;
  reconnectSignal: number;
  live: boolean;
  onAttached: (attached: boolean) => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const attachedRef = useRef(onAttached);
  const liveRef = useRef(live);

  useEffect(() => {
    attachedRef.current = onAttached;
  }, [onAttached]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const xterm = new Xterm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 8000,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      const live = socket.current;
      if (live?.readyState !== WebSocket.OPEN) return;
      live.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
    });
    // The cleanup below is the effect's return value, so nothing that throws
    // before the effect returns is ever cleaned up: without this the xterm
    // keeps its DOM and its renderer for the life of the page.
    try {
      xterm.loadAddon(fitAddon);
      xterm.loadAddon(new WebLinksAddon());
      xterm.open(element);
      fitAddon.fit();
      observer.observe(element);
    } catch (cause: unknown) {
      observer.disconnect();
      xterm.dispose();
      throw cause;
    }
    term.current = xterm;
    fit.current = fitAddon;

    return () => {
      observer.disconnect();
      xterm.dispose();
      term.current = null;
      fit.current = null;
    };
  }, []);

  useEffect(() => {
    const xterm = term.current;
    if (xterm === null) return;
    let closed = false;
    let retry: number | undefined;
    let attempt = 0;
    let refused = false;

    const open = (): void => {
      if (closed) return;
      fit.current?.fit();
      const query = `?cols=${xterm.cols}&rows=${xterm.rows}`;
      let next: WebSocket;
      // Same rule as the xterm above: a throw from the constructor happens
      // before the cleanup exists, so the socket it may already have opened is
      // closed here or never at all.
      try {
        next = new WebSocket(socketUrl(`/ws/terminal/${encodeURIComponent(sessionId)}${query}`));
      } catch (cause: unknown) {
        socket.current?.close();
        socket.current = null;
        throw cause;
      }
      next.binaryType = 'arraybuffer';
      socket.current = next;

      next.onopen = () => {
        attempt = 0;
        attachedRef.current(true);
        next.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
      };
      next.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) {
          xterm.write(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data !== 'string') return;
        try {
          const frame = JSON.parse(event.data) as TerminalServerFrame;
          if (frame.type === 'error') {
            refused = true;
            xterm.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
          }
          if (frame.type === 'exit')
            xterm.writeln(`\r\n\x1b[90mpty exited (${frame.exitCode})\x1b[0m`);
        } catch {
          return;
        }
      };
      next.onclose = () => {
        if (socket.current !== next) return;
        socket.current = null;
        attachedRef.current(false);
        if (closed) return;
        if (refused || !liveRef.current || attempt >= MAX_RETRIES) {
          xterm.writeln('\r\n\x1b[90mnot reattaching; use Reconnect to try again\x1b[0m');
          return;
        }
        retry = window.setTimeout(open, reconnectDelayMs(attempt));
        attempt += 1;
      };
      next.onerror = () => next.close();
    };

    const input = xterm.onData((data) => {
      const live = socket.current;
      if (live?.readyState !== WebSocket.OPEN) return;
      live.send(new TextEncoder().encode(data));
    });

    try {
      open();
    } catch (cause: unknown) {
      input.dispose();
      throw cause;
    }

    return () => {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      input.dispose();
      socket.current?.close();
      socket.current = null;
    };
  }, [sessionId, reconnectSignal]);

  return <div className="terminal-host" ref={host} />;
}
