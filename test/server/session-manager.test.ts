import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardView, CreateSessionRequest, EventFrame } from '../../src/core/api.js';
import type { Config } from '../../src/core/types.js';
import {
  ActionError,
  BOARD_DEBOUNCE_MS,
  SessionManager,
  readDerivedCacheTtlSeconds,
} from '../../src/server/session-manager.js';
import { Store } from '../../src/server/store.js';
import { makeIssue } from '../core/helpers.js';
import {
  FakeIssueSource,
  FakeRunner,
  FakeWorkspace,
  RecordingLogger,
  makeConfig,
} from './fakes.js';

const START: CreateSessionRequest = {
  playbookId: 'implement',
  prompt: 'Work on DOC-1',
  model: 'claude-fable-5-1',
  effort: 'high',
  permissionMode: 'acceptEdits',
};

/**
 * Everything one test needs to drive a manager over fakes.
 */
interface Harness {
  /** Temporary data directory. */
  dir: string;
  /** Validated configuration the manager runs on. */
  config: Config;
  /** Durable state. */
  store: Store;
  /** The manager under test. */
  manager: SessionManager;
  /** Runner the manager launches through. */
  runner: FakeRunner;
  /** Issue source the board is projected from. */
  source: FakeIssueSource;
  /** Workspace connector the checkouts come from. */
  workspace: FakeWorkspace;
  /** Diagnostics the manager wrote. */
  logger: RecordingLogger;
  /** Every editor launch the manager asked for. */
  editorCalls: Array<{ command: string; args: string[] }>;
  /** Current time in epoch milliseconds; assignable to advance the clock. */
  clock: { ms: number };
}

/**
 * Builds a manager over a temporary data directory and in-memory connectors.
 *
 * @returns The harness, with the first board already fetched.
 */
async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'qc-manager-'));
  const config = makeConfig(dir);
  const store = new Store(dir);
  await store.load();
  const source = new FakeIssueSource('ws', [makeIssue()]);
  const workspace = new FakeWorkspace('ws', {
    cwd: '/repos/worktrees/DOC-1',
    branch: 'DOC-1-document-the-thing',
    needsBootstrap: true,
  });
  const runner = new FakeRunner();
  const logger = new RecordingLogger();
  const editorCalls: Array<{ command: string; args: string[] }> = [];
  const clock = { ms: Date.parse('2026-09-09T12:00:00.000Z') };
  const workspaceConfig = config.workspaces['ws'];
  if (workspaceConfig === undefined) throw new Error('the test config lost its workspace');
  const manager = new SessionManager({
    config,
    store,
    runner,
    workspaces: [{ id: 'ws', config: workspaceConfig, issues: source, workspace }],
    derivedCacheTtlSeconds: 300,
    now: () => clock.ms,
    spawnEditor: (command, args) => editorCalls.push({ command, args }),
    logger,
  });
  await manager.refresh('ws');
  return { dir, config, store, manager, runner, source, workspace, logger, editorCalls, clock };
}

/**
 * Waits out one board debounce window.
 *
 * @returns Nothing, once every queued board frame has been pushed.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, BOARD_DEBOUNCE_MS + 20));
}

/**
 * Finds the lane a card sits in.
 *
 * @param view - Board view to search.
 * @param issueKey - Key of the card's issue.
 * @returns The lane id, or null when no lane holds the card.
 */
function laneOf(view: BoardView, issueKey: string): string | null {
  for (const column of view.columns) {
    if (column.cards.some((card) => card.issue.key === issueKey)) return column.id;
  }
  return null;
}

