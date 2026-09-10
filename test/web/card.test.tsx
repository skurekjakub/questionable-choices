// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardHandlers } from '../../src/web/src/components/Card.js';
import { Card } from '../../src/web/src/components/Card.js';
import { hintSentence, STALE_SENTENCE } from '../../src/web/src/components/Lamp.js';
import { card, cardSession, FIXTURE_NOW } from './fixtures.js';
import './jsdom-gaps.js';

/**
 * Handlers that record nothing, for the actions a test does not exercise.
 *
 * @returns The handler set.
 */
function handlers(): CardHandlers {
  return {
    openIssue: () => {},
    startPlaybook: () => {},
    openSession: () => {},
    openEditor: () => {},
    setFlag: () => {},
  };
}

/**
 * Renders one card with a single session.
 *
 * @param session - The session to put on the card.
 * @returns Nothing.
 */
function open(session = cardSession('qc-DOC-1-implement')): void {
  render(
    <Card
      card={card('DOC-1', [session])}
      playbooks={[
        {
          id: 'implement',
          label: 'Implement',
          description: 'Implements it.',
          isolation: 'worktree',
        },
      ]}
      nowMs={Date.parse(FIXTURE_NOW)}
      handlers={handlers()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Card', () => {
  it('opens the tracker with no handle back to this page', () => {
    // Without `noopener` the tracker tab gets a live `window.opener` and can
    // navigate the dashboard; the two anchors that open the same URL carry it.
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for DOC-1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Jira' }));
    expect(opened).toHaveBeenCalledWith(
      'https://example.atlassian.net/browse/DOC-1',
      '_blank',
      'noopener,noreferrer',
    );
    vi.unstubAllGlobals();
  });

  it('puts the glyph before the key', () => {
    open();
    const ident = document.querySelector('.card-ident');
    expect(ident?.firstElementChild?.className).toBe('type-glyph');
  });

  it('orders the row the way the spec reads it', () => {
    // playbook, state, time in state, done, unverified, may-need-you, gauge.
    open(
      cardSession('qc-DOC-1-implement', {
        done: true,
        staleSince: FIXTURE_NOW,
        hint: 'Claude is waiting for your input',
        cache: { expiresAt: 0, ttlSeconds: 300, warm: false, source: 'statusline' },
      }),
    );
    const line = document.querySelector('.session-line');
    const classes = [...(line?.children ?? [])].map((child) => child.className);
    expect(classes).toEqual([
      'lamp',
      'session-playbook',
      'session-state',
      'session-time',
      'session-done',
      'session-stale',
      'session-hint',
      'cache',
    ]);
  });

  it('carries each marker’s whole sentence in its accessible name', () => {
    open(
      cardSession('qc-DOC-1-implement', {
        staleSince: FIXTURE_NOW,
        hint: 'Claude is waiting for your input',
      }),
    );
    expect(screen.getByLabelText(STALE_SENTENCE)).toBeTruthy();
    expect(screen.getByLabelText(hintSentence('Claude is waiting for your input'))).toBeTruthy();
  });

  it('opens the running session rather than offering a second start, for every live state', () => {
    // Starting a second session for a playbook that already has a live one is a
    // 409, and "live" is the contract's own set — not the three states a reader
    // thinks of first.
    open(cardSession('qc-DOC-1-implement', { state: 'waiting-permission', needsYou: true }));
    expect(screen.getByRole('button', { name: 'Open Implement session' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start Implement' })).toBeNull();
  });

  it('shows no may-need-you marker for a session with no outstanding notification', () => {
    open();
    expect(document.querySelector('.session-hint')).toBeNull();
  });
});
