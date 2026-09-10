/**
 * The wire contract between the server and the SPA: every REST route, every
 * WebSocket frame and every ingress the generated session files post to.
 *
 * REST, with the statuses the server really answers:
 *
 * ```
 * GET    /api/config/public                              → 200 PublicConfigResponse
 * POST   /api/workspaces                                 → 201 WorkspaceSummary
 *                                                          400 ErrorResponse with issues
 *                                                          409 ErrorResponse on a duplicate id
 * DELETE /api/workspaces/:id                             → 204; 404 when no workspace has the id
 * GET    /api/workspaces/:id/board                       → 200 BoardView
 * POST   /api/workspaces/:id/refresh                     → 200 BoardView
 * GET    /api/workspaces/:id/issues/:key                 → 200 IssueDetailResponse
 * GET    /api/workspaces/:id/issues/:key/prefill?playbook= → 200 PrefillResponse
 *                                                          400 when `playbook` is absent
 * POST   /api/workspaces/:id/issues/:key/sessions        → 201 SessionRecord
 * POST   /api/workspaces/:id/issues/:key/flags           → 200 IssueFlags
 * GET    /api/workspaces/:id/issues/:key/checklist       → 200 ChecklistResponse
 * PUT    /api/workspaces/:id/issues/:key/checklist       → 200 ChecklistResponse
 *                                                          400 with issues for a label the
 *                                                          template does not have, or a
 *                                                          malformed body
 * POST   /api/workspaces/:id/issues/:key/open-editor     → 204; 409 without a checkout
 * POST   /api/sessions/:id/<SessionAction>               → 200 SessionRecord
 * POST   /api/sessions/:id/remove-worktree               → 200 RemoveWorktreeResponse
 * GET    /api/sessions/:id/events                        → 200 SessionEventsResponse
 *                                                          404 when no session has the id
 *                                                          409 when the log exists and cannot be read
 * POST   /api/hooks/:sessionId/:event                    → 204 (hook ingress)
 * POST   /api/hooks/:sessionId/statusline                → 204 (status-line ingress)
 * POST   /api/hooks/:sessionId/launcher/:event           → 204 (launcher ingress)
 * ```
 *
 * Every refusal is a 4xx carrying an `ErrorResponse` the UI shows verbatim,
 * including a tracker that cannot be reached. The three ingress routes answer
 * 404 for an unknown session id and 400 for a body that is not a JSON object.
 *
 * WebSocket: `/ws/events` pushes `EventFrame`;
 * `/ws/terminal/:sessionId?cols=<n>&rows=<n>` carries pty bytes as binary
 * frames, `TerminalClientFrame` up and `TerminalServerFrame` down. Both query
 * parameters are optional and name the viewer's initial pty size; a value that
 * is not an integer between 1 and 1000 falls back to the server's default
 * (`DEFAULT_COLS` / `DEFAULT_ROWS` in `server/terminal-ws.ts`).
 */
import type {
  ColumnId,
  Effort,
  Isolation,
  IssueFlags,
  Issue,
  ModelChoice,
  Pending,
  PermissionModeSetting,
  SessionCache,
  SessionRecord,
  SessionState,
  StatusCategory,
} from './types.js';

/**
 * States in which a session is blocked on the owner.
 *
 * Part of the wire contract: `CardSession.needsYou` is derived from this set,
 * and a client that filters records itself reads the set from here rather than
 * restating it. It lives in the contract module so the SPA never has to reach
 * into the reducer for it.
 */
export const NEEDS_YOU_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'waiting-permission',
  'waiting-question',
  'idle',
]);

/**
 * States in which a session still counts as running.
 *
 * Part of the wire contract: `CardSession.live` is derived from this set.
 */
export const LIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'bootstrapping',
  'starting',
  'working',
  'waiting-permission',
  'waiting-question',
  'idle',
]);

/**
 * A session record as the wire carries it.
 *
 * `lastEventAt` is the server's own bookkeeping for the staleness judgement
 * and is not part of the contract: `CardSession.staleSince` is the answer a
 * client renders, and nothing outside the server may derive that answer for
 * itself.
 */
