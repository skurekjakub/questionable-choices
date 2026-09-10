// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardView } from '../../src/core/api.js';
import { App } from '../../src/web/src/App.js';
import { navigate } from '../../src/web/src/navigation.js';
import { boardListing, publicConfig } from './fixtures.js';
import './jsdom-gaps.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getPublicConfig: vi.fn(),
  getBoard: vi.fn(),
  getIssue: vi.fn(),
  getSessionEvents: vi.fn(),
}));

// The xterm bundle is not the subject and does not survive jsdom.
vi.mock('../../src/web/src/components/Terminal.js', () => ({
  SessionTerminal: () => <div data-testid="terminal" />,
}));

const { getPublicConfig, getBoard, getIssue, getSessionEvents } =
  await import('../../src/web/src/api.js');

/**
 * A WebSocket that never connects, so the shared event stream can be entered
 * without reaching the network.
 */
class SilentSocket {
  /** Called once the socket is considered open. */
  onopen: (() => void) | null = null;
  /** Called with each frame delivered to the consumer. */
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Called when the socket closes. */
  onclose: (() => void) | null = null;
  /** Called when the socket errors. */
  onerror: (() => void) | null = null;

  /**
   * Closes the socket, telling the consumer once.
   *
   * @returns Nothing.
   */
  close(): void {
    this.onclose?.();
    this.onclose = null;
  }
}

/**
 * The workspace the app remembers between reloads.
 *
 * @returns The remembered id, or null.
 */
function remembered(): string | null {
  return window.localStorage.getItem('qc.workspace');
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentSocket);
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
  vi.mocked(getPublicConfig).mockResolvedValue(publicConfig(['docs', 'migration']));
  vi.mocked(getIssue).mockRejectedValue(new Error('the detail is not the subject'));
  vi.mocked(getSessionEvents).mockRejectedValue(new Error('the log is not the subject'));
  vi.mocked(getBoard).mockImplementation((workspaceId: string): Promise<BoardView> => {
    // Only the second workspace has the session the URL below names.
    const ids = workspaceId === 'migration' ? ['qc-DOC-9-implement'] : [];
    return Promise.resolve(boardListing(workspaceId, ids));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App', () => {
  it('does not remember the workspace a session URL resolved', async () => {
    // Following a notification into another workspace is not the owner choosing
    // a board, so it must not change the one the next cold start opens.
    window.localStorage.setItem('qc.workspace', 'docs');
    window.history.pushState(null, '', '/session/qc-DOC-9-implement');
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal')).toBeTruthy());
    expect(remembered()).toBe('docs');
  });

  it('puts the remembered board back when the session route is left', async () => {
    // Otherwise the switcher shows the resolved epic while storage names
    // another, and the next reload swaps the board under the owner.
    window.localStorage.setItem('qc.workspace', 'docs');
    window.history.pushState(null, '', '/session/qc-DOC-9-implement');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('terminal')).toBeTruthy());

    await act(async () => navigate('/'));
    await waitFor(() => expect(vi.mocked(getBoard).mock.calls.at(-1)?.[0]).toBe('docs'));
    expect(remembered()).toBe('docs');
  });

  it('opens the remembered workspace rather than the first one', async () => {
    window.localStorage.setItem('qc.workspace', 'migration');
    render(<App />);
    await waitFor(() =>
      expect(vi.mocked(getBoard).mock.calls.some((call) => call[0] === 'migration')).toBe(true),
    );
    expect(vi.mocked(getBoard).mock.calls.some((call) => call[0] === 'docs')).toBe(false);
  });

  it('falls back to the first workspace when the remembered one has been removed', async () => {
    window.localStorage.setItem('qc.workspace', 'retired');
    render(<App />);
    await waitFor(() =>
      expect(vi.mocked(getBoard).mock.calls.some((call) => call[0] === 'docs')).toBe(true),
    );
  });
});
