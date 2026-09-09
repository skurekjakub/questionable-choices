import type { JSX } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap.js';

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
  const dialog = useFocusTrap<HTMLDivElement>(onCancel);

  return (
    <div className="scrim dialog-scrim" onMouseDown={onCancel}>
      <div
        className="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialog}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
        {error === null ? null : (
          <div className="dialog-body">
            <p className="error-note" role="alert">
              {error}
            </p>
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
