/**
 * Picks the control focus should return to when a modal surface closes.
 *
 * The control that opened the surface is the right answer, but it does not
 * always survive: an overlay opened from a menu item unmounts the menu with
 * itself, and focusing a detached node silently drops focus to the document. In
 * that case the walk climbs to the nearest ancestor that is still in the
 * document — for a menu, the element holding both the panel and its trigger —
 * and takes the first control inside it, which is the trigger.
 *
 * @param chain - The element focused when the surface opened, followed by its
 * ancestors, outermost last.
 * @param isConnected - Whether a node is still in the document.
 * @param focusableIn - First control inside a node that can take focus, or null
 * when it holds none.
 * @returns The node to focus, or null when nothing in the chain survived.
 */
export function restoreFocusTarget<T>(
  chain: readonly T[],
  isConnected: (node: T) => boolean,
  focusableIn: (node: T) => T | null,
): T | null {
  const opener = chain[0];
  if (opener !== undefined && isConnected(opener)) return opener;
  for (const ancestor of chain.slice(1)) {
    if (!isConnected(ancestor)) continue;
    const target = focusableIn(ancestor);
    if (target !== null) return target;
  }
  return null;
}
