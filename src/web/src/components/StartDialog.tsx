import { useCallback, useEffect, useState, type JSX } from 'react';
import type { Card, PlaybookSummary, PublicRunnerConfig } from '../../../core/api.js';
import { createSession, errorMessage, getPrefill } from '../api.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import type { Effort, PermissionModeSetting } from '../model.js';
import { CloseIcon } from './Icons.js';

/**
 * Explains what each isolation mode does to the session's checkout.
 */
const ISOLATION_NOTE: Readonly<Record<PlaybookSummary['isolation'], string>> = {
  worktree: 'Runs in a fresh worktree on a new branch.',
  'issue-worktree': "Runs in the worktree of the issue's existing branch.",
  shared: 'Runs in the main checkout, on whatever is checked out there.',
};

/**
 * Collects everything a start needs: which playbook, what prompt, and which
 * runner settings, prefilled from the server and editable before sending.
 *
 * Once the prompt differs from the prefill, dismissing the dialog asks for
 * confirmation instead of throwing the edit away.
 *
 * @param props - Component props.
 * @param props.card - Card the start was triggered from.
 * @param props.workspaceId - Id of the workspace the issue belongs to.
 * @param props.playbooks - Playbooks the workspace offers.
 * @param props.runner - Picker options and defaults from the public config.
 * @param props.initialPlaybookId - Playbook selected when the dialog opens.
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
  onClose,
  onStarted,
}: {
  card: Card;
  workspaceId: string;
  playbooks: PlaybookSummary[];
  runner: PublicRunnerConfig;
  initialPlaybookId: string;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}): JSX.Element {
  const [playbookId, setPlaybookId] = useState(initialPlaybookId);
  const [prompt, setPrompt] = useState('');
  const [prefilled, setPrefilled] = useState('');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [model, setModel] = useState(runner.defaults.model);
  const [effort, setEffort] = useState<Effort>(runner.defaults.effort);
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(
    runner.defaults.permissionMode,
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getPrefill(workspaceId, card.issue.key, playbookId)
      .then((prefill) => {
        if (!live) return;
        setPrompt(prefill.prompt);
        setPrefilled(prefill.prompt);
        setConfirmingDiscard(false);
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
  const requestClose = useCallback(() => {
    if (edited) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [edited, onClose]);
  const dialog = useFocusTrap<HTMLDivElement>(requestClose);

  const selected = playbooks.find((playbook) => playbook.id === playbookId) ?? null;

  const start = (): void => {
    setStarting(true);
    createSession(workspaceId, card.issue.key, {
      playbookId,
      prompt,
      model,
      effort,
      permissionMode,
    })
      .then((record) => onStarted(record.id))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setStarting(false));
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
          <label className="field">
            <span>Playbook</span>
            <select value={playbookId} onChange={(event) => setPlaybookId(event.target.value)}>
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
          {confirmingDiscard ? (
            <p className="discard-note" role="alert">
              The prompt has been edited. Closing discards it.
            </p>
          ) : null}
          <span className="action-spacer" />
          {confirmingDiscard ? (
            <>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirmingDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="btn btn-danger" onClick={onClose}>
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
