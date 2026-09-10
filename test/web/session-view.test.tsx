// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/src/api.js';
import { SessionView } from '../../src/web/src/components/SessionView.js';
import { boardView, card, cardSession, FIXTURE_NOW } from './fixtures.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
  getSessionEvents: vi.fn(),
}));

// The xterm bundle is not the subject and does not survive jsdom.
vi.mock('../../src/web/src/components/Terminal.js', () => ({
  SessionTerminal: () => <div data-testid="terminal" />,
}));

// The shared socket would open a real WebSocket per mount.
vi.mock('../../src/web/src/ws.js', () => ({ subscribeEvents: () => () => {} }));

const { getIssue, getSessionEvents } = await import('../../src/web/src/api.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SessionView', () => {
  it('keeps the terminal and the attach command when the tracker refuses the issue', async () => {
    // A 409 from a Jira outage says nothing about whether the session exists;
    // the board, which lists it, does.
    vi.mocked(getIssue).mockRejectedValue(
      new ApiError(409, 'cannot fetch DOC-1', 'jira: 503 Service Unavailable'),
    );
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'working' })]),
    ]);
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot fetch'));
    expect(screen.queryByText(/No board lists this session/)).toBeNull();
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(screen.getByText('tmux attach -t qc-DOC-1-implement')).toBeTruthy();
    expect(screen.getByText('Attach in a terminal')).toBeTruthy();
  });

  it('reads the header off the card while the issue detail is refused', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'waiting-permission',
          needsYou: true,
          pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
        }),
      ]),
    ]);
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/needs permission/)).toBeTruthy());
    expect(screen.getByText(/Bash: rm -rf \.next\/cache/)).toBeTruthy();
    expect(screen.queryByText('session not found')).toBeNull();
  });

  it('takes the terminal away only from a session no board lists', async () => {
    render(
      <SessionView
        sessionId="qc-DOC-9-implement"
        board={boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])])}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/No board lists this session/)).toBeTruthy());
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.queryByText('Attach in a terminal')).toBeNull();
    expect(screen.getByText('No such session')).toBeTruthy();
  });

  it('keeps looking while another workspace is still being searched', () => {
    render(
      <SessionView
        sessionId="qc-DOC-9-implement"
        board={boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])])}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={true}
        onBack={() => {}}
      />,
    );
    expect(screen.queryByText(/No board lists this session/)).toBeNull();
    expect(screen.getByText('loading')).toBeTruthy();
  });

  it('says the log could not be read rather than that it named no reason', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockRejectedValue(
      new ApiError(404, "unknown session 'qc-DOC-1-implement'", null),
    );
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', { state: 'failed', live: false, lastExitCode: 128 }),
      ]),
    ]);
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/The event log could not be read/)).toBeTruthy());
    expect(screen.queryByText(/records no reason/)).toBeNull();
  });

  it('says the log named no reason when it was read and named none', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockResolvedValue({ events: [] });
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', { state: 'failed', live: false, lastExitCode: 128 }),
      ]),
    ]);
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/records no reason/)).toBeTruthy());
    expect(screen.getByText(/failed, exit 128/)).toBeTruthy();
    expect(screen.getByText(/shell open in tmux qc-DOC-1-implement/)).toBeTruthy();
  });

  it('names the exit code of a session that ran and died, not only of a failed one', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockResolvedValue({ events: [] });
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', { state: 'exited', live: false, lastExitCode: 1 }),
      ]),
    ]);
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/exited, code 1/)).toBeTruthy());
    expect(screen.getByText('Why it ended')).toBeTruthy();
  });
});
