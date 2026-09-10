// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistResponse, IssueDetailResponse } from '../../src/core/api.js';
import { ApiError } from '../../src/web/src/api.js';
import { drawerSessions, IssueDrawer } from '../../src/web/src/components/IssueDrawer.js';
import { DROPPED_SENTENCE } from '../../src/web/src/model.js';
import { card, cardSession, FIXTURE_NOW } from './fixtures.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
  getChecklist: vi.fn(),
  setChecklistItem: vi.fn(),
}));

const { getChecklist, getIssue, setChecklistItem } = await import('../../src/web/src/api.js');

/**
 * Builds the detail response for one card's sessions, as the drawer loads it.
 *
 * @param key - Tracker key of the issue.
 * @param sessions - Records the detail reports.
 * @returns The detail response.
 */
function detail(key: string, sessions: IssueDetailResponse['sessions']): IssueDetailResponse {
  return {
    issue: {
      key,
      summary: `${key} summary`,
      type: 'Task',
      status: 'In Progress',
      statusCategory: 'inprogress',
      labels: [],
      url: `https://example.atlassian.net/browse/${key}`,
      description: `${key} description`,
      updated: FIXTURE_NOW,
    },
    sessions,
    worktreePath: null,
    flags: {},
  };
}

/**
 * Builds one session record as the detail route reports it.
 *
 * @param id - Session id.
 * @param overrides - Fields to set, over the defaults.
 * @returns The record.
 */
function record(
  id: string,
  overrides: Partial<IssueDetailResponse['sessions'][number]> = {},
): IssueDetailResponse['sessions'][number] {
  return {
    id,
    issueKey: 'DOC-1',
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
    state: 'waiting-permission',
    stateSince: FIXTURE_NOW,
    pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
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
  };
}

beforeEach(() => {
  // Every drawer render loads the checklist, so a suite that never arranges one
  // still needs an answer rather than an unmocked call.
  vi.mocked(getChecklist).mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('drawerSessions', () => {
  it('shows the board’s cleared pending, not the one the snapshot still carries', () => {
    // The board clears `pending` when a session stops needing the owner. Merging
    // field by field on null treats that as "no opinion" and resurrects it.
    const killed = cardSession('qc-DOC-1-implement', { state: 'exited', pending: null });
    const rows = drawerSessions(
      card('DOC-1', [killed]),
      detail('DOC-1', [record('qc-DOC-1-implement')]),
    );
    expect(rows[0]?.state).toBe('exited');
    expect(rows[0]?.pending).toBeNull();
  });

  it('shows the board’s cleared cache, not the one the snapshot still carries', () => {
    const killed = cardSession('qc-DOC-1-implement', { state: 'exited', cache: null });
    const rows = drawerSessions(
      card('DOC-1', [killed]),
      detail('DOC-1', [
        record('qc-DOC-1-implement', {
          cache: {
            // Epoch seconds, as `SessionCache` says; a fixture in milliseconds
            // passes here only because nothing reads it, and is then copied.
            expiresAt: Math.floor(Date.parse(FIXTURE_NOW) / 1000),
            ttlSeconds: 300,
            source: 'statusline',
            warm: true,
          },
        }),
      ]),
    );
    expect(rows[0]?.cache).toBeNull();
  });

  it('takes the Claude session id from the snapshot, which the board does not carry', () => {
    const rows = drawerSessions(
      card('DOC-1', [cardSession('qc-DOC-1-implement')]),
      detail('DOC-1', [record('qc-DOC-1-implement', { claudeSessionId: 'claude-9' })]),
    );
    expect(rows[0]?.claudeSessionId).toBe('claude-9');
  });

  it('drops a session the board has stopped listing, rather than freezing its row', () => {
    // A session archived from anywhere else leaves `card.sessions` and stays in
    // the loaded detail; keeping it offers Kill and Resume against a record the
    // server will refuse.
    const rows = drawerSessions(
      card('DOC-1', []),
      detail('DOC-1', [record('qc-DOC-1-implement', { state: 'exited' })]),
    );
    expect(rows).toHaveLength(0);
  });

  it('shows every session the board lists before the detail has loaded', () => {
    const rows = drawerSessions(card('DOC-1', [cardSession('qc-DOC-1-implement')]), null);
    expect(rows.map((row) => row.id)).toEqual(['qc-DOC-1-implement']);
  });

  it('puts a session started after the load at the top, with no id to resume from', () => {
    const rows = drawerSessions(
      card('DOC-1', [cardSession('qc-DOC-1-verify'), cardSession('qc-DOC-1-implement')]),
      detail('DOC-1', [record('qc-DOC-1-implement')]),
    );
    expect(rows.map((row) => row.id)).toEqual(['qc-DOC-1-verify', 'qc-DOC-1-implement']);
    expect(rows[0]?.claudeSessionId).toBeNull();
  });

  it('keeps the board’s order for the sessions the detail has never seen', () => {
    // `Card.sessions` is ordered most relevant first; reversing it puts the
    // stale one above the session the owner just started.
    const rows = drawerSessions(
      card('DOC-1', [
        cardSession('qc-DOC-1-verify'),
        cardSession('qc-DOC-1-review'),
        cardSession('qc-DOC-1-implement'),
      ]),
      detail('DOC-1', [record('qc-DOC-1-implement')]),
    );
    expect(rows.map((row) => row.id)).toEqual([
      'qc-DOC-1-verify',
      'qc-DOC-1-review',
      'qc-DOC-1-implement',
    ]);
  });

  it('takes the attach command the board sends, not one derived from the id', () => {
    // The server builds it from the runner's own tmux invocation, which a
    // socket path or a `-L` label makes different from the plain form.
    const rows = drawerSessions(
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          attachCommand: 'tmux -L qc attach -t qc-DOC-1-implement',
        }),
      ]),
      detail('DOC-1', [record('qc-DOC-1-implement')]),
    );
    expect(rows[0]?.attachCommand).toBe('tmux -L qc attach -t qc-DOC-1-implement');
  });
});

