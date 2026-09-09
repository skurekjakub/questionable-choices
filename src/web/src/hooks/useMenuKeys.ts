import { useEffect, useRef, type RefObject } from 'react';

/**
 * Selector matching the items a `role="menu"` panel offers.
 */
const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"]';

/**
 * Refs a caller of {@link useMenuKeys} attaches to its markup.
 */
export interface MenuRefs {
  /** Wraps the trigger and the panel; a pointer press outside it closes the menu. */
  anchor: RefObject<HTMLDivElement | null>;
  /** The `role="menu"` panel, searched for the items arrow keys walk. */
  panel: RefObject<HTMLDivElement | null>;
}

/**
 * Lists the items of a menu panel that can currently take focus.
 *
 * @param panel - The `role="menu"` element.
 * @returns The enabled items in document order.
 */
function items(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(MENU_ITEMS)].filter(
    (item) => !item.hasAttribute('disabled'),
  );
}

/**
 * Gives a popover menu the keyboard behaviour `role="menu"` promises: the
 * checked item takes focus when the panel opens, Up/Down/Home/End walk the
 * items, Escape and a pointer press outside close it, and the trigger takes
 * focus back on Escape.
 *
 * @param open - Whether the panel is currently rendered.
 * @param onClose - Called when the menu should close.
 * @returns Refs for the anchor and the panel.
 */
export function useMenuKeys(open: boolean, onClose: () => void): MenuRefs {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const element = panel.current;
    if (element === null) return;
    const entries = items(element);
    const checked = entries.find((item) => item.getAttribute('aria-checked') === 'true');
    (checked ?? entries[0])?.focus();

    const trigger = (): HTMLElement | null =>
      anchor.current?.querySelector<HTMLElement>(':scope > button') ?? null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        trigger()?.focus();
        return;
      }
      if (event.key === 'Tab') {
        close.current();
        return;
      }
      const walkable = items(element);
      const index = walkable.indexOf(document.activeElement as HTMLElement);
      const target =
        event.key === 'ArrowDown'
          ? walkable[(index + 1) % walkable.length]
          : event.key === 'ArrowUp'
            ? walkable[(index <= 0 ? walkable.length : index) - 1]
            : event.key === 'Home'
              ? walkable[0]
              : event.key === 'End'
                ? walkable[walkable.length - 1]
                : undefined;
      if (target === undefined) return;
      event.preventDefault();
      target.focus();
    };

    const onPointerDown = (event: MouseEvent): void => {
      if (anchor.current?.contains(event.target as Node) === true) return;
      close.current();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return { anchor, panel };
}
