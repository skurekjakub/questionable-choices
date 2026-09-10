import { useEffect, useRef, useState } from 'react';
import type { BoardView, PublicConfigResponse } from '../../../core/api.js';
import { getBoard } from '../api.js';
import { findSessionOwner, lists } from '../session-owner.js';

/**
 * Switches to the workspace that owns a session the selected board does not
 * list, so a session URL resolves whichever board the owner was last looking at.
 *
 * Notifications are deduped by session id and outlive a workspace switch, so a
 * notification clicked after switching lands on a session the current board has
 * never heard of; the owning workspace is found by reading the other boards.
 * Each session id is searched at most once, and a search that has started
 * always answers: nothing cancels it, so the view cannot be left loading.
 *
 * @param sessionId - Id of the session being shown, or null off the session route.
 * @param config - Public configuration naming every workspace, or null before it loads.
 * @param board - Selected workspace's board, or null before it loads.
 * @param onSelectWorkspace - Called with the id of the workspace that owns the session.
 * @returns Whether a search is still in flight, so the view can say "loading"
 * rather than "session not found".
 */
export function useSessionOwner(
  sessionId: string | null,
  config: PublicConfigResponse | null,
  board: BoardView | null,
  onSelectWorkspace: (workspaceId: string) => void,
): boolean {
  const [searching, setSearching] = useState(false);
  const searched = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  const select = useRef(onSelectWorkspace);
  select.current = onSelectWorkspace;

  // The board is read through the ref rather than watched, because the board
  // frame is debounced and arrives repeatedly while a search is in flight. The
  // one thing the effect branches on is whether a loaded board has ruled the
  // session out, which is stable across those frames.
  const unlisted = sessionId !== null && board !== null && !lists(board, sessionId);

  useEffect(() => {
    const current = boardRef.current;
    if (sessionId === null || config === null || current === null || !unlisted) return;
    if (searched.current === sessionId) {
      // A re-run must report the search this session already started rather
      // than returning with `searching` stuck at whatever the last run left.
      setSearching(pending.current === sessionId);
      return;
    }
    searched.current = sessionId;
    const others = config.workspaces
      .filter((workspace) => workspace.id !== current.workspaceId)
      .map((workspace) => workspace.id);
    if (others.length === 0) return;
    pending.current = sessionId;
    setSearching(true);
    void findSessionOwner(sessionId, others, getBoard).then((owner) => {
      // A newer session's search owns the flag; this one's answer is stale and
      // must not clear a search that is still running.
      if (pending.current !== sessionId) return;
      pending.current = null;
      if (owner !== null) select.current(owner);
      setSearching(false);
    });
  }, [sessionId, config, unlisted]);

  // A board that has come to list the session answers the question the search
  // was asking, so the view stops waiting for the search whether or not it has
  // returned yet.
  return searching && unlisted;
}
