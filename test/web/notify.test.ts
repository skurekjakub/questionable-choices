// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBadge,
  needsYouEntries,
  notificationPermission,
  notifyNeedsYou,
  requestNotificationPermission,
} from '../../src/web/src/notify.js';
import { boardView, card, cardSession } from './fixtures.js';
import './jsdom-gaps.js';

/**
 * A stand-in for the browser's `Notification`, recording what was posted.
 */
class FakeNotification {
  /** Every notification posted since the last reset, in order. */
  static readonly posted: FakeNotification[] = [];
  /** Permission the constructor and `permission` report. */
  static permission: NotificationPermission = 'granted';
  /** What `requestPermission` resolves, or rejects with when it is an Error. */
  static requested: NotificationPermission | Error = 'granted';
  /** Thrown by the constructor when set, standing in for a gated build. */
  static refuse: Error | null = null;
  /** Title the notification was posted with. */
  readonly title: string;
  /** Options the notification was posted with. */
  readonly options: NotificationOptions;
  /** Called when the owner activates the notification. */
  onclick: (() => void) | null = null;
  /** Whether `close()` has been called. */
  closed = false;

  /**
   * Records the post.
   *
   * @param title - Title of the notification.
   * @param options - Body and tag.
   */
  constructor(title: string, options: NotificationOptions = {}) {
    if (FakeNotification.refuse !== null) throw FakeNotification.refuse;
    this.title = title;
    this.options = options;
    FakeNotification.posted.push(this);
  }

  /**
   * Asks the browser for permission to post notifications.
   *
   * @returns The permission the test set.
   */
  static requestPermission(): Promise<NotificationPermission> {
    return FakeNotification.requested instanceof Error
      ? Promise.reject(FakeNotification.requested)
      : Promise.resolve(FakeNotification.requested);
  }

  /**
   * Dismisses the notification.
   *
   * @returns Nothing.
   */
  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeNotification.posted.length = 0;
  FakeNotification.permission = 'granted';
  FakeNotification.requested = 'granted';
  FakeNotification.refuse = null;
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('needsYouEntries', () => {
  it('lists a session the board says is blocked on the owner', () => {
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'waiting-permission',
          needsYou: true,
          pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
        }),
      ]),
    ]);
    expect([...needsYouEntries(board).values()]).toEqual([
      {
        sessionId: 'qc-DOC-1-implement',
        issueKey: 'DOC-1',
        state: 'waiting-permission',
        body: 'Bash: rm -rf .next/cache',
      },
    ]);
  });

  it('skips a session flagged needs-you in a state that is not one', () => {
    // The two are computed apart on the server, and a `working` session that
    // still carries the flag would otherwise notify with the word "working".
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'working', needsYou: true })]),
    ]);
    expect(needsYouEntries(board).size).toBe(0);
  });

  it('skips a session in a needs-you state the board has not flagged', () => {
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'idle', needsYou: false })]),
    ]);
    expect(needsYouEntries(board).size).toBe(0);
  });

  it('falls back to the last assistant message for an idle turn, which has no pending', () => {
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'idle',
          needsYou: true,
          lastAssistantMessage: 'Done. verify is green.',
        }),
      ]),
    ]);
    expect(needsYouEntries(board).get('qc-DOC-1-implement')?.body).toBe('Done. verify is green.');
  });

  it('prefers the pending summary over the last assistant message', () => {
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', {
          state: 'waiting-question',
          needsYou: true,
          pending: { kind: 'question', summary: 'Which branch?' },
          lastAssistantMessage: 'Some earlier turn.',
        }),
      ]),
    ]);
    expect(needsYouEntries(board).get('qc-DOC-1-implement')?.body).toBe('Which branch?');
  });

  it('leaves the body empty when the session offers neither', () => {
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement', { state: 'idle', needsYou: true })]),
    ]);
    expect(needsYouEntries(board).get('qc-DOC-1-implement')?.body).toBe('');
  });

  it('keys the map by session id, so two sessions on one card both appear', () => {
    const board = boardView('docs', [
      card('DOC-1', [
        cardSession('qc-DOC-1-implement', { state: 'idle', needsYou: true }),
        cardSession('qc-DOC-1-verify', { state: 'waiting-question', needsYou: true }),
      ]),
    ]);
    expect([...needsYouEntries(board).keys()]).toEqual(['qc-DOC-1-implement', 'qc-DOC-1-verify']);
  });

  it('reads nothing off a board with no cards', () => {
    expect(needsYouEntries(boardView('docs')).size).toBe(0);
  });
});

