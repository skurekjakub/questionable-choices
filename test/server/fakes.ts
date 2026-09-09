import type {
  Config,
  Issue,
  Playbook,
  PrepareHints,
  PreparedCheckout,
  Repo,
  RepoConfig,
  Runner,
  RunnerStartRequest,
  RunnerTerminal,
  SessionRecord,
  IssueSource,
  WorktreeInfo,
} from '../../src/core/types.js';
import type { Logger, WorkspaceRuntime } from '../../src/server/session-manager.js';
import { makeConnector, makeRepo, makeWorkspace } from '../core/helpers.js';

/**
 * In-memory issue source whose list, single fetches and failures are set by the
 * test rather than by a tracker.
 */
export class FakeIssueSource implements IssueSource {
  /** Id of the board this source belongs to. */
  readonly id: string;
  /** Issues `list` returns. */
  issues: Issue[];
  /** Issues `get` can answer with, keyed by key; falls back to `issues`. */
  readonly extra = new Map<string, Issue>();
  /** Error `list` throws instead of answering, or null. */
  listError: Error | null = null;
  /** Error `get` throws instead of answering, or null. */
  getError: Error | null = null;
  /** Number of `list` calls so far. */
  listCalls = 0;
  /** Keys passed to `get`, in call order. */
  readonly getCalls: string[] = [];

  /**
   * Builds a source over a fixed issue list.
   *
   * @param id - Board id.
   * @param issues - Issues `list` starts out returning.
   */
  constructor(id: string, issues: Issue[] = []) {
    this.id = id;
    this.issues = issues;
  }

  /**
   * Lists the configured issues.
   *
   * @returns A copy of the issue list.
   * @throws {Error} When `listError` is set.
   */
  async list(): Promise<Issue[]> {
    this.listCalls += 1;
    if (this.listError !== null) throw this.listError;
    return [...this.issues];
  }

  /**
   * Fetches one issue by key.
   *
   * @param key - Key to look up.
   * @returns The issue, or null when neither `extra` nor the list has it.
   * @throws {Error} When `getError` is set.
   */
  async get(key: string): Promise<Issue | null> {
    this.getCalls.push(key);
    if (this.getError !== null) throw this.getError;
    return this.extra.get(key) ?? this.issues.find((issue) => issue.key === key) ?? null;
  }
}

/**
 * In-memory repo that records what it was asked to prepare and remove instead
 * of touching git.
 */
export class FakeRepo implements Repo {
  /** Id of the repo. */
  readonly id: string;
  /** Checkout `prepare` answers with. */
  result: PreparedCheckout;
  /** Error `prepare` throws instead of answering, or null. */
  prepareError: Error | null = null;
  /** Error `removeWorktree` throws instead of answering, or null. */
  removeError: Error | null = null;
  /** Every `prepare` call, in order. */
  readonly prepared: Array<{ issue: Issue; playbook: Playbook; hints: PrepareHints }> = [];
  /** Every `removeWorktree` call, in order. */
  readonly removed: Array<{ issueKey: string; force: boolean }> = [];
  /** Worktrees `worktreeFor` answers from. */
  readonly worktrees = new Map<string, WorktreeInfo>();

  /**
   * Builds a repo that always prepares the same checkout.
   *
   * @param id - Repo id.
   * @param result - Checkout `prepare` answers with.
   */
  constructor(id: string, result: PreparedCheckout) {
    this.id = id;
    this.result = result;
  }

  /**
   * Records the request and answers with the configured checkout.
   *
   * @param issue - Issue the session is for.
   * @param playbook - Playbook whose isolation would decide the policy.
   * @param hints - What the caller already knows about the checkout.
   * @returns The configured checkout.
   * @throws {Error} When `prepareError` is set.
   */
  async prepare(
    issue: Issue,
    playbook: Playbook,
    hints: PrepareHints = {},
  ): Promise<PreparedCheckout> {
    this.prepared.push({ issue, playbook, hints });
    if (this.prepareError !== null) throw this.prepareError;
    return this.result;
  }

