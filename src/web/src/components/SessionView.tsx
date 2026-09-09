import { useState, type JSX } from 'react';
import type { BoardView, SessionAction } from '../../../core/api.js';
import { ApiError, errorMessage, openEditor, removeWorktree, sessionAction } from '../api.js';
import { useSession } from '../hooks/useSession.js';
import { LIVE_STATES, NEEDS_YOU_STATES, STATE_LABELS } from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { CopyButton } from './CopyButton.js';
import { EditorIcon, ExternalIcon } from './Icons.js';
import { Lamp } from './Lamp.js';
import { SessionTerminal } from './Terminal.js';

/**
 * Shows one session: its terminal, its lifecycle controls, and the issue it is
 * working on.
 *
 * @param props - Component props.
 * @param props.sessionId - Id of the session to show.
 * @param props.board - Latest board view, used to locate the session's issue.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.onBack - Called when the owner leaves for the board.
 * @returns The session view.
 */
export function SessionView({
  sessionId,
  board,
  nowMs,
  onBack,
}: {
  sessionId: string;
  board: BoardView | null;
  nowMs: number;
  onBack: () => void;
}): JSX.Element {
  const { record, issue, workspaceId, worktreePath, error, loading, reload } = useSession(
    sessionId,
    board,
  );
  const [attached, setAttached] = useState(false);
  const [reconnectSignal, setReconnectSignal] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const live = record !== null && LIVE_STATES.includes(record.state);
  const needsYou = record !== null && NEEDS_YOU_STATES.includes(record.state);
  const playbookLabel =
    board?.playbooks.find((playbook) => playbook.id === record?.playbookId)?.label ??
    record?.playbookId ??
    '';
  const attachCommand =
    board?.columns
      .flatMap((column) => column.cards)
      .flatMap((card) => card.sessions)
      .find((session) => session.id === sessionId)?.attachCommand ?? `tmux attach -t ${sessionId}`;

  const runAction = (action: SessionAction): void => {
    setBusy(true);
    sessionAction(sessionId, action)
      .then(() => {
        setActionError(null);
        reload();
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const runRemoveWorktree = (): void => {
    setBusy(true);
    removeWorktree(sessionId, forceRemove)
      .then(() => {
        setActionError(null);
        setForceRemove(false);
        reload();
      })
      .catch((cause: unknown) => {
        setActionError(errorMessage(cause));
        setForceRemove(cause instanceof ApiError && cause.status === 409);
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
          <span className="state-pill">{loading ? 'loading' : 'session not found'}</span>
        ) : (
          <span className="state-pill" data-alert={needsYou}>
            <Lamp state={record.state} />
            {STATE_LABELS[record.state]}
            {record.pending === null ? null : (
              <span className="pending">— {record.pending.summary}</span>
            )}
          </span>
        )}
        {record?.branch == null ? null : <span className="branch">{record.branch}</span>}
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

      {error === null ? null : <p className="banner">{error}</p>}

      <div className="session-main">
        <div className="terminal-pane">
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
          <SessionTerminal
            sessionId={sessionId}
            reconnectSignal={reconnectSignal}
            onAttached={setAttached}
          />
        </div>

        <aside className="side-panel">
          {actionError === null ? null : <p className="error-note">{actionError}</p>}

          <section className="section">
            <h2>{issue?.summary ?? record?.issueKey ?? sessionId}</h2>
            <div className="chip-row" style={{ marginTop: 'var(--sp-2)' }}>
              {issue === null ? null : (
                <StatusChip status={issue.status} category={issue.statusCategory} />
              )}
              {issue === null ? null : <LabelChips labels={issue.labels} />}
            </div>
            {issue === null ? null : (
              <a
                className="link"
                href={issue.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{ display: 'inline-flex', gap: '6px', marginTop: 'var(--sp-2)' }}
              >
                <ExternalIcon /> Open in Jira
              </a>
            )}
          </section>

          {issue?.description == null ? null : (
            <section className="section">
              <h3>Description</h3>
              <pre className="description">{issue.description}</pre>
            </section>
          )}

          <section className="section">
            <h3>Checkout</h3>
            {worktreePath === null ? (
              <p className="empty" style={{ padding: 0 }}>
                This session runs in the main checkout.
              </p>
            ) : (
              <>
                <div className="path-row">
                  <code className="path">{worktreePath}</code>
                </div>
                <div className="session-block-actions" style={{ marginTop: 'var(--sp-2)' }}>
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

          <section className="section">
            <h3>Attach in a terminal</h3>
            <div className="path-row">
              <code className="path">{attachCommand}</code>
              <CopyButton value={attachCommand} label="Copy the attach command" />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
