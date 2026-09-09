import { useEffect, useRef, type RefObject } from 'react';

/**
 * Selector matching the controls a dialog can move focus between.
 */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Lists the controls inside a container that can currently take focus.
 *
 * @param container - Element to search.
 * @returns The focusable controls in document order.
 */
function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0,
  );
}

/**
 * Makes a modal surface behave like one: focus moves into it on mount, Tab
 * cycles inside it, Escape dismisses it, and the previously focused element
 * gets focus back when it unmounts.
 *
 * The container needs `tabIndex={-1}` so focus has somewhere to land when the
 * surface has no controls of its own yet.
 *
 * @param onEscape - Called when the owner presses Escape.
 * @returns A ref to attach to the element holding the modal surface.
 */
export function useFocusTrap<T extends HTMLElement>(onEscape: () => void): RefObject<T | null> {
  const container = useRef<T | null>(null);
  const escape = useRef(onEscape);

  useEffect(() => {
    escape.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const restoreTo = document.activeElement;
    const items = focusable(element);
    (items[0] ?? element).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable(element);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        element.focus();
        return;
      }
      const active = document.activeElement;
      if (active === null || !element.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (restoreTo instanceof HTMLElement) restoreTo.focus();
    };
  }, []);

  return container;
}
