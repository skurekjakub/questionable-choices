import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { copyText } from '../format.js';
import { CopyIcon } from './Icons.js';

/**
 * Copies a value to the clipboard and confirms it in place for two seconds.
 *
 * The button is named by its own visible word; what is being copied is its
 * description, and the confirmation is announced from a live region so it is
 * not silent for a screen reader.
 *
 * @param props - Component props.
 * @param props.value - Text placed on the clipboard.
 * @param props.label - Sentence describing what is copied.
 * @returns The copy button.
 */
export function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const describedBy = useId();

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const onClick = useCallback(() => {
    void copyText(value).then((ok) => setCopied(ok));
  }, [value]);

  return (
    <>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={onClick}
        title={label}
        aria-describedby={describedBy}
      >
        <CopyIcon />
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span id={describedBy} className="sr-only">
        {label}
      </span>
      <span className="sr-only" role="status">
        {copied ? `${label}: copied` : ''}
      </span>
    </>
  );
}
