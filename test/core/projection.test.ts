import { describe, expect, it } from 'vitest';
import { attachCommand, missingIssueKeys, project } from '../../src/core/projection.js';
import type { ProjectionInput } from '../../src/core/projection.js';
import type { BoardView, Card } from '../../src/core/api.js';
import type { ColumnId, SessionRecord, SessionState } from '../../src/core/types.js';
import { makeIssue, makePlaybook, makeRecord, makeRepo, makeWorkspace } from './helpers.js';

/**
 * Projects a board from partial input, filling in the workspace and clock.
 *
 * @param overrides - Fields to replace on the default projection input.
 * @returns The board view.
 */
function projectWith(overrides: Partial<ProjectionInput> = {}): BoardView {
  return project({
    workspaceId: 'ws',
    workspace: makeWorkspace(),
    repo: makeRepo(),
    issues: [makeIssue()],
    sessions: [],
    flags: {},
    fetchedAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  });
}

/**
 * Finds the lane an issue landed in.
 *
 * @param view - The projected board.
 * @param key - Issue key to look for.
 * @returns The lane id, or null when no card carries the key.
 */
function columnOf(view: BoardView, key: string): ColumnId | null {
  for (const column of view.columns) {
    if (column.cards.some((card) => card.issue.key === key)) return column.id;
  }
  return null;
}

/**
 * Lists the issue keys of one lane, in display order.
 *
 * @param view - The projected board.
 * @param id - Lane to read.
 * @returns The keys in order.
 */
function keysIn(view: BoardView, id: ColumnId): string[] {
  return (view.columns.find((column) => column.id === id)?.cards ?? []).map(
    (card: Card) => card.issue.key,
  );
}

describe('board shape', () => {
  it('always renders the five lanes in display order', () => {
    const view = projectWith();
    expect(view.columns.map((column) => column.id)).toEqual([
      'backlog',
      'working',
      'needs-you',
      'review',
      'done',
    ]);
    expect(view.columns.map((column) => column.name)).toEqual([
      'Backlog',
      'Working',
      'Needs you',
      'Review',
      'Done',
    ]);
  });

  it('carries the workspace identity and its playbooks', () => {
    const view = projectWith();
    expect(view.workspaceId).toBe('ws');
    expect(view.name).toBe('Docs');
    expect(view.playbooks.map((playbook) => playbook.id)).toEqual(['implement', 'test']);
    expect(view.sourceError).toBeNull();
  });

  it('passes a source error through for the banner', () => {
    expect(projectWith({ sourceError: 'jira unreachable' }).sourceError).toBe('jira unreachable');
  });
});

describe('column precedence', () => {
  const cases: Array<{
    name: string;
    states: SessionState[];
    status?: string;
    statusCategory?: 'todo' | 'inprogress' | 'done';
    flags?: { review?: boolean; done?: boolean };
    expected: ColumnId;
  }> = [
    { name: 'no sessions and an open status', states: [], expected: 'backlog' },
    { name: 'a bootstrapping session', states: ['bootstrapping'], expected: 'working' },
    { name: 'a starting session', states: ['starting'], expected: 'working' },
    { name: 'a working session', states: ['working'], expected: 'working' },
    { name: 'an idle session', states: ['idle'], expected: 'needs-you' },
    {
      name: 'a session waiting on permission',
      states: ['waiting-permission'],
      expected: 'needs-you',
    },
    {
      name: 'a session waiting on a question',
      states: ['waiting-question'],
      expected: 'needs-you',
    },
    {
      name: 'needs-you beating working when both are live',
      states: ['working', 'idle'],
      expected: 'needs-you',
    },
    {
      name: 'a live session beating a done status',
      states: ['working'],
      statusCategory: 'done',
      expected: 'working',
    },
    {
      name: 'a live session beating the review flag',
      states: ['waiting-permission'],
      flags: { review: true },
      expected: 'needs-you',
    },
    {
      name: 'an exited session leaving the lane to the status',
      states: ['exited'],
      expected: 'backlog',
    },
    {
      name: 'a failed session leaving the lane to the status',
      states: ['failed'],
      expected: 'backlog',
    },
    {
      name: 'a done status with no live session',
      states: ['exited'],
      statusCategory: 'done',
      expected: 'done',
    },
    { name: 'the done flag', states: [], flags: { done: true }, expected: 'done' },
    {
      name: 'the done flag beating a review status',
      states: [],
      status: 'Ready for review',
      flags: { done: true },
      expected: 'done',
    },
    { name: 'a review status', states: [], status: 'Ready for review', expected: 'review' },
    { name: 'the review flag', states: [], flags: { review: true }, expected: 'review' },
  ];

  it.each(cases)('places an issue with $name in $expected', (testCase) => {
    const issue = makeIssue({
      key: 'DOC-7',
      status: testCase.status ?? 'To Do',
      statusCategory: testCase.statusCategory ?? 'todo',
    });
    const sessions = testCase.states.map((state, index) =>
      makeRecord({ id: `qc-DOC-7-${index}`, issueKey: 'DOC-7', state }),
    );
    const view = projectWith({
      issues: [issue],
      sessions,
      flags: testCase.flags === undefined ? {} : { 'DOC-7': testCase.flags },
    });
    expect(columnOf(view, 'DOC-7')).toBe(testCase.expected);
  });
});

