import type { JSX } from 'react';
import type { SessionState } from '../model.js';

/**
 * Colour band a lamp is drawn in.
 */
export type LampTone = 'cyan' | 'amber' | 'red' | 'moss' | 'dim';

/**
 * Silhouette a lamp is drawn as, so state survives without colour.
 */
export type LampShape = 'disc' | 'ring' | 'bar' | 'square';

/**
 * How one session state is signalled.
 */
export interface LampLook {
  /** Silhouette of the indicator. */
  shape: LampShape;
  /** Colour band of the indicator. */
  tone: LampTone;
  /** Whether the indicator breathes to draw the eye. */
  pulse: boolean;
}

/**
 * Maps a session state onto its indicator.
 *
 * @param state - Lifecycle state to signal.
 * @returns The shape, tone and pulse for that state.
 */
export function lampFor(state: SessionState): LampLook {
  switch (state) {
    case 'bootstrapping':
      return { shape: 'ring', tone: 'cyan', pulse: false };
    case 'starting':
      return { shape: 'disc', tone: 'dim', pulse: false };
    case 'working':
      return { shape: 'disc', tone: 'cyan', pulse: false };
    case 'waiting-permission':
      return { shape: 'disc', tone: 'amber', pulse: true };
    case 'waiting-question':
      return { shape: 'ring', tone: 'amber', pulse: true };
    case 'idle':
      return { shape: 'ring', tone: 'amber', pulse: false };
    case 'exited':
      return { shape: 'bar', tone: 'dim', pulse: false };
    case 'failed':
      return { shape: 'square', tone: 'red', pulse: false };
  }
}

/**
 * Draws the state indicator for one session.
 *
 * @param props - Component props.
 * @param props.state - Lifecycle state to signal.
 * @returns The indicator element.
 */
export function Lamp({ state }: { state: SessionState }): JSX.Element {
  const look = lampFor(state);
  return (
    <span
      className="lamp"
      data-shape={look.shape}
      data-tone={look.tone}
      data-pulse={look.pulse}
      aria-hidden="true"
    />
  );
}

/**
 * What an unverified session's marker says, in the one place both surfaces
 * that render it read it from.
 */
export const STALE_SENTENCE = 'No hook has been seen since the server restarted';

/**
 * Draws the marker for a session whose state has not been confirmed since the
 * server restarted.
 *
 * It is a second indicator rather than a word because the row it sits in has
 * no room for one: a chip long enough to say this pushed the time reading off
 * the card. The sentence is carried by the accessible name and the tooltip, so
 * nothing about it is colour-only.
 *
 * @returns The marker element.
 */
export function StaleMarker(): JSX.Element {
  return (
    <span className="session-stale" role="img" aria-label={STALE_SENTENCE} title={STALE_SENTENCE} />
  );
}

/**
 * Words the hint marker stands for.
 *
 * @param summary - What the notification said.
 * @returns The sentence carried by the marker's accessible name and tooltip.
 */
export function hintSentence(summary: string): string {
  return `This session may need you: ${summary}`;
}

/**
 * Draws the marker for a session whose last notification suggests it is
 * waiting on the owner.
 *
 * A notification lags the dialog it describes and cannot be placed in a turn,
 * so what it says is a hint and not a state: the marker never moves the session
 * between columns and never raises a desktop notification. It is a marker
 * rather than a word for the same reason the unverified marker is — the row it
 * sits in has no room for the sentence, which the accessible name and the
 * tooltip carry instead.
 *
 * @param props - Component props.
 * @param props.summary - What the notification said.
 * @returns The marker element.
 */
export function HintMarker({ summary }: { summary: string }): JSX.Element {
  const sentence = hintSentence(summary);
  return <span className="session-hint" role="img" aria-label={sentence} title={sentence} />;
}
