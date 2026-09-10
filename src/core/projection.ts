import { LIVE_STATES, NEEDS_YOU_STATES } from './api.js';
import type { BoardColumn, BoardView, Card, CardSession, PlaybookSummary } from './api.js';
import { isLive, needsYou } from './state-machine.js';
import {
  COLUMN_IDS,
  COLUMN_NAMES,
  type ColumnId,
  type Issue,
  type IssueFlags,
  type RepoConfig,
  type SessionRecord,
  type SessionState,
  type WorkspaceConfig,
} from './types.js';

/**
 * States in which a session is making progress on its own: live but not
 * blocked on the owner.
 */
const BUSY_STATES: ReadonlySet<SessionState> = new Set(
  [...LIVE_STATES].filter((state) => !NEEDS_YOU_STATES.has(state)),
);

/**
 * States in which a dialog is on screen, as opposed to a merely idle prompt.
 */
const DIALOG_STATES: ReadonlySet<SessionState> = new Set(
  [...NEEDS_YOU_STATES].filter((state) => state !== 'idle'),
);

/**
 * The one state that means "your turn" without a dialog on screen.
 */
const IDLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>(['idle']);

/**
 * Builds the shell command that attaches a terminal to a session.
 *
 * @param sessionId - Session id, which is also the tmux session name.
 * @returns The command, e.g. `tmux attach -t qc-DOC-3847-implement`.
 */
export function attachCommand(sessionId: string): string {
  return `tmux attach -t ${sessionId}`;
}

/**
 * Everything the projection needs to turn issues and sessions into a board.
 */
export interface ProjectionInput {
  /** Id of the workspace being projected; also the board id. */
  workspaceId: string;
  /** The workspace's configuration: its name, repo and review statuses. */
  workspace: WorkspaceConfig;
  /** Configuration of the repo the workspace names, supplying the playbooks. */
  repo: RepoConfig;
  /** Issues from the source, in source order. */
  issues: Issue[];
  /** Every session record known to the app; sessions of other repos are ignored. */
  sessions: SessionRecord[];
  /** Owner-set flags, keyed by issue key. */
  flags: Record<string, IssueFlags>;
  /** Known worktree paths, keyed by issue key. */
  worktrees?: Record<string, string> | undefined;
  /** Message from the last failed source refresh, or null when the list is fresh. */
  sourceError?: string | null | undefined;
  /** ISO timestamp of the last successful source refresh. */
  fetchedAt: string;
}

/**
 * Lists issue keys that have a session but did not come back from the source.
 *
 * The board must show these anyway, so the caller fetches them one by one.
 *
 * @param repoId - Repo whose sessions are relevant.
 * @param issues - Issues the source returned.
 * @param sessions - Every session record known to the app.
 * @returns The missing keys, in first-seen order and without duplicates.
 */
export function missingIssueKeys(
  repoId: string,
  issues: Issue[],
  sessions: SessionRecord[],
): string[] {
  const known = new Set(issues.map((issue) => issue.key));
  const missing: string[] = [];
  for (const session of sessions) {
    if (session.repoId !== repoId || session.archived) continue;
    if (known.has(session.issueKey)) continue;
    known.add(session.issueKey);
    missing.push(session.issueKey);
  }
  return missing;
}

/**
 * Picks the lane an issue belongs in, first match winning.
 *
 * @param issue - The issue being placed.
 * @param sessions - The issue's non-archived sessions on this board.
 * @param flags - Owner-set flags for the issue.
 * @param reviewStatuses - Status names that mean "in review".
 * @returns The lane id.
 */
function columnFor(
  issue: Issue,
  sessions: SessionRecord[],
  flags: IssueFlags,
  reviewStatuses: string[],
): ColumnId {
  const liveSessions = sessions.filter((session) => isLive(session.state));
  if (liveSessions.some((session) => needsYou(session.state))) return 'needs-you';
  if (liveSessions.some((session) => BUSY_STATES.has(session.state))) return 'working';
  if (flags.done === true || issue.statusCategory === 'done') return 'done';
  if (flags.review === true || reviewStatuses.includes(issue.status)) return 'review';
  return 'backlog';
}

/**
 * Converts a session record into the row a card shows.
 *
 * @param record - The session record.
 * @returns The card row.
 */
function toCardSession(record: SessionRecord): CardSession {
  return {
    id: record.id,
    playbookId: record.playbookId,
    state: record.state,
    stateSince: record.stateSince,
    pending: record.pending,
    lastAssistantMessage: record.lastAssistantMessage,
    lastExitCode: record.lastExitCode,
    staleSince: record.staleSince,
    cache: record.cache,
    done: record.done,
    live: isLive(record.state),
    needsYou: needsYou(record.state),
    branch: record.branch,
    attachCommand: attachCommand(record.id),
  };
}

