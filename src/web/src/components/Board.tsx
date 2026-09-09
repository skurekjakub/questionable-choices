import { useCallback, useRef, useState, type JSX } from 'react';
import type { BoardView } from '../../../core/api.js';
import { deleteWorkspace, errorMessage, openEditor, setFlags } from '../api.js';
import type { PublicConfigResponse } from '../../../core/api.js';
import { AddWorkspaceDialog } from './AddWorkspaceDialog.js';
import { BoardHeader } from './BoardHeader.js';
import type { CardHandlers } from './Card.js';
import { Column } from './Column.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { IssueDrawer } from './IssueDrawer.js';
import { StartDialog } from './StartDialog.js';

/**
 * Which overlay is open over the board, if any.
 */
type Overlay =
  | { kind: 'drawer'; issueKey: string }
  | { kind: 'start'; issueKey: string; playbookId: string }
  | { kind: 'add-workspace' }
  | { kind: 'remove-workspace' }
  | null;

/**
 * Renders the whole board: header, five lanes, and whichever overlay is open.
 *
 * @param props - Component props.
 * @param props.board - Latest board view, or null before the first load.
 * @param props.config - Public configuration, or null before the first load.
 * @param props.workspaceId - Id of the workspace currently shown.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.connected - Whether the event socket is open.
 * @param props.refreshing - Whether a manual refresh is in flight.
 * @param props.error - Message from the last failed load, or null.
 * @param props.onRefresh - Called when the owner asks for a refresh.
 * @param props.onSelectWorkspace - Called with the id the owner switched to.
 * @param props.onConfigChanged - Called after a workspace is added or removed.
 * @param props.onOpenSession - Called with a session id to show its terminal.
 * @returns The board view.
 */
export function Board({
  board,
  config,
  workspaceId,
  nowMs,
  connected,
  refreshing,
  error,
  onRefresh,
  onSelectWorkspace,
  onConfigChanged,
  onOpenSession,
}: {
  board: BoardView | null;
  config: PublicConfigResponse | null;
  workspaceId: string | null;
  nowMs: number;
  connected: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onConfigChanged: () => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [visibleColumn, setVisibleColumn] = useState(0);
  const columns = useRef<HTMLDivElement>(null);

  // Below the breakpoint the lanes are a snapping strip, so which one is on
  // screen is read back off the scroll offset rather than tracked in state.
  const onColumnsScroll = useCallback(() => {
    const strip = columns.current;
    const lanes = board?.columns.length ?? 0;
    if (strip === null || lanes === 0) return;
    const step = strip.scrollWidth / lanes;
    setVisibleColumn(Math.min(lanes - 1, Math.max(0, Math.round(strip.scrollLeft / step))));
  }, [board?.columns.length]);

  const workspaces = config?.workspaces ?? [];
  const active = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  const handlers: CardHandlers = {
    openIssue: (card) => setOverlay({ kind: 'drawer', issueKey: card.issue.key }),
    startPlaybook: (card, playbookId) =>
      setOverlay({ kind: 'start', issueKey: card.issue.key, playbookId }),
    openSession: onOpenSession,
    openEditor: (card) => {
      if (workspaceId === null) return;
      openEditor(workspaceId, card.issue.key).catch((cause: unknown) =>
        setActionError(errorMessage(cause)),
      );
    },
    setFlag: (card, flag, value) => {
      if (workspaceId === null) return;
      setFlags(workspaceId, card.issue.key, { [flag]: value })
        .then(() => setActionError(null))
        .catch((cause: unknown) => setActionError(errorMessage(cause)));
    },
  };

  const overlayKey = overlay !== null && 'issueKey' in overlay ? overlay.issueKey : null;
  const overlayCard =
    overlayKey === null
      ? null
      : (board?.columns
          .flatMap((column) => column.cards)
          .find((card) => card.issue.key === overlayKey) ?? null);

  const removeActive = (): void => {
    if (workspaceId === null) return;
    setRemoving(true);
    deleteWorkspace(workspaceId)
      .then(() => {
        const next = workspaces.find((workspace) => workspace.id !== workspaceId) ?? null;
        setOverlay(null);
        setRemoveError(null);
        onConfigChanged();
        if (next !== null) onSelectWorkspace(next.id);
      })
      .catch((cause: unknown) => setRemoveError(errorMessage(cause)))
      .finally(() => setRemoving(false));
  };

  return (
    <div className="app">
      <BoardHeader
        workspaces={workspaces}
        workspaceId={workspaceId}
        board={board}
        nowMs={nowMs}
        connected={connected}
        refreshing={refreshing}
        onSelectWorkspace={onSelectWorkspace}
        onAddWorkspace={() => setOverlay({ kind: 'add-workspace' })}
        onRemoveWorkspace={() => {
          setRemoveError(null);
          setOverlay({ kind: 'remove-workspace' });
        }}
        onRefresh={onRefresh}
      />

      {error === null ? null : (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {board?.sourceError == null ? null : (
        <p className="banner" role="alert">
          Showing the last good list. {board.sourceError}
        </p>
      )}
      {actionError === null ? null : (
        <p className="banner" role="alert">
          {actionError}
        </p>
      )}

      {board === null ? (
        <p className="empty">Loading the board.</p>
      ) : (
        <>
          <div className="columns" ref={columns} onScroll={onColumnsScroll}>
            {board.columns.map((column) => (
              <Column
                key={column.id}
                column={column}
                playbooks={board.playbooks}
                nowMs={nowMs}
                handlers={handlers}
              />
            ))}
          </div>
          <p className="columns-indicator">
            <span className="columns-dots" aria-hidden="true">
              {board.columns.map((column, index) => (
                <span key={column.id} data-current={index === visibleColumn} />
              ))}
            </span>
            {board.columns[visibleColumn]?.name ?? ''} — {visibleColumn + 1} of{' '}
            {board.columns.length}
          </p>
        </>
      )}

      {overlay?.kind === 'drawer' && overlayCard !== null && workspaceId !== null ? (
        <IssueDrawer
          card={overlayCard}
          workspaceId={workspaceId}
          playbooks={board?.playbooks ?? []}
          nowMs={nowMs}
          onClose={() => setOverlay(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}

      {overlay?.kind === 'start' &&
      overlayCard !== null &&
      workspaceId !== null &&
      config !== null ? (
        <StartDialog
          card={overlayCard}
          workspaceId={workspaceId}
          playbooks={board?.playbooks ?? []}
          runner={config.runner}
          initialPlaybookId={overlay.playbookId}
          onClose={() => setOverlay(null)}
          onStarted={(sessionId) => {
            setOverlay(null);
            onOpenSession(sessionId);
          }}
        />
      ) : null}

      {overlay?.kind === 'add-workspace' && config !== null ? (
        <AddWorkspaceDialog
          repos={config.repos}
          connectors={config.connectors}
          onClose={() => setOverlay(null)}
          onAdded={(workspace) => {
            setOverlay(null);
            onConfigChanged();
            onSelectWorkspace(workspace.id);
          }}
        />
      ) : null}

      {overlay?.kind === 'remove-workspace' && active !== null ? (
        <ConfirmDialog
          title={`Remove ${active.name}?`}
          body={`The board for ${active.epic} disappears from the switcher. Sessions and worktrees belong to the ${active.repo} repo and are kept.`}
          confirmLabel={removing ? 'Removing' : 'Remove workspace'}
          error={removeError}
          busy={removing}
          onConfirm={removeActive}
          onCancel={() => setOverlay(null)}
        />
      ) : null}
    </div>
  );
}
