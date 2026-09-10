import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import { ApiError, createWorkspace, errorHeadline } from '../api.js';
import type {
  ConfigIssue,
  ConnectorSummary,
  CreateWorkspaceRequest,
  RepoSummary,
  WorkspaceSummary,
} from '../../../core/api.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import {
  NEW_CONNECTOR_FIELDS,
  placeIssue,
  withoutFields,
  type WorkspaceFieldPath,
} from '../workspace-fields.js';
import { CloseIcon } from './Icons.js';

/**
 * Review statuses a new workspace starts with.
 */
const DEFAULT_REVIEW_STATUSES = 'Ready for review';

/**
 * Sentinel selected in the connector picker to reveal the new-connector fields.
 */
const NEW_CONNECTOR = '__new__';

/**
 * Attributes a control carries while the server holds it at fault.
 */
interface FaultAttributes {
  /** Marks the control as rejected. */
  'aria-invalid'?: true;
  /** Points at the note carrying the server's wording. */
  'aria-describedby'?: string;
}

/**
 * Renders the problem the server placed against one field.
 *
 * @param props - Component props.
 * @param props.id - Id the field's `aria-describedby` points at.
 * @param props.message - The server's wording, or null when the field is fine.
 * @returns The note, or null when there is nothing to say.
 */
function FieldNote({ id, message }: { id: string; message: string | null }): JSX.Element | null {
  if (message === null) return null;
  return (
    <span className="field-note" id={id} role="alert">
      {message}
    </span>
  );
}

/**
 * Collects one epic, the repo it is worked in and the connector that reads it,
 * creating the connector inline when the owner has none yet.
 *
 * Validation problems are placed against the field their path names; anything
 * that names no field stays in the dialog's error note. Once anything has been
 * filled in, dismissing the dialog asks for confirmation rather than throwing
 * the form away.
 *
 * @param props - Component props.
 * @param props.repos - Repos configured in the file, which the UI cannot add to.
 * @param props.connectors - Connectors already configured.
 * @param props.onClose - Called when the dialog should close.
 * @param props.onAdded - Called with the workspace the server created.
 * @returns The dialog element.
 */
