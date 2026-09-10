import { lazy, Suspense, useEffect, useState, type JSX } from 'react';
import type { BoardView, SessionAction } from '../../../core/api.js';
import {
  errorMessage,
  getSessionEvents,
  isForceableRemoval,
  openEditor,
  removeWorktree,
  sessionAction,
} from '../api.js';
import { failureReason } from '../failure.js';
import { attachCommand } from '../format.js';
import { useSession } from '../hooks/useSession.js';
import { LIVE_STATES, NEEDS_YOU_STATES, STATE_LABELS } from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { CopyButton } from './CopyButton.js';
import { EditorIcon, ExternalIcon } from './Icons.js';
import { Lamp } from './Lamp.js';

/**
 * The terminal and the xterm bundle behind it, which is the largest dependency
 * in the app and is reachable only from this route.
 */
const SessionTerminal = lazy(() =>
  import('./Terminal.js').then((module) => ({ default: module.SessionTerminal })),
);

/**
 * Shows one session: its terminal, its lifecycle controls, and the issue it is
 * working on.
 *
 * A session no board lists has no terminal, no checkout and no attach command:
 * the sections that would describe one are suppressed rather than filled with
 * claims about a session that is not there.
 *
 * @param props - Component props.
 * @param props.sessionId - Id of the session to show.
 * @param props.board - Latest board view, used to locate the session's issue.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.resolving - Whether another workspace is still being searched for the session.
 * @param props.onBack - Called when the owner leaves for the board.
 * @returns The session view.
 */
