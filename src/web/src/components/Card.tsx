import type { JSX } from 'react';
import type { Card as CardModel, CardSession, PlaybookSummary } from '../../../core/api.js';
import { timeInState, typeGlyph } from '../format.js';
import { STATE_LABELS } from '../model.js';
import { CacheReadout } from './CacheReadout.js';
import { LabelChips, StatusChip } from './Chips.js';
import { EditorIcon } from './Icons.js';
import { Lamp, type LampTone } from './Lamp.js';
import { Menu } from './Menu.js';

/**
 * Everything a card can ask the board to do.
 */
export interface CardHandlers {
  /** Opens the issue drawer for a card. */
  openIssue: (card: CardModel) => void;
  /** Opens the start dialog for a card and playbook. */
  startPlaybook: (card: CardModel, playbookId: string) => void;
  /** Opens a session's terminal view. */
  openSession: (sessionId: string) => void;
  /** Opens the issue's checkout in the desktop editor. */
  openEditor: (card: CardModel) => void;
  /** Sets or clears one of the owner's per-issue flags. */
  setFlag: (card: CardModel, flag: 'review' | 'done', value: boolean) => void;
}

/**
 * Picks the colour of the card's left rail from its most urgent session.
 *
 * @param card - Card to read.
 * @returns The rail tone, or null when nothing on the card is signalling.
 */
function railTone(card: CardModel): LampTone | null {
  if (card.needsYou) return 'amber';
  if (card.sessions.some((session) => session.state === 'failed')) return 'red';
  if (card.sessions.some((session) => session.live)) return 'cyan';
  if (card.column === 'done' || card.flags.done === true) return 'moss';
  return null;
}

/**
 * Renders one session row: what it runs, where it is, its cache clock, and —
 * while it is blocked on the owner — what it is waiting for, so a full
 * needs-you column can be triaged without opening every card.
 *
 * A board frame carries no assistant snippet, so a session waiting without a
 * pending summary (an idle one, usually) shows no second line.
 *
 * @param props - Component props.
 * @param props.session - Session to render.
 * @param props.playbookLabel - Label of the playbook that produced the prompt.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.onOpen - Called when the row is activated.
 * @returns The session row.
 */
function SessionRow({
  session,
  playbookLabel,
  nowMs,
  onOpen,
}: {
  session: CardSession;
  playbookLabel: string;
  nowMs: number;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button type="button" className="session-row card-open" onClick={onOpen}>
      <span className="session-line">
        <Lamp state={session.state} />
        <span className="session-playbook">{playbookLabel}</span>
        <span className="session-state">{STATE_LABELS[session.state]}</span>
        {session.done ? <span className="session-done">done</span> : null}
        <span className="session-time">{timeInState(session.stateSince, nowMs)}</span>
        <CacheReadout cache={session.cache} nowMs={nowMs} />
      </span>
      {session.needsYou && session.pending !== null ? (
        <span className="session-pending">{session.pending.summary}</span>
      ) : null}
    </button>
  );
}

/**
 * Renders one issue as a board card: identity, summary, chips, its sessions,
 * and the actions the column offers.
 *
 * @param props - Component props.
 * @param props.card - Card to render.
 * @param props.playbooks - Playbooks the workspace offers.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @param props.handlers - Callbacks for every action the card can trigger.
 * @returns The card element.
 */
export function Card({
  card,
  playbooks,
  nowMs,
  handlers,
}: {
  card: CardModel;
  playbooks: PlaybookSummary[];
  nowMs: number;
  handlers: CardHandlers;
}): JSX.Element {
  const tone = railTone(card);
  const primary = playbooks.find((playbook) => playbook.id === card.primaryPlaybookId) ?? null;
  const others = playbooks.filter((playbook) => playbook.id !== primary?.id);
  // Starting a second session for a playbook that already has a live one is a
  // 409, so the button opens the running session rather than offering a start.
  const running =
    primary === null
      ? null
      : (card.sessions.find((session) => session.playbookId === primary.id && session.live) ??
        null);
  const labelFor = (playbookId: string): string =>
    playbooks.find((playbook) => playbook.id === playbookId)?.label ?? playbookId;

  return (
    <article className="card">
      <span className="card-rail" data-tone={tone ?? undefined} />
      <button
        type="button"
        className="card-open"
        onClick={() => handlers.openIssue(card)}
        aria-label={`Open ${card.issue.key}`}
      >
        <span className="card-ident">
          <span className="type-glyph" title={card.issue.type}>
            {typeGlyph(card.issue.type)}
          </span>
          <span className="card-key">{card.issue.key}</span>
        </span>
        <span className="card-summary">{card.issue.summary}</span>
      </button>

      <div className="chip-row">
        <StatusChip status={card.issue.status} category={card.issue.statusCategory} />
        {card.flags.review === true ? <span className="chip flag-chip">in review</span> : null}
        {card.flags.done === true ? <span className="chip flag-chip">marked done</span> : null}
        <LabelChips labels={card.issue.labels} />
      </div>

      {card.sessions.length > 0 ? (
        <div className="session-rows">
          {card.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              playbookLabel={labelFor(session.playbookId)}
              nowMs={nowMs}
              onOpen={() => handlers.openSession(session.id)}
            />
          ))}
        </div>
      ) : null}

      <div className="card-actions">
        {primary === null ? null : running !== null ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => handlers.openSession(running.id)}
          >
            Open {primary.label} session
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => handlers.startPlaybook(card, primary.id)}
          >
            Start {primary.label}
          </button>
        )}
        <span className="action-spacer" />
        {card.worktreePath === null ? null : (
          <button
            type="button"
            className="btn btn-icon"
            aria-label={`Open ${card.issue.key} in VS Code`}
            title={card.worktreePath}
            onClick={() => handlers.openEditor(card)}
          >
            <EditorIcon />
          </button>
        )}
        <Menu label={`More actions for ${card.issue.key}`}>
          {(close) => (
            <>
              {others.map((playbook) => (
                <button
                  key={playbook.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    handlers.startPlaybook(card, playbook.id);
                  }}
                >
                  Start {playbook.label}
                </button>
              ))}
              {others.length > 0 ? <span className="menu-divider" /> : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  handlers.setFlag(card, 'review', card.flags.review !== true);
                }}
              >
                {card.flags.review === true ? 'Clear review' : 'Send to review'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  handlers.setFlag(card, 'done', card.flags.done !== true);
                }}
              >
                {card.flags.done === true ? 'Unmark done' : 'Mark done'}
              </button>
              <span className="menu-divider" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  window.open(card.issue.url, '_blank', 'noopener');
                }}
              >
                Open in Jira
              </button>
            </>
          )}
        </Menu>
      </div>
    </article>
  );
}
