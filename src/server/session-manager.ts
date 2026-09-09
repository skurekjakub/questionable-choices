import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BoardView,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  EventFrame,
  IssueDetailResponse,
  PrefillResponse,
  PublicConfigResponse,
  RemoveWorktreeResponse,
  SessionEventsResponse,
  WorkspaceSummary,
} from '../core/api.js';
import { CACHE_TTL_1H_SECONDS, CACHE_TTL_5M_SECONDS } from '../core/cache-clock.js';
import {
  applyWorkspaceChange,
  removeWorkspace,
  serializeConfig,
  startDefaults,
  workspaceIdFor,
} from '../core/config.js';
import { missingIssueKeys, project } from '../core/projection.js';
import { branchName, editorCommand, renderPrompt, sessionName } from '../core/prompt.js';
import { isLive, reduce } from '../core/state-machine.js';
import type { SessionEvent } from '../core/state-machine.js';
import {
  EFFORTS,
  PERMISSION_MODE_SETTINGS,
  type Config,
  type Effort,
  type Issue,
  type IssueFlags,
  type IssueSource,
  type PermissionModeSetting,
  type Playbook,
  type Repo,
  type RepoConfig,
  type Runner,
  type SessionRecord,
  type SessionState,
  type WorkspaceConfig,
} from '../core/types.js';
import { Store, writeJsonAtomic } from './store.js';

/**
 * Interval between reconciler passes, in milliseconds.
 */
export const RECONCILE_INTERVAL_MS = 10_000;

/**
 * Window over which board recomputations for one workspace are coalesced.
 */
export const BOARD_DEBOUNCE_MS = 250;

/**
 * A refusal the API answers with a 4xx and shows to the owner verbatim.
 */
export class ActionError extends Error {
  /** HTTP status the route should answer with. */
  readonly status: number;
  /** Extra context, e.g. git's stderr or the command that failed. */
  readonly detail: string | undefined;

  /**
   * Builds a refusal.
   *
   * @param status - HTTP status to answer with.
   * @param message - Message shown to the owner verbatim.
   * @param detail - Extra context, when there is any.
   */
  constructor(status: number, message: string, detail?: string | undefined) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Where the server writes its diagnostics.
 */
export interface Logger {
  /** Logs a routine fact. */
  info(message: string): void;
  /** Logs something the owner should probably look at. */
  warn(message: string): void;
  /** Logs a failure. */
  error(message: string): void;
}

/**
 * Logger writing to the process console.
 */
export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/**
 * One workspace's configuration together with the connectors built for it.
 */
export interface WorkspaceRuntime {
  /** Workspace id, matching its key in `Config.workspaces`. */
  id: string;
  /** The workspace's validated configuration. */
  config: WorkspaceConfig;
  /** Configuration of the repo the workspace names, supplying the playbooks. */
  repoConfig: RepoConfig;
  /** Repo connector providing this board's checkouts; shared between workspaces. */
  repo: Repo;
  /** Issue source listing this board's issues. */
  issues: IssueSource;
}

/**
 * Builds the runtime of one workspace out of a configuration that already
 * contains it.
 */
export type WorkspaceRuntimeFactory = (config: Config, workspaceId: string) => WorkspaceRuntime;

/**
 * Spawns the owner's editor on a checkout.
 *
 * @param command - Executable to spawn.
 * @param args - Arguments, with `{{path}}` already substituted.
 * @param onError - Called when the launch fails, synchronously or later.
 */
export type EditorSpawner = (
  command: string,
  args: string[],
  onError: (error: Error) => void,
) => void;

/**
 * Everything the session manager needs to run.
 */
export interface SessionManagerOptions {
  /** Validated configuration. */
  config: Config;
  /** Absolute path of the configuration file, rewritten when a workspace changes. */
  configPath: string;
  /** Durable state. */
  store: Store;
  /** Runner used for every session on every workspace. */
  runner: Runner;
  /** One entry per configured workspace. */
  workspaces: WorkspaceRuntime[];
  /** Builds the runtime of a workspace added while the server runs. */
  createRuntime: WorkspaceRuntimeFactory;
  /** TTL in seconds of the derived prompt-cache fallback. */
  derivedCacheTtlSeconds: number;
  /** Clock, in epoch milliseconds; replaceable in tests. */
  now?: (() => number) | undefined;
  /** Editor launcher; replaceable in tests. */
  spawnEditor?: EditorSpawner | undefined;
  /** Diagnostics sink. */
  logger?: Logger | undefined;
}

/**
 * Per-workspace issue cache: the last good list plus the issues that only a
 * session record still refers to.
 */
interface IssueCache {
  /** Last list the source returned successfully. */
  issues: Issue[];
  /** Issues fetched one by one because they dropped out of the list. */
  extras: Map<string, Issue>;
  /** ISO timestamp of the last successful list. */
  fetchedAt: string;
  /** Message from the last failed refresh, or null when the list is fresh. */
  sourceError: string | null;
  /** The refresh currently running, so callers can join it instead of piling on. */
  inFlight: Promise<void> | null;
}

/**
 * Reads the derived prompt-cache TTL out of the owner's Claude Code settings.
 *
 * @param settingsPath - Absolute path of `~/.claude/settings.json`.
 * @returns 3600 when the settings enable the one-hour prompt cache, else 300.
 */
export function readDerivedCacheTtlSeconds(settingsPath: string): number {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
  } catch {
    return CACHE_TTL_5M_SECONDS;
  }
  if (document === null || typeof document !== 'object') return CACHE_TTL_5M_SECONDS;
  const env = (document as Record<string, unknown>)['env'];
  if (env === null || typeof env !== 'object') return CACHE_TTL_5M_SECONDS;
  const flag = (env as Record<string, unknown>)['ENABLE_PROMPT_CACHING_1H'];
  if (flag === undefined || flag === null) return CACHE_TTL_5M_SECONDS;
  const text = String(flag);
  return text === '' || text === '0' || text === 'false'
    ? CACHE_TTL_5M_SECONDS
    : CACHE_TTL_1H_SECONDS;
}

