/**
 * Reasoning-effort levels the `claude` CLI accepts on `--effort`.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * One reasoning-effort level.
 */
export type Effort = (typeof EFFORTS)[number];

/**
 * Permission-mode choices offered by the picker: every mode the `claude` CLI
 * accepts on `--permission-mode`, plus the sentinel `'default'` that means
 * "pass no `--permission-mode` flag at all".
 */
export const PERMISSION_MODE_SETTINGS = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
  'default',
] as const;

/**
 * A permission mode or the sentinel `'default'` meaning "pass no flag".
 */
export type PermissionModeSetting = (typeof PERMISSION_MODE_SETTINGS)[number];

/**
 * Coarse issue-status buckets, normalised across issue sources.
 */
export type StatusCategory = 'todo' | 'inprogress' | 'done';

/**
 * One issue from an issue source, normalised to the fields the board needs.
 */
export interface Issue {
  /** Tracker key, e.g. `DOC-3847`. Unique within a board. */
  key: string;
  /** One-line title. */
  summary: string;
  /** Issue type name as the tracker spells it, e.g. `Bug`. */
  type: string;
  /** Status name as the tracker spells it, e.g. `Ready for review`. */
  status: string;
  /** Normalised status bucket. */
  statusCategory: StatusCategory;
  /** Label names, in tracker order. */
  labels: string[];
  /** Browser URL of the issue. */
  url: string;
  /** Description as plain text; absent when the source did not fetch it. */
  description?: string | undefined;
  /** Display name of the assignee, when the issue has one. */
  assignee?: string | undefined;
  /** Priority name, when the tracker reports one. */
  priority?: string | undefined;
  /** ISO timestamp of the last tracker-side update. */
  updated?: string | undefined;
}

/**
 * Board lanes, in display order.
 */
export const COLUMN_IDS = ['backlog', 'working', 'needs-you', 'review', 'done'] as const;

/**
 * One board lane id.
 */
export type ColumnId = (typeof COLUMN_IDS)[number];

/**
 * Human-readable lane names, keyed by lane id.
 */
export const COLUMN_NAMES: Readonly<Record<ColumnId, string>> = {
  backlog: 'Backlog',
  working: 'Working',
  'needs-you': 'Needs you',
  review: 'Review',
  done: 'Done',
};

/**
 * How a playbook isolates its session from the main checkout.
 *
 * `worktree` creates a fresh worktree and branch, `issue-worktree` reuses or
 * recreates the worktree of the issue's existing branch, `shared` runs in the
 * main checkout with no branch of its own.
 */
export type Isolation = 'worktree' | 'issue-worktree' | 'shared';

/**
 * Session lifecycle states, as tracked from launcher signals and hook events.
 */
export const SESSION_STATES = [
  'bootstrapping',
  'starting',
  'working',
  'waiting-permission',
  'waiting-question',
  'idle',
  'exited',
  'failed',
] as const;

/**
 * One session lifecycle state.
 */
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * What a session is blocked on while it waits for the owner.
 */
export type PendingKind = 'permission' | 'question';

/**
 * The thing on screen that the session is waiting for the owner to answer.
 */
export interface Pending {
  /** Whether a permission dialog or a question is on screen. */
  kind: PendingKind;
  /** One-line description of the prompt, for the card and the notification. */
  summary: string;
}

/**
 * What the most recent `Notification` said about a session.
 *
 * A notification lags the dialog it describes by seconds and carries only a
 * generic message, so it is kept as a hint the owner may act on rather than as
 * a state anything derives from.
 */
export interface SessionHint {
  /** The notification's message as one line, or a generic stand-in. */
  summary: string;
  /** ISO timestamp at which the notification was accepted. */
  at: string;
}

/**
 * Where a session's prompt-cache figures came from.
 *
 * `statusline` means a real status-line payload; `derived` means the value was
 * computed from the end of a turn because no payload had arrived yet.
 */
export type CacheSource = 'statusline' | 'derived';

/**
 * Prompt-cache state of one session.
 */
export interface SessionCache {
  /** Epoch **seconds** at which the cached prefix goes cold; null when unknown. */
  expiresAt: number | null;
  /** Cache TTL in seconds (3600 for a 1h cache, 300 for a 5m one, 0 when unknown). */
  ttlSeconds: number;
  /** Whether the source reported the cache as warm. */
  warm: boolean;
  /** Provenance of the figures. */
  source: CacheSource;
}