export function AddWorkspaceDialog({
  repos,
  connectors,
  onClose,
  onAdded,
}: {
  repos: RepoSummary[];
  connectors: ConnectorSummary[];
  onClose: () => void;
  onAdded: (workspace: WorkspaceSummary) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [epic, setEpic] = useState('');
  const [repo, setRepo] = useState(repos[0]?.id ?? '');
  const [connector, setConnector] = useState(connectors[0]?.id ?? NEW_CONNECTOR);
  const [connectorId, setConnectorId] = useState('');
  const [site, setSite] = useState('');
  const [emailEnv, setEmailEnv] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [reviewStatuses, setReviewStatuses] = useState(DEFAULT_REVIEW_STATUSES);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const prefix = useId();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Only typing counts. A select is never blank, so "changed from its default"
  // is not work worth confirming away: picking the other repo and picking the
  // first one back would otherwise leave an empty form permanently dirty, and
  // every Escape after it would raise a discard confirmation over nothing.
  const dirty =
    name !== '' ||
    epic !== '' ||
    connectorId !== '' ||
    site !== '' ||
    emailEnv !== '' ||
    tokenEnv !== '' ||
    reviewStatuses !== DEFAULT_REVIEW_STATUSES;

  // Escape, the backdrop and Close all route here, so a stray click cannot take
  // eight filled fields with it; while the confirmation is up they mean "keep
  // editing" rather than repeating a question already asked.
  const requestClose = useCallback(() => {
    // The workspace is created whether or not this dialog is on screen, so
    // closing over the request in flight loses the 201 that would select it and
    // the 400 that would name the field to fix.
    if (saving) return;
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return;
    }
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [saving, confirmingDiscard, dirty, onClose]);
  const dialog = useFocusTrap<HTMLDivElement>(requestClose);

  // The confirmation is announced from a live region; without moving focus a
  // keyboard user hears it with no way to reach the two buttons it offers.
  // "Keep editing" then unmounts itself, and focus it was holding goes to
  // `document.body` with the dialog still open, so it is handed on to the
  // control that replaces it rather than dropped.
  useEffect(() => {
    if (confirmingDiscard) {
      wasConfirming.current = true;
      keepEditing.current?.focus();
      return;
    }
    if (!wasConfirming.current) return;
    wasConfirming.current = false;
    cancel.current?.focus();
  }, [confirmingDiscard]);

  const creatingConnector = connector === NEW_CONNECTOR;
  const complete =
    name.trim().length > 0 &&
    epic.trim().length > 0 &&
    repo.length > 0 &&
    (!creatingConnector ||
      (connectorId.trim().length > 0 &&
        site.trim().length > 0 &&
        emailEnv.trim().length > 0 &&
        tokenEnv.trim().length > 0));

  const noteId = (path: WorkspaceFieldPath): string => `${prefix}-${path}`;
  const messageFor = (path: WorkspaceFieldPath): string | null => {
    const found = issues
      .filter((issue) => placeIssue(issue.path) === path)
      .map((issue) => issue.message);
    return found.length === 0 ? null : found.join(' ');
  };
  const faultProps = (path: WorkspaceFieldPath): FaultAttributes =>
    messageFor(path) === null ? {} : { 'aria-invalid': true, 'aria-describedby': noteId(path) };
  const unplaced = issues.filter((issue) => placeIssue(issue.path) === null);

  /**
   * Retires the problems the given fields were holding.
   *
   * The dialog-wide note goes with the last of them: it says the request was
   * invalid, and once nothing in the form is, a live region asserting otherwise
   * is telling the owner their form is broken with no indication of where.
   * A refusal that placed no problems at all — a duplicate id, a write that
   * failed — is not about a field and stays until the next submit.
   *
   * @param fields - Fields whose problems should go.
   * @returns Nothing.
   */
  const retire = (fields: readonly WorkspaceFieldPath[]): void => {
    const next = withoutFields(issues, fields);
    setIssues(next);
    if (issues.length > 0 && next.length === 0) setError(null);
  };

  /**
   * Wraps a field's setter so editing it retires the problem it was holding.
   *
   * @param path - Field the control edits.
   * @param set - The field's own state setter.
   * @returns A change handler for the control.
   */
  const edits =
    (path: WorkspaceFieldPath, set: (value: string) => void) =>
    (event: { target: { value: string } }): void => {
      set(event.target.value);
      retire([path]);
    };

  /**
   * Switches the issue source, retiring the problems of the fields the switch
   * hides.
   *
   * The four `newConnector.*` fields unmount when the picker leaves "add a new
   * issue source", so a problem left on one of them is neither shown nor
   * retired — it simply vanishes with its field and re-appears on the next
   * submit against a connector the owner is no longer creating.
   *
   * @param event - Change event from the picker.
   * @returns Nothing.
   */
  const changeConnector = (event: { target: { value: string } }): void => {
    setConnector(event.target.value);
    retire(['connector', ...NEW_CONNECTOR_FIELDS]);
  };

  const submit = (): void => {
    const statuses = reviewStatuses
      .split(',')
      .map((status) => status.trim())
      .filter((status) => status.length > 0);
    const body: CreateWorkspaceRequest = {
      name: name.trim(),
      epic: epic.trim().toUpperCase(),
      repo,
      ...(creatingConnector
        ? {
            newConnector: {
              id: connectorId.trim(),
              site: site.trim(),
              emailEnv: emailEnv.trim(),
              tokenEnv: tokenEnv.trim(),
            },
          }
        : { connector }),
      ...(statuses.length > 0 ? { reviewStatuses: statuses } : {}),
    };
    setSaving(true);
    createWorkspace(body)
      .then(onAdded)
      .catch((cause: unknown) => {
        setError(errorHeadline(cause));
        setIssues(cause instanceof ApiError ? cause.issues : []);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="scrim dialog-scrim" onMouseDown={requestClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add a workspace"
        tabIndex={-1}
        ref={dialog}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="path-row">
            <h2>Add a workspace</h2>
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
          <p>One epic, the repo its issues are worked in, and the account that reads it.</p>
        </div>

        <div className="dialog-body">
          <div className="dialog-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={edits('name', setName)} {...faultProps('name')} />
              <FieldNote id={noteId('name')} message={messageFor('name')} />
            </label>
            <label className="field">
              <span>Epic key</span>
              <input
                value={epic}
                placeholder="DOC-3807"
                onChange={edits('epic', setEpic)}
                {...faultProps('epic')}
              />
              <FieldNote id={noteId('epic')} message={messageFor('epic')} />
            </label>
            <label className="field">
              <span>Repo</span>
              <select value={repo} onChange={edits('repo', setRepo)} {...faultProps('repo')}>
                {repos.length === 0 ? <option value="">No repos configured</option> : null}
                {repos.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id} — {entry.path}
                  </option>
                ))}
              </select>
              <FieldNote id={noteId('repo')} message={messageFor('repo')} />
            </label>
          </div>

          <label className="field">
            <span>Issue source</span>
            <select value={connector} onChange={changeConnector} {...faultProps('connector')}>
              {connectors.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id} — {entry.site}
                </option>
              ))}
              <option value={NEW_CONNECTOR}>Add a new issue source</option>
            </select>
            <FieldNote id={noteId('connector')} message={messageFor('connector')} />
          </label>

          {creatingConnector ? (
            <div className="dialog-grid">
              <label className="field">
                <span>Source id</span>
                <input
                  value={connectorId}
                  placeholder="kentico-jira"
                  onChange={edits('newConnector.id', setConnectorId)}
                  {...faultProps('newConnector.id')}
                />
                <FieldNote id={noteId('newConnector.id')} message={messageFor('newConnector.id')} />
              </label>
              <label className="field">
                <span>Jira site</span>
                <input
                  value={site}
                  placeholder="example.atlassian.net"
                  onChange={edits('newConnector.site', setSite)}
                  {...faultProps('newConnector.site')}
                />
                <FieldNote
                  id={noteId('newConnector.site')}
                  message={messageFor('newConnector.site')}
                />
              </label>
              <label className="field">
                <span>Email variable</span>
                <input
                  value={emailEnv}
                  placeholder="JIRA_EMAIL"
                  onChange={edits('newConnector.emailEnv', setEmailEnv)}
                  {...faultProps('newConnector.emailEnv')}
                />
                <FieldNote
                  id={noteId('newConnector.emailEnv')}
                  message={messageFor('newConnector.emailEnv')}
                />
              </label>
              <label className="field">
                <span>Token variable</span>
                <input
                  value={tokenEnv}
                  placeholder="JIRA_PAT"
                  onChange={edits('newConnector.tokenEnv', setTokenEnv)}
                  {...faultProps('newConnector.tokenEnv')}
                />
                <FieldNote
                  id={noteId('newConnector.tokenEnv')}
                  message={messageFor('newConnector.tokenEnv')}
                />
              </label>
            </div>
          ) : null}

          <label className="field">
            <span>Review statuses, separated by commas</span>
            <input
              value={reviewStatuses}
              onChange={edits('reviewStatuses', setReviewStatuses)}
              {...faultProps('reviewStatuses')}
            />
            <FieldNote id={noteId('reviewStatuses')} message={messageFor('reviewStatuses')} />
          </label>

          {error === null ? null : (
            <p className="error-note" role="alert">
              {[error, ...unplaced.map((issue) => `${issue.path}: ${issue.message}`)].join('\n')}
            </p>
          )}
        </div>

        <div className="dialog-foot">
          {confirmingDiscard ? (
            <p className="discard-note" role="alert">
              The form has been filled in. Closing discards it.
            </p>
          ) : null}
          <span className="action-spacer" />
          {confirmingDiscard ? (
            <>
              <button
                type="button"
                className="btn btn-quiet"
                ref={keepEditing}
                onClick={() => setConfirmingDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="btn btn-danger" onClick={onClose}>
                Discard the form
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet" ref={cancel} onClick={requestClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!complete || saving}
            onClick={submit}
          >
            {saving ? 'Adding' : 'Add workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
