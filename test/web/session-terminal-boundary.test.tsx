// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/src/api.js';
import { SessionView } from '../../src/web/src/components/SessionView.js';
import { boardView, card, cardSession, FIXTURE_NOW } from './fixtures.js';
import './jsdom-gaps.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
  getSessionEvents: vi.fn(),
}));

/**
 * Whether the next import of the terminal module should fail, standing in for
 * the chunk 404 a tab kept open across a rebuild gets.
 */
let chunkMissing = true;

vi.mock('../../src/web/src/components/Terminal.js', () => {
  if (chunkMissing) throw new Error('Failed to fetch dynamically imported module');
  return { SessionTerminal: () => <div data-testid="terminal" /> };
});

const { getIssue } = await import('../../src/web/src/api.js');

/**
 * A WebSocket that never connects.
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
 * Renders the session view over a board that lists the session.
 *
 * @returns Nothing.
 */
function open(): void {
  render(
    <SessionView
      sessionId="qc-DOC-1-implement"
      board={boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])])}
      nowMs={Date.parse(FIXTURE_NOW)}
      resolving={false}
      onBack={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentSocket);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
  chunkMissing = true;
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('SessionView terminal boundary', () => {
  it('degrades to the attach command when the terminal chunk cannot be loaded', async () => {
    open();
    const notice = await screen.findByText(/The terminal could not be loaded/);
    // The command is the whole point of the scoped boundary: it does the same
    // job as the terminal it is standing in for. The session header renders the
    // same command, so the assertion is scoped to the panel that replaced the
    // terminal — otherwise the header alone satisfies it.
    const host = notice.closest('.terminal-host');
    expect(host).not.toBeNull();
    expect(within(host as HTMLElement).getByText('tmux attach -t qc-DOC-1-implement')).toBeTruthy();
    // A whole-dashboard panel here would take the board and the event socket
    // down over one missing chunk.
    expect(screen.queryByText(/The dashboard stopped rendering/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeTruthy();
  });

  it('re-imports the chunk when the owner asks it to try again', async () => {
    // React caches a rejected lazy payload for the life of the component, so a
    // retry that re-renders the same `lazy()` answers with the same rejection
    // forever — which is the only failure this button exists for.
    open();
    await waitFor(() => expect(screen.getByText(/The terminal could not be loaded/)).toBeTruthy());

    chunkMissing = false;
    vi.resetModules();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('terminal')).toBeTruthy());
    expect(screen.queryByText(/The terminal could not be loaded/)).toBeNull();
  });
});
