import { useCallback, useEffect, useState, type JSX } from 'react';
import { Board } from './components/Board.js';
import { SessionView } from './components/SessionView.js';
import { useBoard } from './hooks/useBoard.js';
import { useConfig } from './hooks/useConfig.js';
import { useNeedsYouSignals } from './hooks/useNeedsYou.js';
import { useNow } from './hooks/useNow.js';
import { useSessionOwner } from './hooks/useSessionOwner.js';
import { navigate, NAVIGATE_EVENT } from './navigation.js';

/**
 * localStorage key holding the workspace the owner last looked at.
 */
const WORKSPACE_KEY = 'qc.workspace';

/**
 * Reads the workspace the owner last looked at.
 *
 * @returns The remembered id, or null when nothing is remembered or storage is
 * unreadable.
 */
function readRememberedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    // Storage throws outright when the browser blocks site data; remembering
    // the workspace is a convenience and must never take the app down with it.
    return null;
  }
}

/**
 * Remembers the workspace the owner is looking at.
 *
 * @param workspaceId - Id to remember.
 * @returns Nothing.
 */
function rememberWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, workspaceId);
  } catch {
    return;
  }
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
    rememberWorkspace(id);
  }, []);

  // Following a notification into another workspace's session is not the owner
  // choosing a board, so it must not change the one they come back to — on this
  // tab or the next cold start.
  const showWorkspace = useCallback((id: string) => setWorkspaceId(id), []);

  // The remembered workspace can vanish when it is removed elsewhere, so the
  // selection is re-derived from every configuration the server sends.
  useEffect(() => {
    if (config === null) return;
    setWorkspaceId((current) => {
      if (config.workspaces.some((workspace) => workspace.id === current)) return current;
      const remembered = readRememberedWorkspace();
      const known = config.workspaces.some((workspace) => workspace.id === remembered);
      return known && remembered !== null ? remembered : (config.workspaces[0]?.id ?? null);
    });
  }, [config]);

  const sessionId = sessionIdFromPath(path);
  const onSessionRoute = sessionId !== null;

  // A workspace the session route resolved is on screen without being the
  // owner's choice, so leaving that route puts the remembered board back —
  // otherwise the switcher and the next cold start disagree about which epic
  // the dashboard is showing.
  useEffect(() => {
    if (onSessionRoute || config === null) return;
    const remembered = readRememberedWorkspace();
    if (remembered === null) return;
    if (!config.workspaces.some((workspace) => workspace.id === remembered)) return;
    setWorkspaceId(remembered);
  }, [onSessionRoute, config]);

  const board = useBoard(workspaceId);
  const openSession = useCallback((sessionId: string) => {
    navigate(`/session/${encodeURIComponent(sessionId)}`);
  }, []);
  useNeedsYouSignals(board.board, openSession);

  const resolvingOwner = useSessionOwner(sessionId, config, board.board, showWorkspace);

  if (sessionId !== null) {
    return (
      <SessionView
        sessionId={sessionId}
        board={board.board}
        nowMs={nowMs}
        resolving={resolvingOwner}
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
