// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardSession } from '../../src/core/api.js';
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
function handlers(overrides: Partial<CardHandlers> = {}): CardHandlers {
  return {
    openIssue: () => {},
    startPlaybook: () => {},
    openSession: () => {},
    openEditor: () => {},
    compact: async () => {},
    setFlag: () => {},
    ...overrides,
  };
}

/**
 * A cache that went cold two minutes ago.
 */
const COLD = {
  expiresAt: Math.floor(Date.parse(FIXTURE_NOW) / 1000) - 120,
  ttlSeconds: 300,
  warm: false,
  source: 'statusline' as const,
};

/**
 * A session sitting at the prompt with a cold cache, which is the one shape
 * the Compact action is offered for.
 *
 * @param overrides - Fields to set, over the compactable defaults.
 * @returns The session.
 */
function coldIdle(overrides: Partial<CardSession> = {}): CardSession {
  return cardSession('qc-DOC-1-implement', {
    state: 'idle',
    needsYou: true,
    cache: COLD,
    ...overrides,
  });
}

/**
 * Renders one card with a single session.
 *
 * @param session - The session to put on the card.
 * @param handlerOverrides - Handlers to replace on the default set.
 * @returns Nothing.
 */
function open(
  session = cardSession('qc-DOC-1-implement'),
  handlerOverrides: Partial<CardHandlers> = {},
): void {
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
      handlers={handlers(handlerOverrides)}
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

  it('shows the model the session is on, next to the state', () => {
    open(cardSession('qc-DOC-1-implement', { model: 'claude-sonnet-5' }));
    const line = document.querySelector('.session-line');
    const classes = [...(line?.children ?? [])].map((child) => child.className);
    expect(classes).toEqual([
      'lamp',
      'session-playbook',
      'session-state',
      'session-model',
      'session-time',
    ]);
    expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
  });

  it('says nothing about the model before a status line has reported one', () => {
    open();
    expect(document.querySelector('.session-model')).toBeNull();
  });

  it('follows the state word with "compacting" while one is running', () => {
    open(coldIdle({ compacting: true }));
    const line = document.querySelector('.session-line');
    const classes = [...(line?.children ?? [])].map((child) => child.className);
    expect(classes.slice(0, 4)).toEqual([
      'lamp',
      'session-playbook',
      'session-state',
      'session-compacting',
    ]);
    expect(screen.getByText('compacting')).toBeTruthy();
  });

  it('offers Compact only for an idle session whose cache has gone cold', () => {
    open(coldIdle());
    expect(screen.getByRole('button', { name: 'Compact qc-DOC-1-implement' })).toBeTruthy();
  });

  it.each([
    ['a warm cache', { cache: { ...COLD, warm: true, expiresAt: COLD.expiresAt + 600 } }],
    ['no cache reported at all', { cache: null }],
    ['a state that is not idle', { state: 'working' as const, needsYou: false }],
    ['a compaction already running', { compacting: true }],
  ])('offers no Compact for %s', (_label, overrides) => {
    open(coldIdle(overrides));
    expect(screen.queryByRole('button', { name: 'Compact qc-DOC-1-implement' })).toBeNull();
  });

  it('names the session it compacts and disables itself while the POST is in flight', async () => {
    // The record only says "compacting" once the server has answered, so a
    // second click before that would be a second request.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compact = vi.fn(async (_sessionId: string) => held);
    open(coldIdle(), { compact });

    const button = screen.getByRole('button', { name: 'Compact qc-DOC-1-implement' });
    fireEvent.click(button);
    expect(compact).toHaveBeenCalledWith('qc-DOC-1-implement');
    expect(button.hasAttribute('disabled')).toBe(true);

    fireEvent.click(button);
    expect(compact).toHaveBeenCalledTimes(1);

    release();
    await act(async () => {
      await held;
    });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the Compact button out of the row’s own click target', () => {
    // A button inside a button is not a control the browser gives the keyboard,
    // and clicking it would open the session as well as compacting it.
    open(coldIdle());
    const button = screen.getByRole('button', { name: 'Compact qc-DOC-1-implement' });
    expect(button.closest('.session-open')).toBeNull();
    expect(button.closest('.session-row')).not.toBeNull();
  });
});
