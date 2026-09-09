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
import { git, gitAttempt } from './git.js';
import { parseWorktreeList } from './worktrees.js';

/**
 * Thrown when `issue-worktree` isolation finds no branch to check out.
 */
export class NoBranchError extends Error {
  /** Key of the issue no branch was found for. */
  readonly issueKey: string;
  /** Human-readable list of the places that were searched. */
  readonly searched: string[];

  /**
   * Builds a no-branch error naming everything that was searched.
   *
   * @param issueKey - Key of the issue no branch was found for.
   * @param searched - Descriptions of the places that were searched.
   */
  constructor(issueKey: string, searched: string[]) {
    super(`no branch found for ${issueKey}; searched ${searched.join(', ')}`);
    this.name = 'NoBranchError';
    this.issueKey = issueKey;
    this.searched = searched;
  }
}

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
    super(`${path} has uncommitted changes; removing it needs force\n${status.trim()}`);
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
 * Provides checkouts for sessions out of one git repository and its worktrees.
 */
export class GitRepo implements Repo {
  /** Id of the repo, matching its key in `Config.repos`. */
  readonly id: string;

  private readonly config: RepoConfig;
  private readonly remote: string;

  /**
   * Builds a repo connector over one main checkout.
   *
   * @param id - Id of the repo, matching its key in `Config.repos`.
   * @param config - The repo's configuration.
   */
  constructor(id: string, config: RepoConfig) {
    this.id = id;
    this.config = config;
    this.remote = remoteOf(config.baseRef);
  }

  /**
   * Path the repo puts an issue's worktree at.
   *
   * @param issueKey - Key of the issue.
   * @returns The absolute worktree path, `<worktreeDir>/<KEY>`.
   */
  worktreePath(issueKey: string): string {
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
   * @throws {GitError} When git refuses to create the worktree.
   * @throws {NoBranchError} When `issue-worktree` finds no branch.
   */
  async prepare(
    issue: Issue,
    playbook: Playbook,
    hints: PrepareHints = {},
  ): Promise<PreparedCheckout> {
    if (playbook.isolation === 'shared') {
      return { cwd: this.config.path, branch: null, needsBootstrap: false };
    }

    const existing = await this.worktreeFor(issue.key);
    if (existing !== null) {
      return { cwd: existing.path, branch: existing.branch, needsBootstrap: false };
    }

    const path = this.worktreePath(issue.key);
    if (playbook.isolation === 'issue-worktree') {
      const branch = await this.findIssueBranch(issue.key, hints.knownBranch);
      if (branch === null) {
        throw new NoBranchError(issue.key, [
          `the worktree ${path}`,
          'the branch on the newest session record for the issue',
          `remote branches matching ${remoteBranchPattern(this.remote, issue.key)}`,
        ]);
      }
      await this.addWorktree(path, branch);
      return { cwd: path, branch, needsBootstrap: true };
    }

    await git(['fetch', this.remote], this.config.path);
    const branch = branchName(this.config.branchPattern, issue);
    await this.addWorktree(path, branch);
    return { cwd: path, branch, needsBootstrap: true };
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

export { GIT_MAX_BUFFER, GitError, git, gitAttempt, gitCommandLine } from './git.js';
export type { GitAttempt, GitOutput } from './git.js';
export { parseWorktreeList, shortBranch } from './worktrees.js';
export {
  newestBranch,
  parseRefNames,
  parseRemoteBranches,
  remoteBranchPattern,
  remoteOf,
  remoteRefPattern,
  stripRemote,
} from './branches.js';
