import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { branchName } from '../../../core/prompt.js';
import type {
  Issue,
  Playbook,
  PrepareHints,
  PreparedCheckout,
  Repo,
  RepoConfig,
  WorktreeInfo,
} from '../../../core/types.js';
import {
  newestBranch,
  parseRefNames,
  parseRemoteBranches,
  remoteBranchPattern,
  remoteOf,
  remoteRefPattern,
} from './branches.js';
import { GIT_NETWORK_TIMEOUT_MS, GitError, git, gitAttempt } from './git.js';
import { parseWorktreeList } from './worktrees.js';

/**
 * Thrown when a worktree removal is refused because the tree has changes.
 */
export class DirtyWorktreeError extends Error {
  /** Absolute path of the worktree that was not removed. */
  readonly path: string;
  /** Output of `git status --porcelain` in that worktree. */
  readonly status: string;

  /**
   * Builds a dirty-worktree error carrying the porcelain status.
   *
   * @param path - Absolute path of the worktree that was not removed.
   * @param status - Output of `git status --porcelain` in that worktree.
   */
  constructor(path: string, status: string) {
    super(`${path} has uncommitted changes; removing it needs --force\n${status.trim()}`);
    this.name = 'DirtyWorktreeError';
    this.path = path;
    this.status = status;
  }
}

/**
 * Thrown when a removal names an issue that has no registered worktree.
 */
export class WorktreeNotFoundError extends Error {
  /** Key of the issue that has no worktree. */
  readonly issueKey: string;
  /** Path that was expected to hold one. */
  readonly path: string;

  /**
   * Builds a missing-worktree error.
   *
   * @param issueKey - Key of the issue that has no worktree.
   * @param path - Path that was expected to hold one.
   */
  constructor(issueKey: string, path: string) {
    super(`${issueKey} has no registered worktree at ${path}`);
    this.name = 'WorktreeNotFoundError';
    this.issueKey = issueKey;
    this.path = path;
  }
}

/**
 * Thrown when an issue key cannot be used as a path or a session-name segment.
 */
export class InvalidIssueKeyError extends Error {
  /** The key that was refused. */
  readonly issueKey: string;

  /**
   * Builds an invalid-key error.
   *
   * @param issueKey - The key that was refused.
   */
  constructor(issueKey: string) {
    super(`'${issueKey}' is not a usable issue key; expected letters, digits, '-' and '_'`);
    this.name = 'InvalidIssueKeyError';
    this.issueKey = issueKey;
  }
}

/**
 * Thrown when the worktree registered for an issue has no branch to work on.
 */
export class DetachedWorktreeError extends Error {
  /** Key of the issue the worktree belongs to. */
  readonly issueKey: string;
  /** Absolute path of the detached worktree. */
  readonly path: string;

  /**
   * Builds a detached-worktree error.
   *
   * @param issueKey - Key of the issue the worktree belongs to.
   * @param path - Absolute path of the detached worktree.
   */
  constructor(issueKey: string, path: string) {
    super(
      `the worktree for ${issueKey} at ${path} has a detached HEAD; check a branch out there or remove it`,
    );
    this.name = 'DetachedWorktreeError';
    this.issueKey = issueKey;
    this.path = path;
  }
}

const ISSUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Staleness reported before any fetch has run in this process.
 *
 * The refs on disk are whatever the last run of the dashboard, or the owner,
 * left behind, which is a caveat worth showing rather than silence.
 */
export const NO_FETCH_YET_MESSAGE =
  'no fetch has been attempted since the dashboard started, so the refs are as old as the checkout';

/**
 * Knobs a caller may override when building a repo connector.
 */
export interface GitRepoOptions {
  /**
   * Milliseconds a network-bound git invocation may run; defaults to
   * `GIT_NETWORK_TIMEOUT_MS`.
   */
  fetchTimeoutMs?: number | undefined;
}

/**
 * Provides checkouts for sessions out of one git repository and its worktrees.
 */
export class GitRepo implements Repo {
  /** Id of the repo, matching its key in `Config.repos`. */
  readonly id: string;

  private readonly config: RepoConfig;
  private readonly remote: string;
  private readonly fetchTimeoutMs: number;
  private fetchError: string | null = NO_FETCH_YET_MESSAGE;

  /**
   * Builds a repo connector over one main checkout.
   *
   * @param id - Id of the repo, matching its key in `Config.repos`.
   * @param config - The repo's configuration.
   * @param options - Overrides of the connector's own limits.
   */
  constructor(id: string, config: RepoConfig, options: GitRepoOptions = {}) {
    this.id = id;
    this.config = config;
    this.remote = remoteOf(config.baseRef);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
  }

