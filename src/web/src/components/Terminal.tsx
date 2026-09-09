import { useEffect, useRef, type JSX } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as Xterm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerFrame } from '../../../core/api.js';
import { socketUrl } from '../ws.js';

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
 * Delay before an unattended reconnect attempt.
 */
const RETRY_MS = 3000;

/**
 * Attaches a terminal to a session's tmux window over a WebSocket.
 *
 * @param props - Component props.
 * @param props.sessionId - Id of the session to attach to.
 * @param props.reconnectSignal - Changing this value forces a fresh attach.
 * @param props.onAttached - Called with the attachment state on every change.
 * @returns The terminal host element.
 */
export function SessionTerminal({
  sessionId,
  reconnectSignal,
  onAttached,
}: {
  sessionId: string;
  reconnectSignal: number;
  onAttached: (attached: boolean) => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const attachedRef = useRef(onAttached);
  attachedRef.current = onAttached;

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
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(element);
    fitAddon.fit();
    term.current = xterm;
    fit.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      const live = socket.current;
      if (live?.readyState !== WebSocket.OPEN) return;
      live.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
    });
    observer.observe(element);

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

    const open = (): void => {
      if (closed) return;
      fit.current?.fit();
      const query = `?cols=${xterm.cols}&rows=${xterm.rows}`;
      const next = new WebSocket(
        socketUrl(`/ws/terminal/${encodeURIComponent(sessionId)}${query}`),
      );
      next.binaryType = 'arraybuffer';
      socket.current = next;

      next.onopen = () => {
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
          if (frame.type === 'error') xterm.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
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
        if (!closed) retry = window.setTimeout(open, RETRY_MS);
      };
      next.onerror = () => next.close();
    };

    const input = xterm.onData((data) => {
      const live = socket.current;
      if (live?.readyState !== WebSocket.OPEN) return;
      live.send(new TextEncoder().encode(data));
    });

    open();

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
