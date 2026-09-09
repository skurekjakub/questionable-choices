import type { JSX } from 'react';
import type { CardIssue } from '../../../core/api.js';

/**
 * Number of labels shown before the rest collapse into a count.
 */
const LABEL_LIMIT = 3;

/**
 * Renders the tracker's own status name, tinted by its normalised bucket.
 *
 * @param props - Component props.
 * @param props.status - Status name as the tracker spells it.
 * @param props.category - Normalised status bucket.
 * @returns The status chip.
 */
export function StatusChip({
  status,
  category,
}: {
  status: string;
  category: CardIssue['statusCategory'];
}): JSX.Element {
  return (
    <span className="chip" data-category={category}>
      {status}
    </span>
  );
}

/**
 * Renders up to three labels, collapsing the remainder into a count.
 *
 * @param props - Component props.
 * @param props.labels - Label names in tracker order.
 * @returns The label chips, or null when the issue has none.
 */
export function LabelChips({ labels }: { labels: string[] }): JSX.Element | null {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, LABEL_LIMIT);
  const rest = labels.length - shown.length;
  return (
    <>
      {shown.map((label) => (
        <span className="label-chip" key={label}>
          {label}
        </span>
      ))}
      {rest > 0 ? (
        <span className="label-chip" title={labels.slice(LABEL_LIMIT).join(', ')}>
          +{rest}
        </span>
      ) : null}
    </>
  );
}