describe('IssueDrawer', () => {
  it('stops advertising a permission request the owner can no longer answer', async () => {
    vi.mocked(getIssue).mockResolvedValue(detail('DOC-1', [record('qc-DOC-1-implement')]));
    const waiting = cardSession('qc-DOC-1-implement', {
      state: 'waiting-permission',
      needsYou: true,
      pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
    });
    const { rerender } = render(
      <IssueDrawer
        card={card('DOC-1', [waiting])}
        workspaceId="docs"
        playbooks={[]}
        nowMs={Date.parse(FIXTURE_NOW)}
        dropped={false}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Bash: rm -rf .next/cache')).toBeTruthy());

    const killed = cardSession('qc-DOC-1-implement', { state: 'exited', pending: null });
    rerender(
      <IssueDrawer
        card={card('DOC-1', [killed])}
        workspaceId="docs"
        playbooks={[]}
        nowMs={Date.parse(FIXTURE_NOW)}
        dropped={false}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
    expect(screen.queryByText('Bash: rm -rf .next/cache')).toBeNull();
    expect(screen.getByText('exited')).toBeTruthy();
  });

  it('ignores a load that resolves after a newer one, so the older answer cannot win', async () => {
    let releaseFirst: ((value: IssueDetailResponse) => void) | null = null;
    vi.mocked(getIssue)
      .mockImplementationOnce(
        () =>
          new Promise<IssueDetailResponse>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(
        detail('DOC-2', [record('qc-DOC-2-implement', { state: 'exited', pending: null })]),
      );

    const props = {
      workspaceId: 'docs',
      playbooks: [],
      nowMs: Date.parse(FIXTURE_NOW),
      dropped: false,
      onClose: () => {},
      onOpenSession: () => {},
    };
    const { rerender } = render(<IssueDrawer card={card('DOC-1', [])} {...props} />);
    rerender(<IssueDrawer card={card('DOC-2', [])} {...props} />);
    await waitFor(() => expect(screen.getByText('DOC-2 description')).toBeTruthy());

    await act(async () => {
      releaseFirst?.(detail('DOC-1', [record('qc-DOC-1-implement')]));
    });
    // The first card's detail must not land under the second card's key.
    expect(screen.queryByText('DOC-1 description')).toBeNull();
    expect(screen.getByText('DOC-2 description')).toBeTruthy();
  });

  it('puts the glyph before the key, as every other surface does', async () => {
    vi.mocked(getIssue).mockResolvedValue(detail('DOC-1', [record('qc-DOC-1-implement')]));
    render(
      <IssueDrawer
        card={card('DOC-1', [cardSession('qc-DOC-1-implement')])}
        workspaceId="docs"
        playbooks={[]}
        nowMs={Date.parse(FIXTURE_NOW)}
        dropped={false}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('DOC-1 description')).toBeTruthy());
    const ident = document.querySelector('.card-ident');
    expect(ident?.firstElementChild?.className).toBe('type-glyph');
  });

  it('says the board has dropped the issue rather than taking the drawer away', async () => {
    vi.mocked(getIssue).mockResolvedValue(detail('DOC-1', [record('qc-DOC-1-implement')]));
    render(
      <IssueDrawer
        card={card('DOC-1', [cardSession('qc-DOC-1-implement')])}
        workspaceId="docs"
        playbooks={[]}
        nowMs={Date.parse(FIXTURE_NOW)}
        dropped={true}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(DROPPED_SENTENCE)).toBeTruthy());
  });
});

describe('the drawer’s checklist', () => {
  const TEMPLATE: ChecklistResponse = {
    items: [
      { label: 'Read the issue live', done: false },
      { label: 'npm run verify is green', done: true },
    ],
  };

  /**
   * Renders the drawer over one card with the checklist mocks already arranged.
   *
   * @returns Nothing, once the description has loaded.
   */
  const open = async (): Promise<void> => {
    vi.mocked(getIssue).mockResolvedValue(detail('DOC-1', [record('qc-DOC-1-implement')]));
    render(
      <IssueDrawer
        card={card('DOC-1', [cardSession('qc-DOC-1-implement')])}
        workspaceId="docs"
        playbooks={[]}
        nowMs={Date.parse(FIXTURE_NOW)}
        dropped={false}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('DOC-1 description')).toBeTruthy());
  };

  /**
   * Reads one checklist box by the item text beside it.
   *
   * @param label - Item text.
   * @returns The checkbox.
   */
  const box = (label: string): HTMLInputElement =>
    screen.getByRole('checkbox', { name: label }) as HTMLInputElement;

  it('renders one box per item, ticked as the loaded response says', async () => {
    vi.mocked(getChecklist).mockResolvedValue(TEMPLATE);
    await open();

    await waitFor(() => expect(box('Read the issue live').checked).toBe(false));
    expect(box('npm run verify is green').checked).toBe(true);
    expect(screen.getByRole('heading', { name: 'Checklist' })).toBeTruthy();
  });

  it('leaves the section out for a workspace whose response has no items', async () => {
    vi.mocked(getChecklist).mockResolvedValue({ items: [] });
    await open();

    expect(screen.queryByRole('heading', { name: 'Checklist' })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });

  it('leaves the section out when the checklist cannot be loaded', async () => {
    vi.mocked(getChecklist).mockRejectedValue(new Error('nope'));
    await open();

    expect(screen.queryByRole('heading', { name: 'Checklist' })).toBeNull();
  });

  it('ticks the box before the server answers, and keeps it when the PUT lands', async () => {
    vi.mocked(getChecklist).mockResolvedValue(TEMPLATE);
    let release: ((value: ChecklistResponse) => void) | null = null;
    vi.mocked(setChecklistItem).mockImplementation(
      () =>
        new Promise<ChecklistResponse>((resolve) => {
          release = resolve;
        }),
    );
    await open();
    await waitFor(() => expect(box('Read the issue live')).toBeTruthy());

    fireEvent.click(box('Read the issue live'));

    // The tick is on screen while the request is still in flight, and every box
    // is out of reach until it answers.
    expect(box('Read the issue live').checked).toBe(true);
    expect(box('npm run verify is green').disabled).toBe(true);
    expect(vi.mocked(setChecklistItem).mock.calls[0]).toEqual([
      'docs',
      'DOC-1',
      { label: 'Read the issue live', done: true },
    ]);

    await act(async () => {
      release?.({
        items: [
          { label: 'Read the issue live', done: true },
          { label: 'npm run verify is green', done: true },
        ],
      });
    });
    expect(box('Read the issue live').checked).toBe(true);
    expect(box('Read the issue live').disabled).toBe(false);
  });

  it('puts the box back and says why when the PUT fails', async () => {
    vi.mocked(getChecklist).mockResolvedValue(TEMPLATE);
    vi.mocked(setChecklistItem).mockRejectedValue(
      new ApiError(400, "'Read the issue live' is not on the checklist", null),
    );
    await open();
    await waitFor(() => expect(box('Read the issue live')).toBeTruthy());

    fireEvent.click(box('Read the issue live'));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        "'Read the issue live' is not on the checklist",
      ),
    );
    expect(box('Read the issue live').checked).toBe(false);
    // The other item's tick came from the load, not from this toggle: a revert
    // that replays a stale list would take it with it.
    expect(box('npm run verify is green').checked).toBe(true);
    expect(box('Read the issue live').disabled).toBe(false);
  });
});
