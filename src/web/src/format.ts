/**
 * Formats how long a session has been in its current state.
 *
 * @param since - ISO timestamp of the last state change.
 * @param nowMs - Current time in epoch milliseconds.
 * @returns A compact duration such as `12s`, `4m`, `2h 06m` or `3d`.
 */
export function timeInState(since: string, nowMs: number): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Formats how long ago the board was last synced with its issue source.
 *
 * @param at - ISO timestamp of the last successful refresh.
 * @param nowMs - Current time in epoch milliseconds.
 * @returns A phrase such as `synced 12s ago`, or `never synced` when unparsable.
 */
export function syncedAgo(at: string, nowMs: number): string {
  const stamp = Date.parse(at);
  if (Number.isNaN(stamp)) return 'never synced';
  return `synced ${timeInState(at, nowMs)} ago`;
}

/**
 * Picks a one-character glyph for an issue type.
 *
 * @param type - Issue type name as the tracker spells it.
 * @returns A glyph standing in for the type.
 */
export function typeGlyph(type: string): string {
  const name = type.toLowerCase();
  if (name.includes('bug') || name.includes('defect')) return '▲';
  if (name.includes('epic')) return '⬢';
  if (name.includes('sub')) return '◦';
  if (name.includes('story')) return '◆';
  return '■';
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea where the
 * async clipboard API is unavailable.
 *
 * @param text - Text to place on the clipboard.
 * @returns True when the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  }
}