/**
 * Ranks a card's urgency inside the Needs you lane: waiting beats idle.
 *
 * @param card - The card to rank.
 * @returns 0 for a card with a dialog on screen, 1 for a merely idle one.
 */
function needsYouRank(card: Card): number {
  return card.sessions.some((session) => DIALOG_STATES.has(session.state)) ? 0 : 1;
}

/**
 * Earliest `stateSince` among the sessions that put the card in its lane.
 *
 * @param card - The card to measure.
 * @param states - States a session must be in to count.
 * @returns The ISO timestamp, or an empty string when no session qualifies.
 */
function oldestStateSince(card: Card, states: ReadonlySet<SessionState>): string {
  let oldest = '';
  for (const session of card.sessions) {
    if (!states.has(session.state)) continue;
    if (oldest === '' || session.stateSince < oldest) oldest = session.stateSince;
  }
  return oldest;
}

/**
 * Orders the cards of one lane.
 *
 * @param columnId - Lane the cards belong to.
 * @param cards - Cards in source order.
 * @returns A new array in display order.
 */
function orderCards(columnId: ColumnId, cards: Card[]): Card[] {
  if (columnId === 'needs-you') {
    return [...cards].sort((a, b) => {
      const rank = needsYouRank(a);
      if (rank !== needsYouRank(b)) return rank - needsYouRank(b);
      // Cards of one rank are compared on the sessions that earned them that
      // rank, so an older idle session cannot outrank a longer-blocked dialog.
      const states = rank === 0 ? DIALOG_STATES : IDLE_STATES;
      return oldestStateSince(a, states).localeCompare(oldestStateSince(b, states));
    });
  }
  if (columnId === 'working') {
    return [...cards].sort((a, b) =>
      oldestStateSince(a, BUSY_STATES).localeCompare(oldestStateSince(b, BUSY_STATES)),
    );
  }
  return cards;
}

/**
 * Projects issues and session records into the board the UI renders.
 *
 * Issues keep source order inside the Review, Done and Backlog lanes; the
 * Needs you and Working lanes are re-ordered by how long they have waited.
 *
 * @param input - Issues, sessions, flags and the board's configuration.
 * @returns The board view.
 */
export function project(input: ProjectionInput): BoardView {
  const playbooks: PlaybookSummary[] = input.repo.playbooks.map((playbook) => ({
    id: playbook.id,
    label: playbook.label,
    description: playbook.description,
    isolation: playbook.isolation,
  }));
  const primaryByColumn = new Map<ColumnId, string | null>();
  for (const columnId of COLUMN_IDS) {
    const match = input.repo.playbooks.find((playbook) => playbook.primaryFor.includes(columnId));
    primaryByColumn.set(columnId, match?.id ?? playbooks[0]?.id ?? null);
  }

  const byIssue = new Map<string, SessionRecord[]>();
  for (const session of input.sessions) {
    if (session.repoId !== input.workspace.repo || session.archived) continue;
    const list = byIssue.get(session.issueKey);
    if (list === undefined) byIssue.set(session.issueKey, [session]);
    else list.push(session);
  }

  const buckets = new Map<ColumnId, Card[]>(COLUMN_IDS.map((id) => [id, []]));
  const reviewStatuses = input.workspace.reviewStatuses;

  for (const issue of input.issues) {
    const sessions = (byIssue.get(issue.key) ?? []).slice().sort((a, b) => {
      const live = Number(isLive(b.state)) - Number(isLive(a.state));
      return live !== 0 ? live : b.createdAt.localeCompare(a.createdAt);
    });
    const flags = input.flags[issue.key] ?? {};
    const column = columnFor(issue, sessions, flags, reviewStatuses);
    const card: Card = {
      issue: {
        key: issue.key,
        summary: issue.summary,
        type: issue.type,
        status: issue.status,
        statusCategory: issue.statusCategory,
        labels: issue.labels,
        url: issue.url,
      },
      column,
      sessions: sessions.map(toCardSession),
      primaryPlaybookId: primaryByColumn.get(column) ?? null,
      worktreePath: input.worktrees?.[issue.key] ?? null,
      flags,
      needsYou: sessions.some((session) => isLive(session.state) && needsYou(session.state)),
    };
    (buckets.get(column) as Card[]).push(card);
  }

  const columns: BoardColumn[] = COLUMN_IDS.map((id) => {
    const cards = orderCards(id, buckets.get(id) ?? []);
    return { id, name: COLUMN_NAMES[id], cards, count: cards.length };
  });

  return {
    workspaceId: input.workspaceId,
    name: input.workspace.name,
    playbooks,
    columns,
    sourceError: input.sourceError ?? null,
    fetchedAt: input.fetchedAt,
    needsYouCount: (buckets.get('needs-you') ?? []).length,
  };
}