/**
 * Default editor launcher: a detached process the dashboard never waits for.
 *
 * @param command - Executable to spawn.
 * @param args - Arguments, with `{{path}}` already substituted.
 * @param onError - Called with the spawn failure, which arrives asynchronously.
 * @returns Nothing.
 */
export const spawnDetached: EditorSpawner = (command, args, onError) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  // A missing executable reaches the child as an asynchronous 'error' event,
  // never as a throw from spawn; unhandled, that event takes the whole server
  // down and every session's state tracking with it.
  child.on('error', onError);
  // Without unref the editor keeps the event loop — and therefore the
  // dashboard — alive for as long as the owner leaves the window open.
  child.unref();
};

/**
 * Turns anything thrown into a message.
 *
 * @param cause - The thrown value.
 * @returns The error message, or its string form.
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Orchestrates sessions: validation, launch, lifecycle events, persistence,
 * issue polling, board projection and fan-out to the WebSocket layer.
 */
export class SessionManager {
  /** Raw channels: `board`, `session` and `config`, each carrying an `EventFrame`. */
  readonly events = new EventEmitter();
  /** Runner every session on every workspace runs through. */
  readonly runner: Runner;
  /** Validated configuration, as the last accepted workspace change left it. */
  config: Config;
  /** Durable state. */
  readonly store: Store;

  private readonly configPath: string;
  private readonly createRuntime: WorkspaceRuntimeFactory;
  private readonly workspaces = new Map<string, WorkspaceRuntime>();
  private readonly caches = new Map<string, IssueCache>();
  private readonly boardTimers = new Map<string, NodeJS.Timeout>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly derivedCacheTtlSeconds: number;
  private readonly now: () => number;
  private readonly spawnEditor: EditorSpawner;
  private readonly logger: Logger;
  private reconcileTimer: NodeJS.Timeout | null = null;

  /**
   * Builds a manager over already-constructed connectors.
   *
   * @param options - Configuration, store, connectors and injectable clock.
   */
  constructor(options: SessionManagerOptions) {
    this.config = options.config;
    this.configPath = options.configPath;
    this.store = options.store;
    this.runner = options.runner;
    this.createRuntime = options.createRuntime;
    this.derivedCacheTtlSeconds = options.derivedCacheTtlSeconds;
    this.now = options.now ?? Date.now;
    this.spawnEditor = options.spawnEditor ?? spawnDetached;
    this.logger = options.logger ?? consoleLogger;
    for (const runtime of options.workspaces) this.adopt(runtime);
    // Every terminal and every board viewer adds two listeners, so the default
    // ceiling of ten would warn as soon as a few tabs are open.
    this.events.setMaxListeners(0);
  }

  /**
   * Subscribes to every frame the manager pushes.
   *
   * @param listener - Called with each board or session frame.
   * @returns A function that removes the subscription.
   */
  subscribe(listener: (frame: EventFrame) => void): () => void {
    this.events.on('board', listener);
    this.events.on('session', listener);
    this.events.on('config', listener);
    return () => {
      this.events.off('board', listener);
      this.events.off('session', listener);
      this.events.off('config', listener);
    };
  }

