import { useCallback, useEffect, useState } from 'react';
import type { BoardView } from '../../../core/api.js';
import { errorMessage, getBoard, refreshBoard } from '../api.js';
import { subscribeEvents } from '../ws.js';

/**
 * What {@link useBoard} exposes to the board and session views.
 */
export interface BoardStream {
  /** The latest board view, or null before the first load. */
  board: BoardView | null;
  /** Whether the first load is still in flight. */
  loading: boolean;
  /** Message from the last failed load or refresh, or null. */
  error: string | null;
  /** Whether the event socket is currently open. */
  connected: boolean;
  /** Whether a manual refresh is in flight. */
  refreshing: boolean;
  /** Asks the server to re-read the issue source and replaces the view. */
  refresh: () => void;
}

/**
 * Loads a workspace's board and keeps it current from the shared event stream,
 * which every hook multiplexes over one socket. Switching workspaces re-enters
 * the stream rather than reconnecting, and the newest cached frame for the new
 * workspace is replayed straight away.
 *
 * @param workspaceId - Id of the workspace to show, or null before the config loads.
 * @returns The board view, its load state, and a manual refresh.
 */
export function useBoard(workspaceId: string | null): BoardStream {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(workspaceId !== null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (workspaceId === null) {
      setBoard(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setBoard(null);
    getBoard(workspaceId)
      .then((view) => {
        if (!live) return;
        setBoard(view);
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
  }, [workspaceId]);

  useEffect(() => {
    return subscribeEvents({
      onConnected: setConnected,
      onFrame: (frame) => {
        if (frame.type !== 'board') return;
        if (frame.workspaceId !== workspaceId) return;
        setBoard(frame.view);
      },
    });
  }, [workspaceId]);

  const refresh = useCallback(() => {
    if (workspaceId === null) return;
    setRefreshing(true);
    refreshBoard(workspaceId)
      .then((view) => {
        setBoard(view);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setRefreshing(false));
  }, [workspaceId]);

  return { board, loading, error, connected, refreshing, refresh };
}
