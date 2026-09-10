import { useCallback, useEffect, useState } from 'react';
import type { BoardView } from '../../../core/api.js';
import { errorMessage, getIssue } from '../api.js';
import type { Issue, SessionRecord } from '../model.js';
import { subscribeEvents } from '../ws.js';

/**
 * Where a session sits: which workspace and issue own it, and where it runs.
 */
export interface SessionContext {
  /** The record as the server last reported it, or null while it loads. */
  record: SessionRecord | null;
  /** The issue the session works on, or null while it loads. */
  issue: Issue | null;
  /** Workspace that owns the session, or null until the board names it. */
  workspaceId: string | null;
  /** Absolute worktree path for the issue, or null when it has none. */
  worktreePath: string | null;
  /** Message from the last failed load, or null. */
  error: string | null;
  /** Whether the first load is still in flight; false once the board rules the session out. */
  loading: boolean;
  /**
   * Whether a loaded board lists no such session.
   *
   * This is the answer to "does this session exist", and the issue detail is
   * not: a tracker outage refuses the detail for a session that is running.
   */
  missing: boolean;
  /** Re-reads the issue and its sessions from the server. */
  reload: () => void;
}

/**
 * Locates a session on a board view.
 *
 * @param board - Board view to search, or null.
 * @param sessionId - Id of the session to find.
 * @returns The issue key and worktree path of its card, or null when absent.
 */
function findOnBoard(
  board: BoardView | null,
  sessionId: string,
): { issueKey: string; worktreePath: string | null } | null {
  if (board === null) return null;
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.sessions.some((session) => session.id === sessionId)) {
        return { issueKey: card.issue.key, worktreePath: card.worktreePath };
      }
    }
  }
  return null;
}

/**
 * Follows one session: its record, its issue, and its checkout.
 *
 * The board supplies the issue key, so a session opened by URL resolves only
 * once the board it belongs to has loaded. A loaded board that lists no such
 * session settles as not found rather than loading forever.
 *
 * @param sessionId - Id of the session to follow.
 * @param board - Latest board view, used to locate the session's card.
 * @returns The record, the issue and the load state.
 */
export function useSession(sessionId: string, board: BoardView | null): SessionContext {
  const located = findOnBoard(board, sessionId);
  const issueKey = located?.issueKey ?? null;
  const workspaceId = board?.workspaceId ?? null;
  const [record, setRecord] = useState<SessionRecord | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [detailWorktree, setDetailWorktree] = useState<{ path: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // A board that has loaded and does not list the session is the answer, not a
  // step towards one: no later frame will introduce it.
  const missing = board !== null && located === null;

  useEffect(() => {
    if (workspaceId === null || issueKey === null) return;
    let live = true;
    setLoading(true);
    getIssue(workspaceId, issueKey)
      .then((detail) => {
        if (!live) return;
        setIssue(detail.issue);
        setDetailWorktree({ path: detail.worktreePath });
        setRecord(detail.sessions.find((entry) => entry.id === sessionId) ?? null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, issueKey, sessionId, reloadKey]);

  useEffect(() => {
    return subscribeEvents({
      onFrame: (frame) => {
        if (frame.type !== 'session') return;
        if (frame.record.id !== sessionId) return;
        setRecord(frame.record);
      },
    });
  }, [sessionId]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    record,
    issue,
    workspaceId,
    // Once the detail has loaded its worktree is the truth, including the null
    // a removal leaves behind; the board's copy only fills the gap before that.
    worktreePath: detailWorktree === null ? (located?.worktreePath ?? null) : detailWorktree.path,
    error,
    loading: !missing && loading && record === null,
    missing,
    reload,
  };
}