/**
 * One launch of the `claude` process inside a session's tmux window.
 */
export interface SessionRun {
  /** ISO timestamp of the launch. */
  startedAt: string;
  /** Whether this run was a fresh prompt or a `--resume`. */
  kind: 'start' | 'resume';
  /**
   * Process exit code, or null when the run is still going or was killed.
   * Killing a session takes the whole tmux shell down, so the launcher never
   * reports a code: only a run that ended on its own has one.
   */
  exitCode: number | null;
}

/**
 * The persistent record of one session: one tmux session running one `claude`
 * process for one issue and one playbook.
 */
export interface SessionRecord {
  /** tmux session name, e.g. `qc-DOC-3847-implement`. Unique across the app. */
  id: string;
  /** Key of the issue the session works on. */
  issueKey: string;
  /** Id of the playbook that produced the prompt. */
  playbookId: string;
  /** Id of the repo the checkout was made in; sessions belong to a repo, not a workspace. */
  repoId: string;
  /** Absolute working directory of the tmux session. */
  cwd: string;
  /** Branch the session works on; null for isolation `shared`. */
  branch: string | null;
  /** Model id passed to the CLI. */
  model: string;
  /** Reasoning effort passed to the CLI. */
  effort: Effort;
  /** Permission mode passed to the CLI, or `'default'` when no flag was passed. */
  permissionMode: PermissionModeSetting;
  /** The prompt text exactly as it was sent. */
  prompt: string;
  /** Claude Code's own session id, learned from the SessionStart hook. */
  claudeSessionId: string | null;
  /** Current lifecycle state. */
  state: SessionState;
  /** ISO timestamp of the last state change. */
  stateSince: string;
  /** What the session is waiting for, or null when it is not waiting. */
  pending: Pending | null;
  /**
   * What the last `Notification` said, or null when none is outstanding.
   *
   * A notification never moves `state`: it lags the dialog it describes and
   * carries no way of placing itself in a turn, so acting on it produces a
   * needs-you state that no later event is guaranteed to clear. Every accepted
   * lifecycle event other than a status-line payload clears the hint.
   */
  hint: SessionHint | null;
  /** Snippet of the last assistant message, when the Stop payload carried one. */
  lastAssistantMessage: string | null;
  /**
   * Exit code of the process that most recently ended — the bootstrap or the
   * CLI — or null while one is running or none has ended.
   */
  lastExitCode: number | null;
  /**
   * ISO timestamp of the server start that found this live record already
   * older than itself, or null when the state is current.
   *
   * A record whose hooks were posted while the server was down cannot be
   * recovered — the events are gone — so the state is flagged as possibly
   * out of date rather than guessed at. The next accepted event clears it.
   */
  staleSince: string | null;
  /**
   * ISO timestamp of the last accepted event that carried lifecycle
   * information, or null before any. A status-line payload never stamps it: it
   * says nothing about the state, so it must not pass for having heard from the
   * session.
   */
  lastEventAt: string | null;
  /** Prompt-cache state, or null before anything reported one. */
  cache: SessionCache | null;
  /** ISO timestamp of record creation. */
  createdAt: string;
  /** ISO timestamp at which the process ended, or null while it runs. */
  endedAt: string | null;
  /** Owner-set "this session did its job" flag. */
  done: boolean;
  /** Whether the record is hidden from the card. */
  archived: boolean;
  /** One entry per launch, oldest first. */
  runs: SessionRun[];
}

/**
 * Owner-set per-issue flags that override the projection's column choice.
 */
export interface IssueFlags {
  /** Force the issue into the Review column. */
  review?: boolean | undefined;
  /** Force the issue into the Done column. */
  done?: boolean | undefined;
}

/**
 * A model offered by the start dialog's picker.
 */
export interface ModelChoice {
  /** Value passed to `claude --model`. */
  id: string;
  /** Label shown in the picker. */
  label: string;
}

/**
 * Runner configuration: which CLI to launch and what the pickers default to.
 */
