import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  Card,
  IssueDetailResponse,
  PlaybookSummary,
  SessionAction,
} from '../../../core/api.js';
import {
  errorMessage,
  getIssue,
  isForceableRemoval,
  openEditor,
  removeWorktree,
  sessionAction,
} from '../api.js';
import { attachCommand, timeInState, typeGlyph } from '../format.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import {
  LIVE_STATES,
  STATE_LABELS,
  type Pending,
  type SessionCache,
  type SessionState,
} from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { CopyButton } from './CopyButton.js';
import { CloseIcon, EditorIcon, ExternalIcon } from './Icons.js';
import { Lamp } from './Lamp.js';

/**
 * One session as the drawer renders it: the board's live view of it, over the
 * fields only the loaded detail carries.
 */
interface DrawerSession {
  /** Id of the session. */
  id: string;
  /** Playbook that produced its prompt. */
  playbookId: string;
  /** Lifecycle state, from the board when the board still lists it. */
  state: SessionState;
  /** ISO timestamp of the last state change. */
  stateSince: string;
  /** What it is waiting for, or null. */
  pending: Pending | null;
  /** Prompt-cache state, or null when none was reported. */
  cache: SessionCache | null;
  /** Shell command that attaches a terminal to it. */
  attachCommand: string;
  /** Whether the owner has marked its work done. */
  done: boolean;
  /** Claude session id, or null when it never reported one. */
  claudeSessionId: string | null;
}

/**
 * Merges the board's live sessions over the records the detail load returned,
 * so the rows keep ticking while the drawer stays open.
 *
 * The board's copy of a session replaces the snapshot's wholesale rather than
 * field by field. Falling through on a null would mean the two fields a
 * session clears when it stops needing the owner — `pending` and `cache` — are
 * the two the row keeps showing from the snapshot, so a killed session goes on
 * advertising a permission request nobody can answer.
 *
 * @param card - Card the drawer was opened from, carrying the live sessions.
 * @param detail - Loaded issue detail, or null before it arrives.
 * @returns One row per session, newest first.
 */
export function drawerSessions(card: Card, detail: IssueDetailResponse | null): DrawerSession[] {
  const live = new Map(card.sessions.map((session) => [session.id, session]));
  const rows: DrawerSession[] = [];
  for (const record of detail?.sessions ?? []) {
    const current = live.get(record.id);
    live.delete(record.id);
    const shown = current ?? record;
    rows.push({
      id: record.id,
      playbookId: record.playbookId,
      state: shown.state,
      stateSince: shown.stateSince,
      pending: shown.pending,
      cache: shown.cache,
      attachCommand: attachCommand(record.id, current?.attachCommand),
      done: shown.done,
      // The board carries no Claude session id, so this is the one field the
      // snapshot answers even while the board still lists the session.
      claudeSessionId: record.claudeSessionId,
    });
  }
  // A session started after the detail loaded is on the board and nowhere else;
  // it has no Claude session id yet, so resuming it stays disabled.
  for (const session of live.values()) {
    rows.unshift({
      id: session.id,
      playbookId: session.playbookId,
      state: session.state,
      stateSince: session.stateSince,
      pending: session.pending,
      cache: session.cache,
      attachCommand: attachCommand(session.id, session.attachCommand),
      done: session.done,
      claudeSessionId: null,
    });
  }
  return rows;
}

/**
 * Renders the actions available on one session.
 *
 * @param props - Component props.
 * @param props.session - Session to act on.
 * @param props.busy - Whether an action is already in flight.
 * @param props.onAction - Called with the action the owner picked.
 * @param props.onOpen - Called when the owner wants the session's terminal.
 * @returns The action row.
 */
