import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardView, CreateSessionRequest, EventFrame } from '../../src/core/api.js';
import type { Config, SessionRecord } from '../../src/core/types.js';
import { JiraTruncatedError } from '../../src/connectors/issues/jira/client.js';
import { MissingExecutableError } from '../../src/connectors/runners/claude-tmux/index.js';
import {
  ActionError,
  BOARD_DEBOUNCE_MS,
  RECONCILE_INTERVAL_MS,
  SessionManager,
  checkoutKey,
  detachedEditorSpawner,
  readDerivedCacheTtlSeconds,
  spawnDetached,
} from '../../src/server/session-manager.js';
import { Store } from '../../src/server/store.js';
import { makeIssue, makePlaybook } from '../core/helpers.js';
import {
  FakeIssueSource,
  FakeRepo,
  FakeRunner,
  RecordingLogger,
  makeConfig,
  makeRuntime,
} from './fakes.js';

const START: CreateSessionRequest = {
  playbookId: 'implement',
  prompt: 'Work on DOC-1',
  model: 'claude-fable-5-1',
  effort: 'high',
  permissionMode: 'acceptEdits',
};

/**
 * Store that can be told to yield between reading a record and writing it, so a
 * test can interleave two read-modify-write sequences on purpose.
 */
class InterleavingStore extends Store {
  /** Whether every save should yield to the microtask queue first. */
  slowSave = false;

