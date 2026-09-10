import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardView } from '../../src/core/api.js';
import { findSessionOwner, lists } from '../../src/web/src/session-owner.js';
import { boardListing, boardView, card, cardSession } from './fixtures.js';

/**
 * Builds a reader over a fixed set of boards, recording what it was asked for.
 *
 * @param boards - Board per workspace id; a workspace named here answers, and
 * any other rejects the way an unknown workspace does.
 * @returns The reader and the ids it was asked for, in order.
 */
function reader(boards: Record<string, BoardView>): {
  read: (workspaceId: string) => Promise<BoardView>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    read: (workspaceId) => {
      asked.push(workspaceId);
      const board = boards[workspaceId];
      return board === undefined
        ? Promise.reject(new Error(`unknown workspace '${workspaceId}'`))
        : Promise.resolve(board);
    },
  };
}

describe('lists', () => {
  it('finds a session on any card of any lane', () => {
    const board = boardView('docs', [
      card('DOC-1', [cardSession('qc-DOC-1-implement')]),
      card('DOC-2', [cardSession('qc-DOC-2-implement'), cardSession('qc-DOC-2-verify')]),
    ]);
    expect(lists(board, 'qc-DOC-2-verify')).toBe(true);
  });

  it('says no for a session no card carries', () => {
    expect(lists(boardListing('docs', ['qc-DOC-1-implement']), 'qc-DOC-9-implement')).toBe(false);
    expect(lists(boardView('docs'), 'qc-DOC-1-implement')).toBe(false);
  });
});

describe('findSessionOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the workspace whose board lists the session', async () => {
    const { read } = reader({
      migration: boardListing('migration', ['qc-DOC-9-implement']),
      archive: boardListing('archive', ['qc-DOC-7-implement']),
    });
    await expect(
      findSessionOwner('qc-DOC-7-implement', ['migration', 'archive'], read),
    ).resolves.toBe('archive');
  });

  it('stops reading boards once one has answered', async () => {
    const { read, asked } = reader({
      migration: boardListing('migration', ['qc-DOC-9-implement']),
      archive: boardListing('archive', ['qc-DOC-9-implement']),
    });
    await findSessionOwner('qc-DOC-9-implement', ['migration', 'archive'], read);
    expect(asked).toEqual(['migration']);
  });

  it('keeps going past a workspace whose source is unreachable', async () => {
    const { read, asked } = reader({ archive: boardListing('archive', ['qc-DOC-7-implement']) });
    await expect(
      findSessionOwner('qc-DOC-7-implement', ['down', 'archive'], read),
    ).resolves.toBe('archive');
    expect(asked).toEqual(['down', 'archive']);
  });

  it('answers null when every board it could read ruled the session out', async () => {
    const { read } = reader({
      migration: boardListing('migration', ['qc-DOC-9-implement']),
      archive: boardListing('archive', ['qc-DOC-7-implement']),
    });
    await expect(
      findSessionOwner('qc-DOC-1-implement', ['migration', 'archive'], read),
    ).resolves.toBeNull();
  });

  it('gives up on a board that never answers, rather than searching forever', async () => {
    const asked: string[] = [];
    const search = findSessionOwner(
      'qc-DOC-7-implement',
      ['hung'],
      (workspaceId) => {
        asked.push(workspaceId);
        return new Promise<BoardView>(() => {});
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(search).resolves.toBeNull();
    expect(asked).toEqual(['hung']);
  });

  it('spends the budget across the whole search, not once per workspace', async () => {
    const asked: string[] = [];
    const search = findSessionOwner(
      'qc-DOC-7-implement',
      ['hung', 'archive'],
      (workspaceId) => {
        asked.push(workspaceId);
        return new Promise<BoardView>(() => {});
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(search).resolves.toBeNull();
    // The second workspace is never asked: the first spent the budget, and a
    // per-workspace budget would have let one hung tracker hold the session
    // view in "loading" for as many workspaces as there are.
    expect(asked).toEqual(['hung']);
  });

  it('reads nothing when there is nowhere to look', async () => {
    const { read, asked } = reader({});
    await expect(findSessionOwner('qc-DOC-7-implement', [], read)).resolves.toBeNull();
    expect(asked).toEqual([]);
  });
});
