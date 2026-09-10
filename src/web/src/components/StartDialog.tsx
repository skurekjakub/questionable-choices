import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Card, PlaybookSummary, PublicRunnerConfig } from '../../../core/api.js';
import { createSession, errorMessage, getPrefill } from '../api.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { DROPPED_SENTENCE, type Effort, type PermissionModeSetting } from '../model.js';
import { CloseIcon } from './Icons.js';

/**
 * Explains what each isolation mode does to the session's checkout.
 */
const ISOLATION_NOTE: Readonly<Record<PlaybookSummary['isolation'], string>> = {
  worktree: 'Runs in a fresh worktree on a new branch.',
  'issue-worktree':
    "Runs in the worktree of the issue's existing branch, or a fresh one off the base ref when none exists.",
  shared: 'Runs in the main checkout, on whatever is checked out there.',
};

/**
 * What the owner asked for that would throw an edited prompt away.
 */
type DiscardIntent =
  | { /** Dismissing the dialog. */ kind: 'close' }
  | {
      /** Loading another playbook's prefill over the edit. */
      kind: 'playbook';
      /** Playbook the owner picked. */
      playbookId: string;
    };

/**
 * Sentence explaining what the pending action would discard.
 */
const DISCARD_NOTE: Readonly<Record<DiscardIntent['kind'], string>> = {
  close: 'The prompt has been edited. Closing discards it.',
  playbook: 'The prompt has been edited. Switching playbook discards it.',
};

/**
 * What a dismissal refused over the start request tells the owner.
 */
export const STILL_STARTING_SENTENCE =
  'The session is still starting, so the dialog is holding on for the answer. Dismiss it again to leave without one.';

/**
 * Collects everything a start needs: which playbook, what prompt, and which
 * runner settings, prefilled from the server and editable before sending.
 *
 * Once the prompt differs from the prefill, everything that would replace it —
 * dismissing the dialog, and picking another playbook — asks for confirmation
 * instead of throwing the edit away. A dismissal over the start request is
 * refused once and honoured the second time, which abandons the request: the
 * session still starts, and its answer is dropped rather than acted on.
 *
 * @param props - Component props.
 * @param props.card - Card the start was triggered from.
 * @param props.workspaceId - Id of the workspace the issue belongs to.
 * @param props.playbooks - Playbooks the workspace offers.
 * @param props.runner - Picker options and defaults from the public config.
 * @param props.initialPlaybookId - Playbook selected when the dialog opens.
 * @param props.dropped - Whether the board has stopped listing the card, so
 * what is on screen is the card as the dialog opened it.
 * @param props.onClose - Called when the dialog should close.
 * @param props.onStarted - Called with the new session's id once it starts.
 * @returns The dialog element.
 */
