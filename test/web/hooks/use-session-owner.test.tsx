// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardView, PublicConfigResponse } from '../../../src/core/api.js';
import { useSessionOwner } from '../../../src/web/src/hooks/useSessionOwner.js';
import { boardListing, publicConfig } from '../fixtures.js';
import '../jsdom-gaps.js';

vi.mock('../../../src/web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web/src/api.js')>()),
  getBoard: vi.fn(),
}));

const { getBoard } = await import('../../../src/web/src/api.js');

/**
 * What one render of the hook reported.
 */
interface Reading {
  /** Whether the hook says a search is still in flight. */
  searching: boolean;
}

/**
 * Drives the hook and records what it reports on every render.
 *
 * @param props - Component props.
 * @param props.sessionId - Id of the session being shown.
 * @param props.config - Public configuration, or null before it loads.
 * @param props.board - Selected workspace's board, or null before it loads.
 * @param props.onSelectWorkspace - Called with the owning workspace's id.
 * @param props.readings - Array every render appends its reading to.
 * @returns Nothing rendered.
 */
function Probe({
  sessionId,
  config,
  board,
  onSelectWorkspace,
  readings,
}: {
  sessionId: string | null;
  config: PublicConfigResponse | null;
  board: BoardView | null;
  onSelectWorkspace: (workspaceId: string) => void;
  readings: Reading[];
}): null {
  const searching = useSessionOwner(sessionId, config, board, onSelectWorkspace);
  readings.push({ searching });
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSessionOwner', () => {
  it('settles the search even when a board frame lands while it is still running', async () => {
    // The board frame is debounced and arrives repeatedly. A re-run that
    // abandoned the search in flight would leave the view loading forever, with
    // a terminal attached to a session no board lists.
    let releaseOther: ((view: BoardView) => void) | null = null;
    vi.mocked(getBoard).mockImplementation(
      () =>
        new Promise<BoardView>((resolve) => {
          releaseOther = resolve;
        }),
    );
    const readings: Reading[] = [];
    const picked: string[] = [];
    const props = {
      sessionId: 'qc-DOC-9-implement',
      config: publicConfig(['docs', 'migration']),
      onSelectWorkspace: (id: string) => picked.push(id),
      readings,
    };
    const { rerender } = render(<Probe {...props} board={boardListing('docs', ['qc-DOC-1-x'])} />);
    expect(readings.at(-1)?.searching).toBe(true);

    // A second board frame for the same workspace: same answer, new object.
    rerender(<Probe {...props} board={boardListing('docs', ['qc-DOC-1-x'])} />);
    expect(readings.at(-1)?.searching).toBe(true);

    await act(async () => {
      releaseOther?.(boardListing('migration', ['qc-DOC-9-implement']));
    });
    expect(picked).toEqual(['migration']);
    expect(readings.at(-1)?.searching).toBe(false);
  });

  it('searches once per session, however many board frames arrive', async () => {
    vi.mocked(getBoard).mockResolvedValue(boardListing('migration', []));
    const readings: Reading[] = [];
    const props = {
      sessionId: 'qc-DOC-9-implement',
      config: publicConfig(['docs', 'migration']),
      onSelectWorkspace: () => {},
      readings,
    };
    const { rerender } = render(<Probe {...props} board={boardListing('docs', [])} />);
    await act(async () => {});
    rerender(<Probe {...props} board={boardListing('docs', [])} />);
    await act(async () => {});
    expect(vi.mocked(getBoard).mock.calls).toHaveLength(1);
    expect(readings.at(-1)?.searching).toBe(false);
  });

  it('says nothing is in flight for a session the selected board already lists', () => {
    vi.mocked(getBoard).mockResolvedValue(boardListing('migration', []));
    const readings: Reading[] = [];
    render(
      <Probe
        sessionId="qc-DOC-1-implement"
        config={publicConfig(['docs', 'migration'])}
        board={boardListing('docs', ['qc-DOC-1-implement'])}
        onSelectWorkspace={() => {}}
        readings={readings}
      />,
    );
    expect(readings.at(-1)?.searching).toBe(false);
    expect(vi.mocked(getBoard).mock.calls).toHaveLength(0);
  });

  it('stops waiting once a board comes to list the session, search or no search', async () => {
    vi.mocked(getBoard).mockImplementation(() => new Promise<BoardView>(() => {}));
    const readings: Reading[] = [];
    const props = {
      sessionId: 'qc-DOC-9-implement',
      config: publicConfig(['docs', 'migration']),
      onSelectWorkspace: () => {},
      readings,
    };
    const { rerender } = render(<Probe {...props} board={boardListing('docs', [])} />);
    expect(readings.at(-1)?.searching).toBe(true);
    rerender(<Probe {...props} board={boardListing('docs', ['qc-DOC-9-implement'])} />);
    expect(readings.at(-1)?.searching).toBe(false);
  });

  it('drops the answer to a search for a session the owner has navigated away from', async () => {
    // Both sessions are unlisted here, so the second starts a search of its
    // own: the first one's answer must not clear the flag that search owns,
    // nor switch the board to the workspace that owns a session off screen.
    const answers: Array<(view: BoardView) => void> = [];
    vi.mocked(getBoard).mockImplementation(
      () =>
        new Promise<BoardView>((resolve) => {
          answers.push(resolve);
        }),
    );
    const readings: Reading[] = [];
    const picked: string[] = [];
    const props = {
      config: publicConfig(['docs', 'migration']),
      board: boardListing('docs', []),
      onSelectWorkspace: (id: string) => picked.push(id),
      readings,
    };
    const { rerender } = render(<Probe {...props} sessionId="qc-DOC-9-implement" />);
    expect(readings.at(-1)?.searching).toBe(true);

    rerender(<Probe {...props} sessionId="qc-DOC-8-implement" />);
    expect(answers).toHaveLength(2);

    await act(async () => {
      answers[0]?.(boardListing('migration', ['qc-DOC-9-implement']));
    });
    expect(picked).toEqual([]);
    expect(readings.at(-1)?.searching).toBe(true);
  });

  it('does not switch the board for a session the owner has left for one this board lists', async () => {
    // The second session needs no search, so nothing else retires the first
    // one's: its answer would otherwise pull the board out from under a session
    // that is rendering perfectly well.
    const answers: Array<(view: BoardView) => void> = [];
    vi.mocked(getBoard).mockImplementation(
      () =>
        new Promise<BoardView>((resolve) => {
          answers.push(resolve);
        }),
    );
    const readings: Reading[] = [];
    const picked: string[] = [];
    const props = {
      config: publicConfig(['docs', 'migration']),
      onSelectWorkspace: (id: string) => picked.push(id),
      readings,
    };
    const { rerender } = render(
      <Probe {...props} sessionId="qc-DOC-9-implement" board={boardListing('docs', [])} />,
    );
    expect(readings.at(-1)?.searching).toBe(true);

    rerender(
      <Probe
        {...props}
        sessionId="qc-DOC-1-implement"
        board={boardListing('docs', ['qc-DOC-1-implement'])}
      />,
    );
    expect(readings.at(-1)?.searching).toBe(false);

    await act(async () => {
      answers[0]?.(boardListing('migration', ['qc-DOC-9-implement']));
    });
    expect(picked).toEqual([]);
    expect(readings.at(-1)?.searching).toBe(false);
  });

  it('is still searching after a board listed the session and then stopped', async () => {
    // A board frame that lists the session answers the question; a later one
    // that does not puts the question back, and the search started for it is
    // still running.
    vi.mocked(getBoard).mockImplementation(() => new Promise<BoardView>(() => {}));
    const readings: Reading[] = [];
    const props = {
      sessionId: 'qc-DOC-9-implement',
      config: publicConfig(['docs', 'migration']),
      onSelectWorkspace: () => {},
      readings,
    };
    const { rerender } = render(<Probe {...props} board={boardListing('docs', [])} />);
    expect(readings.at(-1)?.searching).toBe(true);

    rerender(<Probe {...props} board={boardListing('docs', ['qc-DOC-9-implement'])} />);
    expect(readings.at(-1)?.searching).toBe(false);

    rerender(<Probe {...props} board={boardListing('docs', [])} />);
    expect(readings.at(-1)?.searching).toBe(true);
    expect(vi.mocked(getBoard).mock.calls).toHaveLength(1);
  });

  it('searches a session a single-workspace configuration could not answer for', async () => {
    // Marking it searched without searching it means a workspace added while
    // the session route is open can never answer for the session on screen.
    vi.mocked(getBoard).mockResolvedValue(boardListing('migration', ['qc-DOC-9-implement']));
    const readings: Reading[] = [];
    const picked: string[] = [];
    const props = {
      sessionId: 'qc-DOC-9-implement',
      board: boardListing('docs', []),
      onSelectWorkspace: (id: string) => picked.push(id),
      readings,
    };
    const { rerender } = render(<Probe {...props} config={publicConfig(['docs'])} />);
    await act(async () => {});
    expect(vi.mocked(getBoard).mock.calls).toHaveLength(0);

    rerender(<Probe {...props} config={publicConfig(['docs', 'migration'])} />);
    await act(async () => {});
    expect(picked).toEqual(['migration']);
  });

  it('does not search before the board or the configuration has loaded', () => {
    const readings: Reading[] = [];
    render(
      <Probe
        sessionId="qc-DOC-9-implement"
        config={null}
        board={null}
        onSelectWorkspace={() => {}}
        readings={readings}
      />,
    );
    expect(readings.at(-1)?.searching).toBe(false);
    expect(vi.mocked(getBoard).mock.calls).toHaveLength(0);
  });
});
