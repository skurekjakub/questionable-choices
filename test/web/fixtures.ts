import type { BoardView, Card, CardSession, PublicConfigResponse } from '../../src/core/api.js';
import type { SessionState } from '../../src/web/src/model.js';

/**
 * A fixed instant the fixtures below are stamped with, so a test that reads a
 * duration has something stable to measure from.
 */
export const FIXTURE_NOW = '2026-09-10T12:00:00.000Z';

/**
 * Builds one card session, defaulting every field the caller does not care
 * about.
 *
 * The fixtures build real contract values rather than casting a partial shape
 * through `unknown`: a fixture exempt from the contract it claims to carry
 * stops failing when the contract changes, which is the one thing it is for.
 *
 * @param id - Session id.
 * @param overrides - Fields to set, over the defaults.
 * @returns The session.
 */
export function cardSession(id: string, overrides: Partial<CardSession> = {}): CardSession {
  const state: SessionState = overrides.state ?? 'working';
  return {
    id,
    playbookId: 'implement',
    state,
    stateSince: FIXTURE_NOW,
    pending: null,
    lastAssistantMessage: null,
    lastExitCode: null,
    staleSince: null,
    cache: null,
    done: false,
    live: state === 'working' || state === 'bootstrapping' || state === 'starting',
    needsYou: false,
    branch: null,
    attachCommand: `tmux attach -t ${id}`,
    ...overrides,
  };
}

/**
 * Builds one card, defaulting every field the caller does not care about.
 *
 * @param key - Tracker key of the issue.
 * @param sessions - Sessions on the card.
 * @param overrides - Fields to set, over the defaults.
 * @returns The card.
 */
export function card(
  key: string,
  sessions: CardSession[] = [],
  overrides: Partial<Card> = {},
): Card {
  return {
    issue: {
      key,
      summary: `${key} summary`,
      type: 'Task',
      status: 'In Progress',
      statusCategory: 'inprogress',
      labels: [],
      url: `https://example.atlassian.net/browse/${key}`,
    },
    column: 'working',
    sessions,
    primaryPlaybookId: 'implement',
    worktreePath: null,
    flags: {},
    needsYou: sessions.some((session) => session.needsYou),
    ...overrides,
  };
}

/**
 * Builds a board holding one lane of the given cards.
 *
 * @param workspaceId - Workspace the board belongs to.
 * @param cards - Cards to put in the lane.
 * @param overrides - Fields to set, over the defaults.
 * @returns The board view.
 */
export function boardView(
  workspaceId: string,
  cards: Card[] = [],
  overrides: Partial<BoardView> = {},
): BoardView {
  return {
    workspaceId,
    name: workspaceId,
    playbooks: [
      {
        id: 'implement',
        label: 'Implement',
        description: 'Implements the issue.',
        isolation: 'worktree',
      },
    ],
    columns: [{ id: 'working', name: 'Working', cards, count: cards.length }],
    sourceError: null,
    fetchedAt: FIXTURE_NOW,
    needsYouCount: cards.filter((entry) => entry.needsYou).length,
    ...overrides,
  };
}

/**
 * Builds a board that lists exactly the given session ids, one card each.
 *
 * @param workspaceId - Workspace the board belongs to.
 * @param sessionIds - Sessions the board should list.
 * @returns The board view.
 */
export function boardListing(workspaceId: string, sessionIds: string[]): BoardView {
  return boardView(
    workspaceId,
    sessionIds.map((id, index) => card(`DOC-${index + 1}`, [cardSession(id)])),
  );
}

/**
 * Builds a public configuration naming exactly the given workspaces.
 *
 * @param ids - Workspace ids the configuration names, in switcher order.
 * @returns The configuration.
 */
export function publicConfig(ids: string[]): PublicConfigResponse {
  return {
    workspaces: ids.map((id) => ({ id, name: id, epic: 'DOC-1', repo: 'app', connector: 'jira' })),
    repos: [{ id: 'app', path: '/repos/app' }],
    connectors: [{ id: 'jira', site: 'example.atlassian.net' }],
    runner: {
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
      defaults: { model: 'claude-opus-5', effort: 'high', permissionMode: 'acceptEdits' },
      efforts: ['low', 'medium', 'high'],
      permissionModes: ['default', 'acceptEdits', 'plan'],
    },
  };
}
