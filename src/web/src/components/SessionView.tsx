import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type LazyExoticComponent,
} from 'react';
import type { BoardView, SessionAction } from '../../../core/api.js';
import {
  ApiError,
  errorMessage,
  getSessionEvents,
  isForceableRemoval,
  openEditor,
  removeWorktree,
  sessionAction,
} from '../api.js';
import { failureReason } from '../failure.js';
import { attachCommand, endedHint } from '../format.js';
import { useSession } from '../hooks/useSession.js';
import { LIVE_STATES, NEEDS_YOU_STATES, STATE_LABELS } from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { CopyButton } from './CopyButton.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { EditorIcon, ExternalIcon } from './Icons.js';
import { HintMarker, Lamp, StaleMarker } from './Lamp.js';
import type { SessionTerminal as SessionTerminalComponent } from './Terminal.js';

/**
 * Loads the terminal and the xterm bundle behind it, which is the largest
 * dependency in the app and is reachable only from this route.
 *
 * @returns A component that resolves to the session terminal.
 */
function loadTerminal(): LazyExoticComponent<typeof SessionTerminalComponent> {
  return lazy(() =>
    import('./Terminal.js').then((module) => ({ default: module.SessionTerminal })),
  );
}

/**
 * What the event log had to say about a failed session.
 *
 * "The log names no reason", "the log could not be read" and "there is no such
 * session any more" are different answers to the owner's question, and
 * collapsing them hides an outage — or a pruned session — behind a shrug.
 */
type FailureRead =
  | { /** The log named a reason. */ kind: 'reason'; /** What it said. */ text: string }
  | { /** The log was read and named nothing. */ kind: 'none' }
  | { /** The server knows no session with this id. */ kind: 'gone' }
  | {
      /** The log could not be read. */ kind: 'unreadable';
      /** Why the read failed. */ message: string;
    };

/**
 * Reduces a failed events read to the answer it is.
 *
 * The events route separates the two failures the owner would act on
 * differently: 404 is a session the server no longer has, 409 is a log on disk
 * it could not open.
 *
 * @param cause - Value caught from the events call.
 * @returns What to tell the owner about the log.
 */
function failureRead(cause: unknown): FailureRead {
  if (cause instanceof ApiError && cause.status === 404) return { kind: 'gone' };
  return { kind: 'unreadable', message: errorMessage(cause) };
}

