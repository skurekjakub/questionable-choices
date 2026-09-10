import { useEffect, useRef, useState } from 'react';
import type { BoardView, PublicConfigResponse } from '../../../core/api.js';
import { getBoard } from '../api.js';

/**
 * Whether a board lists a session.
 *
 * @param board - Board view to search.
 * @param sessionId - Id of the session to look for.
 * @returns True when one of the board's cards carries that session.
 */
function lists(board: BoardView, sessionId: string): boolean {
  return board.columns.some((column) =>
    column.cards.some((card) => card.sessions.some((session) => session.id === sessionId)),
  );
}

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
    const others = config.workspaces.filter((workspace) => workspace.id !== board.workspaceId);
    if (others.length === 0) return;
    setSearching(true);
    void (async () => {
      for (const workspace of others) {
        try {
          const view = await getBoard(workspace.id);
          if (lists(view, sessionId)) {
            onSelectWorkspace(workspace.id);
            break;
          }
        } catch {
          // A workspace whose source is unreachable cannot rule the session in
          // or out; the remaining boards still can.
          continue;
        }
      }
      setSearching(false);
    })();
  }, [sessionId, config, board, onSelectWorkspace]);

  return searching;
}
