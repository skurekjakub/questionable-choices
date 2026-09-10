// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/web/src/components/ErrorBoundary.js';
import { navigate } from '../../src/web/src/navigation.js';

/**
 * A child that throws on demand, standing in for any tree below the boundary.
 *
 * @param props - Component props.
 * @param props.throws - Value to throw, or null to render.
 * @returns The healthy child.
 */
function Bomb({ throws }: { throws: unknown }): React.JSX.Element {
  if (throws !== null) throw throws;
  return <p>the dashboard</p>;
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
  // React reports a caught error to the console; the noise is not the subject.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows what happened instead of an empty document', () => {
    render(
      <ErrorBoundary>
        <Bomb throws={new Error('probe: title is not settable')} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('probe: title is not settable');
    expect(screen.queryByText('the dashboard')).toBeNull();
  });

  it('renders a sentence for a thrown value with no words of its own', () => {
    render(
      <ErrorBoundary>
        <Bomb throws={new Error('')} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The dashboard stopped rendering: no message',
    );
  });

  it('mounts the tree again when the owner asks it to try again', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb throws={new Error('one bad frame')} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary>
        <Bomb throws={null} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('the dashboard')).toBeTruthy();
  });

  it('clears the failure when the owner navigates away from the route it happened on', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb throws={new Error('one bad frame')} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary>
        <Bomb throws={null} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('the dashboard')).toBeNull();
    act(() => navigate('/session/qc-DOC-1-implement'));
    expect(screen.getByText('the dashboard')).toBeTruthy();
  });

  it('keeps the failure up while the owner is still on the route that threw', () => {
    // The child is rendered healthy first, so clearing and re-deriving the
    // failure would look identical without it: only a boundary that checks the
    // pathname still has the panel up here.
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb throws={new Error('one bad frame')} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary>
        <Bomb throws={null} />
      </ErrorBoundary>,
    );
    act(() => {
      window.dispatchEvent(new Event('popstate'));
    });
    expect(screen.queryByText('the dashboard')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('one bad frame');
  });

  it('shows the failure again, without looping, when the tree is still broken', () => {
    // The realistic case for *Try again*: a chunk that 404s answers the retry
    // with the same rejection, and the panel has to come back rather than
    // leaving a blank page behind.
    render(
      <ErrorBoundary>
        <Bomb throws={new Error('chunk 404')} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert').textContent).toContain('chunk 404');
    expect(screen.queryByText('the dashboard')).toBeNull();
  });

  it('shows the failure again when the owner navigates back onto the route that threw', () => {
    render(
      <ErrorBoundary>
        <Bomb throws={new Error('one bad frame')} />
      </ErrorBoundary>,
    );
    act(() => navigate('/session/qc-DOC-1-implement'));
    act(() => navigate('/'));
    expect(screen.getByRole('alert').textContent).toContain('one bad frame');
  });

  it('names the route the failure happened on, which is the only trace it leaves', () => {
    const reported = vi.mocked(console.error);
    window.history.pushState(null, '', '/session/qc-DOC-1-implement');
    render(
      <ErrorBoundary>
        <Bomb throws={new Error('one bad frame')} />
      </ErrorBoundary>,
    );
    const lines = reported.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('/session/qc-DOC-1-implement'))).toBe(true);
  });

  it('hands the failure to a caller that renders its own, leaving the rest standing', () => {
    render(
      <ErrorBoundary
        fallback={(message, retry) => (
          <div>
            <p>the terminal could not be loaded: {message}</p>
            <button type="button" onClick={retry}>
              Try again
            </button>
          </div>
        )}
      >
        <Bomb throws={new Error('chunk 404')} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('the terminal could not be loaded: chunk 404')).toBeTruthy();
    // The whole-dashboard panel must not be what a scoped boundary renders.
    expect(screen.queryByText(/The dashboard stopped rendering/)).toBeNull();
  });
});