/**
 * Shows one session: its terminal, its lifecycle controls, and the issue it is
 * working on.
 *
 * Whether the session exists is the board's answer, not the issue detail's: a
 * tracker that cannot be reached refuses the detail for a session that is
 * running perfectly, and taking its terminal away over that is the outage
 * spreading. Only a session no board lists loses the terminal, the checkout and
 * the attach command.
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
    missing,
    reload,
  } = useSession(sessionId, board);
  const loading = sessionLoading || resolving;
  const [attached, setAttached] = useState(false);
  const [reconnectSignal, setReconnectSignal] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureRead | null>(null);
  const [terminalAttempt, setTerminalAttempt] = useState(0);

  // React caches a rejected lazy payload for the life of the component, so the
  // chunk-404 this boundary exists for can only be retried by handing Suspense
  // a different `lazy()` — re-rendering the same one throws the same rejection.
  const SessionTerminal = useMemo(() => loadTerminal(), [terminalAttempt]);

  const cardSession =
    board?.columns
      .flatMap((column) => column.cards)
      .flatMap((card) => card.sessions)
      .find((session) => session.id === sessionId) ?? null;
  // The record is the authority the moment it exists, including for the fields
  // it clears: the board's copy is a debounced snapshot, so falling through to
  // it on a null would resurrect a pending prompt or a staleness marker the
  // server has just cleared. Before the record loads the card is all there is.
  const shown = record ?? cardSession;
  // The record carries the whole notification and the card only its summary, so
  // the two shapes of the same field are reduced here rather than at the marker.
  const hint = record !== null ? (record.hint?.summary ?? null) : (cardSession?.hint ?? null);

  const ended = shown === null ? null : endedHint(sessionId, shown.state, shown.lastExitCode);

  // The reducer keeps no field for why a session ended badly, so the reason is
  // read back out of the raw event log the server already serves. A retry that
  // fails again re-enters the state with a new timestamp and code, which is
  // what makes the second failure reach the panel.
  const endedBadly = ended !== null;
  const stateSince = shown?.stateSince ?? null;
  const lastExitCode = shown?.lastExitCode ?? null;
  useEffect(() => {
    if (!endedBadly) {
      setFailure(null);
      return;
    }
    let live = true;
    getSessionEvents(sessionId)
      .then((log) => {
        if (!live) return;
        const reason = failureReason(log.events);
        setFailure(reason === null ? { kind: 'none' } : { kind: 'reason', text: reason });
      })
      .catch((cause: unknown) => {
        if (live) setFailure(failureRead(cause));
      });
    return () => {
      live = false;
    };
  }, [sessionId, endedBadly, stateSince, lastExitCode]);

  // No board lists the session and nothing is still looking, so the terminal,
  // the checkout and the attach command have nothing to describe.
  const absent = missing && !loading;
  // Attaching is only honest once a board has ruled the session in: before the
  // first frame nothing has confirmed the id, and opening a socket for one that
  // exists nowhere is a request the server can only refuse. The issue detail is
  // deliberately not part of this — a tracker outage says nothing about whether
  // the session is running.
  const answered = board !== null && !resolving;
  const live = shown !== null && LIVE_STATES.has(shown.state);
  const needsYou = shown !== null && NEEDS_YOU_STATES.has(shown.state);
  const playbookLabel =
    board?.playbooks.find((playbook) => playbook.id === shown?.playbookId)?.label ??
    shown?.playbookId ??
    '';
  const attach = attachCommand(sessionId, cardSession?.attachCommand);

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
        {shown === null ? (
          <span className="state-pill">
            {loading ? 'loading' : error !== null ? 'could not load' : 'session not found'}
          </span>
        ) : (
          <span className="state-pill" data-alert={needsYou}>
            <Lamp state={shown.state} />
            {ended?.label ?? STATE_LABELS[shown.state]}
            {shown.staleSince == null ? null : <StaleMarker />}
            {hint === null ? null : <HintMarker summary={hint} />}
            {shown.pending === null ? null : (
              <span className="pending">— {shown.pending.summary}</span>
            )}
          </span>
        )}
        {shown?.branch == null ? null : <span className="branch">{shown.branch}</span>}
        <CacheReadout cache={shown?.cache ?? null} nowMs={nowMs} />
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
        {shown !== null && !live ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || record === null || record.claudeSessionId === null}
            title={
              record === null
                ? 'The issue detail has not loaded, so this session’s Claude id is unknown'
                : record.claudeSessionId === null
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
              No board lists this session, so there is no terminal to attach to.
            </p>
          ) : !answered ? (
            <p className="empty" role="status">
              Waiting for the board to say whether this session exists.
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
              {/* The xterm bundle is a separate chunk, so it can 404 on its own
                  — a tab kept open across a rebuild, or an offline reload. The
                  root boundary would answer that by replacing the dashboard;
                  this one answers it with the command that does the same job. */}
              <ErrorBoundary
                fallback={(message, retry) => (
                  <div className="terminal-host">
                    <p className="empty" role="alert">
                      The terminal could not be loaded: {message}
                    </p>
                    <p className="empty empty-inline">
                      Attach to it from a shell instead: <code className="path">{attach}</code>
                    </p>
                    <div className="session-block-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setTerminalAttempt((value) => value + 1);
                          retry();
                        }}
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                )}
              >
                <Suspense
                  fallback={
                    <div className="terminal-host">
                      <p className="empty" role="status">
                        Loading the terminal.
                      </p>
                    </div>
                  }
                >
                  <SessionTerminal
                    sessionId={sessionId}
                    reconnectSignal={reconnectSignal}
                    live={live}
                    onAttached={setAttached}
                  />
                </Suspense>
              </ErrorBoundary>
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
                <h2>No such session</h2>
                <p className="empty empty-inline">
                  No workspace on this dashboard lists it. It may have been archived, or its
                  workspace removed.
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

          {ended === null || shown === null ? null : (
            <section className="section">
              <h3>{shown.state === 'failed' ? 'Why it failed' : 'Why it ended'}</h3>
              {failure === null ? (
                <p className="empty empty-inline">Reading the event log.</p>
              ) : failure.kind === 'reason' ? (
                <pre className="description">{failure.text}</pre>
              ) : failure.kind === 'none' ? (
                <p className="empty empty-inline">
                  The event log records no reason beyond the exit code.
                </p>
              ) : failure.kind === 'gone' ? (
                <p className="empty empty-inline">
                  The server has no session with this id any more, so its event log is gone.
                </p>
              ) : (
                <p className="empty empty-inline">
                  The event log could not be read, so the reason is unknown: {failure.message}
                </p>
              )}
              {ended.shell === null ? null : (
                <p className="empty empty-inline">
                  The failed shell is still open, so the output that ended it can be read there:{' '}
                  {ended.shell}.
                </p>
              )}
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
