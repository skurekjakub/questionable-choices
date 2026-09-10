import { useEffect, useRef, type RefObject } from 'react';
import { restoreFocusTarget } from '../focus-restore.js';

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
 * Lists an element and its ancestors, so a restore can fall back up the tree.
 *
 * `document.body` is left out: focusing it is what the fallback exists to
 * avoid.
 *
 * @param element - Element to start from.
 * @returns The element, then each ancestor below `<body>`.
 */
function ancestry(element: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = element;
  while (node !== null && node !== document.body) {
    chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

/**
 * Makes a modal surface behave like one: focus moves into it on mount, Tab
 * cycles inside it, Escape dismisses it, and the previously focused element
 * gets focus back when it unmounts — or, when that element did not survive the
 * open, the nearest surviving control above it.
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
    const opener = document.activeElement;
    const restoreChain = opener instanceof HTMLElement ? ancestry(opener) : [];
    const items = focusable(element);
    (items[0] ?? element).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // An open menu inside the surface owns Escape: it closes the menu and
        // the surface stays. Deferring has to happen here, because the menu's
        // own handler is on `document` too and this one captures, so it runs
        // first and one press would otherwise close both.
        const target = event.target;
        if (target instanceof Element && target.closest('[role="menu"]') !== null) return;
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
      const target = restoreFocusTarget(
        restoreChain,
        (node) => node.isConnected,
        (node) => focusable(node)[0] ?? null,
      );
      target?.focus();
    };
  }, []);

  return container;
}