  /**
   * Records the removal request.
   *
   * @param issueKey - Key of the issue whose worktree should go.
   * @param force - Whether the caller asked to discard a dirty tree.
   * @returns Nothing.
   * @throws {Error} When `removeError` is set.
   */
  async removeWorktree(issueKey: string, force: boolean): Promise<void> {
    this.removed.push({ issueKey, force });
    if (this.removeError !== null) throw this.removeError;
    this.worktrees.delete(issueKey);
  }

  /**
   * Looks a recorded worktree up.
   *
   * @param issueKey - Key of the issue to look up.
   * @returns The worktree, or null when the map has none.
   */
  async worktreeFor(issueKey: string): Promise<WorktreeInfo | null> {
    return this.worktrees.get(issueKey) ?? null;
  }
}

/**
 * A terminal that keeps what was written to it instead of driving a pty.
 */
export class FakeTerminal implements RunnerTerminal {
  /** Everything the viewer wrote, in order. */
  readonly writes: string[] = [];
  /** Every resize the viewer asked for, in order. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  /** Whether the viewer detached. */
  disposed = false;
  private dataListener: ((chunk: string) => void) | null = null;
  private exitListener: ((exitCode: number) => void) | null = null;

  /**
   * Registers the output listener.
   *
   * @param listener - Called with each chunk the terminal emits.
   * @returns Nothing.
   */
  onData(listener: (chunk: string) => void): void {
    this.dataListener = listener;
  }

  /**
   * Registers the exit listener.
   *
   * @param listener - Called once with the exit code.
   * @returns Nothing.
   */
  onExit(listener: (exitCode: number) => void): void {
    this.exitListener = listener;
  }

  /**
   * Records a write.
   *
   * @param data - Bytes the viewer sent.
   * @returns Nothing.
   */
  write(data: string): void {
    this.writes.push(data);
  }

  /**
   * Records a resize.
   *
   * @param cols - New column count.
   * @param rows - New row count.
   * @returns Nothing.
   */
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  /**
   * Marks the viewer detached.
   *
   * @returns Nothing.
   */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Pushes a chunk to the registered output listener.
   *
   * @param chunk - Bytes to emit.
   * @returns Nothing.
   */
  emitData(chunk: string): void {
    this.dataListener?.(chunk);
  }

  /**
   * Signals the terminal ending.
   *
   * @param exitCode - Exit code to report.
   * @returns Nothing.
   */
  emitExit(exitCode: number): void {
    this.exitListener?.(exitCode);
  }
}

/**
 * In-memory runner that records launches and answers liveness from a set.
 */
export class FakeRunner implements Runner {
  /** Runner type id. */
  readonly type = 'fake';
  /** Every `start` request, in order. */
  readonly started: RunnerStartRequest[] = [];
  /** Every record passed to `resume`, in order. */
  readonly resumed: SessionRecord[] = [];
  /** Ids passed to `interrupt`, in order. */
  readonly interrupted: string[] = [];
  /** Ids passed to `kill`, in order. */
  readonly killed: string[] = [];
  /** Ids `isAlive` answers true for. */
  readonly alive = new Set<string>();
  /** Terminals handed out by `attach`, in order. */
  readonly terminals: FakeTerminal[] = [];
  /** Error `start` throws instead of launching, or null. */
  startError: Error | null = null;
  /** Error `resume` throws instead of launching, or null. */
  resumeError: Error | null = null;
  /** Error `attach` throws instead of answering, or null. */
  attachError: Error | null = null;

  /**
   * Records a launch and marks the session alive.
   *
   * @param request - Record to launch plus its bootstrap decision.
   * @returns Nothing.
   * @throws {Error} When `startError` is set.
   */
  async start(request: RunnerStartRequest): Promise<void> {
    this.started.push(request);
    if (this.startError !== null) throw this.startError;
    this.alive.add(request.record.id);
  }

