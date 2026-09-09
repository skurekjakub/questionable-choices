import { useCallback, useEffect, useState, type JSX } from 'react';
import { Board } from './components/Board.js';
import { SessionView } from './components/SessionView.js';
import { useBoard } from './hooks/useBoard.js';
import { useConfig } from './hooks/useConfig.js';
import { useNeedsYouSignals } from './hooks/useNeedsYou.js';
import { useNow } from './hooks/useNow.js';

/**
 * localStorage key holding the workspace the owner last looked at.
 */
const WORKSPACE_KEY = 'qc.workspace';

/**
 * Event fired after a programmatic navigation, so the router re-reads the path.
 */
const NAVIGATE_EVENT = 'qc:navigate';

/**
 * Navigates to a path without a full page load.
 *
 * @param to - Path to navigate to, starting with a slash.
 * @returns Nothing.
 */
export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/**
 * Tracks the current pathname across back/forward and programmatic navigation.
 *
 * @returns The current pathname.
 */
function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  return path;
}

/**
 * Reads the session id out of a pathname.
 *
 * @param path - Current pathname.
 * @returns The session id, or null when the path is not a session route.
 */
function sessionIdFromPath(path: string): string | null {
  const match = /^\/session\/(.+)$/.exec(path);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/**
 * Roots the app: loads the configuration, follows one workspace's board, and
 * switches between the board and a single session's terminal.
 *
 * @returns The application element.
 */
export function App(): JSX.Element {
  const path = usePath();
  const nowMs = useNow();
  const { config, error: configError, reload: reloadConfig } = useConfig();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    window.localStorage.setItem(WORKSPACE_KEY, id);
  }, []);

  // The remembered workspace can vanish when it is removed elsewhere, so the
  // selection is re-derived from every configuration the server sends.
  useEffect(() => {
    if (config === null) return;
    setWorkspaceId((current) => {
      if (config.workspaces.some((workspace) => workspace.id === current)) return current;
      const remembered = window.localStorage.getItem(WORKSPACE_KEY);
      const known = config.workspaces.some((workspace) => workspace.id === remembered);
      return known && remembered !== null ? remembered : (config.workspaces[0]?.id ?? null);
    });
  }, [config]);

  const board = useBoard(workspaceId);
  const openSession = useCallback((sessionId: string) => {
    navigate(`/session/${encodeURIComponent(sessionId)}`);
  }, []);
  useNeedsYouSignals(board.board, openSession);

  const sessionId = sessionIdFromPath(path);
  if (sessionId !== null) {
    return (
      <SessionView
        sessionId={sessionId}
        board={board.board}
        nowMs={nowMs}
        onBack={() => navigate('/')}
      />
    );
  }

  return (
    <Board
      board={board.board}
      config={config}
      workspaceId={workspaceId}
      nowMs={nowMs}
      connected={board.connected}
      refreshing={board.refreshing}
      error={configError ?? board.error}
      onRefresh={board.refresh}
      onSelectWorkspace={selectWorkspace}
      onConfigChanged={reloadConfig}
      onOpenSession={openSession}
    />
  );
}
