import { describe, expect, it } from 'vitest';
import {
  newestBranch,
  parseRefNames,
  parseRemoteBranches,
  remoteBranchPattern,
  remoteOf,
  remoteRefPattern,
  stripRemote,
} from '../../src/connectors/workspaces/git/branches.js';
import { parseWorktreeList, shortBranch } from '../../src/connectors/workspaces/git/worktrees.js';

describe('parseWorktreeList', () => {
  it('reads path and branch out of every porcelain block', () => {
    const output = [
      'worktree /repos/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repos/worktrees/DOC-1',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/DOC-1-document-the-thing',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/worktrees/DOC-1', branch: 'DOC-1-document-the-thing' },
    ]);
  });

  it('reports a detached worktree with a null branch', () => {
    const output = [
      'worktree /repos/worktrees/DOC-2',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([{ path: '/repos/worktrees/DOC-2', branch: null }]);
  });

  it('skips a bare repository and keeps locked and prunable worktrees', () => {
    const output = [
      'worktree /repos/app.git',
      'bare',
      '',
      'worktree /repos/worktrees/DOC-3',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/DOC-3-thing',
      'locked',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repos/worktrees/DOC-3', branch: 'DOC-3-thing' },
    ]);
  });

  it('handles a final block with no trailing blank line', () => {
    const output = 'worktree /repos/app\nHEAD 5555555\nbranch refs/heads/main';
    expect(parseWorktreeList(output)).toEqual([{ path: '/repos/app', branch: 'main' }]);
  });

  it('answers an empty list for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('shortBranch', () => {
  it('strips refs/heads/ and leaves anything else alone', () => {
    expect(shortBranch('refs/heads/DOC-1-x')).toBe('DOC-1-x');
    expect(shortBranch('DOC-1-x')).toBe('DOC-1-x');
  });
});

describe('remoteOf', () => {
  it('takes the segment before the first slash', () => {
    expect(remoteOf('origin/main')).toBe('origin');
    expect(remoteOf('upstream/release/31.x')).toBe('upstream');
  });

  it('falls back to origin for a bare ref', () => {
    expect(remoteOf('main')).toBe('origin');
    expect(remoteOf('/main')).toBe('origin');
  });
});

describe('remoteBranchPattern and remoteRefPattern', () => {
  it('scope the search to one issue key', () => {
    expect(remoteBranchPattern('origin', 'DOC-3847')).toBe('origin/DOC-3847-*');
    expect(remoteRefPattern('origin', 'DOC-3847')).toBe('refs/remotes/origin/DOC-3847-*');
  });
});

describe('stripRemote', () => {
  it('removes only a matching remote prefix', () => {
    expect(stripRemote('origin/DOC-1-x', 'origin')).toBe('DOC-1-x');
    expect(stripRemote('upstream/DOC-1-x', 'origin')).toBe('upstream/DOC-1-x');
  });
});

describe('parseRemoteBranches', () => {
  it('trims the names and drops the remote prefix', () => {
    const output = '  origin/DOC-1-alpha\n  origin/DOC-1-beta\n';
    expect(parseRemoteBranches(output, 'origin')).toEqual(['DOC-1-alpha', 'DOC-1-beta']);
  });

  it('skips the symbolic HEAD entry', () => {
    const output = '  origin/HEAD -> origin/main\n  origin/DOC-1-alpha\n';
    expect(parseRemoteBranches(output, 'origin')).toEqual(['DOC-1-alpha']);
  });

  it('answers an empty list for empty output', () => {
    expect(parseRemoteBranches('\n', 'origin')).toEqual([]);
  });
});

describe('parseRefNames', () => {
  it('reads one short ref per line', () => {
    expect(parseRefNames('origin/DOC-1-beta\norigin/DOC-1-alpha\n', 'origin')).toEqual([
      'DOC-1-beta',
      'DOC-1-alpha',
    ]);
  });
});

describe('newestBranch', () => {
  it('picks the first candidate the committer-date order names', () => {
    expect(newestBranch(['DOC-1-alpha', 'DOC-1-beta'], ['DOC-1-beta', 'DOC-1-alpha'])).toBe(
      'DOC-1-beta',
    );
  });

  it('falls back to the first candidate when the ordering knows none of them', () => {
    expect(newestBranch(['DOC-1-alpha'], [])).toBe('DOC-1-alpha');
  });

  it('answers null when there are no candidates', () => {
    expect(newestBranch([], ['DOC-1-beta'])).toBeNull();
  });
});
