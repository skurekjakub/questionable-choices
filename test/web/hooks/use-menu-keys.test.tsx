// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { JSX } from 'react';
import { useMenuKeys } from '../../../src/web/src/hooks/useMenuKeys.js';
import '../jsdom-gaps.js';

/**
 * A trigger and an open menu panel wired to the hook, with a control outside
 * it that keyboard events can be aimed at.
 *
 * @param props - Component props.
 * @param props.onClose - Called when the menu should close.
 * @param props.checked - Label of the item marked `aria-checked`, or null.
 * @returns The anchor and the panel.
 */
function Menu({
  onClose,
  checked = null,
}: {
  onClose: () => void;
  checked?: string | null;
}): JSX.Element {
  const { anchor, panel } = useMenuKeys(true, onClose);
  return (
    <>
      <div ref={anchor}>
        <button type="button">Trigger</button>
        <div role="menu" ref={panel}>
          {['One', 'Two', 'Three'].map((label) => (
            <button key={label} type="button" role="menuitemradio" aria-checked={label === checked}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <button type="button">Outside</button>
    </>
  );
}

afterEach(cleanup);

describe('useMenuKeys', () => {
  it('focuses the checked item when the panel opens', () => {
    render(<Menu onClose={() => {}} checked="Two" />);
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Two' }));
  });

  it('walks the items on ArrowDown and wraps at the end', () => {
    render(<Menu onClose={() => {}} checked="Three" />);
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Three' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'One' }));
  });

  it('jumps to the last item on End', () => {
    render(<Menu onClose={() => {}} checked="One" />);
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'One' }), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Three' }));
  });

  it('leaves an arrow key pressed outside the panel alone', () => {
    // The handler is on `document` for as long as the menu is open, and an item
    // index of -1 reads as "before the first": without a target check, a press
    // anywhere on the page pulls focus into the menu.
    render(<Menu onClose={() => {}} checked="One" />);
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(outside);
  });

  it('closes on Escape and gives the trigger its focus back', () => {
    let closed = 0;
    render(
      <Menu
        onClose={() => {
          closed += 1;
        }}
        checked="One"
      />,
    );
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'One' }), { key: 'Escape' });
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Trigger' }));
  });

  it('closes on a pointer press outside the anchor', () => {
    let closed = 0;
    render(
      <Menu
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(closed).toBe(1);
  });

  it('stays open for a pointer press on the trigger inside the anchor', () => {
    let closed = 0;
    render(
      <Menu
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Trigger' }));
    expect(closed).toBe(0);
  });
});