export interface RunnerConfig {
  /** Runner connector to build. */
  type: 'claude-tmux';
  /** Executable name or path of the Claude CLI. */
  claudeBin: string;
  /** Prefix of generated tmux session names (`<prefix>-<KEY>-<playbook>`). */
  tmuxPrefix: string;
  /** Models offered by the picker. */
  models: ModelChoice[];
  /** Model preselected when the playbook names none. */
  defaultModel: string;
  /** Effort preselected when the playbook names none. */
  defaultEffort: Effort;
  /** Permission mode preselected when the playbook names none. */
  defaultPermissionMode: PermissionModeSetting;
}

/**
 * Per-playbook overrides of the runner defaults.
 */
export interface PlaybookDefaults {
  /** Model preselected for this playbook. */
  model?: string | undefined;
  /** Effort preselected for this playbook. */
  effort?: Effort | undefined;
  /** Permission mode preselected for this playbook. */
  permissionMode?: PermissionModeSetting | undefined;
}

/**
 * A named kickoff recipe on a repo.
 */
export interface Playbook {
  /** Id, unique within its repo. */
  id: string;
  /** Label shown on buttons and menus. */
  label: string;
  /** One-sentence explanation shown in the start dialog. */
  description: string;
  /** How the session's checkout is isolated. */
  isolation: Isolation;
  /** Columns whose cards offer this playbook as their primary action. */
  primaryFor: ColumnId[];
  /** Overrides of the runner defaults, when the playbook has opinions. */
  defaults?: PlaybookDefaults | undefined;
  /** Prompt template rendered with the variables listed by `promptVariables`. */
  promptTemplate: string;
}

/**
 * A git repository plus its worktree policy, bootstrap command and playbooks.
 * Several workspaces may name the same repo.
 */
export interface RepoConfig {
  /** Absolute path of the main checkout. */
  path: string;
  /** Absolute directory that holds generated worktrees. */
  worktreeDir: string;
  /** Ref new worktrees branch from, e.g. `origin/main`. */
  baseRef: string;
  /** Branch-name template, rendered with `{{key}}` and `{{slug}}`. */
  branchPattern: string;
  /** Shell command run in the tmux session after a new worktree is created. */
  bootstrap?: string | undefined;
  /** Playbooks offered on the cards of every workspace that names this repo. */
  playbooks: Playbook[];
}

/**
 * An issue-tracker account on a Jira Cloud site.
 */
export interface JiraConnectorConfig {
  /** Discriminator selecting the Jira connector. */
  type: 'jira';
  /** Jira Cloud site host, e.g. `example.atlassian.net`. */
  site: string;
  /** Name of the environment variable holding the account email. */
  emailEnv: string;
  /** Name of the environment variable holding the API token. */
  tokenEnv: string;
}

/**
 * An issue-tracker account. One variant per connector type.
 */
export type ConnectorConfig = JiraConnectorConfig;

/**
 * The part of a workspace that decides which issues its source lists and how
 * they are bucketed.
 */
export interface WorkspaceQuery {
  /** Parent epic key; the default query lists its unfinished children. */
  epic: string;
  /** Raw query that replaces the default one entirely. */
  jql?: string | undefined;
  /** Status names that land in the Review column. */
  reviewStatuses: string[];
}

/**
 * One epic, read through one connector and worked in one repo. The header
 * dropdown switches workspaces; a board is a workspace's view.
 */
export interface WorkspaceConfig extends WorkspaceQuery {
  /** Name shown in the workspace switcher. */
  name: string;
  /** Id of the connector the issues are read through. */
  connector: string;
  /** Id of the repo the sessions are worked in. */
  repo: string;
  /**
   * Template of the private per-issue checklist, in display order. Empty when
   * the workspace offers no checklist.
   */
  checklist: string[];
  /** Poll interval in seconds. */
  pollSeconds: number;
}

/**
 * How the dashboard opens a checkout in a desktop editor.
 */
export interface EditorConfig {
  /** Executable to spawn, e.g. `code` or `cmd.exe`. */
  command: string;
  /** Arguments; every `{{path}}` is replaced with the checkout path. */
  args: string[];
}

/**
 * The whole validated configuration file.
 */
