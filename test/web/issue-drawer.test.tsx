// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueDetailResponse } from '../../src/core/api.js';
import { drawerSessions, IssueDrawer } from '../../src/web/src/components/IssueDrawer.js';
import { card, cardSession, FIXTURE_NOW } from './fixtures.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
}));

const { getIssue } = await import('../../src/web/src/api.js');

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
      description: 'the description',
      assignee: null,
      priority: null,
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
    lastEventAt: FIXTURE_NOW,
    cache: null,
    createdAt: FIXTURE_NOW,
    endedAt: null,
    done: false,
    archived: false,
    runs: [{ startedAt: FIXTURE_NOW, kind: 'start', exitCode: null }],
    ...overrides,
  };
}

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
          cache: { expiresAt: FIXTURE_NOW, ttlSeconds: 300, source: 'statusline' },
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

  it('falls back to the snapshot for a session the board no longer lists', () => {
    const rows = drawerSessions(
      card('DOC-1', []),
      detail('DOC-1', [record('qc-DOC-1-implement', { state: 'exited' })]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('exited');
  });

  it('puts a session started after the load at the top, with no id to resume from', () => {
    const rows = drawerSessions(
      card('DOC-1', [cardSession('qc-DOC-1-verify')]),
      detail('DOC-1', [record('qc-DOC-1-implement')]),
    );
    expect(rows.map((row) => row.id)).toEqual(['qc-DOC-1-verify', 'qc-DOC-1-implement']);
    expect(rows[0]?.claudeSessionId).toBeNull();
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
      onClose: () => {},
      onOpenSession: () => {},
    };
    const { rerender } = render(<IssueDrawer card={card('DOC-1', [])} {...props} />);
    rerender(<IssueDrawer card={card('DOC-2', [])} {...props} />);
    await waitFor(() => expect(screen.getByText('the description')).toBeTruthy());

    await act(async () => {
      releaseFirst?.(detail('DOC-1', [record('qc-DOC-1-implement')]));
    });
    // The first card's session must not appear under the second card's key.
    expect(screen.queryByText('Bash: rm -rf .next/cache')).toBeNull();
  });
});
