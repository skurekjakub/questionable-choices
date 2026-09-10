import { useEffect, useState, type JSX } from 'react';
import type { BoardView } from '../../../core/api.js';
import { syncedAgo } from '../format.js';
import type { WorkspaceSummary } from '../../../core/api.js';
import { notificationPermission, requestNotificationPermission } from '../notify.js';
import { BellIcon, RefreshIcon } from './Icons.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

/**
 * Renders the board's fixed header: which epic is shown, how fresh it is, how
 * many sessions want the owner, and the notification opt-in.
 *
 * @param props - Component props.
 * @param props.workspaces - Workspaces offered by the switcher.
 * @param props.workspaceId - Id of the workspace currently shown.
 * @param props.board - Latest board view, or null before the first load.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.connected - Whether the event socket is open.
 * @param props.refreshing - Whether a manual refresh is in flight.
 * @param props.onSelectWorkspace - Called with the id the owner switched to.
 * @param props.onAddWorkspace - Called when the owner wants to add a workspace.
 * @param props.onRemoveWorkspace - Called when the owner wants to remove the active one.
 * @param props.onRefresh - Called when the owner asks for a refresh.
 * @returns The header element.
 */
export function BoardHeader({
  workspaces,
  workspaceId,
  board,
  nowMs,
  connected,
  refreshing,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRefresh,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  board: BoardView | null;
  nowMs: number;
  connected: boolean;
  refreshing: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const [permission, setPermission] = useState(() => notificationPermission());
  const needsYou = board?.needsYouCount ?? 0;

  // The permission can be granted or revoked in the browser's own settings,
  // which fires no event; re-reading it when the tab comes back is the only
  // moment the button can be corrected without a reload.
  useEffect(() => {
    const sync = (): void => setPermission(notificationPermission());
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return (
    <header className="board-header">
      <span className="wordmark">questionable choices</span>
      <WorkspaceSwitcher
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSelect={onSelectWorkspace}
        onAdd={onAddWorkspace}
        onRemove={onRemoveWorkspace}
      />

      <span className="header-spacer" />

      <div className="header-meta">
        <span role="status">
          {needsYou > 0 ? (
            <span className="needs-you-badge">
              <span className="count">{needsYou}</span> waiting for you
            </span>
          ) : null}
        </span>
        <span>{board === null ? 'loading' : syncedAgo(board.fetchedAt, nowMs)}</span>
        <span role="status">
          {connected ? null : <span title="Reconnecting to the server">stream offline</span>}
        </span>
        <span className="header-rule" />
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Refresh the board"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
        {permission === 'granted' || permission === 'unsupported' ? null : (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              void requestNotificationPermission()
                .then(setPermission)
                .catch(() => setPermission('denied'));
            }}
            disabled={permission === 'denied'}
            title={
              permission === 'denied'
                ? 'Notifications are blocked in the browser settings'
                : undefined
            }
          >
            <BellIcon />
            {permission === 'denied' ? 'Notifications blocked' : 'Turn on notifications'}
          </button>
        )}
      </div>
    </header>
  );
}