describe('ordering', () => {
  /**
   * Builds an issue plus one session in a given state and age.
   *
   * @param key - Issue key.
   * @param state - State of the session.
   * @param stateSince - ISO timestamp the session entered that state.
   * @returns The issue and its session.
   */
  const pair = (
    key: string,
    state: SessionState,
    stateSince: string,
  ): { issue: ReturnType<typeof makeIssue>; session: SessionRecord } => ({
    issue: makeIssue({ key }),
    session: makeRecord({ id: `qc-${key}`, issueKey: key, state, stateSince }),
  });

  it('puts waiting cards above idle ones, oldest first', () => {
    const rows = [
      pair('DOC-1', 'idle', '2026-09-09T10:00:00.000Z'),
      pair('DOC-2', 'waiting-permission', '2026-09-09T11:00:00.000Z'),
      pair('DOC-3', 'waiting-question', '2026-09-09T10:30:00.000Z'),
      pair('DOC-4', 'idle', '2026-09-09T09:00:00.000Z'),
    ];
    const view = projectWith({
      issues: rows.map((row) => row.issue),
      sessions: rows.map((row) => row.session),
    });
    expect(keysIn(view, 'needs-you')).toEqual(['DOC-3', 'DOC-2', 'DOC-4', 'DOC-1']);
  });

  it('ranks a card on its oldest qualifying session, not its newest', () => {
    // A card with two dialogs is as old as the older of them; ranking it on the
    // newer one lets a shorter wait outrank a longer one.
    const view = projectWith({
      issues: [makeIssue({ key: 'DOC-1' }), makeIssue({ key: 'DOC-2' })],
      sessions: [
        makeRecord({
          id: 'qc-DOC-1-a',
          issueKey: 'DOC-1',
          state: 'waiting-permission',
          stateSince: '2026-09-09T09:00:00.000Z',
        }),
        makeRecord({
          id: 'qc-DOC-1-b',
          issueKey: 'DOC-1',
          playbookId: 'test',
          state: 'waiting-permission',
          stateSince: '2026-09-09T11:00:00.000Z',
        }),
        makeRecord({
          id: 'qc-DOC-2-a',
          issueKey: 'DOC-2',
          state: 'waiting-permission',
          stateSince: '2026-09-09T10:00:00.000Z',
        }),
      ],
    });

    expect(keysIn(view, 'needs-you')).toEqual(['DOC-1', 'DOC-2']);
  });

  it('ranks a blocked card on its dialog, not on an older idle session beside it', () => {
    const rows = [
      pair('DOC-1', 'waiting-permission', '2026-09-09T10:00:00.000Z'),
      pair('DOC-2', 'waiting-permission', '2026-09-09T09:30:00.000Z'),
    ];
    const view = projectWith({
      issues: rows.map((row) => row.issue),
      sessions: [
        ...rows.map((row) => row.session),
        makeRecord({
          id: 'qc-DOC-1-test',
          issueKey: 'DOC-1',
          playbookId: 'test',
          state: 'idle',
          stateSince: '2026-09-09T09:00:00.000Z',
        }),
      ],
    });
    expect(keysIn(view, 'needs-you')).toEqual(['DOC-2', 'DOC-1']);
  });

  it('puts the longest-running working card on top', () => {
    const rows = [
      pair('DOC-1', 'working', '2026-09-09T11:00:00.000Z'),
      pair('DOC-2', 'bootstrapping', '2026-09-09T09:00:00.000Z'),
      pair('DOC-3', 'starting', '2026-09-09T10:00:00.000Z'),
    ];
    const view = projectWith({
      issues: rows.map((row) => row.issue),
      sessions: rows.map((row) => row.session),
    });
    expect(keysIn(view, 'working')).toEqual(['DOC-2', 'DOC-3', 'DOC-1']);
  });

  it('keeps source order in the quiet lanes', () => {
    const issues = ['DOC-9', 'DOC-3', 'DOC-5'].map((key) => makeIssue({ key }));
    expect(keysIn(projectWith({ issues }), 'backlog')).toEqual(['DOC-9', 'DOC-3', 'DOC-5']);
  });

  it('lists live sessions before finished ones on a card', () => {
    const view = projectWith({
      sessions: [
        makeRecord({ id: 'old', state: 'exited', createdAt: '2026-09-09T08:00:00.000Z' }),
        makeRecord({ id: 'new', state: 'idle', createdAt: '2026-09-09T09:00:00.000Z' }),
        makeRecord({ id: 'newest-dead', state: 'failed', createdAt: '2026-09-09T10:00:00.000Z' }),
      ],
    });
    const card = view.columns.find((column) => column.id === 'needs-you')?.cards[0];
    expect(card?.sessions.map((session) => session.id)).toEqual(['new', 'newest-dead', 'old']);
  });
});

