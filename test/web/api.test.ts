import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorResponse } from '../../src/core/api.js';
import {
  ApiError,
  errorHeadline,
  errorMessage,
  isForceableRemoval,
  removeWorktree,
} from '../../src/web/src/api.js';

/**
 * Answers the next fetch with one refusal body.
 *
 * @param status - HTTP status to answer with.
 * @param body - The error body, or a raw string for a response that is not JSON.
 * @returns Nothing.
 */
function refuseWith(status: number, body: ErrorResponse | string): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(text, { status, statusText: 'Conflict' })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isForceableRemoval', () => {
  it('offers to force only git’s dirty-tree refusal', () => {
    const dirty = new ApiError(
      409,
      'cannot remove /w/DOC-1',
      'has uncommitted changes',
      [],
      'dirty-worktree',
    );
    expect(isForceableRemoval(dirty)).toBe(true);
  });

  it('refuses to offer force for the refusals force cannot get past', () => {
    const liveSession = new ApiError(
      409,
      'qc-DOC-1 is still working in /w/DOC-1',
      'kill it',
      [],
      'session-live',
    );
    const mainCheckout = new ApiError(409, '/repo is the main checkout', null, [], 'main-checkout');
    expect(isForceableRemoval(liveSession)).toBe(false);
    expect(isForceableRemoval(mainCheckout)).toBe(false);
  });

  it('does not read force out of prose, which the server never writes', () => {
    const sniffable = new ApiError(409, 'cannot remove /w/DOC-1', 'use --force to delete it');
    expect(isForceableRemoval(sniffable)).toBe(false);
  });

  it('ignores a reason that arrives on any status but a 409', () => {
    expect(isForceableRemoval(new ApiError(500, 'boom', null, [], 'dirty-worktree'))).toBe(false);
  });

  it('ignores a value that is not an API refusal at all', () => {
    expect(isForceableRemoval(new Error('offline'))).toBe(false);
    expect(isForceableRemoval(null)).toBe(false);
    expect(isForceableRemoval('409')).toBe(false);
  });
});

describe('errorHeadline and errorMessage', () => {
  it('shows the server’s sentence on its own when there is no detail', () => {
    const error = new ApiError(409, 'cannot fetch DOC-1', null);
    expect(errorHeadline(error)).toBe('cannot fetch DOC-1');
    expect(errorMessage(error)).toBe('cannot fetch DOC-1');
  });

  it('adds the detail on its own line', () => {
    const error = new ApiError(409, 'cannot fetch DOC-1', 'jira: 503');
    expect(errorHeadline(error)).toBe('cannot fetch DOC-1\njira: 503');
  });

  it('adds one line per field problem, which the headline leaves out', () => {
    const error = new ApiError(400, 'Invalid workspace request', null, [
      { path: 'epic', message: 'epic must be an issue key' },
      { path: 'repo', message: "no repo has id ''" },
    ]);
    expect(errorHeadline(error)).toBe('Invalid workspace request');
    expect(errorMessage(error)).toBe(
      "Invalid workspace request\nepic: epic must be an issue key\nrepo: no repo has id ''",
    );
  });

  it('falls back to whatever was thrown when it is not an API refusal', () => {
    expect(errorMessage(new Error('the server is not running'))).toBe('the server is not running');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('reading a refusal off the wire', () => {
  it('carries the status, detail, issues and reason onto the error', async () => {
    refuseWith(409, {
      error: 'cannot remove /w/DOC-1',
      detail: '/w/DOC-1 has uncommitted changes; removing it needs force\n M a.ts',
      reason: 'dirty-worktree',
    });
    const caught = await removeWorktree('qc-DOC-1-implement', false).catch(
      (cause: unknown) => cause,
    );
    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.status).toBe(409);
    expect(error.message).toBe('cannot remove /w/DOC-1');
    expect(error.reason).toBe('dirty-worktree');
    expect(isForceableRemoval(error)).toBe(true);
  });

  it('reads no reason when the refusal named none', async () => {
    refuseWith(409, { error: 'qc-DOC-1 is already live' });
    const caught = (await removeWorktree('qc-DOC-1-implement', false).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(caught.reason).toBeNull();
    expect(caught.detail).toBeNull();
    expect(caught.issues).toEqual([]);
  });

  it('falls back to the status line when the body is empty or unreadable', async () => {
    refuseWith(409, '');
    const caught = (await removeWorktree('qc-DOC-1-implement', false).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(caught.message).toBe('409 Conflict');
  });
});
