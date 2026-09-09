import type { WorktreeInfo } from '../../../core/types.js';

/**
 * Strips the `refs/heads/` prefix from a branch ref.
 *
 * @param ref - Ref as `git worktree list --porcelain` prints it.
 * @returns The short branch name.
 */
export function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Parses the output of `git worktree list --porcelain`.
 *
 * Bare repositories are skipped: they have no checkout a session could run in.
 *
 * @param output - Everything the command wrote to stdout.
 * @returns One entry per non-bare worktree, in the order git listed them.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let bare = false;

  const flush = (): void => {
    if (path !== null && !bare) worktrees.push({ path, branch });
    path = null;
    branch = null;
    bare = false;
  };

  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') {
      flush();
      continue;
    }
    if (trimmed.startsWith('worktree ')) {
      flush();
      path = trimmed.slice('worktree '.length);
    } else if (trimmed.startsWith('branch ')) {
      branch = shortBranch(trimmed.slice('branch '.length));
    } else if (trimmed === 'bare') {
      bare = true;
    }
  }
  flush();
  return worktrees;
}