describe('card payload', () => {
  it('carries everything the card renders', () => {
    const view = projectWith({
      issues: [
        makeIssue({
          key: 'DOC-7',
          labels: ['docs'],
          status: 'In Progress',
          statusCategory: 'inprogress',
        }),
      ],
      sessions: [
        makeRecord({
          id: 'qc-DOC-7-implement',
          issueKey: 'DOC-7',
          state: 'waiting-permission',
          pending: { kind: 'permission', summary: 'Bash: ls' },
          lastAssistantMessage: 'I looked at the loader.',
          branch: 'DOC-7-x',
        }),
      ],
      worktrees: { 'DOC-7': '/repos/worktrees/DOC-7' },
      flags: { 'DOC-7': { review: true } },
    });
    const card = view.columns.find((column) => column.id === 'needs-you')?.cards[0] as Card;
    expect(card.issue).toEqual({
      key: 'DOC-7',
      summary: 'Document the thing',
      type: 'Task',
      status: 'In Progress',
      statusCategory: 'inprogress',
      labels: ['docs'],
      url: 'https://example.atlassian.net/browse/DOC-1',
    });
    expect(card.worktreePath).toBe('/repos/worktrees/DOC-7');
    expect(card.flags).toEqual({ review: true });
    expect(card.needsYou).toBe(true);
    expect(card.sessions[0]).toEqual({
      id: 'qc-DOC-7-implement',
      playbookId: 'implement',
      state: 'waiting-permission',
      stateSince: '2026-09-09T10:00:00.000Z',
      pending: { kind: 'permission', summary: 'Bash: ls' },
      lastAssistantMessage: 'I looked at the loader.',
      lastExitCode: null,
      staleSince: null,
      cache: null,
      done: false,
      live: true,
      needsYou: true,
      branch: 'DOC-7-x',
      attachCommand: 'tmux attach -t qc-DOC-7-implement',
    });
  });

  it('carries the last assistant snippet of an idle session, which has no pending', () => {
    const view = projectWith({
      issues: [makeIssue({ key: 'DOC-8' })],
      sessions: [
        makeRecord({
          id: 'qc-DOC-8-implement',
          issueKey: 'DOC-8',
          state: 'idle',
          pending: null,
          lastAssistantMessage: 'Done: the loader now reads the front matter.',
        }),
      ],
    });
    const card = view.columns.find((column) => column.id === 'needs-you')?.cards[0] as Card;
    expect(card.sessions[0]?.lastAssistantMessage).toBe(
      'Done: the loader now reads the front matter.',
    );
  });

  it('carries the exit code and the staleness marker a failed card needs', () => {
    const view = projectWith({
      issues: [makeIssue({ key: 'DOC-9' })],
      sessions: [
        makeRecord({
          id: 'qc-DOC-9-implement',
          issueKey: 'DOC-9',
          state: 'failed',
          lastExitCode: 127,
          staleSince: '2026-09-09T12:00:00.000Z',
        }),
      ],
    });
    const card = view.columns
      .flatMap((column) => column.cards)
      .find((entry) => entry.issue.key === 'DOC-9') as Card;

    expect(card.sessions[0]?.lastExitCode).toBe(127);
    expect(card.sessions[0]?.staleSince).toBe('2026-09-09T12:00:00.000Z');
  });

  it('reports a null snippet when no Stop payload carried one', () => {
    const card = projectWith({
      sessions: [makeRecord({ lastAssistantMessage: null })],
    })
      .columns.flatMap((column) => column.cards)
      .find((entry) => entry.sessions.length > 0) as Card;
    expect(card.sessions[0]?.lastAssistantMessage).toBeNull();
  });

  it('has no worktree path when the workspace knows none', () => {
    const card = projectWith().columns[0]?.cards[0] as Card;
    expect(card.worktreePath).toBeNull();
  });

  it.each([
    ['backlog', 'implement'],
    ['working', 'implement'],
    ['needs-you', 'implement'],
    ['review', 'test'],
  ])('offers %s the %s playbook as its primary action', (column, playbookId) => {
    const issue = makeIssue({ key: 'DOC-7' });
    const states: Record<string, SessionState[]> = {
      backlog: [],
      working: ['working'],
      'needs-you': ['idle'],
      review: [],
    };
    const view = projectWith({
      issues: [issue],
      sessions: (states[column] ?? []).map((state) => makeRecord({ issueKey: 'DOC-7', state })),
      flags: column === 'review' ? { 'DOC-7': { review: true } } : {},
    });
    const card = view.columns.find((c) => c.id === column)?.cards[0] as Card;
    expect(card.primaryPlaybookId).toBe(playbookId);
  });

  it('falls back to the first playbook when no playbook claims the lane', () => {
    const repo = makeRepo({ playbooks: [makePlaybook({ primaryFor: [] })] });
    const view = projectWith({ repo, flags: { 'DOC-1': { done: true } } });
    const card = view.columns.find((column) => column.id === 'done')?.cards[0] as Card;
    expect(card.primaryPlaybookId).toBe('implement');
  });
});

