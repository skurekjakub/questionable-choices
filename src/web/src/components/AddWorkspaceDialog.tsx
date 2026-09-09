import { useEffect, useState, type JSX } from 'react';
import { createWorkspace, errorMessage } from '../api.js';
import type {
  ConnectorSummary,
  CreateWorkspaceRequest,
  RepoSummary,
  WorkspaceSummary,
} from '../../../core/api.js';
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
 * Collects one epic, the repo it is worked in and the connector that reads it,
 * creating the connector inline when the owner has none yet.
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="scrim dialog-scrim" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add a workspace"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="path-row">
            <h2>Add a workspace</h2>
            <span className="header-spacer" />
            <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          <p>One epic, the repo its issues are worked in, and the account that reads it.</p>
        </div>

        <div className="dialog-body">
          <div className="dialog-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>Epic key</span>
              <input
                value={epic}
                placeholder="DOC-3807"
                onChange={(event) => setEpic(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Repo</span>
              <select value={repo} onChange={(event) => setRepo(event.target.value)}>
                {repos.length === 0 ? <option value="">No repos configured</option> : null}
                {repos.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>Issue source</span>
            <select value={connector} onChange={(event) => setConnector(event.target.value)}>
              {connectors.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id} — {entry.site}
                </option>
              ))}
              <option value={NEW_CONNECTOR}>Add a new issue source</option>
            </select>
          </label>

          {creatingConnector ? (
            <div className="dialog-grid">
              <label className="field">
                <span>Source id</span>
                <input
                  value={connectorId}
                  placeholder="kentico-jira"
                  onChange={(event) => setConnectorId(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Jira site</span>
                <input
                  value={site}
                  placeholder="example.atlassian.net"
                  onChange={(event) => setSite(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Email variable</span>
                <input
                  value={emailEnv}
                  placeholder="JIRA_EMAIL"
                  onChange={(event) => setEmailEnv(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Token variable</span>
                <input
                  value={tokenEnv}
                  placeholder="JIRA_PAT"
                  onChange={(event) => setTokenEnv(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          <label className="field">
            <span>Review statuses, separated by commas</span>
            <input
              value={reviewStatuses}
              onChange={(event) => setReviewStatuses(event.target.value)}
            />
          </label>

          {error === null ? null : <p className="error-note">{error}</p>}
        </div>

        <div className="dialog-foot">
          <span className="action-spacer" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
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
