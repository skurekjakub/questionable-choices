import { useEffect, useRef } from 'react';
import type { BoardView } from '../../../core/api.js';
import { applyBadge, needsYouEntries, notifyNeedsYou } from '../notify.js';

/**
 * Mirrors the needs-you count into the title and favicon, and posts one
 * notification per session that enters the needs-you set.
 *
 * The baseline is per workspace and the first board seen of one only
 * establishes it, so neither opening the app nor switching to a workspace with
 * three waiting sessions announces sessions that were already waiting.
 *
 * @param board - Latest board view, or null before the first load.
 * @param onOpen - Called with a session id when a notification is activated.
 * @returns Nothing.
 */
export function useNeedsYouSignals(
  board: BoardView | null,
  onOpen: (sessionId: string) => void,
): void {
  const seen = useRef<{ workspaceId: string; ids: Set<string> } | null>(null);
  const openRef = useRef(onOpen);

  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (board === null) return;
    applyBadge(board.needsYouCount);
    const entries = needsYouEntries(board);
    const previous = seen.current;
    seen.current = { workspaceId: board.workspaceId, ids: new Set(entries.keys()) };
    if (previous === null || previous.workspaceId !== board.workspaceId) return;
    for (const [id, entry] of entries) {
      if (previous.ids.has(id)) continue;
      notifyNeedsYou(entry, (sessionId) => openRef.current(sessionId));
    }
  }, [board]);
}
