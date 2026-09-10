import type { BoardView } from '../../core/api.js';
import { NEEDS_YOU_STATES, STATE_LABELS, type SessionState } from './model.js';

/**
 * Title shown when nothing is waiting for the owner.
 */
const BASE_TITLE = 'questionable choices';

/**
 * Paints the favicon: an instrument face, with an amber lamp when something is
 * waiting for the owner.
 *
 * @param needsYou - Number of cards blocked on the owner.
 * @returns A data URL for the icon, or null when canvas is unavailable.
 */
function paintFavicon(needsYou: number): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.fillStyle = '#182228';
    ctx.beginPath();
    // roundRect landed in Safari 16.4 and Firefox 112; an older browser throws
    // here, and a decorative icon must not take the dashboard down with it.
    ctx.roundRect(1, 1, 30, 30, 7);
    ctx.fill();
    ctx.strokeStyle = '#2b3a42';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#93a1a6';
    for (const [index, width] of [16, 11, 7].entries()) {
      ctx.fillRect(7, 9 + index * 6, width, 2);
    }
    if (needsYou > 0) {
      ctx.fillStyle = '#f0a52e';
      ctx.beginPath();
      ctx.arc(24, 24, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Mirrors the needs-you count into the document title and the favicon.
 *
 * @param needsYou - Number of cards blocked on the owner.
 * @returns Nothing.
 */
export function applyBadge(needsYou: number): void {
  try {
    document.title = needsYou > 0 ? `(${needsYou}) ${BASE_TITLE}` : BASE_TITLE;
  } catch {
    // This runs from a render effect, so a host that refuses the write — an
    // embedder that seals `document`, an extension that redefines the property
    // — would otherwise take the whole dashboard down through the boundary.
  }
  const href = paintFavicon(needsYou);
  // Painting is best-effort; a browser that cannot draw the face keeps the icon
  // it already has rather than losing the title update above.
  if (href === null) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Whether the browser exposes the Notifications API at all.
 *
 * @returns True when notifications can be requested and shown.
 */
function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Current notification permission, or `'unsupported'`.
 *
 * @returns The permission state as the browser reports it.
 */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/**
 * Asks the owner for permission to post notifications.
 *
 * @returns The permission after the prompt, `'denied'` when the browser refuses
 * to prompt, or `'unsupported'`.
 */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    // A context that exposes the API but refuses to prompt — private windows,
    // policy-blocked embeds — rejects rather than resolving `'denied'`.
    return 'denied';
  }
}

/**
 * One session that has just become blocked on the owner.
 */
export interface NeedsYouEntry {
  /** Id of the session. */
  sessionId: string;
  /** Tracker key of the issue it works on. */
  issueKey: string;
  /** State it entered. */
  state: SessionState;
  /** Pending summary, or the last assistant snippet, or an empty string. */
  body: string;
}

/**
 * Lists the sessions on a board that are blocked on the owner.
 *
 * @param board - Board view to read.
 * @returns One entry per waiting session, keyed by session id.
 */
export function needsYouEntries(board: BoardView): Map<string, NeedsYouEntry> {
  const entries = new Map<string, NeedsYouEntry>();
  for (const column of board.columns) {
    for (const card of column.cards) {
      for (const session of card.sessions) {
        if (!session.needsYou) continue;
        if (!NEEDS_YOU_STATES.has(session.state)) continue;
        entries.set(session.id, {
          sessionId: session.id,
          issueKey: card.issue.key,
          state: session.state,
          // An idle session has no pending by definition, so without the
          // snippet the most common needs-you state would notify with no body.
          body: session.pending?.summary ?? session.lastAssistantMessage ?? '',
        });
      }
    }
  }
  return entries;
}

/**
 * Posts one notification for a session that has just started waiting.
 *
 * @param entry - The session that entered the needs-you set.
 * @param onOpen - Called when the owner activates the notification.
 * @returns Nothing.
 */
export function notifyNeedsYou(entry: NeedsYouEntry, onOpen: (sessionId: string) => void): void {
  if (notificationPermission() !== 'granted') return;
  const label = STATE_LABELS[entry.state];
  let notification: Notification;
  try {
    notification = new Notification(`${entry.issueKey} · ${label}`, {
      body: entry.body.length > 0 ? entry.body : label,
      tag: entry.sessionId,
    });
  } catch {
    // Chrome on Android and some gated builds expose the constructor but throw
    // from it; a missed notification must not unmount the board behind it.
    return;
  }
  notification.onclick = () => {
    window.focus();
    onOpen(entry.sessionId);
    notification.close();
  };
}
