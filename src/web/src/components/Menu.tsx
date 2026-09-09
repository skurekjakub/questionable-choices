import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { OverflowIcon } from './Icons.js';

/**
 * An overflow menu that closes on outside click, on Escape and on selection.
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
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (anchor.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
