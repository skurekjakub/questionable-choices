// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartDialog, STILL_STARTING_SENTENCE } from '../../src/web/src/components/StartDialog.js';
import { DROPPED_SENTENCE } from '../../src/web/src/model.js';
import { card, cardSession, publicConfig } from './fixtures.js';
import './jsdom-gaps.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  getPrefill: vi.fn(),
  createSession: vi.fn(),
}));

const { getPrefill, createSession } = await import('../../src/web/src/api.js');

/**
 * Renders the dialog over one card and one playbook.
 *
 * @param onClose - Called when the dialog asks to close.
 * @param dropped - Whether the board has stopped listing the card.
 * @returns Nothing.
 */
function open(onClose: () => void = () => {}, dropped = false): void {
  render(
    <StartDialog
      card={card('DOC-1', [cardSession('qc-DOC-1-implement')])}
      workspaceId="docs"
      playbooks={[
        {
          id: 'implement',
          label: 'Implement',
          description: 'Implements the issue.',
          isolation: 'worktree',
        },
      ]}
      runner={publicConfig(['docs']).runner}
      initialPlaybookId="implement"
      dropped={dropped}
      onClose={onClose}
      onStarted={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.mocked(getPrefill).mockResolvedValue({
    prompt: 'Work on DOC-1.',
    model: 'claude-opus-5',
    effort: 'high',
    permissionMode: 'acceptEdits',
    isolation: 'worktree',
    warnings: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StartDialog', () => {
  it('refuses to be dismissed over the request that starts the session', async () => {
    // The session is started whether or not the dialog is on screen, so a
    // dismissal here loses both the id to navigate to and the refusal.
    let closed = 0;
    vi.mocked(createSession).mockImplementation(() => new Promise(() => {}));
    open(() => {
      closed += 1;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starting' })).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(0);
    expect(screen.getByRole('button', { name: 'Starting' })).toBeTruthy();
  });

  it('lets a second dismissal abandon a start request that never answers', async () => {
    // Nothing lowers `starting` for a request the server accepts and never
    // answers, and every way out routes through the same guard, so a first
    // dismissal that only refuses would seal the dialog until a reload.
    let closed = 0;
    let refuse: ((cause: unknown) => void) | null = null;
    vi.mocked(createSession).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    open(() => {
      closed += 1;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starting' })).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(0);
    expect(screen.getByText(STILL_STARTING_SENTENCE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(closed).toBe(1);

    // The request runs on; what the owner abandoned is waiting for its answer,
    // so nothing it says is reported into a dialog they have dismissed.
    await act(async () => {
      refuse?.(new Error('the runner refused the session'));
    });
    expect(screen.queryByText(/the runner refused the session/)).toBeNull();
  });

  it('closes on Escape while nothing is in flight', async () => {
    let closed = 0;
    open(() => {
      closed += 1;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('says the board has dropped the issue rather than taking the edit away', async () => {
    open(() => {}, true);
    await waitFor(() => expect(screen.getByText(DROPPED_SENTENCE)).toBeTruthy());
  });
});
