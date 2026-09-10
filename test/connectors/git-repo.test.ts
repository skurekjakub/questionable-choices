import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DetachedWorktreeError,
  DirtyWorktreeError,
  GitError,
  GitRepo,
  InvalidIssueKeyError,
  NO_FETCH_YET_MESSAGE,
  NoBranchError,
  WorktreeNotFoundError,
  git,
  gitAttempt,
  gitCommandLine,
} from '../../src/connectors/repos/git/index.js';
import type { RepoConfig } from '../../src/core/types.js';
import { makeIssue, makePlaybook, makeRepo } from '../core/helpers.js';

const execFileAsync = promisify(execFile);

/**
 * Seconds the `ext::` transport sleeps in the leak test.
 *
 * Unique to this run, so a survivor of an earlier one — which is the very
 * failure the test exists to catch — cannot be counted as this run's.
 */
const SLEEP_SECONDS = 20_000 + (Date.now() % 9000);

let root = '';
let repo = '';
let worktreeDir = '';
let subject: GitRepo;

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
  root = await mkdtemp(join(tmpdir(), 'qc-git-repo-'));
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

  const config: RepoConfig = makeRepo({ path: repo, worktreeDir, baseRef: 'origin/main' });
  subject = new GitRepo('docs', config);
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('GitRepo.prepare', () => {
  it('runs shared isolation in the main checkout with no branch', async () => {
    const prepared = await subject.prepare(makeIssue(), playbooks.shared);

    expect(prepared).toEqual({ cwd: repo, branch: null, needsBootstrap: false });
    expect(await subject.worktreeFor('DOC-1')).toBeNull();
  });

  it('creates a worktree and a branch off the base ref, asking for a bootstrap', async () => {
    const prepared = await subject.prepare(makeIssue(), playbooks.worktree);

    expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-1'));
    expect(prepared.branch).toBe('DOC-1-document-the-thing');
    expect(prepared.needsBootstrap).toBe(true);
  });

  it('reuses a registered worktree without asking for another bootstrap', async () => {
    // Its own key and its own worktree: taking the one the test above created
    // would make this assertion depend on that test having run first.
    const issue = makeIssue({ key: 'DOC-11', summary: 'Reused' });
    const created = await subject.prepare(issue, playbooks.worktree);
    expect(created.needsBootstrap).toBe(true);

    try {
      const prepared = await subject.prepare(issue, playbooks.worktree);

      expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-11'));
      expect(prepared.branch).toBe('DOC-11-reused');
      expect(prepared.needsBootstrap).toBe(false);
    } finally {
      await run(['worktree', 'remove', '--force', join(worktreeDir, 'DOC-11')], repo);
      await run(['branch', '-D', 'DOC-11-reused'], repo);
    }
  });

  it('recreates an issue worktree from the newest remote branch', async () => {
    const issue = makeIssue({ key: 'DOC-2', summary: 'Second thing' });

    const prepared = await subject.prepare(issue, playbooks.issueWorktree);

    expect(prepared.cwd).toBe(join(worktreeDir, 'DOC-2'));
    expect(prepared.branch).toBe('DOC-2-newer');
    expect(prepared.needsBootstrap).toBe(true);
  });

  it('refuses issue-worktree isolation when nothing names a branch', async () => {
    const issue = makeIssue({ key: 'DOC-404', summary: 'Nothing here' });

    await expect(subject.prepare(issue, playbooks.issueWorktree)).rejects.toBeInstanceOf(
      NoBranchError,
    );
    await expect(subject.prepare(issue, playbooks.issueWorktree)).rejects.toThrow(
      /origin\/DOC-404-\*/,
    );
  });

  it('refuses a key that would escape the worktree directory', async () => {
    const issue = makeIssue({ key: '../../etc' });

    await expect(subject.prepare(issue, playbooks.worktree)).rejects.toBeInstanceOf(
      InvalidIssueKeyError,
    );
    expect(() => subject.worktreePath('DOC 1')).toThrow(InvalidIssueKeyError);
  });

  it('refuses to reuse a worktree whose HEAD is detached', async () => {
    const issue = makeIssue({ key: 'DOC-7', summary: 'Detached' });
    const path = join(worktreeDir, 'DOC-7');
    await run(['worktree', 'add', '--detach', path, 'main'], repo);

    try {
      await expect(subject.prepare(issue, playbooks.worktree)).rejects.toBeInstanceOf(
        DetachedWorktreeError,
      );
    } finally {
      // The fixture is shared by every test in this file, so the cleanup must
      // run even when the assertion above fails, or later tests fail too.
      await run(['worktree', 'remove', '--force', path], repo);
    }
  });

  it('refuses a key that is not a usable path segment even for shared isolation', async () => {
    // `shared` never builds a path, but the key still names the tmux session
    // and the session directory, so the gate is not the worktree path's alone.
    await expect(
      subject.prepare(makeIssue({ key: '../../etc' }), playbooks.shared),
    ).rejects.toBeInstanceOf(InvalidIssueKeyError);
  });
});