function SessionActions({
  session,
  busy,
  onAction,
  onOpen,
}: {
  session: DrawerSession;
  busy: boolean;
  onAction: (action: SessionAction) => void;
  onOpen: () => void;
}): JSX.Element {
  const live = LIVE_STATES.has(session.state);
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
        disabled={busy || live || session.claudeSessionId === null}
        title={
          session.claudeSessionId === null
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
        disabled={busy}
        onClick={() => onAction(session.done ? 'unmark-done' : 'mark-done')}
      >
        {session.done ? 'Unmark done' : 'Mark done'}
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
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forceTarget, setForceTarget] = useState<string | null>(null);
  const drawer = useFocusTrap<HTMLElement>(onClose);
  const loadToken = useRef(0);

  // Every action reloads, and the drawer can close mid-flight, so a response is
  // only applied while it is still the newest one asked for: without the token
  // a slow first read lands on top of the reload that followed it, and a read
  // that resolves after the close sets state on an unmounted component.
  const load = useCallback(() => {
    const token = (loadToken.current += 1);
    setLoadFailed(false);
    getIssue(workspaceId, card.issue.key)
      .then((next) => {
        if (loadToken.current !== token) return;
        setDetail(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (loadToken.current !== token) return;
        setError(errorMessage(cause));
        setLoadFailed(true);
      });
  }, [workspaceId, card.issue.key]);

  useEffect(() => {
    load();
    return () => {
      loadToken.current += 1;
    };
  }, [load]);

  const worktreePath = detail?.worktreePath ?? card.worktreePath;
  const sessions = drawerSessions(card, detail);
  const newest = sessions[0] ?? null;

  const runAction = (sessionId: string, action: SessionAction): void => {
    setBusy(true);
    sessionAction(sessionId, action)
      .then(() => {
        setError(null);
        setNotice(null);
        load();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const runRemoveWorktree = (sessionId: string, force: boolean): void => {
    setBusy(true);
    removeWorktree(sessionId, force)
      .then((removed) => {
        setError(null);
        setNotice(`Removed ${removed.path}`);
        setForceTarget(null);
        load();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setForceTarget(isForceableRemoval(cause) ? sessionId : null);
      })
      .finally(() => setBusy(false));
  };

  const labelFor = (playbookId: string): string =>
    playbooks.find((playbook) => playbook.id === playbookId)?.label ?? playbookId;

  // The drawer holds no unsaved text, but it does hold an in-flight action; a
  // stray click on the backdrop must not close it over a running DELETE and
  // leave the owner with no report of how it went. Escape and Close stay live,
  // so the drawer is never a trap.
  const dismissFromBackdrop = (): void => {
    if (busy) return;
    onClose();
  };

  return (
    <div className="scrim" onMouseDown={dismissFromBackdrop}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${card.issue.key} details`}
        tabIndex={-1}
        ref={drawer}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <div className="card-ident">
              <span className="card-key">{card.issue.key}</span>
              <span className="type-glyph" title={card.issue.type}>
                {typeGlyph(card.issue.type)}
              </span>
            </div>
            <h2>{card.issue.summary}</h2>
          </div>
          <span className="header-spacer" />
          <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          {error === null ? null : (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
          <div role="status">
            {notice === null ? null : <p className="empty empty-inline">{notice}</p>}
          </div>

          <div className="chip-row">
            <StatusChip status={card.issue.status} category={card.issue.statusCategory} />
            <LabelChips labels={card.issue.labels} />
            <a className="link" href={card.issue.url} target="_blank" rel="noreferrer noopener">
              <ExternalIcon /> Open in Jira
            </a>
          </div>

          <section className="section">
            <h3>Description</h3>
            {detail !== null ? (
              <pre className="description">
                {detail.issue.description ?? 'This issue has no description.'}
              </pre>
            ) : loadFailed ? (
              <>
                <p className="empty empty-inline">Could not load the description.</p>
                <div className="session-block-actions">
                  <button type="button" className="btn" onClick={load}>
                    Try again
                  </button>
                </div>
              </>
            ) : (
              <p className="empty">Loading the description.</p>
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
                  <div className="session-block-actions">
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
              sessions.map((session) => (
                <div className="session-block" key={session.id}>
                  <div className="session-block-head">
                    <Lamp state={session.state} />
                    <span className="session-playbook">{labelFor(session.playbookId)}</span>
                    <span>{STATE_LABELS[session.state]}</span>
                    {session.done ? <span className="session-done">done</span> : null}
                    <span className="session-time">{timeInState(session.stateSince, nowMs)}</span>
                    <CacheReadout cache={session.cache} nowMs={nowMs} />
                  </div>
                  {session.pending === null ? null : (
                    <p className="description">{session.pending.summary}</p>
                  )}
                  <div className="path-row">
                    <code className="path">{session.attachCommand}</code>
                    <CopyButton
                      value={session.attachCommand}
                      label={`Copy the attach command for ${session.id}`}
                    />
                  </div>
                  <SessionActions
                    session={session}
                    busy={busy}
                    onAction={(action) => runAction(session.id, action)}
                    onOpen={() => onOpenSession(session.id)}
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