  /**
   * Records a resume and marks the session alive.
   *
   * @param record - Record to resume.
   * @returns Nothing.
   * @throws {Error} When `resumeError` is set.
   */
  async resume(record: SessionRecord): Promise<void> {
    this.resumed.push(record);
    if (this.resumeError !== null) throw this.resumeError;
    this.alive.add(record.id);
  }

  /**
   * Hands out a fresh fake terminal.
   *
   * @param _sessionId - Session to attach to.
   * @param cols - Initial column count.
   * @param rows - Initial row count.
   * @returns The terminal.
   * @throws {Error} When `attachError` is set.
   */
  async attach(_sessionId: string, cols: number, rows: number): Promise<RunnerTerminal> {
    if (this.attachError !== null) throw this.attachError;
    const terminal = new FakeTerminal();
    terminal.resize(cols, rows);
    this.terminals.push(terminal);
    return terminal;
  }

  /**
   * Records an interrupt.
   *
   * @param sessionId - Session to interrupt.
   * @returns Nothing.
   */
  async interrupt(sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
  }

  /**
   * Records a kill and marks the session dead.
   *
   * @param sessionId - Session to kill.
   * @returns Nothing.
   */
  async kill(sessionId: string): Promise<void> {
    this.killed.push(sessionId);
    this.alive.delete(sessionId);
  }

  /**
   * Reports whether a session is in the alive set.
   *
   * @param sessionId - Session to probe.
   * @returns True while the id is in `alive`.
   */
  async isAlive(sessionId: string): Promise<boolean> {
    return this.alive.has(sessionId);
  }
}

/**
 * Logger that keeps its lines instead of printing them.
 */
export class RecordingLogger implements Logger {
  /** Every line, prefixed with its level. */
  readonly lines: string[] = [];

  /**
   * Records an info line.
   *
   * @param message - The line.
   * @returns Nothing.
   */
  info(message: string): void {
    this.lines.push(`info: ${message}`);
  }

  /**
   * Records a warning line.
   *
   * @param message - The line.
   * @returns Nothing.
   */
  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  /**
   * Records an error line.
   *
   * @param message - The line.
   * @returns Nothing.
   */
  error(message: string): void {
    this.lines.push(`error: ${message}`);
  }
}

/**
 * Builds a configuration with one connector, one repo and one workspace.
 *
 * @param dataDir - Directory the store writes into.
 * @param repo - Overrides of the default repo configuration.
 * @returns The configuration.
 */
export function makeConfig(dataDir: string, repo: Partial<RepoConfig> = {}): Config {
  return {
    port: 4400,
    dataDir,
    editor: { command: 'code', args: ['{{path}}'] },
    runner: {
      type: 'claude-tmux',
      claudeBin: 'claude',
      tmuxPrefix: 'qc',
      models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1' }],
      defaultModel: 'claude-fable-5-1',
      defaultEffort: 'high',
      defaultPermissionMode: 'acceptEdits',
    },
    connectors: { tracker: makeConnector() },
    repos: { app: makeRepo({ bootstrap: 'npm ci', ...repo }) },
    workspaces: { ws: makeWorkspace() },
  };
}

/**
 * Builds the manager options that describe one workspace over fakes.
 *
 * @param config - Configuration holding the workspace and its repo.
 * @param workspaceId - Id of the workspace to build a runtime for.
 * @param issues - Issue source the board is projected from.
 * @param repo - Repo connector the checkouts come from.
 * @returns The runtime.
 * @throws {Error} When the configuration has no such workspace or repo.
 */
export function makeRuntime(
  config: Config,
  workspaceId: string,
  issues: IssueSource,
  repo: Repo,
): WorkspaceRuntime {
  const workspace = config.workspaces[workspaceId];
  const repoConfig = workspace === undefined ? undefined : config.repos[workspace.repo];
  if (workspace === undefined || repoConfig === undefined) {
    throw new Error(`the test config has no workspace '${workspaceId}' with a repo`);
  }
  return { id: workspaceId, config: workspace, repoConfig, repo, issues };
}