describe('GitRepo.prepare against a remote that moved', () => {
  let clone = '';
  let cloneWorktrees = '';
  let cloned: GitRepo;

  beforeEach(async () => {
    clone = join(root, `clone-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    cloneWorktrees = join(clone, '..', `clone-worktrees-${String(Math.random()).slice(2)}`);
    await run(['clone', join(root, 'origin.git'), clone], root);
    await run(['config', 'commit.gpgsign', 'false'], clone);
    cloned = new GitRepo(
      'docs',
      makeRepo({ path: clone, worktreeDir: cloneWorktrees, baseRef: 'origin/main' }),
    );
  });

  afterEach(async () => {
    await rm(clone, { recursive: true, force: true });
    await rm(cloneWorktrees, { recursive: true, force: true });
  });

  it('branches off the tip that was pushed after the clone, not the stale ref', async () => {
    await commitFile('after-clone.txt', '2026-07-01T00:00:00+0000');
    await run(['push', 'origin', 'main'], repo);
    const tip = (await run(['rev-parse', 'main'], repo)).trim();

    const prepared = await cloned.prepare(
      makeIssue({ key: 'DOC-50', summary: 'Fresh base' }),
      playbooks.worktree,
    );

    expect((await run(['rev-parse', 'HEAD'], prepared.cwd)).trim()).toBe(tip);
    expect(cloned.lastFetchError()).toBeNull();
  });

  it('reports the refs as unrefreshed before it has attempted a single fetch', async () => {
    // "nobody has checked" and "the refs are current" are different answers,
    // and the start dialog shows one of them as a warning.
    expect(cloned.lastFetchError()).toBe(NO_FETCH_YET_MESSAGE);
  });

  it('reuses a registered worktree offline, reporting the fetch failure instead', async () => {
    const issue = makeIssue({ key: 'DOC-51', summary: 'Already on disk' });
    await cloned.prepare(issue, playbooks.worktree);
    await run(['remote', 'set-url', 'origin', join(root, 'no-such-origin.git')], clone);

    const prepared = await cloned.prepare(issue, playbooks.worktree);

    expect(prepared.cwd).toBe(join(cloneWorktrees, 'DOC-51'));
    expect(prepared.needsBootstrap).toBe(false);
    expect(cloned.lastFetchError()).toEqual(expect.stringContaining('git fetch origin'));
  });

  it('gives up on a remote that never answers instead of holding the caller for ever', async () => {
    // `ext::` runs the command as the transport, so this is a fetch that
    // really hangs rather than one that is refused quickly. It is also the case
    // the process-group kill exists for: the transport is a separate process
    // that inherits git's pipes and outlives a signal sent to git alone.
    const timeoutMs = 500;
    const issue = makeIssue({ key: 'DOC-53', summary: 'Black hole' });
    await cloned.prepare(issue, playbooks.worktree);
    await run(['config', 'protocol.ext.allow', 'always'], clone);
    await run(['remote', 'set-url', 'origin', 'ext::sleep 30'], clone);
    const bounded = new GitRepo(
      'docs',
      makeRepo({ path: clone, worktreeDir: cloneWorktrees, baseRef: 'origin/main' }),
      { fetchTimeoutMs: timeoutMs },
    );

    const started = Date.now();
    const prepared = await bounded.prepare(issue, playbooks.worktree);
    const elapsed = Date.now() - started;

    // A multiple of the deadline, not a round number above the harness's own
    // `testTimeout`: an assertion the runner can never reach measures nothing.
    // The transport sleeps 30 s, so anything that waited for it fails here.
    expect(elapsed).toBeLessThan(timeoutMs * 12);
    expect(prepared.cwd).toBe(join(cloneWorktrees, 'DOC-53'));
    expect(bounded.lastFetchError()).toEqual(expect.stringContaining('timed out after 500 ms'));
  }, 20_000);

  it('leaves no transport process behind when it gives up on a remote', async () => {
    // `npm test` returning is not the same as the machine being quiet: without
    // a process group to kill, the transport lives out its own 30 s.
    const issue = makeIssue({ key: 'DOC-54', summary: 'Black hole, tidied' });
    await cloned.prepare(issue, playbooks.worktree);
    await run(['config', 'protocol.ext.allow', 'always'], clone);
    await run(['remote', 'set-url', 'origin', `ext::sleep ${String(SLEEP_SECONDS)}`], clone);
    const bounded = new GitRepo(
      'docs',
      makeRepo({ path: clone, worktreeDir: cloneWorktrees, baseRef: 'origin/main' }),
      { fetchTimeoutMs: 500 },
    );

    await bounded.prepare(issue, playbooks.worktree);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Anchored on the whole command line, so the shell that runs this probe —
    // whose own arguments name the same sleep — cannot count as a survivor.
    const survivors = await execFileAsync('bash', [
      '-c',
      `ps -eo args= | grep -c '^[^ ]*sleep ${String(SLEEP_SECONDS)}$' || true`,
    ]);
    expect(survivors.stdout.trim()).toBe('0');
  }, 20_000);

  it('fetches for issue-worktree isolation too, so a just-pushed branch resolves', async () => {
    await run(['checkout', '-b', 'DOC-52-pushed-late', 'main'], repo);
    await commitFile('late.txt', '2026-08-01T00:00:00+0000');
    await run(['push', 'origin', 'DOC-52-pushed-late'], repo);
    await run(['checkout', 'main'], repo);
    await run(['branch', '-D', 'DOC-52-pushed-late'], repo);

    const prepared = await cloned.prepare(
      makeIssue({ key: 'DOC-52', summary: 'Pushed late' }),
      playbooks.issueWorktree,
    );

    expect(prepared.branch).toBe('DOC-52-pushed-late');
  });
});

describe('git and gitAttempt', () => {
  it('throws a GitError naming the exact command, directory and exit code', async () => {
    const failure = git(['rev-parse', '--verify', 'refs/heads/no-such-branch'], repo);

    await expect(failure).rejects.toBeInstanceOf(GitError);
    const error = (await failure.catch((cause: unknown) => cause)) as GitError;
    expect(error.args).toEqual(['rev-parse', '--verify', 'refs/heads/no-such-branch']);
    expect(error.cwd).toBe(repo);
    expect(error.exitCode).not.toBeNull();
    expect(error.stderr).not.toBe('');
    expect(error.message).toContain('git rev-parse --verify refs/heads/no-such-branch');
  });

  it('reports the same failure as a result rather than a throw', async () => {
    const attempt = await gitAttempt(['rev-parse', '--verify', 'refs/heads/no-such-branch'], repo);

    expect(attempt.ok).toBe(false);
    expect(attempt.exitCode).not.toBe(0);
    expect(attempt.stderr).not.toBe('');
  });

  it('answers a successful command with both streams', async () => {
    const attempt = await gitAttempt(['rev-parse', '--abbrev-ref', 'HEAD'], repo);

    expect(attempt).toMatchObject({ ok: true, exitCode: 0 });
    expect(attempt.stdout.trim()).toBe('main');
  });

  it('renders a command line the way a person would type it', () => {
    expect(gitCommandLine(['worktree', 'add', '/path', 'branch'])).toBe(
      'git worktree add /path branch',
    );
  });
});

describe('GitRepo.findIssueBranch', () => {
  it('prefers a branch the caller already knows', async () => {
    await expect(subject.findIssueBranch('DOC-2', 'DOC-2-older')).resolves.toBe('DOC-2-older');
  });

  it('falls back to the remote scan when the known branch is gone', async () => {
    await expect(subject.findIssueBranch('DOC-2', 'DOC-2-vanished')).resolves.toBe('DOC-2-newer');
  });

  it('answers null when no remote branch matches', async () => {
    await expect(subject.findIssueBranch('DOC-404')).resolves.toBeNull();
  });
});

describe('GitRepo.listWorktrees and removeWorktree', () => {
  // A clone of its own, with the worktrees this describe asserts on and no
  // others: the exact list below only holds when nothing else in the file has
  // created or removed a worktree first.
  let own = '';
  let ownWorktrees = '';
  let target: GitRepo;

  beforeEach(async () => {
    const stamp = `${String(Date.now())}-${String(Math.random()).slice(2)}`;
    own = join(root, `worktrees-${stamp}`);
    ownWorktrees = join(root, `worktrees-${stamp}-checkouts`);
    await run(['clone', join(root, 'origin.git'), own], root);
    await run(['config', 'commit.gpgsign', 'false'], own);
    // The bare origin was initialised before its first push, so its HEAD names
    // git's default branch rather than the one every assertion here reads.
    await run(['checkout', '-B', 'main', 'origin/main'], own);
    target = new GitRepo(
      'docs',
      makeRepo({ path: own, worktreeDir: ownWorktrees, baseRef: 'origin/main' }),
    );
    await target.prepare(makeIssue(), playbooks.worktree);
    await target.prepare(
      makeIssue({ key: 'DOC-2', summary: 'Second thing' }),
      playbooks.issueWorktree,
    );
  });

  afterEach(async () => {
    await rm(own, { recursive: true, force: true });
    await rm(ownWorktrees, { recursive: true, force: true });
  });

  it('lists the main checkout alongside every issue worktree', async () => {
    const worktrees = await target.listWorktrees();

    expect(worktrees.map((worktree) => worktree.branch)).toEqual([
      'main',
      'DOC-1-document-the-thing',
      'DOC-2-newer',
    ]);
  });

  it('resolves one issue to its worktree', async () => {
    const worktree = await target.worktreeFor('DOC-2');

    expect(worktree?.branch).toBe('DOC-2-newer');
  });

  it('removes a clean worktree', async () => {
    await target.removeWorktree('DOC-2', false);

    expect(await target.worktreeFor('DOC-2')).toBeNull();
  });

  it('refuses a dirty worktree and reports the porcelain status', async () => {
    await writeFile(join(ownWorktrees, 'DOC-1', 'scratch.txt'), 'wip\n', 'utf8');

    const refusal = target.removeWorktree('DOC-1', false);

    await expect(refusal).rejects.toBeInstanceOf(DirtyWorktreeError);
    await expect(refusal).rejects.toThrow(/\?\? scratch\.txt/);
    // The message names the flag that gets past it, so an owner reading the
    // refusal knows what the second attempt has to say.
    await expect(refusal).rejects.toThrow(/--force/);
  });

  it('removes a dirty worktree when forced', async () => {
    await writeFile(join(ownWorktrees, 'DOC-1', 'scratch.txt'), 'wip\n', 'utf8');

    await target.removeWorktree('DOC-1', true);

    expect(await target.worktreeFor('DOC-1')).toBeNull();
  });

  it('refuses an issue that has no worktree', async () => {
    await expect(target.removeWorktree('DOC-404', false)).rejects.toBeInstanceOf(
      WorktreeNotFoundError,
    );
  });
});
