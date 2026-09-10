import type { BoardView } from '../../core/api.js';

/**
 * How long the whole cross-workspace search may take before it gives up.
 *
 * Each board read is a live issue-source read on the server, so a workspace
 * whose tracker is hanging would otherwise hold the session view in "loading"
 * for as long as that request takes — and while it is loading the view renders
 * a terminal for a session that may exist nowhere.
 */
export const OWNER_SEARCH_TIMEOUT_MS = 5000;

/**
 * Whether a board lists a session.
 *
 * @param board - Board view to search.
 * @param sessionId - Id of the session to look for.
 * @returns True when one of the board's cards carries that session.
 */
export function lists(board: BoardView, sessionId: string): boolean {
  return board.columns.some((column) =>
    column.cards.some((card) => card.sessions.some((session) => session.id === sessionId)),
  );
}

/**
 * Rejects once the given delay has passed.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that never resolves and rejects on the deadline.
 */
function expiresIn(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('the search ran out of time')), ms);
  });
}

/**
 * Finds which workspace owns a session, by reading the other workspaces'
 * boards until one lists it.
 *
 * A workspace whose board cannot be read — or cannot be read in time — cannot
 * rule the session in or out, so the search moves on; when the whole budget is
 * spent the answer is "not found" rather than a view that never settles.
 *
 * @param sessionId - Id of the session to locate.
 * @param workspaceIds - Workspaces to search, in the order to try them.
 * @param readBoard - Reads one workspace's board.
 * @param timeoutMs - Budget for the whole search, in milliseconds.
 * @returns The id of the workspace that lists the session, or null when none
 * of the boards read within the budget did.
 */
export async function findSessionOwner(
  sessionId: string,
  workspaceIds: readonly string[],
  readBoard: (workspaceId: string) => Promise<BoardView>,
  timeoutMs: number = OWNER_SEARCH_TIMEOUT_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (const workspaceId of workspaceIds) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    try {
      const view = await Promise.race([readBoard(workspaceId), expiresIn(left)]);
      if (lists(view, sessionId)) return workspaceId;
    } catch {
      // Unreachable, refused, or out of time: the remaining boards can still
      // answer, and the budget above is what stops this walking forever.
      continue;
    }
  }
  return null;
}
