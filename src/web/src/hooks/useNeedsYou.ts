import { useEffect, useRef } from 'react';
import type { BoardView } from '../../../core/api.js';
import { applyBadge, needsYouEntries, notifyNeedsYou } from '../notify.js';

/**
 * Mirrors the needs-you count into the title and favicon, and posts one
 * notification per session that enters the needs-you set.
 *
 * The first board seen only establishes the baseline, so opening the app with
 * three waiting sessions does not fire three notifications.
 *
 * @param board - Latest board view, or null before the first load.
 * @param onOpen - Called with a session id when a notification is activated.
 * @returns Nothing.
 */
export function useNeedsYouSignals(
  board: BoardView | null,
  onOpen: (sessionId: string) => void,
): void {
  const seen = useRef<Set<string> | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (board === null) return;
    applyBadge(board.needsYouCount);
    const entries = needsYouEntries(board);
    const previous = seen.current;
    seen.current = new Set(entries.keys());
    if (previous === null) return;
    for (const [id, entry] of entries) {
      if (previous.has(id)) continue;
      notifyNeedsYou(entry, (sessionId) => openRef.current(sessionId));
    }
  }, [board]);
}
