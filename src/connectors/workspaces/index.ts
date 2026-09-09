import type { Workspace, WorkspaceConfig } from '../../core/types.js';
import { GitWorkspace } from './git/index.js';

/**
 * Builds the workspace connector for one configured workspace.
 *
 * Every workspace is a git checkout today, so the configuration carries no
 * discriminator and this factory has one branch.
 *
 * @param id - Id of the workspace, matching its key in `Config.workspaces`.
 * @param config - The workspace's configuration.
 * @returns The workspace connector.
 */
export function createWorkspace(id: string, config: WorkspaceConfig): Workspace {
  return new GitWorkspace(id, config);
}

export {
  DirtyWorktreeError,
  GitError,
  GitWorkspace,
  NoBranchError,
  WorktreeNotFoundError,
} from './git/index.js';
export type { PrepareHints } from './git/index.js';
