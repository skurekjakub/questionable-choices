import type { Repo, RepoConfig } from '../../core/types.js';
import { GitRepo } from './git/index.js';

/**
 * Builds the repo connector for one configured repo.
 *
 * Every repo is a git checkout today, so the configuration carries no
 * discriminator and this factory has one branch.
 *
 * @param id - Id of the repo, matching its key in `Config.repos`.
 * @param config - The repo's configuration.
 * @returns The repo connector.
 */
export function createRepo(id: string, config: RepoConfig): Repo {
  return new GitRepo(id, config);
}

export {
  DetachedWorktreeError,
  DirtyWorktreeError,
  GitError,
  GitRepo,
  InvalidIssueKeyError,
  NoBranchError,
  WorktreeNotFoundError,
} from './git/index.js';