describe('counts', () => {
  it('counts the cards of each lane and the ones wanting attention', () => {
    const view = projectWith({
      issues: [
        makeIssue({ key: 'DOC-1' }),
        makeIssue({ key: 'DOC-2' }),
        makeIssue({ key: 'DOC-3' }),
      ],
      sessions: [
        makeRecord({ id: 'a', issueKey: 'DOC-1', state: 'idle' }),
        makeRecord({ id: 'b', issueKey: 'DOC-2', state: 'working' }),
      ],
    });
    expect(view.columns.map((column) => [column.id, column.count])).toEqual([
      ['backlog', 1],
      ['working', 1],
      ['needs-you', 1],
      ['review', 0],
      ['done', 0],
    ]);
    expect(view.needsYouCount).toBe(1);
  });
});

describe('session scoping', () => {
  it('ignores sessions of another workspace and archived ones', () => {
    const view = projectWith({
      sessions: [
        makeRecord({ id: 'other', repoId: 'elsewhere', state: 'working' }),
        makeRecord({ id: 'archived', state: 'working', archived: true }),
      ],
    });
    expect(columnOf(view, 'DOC-1')).toBe('backlog');
    expect((view.columns[0]?.cards[0] as Card).sessions).toEqual([]);
  });

  it('drops a session whose issue the caller did not supply', () => {
    const view = projectWith({
      issues: [],
      sessions: [makeRecord({ issueKey: 'DOC-404', state: 'working' })],
    });
    expect(view.columns.every((column) => column.cards.length === 0)).toBe(true);
  });
});

describe('missingIssueKeys', () => {
  it('names the issues a session references but the source did not list', () => {
    const sessions = [
      makeRecord({ id: 'a', issueKey: 'DOC-1' }),
      makeRecord({ id: 'b', issueKey: 'DOC-2' }),
      makeRecord({ id: 'c', issueKey: 'DOC-2' }),
      makeRecord({ id: 'd', issueKey: 'DOC-3', archived: true }),
      makeRecord({ id: 'e', issueKey: 'DOC-4', repoId: 'elsewhere' }),
    ];
    expect(missingIssueKeys('app', [makeIssue({ key: 'DOC-1' })], sessions)).toEqual(['DOC-2']);
  });

  it('is empty when the source listed everything', () => {
    expect(missingIssueKeys('app', [makeIssue()], [makeRecord()])).toEqual([]);
  });
});

describe('attachCommand', () => {
  it('names the tmux session', () => {
    expect(attachCommand('qc-DOC-1-implement')).toBe('tmux attach -t qc-DOC-1-implement');
  });
});