describe('SessionManager', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    h.manager.stop();
    await rm(h.dir, { recursive: true, force: true });
  });

  describe('startSession', () => {
    it('prepares a checkout, persists the record and launches the runner', async () => {
      const record = await h.manager.startSession('ws', 'DOC-1', START);

      expect(record.id).toBe('qc-DOC-1-implement');
      expect(record.state).toBe('starting');
      expect(record.runs).toEqual([]);
      expect(record.cwd).toBe('/repos/worktrees/DOC-1');
      expect(h.store.session('qc-DOC-1-implement')).toBeDefined();
      expect(h.store.worktree('ws', 'DOC-1')).toEqual({
        path: '/repos/worktrees/DOC-1',
        branch: 'DOC-1-document-the-thing',
        bootstrapped: false,
      });
      expect(h.runner.started[0]?.needsBootstrap).toBe(true);
      expect(h.runner.started[0]?.bootstrap).toBe('npm ci');
    });

    it('puts the issue in the Working lane', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      expect(laneOf(h.manager.board('ws'), 'DOC-1')).toBe('working');
    });

    it('refuses a second live session for the same issue and playbook', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toMatchObject({
        status: 409,
      });
    });

    it('refuses an unknown playbook, model, effort and permission mode', async () => {
      await expect(
        h.manager.startSession('ws', 'DOC-1', { ...START, playbookId: 'nope' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        h.manager.startSession('ws', 'DOC-1', { ...START, model: 'gpt' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        h.manager.startSession('ws', 'DOC-1', {
          ...START,
          effort: 'turbo' as CreateSessionRequest['effort'],
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        h.manager.startSession('ws', 'DOC-1', {
          ...START,
          permissionMode: 'yolo' as CreateSessionRequest['permissionMode'],
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("surfaces git's message when the checkout cannot be prepared", async () => {
      h.workspace.prepareError = new Error('fatal: branch DOC-1-x is already checked out');
      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toMatchObject({
        status: 409,
        detail: 'fatal: branch DOC-1-x is already checked out',
      });
      expect(h.store.session('qc-DOC-1-implement')).toBeUndefined();
    });

    it('marks the record failed when the runner refuses to launch', async () => {
      h.runner.startError = new Error('tmux: command not found');
      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toBeInstanceOf(
        ActionError,
      );
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('failed');
    });

    it('refuses an issue the source does not have', async () => {
      await expect(h.manager.startSession('ws', 'DOC-404', START)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('session actions', () => {
    it('refuses to resume a session that never reported a Claude session id', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await expect(h.manager.resumeSession('qc-DOC-1-implement')).rejects.toMatchObject({
        status: 409,
      });
    });

    it('resumes a session that has one', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'SessionStart', session_id: 'abc' } },
        {},
      );
      await h.manager.applyEvent('qc-DOC-1-implement', { type: 'claude-exit', exitCode: 0 }, {});

      const record = await h.manager.resumeSession('qc-DOC-1-implement');
      expect(record.state).toBe('starting');
      expect(record.endedAt).toBeNull();
      expect(h.runner.resumed).toHaveLength(1);
    });

    it('kills a session and closes its record', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const record = await h.manager.killSession('qc-DOC-1-implement');
      expect(record.state).toBe('exited');
      expect(record.endedAt).not.toBeNull();
      expect(h.runner.killed).toEqual(['qc-DOC-1-implement']);
    });

    it('interrupts a working session back to idle', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'UserPromptSubmit' } },
        {},
      );
      const record = await h.manager.interruptSession('qc-DOC-1-implement');
      expect(record.state).toBe('idle');
      expect(h.runner.interrupted).toEqual(['qc-DOC-1-implement']);
    });

    it('refuses to archive a live session and allows it once exited', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await expect(h.manager.archiveSession('qc-DOC-1-implement')).rejects.toMatchObject({
        status: 409,
      });
      await h.manager.killSession('qc-DOC-1-implement');
      expect((await h.manager.archiveSession('qc-DOC-1-implement')).archived).toBe(true);
    });

    it('toggles the done flag on a record', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      expect((await h.manager.setSessionDone('qc-DOC-1-implement', true)).done).toBe(true);
      expect((await h.manager.setSessionDone('qc-DOC-1-implement', false)).done).toBe(false);
    });

    it('answers 404 for an unknown session id', async () => {
      await expect(h.manager.killSession('qc-nope')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('removeWorktree', () => {
    it('refuses while a live session still uses the checkout', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await expect(h.manager.removeWorktree('qc-DOC-1-implement', false)).rejects.toMatchObject({
        status: 409,
      });
    });

    it('removes the checkout once the session has exited', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession('qc-DOC-1-implement');
      const result = await h.manager.removeWorktree('qc-DOC-1-implement', true);
      expect(result).toEqual({ path: '/repos/worktrees/DOC-1', removed: true });
      expect(h.workspace.removed).toEqual([{ issueKey: 'DOC-1', force: true }]);
      expect(h.store.worktree('ws', 'DOC-1')).toBeUndefined();
    });

    it("surfaces git's message when the tree is dirty", async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession('qc-DOC-1-implement');
      h.workspace.removeError = new Error('fatal: contains modified or untracked files');
      await expect(h.manager.removeWorktree('qc-DOC-1-implement', false)).rejects.toMatchObject({
        detail: 'fatal: contains modified or untracked files',
      });
    });
  });

  describe('flags and projection', () => {
    it('moves a flagged issue into the Review lane', async () => {
      expect(laneOf(h.manager.board('ws'), 'DOC-1')).toBe('backlog');
      expect(await h.manager.setFlags('ws', 'DOC-1', { review: true })).toEqual({ review: true });
      expect(laneOf(h.manager.board('ws'), 'DOC-1')).toBe('review');
    });

    it('keeps an issue that has a session but dropped out of the source list', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.source.issues = [];
      h.source.extra.set('DOC-1', makeIssue({ status: 'Done', statusCategory: 'done' }));

      const view = await h.manager.refresh('ws');
      expect(h.source.getCalls).toContain('DOC-1');
      expect(laneOf(view, 'DOC-1')).toBe('working');
    });

    it('keeps the last good list and reports the error when the source fails', async () => {
      h.source.listError = new Error('jira: 503');
      const view = await h.manager.refresh('ws');
      expect(view.sourceError).toBe('jira: 503');
      expect(view.columns.flatMap((column) => column.cards)).toHaveLength(1);
    });

    it('warns that the prefilled issue text may be stale after a failed refresh', async () => {
      h.source.listError = new Error('jira: 503');
      await h.manager.refresh('ws');
      const prefill = await h.manager.prefill('ws', 'DOC-1', 'implement');
      expect(prefill.prompt).toBe('Work on DOC-1');
      expect(prefill.warnings[0]).toContain('jira: 503');
    });

    it('answers 404 for an unknown workspace', () => {
      expect(() => h.manager.board('nope')).toThrow(ActionError);
    });
  });

  describe('open-editor', () => {
    it('refuses when the issue has no checkout', async () => {
      await expect(h.manager.openEditor('ws', 'DOC-1')).rejects.toMatchObject({ status: 409 });
    });

    it('spawns the configured editor on the checkout', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.openEditor('ws', 'DOC-1');
      expect(h.editorCalls).toEqual([{ command: 'code', args: ['/repos/worktrees/DOC-1'] }]);
    });
  });

  describe('reconciler', () => {
    it('marks a session that never launched claude as failed', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.runner.alive.clear();

      await h.manager.reconcile();
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('failed');
    });

    it('marks a session whose tmux session is gone as exited', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent('qc-DOC-1-implement', { type: 'claude-start', mode: 'start' }, {});
      h.runner.alive.clear();

      await h.manager.reconcile();
      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.state).toBe('exited');
      expect(record?.endedAt).not.toBeNull();
    });

    it('leaves a live session alone', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.reconcile();
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
    });
  });

  describe('fan-out', () => {
    it('pushes a session frame immediately and one debounced board frame', async () => {
      // The harness's first refresh already queued a board frame; letting it
      // land keeps this test measuring only the frames it causes itself.
      await settle();
      const frames: EventFrame[] = [];
      const unsubscribe = h.manager.subscribe((frame) => frames.push(frame));

      await h.manager.setFlags('ws', 'DOC-1', { review: true });
      await h.manager.setFlags('ws', 'DOC-1', { done: true });
      expect(frames.filter((frame) => frame.type === 'board')).toHaveLength(0);

      await settle();
      const boards = frames.filter((frame) => frame.type === 'board');
      expect(boards).toHaveLength(1);
      expect(boards[0]?.type === 'board' && boards[0].workspaceId).toBe('ws');
      unsubscribe();
    });

    it('pushes a session frame as soon as a record changes', async () => {
      await settle();
      const frames: EventFrame[] = [];
      const unsubscribe = h.manager.subscribe((frame) => frames.push(frame));

      await h.manager.startSession('ws', 'DOC-1', START);
      const sessions = frames.filter((frame) => frame.type === 'session');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.type === 'session' && sessions[0].record.id).toBe('qc-DOC-1-implement');
      unsubscribe();
    });
  });
});

describe('readDerivedCacheTtlSeconds', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qc-settings-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to five minutes when the settings file is missing', () => {
    expect(readDerivedCacheTtlSeconds(join(dir, 'settings.json'))).toBe(300);
  });

  it('reads one hour when the settings enable the long prompt cache', async () => {
    const path = join(dir, 'settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ env: { ENABLE_PROMPT_CACHING_1H: '1' } }), 'utf8');
    expect(readDerivedCacheTtlSeconds(path)).toBe(3600);
  });

  it('stays at five minutes when the flag is switched off', async () => {
    const path = join(dir, 'settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ env: { ENABLE_PROMPT_CACHING_1H: '0' } }), 'utf8');
    expect(readDerivedCacheTtlSeconds(path)).toBe(300);
  });
});