  /**
   * Path the repo puts an issue's worktree at.
   *
   * @param issueKey - Key of the issue.
   * @returns The absolute worktree path, `<worktreeDir>/<KEY>`.
   * @throws {InvalidIssueKeyError} When the key is not a single safe segment.
   */
  worktreePath(issueKey: string): string {
    // A key is a path segment here and a tmux target elsewhere, and it arrives
    // from a URL: `../` would escape worktreeDir, `/` would collide two keys.
    if (!ISSUE_KEY_PATTERN.test(issueKey)) throw new InvalidIssueKeyError(issueKey);
    return join(this.config.worktreeDir, issueKey);
  }

  /**
   * Lists every worktree the repository has registered.
   *
   * @returns The worktrees, main checkout first.
   * @throws {GitError} When git cannot be run.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await git(['worktree', 'list', '--porcelain'], this.config.path);
    return parseWorktreeList(stdout);
  }

  /**
   * Looks up the worktree currently registered for an issue.
   *
   * @param issueKey - Key of the issue to look up.
   * @returns The worktree, or null when the issue has none.
   * @throws {GitError} When git cannot be run.
   */
  async worktreeFor(issueKey: string): Promise<WorktreeInfo | null> {
    const wanted = await canonicalPath(this.worktreePath(issueKey));
    const worktrees = await this.listWorktrees();
    for (const worktree of worktrees) {
      if ((await canonicalPath(worktree.path)) === wanted) return worktree;
    }
    return null;
  }

