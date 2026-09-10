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
 * Each session id is searched at most once.
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

  useEffect(() => {
    if (sessionId === null || board === null || config === null) return;
    if (lists(board, sessionId)) {
      setSearching(false);
      return;
    }
    if (searched.current === sessionId) return;
    searched.current = sessionId;
    const others = config.workspaces
      .filter((workspace) => workspace.id !== board.workspaceId)
      .map((workspace) => workspace.id);
    if (others.length === 0) return;
    let live = true;
    setSearching(true);
    void findSessionOwner(sessionId, others, getBoard).then((owner) => {
      if (!live) return;
      if (owner !== null) onSelectWorkspace(owner);
      setSearching(false);
    });
    return () => {
      live = false;
    };
  }, [sessionId, config, board, onSelectWorkspace]);

  return searching;
}
