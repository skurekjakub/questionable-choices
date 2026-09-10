import { useState, type JSX } from 'react';
import { CompactIcon } from './Icons.js';

/**
 * What the Compact button promises, in full, as its tooltip.
 *
 * The model switch is named because it is the part an owner would not expect:
 * the session comes back on the model it was on, but their own global default
 * for new sessions is written twice on the way.
 */
export const COMPACT_TITLE =
  'Summarise the conversation so far and carry on from the summary. ' +
  'The session is switched to a cheaper model for the summary and switched back afterwards; ' +
  'nothing else is sent to it.';

/**
 * Renders the Compact action for one session.
 *
 * It disables itself while its own request is in flight rather than reading a
 * flag off the record: the record only says "compacting" once the server has
 * answered, and a second click before that would be a second request.
 *
 * @param props - Component props.
 * @param props.onCompact - Starts the compaction; rejects with the refusal.
 * @param props.label - Accessible name, which names the session it acts on.
 * @returns The button.
 */
export function CompactButton({
  onCompact,
  label,
}: {
  onCompact: () => Promise<void>;
  label: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet compact-button"
      aria-label={label}
      title={COMPACT_TITLE}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onCompact().finally(() => setBusy(false));
      }}
    >
      <CompactIcon /> Compact
    </button>
  );
}