  /**
   * Finds the branch an issue's work lives on.
   *
   * @param issueKey - Key of the issue to find a branch for.
   * @param preferred - Branch the caller already knows; used when it still
   *   resolves in the repository.
   * @returns The branch name, or null when nothing matched.
   * @throws {GitError} When git cannot be run.
   */
  async findIssueBranch(
    issueKey: string,
    preferred?: string | null | undefined,
  ): Promise<string | null> {
    if (preferred !== undefined && preferred !== null && preferred !== '') {
      if (await this.branchExists(preferred)) return preferred;
    }
    const listed = await gitAttempt(
      ['branch', '-r', '--list', remoteBranchPattern(this.remote, issueKey)],
      this.config.path,
    );
    if (!listed.ok) return null;
    const candidates = parseRemoteBranches(listed.stdout, this.remote);
    if (candidates.length === 0) return null;
    const sorted = await gitAttempt(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        remoteRefPattern(this.remote, issueKey),
      ],
      this.config.path,
    );
    const ordered = sorted.ok ? parseRefNames(sorted.stdout, this.remote) : [];
    return newestBranch(candidates, ordered);
  }

  /**
   * Resolves the directory and branch a session will run in.
   *
   * @param issue - Issue the session is for; supplies the key and the slug.
   * @param playbook - Playbook whose `isolation` decides the policy.
   * @param hints - What the caller already knows about the issue's checkout.
   * @returns The checkout to launch in.
   * @throws {InvalidIssueKeyError} When the issue key is not a safe segment.
   * @throws {DetachedWorktreeError} When the registered worktree has no branch.
   * @throws {GitError} When git refuses to create the worktree.
   */
  async prepare(
    issue: Issue,
    playbook: Playbook,
    hints: PrepareHints = {},
  ): Promise<PreparedCheckout> {
    // Validated for every isolation, not only the ones that build a path: the
    // key also names the tmux session and the session directory.
    const path = this.worktreePath(issue.key);
    if (playbook.isolation === 'shared') {
      return { cwd: this.config.path, branch: null, needsBootstrap: false };
    }

    // Both non-shared isolations resolve refs from the remote — one to branch
    // off the base ref, the other to find the issue's branch — so both fetch,
    // and before the reuse check so a long-lived worktree is not worked
    // against whatever the last fetch happened to leave behind.
    await this.fetchBaseRef();

    const existing = await this.worktreeFor(issue.key);
    if (existing !== null) {
      if (existing.branch === null) throw new DetachedWorktreeError(issue.key, existing.path);
      return { cwd: existing.path, branch: existing.branch, needsBootstrap: false };
    }

    // An issue with no branch anywhere gets the fresh-worktree treatment
    // instead of a refusal: the owner would rather work on a new branch off the
    // base ref than be told to make one by hand.
    const issueBranch =
      playbook.isolation === 'issue-worktree'
        ? await this.findIssueBranch(issue.key, hints.knownBranch)
        : null;
    const branch = issueBranch ?? branchName(this.config.branchPattern, issue);
    await this.addWorktree(path, branch);
    return { cwd: path, branch, needsBootstrap: true };
  }

  /**
   * Why the repo's refs may be stale, or null when the last fetch worked.
   *
   * Before any fetch has run in this process the answer is
   * `NO_FETCH_YET_MESSAGE`, not null: "nobody has checked" and "it is fine" are
   * different answers, and the start dialog shows one of them as a warning.
   *
   * @returns The staleness text, or null.
   */
  lastFetchError(): string | null {
    return this.fetchError;
  }

  /**
   * Fetches the base ref's remote, remembering a failure instead of raising it.
   *
   * A checkout that is already on disk must stay usable without a network, so
   * an unreachable remote degrades to stale refs plus a warning rather than a
   * refused start. The fetch carries a deadline because it runs under the
   * caller's checkout lock and a black-holed remote never returns on its own.
   *
   * @returns Nothing.
   */
  private async fetchBaseRef(): Promise<void> {
    const args = ['fetch', this.remote];
    const attempt = await gitAttempt(args, this.config.path, {
      timeoutMs: this.fetchTimeoutMs,
    });
    this.fetchError = attempt.ok
      ? null
      : new GitError(args, this.config.path, attempt.exitCode, attempt.stderr).message;
  }

  /**
   * Removes the worktree created for an issue.
   *
   * @param issueKey - Key of the issue whose worktree should go.
   * @param force - Whether to pass `--force`, discarding a dirty tree.
   * @returns Nothing.
   * @throws {WorktreeNotFoundError} When the issue has no registered worktree.
   * @throws {DirtyWorktreeError} When the tree has changes and `force` is false.
   * @throws {GitError} When git refuses the removal.
   */
  async removeWorktree(issueKey: string, force: boolean): Promise<void> {
    const worktree = await this.worktreeFor(issueKey);
    if (worktree === null) throw new WorktreeNotFoundError(issueKey, this.worktreePath(issueKey));
    if (!force) {
      const { stdout } = await git(['status', '--porcelain'], worktree.path);
      if (stdout.trim() !== '') throw new DirtyWorktreeError(worktree.path, stdout);
    }
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path];
    await git(args, this.config.path);
  }

  /**
   * Reports whether a branch resolves locally or on the repo's remote.
   *
   * @param branch - Short branch name to look for.
   * @returns True when either ref exists.
   */
  private async branchExists(branch: string): Promise<boolean> {
    return (await this.localBranchExists(branch)) || (await this.remoteBranchExists(branch));
  }

  /**
   * Reports whether a local branch exists.
   *
   * @param branch - Short branch name to look for.
   * @returns True when `refs/heads/<branch>` resolves.
   */
  private async localBranchExists(branch: string): Promise<boolean> {
    const attempt = await gitAttempt(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      this.config.path,
    );
    return attempt.ok;
  }

  /**
   * Reports whether a branch exists on the repo's remote.
   *
   * @param branch - Short branch name to look for.
   * @returns True when `refs/remotes/<remote>/<branch>` resolves.
   */
  private async remoteBranchExists(branch: string): Promise<boolean> {
    const attempt = await gitAttempt(
      ['show-ref', '--verify', '--quiet', `refs/remotes/${this.remote}/${branch}`],
      this.config.path,
    );
    return attempt.ok;
  }

  /**
   * Adds a worktree for a branch, creating the branch when only the remote has it.
   *
   * @param path - Absolute path the worktree is created at.
   * @param branch - Branch to check out there.
   * @returns Nothing.
   * @throws {GitError} When git refuses the worktree.
   */
  private async addWorktree(path: string, branch: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (await this.localBranchExists(branch)) {
      await git(['worktree', 'add', path, branch], this.config.path);
      return;
    }
    if (await this.remoteBranchExists(branch)) {
      await git(
        ['worktree', 'add', '-b', branch, path, `${this.remote}/${branch}`],
        this.config.path,
      );
      return;
    }
    await git(['worktree', 'add', '-b', branch, path, this.config.baseRef], this.config.path);
  }
}

/**
 * Resolves a path for comparison against git's own output.
 *
 * git prints worktree paths with symlinks resolved, so a `worktreeDir` that
 * sits behind one would never match a plain string comparison.
 *
 * @param path - Path to canonicalise.
 * @returns The real path, or the resolved path when it does not exist yet.
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export { GitError, git, gitAttempt, gitCommandLine } from './git.js';