  /**
   * Saves a record, optionally yielding first.
   *
   * @param record - The record to store.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  override async saveSession(record: SessionRecord): Promise<void> {
    if (this.slowSave) await Promise.resolve();
    await super.saveSession(record);
  }
}

/**
 * Everything one test needs to drive a manager over fakes.
 */
interface Harness {
  /** Temporary data directory. */
  dir: string;
  /** Validated configuration the manager runs on. */
  config: Config;
  /** Durable state. */
  store: InterleavingStore;
  /** The manager under test. */
  manager: SessionManager;
  /** Runner the manager launches through. */
  runner: FakeRunner;
  /** Issue source the board is projected from. */
  source: FakeIssueSource;
  /** Repo connector the checkouts come from. */
  repo: FakeRepo;
  /** Diagnostics the manager wrote. */
  logger: RecordingLogger;
  /** Every editor launch the manager asked for. */
  editorCalls: Array<{ command: string; args: string[]; onError: (error: Error) => void }>;
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
  const store = new InterleavingStore(dir);
  await store.load();
  const source = new FakeIssueSource('ws', [makeIssue()]);
  const repo = new FakeRepo('app', {
    cwd: '/repos/worktrees/DOC-1',
    branch: 'DOC-1-document-the-thing',
    needsBootstrap: true,
  });
  const runner = new FakeRunner();
  const logger = new RecordingLogger();
  const editorCalls: Harness['editorCalls'] = [];
  const clock = { ms: Date.parse('2026-09-09T12:00:00.000Z') };
  const manager = new SessionManager({
    config,
    configPath: join(dir, 'config.json'),
    store,
    runner,
    workspaces: [makeRuntime(config, 'ws', source, repo)],
    createRuntime: (next, workspaceId) => makeRuntime(next, workspaceId, source, repo),
    derivedCacheTtlSeconds: 300,
    now: () => clock.ms,
    spawnEditor: (command, args, onError) => editorCalls.push({ command, args, onError }),
    logger,
  });
  await manager.refresh('ws');
  return { dir, config, store, manager, runner, source, repo, logger, editorCalls, clock };
}

/**
 * Runs out one board debounce window on the fake clock.
 *
 * @returns Nothing, once every queued board frame has been pushed.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(BOARD_DEBOUNCE_MS);
}

/**
 * Gives the event loop enough real turns for any unblocked work — including
 * the store's file writes — to run to completion.
 *
 * A concurrency test asserts that something has *not* happened, so it needs an
 * upper bound on what would have happened had the lock not been there.
 *
 * @param turns - Event-loop turns to yield.
 * @returns Nothing.
 */
async function drain(turns = 200): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Yields the event loop until a condition holds.
 *
 * @param condition - What the test is waiting for.
 * @param label - Named in the failure when the condition never holds.
 * @returns Nothing.
 * @throws {Error} When the condition still does not hold after five seconds.
 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  // Wall clock on a machine running the whole suite in parallel workers: the
  // bound exists to name the failure, not to measure how fast the work was.
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Builds a promise a test releases by hand.
 *
 * @returns The promise and the function that resolves it.
 */
function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
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
    // The board debounce and the poll interval are the only timers here, and
    // both are the subject of assertions: waiting them out on the real clock
    // costs a second of wall time and buys a flake window. `setImmediate` and
    // `Date` stay real, so `drain` can still give the event loop real turns.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    h = await harness();
  });

  afterEach(async () => {
    h.manager.stop();
    vi.useRealTimers();
    await rm(h.dir, { recursive: true, force: true });
  });

  describe('startSession', () => {
    it('prepares a checkout, persists the record and launches the runner', async () => {
      const record = await h.manager.startSession('ws', 'DOC-1', START);

      expect(record.id).toBe('qc-DOC-1-implement');
      expect(record.state).toBe('starting');
      expect(record.runs).toEqual([]);
      expect(record.cwd).toBe('/repos/worktrees/DOC-1');
      expect(h.store.session('qc-DOC-1-implement')).toMatchObject({
        state: 'starting',
        issueKey: 'DOC-1',
        playbookId: 'implement',
        cwd: '/repos/worktrees/DOC-1',
      });
      expect(h.store.worktree('app', 'DOC-1')).toEqual({
        path: '/repos/worktrees/DOC-1',
        branch: 'DOC-1-document-the-thing',
      });
      expect(h.runner.started[0]?.needsBootstrap).toBe(true);
      expect(h.runner.started[0]?.bootstrap).toBe('npm ci');
    });

    it('puts the issue in the Working lane', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      expect(laneOf(h.manager.board('ws'), 'DOC-1')).toBe('working');
    });

    it('names the clash as a live session so a UI need not read the prose', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);

      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toMatchObject({
        status: 409,
        reason: 'session-live',
      });
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
      h.repo.prepareError = new Error('fatal: branch DOC-1-x is already checked out');
      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toMatchObject({
        status: 409,
        detail: 'fatal: branch DOC-1-x is already checked out',
      });
      expect(h.store.session('qc-DOC-1-implement')).toBeUndefined();
    });

    it('marks the record failed when the runner refuses to launch', async () => {
      // The record can move while the launch runs, so the failure is written
      // over a re-read; patching the caller's snapshot would drop it.
      h.runner.start = async (request) => {
        h.runner.started.push(request);
        await h.store.saveSession({ ...request.record, claudeSessionId: 'abc-123' });
        throw new Error('tmux: command not found');
      };

      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toBeInstanceOf(
        ActionError,
      );

      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.state).toBe('failed');
      expect(record?.claudeSessionId).toBe('abc-123');
    });

    it('carries the runner’s machine-readable reason onto the refusal', async () => {
      h.runner.startError = new MissingExecutableError('claude');

      await expect(h.manager.startSession('ws', 'DOC-1', START)).rejects.toMatchObject({
        status: 409,
        reason: 'missing-executable',
      });
    });

    it('refuses an issue the source does not have', async () => {
      await expect(h.manager.startSession('ws', 'DOC-404', START)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses the loser of two simultaneous starts instead of clobbering the winner', async () => {
      const [first, second] = await Promise.allSettled([
        h.manager.startSession('ws', 'DOC-1', START),
        h.manager.startSession('ws', 'DOC-1', START),
      ]);

      const outcomes = [first?.status, second?.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
      expect(h.runner.started).toHaveLength(1);
      expect(h.store.sessions()).toHaveLength(1);
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
    });

    it('starts the same playbook again under a new id rather than over the old record', async () => {
      const first = await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession(first.id);
      await h.manager.archiveSession(first.id);
      h.clock.ms += 60_000;

      const second = await h.manager.startSession('ws', 'DOC-1', START);

      expect(second.id).not.toBe(first.id);
      expect(second.id.startsWith(`${first.id}-`)).toBe(true);
      expect(h.store.session(first.id)?.archived).toBe(true);
      expect(h.store.sessions()).toHaveLength(2);
    });

    it('does not register the main checkout as a worktree for a shared playbook', async () => {
      h.repo.result = { cwd: '/repos/app', branch: null, needsBootstrap: false };
      const config = h.config.repos['app'];
      config?.playbooks.push(
        makePlaybook({ id: 'triage', label: 'Triage', isolation: 'shared', primaryFor: [] }),
      );

      await h.manager.startSession('ws', 'DOC-1', { ...START, playbookId: 'triage' });

      expect(h.store.worktree('app', 'DOC-1')).toBeUndefined();
    });

    it('hands the repo the branch of the newest record for the issue', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      expect(h.repo.prepared[0]?.hints).toEqual({ knownBranch: null });

      await h.manager.killSession('qc-DOC-1-implement');
      await h.manager.startSession('ws', 'DOC-1', { ...START, playbookId: 'test' });
      expect(h.repo.prepared[1]?.hints).toEqual({ knownBranch: 'DOC-1-document-the-thing' });
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

    it('carries the runner’s machine-readable reason onto a refused resume', async () => {
      // Start and resume both probe the CLI, so `missing-executable` is
      // reachable on either; a UI that branches on the reason needs both.
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'SessionStart', session_id: 'abc' } },
        {},
      );
      h.runner.resumeError = new MissingExecutableError('claude');

      await expect(h.manager.resumeSession('qc-DOC-1-implement')).rejects.toMatchObject({
        status: 409,
        reason: 'missing-executable',
      });
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

    it('answers 404 for an unknown session id without asking the runner to kill it', async () => {
      await expect(h.manager.killSession('qc-nope')).rejects.toMatchObject({ status: 404 });
      expect(h.runner.killed).toEqual([]);
    });

    it('answers 404 for the event log of an unknown session id', async () => {
      await expect(h.manager.sessionEvents('qc-nope')).rejects.toMatchObject({ status: 404 });
    });

    it('leaves a record exited when the runner refuses the resume', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'SessionStart', session_id: 'abc' } },
        {},
      );
      await h.manager.killSession('qc-DOC-1-implement');
      h.runner.resumeError = new Error('tmux: no server running');

      await expect(h.manager.resumeSession('qc-DOC-1-implement')).rejects.toMatchObject({
        status: 409,
        detail: 'tmux: no server running',
      });

      // The runner is asked before the record moves, so a refusal costs nothing.
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('exited');
    });

    it('refreshes the board when a session leaves the live set', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const before = h.source.listCalls;

      await h.manager.killSession('qc-DOC-1-implement');

      expect(h.source.listCalls).toBeGreaterThan(before);
    });

    it('applies two events for one session without either losing the other', async () => {
      // Both land inside the same read-modify-write window; without the lock the
      // second write is built on a snapshot that predates the first.
      await h.manager.startSession('ws', 'DOC-1', START);
      h.store.slowSave = true;

      await Promise.all([
        h.manager.applyEvent(
          'qc-DOC-1-implement',
          { type: 'hook', hook: { hook_event_name: 'SessionStart', session_id: 'abc' } },
          {},
        ),
        h.manager.applyEvent(
          'qc-DOC-1-implement',
          { type: 'hook', hook: { hook_event_name: 'UserPromptSubmit' } },
          {},
        ),
      ]);

      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.claudeSessionId).toBe('abc');
      expect(record?.state).toBe('working');
    });

    it('does not save or broadcast an event the reducer ignored', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const frames: EventFrame[] = [];
      h.manager.subscribe((frame) => frames.push(frame));

      // `bootstrap-failed` only applies to a bootstrapping record.
      await h.manager.applyEvent('qc-DOC-1-implement', { type: 'bootstrap-failed' }, {});

      expect(frames.filter((frame) => frame.type === 'session')).toEqual([]);
    });

    it('keeps delivering a frame to the other subscribers when one of them throws', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const delivered: EventFrame[] = [];
      h.manager.subscribe(() => {
        throw new Error('socket is gone');
      });
      h.manager.subscribe((frame) => delivered.push(frame));

      await expect(h.manager.setSessionDone('qc-DOC-1-implement', true)).resolves.toMatchObject({
        done: true,
      });

      expect(delivered.some((frame) => frame.type === 'session')).toBe(true);
      expect(h.logger.lines.join('\n')).toContain('subscriber threw');
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
      expect(result).toEqual({ path: '/repos/worktrees/DOC-1' });
      expect(h.repo.removed).toEqual([{ issueKey: 'DOC-1', force: true }]);
      expect(h.store.worktree('app', 'DOC-1')).toBeUndefined();
    });

    it("surfaces git's message when the tree is dirty", async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession('qc-DOC-1-implement');
      h.repo.removeError = new Error('fatal: contains modified or untracked files');
      await expect(h.manager.removeWorktree('qc-DOC-1-implement', false)).rejects.toMatchObject({
        detail: 'fatal: contains modified or untracked files',
      });
    });

    it('passes the caller’s force choice through rather than always forcing', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession('qc-DOC-1-implement');

      await h.manager.removeWorktree('qc-DOC-1-implement', false);

      expect(h.repo.removed).toEqual([{ issueKey: 'DOC-1', force: false }]);
    });

    it("refuses to remove the repo's main checkout, which a shared session runs in", async () => {
      h.repo.result = { cwd: '/repos/app', branch: null, needsBootstrap: false };
      h.config.repos['app']?.playbooks.push(
        makePlaybook({ id: 'triage', label: 'Triage', isolation: 'shared', primaryFor: [] }),
      );
      const record = await h.manager.startSession('ws', 'DOC-1', {
        ...START,
        playbookId: 'triage',
      });
      await h.manager.killSession(record.id);

      await expect(h.manager.removeWorktree(record.id, true)).rejects.toMatchObject({
        status: 409,
        reason: 'main-checkout',
      });
      expect(h.repo.removed).toEqual([]);
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

    it('clears the banner once the source answers again', async () => {
      h.source.listError = new Error('jira: 503');
      await h.manager.refresh('ws');
      h.source.listError = null;
      h.clock.ms += 1000;

      expect((await h.manager.refresh('ws')).sourceError).toBeNull();
    });

    it('keeps the session-only issues it already has while the source is down', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.source.issues = [];
      h.clock.ms += 1000;
      await h.manager.refresh('ws');
      const before = h.source.getCalls.length;
      h.source.listError = new Error('jira: 503');
      h.clock.ms += 1000;

      await h.manager.refresh('ws');

      expect(h.source.getCalls).toHaveLength(before);
    });

    it('warns that the prefilled issue text may be stale after a failed refresh', async () => {
      h.source.listError = new Error('jira: 503');
      await h.manager.refresh('ws');
      const prefill = await h.manager.prefill('ws', 'DOC-1', 'implement');
      expect(prefill.prompt).toBe('Work on DOC-1');
      expect(prefill.warnings).toEqual([expect.stringContaining('jira: 503')]);
    });

    it('warns that the repo refs may be stale when the last fetch failed', async () => {
      h.repo.fetchError = 'git fetch origin exited 128 in /repos/app';

      const prefill = await h.manager.prefill('ws', 'DOC-1', 'implement');

      expect(prefill.warnings).toEqual([
        expect.stringContaining('git fetch origin exited 128 in /repos/app'),
      ]);
    });

    it('refuses to prefill an issue key that is not a usable path segment', async () => {
      h.source.extra.set('../../etc', makeIssue({ key: '../../etc' }));
      h.repo.rejectedKeys.add('../../etc');

      await expect(h.manager.prefill('ws', '../../etc', 'implement')).rejects.toMatchObject({
        status: 400,
      });
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
      expect(h.editorCalls).toMatchObject([{ command: 'code', args: ['/repos/worktrees/DOC-1'] }]);
    });

    it('logs a launch that fails after the call has answered', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.openEditor('ws', 'DOC-1');
      h.editorCalls[0]?.onError(new Error('spawn code ENOENT'));
      expect(h.logger.lines).toContainEqual(
        'error: cannot open /repos/worktrees/DOC-1 in code: spawn code ENOENT',
      );
    });
  });

  describe('spawnDetached', () => {
    it('reports a missing executable instead of crashing the process', async () => {
      const reported = new Promise<Error>((resolve) => {
        spawnDetached('qc-no-such-editor', ['/tmp'], resolve);
      });
      // Without the deadline a missing `error` listener shows up as a suite
      // timeout, which names the runner rather than the missing listener.
      const deadline = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('spawnDetached never reported the failure')), 2000);
      });

      const error = await Promise.race([reported, deadline]);

      expect(error.message).toContain('qc-no-such-editor');
    });

    it('detaches the child, so an open editor window cannot hold the dashboard up', () => {
      const calls: string[] = [];
      const spawner = detachedEditorSpawner(() => ({
        on: (event: 'error') => calls.push(`on:${event}`),
        unref: () => calls.push('unref'),
      }));

      spawner('code', ['/repos/worktrees/DOC-1'], () => undefined);

      expect(calls).toEqual(['on:error', 'unref']);
    });
  });

  describe('reconciler', () => {
    it('marks a session that never launched claude as failed', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.runner.alive.clear();
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('failed');
    });

    it('leaves a record whose launcher has not reported yet alone for one pass', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.runner.alive.clear();

      await h.manager.reconcile();
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
    });

    it('marks a session whose tmux session is gone as exited', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent('qc-DOC-1-implement', { type: 'claude-start', mode: 'start' }, {});
      h.runner.alive.clear();
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();
      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.state).toBe('exited');
      expect(record?.endedAt).not.toBeNull();
      expect(record?.stateSince).toBe(new Date(h.clock.ms).toISOString());
    });

    it('leaves a session the runner still reports alive alone, having asked', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.clock.ms += RECONCILE_INTERVAL_MS;
      const probed: string[] = [];
      h.runner.isAlive = async (sessionId: string) => {
        probed.push(sessionId);
        return true;
      };

      await h.manager.reconcile();

      expect(probed).toEqual(['qc-DOC-1-implement']);
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
    });

    it('leaves a record whose state changed within one interval alone, mid-resume', async () => {
      // A resume kills and recreates the tmux session; a pass that lands in
      // that gap would read it as a death and flicker the card to Exited.
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.applyEvent('qc-DOC-1-implement', { type: 'claude-start', mode: 'start' }, {});
      h.runner.alive.clear();

      await h.manager.reconcile();

      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
    });

    it('flags a live record that predates this server start rather than guessing its state', async () => {
      // Its hooks were posted at a dead port and are gone; the state on the
      // card is the state it had when the last server died.
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();

      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.state).toBe('starting');
      expect(record?.staleSince).not.toBeNull();
    });

    it('leaves a record started under this server unflagged', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();

      expect(h.store.session('qc-DOC-1-implement')?.staleSince).toBeNull();
    });

    it('lets the session’s next event clear the flag', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      h.clock.ms += RECONCILE_INTERVAL_MS;
      await h.manager.reconcile();

      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'UserPromptSubmit' } },
        {},
      );

      expect(h.store.session('qc-DOC-1-implement')?.staleSince).toBeNull();
    });

    it('survives a probe that throws, leaving the record and naming it in the log', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.clock.ms += RECONCILE_INTERVAL_MS;
      h.runner.isAlive = async () => {
        throw new Error('tmux is not on PATH');
      };

      await expect(h.manager.reconcile()).resolves.toBeUndefined();

      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('starting');
      expect(h.logger.lines.join('\n')).toContain('cannot probe qc-DOC-1-implement');
    });
  });

  describe('workspaces', () => {
    const ADD = {
      id: 'second',
      name: 'Second',
      epic: 'DOC-900',
      repo: 'app',
      connector: 'tracker',
    };

    it('adds a workspace, writes the file and serves its board', async () => {
      const summary = await h.manager.addWorkspace(ADD);

      expect(summary).toEqual({
        id: 'second',
        name: 'Second',
        epic: 'DOC-900',
        repo: 'app',
        connector: 'tracker',
      });
      expect(h.manager.workspaceIds()).toEqual(['ws', 'second']);
      expect(h.manager.board('second').workspaceId).toBe('second');
      const written = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8')) as Config;
      expect(Object.keys(written.workspaces)).toEqual(['ws', 'second']);
    });

    it('shows the same sessions on two workspaces over one repo', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.addWorkspace(ADD);
      await h.manager.refresh('second');

      expect(laneOf(h.manager.board('second'), 'DOC-1')).toBe('working');
    });

    it('refuses a duplicate id without touching the file', async () => {
      await expect(h.manager.addWorkspace({ ...ADD, id: 'ws' })).rejects.toMatchObject({
        name: 'ConfigError',
      });
      await expect(readFile(join(h.dir, 'config.json'), 'utf8')).rejects.toThrow();
    });

    it('removes a workspace and keeps its sessions and worktrees', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.addWorkspace(ADD);

      await h.manager.removeWorkspace('second');

      expect(h.manager.workspaceIds()).toEqual(['ws']);
      expect(h.store.session('qc-DOC-1-implement')).toMatchObject({
        issueKey: 'DOC-1',
        state: 'starting',
      });
      expect(h.store.worktree('app', 'DOC-1')).toEqual({
        path: '/repos/worktrees/DOC-1',
        branch: 'DOC-1-document-the-thing',
      });
      expect(() => h.manager.board('second')).toThrow(ActionError);
    });

    it('answers 404 when removing an unknown workspace', async () => {
      await expect(h.manager.removeWorkspace('ghost')).rejects.toMatchObject({ status: 404 });
    });

    it('takes an inline connector with the workspace that was its only user', async () => {
      // Nothing else can remove a connector: there is no route and no control,
      // so one left behind is permanent and warns on every boot.
      await h.manager.addWorkspace({
        id: 'ops',
        name: 'Ops',
        epic: 'OPS-1',
        repo: 'app',
        newConnector: {
          id: 'ops-jira',
          site: 'ops.atlassian.net',
          emailEnv: 'OPS_EMAIL',
          tokenEnv: 'OPS_TOKEN',
        },
      });
      expect(h.manager.publicConfig().connectors.map((entry) => entry.id)).toContain('ops-jira');

      await h.manager.removeWorkspace('ops');

      expect(h.manager.publicConfig().connectors.map((entry) => entry.id)).toEqual(['tracker']);
      const written = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8')) as Config;
      expect(Object.keys(written.connectors)).toEqual(['tracker']);
    });

    it('keeps a connector another workspace still uses', async () => {
      await h.manager.addWorkspace(ADD);

      await h.manager.removeWorkspace('second');

      expect(h.manager.publicConfig().connectors.map((entry) => entry.id)).toEqual(['tracker']);
    });

    it('keeps both of two simultaneous additions, which rewrite one file', async () => {
      // Each addition serialises the whole configuration; without the lock the
      // second write is built on the document the first one had not saved yet.
      await Promise.all([
        h.manager.addWorkspace(ADD),
        h.manager.addWorkspace({ ...ADD, id: 'third', name: 'Third', epic: 'DOC-901' }),
      ]);

      const written = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8')) as Config;
      expect(Object.keys(written.workspaces).sort()).toEqual(['second', 'third', 'ws']);
    });

    it('warns about credentials the environment does not supply for a new workspace', async () => {
      await h.manager.addWorkspace({
        name: 'Ops',
        epic: 'OPS-1',
        repo: 'app',
        newConnector: {
          id: 'ops',
          site: 'ops.atlassian.net',
          emailEnv: 'QC_TEST_MISSING_EMAIL',
          tokenEnv: 'QC_TEST_MISSING_TOKEN',
        },
      });

      expect(h.logger.lines.join('\n')).toContain('QC_TEST_MISSING_EMAIL');
    });

    it('pushes a config frame on both changes', async () => {
      await settle();
      const frames: EventFrame[] = [];
      const unsubscribe = h.manager.subscribe((frame) => frames.push(frame));

      await h.manager.addWorkspace(ADD);
      await h.manager.removeWorkspace('second');
      unsubscribe();

      const configs = frames.filter((frame) => frame.type === 'config');
      expect(configs.map((frame) => frame.config.workspaces.map((entry) => entry.id))).toEqual([
        ['ws', 'second'],
        ['ws'],
      ]);
    });
  });

  describe('locks', () => {
    it('holds a hook for a suffixed second run until its launch has finished', async () => {
      // The second run takes a suffixed id, which is not the key the start
      // already holds; without a lock on that id the launch write and the
      // hook's read-modify-write overlap and one of them loses.
      const first = await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession(first.id);
      await h.manager.archiveSession(first.id);
      h.clock.ms += 60_000;
      const { held, release } = gate();
      let secondId = '';
      h.runner.start = async (request) => {
        secondId = request.record.id;
        h.runner.started.push(request);
        h.runner.alive.add(request.record.id);
        await held;
      };

      const launch = h.manager.startSession('ws', 'DOC-1', START);
      await waitFor(() => secondId !== '', 'the second run to reach the runner');
      let applied = false;
      const hook = h.manager
        .applyEvent(
          secondId,
          { type: 'hook', hook: { hook_event_name: 'SessionStart', session_id: 'from-hook' } },
          {},
        )
        .then(() => {
          applied = true;
        });
      await drain();

      expect(applied).toBe(false);

      release();
      await Promise.all([launch, hook]);
      expect(h.store.session(secondId)?.claudeSessionId).toBe('from-hook');
    });

    it('does not hold the checkout lock across the tracker fetch', async () => {
      // The tracker is a remote with its own deadline, and nothing in the
      // critical section depends on the issue being read inside it: a slow
      // tracker must not queue every removal of the same checkout behind it.
      await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession('qc-DOC-1-implement');
      await h.manager.archiveSession('qc-DOC-1-implement');
      h.clock.ms += 60_000;
      // Emptied and refetched, so the start has to reach the tracker for the
      // issue rather than answering out of the workspace's cache.
      h.source.issues = [];
      await h.manager.refresh('ws');
      const { held, release } = gate();
      let fetching = false;
      h.source.get = async (key: string) => {
        fetching = true;
        h.source.getCalls.push(key);
        await held;
        return makeIssue({ key });
      };

      const start = h.manager.startSession('ws', 'DOC-1', START);
      await waitFor(() => fetching, 'the start to reach the tracker');
      const removal = h.manager
        .removeWorktree('qc-DOC-1-implement', false)
        .catch(() => 'refused' as const);
      await drain();

      // The removal ran to its own answer while the tracker was still holding.
      await expect(removal).resolves.toBeDefined();
      release();
      await start;
    });

    it('holds a removal of the checkout a start is preparing', async () => {
      const first = await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession(first.id);
      await h.manager.archiveSession(first.id);
      h.clock.ms += 60_000;
      const { held, release } = gate();
      let preparing = false;
      h.repo.prepare = async () => {
        preparing = true;
        await held;
        return { cwd: '/repos/worktrees/DOC-1', branch: 'DOC-1-x', needsBootstrap: false };
      };

      const start = h.manager.startSession('ws', 'DOC-1', START);
      await waitFor(() => preparing, 'the start to reach the checkout');
      let removed = false;
      const removal = h.manager
        .removeWorktree(first.id, true)
        .then(() => {
          removed = true;
        })
        .catch(() => undefined);
      await drain();

      expect(removed).toBe(false);
      expect(h.repo.removed).toEqual([]);

      release();
      await Promise.allSettled([start, removal]);
    });

    it('holds a start of the issue whose checkout is being removed', async () => {
      const first = await h.manager.startSession('ws', 'DOC-1', START);
      await h.manager.killSession(first.id);
      await h.manager.archiveSession(first.id);
      h.clock.ms += 60_000;
      const { held, release } = gate();
      h.repo.removeWorktree = async (issueKey, force) => {
        h.repo.removed.push({ issueKey, force });
        await held;
      };

      const removal = h.manager.removeWorktree(first.id, true);
      await waitFor(() => h.repo.removed.length > 0, 'the removal to reach the repo');
      let prepared = false;
      h.repo.prepare = async () => {
        prepared = true;
        return { cwd: '/repos/worktrees/DOC-1', branch: 'DOC-1-x', needsBootstrap: false };
      };
      const start = h.manager.startSession('ws', 'DOC-1', START).catch(() => undefined);
      await drain();

      expect(prepared).toBe(false);

      release();
      await Promise.allSettled([removal, start]);
    });

    it('gives two different (repo, issue) pairs two different checkout keys', () => {
      // Without the separator, `('app-1','DOC-2')` and `('ap','p-1DOC-2')` are
      // one key, and two unrelated checkouts serialise against each other.
      expect(checkoutKey('app-1', 'DOC-2')).not.toBe(checkoutKey('ap', 'p-1DOC-2'));
      expect(checkoutKey('app', 'DOC-1')).toBe(checkoutKey('app', 'DOC-1'));
    });
  });

  describe('polling', () => {
    it('installs the poll timer even when the boot sequence rejects', async () => {
      // A boot that fails must cost a banner, not a server that never polls
      // and never reconciles for as long as it runs.
      const sessions = h.store.sessions.bind(h.store);
      let thrown = false;
      h.store.sessions = () => {
        if (thrown) return sessions();
        thrown = true;
        throw new Error('EACCES: sessions.json');
      };

      await expect(h.manager.start()).rejects.toThrow('EACCES: sessions.json');
      const before = h.source.listCalls;
      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 1000);
      await drain();

      expect(h.source.listCalls).toBeGreaterThan(before);
    });

    it('stops polling a query the source says repeating cannot fix', async () => {
      h.source.listError = new JiraTruncatedError('parent = DOC-100', 50, 5000);
      await h.manager.start();
      expect(h.logger.lines.join('\n')).toContain('polling suspended');
      const suspended = h.source.listCalls;
      h.source.listError = null;

      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 3000);

      expect(h.source.listCalls).toBe(suspended);
    });

    it('stops polling for any error that marks itself permanent, not only Jira’s', async () => {
      // The marker is the seam: a connector author raises one without
      // importing Jira code, and testing it with the class it was extracted
      // from proves only that the class still works.
      h.source.listError = Object.assign(new Error('the query names no project'), {
        permanent: true,
      });
      await h.manager.start();
      expect(h.logger.lines.join('\n')).toContain('polling suspended');
      const suspended = h.source.listCalls;
      h.source.listError = null;

      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 3000);

      expect(h.source.listCalls).toBe(suspended);
    });

    it('keeps polling for an error that marks itself transient', async () => {
      // `permanent: false` is the natural way to say "try again"; a marker read
      // as "is the property there at all" would suspend on it.
      h.source.listError = Object.assign(new Error('the tracker timed out'), {
        permanent: false,
      });
      await h.manager.start();
      const failed = h.source.listCalls;
      h.source.listError = null;

      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 1000);

      expect(h.source.listCalls).toBeGreaterThan(failed);
    });

    it('names the class that suspended the poll timer', async () => {
      class QueryTooWideError extends Error {
        readonly permanent = true;
      }
      h.source.listError = new QueryTooWideError('too many results');

      await h.manager.start();

      expect(h.logger.lines.join('\n')).toContain('QueryTooWideError');
    });

    it('resumes polling once the owner asks for a refresh', async () => {
      h.source.listError = new JiraTruncatedError('parent = DOC-100', 50, 5000);
      await h.manager.start();
      h.source.listError = null;

      await h.manager.refresh('ws');
      const resumed = h.source.listCalls;
      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 1000);

      expect(h.source.listCalls).toBeGreaterThan(resumed);
    });

    it('leaves the suspension in place when a session merely exits', async () => {
      // A session exiting is not the owner asking; treating it as one resumes
      // the same rejected query on the next tick.
      await h.manager.startSession('ws', 'DOC-1', START);
      h.source.listError = new JiraTruncatedError('parent = DOC-100', 50, 5000);
      await h.manager.start();
      h.source.listError = null;

      await h.manager.killSession('qc-DOC-1-implement');
      const afterExit = h.source.listCalls;
      await vi.advanceTimersByTimeAsync(h.config.workspaces['ws']!.pollSeconds * 3000);

      expect(h.source.listCalls).toBe(afterExit);
    });

    it('answers a refresh from a fetch issued after it, never from one before', async () => {
      // The whole point of `inFlightStartedAt`: a refresh clicked for a change
      // must not be answered by a list read before that change happened.
      const { held, release } = gate();
      h.source.list = async () => {
        h.source.listCalls += 1;
        // Snapshot at call time, the way a real request does: what a fetch
        // answers is what the tracker held when it was issued.
        const snapshot = [...h.source.issues];
        await held;
        return snapshot;
      };
      // Against a captured baseline, not against 1: the harness's own first
      // refresh is what makes a literal right today, and nothing says so.
      const baseline = h.source.listCalls;
      const first = h.manager.refresh('ws');
      await waitFor(() => h.source.listCalls > baseline, 'the first refresh to reach the source');
      h.clock.ms += 1000;
      h.source.issues = [makeIssue(), makeIssue({ key: 'DOC-2', summary: 'Added later' })];
      const second = h.manager.refresh('ws');
      await drain();
      release();

      const [, view] = await Promise.all([first, second]);

      expect(laneOf(view, 'DOC-2')).toBe('backlog');
    });
  });

  describe('staleness', () => {
    it('leaves the marker alone for a status-line payload, which reports no state', async () => {
      // A cold cache says nothing about whether the session moved, and it
      // arrives once a second: clearing the marker on one erases it instantly.
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      h.clock.ms += RECONCILE_INTERVAL_MS;
      await h.manager.reconcile();
      expect(h.store.session('qc-DOC-1-implement')?.staleSince).not.toBeNull();

      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        {
          type: 'statusline',
          payload: { prompt_cache: { expires_at: 1_788_976_000, ttl: '5m', warm: false } },
        },
        {},
      );

      expect(h.store.session('qc-DOC-1-implement')?.staleSince).not.toBeNull();
    });

    it('leaves a session that is still reporting unflagged, however long it has been working', async () => {
      // `stateSince` only moves on a state change, so a session that has been
      // working across the restart and is still posting hooks would be flagged
      // on every pass, and unflagged again by its next hook, for ever.
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        state: 'working',
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } },
        {},
      );
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();

      expect(h.store.session('qc-DOC-1-implement')?.staleSince).toBeNull();
    });

    it('clears the marker on the record it closes in the same pass', async () => {
      // A dead record receives no further event, so a flag left on it is one
      // nothing can ever clear.
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      h.runner.alive.clear();
      h.clock.ms += RECONCILE_INTERVAL_MS;

      await h.manager.reconcile();

      const record = h.store.session('qc-DOC-1-implement');
      expect(record?.state).toBe('failed');
      expect(record?.staleSince).toBeNull();
    });

    it('leaves a session the owner has just resumed unflagged', async () => {
      // The record's `lastEventAt` is from the previous process, so without a
      // stamp on the owner's own action the next reconcile pass badges a
      // session started three seconds ago as "unverified since restart".
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        state: 'exited',
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
        lastEventAt: new Date(h.clock.ms - 3_600_000).toISOString(),
        claudeSessionId: 'abc',
      });

      await h.manager.resumeSession('qc-DOC-1-implement');
      h.clock.ms += RECONCILE_INTERVAL_MS;
      await h.manager.reconcile();

      expect(h.store.session('qc-DOC-1-implement')?.staleSince).toBeNull();
    });

    it('flags a record once, not once per reconcile pass', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      const survivor = h.store.session('qc-DOC-1-implement') as SessionRecord;
      await h.store.saveSession({
        ...survivor,
        stateSince: new Date(h.clock.ms - 3_600_000).toISOString(),
      });
      h.clock.ms += RECONCILE_INTERVAL_MS;
      const frames: EventFrame[] = [];
      h.manager.subscribe((frame) => frames.push(frame));

      await h.manager.reconcile();
      await h.manager.reconcile();

      expect(frames.filter((frame) => frame.type === 'session')).toHaveLength(1);
    });
  });

  describe('event log', () => {
    it('refuses a log it cannot read with a status the panel can show', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.store.readEvents = async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      };

      await expect(h.manager.sessionEvents('qc-DOC-1-implement')).rejects.toMatchObject({
        status: 409,
        detail: 'EACCES: permission denied',
      });
    });

    it('applies the event anyway when the log cannot be appended to', async () => {
      // The transcript is a debugging aid. Letting its failure out 500s every
      // hook of that session, and a hook is fire-and-forget: the card would
      // freeze at whatever state it last reached while the session ran on.
      await h.manager.startSession('ws', 'DOC-1', START);
      h.store.appendEvent = async () => {
        throw Object.assign(new Error('EACCES: sessions/qc-DOC-1-implement'), { code: 'EACCES' });
      };

      const record = await h.manager.applyEvent(
        'qc-DOC-1-implement',
        { type: 'hook', hook: { hook_event_name: 'UserPromptSubmit' } },
        {},
      );

      expect(record.state).toBe('working');
      expect(h.store.session('qc-DOC-1-implement')?.state).toBe('working');
      expect(h.logger.lines.join('\n')).toContain('cannot append to the event log');
    });

    it('reports an unwritable log once per session, not once per event', async () => {
      await h.manager.startSession('ws', 'DOC-1', START);
      h.store.appendEvent = async () => {
        throw new Error('EACCES: sessions/qc-DOC-1-implement');
      };

      for (const hook of ['UserPromptSubmit', 'Stop', 'UserPromptSubmit'] as const) {
        await h.manager.applyEvent(
          'qc-DOC-1-implement',
          { type: 'hook', hook: { hook_event_name: hook } },
          {},
        );
      }

      const complaints = h.logger.lines.filter((line) =>
        line.includes('cannot append to the event log'),
      );
      expect(complaints).toHaveLength(1);
    });
  });

  describe('fan-out', () => {
    it('says nothing when a refresh in flight outlives the workspace it was for', async () => {
      // The refresh schedules the board after its fetch returns, i.e. after the
      // removal has already cleared that workspace's timers.
      await h.manager.addWorkspace({
        id: 'second',
        name: 'Second',
        epic: 'DOC-900',
        repo: 'app',
        connector: 'tracker',
      });
      await settle();
      const { held, release } = gate();
      h.source.list = async () => {
        h.source.listCalls += 1;
        await held;
        return [...h.source.issues];
      };

      const baseline = h.source.listCalls;
      const refresh = h.manager.refresh('second').catch(() => undefined);
      await waitFor(() => h.source.listCalls > baseline, 'the refresh to reach the source');
      await h.manager.removeWorkspace('second');
      release();
      await refresh;
      await settle();

      expect(h.logger.lines.join('\n')).not.toContain('cannot project');
    });

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

    it('still reaches the later subscribers when one unsubscribes during the fan-out', async () => {
      // `/ws/events` unsubscribes from inside its own close handler, and a
      // fan-out over a copy of the set would deliver the frame to a socket that
      // has already gone — while iterating a copy after a delete during the
      // loop is exactly what skips the next listener.
      await settle();
      const seen: string[] = [];
      const unsubscribeSecond: Array<() => void> = [];
      const first = h.manager.subscribe(() => {
        seen.push('first');
        unsubscribeSecond[0]?.();
      });
      const second = h.manager.subscribe(() => seen.push('second'));
      unsubscribeSecond.push(second);
      const third = h.manager.subscribe(() => seen.push('third'));

      await h.manager.startSession('ws', 'DOC-1', START);

      expect(seen).toEqual(['first', 'third']);
      first();
      second();
      third();
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

  it('stays at five minutes for an env block that does not name the flag', async () => {
    // `String(undefined)` is the string 'undefined', which is neither '', '0'
    // nor 'false': a settings file with any other env entry would buy an hour.
    const path = join(dir, 'settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ env: { SOMETHING_ELSE: '1' } }), 'utf8');
    expect(readDerivedCacheTtlSeconds(path)).toBe(300);
  });
});
