import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  Card,
  IssueDetailResponse,
  PlaybookSummary,
  SessionAction,
} from '../../../core/api.js';
import {
  ApiError,
  errorMessage,
  getIssue,
  openEditor,
  removeWorktree,
  sessionAction,
} from '../api.js';
import { timeInState } from '../format.js';
import { LIVE_STATES, STATE_LABELS, type SessionRecord } from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { CopyButton } from './CopyButton.js';
import { CloseIcon, EditorIcon, ExternalIcon } from './Icons.js';
import { Lamp } from './Lamp.js';

/**
 * Builds the shell command that attaches a terminal to a session.
 *
 * @param card - Card the session belongs to, which may already carry the command.
 * @param sessionId - Id of the session to attach to.
 * @returns The command as the server reported it, or the tmux default.
 */
function attachCommand(card: Card, sessionId: string): string {
  const known = card.sessions.find((session) => session.id === sessionId);
  return known?.attachCommand ?? `tmux attach -t ${sessionId}`;
}

/**
 * Renders the actions available on one session record.
 *
 * @param props - Component props.
 * @param props.record - Session to act on.
 * @param props.busy - Whether an action is already in flight.
 * @param props.onAction - Called with the action the owner picked.
 * @param props.onOpen - Called when the owner wants the session's terminal.
 * @returns The action row.
 */
function SessionActions({
  record,
  busy,
  onAction,
  onOpen,
}: {
  record: SessionRecord;
  busy: boolean;
  onAction: (action: SessionAction) => void;
  onOpen: () => void;
}): JSX.Element {
  const live = LIVE_STATES.includes(record.state);
  return (
    <div className="session-block-actions">
      <button type="button" className="btn" onClick={onOpen}>
        Open terminal
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy || !live}
        onClick={() => onAction('interrupt')}
      >
        Interrupt
      </button>
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy || !live}
        onClick={() => onAction('kill')}
      >
        Kill
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy || live || record.claudeSessionId === null}
        title={
          record.claudeSessionId === null
            ? 'This session never reported a Claude session id'
            : undefined
        }
        onClick={() => onAction('resume')}
      >
        Resume
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy || live}
        onClick={() => onAction('archive')}
      >
        Archive
      </button>
    </div>
  );
}

/**
 * Shows one issue in full: its description, its checkout, and every session it
 * has, with the actions each one allows.
 *
 * @param props - Component props.
 * @param props.card - Card the drawer was opened from.
 * @param props.workspaceId - Id of the workspace the issue belongs to.
 * @param props.playbooks - Playbooks the workspace offers, for session labels.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.onClose - Called when the drawer should close.
 * @param props.onOpenSession - Called with a session id to show its terminal.
 * @returns The drawer element.
 */
export function IssueDrawer({
  card,
  workspaceId,
  playbooks,
  nowMs,
  onClose,
  onOpenSession,
}: {
  card: Card;
  workspaceId: string;
  playbooks: PlaybookSummary[];
  nowMs: number;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forceTarget, setForceTarget] = useState<string | null>(null);

  const load = useCallback(() => {
    getIssue(workspaceId, card.issue.key)
      .then((next) => {
        setDetail(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [workspaceId, card.issue.key]);

  useEffect(load, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const worktreePath = detail?.worktreePath ?? card.worktreePath;
  const sessions = detail?.sessions ?? [];
  const newest = sessions[0] ?? null;

  const runAction = (sessionId: string, action: SessionAction): void => {
    setBusy(true);
    sessionAction(sessionId, action)
      .then(() => {
        setError(null);
        load();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const runRemoveWorktree = (sessionId: string, force: boolean): void => {
    setBusy(true);
    removeWorktree(sessionId, force)
      .then(() => {
        setError(null);
        setForceTarget(null);
        load();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        // A 409 is git refusing a dirty tree, which the owner can override; any
        // other status is a refusal that forcing would not change.
        setForceTarget(cause instanceof ApiError && cause.status === 409 ? sessionId : null);
      })
      .finally(() => setBusy(false));
  };

  const labelFor = (playbookId: string): string =>
    playbooks.find((playbook) => playbook.id === playbookId)?.label ?? playbookId;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${card.issue.key} details`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <div className="card-ident">
              <span className="card-key">{card.issue.key}</span>
              <span className="type-glyph">{card.issue.type}</span>
            </div>
            <h2>{card.issue.summary}</h2>
          </div>
          <span className="header-spacer" />
          <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          {error === null ? null : <p className="error-note">{error}</p>}

          <div className="chip-row">
            <StatusChip status={card.issue.status} category={card.issue.statusCategory} />
            <LabelChips labels={card.issue.labels} />
            <a className="link" href={card.issue.url} target="_blank" rel="noreferrer noopener">
              <ExternalIcon /> Open in Jira
            </a>
          </div>

          <section className="section">
            <h3>Description</h3>
            {detail === null ? (
              <p className="empty">Loading the description.</p>
            ) : (
              <pre className="description">
                {detail.issue.description ?? 'This issue has no description.'}
              </pre>
            )}
          </section>

          <section className="section">
            <h3>Checkout</h3>
            {worktreePath === null ? (
              <p className="empty">No worktree yet. Starting a session creates one.</p>
            ) : (
              <>
                <div className="path-row">
                  <code className="path">{worktreePath}</code>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      openEditor(workspaceId, card.issue.key).catch((cause: unknown) =>
                        setError(errorMessage(cause)),
                      );
                    }}
                  >
                    <EditorIcon /> Open in VS Code
                  </button>
                </div>
                {newest === null ? null : (
                  <div className="session-block-actions" style={{ marginTop: 'var(--sp-2)' }}>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => runRemoveWorktree(newest.id, forceTarget === newest.id)}
                    >
                      {forceTarget === newest.id
                        ? 'Remove anyway, discarding changes'
                        : 'Remove worktree'}
                    </button>
                    {forceTarget === newest.id ? (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => setForceTarget(null)}
                      >
                        Keep it
                      </button>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="section">
            <h3>Sessions</h3>
            {sessions.length === 0 ? (
              <p className="empty">No sessions have run for this issue.</p>
            ) : (
              sessions.map((record) => (
                <div className="session-block" key={record.id}>
                  <div className="session-block-head">
                    <Lamp state={record.state} />
                    <span className="session-playbook">{labelFor(record.playbookId)}</span>
                    <span>{STATE_LABELS[record.state]}</span>
                    <span className="session-time">{timeInState(record.stateSince, nowMs)}</span>
                    <CacheReadout cache={record.cache} nowMs={nowMs} />
                  </div>
                  {record.pending === null ? null : (
                    <p className="description" style={{ fontSize: 'var(--fs-control)' }}>
                      {record.pending.summary}
                    </p>
                  )}
                  <div className="path-row">
                    <code className="path">{attachCommand(card, record.id)}</code>
                    <CopyButton
                      value={attachCommand(card, record.id)}
                      label={`Copy the attach command for ${record.id}`}
                    />
                  </div>
                  <SessionActions
                    record={record}
                    busy={busy}
                    onAction={(action) => runAction(record.id, action)}
                    onOpen={() => onOpenSession(record.id)}
                  />
                </div>
              ))
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
