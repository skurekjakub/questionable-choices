// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JSX } from 'react';
import { useFocusTrap } from '../../../src/web/src/hooks/useFocusTrap.js';
import '../jsdom-gaps.js';

/**
 * `getClientRects` as jsdom leaves it, so the stub below can be taken off.
 */
const REAL_RECTS = Element.prototype.getClientRects;

/**
 * One box, standing in for whatever a laid-out element would report.
 */
const ONE_RECT = [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;

/**
 * A modal surface built on the trap, with an optional open menu inside it.
 *
 * @param props - Component props.
 * @param props.onEscape - Called when the trap sees Escape.
 * @param props.withMenu - Whether to render an open `role="menu"` panel inside.
 * @returns The surface element.
 */
function Surface({
  onEscape,
  withMenu = false,
}: {
  onEscape: () => void;
  withMenu?: boolean;
}): JSX.Element {
  const surface = useFocusTrap<HTMLDivElement>(onEscape);
  return (
    <div role="dialog" aria-modal="true" aria-label="a surface" tabIndex={-1} ref={surface}>
      <button type="button">First</button>
      <button type="button">Last</button>
      {withMenu ? (
        <div role="menu">
          <button type="button" role="menuitem">
            An item
          </button>
        </div>
      ) : null}
    </div>
  );
}

// The trap only offers focus to a control that occupies a box, and jsdom
// reports none for anything: without this every surface looks empty.
beforeEach(() => {
  Element.prototype.getClientRects = () => ONE_RECT;
});

afterEach(() => {
  Element.prototype.getClientRects = REAL_RECTS;
  cleanup();
});

describe('useFocusTrap', () => {
  it('moves focus into the surface when it opens', () => {
    render(<Surface onEscape={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('dismisses the surface on Escape', () => {
    let escaped = 0;
    render(
      <Surface
        onEscape={() => {
          escaped += 1;
        }}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(escaped).toBe(1);
  });

  it('leaves Escape to an open menu inside it, so one press closes only the menu', () => {
    // Both handlers are on `document` and this one captures, so without the
    // deferral a single press closes the menu and the surface under it.
    let escaped = 0;
    render(
      <Surface
        withMenu={true}
        onEscape={() => {
          escaped += 1;
        }}
      />,
    );
    const item = screen.getByRole('menuitem', { name: 'An item' });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(escaped).toBe(0);

    // A press outside the menu is still the surface's.
    fireEvent.keyDown(screen.getByRole('button', { name: 'First' }), { key: 'Escape' });
    expect(escaped).toBe(1);
  });

  it('cycles Tab from the last control back to the first', () => {
    render(<Surface onEscape={() => {}} />);
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('gives focus back to the control that opened it, not to the body', () => {
    // The integration, not the algorithm: the trap's own cleanup is what has to
    // find the opener again.
    const opener = document.createElement('button');
    opener.textContent = 'Open the surface';
    document.body.appendChild(opener);
    opener.focus();

    const view = render(<Surface onEscape={() => {}} />);
    expect(document.activeElement).not.toBe(opener);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('falls back up the tree when the control that opened it has gone', () => {
    const host = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'Open the surface';
    const sibling = document.createElement('button');
    sibling.textContent = 'Still here';
    host.append(opener, sibling);
    document.body.appendChild(host);
    opener.focus();

    const view = render(<Surface onEscape={() => {}} />);
    opener.remove();
    view.unmount();
    expect(document.activeElement).toBe(sibling);
    host.remove();
  });
});