export interface Config {
  /** Port the server binds on 127.0.0.1. */
  port: number;
  /** Absolute directory holding session records and generated session files. */
  dataDir: string;
  /** How to open a checkout in a desktop editor. */
  editor: EditorConfig;
  /** Runner settings shared by every board. */
  runner: RunnerConfig;
  /** Issue-tracker accounts, keyed by connector id. */
  connectors: Record<string, ConnectorConfig>;
  /** Git repositories and their playbooks, keyed by repo id. */
  repos: Record<string, RepoConfig>;
  /** Workspaces, keyed by workspace id; each one is a board. */
  workspaces: Record<string, WorkspaceConfig>;
}

/**
 * An error an issue source raises for a query that repeating cannot fix — a
 * search past its page cap, a syntactically invalid query, a project the
 * credentials cannot see.
 *
 * The manager suspends a workspace's poll timer on one of these rather than
 * re-sending the same rejected query every `pollSeconds` for as long as the
 * server runs. Any source may raise one; nothing about the marker is Jira's.
 */
export interface PermanentSourceError extends Error {
  /** Always true; a transient failure carries no `permanent` property at all. */
  readonly permanent: true;
}

/**
 * Reports whether a thrown value is an issue source's permanent refusal.
 *
 * @param cause - Whatever the source threw.
 * @returns True when the error marks itself `permanent`.
 */
export function isPermanentSourceError(cause: unknown): cause is PermanentSourceError {
  return cause instanceof Error && (cause as { permanent?: unknown }).permanent === true;
}

/**
 * Lists the issues of one workspace.
 */
export interface IssueSource {
  /** Id of the workspace this source belongs to. */
  readonly id: string;
  /**
   * Lists every issue the workspace should show.
   *
   * @returns The issues in source order (Jira rank for the Jira connector).
   * @throws {Error} When the tracker is unreachable or rejects the query.
   */
  list(): Promise<Issue[]>;
  /**
   * Fetches one issue by key, for issues that dropped out of `list`.
   *
   * @param key - Tracker key of the issue.
   * @returns The issue, or null when the tracker has no such issue.
   * @throws {Error} When the tracker is unreachable or rejects the request.
   */
  get(key: string): Promise<Issue | null>;
}

/**
 * The checkout a session will run in, resolved by `Repo.prepare`.
 */
export interface PreparedCheckout {
  /** Absolute working directory for the tmux session. */
  cwd: string;
  /** Branch checked out at `cwd`; null for isolation `shared`. */
  branch: string | null;
  /** Whether the repo's bootstrap command still has to run in `cwd`. */
  needsBootstrap: boolean;
}

/**
 * A worktree the repo knows about.
 */
export interface WorktreeInfo {
  /** Absolute path of the worktree. */
  path: string;
  /** Branch checked out there, or null when detached. */
  branch: string | null;
}

/**
 * What the caller already knows about an issue's checkout.
 */
export interface PrepareHints {
  /**
   * Branch the caller has on record for the issue, typically from its newest
   * session record. Preferred over scanning the remote.
   */
  knownBranch?: string | null | undefined;
}

/**
 * Provides checkouts for sessions: worktree creation, reuse and removal.
 */
export interface Repo {
  /** Id of the repo, matching its key in `Config.repos`. */
  readonly id: string;
  /**
   * Resolves the directory and branch a session will run in, creating a
   * worktree when the playbook's isolation calls for one.
   *
   * @param issue - Issue the session is for; supplies the key and the slug.
   * @param playbook - Playbook whose `isolation` decides the policy.
   * @param hints - What the caller already knows about the issue's checkout.
   * @returns The checkout to launch in.
   * @throws {Error} When git refuses, or when `issue-worktree` finds no branch.
   */
  prepare(issue: Issue, playbook: Playbook, hints?: PrepareHints): Promise<PreparedCheckout>;
  /**
   * Removes a worktree created for an issue.
   *
   * @param issueKey - Key of the issue whose worktree should go.
   * @param force - Whether to pass `--force`, discarding a dirty tree.
   * @returns Nothing.
   * @throws {Error} When git refuses, e.g. on a dirty tree without `force`.
   */
  removeWorktree(issueKey: string, force: boolean): Promise<void>;
  /**
   * Looks up the worktree currently registered for an issue.
   *
   * @param issueKey - Key of the issue to look up.
   * @returns The worktree, or null when the issue has none.
   * @throws {Error} When git cannot be run.
   */
  worktreeFor(issueKey: string): Promise<WorktreeInfo | null>;
  /**
   * Path this repo puts an issue's worktree at.
   *
   * This is the single gate on an issue key used as a path segment, so a caller
   * that needs the path must ask for it here rather than joining it itself.
   *
   * @param issueKey - Key of the issue.
   * @returns The absolute worktree path.
   * @throws {Error} When the key is not usable as a single path segment.
   */
  worktreePath(issueKey: string): string;
  /**
   * Message from the last failed refresh of the repo's remote, or null when the
   * last one worked, none has been attempted, or the connector never fetches.
   *
   * A refresh failure is not a refusal: it means the refs a checkout resolves
   * from may be stale, which the start dialog reports as a warning.
   *
   * @returns The failure text, or null.
   */
  lastFetchError?(): string | null;
}

