import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DirtyWorktreeError,
  GitWorkspace,
  NoBranchError,
  WorktreeNotFoundError,
} from '../../src/connectors/workspaces/git/index.js';
import type { WorkspaceConfig } from '../../src/core/types.js';
import { makeIssue, makePlaybook, makeWorkspace } from '../core/helpers.js';

const execFileAsync = promisify(execFile);

let root = '';
let repo = '';
let worktreeDir = '';
let workspace: GitWorkspace;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Runs a git command in the temporary repository.
 *
 * @param args - Arguments passed to git, without the executable.
 * @param cwd - Directory to run git in.
 * @param env - Extra environment entries, e.g. a fixed committer date.
 * @returns Everything git wrote to stdout.
 */
async function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY, ...env },
  });
  return result.stdout;
}

/**
 * Commits a new file on the current branch.
 *
 * @param name - File name to create in the repository root.
 * @param when - Committer date, so `--sort=-committerdate` has an order.
 * @returns Nothing.
 */
async function commitFile(name: string, when: string): Promise<void> {
  await writeFile(join(repo, name), `${name}\n`, 'utf8');
  await run(['add', name], repo);
  await run(['commit', '-m', `add ${name}`], repo, { GIT_COMMITTER_DATE: when });
}

const playbooks = {
  worktree: makePlaybook({ id: 'implement', isolation: 'worktree' }),
  issueWorktree: makePlaybook({ id: 'test', isolation: 'issue-worktree' }),
  shared: makePlaybook({ id: 'chat', isolation: 'shared' }),
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qc-git-workspace-'));
  repo = join(root, 'repo');
  worktreeDir = join(root, 'worktrees');

  await run(['init', '--bare', 'origin.git'], root);
  await mkdir(repo, { recursive: true });
  await run(['init', '-b', 'main'], repo);
  await run(['config', 'commit.gpgsign', 'false'], repo);
  await commitFile('README.md', '2026-01-01T00:00:00+0000');
  await run(['remote', 'add', 'origin', join(root, 'origin.git')], repo);
  await run(['push', '-u', 'origin', 'main'], repo);

  await run(['checkout', '-b', 'DOC-2-older', 'main'], repo);
  await commitFile('older.txt', '2026-02-01T00:00:00+0000');
  await run(['push', 'origin', 'DOC-2-older'], repo);
  await run(['checkout', '-b', 'DOC-2-newer', 'main'], repo);
  await commitFile('newer.txt', '2026-06-01T00:00:00+0000');
  await run(['push', 'origin', 'DOC-2-newer'], repo);
  await run(['checkout', 'main'], repo);
  await run(['branch', '-D', 'DOC-2-older', 'DOC-2-newer'], repo);

  const config: WorkspaceConfig = makeWorkspace({ repo, worktreeDir, baseRef: 'origin/main' });
  workspace = new GitWorkspace('docs', config);
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('GitWorkspace.prepare', () => {
  it('runs shared isolation in the main checkout with no branch', async () => {
    const prepared = await workspace.prepare(makeIssue(), playbooks.shared);

    expect(prepared).toEqual({ cwd: repo, branch: null, needsBootstrap: false });
    expect(await workspace.worktreeFor('DOC-1')).toBeNull();
  });

  it('creates a worktree and a branch off the base ref, asking for a bootstrap', async () => {
    const prepared = await workspace.prepare(makeIssue(), playbooks.worktree);

    expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-1'));
    expect(prepared.branch).toBe('DOC-1-document-the-thing');
    expect(prepared.needsBootstrap).toBe(true);
  });

  it('reuses a registered worktree without asking for another bootstrap', async () => {
    const prepared = await workspace.prepare(makeIssue(), playbooks.worktree);

    expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-1'));
    expect(prepared.branch).toBe('DOC-1-document-the-thing');
    expect(prepared.needsBootstrap).toBe(false);
  });

  it('recreates an issue worktree from the newest remote branch', async () => {
    const issue = makeIssue({ key: 'DOC-2', summary: 'Second thing' });

    const prepared = await workspace.prepare(issue, playbooks.issueWorktree);

    expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-2'));
    expect(prepared.branch).toBe('DOC-2-newer');
    expect(prepared.needsBootstrap).toBe(true);
  });

  it('refuses issue-worktree isolation when nothing names a branch', async () => {
    const issue = makeIssue({ key: 'DOC-404', summary: 'Nothing here' });

    await expect(workspace.prepare(issue, playbooks.issueWorktree)).rejects.toBeInstanceOf(
      NoBranchError,
    );
    await expect(workspace.prepare(issue, playbooks.issueWorktree)).rejects.toThrow(
      /origin\/DOC-404-\*/,
    );
  });
});

describe('GitWorkspace.findIssueBranch', () => {
  it('prefers a branch the caller already knows', async () => {
    await expect(workspace.findIssueBranch('DOC-2', 'DOC-2-older')).resolves.toBe('DOC-2-older');
  });

  it('falls back to the remote scan when the known branch is gone', async () => {
    await expect(workspace.findIssueBranch('DOC-2', 'DOC-2-vanished')).resolves.toBe('DOC-2-newer');
  });

  it('answers null when no remote branch matches', async () => {
    await expect(workspace.findIssueBranch('DOC-404')).resolves.toBeNull();
  });
});

describe('GitWorkspace.listWorktrees', () => {
  it('lists the main checkout alongside every issue worktree', async () => {
    const worktrees = await workspace.listWorktrees();

    expect(worktrees.map((worktree) => worktree.branch)).toEqual([
      'main',
      'DOC-1-document-the-thing',
      'DOC-2-newer',
    ]);
  });

  it('resolves one issue to its worktree', async () => {
    const worktree = await workspace.worktreeFor('DOC-2');

    expect(worktree?.branch).toBe('DOC-2-newer');
  });
});

describe('GitWorkspace.removeWorktree', () => {
  it('removes a clean worktree', async () => {
    await workspace.removeWorktree('DOC-2', false);

    expect(await workspace.worktreeFor('DOC-2')).toBeNull();
  });

  it('refuses a dirty worktree and reports the porcelain status', async () => {
    await writeFile(join(worktreeDir, 'DOC-1', 'scratch.txt'), 'wip\n', 'utf8');

    const refusal = workspace.removeWorktree('DOC-1', false);

    await expect(refusal).rejects.toBeInstanceOf(DirtyWorktreeError);
    await expect(refusal).rejects.toThrow(/\?\? scratch\.txt/);
  });

  it('removes a dirty worktree when forced', async () => {
    await workspace.removeWorktree('DOC-1', true);

    expect(await workspace.worktreeFor('DOC-1')).toBeNull();
  });

  it('refuses an issue that has no worktree', async () => {
    await expect(workspace.removeWorktree('DOC-404', false)).rejects.toBeInstanceOf(
      WorktreeNotFoundError,
    );
  });
});
