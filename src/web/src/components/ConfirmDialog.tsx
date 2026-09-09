import { useEffect, type JSX } from 'react';

/**
 * Asks the owner to confirm one action, spelling out what it does and does not
 * touch.
 *
 * @param props - Component props.
 * @param props.title - Heading naming the action.
 * @param props.body - Sentence explaining the consequences.
 * @param props.confirmLabel - Label of the confirming button.
 * @param props.error - Message from a failed attempt, or null.
 * @param props.busy - Whether the action is in flight.
 * @param props.onConfirm - Called when the owner confirms.
 * @param props.onCancel - Called when the owner backs out.
 * @returns The dialog element.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="scrim dialog-scrim" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: '440px' }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
        {error === null ? null : (
          <div className="dialog-body">
            <p className="error-note">{error}</p>
          </div>
        )}
        <div className="dialog-foot">
          <span className="action-spacer" />
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
