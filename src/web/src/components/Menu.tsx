import { useCallback, useState, type JSX, type ReactNode } from 'react';
import { useMenuKeys } from '../hooks/useMenuKeys.js';
import { OverflowIcon } from './Icons.js';

/**
 * An overflow menu that closes on outside click, on Escape and on selection,
 * and whose items are reachable with the arrow keys.
 *
 * @param props - Component props.
 * @param props.label - Accessible name of the trigger button.
 * @param props.children - Menu items, rendered by a callback that closes the menu.
 * @returns The trigger and, while open, the menu.
 */
export function Menu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { anchor, panel } = useMenuKeys(open, close);

  return (
    <div className="menu-anchor" ref={anchor}>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((was) => !was);
        }}
      >
        <OverflowIcon />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label={label} ref={panel}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
