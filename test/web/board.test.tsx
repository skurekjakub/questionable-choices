// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDetailResponse } from '../../src/core/api.js';
import { Board } from '../../src/web/src/components/Board.js';
import { DROPPED_SENTENCE } from '../../src/web/src/model.js';
import { boardView, card, cardSession, FIXTURE_NOW, publicConfig } from './fixtures.js';
import './jsdom-gaps.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getIssue: vi.fn(),
}));

const { getIssue } = await import('../../src/web/src/api.js');

/**
 * Builds the detail the drawer loads for one issue.
 *
 * @param key - Tracker key of the issue.
 * @returns The detail response.
 */
function detail(key: string): IssueDetailResponse {
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
    sessions: [],
    worktreePath: null,
    flags: {},
  };
}

/**
 * Props every render below shares.
 *
 * @returns The common props.
 */
function common(): Omit<Parameters<typeof Board>[0], 'board'> {
  return {
    config: publicConfig(['docs']),
    workspaceId: 'docs',
    nowMs: Date.parse(FIXTURE_NOW),
    connected: true,
    refreshing: false,
    error: null,
    onRefresh: () => {},
    onSelectWorkspace: () => {},
    onConfigChanged: () => {},
    onOpenSession: () => {},
  };
}

beforeEach(() => {
  vi.mocked(getIssue).mockResolvedValue(detail('DOC-1'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Board overlays', () => {
  it('keeps an open drawer on screen when the board stops listing its issue', async () => {
    // A status change in the tracker drops the issue from the epic's query.
    // Unmounting the drawer over that takes a read in progress with it and
    // leaves no trace that anything happened.
    const listed = boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])]);
    const { rerender } = render(<Board board={listed} {...common()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open DOC-1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    rerender(<Board board={boardView('docs', [])} {...common()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(DROPPED_SENTENCE)).toBeTruthy();
  });

  it('says nothing about the board while it still lists the open issue', async () => {
    const listed = boardView('docs', [card('DOC-1', [cardSession('qc-DOC-1-implement')])]);
    render(<Board board={listed} {...common()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open DOC-1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.queryByText(DROPPED_SENTENCE)).toBeNull();
  });
});