export function SessionView({
  sessionId,
  board,
  nowMs,
  resolving,
  onBack,
}: {
  sessionId: string;
  board: BoardView | null;
  nowMs: number;
  resolving: boolean;
  onBack: () => void;
}): JSX.Element {
  const {
    record,
    issue,
    workspaceId,
    worktreePath,
    error,
    loading: sessionLoading,
    reload,
  } = useSession(sessionId, board);
  const loading = sessionLoading || resolving;
  const [attached, setAttached] = useState(false);
  const [reconnectSignal, setReconnectSignal] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The reducer keeps no field for why a session failed, so the reason is read
  // back out of the raw event log the server already serves.
  const state = record?.state ?? null;
  useEffect(() => {
    if (state !== 'failed') {
      setFailure(null);
      return;
    }
    let live = true;
    getSessionEvents(sessionId)
      .then((log) => {
        if (live) setFailure(failureReason(log.events));
      })
      .catch(() => {
        if (live) setFailure(null);
      });
    return () => {
      live = false;
    };
  }, [sessionId, state]);

  // No board lists the session and nothing is still looking, so the terminal,
  // the checkout and the attach command have nothing to describe.
  const absent = record === null && !loading;
  const live = record !== null && LIVE_STATES.has(record.state);
  const needsYou = record !== null && NEEDS_YOU_STATES.has(record.state);
  const playbookLabel =
    board?.playbooks.find((playbook) => playbook.id === record?.playbookId)?.label ??
    record?.playbookId ??
    '';
  const cardSession =
    board?.columns
      .flatMap((column) => column.cards)
      .flatMap((card) => card.sessions)
      .find((session) => session.id === sessionId) ?? null;
  const attach = attachCommand(sessionId, cardSession?.attachCommand);
  // The board names the branch before the issue detail has loaded, so the
  // header reads it from whichever source has it.
  const branch = record?.branch ?? cardSession?.branch ?? null;

  const runAction = (action: SessionAction): void => {
    setBusy(true);
    sessionAction(sessionId, action)
      .then(() => {
        setActionError(null);
        setActionNotice(null);
        reload();
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const runRemoveWorktree = (): void => {
    setBusy(true);
    removeWorktree(sessionId, forceRemove)
      .then((removed) => {
        setActionError(null);
        setActionNotice(`Removed ${removed.path}`);
        setForceRemove(false);
        reload();
      })
      .catch((cause: unknown) => {
        setActionError(errorMessage(cause));
        setForceRemove(isForceableRemoval(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="session-view">
      <header className="session-header">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back to board
        </button>
        <span className="key">{record?.issueKey ?? issue?.key ?? sessionId}</span>
        <span className="playbook">{playbookLabel}</span>
        {record === null ? (
          <span className="state-pill">
            {loading ? 'loading' : error !== null ? 'could not load' : 'session not found'}
          </span>
        ) : (
          <span className="state-pill" data-alert={needsYou}>
            <Lamp state={record.state} />
            {STATE_LABELS[record.state]}
            {record.pending === null ? null : (
              <span className="pending">— {record.pending.summary}</span>
            )}
          </span>
        )}
        {branch === null ? null : <span className="branch">{branch}</span>}
        <CacheReadout cache={record?.cache ?? null} nowMs={nowMs} />
        <span className="header-spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy || !live}
          onClick={() => runAction('interrupt')}
        >
          Interrupt
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || !live}
          onClick={() => runAction('kill')}
        >
          Kill
        </button>
        {record !== null && !live ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || record.claudeSessionId === null}
            title={
              record.claudeSessionId === null
                ? 'This session never reported a Claude session id'
                : undefined
            }
            onClick={() => runAction('resume')}
          >
            Resume
          </button>
        ) : null}
      </header>

      {error === null ? null : (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      <div className="session-main">
        <div className="terminal-pane">
          {absent ? (
            <p className="empty">
              {error === null
                ? 'No board lists this session, so there is no terminal to attach to.'
                : 'This session could not be loaded, so no terminal was attached.'}
            </p>
          ) : (
            <>
              <div role="status">
                {attached ? null : (
                  <div className="detached-bar">
                    <span>Detached from the terminal.</span>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setReconnectSignal((value) => value + 1)}
                    >
                      Reconnect
                    </button>
                  </div>
                )}
              </div>
              <Suspense fallback={<div className="terminal-host" />}>
                <SessionTerminal
                  sessionId={sessionId}
                  reconnectSignal={reconnectSignal}
                  live={live}
                  onAttached={setAttached}
                />
              </Suspense>
            </>
          )}
        </div>

        <aside className="side-panel">
          {actionError === null ? null : (
            <p className="error-note" role="alert">
              {actionError}
            </p>
          )}
          <div role="status">
            {actionNotice === null ? null : <p className="empty empty-inline">{actionNotice}</p>}
          </div>

          <section className="section">
            {absent ? (
              <>
                <h2>{error === null ? 'No such session' : 'This session could not be loaded'}</h2>
                <p className="empty empty-inline">
                  {error === null
                    ? 'No workspace on this dashboard lists it. It may have been archived, or its workspace removed.'
                    : 'The message above says why. Nothing below describes it, because nothing is known about it.'}
                </p>
                <div className="path-row">
                  <code className="path">{sessionId}</code>
                </div>
              </>
            ) : (
              <>
                <h2>{issue?.summary ?? record?.issueKey ?? sessionId}</h2>
                <div className="chip-row">
                  {issue === null ? null : (
                    <StatusChip status={issue.status} category={issue.statusCategory} />
                  )}
                  {issue === null ? null : <LabelChips labels={issue.labels} />}
                </div>
                {issue === null ? null : (
                  <a className="link" href={issue.url} target="_blank" rel="noreferrer noopener">
                    <ExternalIcon /> Open in Jira
                  </a>
                )}
              </>
            )}
          </section>

          {failure === null ? null : (
            <section className="section">
              <h3>Why it failed</h3>
              <pre className="description">{failure}</pre>
            </section>
          )}

          {issue?.description == null ? null : (
            <section className="section">
              <h3>Description</h3>
              <pre className="description">{issue.description}</pre>
            </section>
          )}

          {absent ? null : (
            <section className="section">
              <h3>Checkout</h3>
              {worktreePath === null ? (
                <p className="empty empty-inline">This session runs in the main checkout.</p>
              ) : (
                <>
                  <div className="path-row">
                    <code className="path">{worktreePath}</code>
                  </div>
                  <div className="session-block-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={workspaceId === null || record === null}
                      onClick={() => {
                        if (workspaceId === null || record === null) return;
                        openEditor(workspaceId, record.issueKey).catch((cause: unknown) =>
                          setActionError(errorMessage(cause)),
                        );
                      }}
                    >
                      <EditorIcon /> Open in VS Code
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={runRemoveWorktree}
                    >
                      {forceRemove ? 'Remove anyway, discarding changes' : 'Remove worktree'}
                    </button>
                    {forceRemove ? (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => setForceRemove(false)}
                      >
                        Keep it
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </section>
          )}

          {absent ? null : (
            <section className="section">
              <h3>Attach in a terminal</h3>
              <div className="path-row">
                <code className="path">{attach}</code>
                <CopyButton value={attach} label="Copy the attach command" />
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