  /**
   * Reconciles the persisted records, fetches every board and starts the poll
   * and reconcile timers.
   *
   * @returns Nothing, once the first refresh of every workspace has finished.
   */
  async start(): Promise<void> {
    await this.reconcile();
    await Promise.all([...this.workspaces.keys()].map((id) => this.refresh(id)));
    for (const runtime of this.workspaces.values()) this.startPolling(runtime);
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  /**
   * Stops every timer the manager owns.
   *
   * @returns Nothing.
   */
  stop(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    for (const timer of this.boardTimers.values()) clearTimeout(timer);
    this.boardTimers.clear();
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /**
   * Registers a workspace runtime and gives it an empty issue cache.
   *
   * @param runtime - The runtime to take ownership of.
   * @returns Nothing.
   */
  private adopt(runtime: WorkspaceRuntime): void {
    this.workspaces.set(runtime.id, runtime);
    this.caches.set(runtime.id, {
      issues: [],
      extras: new Map(),
      fetchedAt: new Date(this.now()).toISOString(),
      sourceError: null,
      inFlight: null,
    });
  }

  /**
   * Starts one workspace's poll timer, replacing any timer it already had.
   *
   * @param runtime - Workspace to poll.
   * @returns Nothing.
   */
  private startPolling(runtime: WorkspaceRuntime): void {
    const previous = this.pollTimers.get(runtime.id);
    if (previous !== undefined) clearInterval(previous);
    const timer = setInterval(() => {
      void this.refresh(runtime.id).catch((cause: unknown) => {
        this.logger.warn(`poll of workspace '${runtime.id}' failed: ${messageOf(cause)}`);
      });
    }, runtime.config.pollSeconds * 1000);
    timer.unref();
    this.pollTimers.set(runtime.id, timer);
  }

  /**
   * Adds a workspace: validates the request, rewrites the configuration file
   * and brings the board up without a restart.
   *
   * The file is written before anything is applied in memory, so a rejected
   * write leaves the running server exactly as it was.
   *
   * @param request - Workspace to add, naming an existing or an inline connector.
   * @returns The new workspace, as the switcher lists it.
   * @throws {ConfigError} When the request or the resulting configuration is invalid.
   * @throws {Error} When the configuration file cannot be written.
   */
  async addWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceSummary> {
    const next = applyWorkspaceChange(this.config, request);
    const id = workspaceIdFor(request);
    await this.writeConfig(next);
    this.config = next;
    const runtime = this.createRuntime(next, id);
    this.adopt(runtime);
    this.startPolling(runtime);
    this.emitConfig();
    void this.refresh(id).catch((cause: unknown) => {
      this.logger.warn(`first refresh of workspace '${id}' failed: ${messageOf(cause)}`);
    });
    return this.summaryOf(id, runtime.config);
  }

  /**
   * Removes a workspace: stops its polling, drops its runtime and rewrites the
   * configuration file. Sessions, flags and worktrees are left alone; they
   * belong to the repo, which other workspaces may still name.
   *
   * @param workspaceId - Workspace to remove.
   * @returns Nothing.
   * @throws {ActionError} When no workspace has that id.
   * @throws {ConfigError} When removing it would leave the configuration invalid.
   * @throws {Error} When the configuration file cannot be written.
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    this.requireWorkspace(workspaceId);
    const next = removeWorkspace(this.config, workspaceId);
    await this.writeConfig(next);
    this.config = next;
    const timer = this.pollTimers.get(workspaceId);
    if (timer !== undefined) clearInterval(timer);
    this.pollTimers.delete(workspaceId);
    const board = this.boardTimers.get(workspaceId);
    if (board !== undefined) clearTimeout(board);
    this.boardTimers.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    this.caches.delete(workspaceId);
    this.emitConfig();
  }

  /**
   * Writes a configuration back to the file the server loaded it from.
   *
   * @param config - Configuration to write.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  private async writeConfig(config: Config): Promise<void> {
    await writeJsonAtomic(this.configPath, serializeConfig(config));
  }

  /**
   * The picker options and workspace list the SPA boots from.
   *
   * @returns The public configuration.
   */
  publicConfig(): PublicConfigResponse {
    return {
      workspaces: [...this.workspaces.values()].map((runtime) =>
        this.summaryOf(runtime.id, runtime.config),
      ),
      repos: Object.entries(this.config.repos).map(([id, repo]) => ({ id, path: repo.path })),
      connectors: Object.entries(this.config.connectors).map(([id, connector]) => ({
        id,
        site: connector.site,
      })),
      runner: {
        models: this.config.runner.models,
        defaults: {
          model: this.config.runner.defaultModel,
          effort: this.config.runner.defaultEffort,
          permissionMode: this.config.runner.defaultPermissionMode,
        },
        efforts: [...EFFORTS],
        permissionModes: [...PERMISSION_MODE_SETTINGS],
      },
    };
  }

  /**
   * Projects one workspace's cached issues and session records onto the board.
   *
   * @param workspaceId - Workspace to project.
   * @returns The board view.
   * @throws {ActionError} When no workspace has that id.
   */
  board(workspaceId: string): BoardView {
    const runtime = this.requireWorkspace(workspaceId);
    const cache = this.requireCache(workspaceId);
    const worktrees: Record<string, string> = {};
    for (const [issueKey, worktree] of Object.entries(
      this.store.worktreesOf(runtime.config.repo),
    )) {
      worktrees[issueKey] = worktree.path;
    }
    return project({
      workspaceId,
      workspace: runtime.config,
      repo: runtime.repoConfig,
      issues: this.boardIssues(cache),
      sessions: this.store.sessions(),
      flags: this.store.flagsOf(workspaceId),
      worktrees,
      sourceError: cache.sourceError,
      fetchedAt: cache.fetchedAt,
    });
  }

  /**
   * Refetches one workspace's issues and recomputes its board.
   *
   * A failed fetch keeps the last good list and surfaces the message as the
   * board's `sourceError` instead of failing the request.
   *
   * @param workspaceId - Workspace to refresh.
   * @returns The board view after the refresh.
   * @throws {ActionError} When no workspace has that id.
   */
  async refresh(workspaceId: string): Promise<BoardView> {
    const runtime = this.requireWorkspace(workspaceId);
    const cache = this.requireCache(workspaceId);
    if (cache.inFlight !== null) {
      await cache.inFlight;
      return this.board(workspaceId);
    }
    const work = this.fetchIssues(runtime, cache);
    cache.inFlight = work;
    try {
      await work;
    } finally {
      cache.inFlight = null;
    }
    this.scheduleBoard(workspaceId);
    return this.board(workspaceId);
  }

  /**
   * Everything the issue drawer shows.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue.
   * @returns The issue, its sessions, its checkout and its flags.
   * @throws {ActionError} When the workspace or the issue is unknown.
   */
  async issueDetail(workspaceId: string, issueKey: string): Promise<IssueDetailResponse> {
    const runtime = this.requireWorkspace(workspaceId);
    const issue = await this.requireIssue(workspaceId, issueKey);
    return {
      issue,
      sessions: this.sessionsFor(runtime.config.repo, issueKey),
      worktreePath: this.store.worktree(runtime.config.repo, issueKey)?.path ?? null,
      flags: this.store.flagsOf(workspaceId)[issueKey] ?? {},
    };
  }

  /**
   * Every non-archived session one repo has for one issue, newest first.
   *
   * @param repoId - Repo the sessions were worked in.
   * @param issueKey - Key of the issue.
   * @returns The records, newest first.
   */
  private sessionsFor(repoId: string, issueKey: string): SessionRecord[] {
    return this.store
      .sessions()
      .filter(
        (record) => record.repoId === repoId && record.issueKey === issueKey && !record.archived,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Prefills the start dialog for one issue and playbook.
   *
   * Nothing is created here: the branch and worktree the prompt names are the
   * ones `Workspace.prepare` will resolve, so a template can mention them
   * before the session exists.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue.
   * @param playbookId - Playbook whose template and defaults to use.
   * @returns The prefilled prompt, picker values and any caveats.
   * @throws {ActionError} When the workspace, issue or playbook is unknown.
   */
  async prefill(
    workspaceId: string,
    issueKey: string,
    playbookId: string,
  ): Promise<PrefillResponse> {
    const runtime = this.requireWorkspace(workspaceId);
    const playbook = this.requirePlaybook(runtime, playbookId);
    const issue = await this.requireIssue(workspaceId, issueKey);
    const warnings: string[] = [];
    const cache = this.requireCache(workspaceId);
    if (cache.sourceError !== null) {
      warnings.push(`issue text may be stale: ${cache.sourceError}`);
    }

    const known = this.store.worktree(runtime.config.repo, issueKey);
    let branch: string | null;
    let worktree: string;
    if (playbook.isolation === 'shared') {
      branch = null;
      worktree = runtime.repoConfig.path;
    } else if (known !== undefined) {
      branch = known.branch;
      worktree = known.path;
    } else {
      worktree = join(runtime.repoConfig.worktreeDir, issueKey);
      branch =
        playbook.isolation === 'worktree'
          ? branchName(runtime.repoConfig.branchPattern, issue)
          : null;
      if (playbook.isolation === 'issue-worktree') {
        warnings.push(
          `no worktree is registered for ${issueKey}; its branch is resolved when the session starts`,
        );
      }
    }

    const defaults = startDefaults(this.config, playbook.defaults);
    return {
      prompt: renderPrompt(playbook, issue, { branch, worktree }),
      model: defaults.model,
      effort: defaults.effort,
      permissionMode: defaults.permissionMode,
      isolation: playbook.isolation,
      warnings,
    };
  }

  /**
   * Validates, prepares a checkout for and launches one session.
   *
   * The record is persisted before the runner is invoked, so a crash between
   * the two leaves a record the reconciler can close instead of an orphan
   * tmux session.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue to work on.
   * @param request - Playbook, prompt and picker values from the dialog.
   * @returns The persisted record, in state `starting`.
   * @throws {ActionError} When validation, checkout preparation or launch fails.
   */
  async startSession(
    workspaceId: string,
    issueKey: string,
    request: CreateSessionRequest,
  ): Promise<SessionRecord> {
    const runtime = this.requireWorkspace(workspaceId);
    const playbook = this.requirePlaybook(runtime, request.playbookId);
    const model = this.requireModel(request.model);
    const effort = this.requireEffort(request.effort);
    const permissionMode = this.requirePermissionMode(request.permissionMode);
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
      throw new ActionError(400, 'the prompt must not be empty');
    }

    const repoId = runtime.config.repo;
    const history = this.sessionsFor(repoId, issueKey);
    const clash = history.find(
      (record) => record.playbookId === playbook.id && isLive(record.state),
    );
    if (clash !== undefined) {
      throw new ActionError(
        409,
        `${issueKey} already has a live '${playbook.id}' session`,
        `session ${clash.id} is ${clash.state}`,
      );
    }

    const issue = await this.requireIssue(workspaceId, issueKey);
    let checkout;
    try {
      checkout = await runtime.repo.prepare(issue, playbook, {
        knownBranch: history[0]?.branch ?? null,
      });
    } catch (cause) {
      throw new ActionError(409, `cannot prepare a checkout for ${issueKey}`, messageOf(cause));
    }

    const startedAt = new Date(this.now()).toISOString();
    const record: SessionRecord = {
      id: sessionName(this.config.runner.tmuxPrefix, issueKey, playbook.id),
      issueKey,
      playbookId: playbook.id,
      repoId,
      cwd: checkout.cwd,
      branch: checkout.branch,
      model,
      effort,
      permissionMode,
      prompt: request.prompt,
      claudeSessionId: null,
      state: 'starting',
      stateSince: startedAt,
      pending: null,
      lastAssistantMessage: null,
      cache: null,
      createdAt: startedAt,
      endedAt: null,
      done: false,
      archived: false,
      runs: [],
    };
    await this.store.saveSession(record);
    await this.store.setWorktree(repoId, issueKey, {
      path: checkout.cwd,
      branch: checkout.branch,
      bootstrapped: !checkout.needsBootstrap,
    });

    try {
      await this.runner.start({
        record,
        needsBootstrap: checkout.needsBootstrap,
        ...(runtime.repoConfig.bootstrap === undefined
          ? {}
          : { bootstrap: runtime.repoConfig.bootstrap }),
      });
    } catch (cause) {
      const failed = await this.patch(record, { state: 'failed' });
      this.emitSession(failed);
      this.scheduleBoard(workspaceId);
      throw new ActionError(409, `cannot launch ${record.id}`, messageOf(cause));
    }

    this.emitSession(record);
    this.scheduleBoard(workspaceId);
    return record;
  }

  /**
   * Relaunches a session with `--resume`.
   *
   * @param sessionId - Session to resume.
   * @returns The record, back in state `starting`.
   * @throws {ActionError} When the session is unknown, never reported a Claude
   *   session id, or the runner refuses.
   */
  async resumeSession(sessionId: string): Promise<SessionRecord> {
    const record = this.requireSession(sessionId);
    if (record.claudeSessionId === null) {
      throw new ActionError(
        409,
        `${sessionId} never reported a Claude session id, so it cannot be resumed`,
      );
    }
    try {
      await this.runner.resume(record);
    } catch (cause) {
      throw new ActionError(409, `cannot resume ${sessionId}`, messageOf(cause));
    }
    const next = await this.patch(record, { state: 'starting', pending: null, endedAt: null });
    this.emitSession(next);
    this.scheduleRepoBoards(record.repoId);
    return next;
  }

  /**
   * Sends an interrupt to a session and moves it to `idle`.
   *
   * @param sessionId - Session to interrupt.
   * @returns The record after the interrupt.
   * @throws {ActionError} When the session is unknown or the runner refuses.
   */
  async interruptSession(sessionId: string): Promise<SessionRecord> {
    const record = this.requireSession(sessionId);
    try {
      await this.runner.interrupt(sessionId);
    } catch (cause) {
      throw new ActionError(409, `cannot interrupt ${sessionId}`, messageOf(cause));
    }
    return this.applyEvent(sessionId, { type: 'interrupt' }, { action: 'interrupt' });
  }

  /**
   * Kills a session's tmux session and closes its record.
   *
   * @param sessionId - Session to kill.
   * @returns The record, in state `exited`.
   * @throws {ActionError} When the session is unknown or the runner refuses.
   */
  async killSession(sessionId: string): Promise<SessionRecord> {
    this.requireSession(sessionId);
    try {
      await this.runner.kill(sessionId);
    } catch (cause) {
      throw new ActionError(409, `cannot kill ${sessionId}`, messageOf(cause));
    }
    return this.applyEvent(sessionId, { type: 'claude-exit', exitCode: null }, { action: 'kill' });
  }

  /**
   * Sets or clears a session's "did its job" flag.
   *
   * @param sessionId - Session to mark.
   * @param done - True to mark the session done, false to unmark it.
   * @returns The record after the change.
   * @throws {ActionError} When the session is unknown.
   */
  async setSessionDone(sessionId: string, done: boolean): Promise<SessionRecord> {
    const record = this.requireSession(sessionId);
    const next = await this.patch(record, { done });
    this.emitSession(next);
    this.scheduleRepoBoards(record.repoId);
    return next;
  }

  /**
   * Hides a session's record from its card.
   *
   * @param sessionId - Session to archive.
   * @returns The record after the change.
   * @throws {ActionError} When the session is unknown or still live.
   */
  async archiveSession(sessionId: string): Promise<SessionRecord> {
    const record = this.requireSession(sessionId);
    if (isLive(record.state)) {
      throw new ActionError(409, `${sessionId} is still ${record.state}; kill it before archiving`);
    }
    const next = await this.patch(record, { archived: true });
    this.emitSession(next);
    this.scheduleRepoBoards(record.repoId);
    return next;
  }

  /**
   * Removes the worktree a session ran in.
   *
   * @param sessionId - Session naming the issue whose checkout should go.
   * @param force - Whether to discard a dirty tree.
   * @returns The path that was removed.
   * @throws {ActionError} When the session is unknown, a live session still
   *   uses the checkout, the checkout is the main repo, or git refuses.
   */
  async removeWorktree(sessionId: string, force: boolean): Promise<RemoveWorktreeResponse> {
    const record = this.requireSession(sessionId);
    const runtime = this.requireRepo(record.repoId);
    const path = this.store.worktree(record.repoId, record.issueKey)?.path ?? record.cwd;
    if (path === runtime.repoConfig.path) {
      throw new ActionError(409, `${path} is the repo's main checkout, not a worktree`);
    }
    const blocking = this.store
      .sessions()
      .find((other) => other.cwd === path && isLive(other.state));
    if (blocking !== undefined) {
      throw new ActionError(
        409,
        `${blocking.id} is still ${blocking.state} in ${path}`,
        'kill the session before removing its worktree',
      );
    }
    try {
      await runtime.repo.removeWorktree(record.issueKey, force);
    } catch (cause) {
      throw new ActionError(409, `cannot remove ${path}`, messageOf(cause));
    }
    await this.store.clearWorktree(record.repoId, record.issueKey);
    this.scheduleRepoBoards(record.repoId);
    return { path, removed: true };
  }

  /**
   * Sets or clears an issue's board flags.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue.
   * @param patch - Flags to set; an explicit false clears one.
   * @returns The issue's flags after the merge.
   * @throws {ActionError} When the workspace is unknown.
   */
  async setFlags(workspaceId: string, issueKey: string, patch: IssueFlags): Promise<IssueFlags> {
    this.requireWorkspace(workspaceId);
    const flags = await this.store.setFlags(workspaceId, issueKey, patch);
    this.scheduleBoard(workspaceId);
    return flags;
  }

  /**
   * Opens an issue's checkout in the owner's editor.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue whose checkout to open.
   * @returns Nothing.
   * @throws {ActionError} When the workspace is unknown, the issue has no
   *   checkout, or the editor cannot be spawned.
   */
  async openEditor(workspaceId: string, issueKey: string): Promise<void> {
    const runtime = this.requireWorkspace(workspaceId);
    const worktree = this.store.worktree(runtime.config.repo, issueKey);
    if (worktree === undefined) {
      throw new ActionError(409, `${issueKey} has no checkout to open`);
    }
    const invocation = editorCommand(this.config.editor, worktree.path);
    const failure = `cannot open ${worktree.path} in ${invocation.command}`;
    try {
      // The launch is detached and its failure arrives after this call has
      // answered, so a bad editor command can only be reported in the log.
      this.spawnEditor(invocation.command, invocation.args, (error) => {
        this.logger.error(`${failure}: ${error.message}`);
      });
    } catch (cause) {
      throw new ActionError(409, failure, messageOf(cause));
    }
  }

  /**
   * Reads one session's raw event log.
   *
   * @param sessionId - Session whose log to read.
   * @returns The accepted events, oldest first.
   * @throws {ActionError} When the session is unknown.
   */
  async sessionEvents(sessionId: string): Promise<SessionEventsResponse> {
    this.requireSession(sessionId);
    return { events: await this.store.readEvents(sessionId) };
  }

  /**
   * Reduces one lifecycle event into a session record, logs it and fans out
   * whatever changed.
   *
   * The event is appended to the session's log whether or not it moved the
   * record, so the log stays a faithful transcript of what arrived.
   *
   * @param sessionId - Session the event belongs to.
   * @param event - The event to apply.
   * @param raw - The payload exactly as it arrived, for the log.
   * @returns The record after the event.
   * @throws {ActionError} When the session is unknown.
   */
  async applyEvent(sessionId: string, event: SessionEvent, raw: unknown): Promise<SessionRecord> {
    const before = this.requireSession(sessionId);
    const nowMs = this.now();
    const result = reduce(before, event, nowMs, {
      derivedCacheTtlSeconds: this.derivedCacheTtlSeconds,
    });
    await this.store.appendEvent(sessionId, {
      at: new Date(nowMs).toISOString(),
      event: raw,
      state: result.record.state,
    });
    if (!result.changed) return result.record;

    await this.store.saveSession(result.record);
    this.emitSession(result.record);
    this.scheduleRepoBoards(before.repoId);
    if (isLive(before.state) && !isLive(result.record.state)) {
      // A session leaving the live set usually means its issue just moved in
      // the tracker, so the board's issue list is refetched rather than waited on.
      for (const runtime of this.workspacesOfRepo(before.repoId)) {
        void this.refresh(runtime.id).catch((cause: unknown) => {
          this.logger.warn(`refresh after ${sessionId} exited failed: ${messageOf(cause)}`);
        });
      }
    }
    return result.record;
  }

  /**
   * Reports whether a session id is known.
   *
   * @param sessionId - Id to look up.
   * @returns True when a record has that id.
   */
  hasSession(sessionId: string): boolean {
    return this.store.session(sessionId) !== undefined;
  }

  /**
   * Ids of every configured workspace, in configuration order.
   *
   * @returns The workspace ids.
   */
  workspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  /**
   * Closes records whose tmux session has gone away.
   *
   * A record that never got as far as launching `claude` is marked `failed`;
   * one that did is marked `exited`.
   *
   * @returns Nothing.
   */
  async reconcile(): Promise<void> {
    for (const record of this.store.sessions()) {
      if (!isLive(record.state)) continue;
      let alive: boolean;
      try {
        alive = await this.runner.isAlive(record.id);
      } catch (cause) {
        this.logger.warn(`cannot probe ${record.id}: ${messageOf(cause)}`);
        continue;
      }
      if (alive) continue;
      const state: SessionState = record.runs.length === 0 ? 'failed' : 'exited';
      const next = await this.patch(record, {
        state,
        pending: null,
        endedAt: new Date(this.now()).toISOString(),
      });
      this.logger.info(`reconciler marked ${record.id} ${state}`);
      this.emitSession(next);
      this.scheduleRepoBoards(record.repoId);
    }
  }

  /**
   * Refetches a workspace's issue list and the issues only a session refers to.
   *
   * @param runtime - Workspace whose source to query.
   * @param cache - The workspace's issue cache, updated in place.
   * @returns Nothing.
   */
  private async fetchIssues(runtime: WorkspaceRuntime, cache: IssueCache): Promise<void> {
    let listed = true;
    try {
      cache.issues = await runtime.issues.list();
      cache.fetchedAt = new Date(this.now()).toISOString();
      cache.sourceError = null;
    } catch (cause) {
      listed = false;
      cache.sourceError = messageOf(cause);
      this.logger.warn(`workspace '${runtime.id}' issue list failed: ${cache.sourceError}`);
    }
    // While the source is down the previously fetched session-only issues are
    // the only ones there are, so they are kept rather than refetched.
    if (!listed) return;

    const extras = new Map<string, Issue>();
    for (const key of missingIssueKeys(runtime.config.repo, cache.issues, this.store.sessions())) {
      try {
        const issue = await runtime.issues.get(key);
        if (issue !== null) extras.set(key, issue);
      } catch (cause) {
        const previous = cache.extras.get(key);
        if (previous !== undefined) extras.set(key, previous);
        this.logger.warn(`cannot fetch ${key}: ${messageOf(cause)}`);
      }
    }
    cache.extras = extras;
  }

  /**
   * The issue list the projection sees: the source's list plus the issues only
   * a session record still refers to.
   *
   * @param cache - The workspace's issue cache.
   * @returns The issues, source order first.
   */
  private boardIssues(cache: IssueCache): Issue[] {
    const keys = new Set(cache.issues.map((issue) => issue.key));
    const extras = [...cache.extras.values()].filter((issue) => !keys.has(issue.key));
    return [...cache.issues, ...extras];
  }

  /**
   * Looks an issue up in the cache, falling back to a single fetch.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue.
   * @returns The issue.
   * @throws {ActionError} When the source has no such issue or cannot be reached.
   */
  private async requireIssue(workspaceId: string, issueKey: string): Promise<Issue> {
    const runtime = this.requireWorkspace(workspaceId);
    const cache = this.requireCache(workspaceId);
    const cached =
      cache.issues.find((issue) => issue.key === issueKey) ?? cache.extras.get(issueKey);
    if (cached !== undefined) return cached;
    let issue: Issue | null;
    try {
      issue = await runtime.issues.get(issueKey);
    } catch (cause) {
      throw new ActionError(502, `cannot fetch ${issueKey}`, messageOf(cause));
    }
    if (issue === null)
      throw new ActionError(404, `${issueKey} is not on workspace '${workspaceId}'`);
    cache.extras.set(issueKey, issue);
    return issue;
  }

  /**
   * Looks a workspace runtime up.
   *
   * @param workspaceId - Workspace id from the route.
   * @returns The runtime.
   * @throws {ActionError} When no workspace has that id.
   */
  private requireWorkspace(workspaceId: string): WorkspaceRuntime {
    const runtime = this.workspaces.get(workspaceId);
    if (runtime === undefined) throw new ActionError(404, `unknown workspace '${workspaceId}'`);
    return runtime;
  }

  /**
   * Every workspace that names one repo.
   *
   * @param repoId - Repo the workspaces must name.
   * @returns The runtimes, in configuration order.
   */
  private workspacesOfRepo(repoId: string): WorkspaceRuntime[] {
    return [...this.workspaces.values()].filter((runtime) => runtime.config.repo === repoId);
  }

  /**
   * Looks up any workspace that can act on one repo.
   *
   * @param repoId - Repo the caller needs a runtime for.
   * @returns The first workspace naming that repo.
   * @throws {ActionError} When no workspace names it, e.g. after the last one
   *   naming it was removed.
   */
  private requireRepo(repoId: string): WorkspaceRuntime {
    const runtime = this.workspacesOfRepo(repoId)[0];
    if (runtime === undefined) {
      throw new ActionError(404, `no workspace uses repo '${repoId}'`);
    }
    return runtime;
  }

  /**
   * Looks a workspace's issue cache up.
   *
   * @param workspaceId - Workspace id.
   * @returns The cache.
   * @throws {ActionError} When no workspace has that id.
   */
  private requireCache(workspaceId: string): IssueCache {
    const cache = this.caches.get(workspaceId);
    if (cache === undefined) throw new ActionError(404, `unknown workspace '${workspaceId}'`);
    return cache;
  }

  /**
   * Looks a session record up.
   *
   * @param sessionId - Session id from the route.
   * @returns The record.
   * @throws {ActionError} When no record has that id.
   */
  private requireSession(sessionId: string): SessionRecord {
    const record = this.store.session(sessionId);
    if (record === undefined) throw new ActionError(404, `unknown session '${sessionId}'`);
    return record;
  }

  /**
   * Looks a playbook up on one workspace.
   *
   * @param runtime - Workspace the playbook must belong to.
   * @param playbookId - Playbook id from the request.
   * @returns The playbook.
   * @throws {ActionError} When the workspace has no such playbook.
   */
  private requirePlaybook(runtime: WorkspaceRuntime, playbookId: string): Playbook {
    const playbook = runtime.repoConfig.playbooks.find((entry) => entry.id === playbookId);
    if (playbook === undefined) {
      throw new ActionError(
        400,
        `repo '${runtime.config.repo}' has no playbook '${playbookId}'`,
        `known playbooks: ${runtime.repoConfig.playbooks.map((entry) => entry.id).join(', ')}`,
      );
    }
    return playbook;
  }

  /**
   * Checks that a model is one the picker offers.
   *
   * @param model - Model id from the request.
   * @returns The model id.
   * @throws {ActionError} When the runner does not offer it.
   */
  private requireModel(model: string): string {
    if (!this.config.runner.models.some((choice) => choice.id === model)) {
      throw new ActionError(
        400,
        `unknown model '${model}'`,
        `known models: ${this.config.runner.models.map((choice) => choice.id).join(', ')}`,
      );
    }
    return model;
  }

  /**
   * Checks that an effort level is one the CLI accepts.
   *
   * @param effort - Effort from the request.
   * @returns The effort.
   * @throws {ActionError} When it is not an accepted level.
   */
  private requireEffort(effort: string): Effort {
    if (!(EFFORTS as readonly string[]).includes(effort)) {
      throw new ActionError(
        400,
        `unknown effort '${effort}'`,
        `known efforts: ${EFFORTS.join(', ')}`,
      );
    }
    return effort as Effort;
  }

  /**
   * Checks that a permission mode is one the picker offers.
   *
   * @param mode - Permission mode from the request.
   * @returns The permission mode.
   * @throws {ActionError} When it is not an accepted mode.
   */
  private requirePermissionMode(mode: string): PermissionModeSetting {
    if (!(PERMISSION_MODE_SETTINGS as readonly string[]).includes(mode)) {
      throw new ActionError(
        400,
        `unknown permission mode '${mode}'`,
        `known modes: ${PERMISSION_MODE_SETTINGS.join(', ')}`,
      );
    }
    return mode as PermissionModeSetting;
  }

  /**
   * Writes a set of fields onto a record, stamping `stateSince` on a state change.
   *
   * @param record - The record before the change.
   * @param fields - Fields to overwrite.
   * @returns The persisted record after the change.
   * @throws {Error} When the record cannot be persisted.
   */
  private async patch(
    record: SessionRecord,
    fields: Partial<SessionRecord>,
  ): Promise<SessionRecord> {
    const next: SessionRecord = { ...record, ...fields };
    if (next.state !== record.state) next.stateSince = new Date(this.now()).toISOString();
    await this.store.saveSession(next);
    return next;
  }

  /**
   * Pushes one session frame to every subscriber.
   *
   * @param record - The record after the change.
   * @returns Nothing.
   */
  private emitSession(record: SessionRecord): void {
    this.events.emit('session', { type: 'session', record } satisfies EventFrame);
  }

  /**
   * Pushes the public configuration to every subscriber.
   *
   * @returns Nothing.
   */
  private emitConfig(): void {
    this.events.emit('config', {
      type: 'config',
      config: this.publicConfig(),
    } satisfies EventFrame);
  }

  /**
   * Describes one workspace the way the switcher lists it.
   *
   * @param id - Workspace id.
   * @param workspace - The workspace's configuration.
   * @returns The summary.
   */
  private summaryOf(id: string, workspace: WorkspaceConfig): WorkspaceSummary {
    return {
      id,
      name: workspace.name,
      epic: workspace.epic,
      repo: workspace.repo,
      connector: workspace.connector,
    };
  }

  /**
   * Queues a board recomputation for every workspace over one repo.
   *
   * @param repoId - Repo whose sessions changed.
   * @returns Nothing.
   */
  private scheduleRepoBoards(repoId: string): void {
    for (const runtime of this.workspacesOfRepo(repoId)) this.scheduleBoard(runtime.id);
  }

  /**
   * Queues a board recomputation, coalescing bursts into one frame.
   *
   * @param workspaceId - Workspace whose board changed.
   * @returns Nothing.
   */
  private scheduleBoard(workspaceId: string): void {
    if (this.boardTimers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.boardTimers.delete(workspaceId);
      try {
        const view = this.board(workspaceId);
        this.events.emit('board', { type: 'board', workspaceId, view } satisfies EventFrame);
      } catch (cause) {
        this.logger.error(`cannot project workspace '${workspaceId}': ${messageOf(cause)}`);
      }
    }, BOARD_DEBOUNCE_MS);
    timer.unref();
    this.boardTimers.set(workspaceId, timer);
  }
}