export function StartDialog({
  card,
  workspaceId,
  playbooks,
  runner,
  initialPlaybookId,
  dropped,
  onClose,
  onStarted,
}: {
  card: Card;
  workspaceId: string;
  playbooks: PlaybookSummary[];
  runner: PublicRunnerConfig;
  initialPlaybookId: string;
  dropped: boolean;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}): JSX.Element {
  const [playbookId, setPlaybookId] = useState(initialPlaybookId);
  const [prompt, setPrompt] = useState('');
  const [prefilled, setPrefilled] = useState('');
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [model, setModel] = useState(runner.defaults.model);
  const [effort, setEffort] = useState<Effort>(runner.defaults.effort);
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(
    runner.defaults.permissionMode,
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [refusedDismissal, setRefusedDismissal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abandoned = useRef(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getPrefill(workspaceId, card.issue.key, playbookId)
      .then((prefill) => {
        if (!live) return;
        setPrompt(prefill.prompt);
        setPrefilled(prefill.prompt);
        setDiscardIntent(null);
        setModel(prefill.model);
        setEffort(prefill.effort);
        setPermissionMode(prefill.permissionMode);
        setWarnings(prefill.warnings);
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
  }, [workspaceId, card.issue.key, playbookId]);

  const edited = prompt !== prefilled;
  const confirming = discardIntent !== null;

  // Escape and the backdrop both route here, so while the confirmation is up
  // they mean "keep editing" rather than repeating a question already asked.
  const requestClose = useCallback(() => {
    // The session is started whether or not this dialog is on screen, so
    // closing over the request in flight loses both the id to navigate to and
    // the refusal that says why nothing started. Nothing lowers `starting` for
    // a request that never answers, though, and every way out routes through
    // here: the second dismissal abandons the request rather than sealing the
    // dialog until the tab is reloaded.
    if (starting) {
      if (!refusedDismissal) {
        setRefusedDismissal(true);
        return;
      }
      abandoned.current = true;
      onClose();
      return;
    }
    if (confirming) {
      setDiscardIntent(null);
      return;
    }
    if (edited) {
      setDiscardIntent({ kind: 'close' });
      return;
    }
    onClose();
  }, [starting, refusedDismissal, confirming, edited, onClose]);
  const dialog = useFocusTrap<HTMLDivElement>(requestClose);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const wasConfirming = useRef(false);

  // The confirmation is announced from a live region; without moving focus a
  // keyboard user hears it with no way to reach the two buttons it offers.
  // "Keep editing" then unmounts itself, and focus it was holding goes to
  // `document.body` with the dialog still open, so it is handed back to the
  // prompt — which is what the owner asked to keep editing.
  useEffect(() => {
    if (confirming) {
      wasConfirming.current = true;
      keepEditing.current?.focus();
      return;
    }
    if (!wasConfirming.current) return;
    wasConfirming.current = false;
    promptField.current?.focus();
  }, [confirming]);

  const selectPlaybook = (next: string): void => {
    if (next === playbookId) return;
    if (edited) {
      setDiscardIntent({ kind: 'playbook', playbookId: next });
      return;
    }
    setPlaybookId(next);
  };

  const discard = (): void => {
    if (discardIntent === null) return;
    if (discardIntent.kind === 'close') {
      onClose();
      return;
    }
    setDiscardIntent(null);
    setPlaybookId(discardIntent.playbookId);
  };

  const selected = playbooks.find((playbook) => playbook.id === playbookId) ?? null;

  const start = (): void => {
    abandoned.current = false;
    setRefusedDismissal(false);
    setStarting(true);
    createSession(workspaceId, card.issue.key, {
      playbookId,
      prompt,
      model,
      effort,
      permissionMode,
    })
      .then((record) => {
        if (!abandoned.current) onStarted(record.id);
      })
      .catch((cause: unknown) => {
        if (!abandoned.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!abandoned.current) setStarting(false);
      });
  };

  return (
    <div className="scrim dialog-scrim" onMouseDown={requestClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Start a session on ${card.issue.key}`}
        tabIndex={-1}
        ref={dialog}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="path-row">
            <h2>
              Start a session on <span className="mono">{card.issue.key}</span>
            </h2>
            <span className="header-spacer" />
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Close"
              onClick={requestClose}
            >
              <CloseIcon />
            </button>
          </div>
          <p>{card.issue.summary}</p>
        </div>

        <div className="dialog-body">
          {/* The live region is mounted empty and filled later: a region that
              arrives with its content already in it announces nothing. */}
          <div role="status">
            {dropped ? <p className="empty empty-inline">{DROPPED_SENTENCE}</p> : null}
            {refusedDismissal && starting ? (
              <p className="empty empty-inline">{STILL_STARTING_SENTENCE}</p>
            ) : null}
          </div>
          <label className="field">
            <span>Playbook</span>
            <select value={playbookId} onChange={(event) => selectPlaybook(event.target.value)}>
              {playbooks.map((playbook) => (
                <option key={playbook.id} value={playbook.id}>
                  {playbook.label}
                </option>
              ))}
            </select>
          </label>
          {selected === null ? null : (
            <p className="empty empty-inline">
              {selected.description} {ISOLATION_NOTE[selected.isolation]}
            </p>
          )}

          {warnings.length === 0 ? null : (
            <ul className="warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <label className="field">
            <span>Prompt</span>
            <textarea
              rows={14}
              ref={promptField}
              value={prompt}
              disabled={loading}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <div className="dialog-grid">
            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {runner.models.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Effort</span>
              <select value={effort} onChange={(event) => setEffort(event.target.value as Effort)}>
                {runner.efforts.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Permission mode</span>
              <select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionModeSetting)}
              >
                {runner.permissionModes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error === null ? null : (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="dialog-foot">
          {discardIntent === null ? null : (
            <p className="discard-note" role="alert">
              {DISCARD_NOTE[discardIntent.kind]}
            </p>
          )}
          <span className="action-spacer" />
          {discardIntent !== null ? (
            <>
              <button
                type="button"
                className="btn btn-quiet"
                ref={keepEditing}
                onClick={() => setDiscardIntent(null)}
              >
                Keep editing
              </button>
              <button type="button" className="btn btn-danger" onClick={discard}>
                Discard the prompt
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={requestClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading || starting || prompt.trim().length === 0}
            onClick={start}
          >
            {starting ? 'Starting' : 'Start session'}
          </button>
        </div>
      </div>
    </div>
  );
}