export type WireSessionRecord = Omit<SessionRecord, 'lastEventAt'>;

/**
 * One reason a document was rejected, with the path that caused it.
 */
export interface ConfigIssue {
  /**
   * Dotted locator of the field that caused the problem, relative to whatever
   * was submitted: `workspaces.docs.epic` for a configuration file, `epic` or
   * `newConnector.id` for a `POST /api/workspaces` body.
   */
  path: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * Why a request was refused, as a closed set a UI can branch on.
 *
 * A refusal that no member describes carries no `reason` at all, so a consumer
 * must treat the field as optional and fall back to showing `error`/`detail`.
 */
export type ErrorReason =
  | 'dirty-worktree'
  | 'session-live'
  | 'main-checkout'
  | 'duplicate-id'
  | 'no-branch'
  | 'missing-executable'
  | 'detached-worktree';

/**
 * Body of every non-2xx JSON response.
 */
export interface ErrorResponse {
  /** Message shown to the owner verbatim. */
  error: string;
  /** Extra context, e.g. git's stderr or the command that failed. */
  detail?: string | undefined;
  /** Per-field validation problems, when the refusal came from a schema. */
  issues?: ConfigIssue[] | undefined;
  /**
   * Why the request was refused, for a UI that must branch on it. `error` and
   * `detail` stay the text shown verbatim; absent when no member of
   * `ErrorReason` describes the refusal.
   */
  reason?: ErrorReason | undefined;
}

/**
 * A workspace as the switcher lists it. One workspace is one board.
 */
export interface WorkspaceSummary {
  /** Workspace id, used in every workspace-scoped route. */
  id: string;
  /** Name shown in the switcher. */
  name: string;
  /** Key of the epic the board projects. */
  epic: string;
  /** Id of the repo the sessions are worked in. */
  repo: string;
  /** Id of the connector the issues are read through. */
  connector: string;
}

/**
 * A repo as the add-workspace dialog lists it.
 */
export interface RepoSummary {
  /** Repo id, referenced by a workspace's `repo`. */
  id: string;
  /** Absolute path of the main checkout. */
  path: string;
}

/**
 * A connector as the add-workspace dialog lists it. Credentials never leave
 * the server: only the site is reported.
 */
export interface ConnectorSummary {
  /** Connector id, referenced by a workspace's `connector`. */
  id: string;
  /** Issue-tracker site host. */
  site: string;
}

/**
 * The picker's defaults, as `GET /api/config/public` reports them.
 */
export interface RunnerDefaults {
  /** Model preselected when the playbook names none. */
  model: string;
  /** Effort preselected when the playbook names none. */
  effort: Effort;
  /** Permission mode preselected when the playbook names none. */
  permissionMode: PermissionModeSetting;
}

/**
 * Everything the pickers need, as `GET /api/config/public` reports it.
 */
export interface PublicRunnerConfig {
  /** Models offered by the picker. */
  models: ModelChoice[];
  /** Values preselected when a playbook has no opinion. */
  defaults: RunnerDefaults;
  /** Every effort level the CLI accepts, in picker order. */
  efforts: Effort[];
  /** Every permission mode the picker offers, including `'default'`. */
  permissionModes: PermissionModeSetting[];
}

/**
 * Response of `GET /api/config/public`.
 */
export interface PublicConfigResponse {
  /** Workspaces, in switcher order. */
  workspaces: WorkspaceSummary[];
  /** Repos a workspace can be pointed at, in configuration order. */
  repos: RepoSummary[];
  /** Connectors a workspace can read through, in configuration order. */
  connectors: ConnectorSummary[];
  /** Picker options and defaults. */
  runner: PublicRunnerConfig;
}

/**
 * A connector created inline from the add-workspace dialog.
 */
export interface NewConnectorRequest {
  /** Id the new connector gets in the configuration file. */
  id: string;
  /** Issue-tracker site host, e.g. `example.atlassian.net`. */
  site: string;
  /** Name of the environment variable holding the account email. */
  emailEnv: string;
  /** Name of the environment variable holding the API token. */
  tokenEnv: string;
}

/**
 * Body of `POST /api/workspaces`, which answers 201 with the new
 * `WorkspaceSummary`, 400 with the zod issues, or 409 when the id is taken.
 *
 * Exactly one of `connector` and `newConnector` must be present.
 */
export interface CreateWorkspaceRequest {
  /** Workspace id; derived from the name when absent. */
  id?: string | undefined;
  /** Name shown in the switcher. */
  name: string;
  /** Key of the epic the board projects. */
  epic: string;
  /** Id of an existing repo. */
  repo: string;
  /** Id of an existing connector. */
  connector?: string | undefined;
  /** A connector to create alongside the workspace. */
  newConnector?: NewConnectorRequest | undefined;
  /** Status names that land in the Review column; defaulted when absent. */
  reviewStatuses?: string[] | undefined;
  /** Raw query replacing the default epic-children one. */
  jql?: string | undefined;
}

/**
 * A playbook as the card menu and the start dialog list it.
 */
export interface PlaybookSummary {
  /** Playbook id. */
  id: string;
  /** Label shown on the button or menu entry. */
  label: string;
  /** One-sentence explanation. */
  description: string;
  /** How the session's checkout is isolated. */
  isolation: Isolation;
}

/**
 * The issue fields a card renders.
 */
export interface CardIssue {
  /** Tracker key, e.g. `DOC-3847`. */
  key: string;
  /** One-line title. */
  summary: string;
  /** Issue type name. */
  type: string;
  /** Status name as the tracker spells it. */
  status: string;
  /** Normalised status bucket. */
  statusCategory: StatusCategory;
  /** Label names, in tracker order. */
  labels: string[];
  /** Browser URL of the issue. */
  url: string;
}

/**
 * One session row on a card.
 */
export interface CardSession {
  /** Session id, which is also the tmux session name. */
  id: string;
  /** Id of the playbook that produced the prompt. */
  playbookId: string;
  /** Current lifecycle state. */
  state: SessionState;
  /** ISO timestamp of the last state change; the "time in state" ticks from it. */
  stateSince: string;
  /** What the session is waiting for, or null when it is not waiting. */
  pending: Pending | null;
  /**
   * Snippet of the session's last assistant message, or null when no `Stop`
   * payload carried one.
   */
  lastAssistantMessage: string | null;
  /**
   * Exit code of the process that most recently ended — the bootstrap or the
   * CLI — or null while one is running or none has ended. It is the only
   * reason a `failed` card can give for its state.
   */
  lastExitCode: number | null;
  /**
   * ISO timestamp of the server start that found this live session already
   * older than itself, or null when the state is current.
   *
   * The hooks that would have moved the record while the server was down are
   * gone, so the state may be out of date until the session's next event. A UI
   * should mark such a session rather than present its state as a fact.
   */
  staleSince: string | null;
  /**
   * What the session's last `Notification` said, or null when none is
   * outstanding.
   *
   * A notification lags the dialog it describes and cannot be placed in a turn,
   * so it never moves `state` and never sets `needsYou`. A UI may show it as
   * "this session may need you"; it must not present it as a fact, and the
   * next lifecycle event clears it.
   */
  hint: string | null;
  /** Prompt-cache state the countdown ticks from, or null when unknown. */
  cache: SessionCache | null;
  /** Owner-set "this session did its job" flag. */
  done: boolean;
  /** Whether the session still counts as running. */
  live: boolean;
  /** Whether the session is blocked on the owner. */
  needsYou: boolean;
  /** Branch the session works on, or null for isolation `shared`. */
  branch: string | null;
  /** Shell command that attaches a terminal to this session. */
  attachCommand: string;
}

/**
 * One issue on the board, with the sessions attached to it.
 */
export interface Card {
  /** The issue the card is about. */
  issue: CardIssue;
  /** Lane the card sits in. */
  column: ColumnId;
  /** Non-archived sessions for this issue, most relevant first. */
  sessions: CardSession[];
  /** Playbook the column's primary button starts, or null when there is none. */
  primaryPlaybookId: string | null;
  /** Absolute worktree path, or null when the issue has none to open. */
  worktreePath: string | null;
  /** Owner-set flags that can override the lane. */
  flags: IssueFlags;
  /** Whether any session on the card is blocked on the owner. */
  needsYou: boolean;
}

/**
 * One lane of the board.
 */
export interface BoardColumn {
  /** Lane id. */
  id: ColumnId;
  /** Lane heading. */
  name: string;
  /** Cards in display order. */
  cards: Card[];
  /** Number of cards, so the heading needs no length lookup. */
  count: number;
}

/**
 * The board as `GET /api/workspaces/:id/board` and
 * `POST /api/workspaces/:id/refresh` report it.
 */
export interface BoardView {
  /** Id of the workspace this board is the view of. */
  workspaceId: string;
  /** Playbooks offered on this board's cards. */
  playbooks: PlaybookSummary[];
  /** The five lanes, in display order. */
  columns: BoardColumn[];
  /** Message from the last failed source refresh, or null when the list is fresh. */
  sourceError: string | null;
  /** ISO timestamp of the last successful source refresh. */
  fetchedAt: string;
  /** Number of cards with a session blocked on the owner. */
  needsYouCount: number;
}

/**
 * Response of `GET /api/workspaces/:id/issues/:key`.
 */
export interface IssueDetailResponse {
  /** The issue, including its description. */
  issue: Issue;
  /** Every non-archived session for the issue, newest first. */
  sessions: WireSessionRecord[];
  /** Absolute worktree path, or null when the issue has none to open. */
  worktreePath: string | null;
  /** Owner-set flags for the issue. */
  flags: IssueFlags;
}

/**
 * Response of `GET /api/workspaces/:id/issues/:key/prefill?playbook=<id>`. The
 * `playbook` query parameter is required; without it the route answers 400.
 */
export interface PrefillResponse {
  /** Rendered prompt text, editable in the start dialog. */
  prompt: string;
  /** Model preselected in the dialog. */
  model: string;
  /** Effort preselected in the dialog. */
  effort: Effort;
  /** Permission mode preselected in the dialog. */
  permissionMode: PermissionModeSetting;
  /** Isolation the playbook will use. */
  isolation: Isolation;
  /** Non-blocking caveats, e.g. that the issue text may be stale. */
  warnings: string[];
}

/**
 * Body of `POST /api/workspaces/:id/issues/:key/sessions`, which answers 201
 * with the created `SessionRecord`.
 */
export interface CreateSessionRequest {
  /** Playbook to start. */
  playbookId: string;
  /** Final prompt text, after any edits in the dialog. */
  prompt: string;
  /** Model to pass to the CLI. */
  model: string;
  /** Effort to pass to the CLI. */
  effort: Effort;
  /** Permission mode, or `'default'` to pass no flag. */
  permissionMode: PermissionModeSetting;
}

/**
 * Body of `POST /api/workspaces/:id/issues/:key/flags`.
 */
export interface SetFlagsRequest {
  /** Force the issue into the Review column, or clear the flag. */
  review?: boolean | undefined;
  /** Force the issue into the Done column, or clear the flag. */
  done?: boolean | undefined;
}

/**
 * One line of an issue's private checklist.
 *
 * The label is the identity: a tick is stored under the item's own text, so
 * reordering the workspace's template keeps every tick, and rewording an item
 * drops the tick that belonged to the old wording.
 */
export interface ChecklistItem {
  /** Item text, exactly as the workspace's template spells it. */
  label: string;
  /** Whether the owner has ticked it. */
  done: boolean;
}

/**
 * Response of `GET` and `PUT /api/workspaces/:id/issues/:key/checklist`.
 */
export interface ChecklistResponse {
  /** Every item of the workspace's template, in template order; empty when it has none. */
  items: ChecklistItem[];
}

/**
 * Body of `PUT /api/workspaces/:id/issues/:key/checklist`.
 */
export interface SetChecklistRequest {
  /** Item to tick or untick; must be one the workspace's template names. */
  label: string;
  /** Whether the item is now ticked. */
  done: boolean;
}

/**
 * Body of `POST /api/sessions/:id/remove-worktree`.
 */
export interface RemoveWorktreeRequest {
  /** Whether to pass `--force`, discarding a dirty tree. */
  force?: boolean | undefined;
}

/**
 * Response of `POST /api/sessions/:id/remove-worktree`.
 */
export interface RemoveWorktreeResponse {
  /** Path that was removed; a refusal comes back as an `ErrorResponse` instead. */
  path: string;
}

/**
 * Path segment the status-line payload is posted to under `/api/hooks/:id/`.
 */
export const STATUSLINE_INGRESS = 'statusline';

/**
 * Path segment the launcher signals are posted under: the ingress is
 * `/api/hooks/:sessionId/launcher/:event`.
 */
export const LAUNCHER_INGRESS = 'launcher';

/**
 * Launcher signals the generated launcher script posts around the CLI process.
 */
export const LAUNCHER_EVENT_NAMES = [
  'bootstrap-start',
  'bootstrap-failed',
  'claude-start',
  'claude-exit',
] as const;

/**
 * One launcher signal name.
 */
export type LauncherEventName = (typeof LAUNCHER_EVENT_NAMES)[number];

/**
 * Body of the `claude-start` launcher signal.
 */
export interface LauncherStartBody {
  /** `resume` when the run continues a transcript; absent on a fresh start. */
  mode?: 'resume' | undefined;
}

/**
 * Body of the `claude-exit` and `bootstrap-failed` launcher signals.
 */
export interface LauncherExitBody {
  /** Exit code of the process that ended, when the launcher observed one. */
  exitCode?: number | undefined;
  /** Failure text, when the launcher has one to report. */
  message?: string | undefined;
}

/**
 * Session-scoped POST actions that take no body and answer with the updated
 * `SessionRecord`.
 */
export type SessionAction =
  'resume' | 'interrupt' | 'kill' | 'mark-done' | 'unmark-done' | 'archive';

/**
 * One line of a session's raw event log.
 */
export interface SessionEventLogEntry {
  /** ISO timestamp at which the event was accepted. */
  at: string;
  /** The raw payload, exactly as it arrived. */
  event: unknown;
  /** State the record was in after the event. */
  state: SessionState;
}

/**
 * Response of `GET /api/sessions/:id/events`.
 */
export interface SessionEventsResponse {
  /** Accepted events, oldest first. */
  events: SessionEventLogEntry[];
}

/**
 * Frames the server pushes on `WS /ws/events`.
 */
export type EventFrame =
  | {
      /** A board's projection changed. */
      type: 'board';
      /** Workspace whose board the view belongs to. */
      workspaceId: string;
      /** The whole recomputed view. */
      view: BoardView;
    }
  | {
      /** One session record changed. */
      type: 'session';
      /** The record after the change. */
      record: WireSessionRecord;
    }
  | {
      /** A workspace was added or removed. */
      type: 'config';
      /** The public configuration after the change. */
      config: PublicConfigResponse;
    };

/**
 * Text frames a viewer sends on `WS /ws/terminal/:sessionId`. Binary frames on
 * the same socket carry raw pty bytes and have no JSON shape.
 */
export type TerminalClientFrame = {
  /** Resize the pty to the viewer's terminal size. */
  type: 'resize';
  /** New column count. */
  cols: number;
  /** New row count. */
  rows: number;
};

/**
 * Text frames the server sends on `WS /ws/terminal/:sessionId`. Binary frames
 * on the same socket carry raw pty bytes and have no JSON shape.
 */
export type TerminalServerFrame =
  | {
      /** The pty could not be spawned or attached; the socket closes next. */
      type: 'error';
      /** Message shown to the owner verbatim. */
      message: string;
    }
  | {
      /** The pty ended, e.g. because tmux killed the session. */
      type: 'exit';
      /** Exit code of the pty. */
      exitCode: number;
    };
