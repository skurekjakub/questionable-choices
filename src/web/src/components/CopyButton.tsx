import { useCallback, useEffect, useState, type JSX } from 'react';
import { copyText } from '../format.js';
import { CopyIcon } from './Icons.js';

/**
 * Copies a value to the clipboard and confirms it in place for two seconds.
 *
 * @param props - Component props.
 * @param props.value - Text placed on the clipboard.
 * @param props.label - Accessible name describing what is copied.
 * @returns The copy button.
 */
export function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const onClick = useCallback(() => {
    void copyText(value).then((ok) => setCopied(ok));
  }, [value]);

  return (
    <button type="button" className="btn btn-quiet" onClick={onClick} aria-label={label}>
      <CopyIcon />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
