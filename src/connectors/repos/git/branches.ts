/**
 * Derives the remote a base ref lives on.
 *
 * @param baseRef - Ref new worktrees branch from, e.g. `origin/main`.
 * @returns The remote name; `origin` when the ref names none.
 */
export function remoteOf(baseRef: string): string {
  const slash = baseRef.indexOf('/');
  return slash > 0 ? baseRef.slice(0, slash) : 'origin';
}

/**
 * Builds the glob matching every remote branch that belongs to an issue.
 *
 * @param remote - Remote to search, e.g. `origin`.
 * @param issueKey - Key of the issue, e.g. `DOC-3847`.
 * @returns The pattern for `git branch -r --list`, e.g. `origin/DOC-3847-*`.
 */
export function remoteBranchPattern(remote: string, issueKey: string): string {
  return `${remote}/${issueKey}-*`;
}

/**
 * Builds the ref glob matching every remote branch that belongs to an issue.
 *
 * @param remote - Remote to search, e.g. `origin`.
 * @param issueKey - Key of the issue, e.g. `DOC-3847`.
 * @returns The pattern for `git for-each-ref`.
 */
export function remoteRefPattern(remote: string, issueKey: string): string {
  return `refs/remotes/${remote}/${issueKey}-*`;
}

/**
 * Drops a `<remote>/` prefix from a branch name.
 *
 * @param name - Branch name, possibly prefixed with its remote.
 * @param remote - Remote name to strip.
 * @returns The branch name without the remote prefix.
 */
export function stripRemote(name: string, remote: string): string {
  const prefix = `${remote}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Parses the output of `git branch -r --list <pattern>`.
 *
 * Symbolic entries such as `origin/HEAD -> origin/main` are skipped: they name
 * no branch of their own.
 *
 * @param output - Everything the command wrote to stdout.
 * @param remote - Remote whose prefix is stripped from each name.
 * @returns The branch names without their remote prefix, in git's order.
 */
export function parseRemoteBranches(output: string, remote: string): string[] {
  const branches: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.includes('->')) continue;
    branches.push(stripRemote(trimmed, remote));
  }
  return branches;
}

/**
 * Parses the output of `git for-each-ref --format=%(refname:short)`.
 *
 * @param output - Everything the command wrote to stdout.
 * @param remote - Remote whose prefix is stripped from each name.
 * @returns The branch names without their remote prefix, in git's sort order.
 */
export function parseRefNames(output: string, remote: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    names.push(stripRemote(trimmed, remote));
  }
  return names;
}

/**
 * Picks the newest of the branches that belong to an issue.
 *
 * @param candidates - Branch names `git branch -r --list` reported.
 * @param byCommitterDate - The same names as `git for-each-ref
 *   --sort=-committerdate` ordered them, newest first.
 * @returns The newest candidate, or null when there are none.
 */
export function newestBranch(
  candidates: readonly string[],
  byCommitterDate: readonly string[],
): string | null {
  const known = new Set(candidates);
  for (const name of byCommitterDate) {
    if (known.has(name)) return name;
  }
  return candidates[0] ?? null;
}
