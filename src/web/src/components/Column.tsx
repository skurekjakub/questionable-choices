import type { JSX } from 'react';
import type { BoardColumn, PlaybookSummary } from '../../../core/api.js';
import { Card, type CardHandlers } from './Card.js';

/**
 * Renders one board lane: its heading, its count, and its cards.
 *
 * @param props - Component props.
 * @param props.column - Lane to render.
 * @param props.playbooks - Playbooks the workspace offers.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.handlers - Callbacks for every action a card can trigger.
 * @returns The column element.
 */
export function Column({
  column,
  playbooks,
  nowMs,
  handlers,
}: {
  column: BoardColumn;
  playbooks: PlaybookSummary[];
  nowMs: number;
  handlers: CardHandlers;
}): JSX.Element {
  const alert = column.id === 'needs-you' && column.count > 0;
  return (
    <section className="column" aria-label={`${column.name}, ${column.count} issues`}>
      <header className="column-head" data-alert={alert}>
        <h2>{column.name}</h2>
        <span className="count">{column.count}</span>
      </header>
      <div className="column-body">
        {column.cards.length === 0 ? (
          <p className="empty">Nothing here.</p>
        ) : (
          column.cards.map((card) => (
            <Card
              key={card.issue.key}
              card={card}
              playbooks={playbooks}
              nowMs={nowMs}
              handlers={handlers}
            />
          ))
        )}
      </div>
    </section>
  );
}
