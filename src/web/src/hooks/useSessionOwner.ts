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
 * Each session id is searched at most once per configuration that has another
 * workspace to read, and a search that has started always answers: nothing
 * cancels it, so the view cannot be left loading. An answer about a session the
 * owner has since left is dropped rather than acted on.
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
    if (sessionId === null || config === null || current === null || !unlisted) {
      // A session the board already lists starts no search, so nothing else
      // would retire the one still running for the session left behind — and
      // its answer would switch the board out from under this one.
      if (pending.current !== null && pending.current !== sessionId) pending.current = null;
      return;
    }
    if (searched.current === sessionId) {
      // A re-run must report the search this session already started rather
      // than returning with `searching` stuck at whatever the last run left.
      setSearching(pending.current === sessionId);
      return;
    }
    const others = config.workspaces
      .filter((workspace) => workspace.id !== current.workspaceId)
      .map((workspace) => workspace.id);
    // A configuration with nothing to search has not searched this session: a
    // workspace added later must still be able to answer for it.
    if (others.length === 0) return;
    searched.current = sessionId;
    pending.current = sessionId;
    setSearching(true);
    void findSessionOwner(sessionId, others, getBoard).then((owner) => {
      // `pending` names the session on screen, so an answer that is not about
      // it is stale: acting on it would switch the board to the owner of a
      // session the owner has already left, and clear a search still running.
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
