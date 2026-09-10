// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDetailResponse } from '../../src/core/api.js';
import { ApiError } from '../../src/web/src/api.js';
import { hintSentence, STALE_SENTENCE } from '../../src/web/src/components/Lamp.js';
import { SessionView } from '../../src/web/src/components/SessionView.js';
import { boardView, card, cardSession, FIXTURE_NOW } from './fixtures.js';
import './jsdom-gaps.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
  getSessionEvents: vi.fn(),
}));

// The xterm bundle is not the subject and does not survive jsdom.
vi.mock('../../src/web/src/components/Terminal.js', () => ({
  SessionTerminal: () => <div data-testid="terminal" />,
}));

const { getIssue, getSessionEvents } = await import('../../src/web/src/api.js');

/**
 * A WebSocket that never connects, so the shared event stream can be entered
 * without reaching the network.
 *
 * The unit under test owns `ws.ts`; the browser API below it is the boundary a
 * test is allowed to replace.
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
 * Builds the issue detail the session route loads, carrying one record.
 *
 * @param key - Tracker key of the issue.
 * @param overrides - Record fields to set, over the defaults.
 * @returns The detail response.
 */
function detailFor(
  key: string,
  overrides: Partial<IssueDetailResponse['sessions'][number]> = {},
): IssueDetailResponse {
  return {
    issue: {
      key,
      summary: `${key} summary`,
      type: 'Task',
      status: 'In Progress',
      statusCategory: 'inprogress',
      labels: [],
      url: `https://example.atlassian.net/browse/${key}`,
      description: undefined,
      updated: FIXTURE_NOW,
    },
    sessions: [
      {
        id: `qc-${key}-implement`,
        issueKey: key,
        playbookId: 'implement',
        repoId: 'app',
        cwd: '/repos/app',
        branch: null,
        model: 'claude-opus-5',
        currentModel: null,
        effort: 'high',
        permissionMode: 'acceptEdits',
        prompt: 'do the thing',
        claudeSessionId: 'claude-1',
        state: 'working',
        stateSince: FIXTURE_NOW,
        pending: null,
        lastAssistantMessage: null,
        lastExitCode: null,
        staleSince: null,
        hint: null,
        cache: null,
        compacting: null,
        createdAt: FIXTURE_NOW,
        endedAt: null,
        done: false,
        archived: false,
        runs: [{ startedAt: FIXTURE_NOW, kind: 'start', exitCode: null }],
        ...overrides,
      },
    ],
    worktreePath: null,
    flags: {},
  };
}

/**
 * A cache that went cold two minutes before the fixture instant.
 */
const COLD = {
  expiresAt: Math.floor(Date.parse(FIXTURE_NOW) / 1000) - 120,
  ttlSeconds: 300,
  warm: false,
  source: 'statusline' as const,
};

/**
 * Epoch seconds at which a cache still warm at the fixture instant goes cold.
 */
