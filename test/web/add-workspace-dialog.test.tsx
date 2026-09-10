// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/src/api.js';
import {
  AddWorkspaceDialog,
  STILL_ADDING_SENTENCE,
} from '../../src/web/src/components/AddWorkspaceDialog.js';

vi.mock('../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/src/api.js')>()),
  createWorkspace: vi.fn(),
}));

const { createWorkspace } = await import('../../src/web/src/api.js');

/**
 * Renders the dialog over one repo and one connector.
 *
 * @param onClose - Called when the dialog asks to close.
 * @returns Nothing.
 */
function open(onClose: () => void = () => {}): void {
  render(
    <AddWorkspaceDialog
      repos={[{ id: 'app', path: '/repos/app' }]}
      connectors={[{ id: 'jira', site: 'example.atlassian.net' }]}
      onClose={onClose}
      onAdded={() => {}}
    />,
  );
}

/**
 * Finds the control of the field with the given label.
 *
 * The label is matched on its own `<span>` rather than on the label element's
 * text, which grows a field note the moment the server faults the field.
 *
 * @param label - Visible label of the field.
 * @returns The input or select the label names.
 * @throws {Error} When no field carries that label.
 */
function control(label: string): HTMLElement {
  const span = [...document.querySelectorAll('label.field > span')].find(
    (element) => element.textContent === label,
  );
  const found = span?.parentElement?.querySelector<HTMLElement>('input, select');
  if (found == null) throw new Error(`no field is labelled ${label}`);
  return found;
}

/**
 * Types a value into the field with the given label.
 *
 * @param label - Visible label of the field.
 * @param value - Value to type.
 * @returns Nothing.
 */
function type(label: string, value: string): void {
  fireEvent.change(control(label), { target: { value } });
}

/**
 * Submits a request the server refuses with the given per-field problems.
 *
 * @param issues - Problems the server places against request paths.
 * @returns Nothing.
 */
async function submitRefused(issues: { path: string; message: string }[]): Promise<void> {
  vi.mocked(createWorkspace).mockRejectedValue(
    new ApiError(400, 'Invalid workspace request', null, issues),
  );
  type('Name', 'Docs Nextjs');
  type('Epic key', 'NOTAKEY');
  fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
  await waitFor(() => expect(screen.getByText(/Invalid workspace request/)).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddWorkspaceDialog', () => {
  it('stops asserting the request is invalid once nothing in it is', async () => {
    open();
    await submitRefused([
      { path: 'name', message: 'name is already taken' },
      { path: 'epic', message: 'epic must be an issue key' },
    ]);
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);

    type('Name', 'Docs Next');
    type('Epic key', 'DOC-3807');
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(screen.queryByText(/Invalid workspace request/)).toBeNull();
  });

  it('keeps a refusal that named no field, which no edit can answer', async () => {
    open();
    await submitRefused([{ path: 'jql', message: 'jql must not be empty' }]);
    type('Name', 'Docs Next');
    // Nothing the owner can type retires this one, so it stays until the next
    // submit rather than clearing on an unrelated keystroke.
    expect(screen.getByText(/Invalid workspace request/)).toBeTruthy();
  });

  it('retires the problems of the fields that leave the screen with the connector', async () => {
    open();
    fireEvent.change(control('Issue source'), {
      target: { value: '__new__' },
    });
    vi.mocked(createWorkspace).mockRejectedValue(
      new ApiError(400, 'Invalid workspace request', null, [
        { path: 'newConnector.site', message: 'site must not be empty' },
      ]),
    );
    type('Name', 'Docs Nextjs');
    type('Epic key', 'DOC-3807');
    type('Source id', 'kentico-jira');
    type('Jira site', 'not a host');
    type('Email variable', 'JIRA_EMAIL');
    type('Token variable', 'JIRA_PAT');
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    await waitFor(() => expect(screen.getByText('site must not be empty')).toBeTruthy());

    fireEvent.change(control('Issue source'), { target: { value: 'jira' } });
    // The four fields unmount, so a problem left on one of them can never be
    // answered: it is retired with them rather than kept as an invisible one.
    expect(screen.queryByText('site must not be empty')).toBeNull();
    expect(screen.queryByText(/Invalid workspace request/)).toBeNull();
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
  });

  it('does not count a changed select as work worth confirming away', () => {
    let closed = 0;
    open(() => {
      closed += 1;
    });
    // Revealing the new-connector fields fills nothing in, so there is nothing
    // to discard and nothing to ask about.
    fireEvent.change(control('Issue source'), { target: { value: '__new__' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/Closing discards it/)).toBeNull();
    expect(closed).toBe(1);
  });

  it('forgets a select it was switched to and back again', () => {
    let closed = 0;
    open(() => {
      closed += 1;
    });
    fireEvent.change(control('Issue source'), { target: { value: '__new__' } });
    fireEvent.change(control('Issue source'), { target: { value: 'jira' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/Closing discards it/)).toBeNull();
    expect(closed).toBe(1);
  });

  it('still confirms away a form that has been typed into', () => {
    let closed = 0;
    open(() => {
      closed += 1;
    });
    type('Name', 'Docs Next');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText(/Closing discards it/)).toBeTruthy();
    expect(closed).toBe(0);
  });

  it('refuses to be dismissed over the request that creates the workspace', async () => {
    // The workspace is created whether or not the dialog is on screen, so a
    // dismissal here loses the 201 that selects it and the 400 that names the
    // field to fix.
    let closed = 0;
    vi.mocked(createWorkspace).mockImplementation(() => new Promise(() => {}));
    open(() => {
      closed += 1;
    });
    type('Name', 'Docs Next');
    type('Epic key', 'DOC-3807');
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adding' })).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(0);
    expect(screen.queryByText(/Closing discards it/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Adding' })).toBeTruthy();
  });

  it('lets a second dismissal abandon a create request that never answers', async () => {
    // Nothing lowers `saving` for a request the server accepts and never
    // answers, and every way out routes through the same guard, so a first
    // dismissal that only refuses would seal the dialog until a reload.
    let closed = 0;
    let refuse: ((cause: unknown) => void) | null = null;
    vi.mocked(createWorkspace).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    open(() => {
      closed += 1;
    });
    type('Name', 'Docs Next');
    type('Epic key', 'DOC-3807');
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adding' })).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(0);
    expect(screen.getByText(STILL_ADDING_SENTENCE)).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(1);
    // The dismissal is not the discard confirmation: there is nothing left to
    // keep, because the dialog is going whatever the request answers.
    expect(screen.queryByText(/Closing discards it/)).toBeNull();

    // The workspace is still created; what the owner abandoned is waiting for
    // the answer, so nothing it says lands in a dialog they have dismissed.
    await act(async () => {
      refuse?.(new Error('the epic could not be read'));
    });
    expect(screen.queryByText(/the epic could not be read/)).toBeNull();
  });

  it('hands focus on when the button holding it unmounts itself', () => {
    open();
    type('Name', 'Docs Next');
    fireEvent.keyDown(document, { key: 'Escape' });
    const keepEditing = screen.getByRole('button', { name: 'Keep editing' });
    expect(document.activeElement).toBe(keepEditing);
    fireEvent.click(keepEditing);
    // Focus would otherwise land on `document.body` with the dialog still open.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});
