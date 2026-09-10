/**
 * Event fired after a programmatic navigation, so the router re-reads the path.
 *
 * `history.pushState` fires no event of its own, so anything that follows the
 * pathname has to be told. `popstate` covers the back and forward buttons; this
 * covers everything the app does itself.
 */
export const NAVIGATE_EVENT = 'qc:navigate';

/**
 * Navigates to a path without a full page load.
 *
 * @param to - Path to navigate to, starting with a slash.
 * @returns Nothing.
 */
export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
