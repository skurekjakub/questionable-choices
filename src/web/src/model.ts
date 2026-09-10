import type {
  BoardColumn,
  Card,
  CardSession,
  EventFrame,
  IssueDetailResponse,
  PrefillResponse,
  PublicRunnerConfig,
} from '../../core/api.js';
import { describeCache } from '../../core/cache-clock.js';

/**
 * A persisted session as the API reports it.
 */
export type SessionRecord = IssueDetailResponse['sessions'][number];

/**
 * An issue with its description, as the issue-detail route reports it.
 */
export type Issue = IssueDetailResponse['issue'];

/**
 * One session lifecycle state.
 */
export type SessionState = CardSession['state'];

/**
 * Prompt-cache state of one session.
 */
export type SessionCache = NonNullable<CardSession['cache']>;

/**
 * What a session is waiting for while it is blocked on the owner.
 */
export type Pending = NonNullable<CardSession['pending']>;

/**
 * Owner-set per-issue flags.
 */
export type IssueFlags = Card['flags'];

/**
 * One board lane id.
 */
export type ColumnId = BoardColumn['id'];

/**
 * A reasoning-effort level the CLI accepts.
 */
export type Effort = PrefillResponse['effort'];

/**
 * A permission mode, or the sentinel meaning "pass no flag".
 */
export type PermissionModeSetting = PrefillResponse['permissionMode'];

/**
 * A model offered by the start dialog's picker.
 */
export type ModelChoice = PublicRunnerConfig['models'][number];

/**
 * A board frame pushed on the events socket.
 */
export type BoardFrame = Extract<EventFrame, { type: 'board' }>;

/**
 * A session frame pushed on the events socket.
 */
export type SessionFrame = Extract<EventFrame, { type: 'session' }>;

// Re-exported rather than restated: a state added to the machine and forgotten
// here would silently change which sessions the web calls live.
export { LIVE_STATES, NEEDS_YOU_STATES } from '../../core/api.js';

/**
 * What an overlay says when the board behind it has stopped listing the issue
 * it was opened on, in the one place both overlays that can outlive a card
 * read it from.
 */
export const DROPPED_SENTENCE =
  'This issue has left the board — the epic’s query no longer returns it. What is shown is the card as it was opened.';

/**
 * Word shown next to the state of a session the dashboard is compacting.
 */
export const COMPACTING_LABEL = 'compacting';

/**
 * Reports whether a session can be compacted right now.
 *
 * A compaction is typed into the prompt, so it needs a session sitting at one;
 * and it costs a full re-read of the context, so it is only worth offering once
 * the prompt cache has gone cold and that re-read is going to happen anyway.
 *
 * @param session - State, cache and compaction flag of the session.
 * @param nowMs - Current time in epoch milliseconds; the cache is a countdown.
 * @returns True when the Compact action should be offered.
 */
export function compactable(
  session: { state: SessionState; cache: SessionCache | null; compacting: boolean },
  nowMs: number,
): boolean {
  if (session.state !== 'idle' || session.compacting) return false;
  return describeCache(session.cache, nowMs).state === 'cold';
}

/**
 * Words shown next to a session's state lamp.
 */
export const STATE_LABELS: Readonly<Record<SessionState, string>> = {
  bootstrapping: 'bootstrapping',
  starting: 'starting',
  working: 'working',
  'waiting-permission': 'needs permission',
  'waiting-question': 'has a question',
  idle: 'your turn',
  exited: 'exited',
  failed: 'failed',
};