describe('applyBadge', () => {
  it('puts the count in front of the title and takes it away again', () => {
    applyBadge(3);
    expect(document.title).toBe('(3) questionable choices');
    applyBadge(0);
    expect(document.title).toBe('questionable choices');
  });

  it('keeps the dashboard up when the host refuses the title write', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    Object.defineProperty(document, 'title', {
      configurable: true,
      get: () => 'sealed',
      set: () => {
        throw new Error('title is not settable');
      },
    });
    try {
      expect(() => applyBadge(2)).not.toThrow();
      // The write is the only thing that failed; nothing else may be skipped
      // over it, and the sealed title must still read what the host set.
      expect(document.title).toBe('sealed');
      expect(document.querySelector('link[rel="icon"]')).toBeNull();
    } finally {
      delete (document as unknown as Record<string, unknown>)['title'];
      if (original !== undefined) Object.defineProperty(Document.prototype, 'title', original);
    }
  });

  it('keeps the dashboard up when the icon cannot be painted', () => {
    // `getContext` answers null here, so this is the "browser cannot draw the
    // face" path: the title still updates and no icon link is added.
    applyBadge(1);
    expect(document.title).toBe('(1) questionable choices');
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
  });
});

describe('notificationPermission', () => {
  it('reports what the browser says', () => {
    FakeNotification.permission = 'denied';
    expect(notificationPermission()).toBe('denied');
  });

  it('reports a browser without the API as unsupported rather than denied', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('Notification', undefined);
    // `'Notification' in window` is what separates the two, and a stubbed
    // `undefined` still leaves the key present, so it is removed outright.
    delete (window as unknown as Record<string, unknown>)['Notification'];
    expect(notificationPermission()).toBe('unsupported');
  });
});

describe('requestNotificationPermission', () => {
  it('answers with the permission the prompt returned', async () => {
    FakeNotification.requested = 'granted';
    await expect(requestNotificationPermission()).resolves.toBe('granted');
  });

  it('answers denied when the browser exposes the API but refuses to prompt', async () => {
    FakeNotification.requested = new Error('permission prompt blocked by policy');
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });

  it('answers unsupported without prompting when there is no API', async () => {
    delete (window as unknown as Record<string, unknown>)['Notification'];
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });
});

describe('notifyNeedsYou', () => {
  /**
   * One entry, as `needsYouEntries` would have built it.
   */
  const entry = {
    sessionId: 'qc-DOC-1-implement',
    issueKey: 'DOC-1',
    state: 'waiting-permission',
    body: 'Bash: rm -rf .next/cache',
  } as const;

  it('titles the notification with the key and the state, and bodies it with the pending', () => {
    notifyNeedsYou(entry, () => {});
    expect(FakeNotification.posted[0]?.title).toBe('DOC-1 · needs permission');
    expect(FakeNotification.posted[0]?.options.body).toBe('Bash: rm -rf .next/cache');
    expect(FakeNotification.posted[0]?.options.tag).toBe('qc-DOC-1-implement');
  });

  it('bodies an entry with nothing to say with the state word rather than nothing', () => {
    notifyNeedsYou({ ...entry, body: '' }, () => {});
    expect(FakeNotification.posted[0]?.options.body).toBe('needs permission');
  });

  it('posts nothing when permission was never granted', () => {
    FakeNotification.permission = 'default';
    notifyNeedsYou(entry, () => {});
    FakeNotification.permission = 'denied';
    notifyNeedsYou(entry, () => {});
    expect(FakeNotification.posted).toHaveLength(0);
  });

  it('opens the session and dismisses itself when the owner activates it', () => {
    const opened: string[] = [];
    notifyNeedsYou(entry, (sessionId) => opened.push(sessionId));
    const posted = FakeNotification.posted[0];
    posted?.onclick?.();
    expect(opened).toEqual(['qc-DOC-1-implement']);
    expect(posted?.closed).toBe(true);
  });

  it('keeps the board up when the constructor throws, as gated builds do', () => {
    FakeNotification.refuse = new Error('notifications are disabled');
    expect(() => notifyNeedsYou(entry, () => {})).not.toThrow();
    // Nothing reached the browser, so nothing may be recorded as if it had.
    expect(FakeNotification.posted).toHaveLength(0);
  });
});
