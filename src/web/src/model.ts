import type {
  BoardColumn,
  Card,
  CardSession,
  EventFrame,
  IssueDetailResponse,
  PrefillResponse,
  PublicRunnerConfig,
} from '../../core/api.js';

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