const WARM_UNTIL = Math.floor(Date.parse(FIXTURE_NOW) / 1000) + 240;

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    screen.getByTestId('terminal');
    const attach = screen.getByText('Attach in a terminal').closest('section');
    expect(attach?.querySelector('code.path')?.textContent).toBe(
      'tmux attach -t qc-DOC-1-implement',
    );
  });

  it('prefers the record over the card for a field the server has just cleared', async () => {
    // The board's copy is a debounced snapshot. Falling through to it once the
    // record exists resurrects a permission prompt nobody can answer any more.
    vi.mocked(getIssue).mockResolvedValue(
      detailFor('DOC-1', { state: 'working', pending: null, staleSince: null }),
    );
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'waiting-permission',
          needsYou: true,
          pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
          staleSince: FIXTURE_NOW,
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

    await waitFor(() => expect(screen.getByText('working')).toBeTruthy());
    expect(screen.queryByText(/Bash: rm -rf \.next\/cache/)).toBeNull();
    expect(screen.queryByText(/needs permission/)).toBeNull();
    expect(screen.queryByLabelText(STALE_SENTENCE)).toBeNull();
  });

  it('marks a session the record says may need the owner, inside the state pill', async () => {
    vi.mocked(getIssue).mockResolvedValue(
      detailFor('DOC-1', {
        hint: { summary: 'Claude is waiting for your input', at: FIXTURE_NOW },
      }),
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

    const marker = await screen.findByLabelText(hintSentence('Claude is waiting for your input'));
    // A hint is not a state: the pill still reads the state the machine is in.
    expect(marker.closest('.state-pill')).not.toBeNull();
    expect(screen.getByText('working')).toBeTruthy();
  });

  it('carries the unverified marker inside the state pill, where the spec puts it', async () => {
    vi.mocked(getIssue).mockResolvedValue(detailFor('DOC-1', { staleSince: FIXTURE_NOW }));
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

    const marker = await screen.findByLabelText(STALE_SENTENCE);
    expect(marker.closest('.state-pill')).not.toBeNull();
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

    const pill = await waitFor(() => {
      const found = document.querySelector('.state-pill');
      expect(found?.textContent).toContain('needs permission');
      return found;
    });
    // The prompt is what the pill is for: the state word alone does not say
    // what the session is waiting to be told.
    expect(pill?.textContent).toContain('Bash: rm -rf .next/cache');
    expect(screen.queryByText('session not found')).toBeNull();
    // A session waiting on the owner is still running, so the header offers the
    // controls that act on a running session and not the one that restarts it.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Interrupt' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows the session on screen, not the one it was opened from, while its detail loads', async () => {
    // One component instance renders every session route, so the record and the
    // issue loaded for the last session outlive the navigation to the next.
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'working' })]),
      card('DOC-2', [cardSession('qc-DOC-2-implement', { state: 'failed', lastExitCode: 1 })]),
    ]);
    vi.mocked(getIssue).mockResolvedValueOnce(detailFor('DOC-1'));
    vi.mocked(getSessionEvents).mockResolvedValue({ events: [] });
    const view = (sessionId: string): JSX.Element => (
      <SessionView
        sessionId={sessionId}
        board={board}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />
    );
    const { rerender } = render(view('qc-DOC-1-implement'));
    await waitFor(() => expect(screen.getByText('DOC-1 summary')).toBeTruthy());

    // The second session's detail is still in flight for the whole assertion.
    vi.mocked(getIssue).mockImplementation(() => new Promise(() => {}));
    rerender(view('qc-DOC-2-implement'));

    // The failed session's own panel, which also settles the log read.
    await screen.findByText(/records no reason/);
    const pill = document.querySelector('.state-pill');
    expect(pill?.textContent).toContain('failed, exit 1');
    expect(screen.queryByText('DOC-1 summary')).toBeNull();
    expect(screen.queryByText('DOC-1')).toBeNull();
    // `live` decides these two, and it is read off whatever the header shows.
    expect(screen.getByRole('button', { name: 'Kill' }).hasAttribute('disabled')).toBe(true);
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

  it('attaches no terminal to a session no board has confirmed yet', () => {
    // Before the first board frame nothing has ruled the id in, so opening a
    // socket for it is a request the server can only refuse.
    render(
      <SessionView
        sessionId="qc-DOC-1-implement"
        board={null}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={false}
        onBack={() => {}}
      />,
    );
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByText(/Waiting for the board/)).toBeTruthy();
  });

  it('attaches no terminal while another workspace is still being searched', () => {
    render(
      <SessionView
        sessionId="qc-DOC-9-implement"
        board={boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])])}
        nowMs={Date.parse(FIXTURE_NOW)}
        resolving={true}
        onBack={() => {}}
      />,
    );
    expect(screen.queryByTestId('terminal')).toBeNull();
    // This board has answered; what is being waited on is the other boards.
    expect(screen.getByText(/Looking through the other workspaces/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for the board/)).toBeNull();
  });

  it('says the log could not be read rather than that it named no reason', async () => {
    // 409 is the status the server uses for a log it cannot open; 404 is a
    // session it does not know, which is a different answer to the owner.
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockRejectedValue(
      new ApiError(409, "cannot read the event log for 'qc-DOC-1-implement'", 'EACCES'),
    );
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'failed', lastExitCode: 128 })]),
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
    expect(screen.queryByText(/no session with this id/)).toBeNull();
  });

  it('says the session itself is gone rather than blaming its log', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockRejectedValue(
      new ApiError(404, "unknown session 'qc-DOC-1-implement'", null),
    );
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'failed', lastExitCode: 128 })]),
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

    await waitFor(() => expect(screen.getByText(/no session with this id any more/)).toBeTruthy());
    expect(screen.queryByText(/The event log could not be read/)).toBeNull();
  });

  it('says the log named no reason when it was read and named none', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockResolvedValue({ events: [] });
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'failed', lastExitCode: 128 })]),
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

    const reason = await screen.findByText(/records no reason/);
    expect(reason.textContent).toBe('The event log records no reason beyond the exit code.');
    expect(document.querySelector('.state-pill')?.textContent).toContain('failed, exit 128');
    expect(screen.getByText(/shell open in tmux qc-DOC-1-implement/).textContent).toContain(
      'the output that ended it can be read there',
    );
  });

  it('names the exit code of a session that ran and died, not only of a failed one', async () => {
    vi.mocked(getIssue).mockRejectedValue(new ApiError(409, 'cannot fetch DOC-1', null));
    vi.mocked(getSessionEvents).mockResolvedValue({ events: [] });
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'exited', lastExitCode: 1 })]),
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

    await screen.findByText('Why it ended');
    expect(document.querySelector('.state-pill')?.textContent).toContain('exited, code 1');
    // A clean exit is not a failure, and the panel's heading is what says so.
    expect(screen.queryByText('Why it failed')).toBeNull();
  });

  it('shows the model the session is on and offers Compact on a cold idle one', async () => {
    vi.mocked(getIssue).mockResolvedValue(
      detailFor('DOC-1', { state: 'idle', currentModel: 'claude-fable-5-1', cache: COLD }),
    );
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'idle',
          needsYou: true,
          model: 'claude-fable-5-1',
          cache: COLD,
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

    await screen.findByText('claude-fable-5-1');
    expect(screen.getByRole('button', { name: 'Compact qc-DOC-1-implement' })).toBeTruthy();
  });

  it('says "compacting" in the state pill and offers no second Compact', async () => {
    vi.mocked(getIssue).mockResolvedValue(
      detailFor('DOC-1', {
        state: 'idle',
        cache: COLD,
        compacting: {
          restoreModel: 'claude-fable-5-1',
          globalDefault: 'claude-fable-5-1',
          startedAt: null,
          requestedAt: FIXTURE_NOW,
        },
      }),
    );
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'idle',
          needsYou: true,
          cache: COLD,
          compacting: true,
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

    await waitFor(() =>
      expect(document.querySelector('.state-pill')?.textContent).toContain('compacting'),
    );
    expect(screen.queryByRole('button', { name: 'Compact qc-DOC-1-implement' })).toBeNull();
  });

  it('offers no Compact while the cache is still warm', async () => {
    // The action costs a full re-read of the context, so it is only worth
    // offering once that re-read is going to happen anyway.
    vi.mocked(getIssue).mockResolvedValue(
      detailFor('DOC-1', { state: 'idle', cache: { ...COLD, warm: true, expiresAt: WARM_UNTIL } }),
    );
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'idle',
          needsYou: true,
          cache: { ...COLD, warm: true, expiresAt: WARM_UNTIL },
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

    await screen.findByTestId('terminal');
    expect(screen.queryByRole('button', { name: 'Compact qc-DOC-1-implement' })).toBeNull();
  });
});