/**
 * Everything the runner needs to launch one session.
 */
export interface RunnerStartRequest {
  /** The record to launch; its `id` becomes the tmux session name. */
  record: SessionRecord;
  /** Whether the bootstrap command should run before `claude`. */
  needsBootstrap: boolean;
  /** Shell command to run as the bootstrap, when there is one. */
  bootstrap?: string | undefined;
}

/**
 * A live terminal attached to a session's tmux window.
 */
export interface RunnerTerminal {
  /**
   * Registers a listener for bytes coming out of the terminal.
   *
   * @param listener - Called with each chunk the terminal emits.
   * @returns Nothing.
   */
  onData(listener: (chunk: string) => void): void;
  /**
   * Registers a listener for the terminal ending.
   *
   * @param listener - Called once with the exit code when the terminal closes.
   * @returns Nothing.
   */
  onExit(listener: (exitCode: number) => void): void;
  /**
   * Writes bytes into the terminal, discarding them once it has ended.
   *
   * @param data - Bytes to write.
   * @returns Nothing.
   */
  write(data: string): void;
  /**
   * Resizes the terminal, doing nothing once it has ended.
   *
   * @param cols - New column count.
   * @param rows - New row count.
   * @returns Nothing.
   */
  resize(cols: number, rows: number): void;
  /**
   * Detaches this viewer, leaving the tmux session running.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * Launches, attaches to, interrupts and kills sessions.
 */
export interface Runner {
  /** Runner type id, matching `RunnerConfig.type`. */
  readonly type: string;
  /**
   * Launches a new `claude` process for a record that has never run.
   *
   * @param request - Record to launch plus its bootstrap decision.
   * @returns Nothing; progress is reported through launcher events.
   * @throws {Error} When tmux or the CLI is missing, naming the failed command.
   */
  start(request: RunnerStartRequest): Promise<void>;
  /**
   * Relaunches a record with `--resume`, reusing its Claude session id.
   *
   * @param record - Record to resume; its `claudeSessionId` must not be null.
   * @returns Nothing; progress is reported through launcher events.
   * @throws {Error} When the record has no Claude session id, or tmux refuses.
   */
  resume(record: SessionRecord): Promise<void>;
  /**
   * Attaches a viewer to the session's tmux window.
   *
   * @param sessionId - Id of the session to attach to.
   * @param cols - Initial column count of the viewer.
   * @param rows - Initial row count of the viewer.
   * @returns The attached terminal.
   * @throws {Error} When the pty cannot be spawned or the session is gone.
   */
  attach(sessionId: string, cols: number, rows: number): Promise<RunnerTerminal>;
  /**
   * Sends an interrupt (Escape) to the session.
   *
   * @param sessionId - Id of the session to interrupt.
   * @returns Nothing.
   * @throws {Error} When tmux refuses the send.
   */
  interrupt(sessionId: string): Promise<void>;
  /**
   * Kills the session's tmux session.
   *
   * @param sessionId - Id of the session to kill.
   * @returns Nothing.
   * @throws {Error} When tmux refuses the kill.
   */
  kill(sessionId: string): Promise<void>;
  /**
   * Reports whether the session's tmux session still exists.
   *
   * @param sessionId - Id of the session to probe.
   * @returns True while tmux still holds the session.
   */
  isAlive(sessionId: string): Promise<boolean>;
}
