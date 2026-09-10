import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BoardView,
  ErrorResponse,
  IssueDetailResponse,
  PrefillResponse,
  PublicConfigResponse,
  RemoveWorktreeResponse,
} from '../../src/core/api.js';
import type { Config, SessionRecord } from '../../src/core/types.js';
import {
  DetachedWorktreeError,
  DirtyWorktreeError,
  NoBranchError,
} from '../../src/connectors/repos/git/index.js';
import { MissingExecutableError } from '../../src/connectors/runners/claude-tmux/index.js';
import { createApp } from '../../src/server/app.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { Store } from '../../src/server/store.js';
import { makeIssue } from '../core/helpers.js';
import {
  FakeIssueSource,
  FakeRepo,
  FakeRunner,
  RecordingLogger,
  makeConfig,
  makeRuntime,
} from './fakes.js';

const CREATE = {
  playbookId: 'implement',
  prompt: 'Work on DOC-1',
  model: 'claude-fable-5-1',
  effort: 'high',
  permissionMode: 'acceptEdits',
};

/**
 * Posts a JSON body to a route.
 *
 * @param app - App under test.
 * @param path - Route path.
 * @param body - Body to send, or undefined for an empty one.
 * @returns The response.
 */
async function post(app: Hono, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * Reads one session's current state through the issue drawer.
 *
 * @param app - App under test.
 * @param sessionId - Session to look up.
 * @returns The state the record is in, or undefined when it is not listed.
 */
async function stateOf(app: Hono, sessionId: string): Promise<string | undefined> {
  const detail = (await (
    await app.request('/api/workspaces/ws/issues/DOC-1')
  ).json()) as IssueDetailResponse;
  return detail.sessions.find((record) => record.id === sessionId)?.state;
}

describe('HTTP API', () => {
  let dir: string;
  let configPath: string;
  let app: Hono;
  let runner: FakeRunner;
  let repo: FakeRepo;
  let source: FakeIssueSource;
  let manager: SessionManager;
  let editorCalls: Array<{ command: string; args: string[] }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qc-app-'));
    configPath = join(dir, 'config.json');
    const config = makeConfig(dir);
    const store = new Store(dir);
    await store.load();
    runner = new FakeRunner();
    source = new FakeIssueSource('ws', [makeIssue({ description: 'the full description' })]);
    repo = new FakeRepo('app', {
      cwd: '/repos/worktrees/DOC-1',
      branch: 'DOC-1-document-the-thing',
      needsBootstrap: false,
    });
    editorCalls = [];
    manager = new SessionManager({
      config,
      configPath,
      store,
      runner,
      workspaces: [makeRuntime(config, 'ws', source, repo)],
      createRuntime: (next, workspaceId) => makeRuntime(next, workspaceId, source, repo),
      derivedCacheTtlSeconds: 300,
      spawnEditor: (command, args) => editorCalls.push({ command, args }),
      logger: new RecordingLogger(),
    });
    await manager.refresh('ws');
    app = createApp({ manager, logger: new RecordingLogger() });
  });

  afterEach(async () => {
    manager.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the switcher list, the repos, the connectors and the picker options', async () => {
    const body = (await (await app.request('/api/config/public')).json()) as PublicConfigResponse;
    expect(body.workspaces).toEqual([
      { id: 'ws', name: 'Docs', epic: 'DOC-100', repo: 'app', connector: 'tracker' },
    ]);
    expect(body.repos).toEqual([{ id: 'app', path: '/repos/app' }]);
    expect(body.connectors).toEqual([{ id: 'tracker', site: 'example.atlassian.net' }]);
    expect(body.runner.efforts).toContain('xhigh');
    expect(body.runner.permissionModes).toContain('default');
    expect(body.runner.defaults.model).toBe('claude-fable-5-1');
  });

  it('adds a workspace, writes the config file and lists it', async () => {
    const created = await post(app, '/api/workspaces', {
      name: 'Second board',
      epic: 'DOC-900',
      repo: 'app',
      connector: 'tracker',
      reviewStatuses: ['In review'],
    });

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: 'second-board',
      name: 'Second board',
      epic: 'DOC-900',
      repo: 'app',
      connector: 'tracker',
    });
    const written = JSON.parse(await readFile(configPath, 'utf8')) as Config;
    expect(written.workspaces['second-board']?.reviewStatuses).toEqual(['In review']);
    const listed = (await (await app.request('/api/config/public')).json()) as PublicConfigResponse;
    expect(listed.workspaces.map((workspace) => workspace.id)).toEqual(['ws', 'second-board']);
  });

  it('creates the inline connector the dialog asked for', async () => {
    const created = await post(app, '/api/workspaces', {
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

    expect(created.status).toBe(201);
    const body = (await (await app.request('/api/config/public')).json()) as PublicConfigResponse;
    expect(body.connectors).toContainEqual({ id: 'ops-jira', site: 'ops.atlassian.net' });
  });

  it('answers 409 for a duplicate id and 400 with issues for a bad request', async () => {
    const duplicate = await post(app, '/api/workspaces', {
      id: 'ws',
      name: 'Again',
      epic: 'DOC-2',
      repo: 'app',
      connector: 'tracker',
    });
    expect(duplicate.status).toBe(409);

    const invalid = await post(app, '/api/workspaces', {
      name: 'Ghost repo',
      epic: 'DOC-2',
      repo: 'ghost',
      connector: 'tracker',
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as ErrorResponse;
    expect(body.issues?.map((issue) => issue.path)).toContain('repo');
  });

  it('removes a workspace with 204 and 404s an unknown one', async () => {
    await post(app, '/api/workspaces', {
      id: 'second',
      name: 'Second',
      epic: 'DOC-900',
      repo: 'app',
      connector: 'tracker',
    });

    const removed = await app.request('/api/workspaces/second', { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await app.request('/api/workspaces/second/board')).status).toBe(404);
    expect((await app.request('/api/workspaces/ghost', { method: 'DELETE' })).status).toBe(404);
  });

  it('serves and refreshes a board', async () => {
    const board = (await (await app.request('/api/workspaces/ws/board')).json()) as BoardView;
    expect(board.workspaceId).toBe('ws');
    expect(board.columns).toHaveLength(5);
    expect(board.needsYouCount).toBe(0);

    const before = source.listCalls;
    const refreshed = (await (await post(app, '/api/workspaces/ws/refresh')).json()) as BoardView;
    expect(source.listCalls).toBe(before + 1);
    expect(refreshed.playbooks.map((playbook) => playbook.id)).toEqual(['implement', 'test']);
  });

  it('answers a JSON error with a 4xx for an unknown workspace', async () => {
    const response = await app.request('/api/workspaces/nope/board');
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toContain('nope');
  });

  it('serves the issue drawer and the start-dialog prefill', async () => {
    const detail = (await (
      await app.request('/api/workspaces/ws/issues/DOC-1')
    ).json()) as IssueDetailResponse;
    expect(detail.issue.description).toBe('the full description');
    expect(detail.sessions).toEqual([]);
    expect(detail.worktreePath).toBeNull();

    const prefill = (await (
      await app.request('/api/workspaces/ws/issues/DOC-1/prefill?playbook=implement')
    ).json()) as PrefillResponse;
    expect(prefill.prompt).toBe('Work on DOC-1');
    expect(prefill.isolation).toBe('worktree');
    expect(prefill.warnings).toEqual([]);
  });

  it('requires the playbook query parameter on prefill', async () => {
    const response = await app.request('/api/workspaces/ws/issues/DOC-1/prefill');

    expect(response.status).toBe(400);
    // A missing playbook 400s further down too, so the message is what says
    // which refusal answered.
    expect(((await response.json()) as ErrorResponse).error).toContain("'playbook'");
  });

  it('creates a session with 201 and refuses a duplicate with 409', async () => {
    const created = await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
    expect(created.status).toBe(201);
    const record = (await created.json()) as SessionRecord;
    expect(record.id).toBe('qc-DOC-1-implement');
    expect(runner.started).toHaveLength(1);

    const again = await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
    expect(again.status).toBe(409);
    const body = (await again.json()) as ErrorResponse;
    expect(body.error).toContain('DOC-1');
  });

  describe('session actions', () => {
    beforeEach(async () => {
      await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
    });

    it('interrupts a working session back to idle', async () => {
      await post(app, '/api/hooks/qc-DOC-1-implement/UserPromptSubmit', { prompt: 'go' });
      expect(await stateOf(app, 'qc-DOC-1-implement')).toBe('working');

      const response = await post(app, '/api/sessions/qc-DOC-1-implement/interrupt');

      expect(response.status).toBe(200);
      expect(((await response.json()) as SessionRecord).state).toBe('idle');
      expect(runner.interrupted).toEqual(['qc-DOC-1-implement']);
    });

    it('marks a session done and back', async () => {
      const marked = (await (
        await post(app, '/api/sessions/qc-DOC-1-implement/mark-done')
      ).json()) as SessionRecord;
      expect(marked.done).toBe(true);

      const unmarked = (await (
        await post(app, '/api/sessions/qc-DOC-1-implement/unmark-done')
      ).json()) as SessionRecord;
      expect(unmarked.done).toBe(false);
    });

    it('refuses to resume a session that never reported a Claude session id', async () => {
      expect((await post(app, '/api/sessions/qc-DOC-1-implement/resume')).status).toBe(409);
    });

    it('kills a session', async () => {
      const response = await post(app, '/api/sessions/qc-DOC-1-implement/kill');

      expect(response.status).toBe(200);
      expect(((await response.json()) as SessionRecord).state).toBe('exited');
    });

    it('archives an exited session', async () => {
      await post(app, '/api/sessions/qc-DOC-1-implement/kill');

      const archived = (await (
        await post(app, '/api/sessions/qc-DOC-1-implement/archive')
      ).json()) as SessionRecord;

      expect(archived.archived).toBe(true);
    });

    it('removes the worktree, forcing only when the body says so', async () => {
      await post(app, '/api/sessions/qc-DOC-1-implement/kill');

      const removed = (await (
        await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', {})
      ).json()) as RemoveWorktreeResponse;

      expect(removed).toEqual({ path: '/repos/worktrees/DOC-1', removed: true });
      expect(repo.removed).toEqual([{ issueKey: 'DOC-1', force: false }]);
    });

    it('passes force through when the body asks for it', async () => {
      await post(app, '/api/sessions/qc-DOC-1-implement/kill');

      await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', { force: true });

      expect(repo.removed).toEqual([{ issueKey: 'DOC-1', force: true }]);
    });
  });

  it('sets issue flags and reports them back', async () => {
    const response = await post(app, '/api/workspaces/ws/issues/DOC-1/flags', { review: true });
    expect(await response.json()).toEqual({ review: true });
  });

  it('answers open-editor with 204 once a checkout exists and 409 before', async () => {
    expect((await post(app, '/api/workspaces/ws/issues/DOC-1/open-editor')).status).toBe(409);
    await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
    expect((await post(app, '/api/workspaces/ws/issues/DOC-1/open-editor')).status).toBe(204);
    expect(editorCalls).toEqual([{ command: 'code', args: ['/repos/worktrees/DOC-1'] }]);
  });

  describe('refusal reasons', () => {
    it('names a duplicate workspace id', async () => {
      const response = await post(app, '/api/workspaces', {
        id: 'ws',
        name: 'Again',
        epic: 'DOC-2',
        repo: 'app',
        connector: 'tracker',
      });

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBe('duplicate-id');
    });

    it('leaves a schema refusal without a reason', async () => {
      const response = await post(app, '/api/workspaces', {
        name: 'Ghost repo',
        epic: 'DOC-2',
        repo: 'ghost',
        connector: 'tracker',
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorResponse).reason).toBeUndefined();
    });

    it('names a dirty worktree so the UI can offer the force removal', async () => {
      await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
      await post(app, '/api/sessions/qc-DOC-1-implement/kill');
      repo.removeError = new DirtyWorktreeError('/repos/worktrees/DOC-1', '?? scratch.txt');

      const response = await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', {});

      expect(response.status).toBe(409);
      const body = (await response.json()) as ErrorResponse;
      expect(body.reason).toBe('dirty-worktree');
      expect(body.detail).toContain('scratch.txt');
    });

    it('leaves a removal that git refused for another cause without a reason', async () => {
      await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);
      await post(app, '/api/sessions/qc-DOC-1-implement/kill');
      repo.removeError = new Error('git worktree remove exited 128');

      const response = await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', {});

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBeUndefined();
    });

    it('names a live session still holding the checkout', async () => {
      await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);

      const response = await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', {});

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBe('session-live');
    });

    it('names the branch a checkout could not be prepared from', async () => {
      repo.prepareError = new NoBranchError('DOC-1', ['origin/DOC-1-*']);

      const response = await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBe('no-branch');
    });

    it('names a detached worktree a checkout could not be prepared from', async () => {
      repo.prepareError = new DetachedWorktreeError('DOC-1', '/repos/worktrees/DOC-1');

      const response = await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBe('detached-worktree');
    });

    it('names a missing CLI a checkout could not be prepared for', async () => {
      repo.prepareError = new MissingExecutableError('claude');

      const response = await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorResponse).reason).toBe('missing-executable');
    });
  });

  it('answers a JSON 404 for an unrouted API path', async () => {
    const response = await app.request('/api/nothing');
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error).toContain('/api/nothing');
  });

  describe('with the built SPA served', () => {
    let spa: Hono;

    beforeEach(async () => {
      const webRoot = join(dir, 'web');
      // `assets/` is what tells a built SPA from the Vite source tree, which
      // also has an index.html.
      await mkdir(join(webRoot, 'assets'), { recursive: true });
      await writeFile(join(webRoot, 'index.html'), '<!doctype html>shell', 'utf8');
      await writeFile(join(webRoot, 'app.js'), 'console.log(1);', 'utf8');
      spa = createApp({ manager, logger: new RecordingLogger(), webRoot });
    });

    it('still answers a JSON 404 for an unrouted API path', async () => {
      const response = await spa.request('/api/nothing');

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(((await response.json()) as ErrorResponse).error).toContain('/api/nothing');
    });

    it('still answers a JSON 404 for an unrouted WebSocket path', async () => {
      const response = await spa.request('/ws/nothing');

      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorResponse).error).toContain('/ws/nothing');
    });

    it('serves a real asset and falls back to the shell on a deep link', async () => {
      expect(await (await spa.request('/app.js')).text()).toBe('console.log(1);');

      const deep = await spa.request('/session/qc-DOC-1-implement');
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('shell');
    });

    it.each(['/api', '/ws'])('answers a JSON 404 for the bare %s prefix', async (path) => {
      const response = await spa.request(path);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(((await response.json()) as ErrorResponse).error).toContain(path);
    });

    it('answers the JSON 404 even when a real file shadows an API path', async () => {
      // The asset handler matches every path, so its own guard is the only
      // thing between a stray file and an API route.
      await mkdir(join(dir, 'web', 'api'), { recursive: true });
      await writeFile(join(dir, 'web', 'api', 'nothing'), 'gotcha', 'utf8');

      const response = await spa.request('/api/nothing');

      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorResponse).error).toContain('/api/nothing');
    });
  });

  describe('with no built SPA', () => {
    it('says the SPA is not built rather than serving the Vite source tree', async () => {
      // Under `tsx src/server/main.ts` the web root resolves to `src/web`,
      // which has an index.html that only a dev server can load.
      const sourceTree = join(dir, 'src-web');
      await mkdir(sourceTree, { recursive: true });
      await writeFile(join(sourceTree, 'index.html'), '<script src="/src/main.tsx">', 'utf8');
      const dev = createApp({ manager, logger: new RecordingLogger(), webRoot: sourceTree });

      const response = await dev.request('/');

      expect(response.status).toBe(503);
      expect(await response.text()).toContain('npm run build:web');
    });

    it('keeps serving the API', async () => {
      const dev = createApp({
        manager,
        logger: new RecordingLogger(),
        webRoot: join(dir, 'nothing-here'),
      });

      expect((await dev.request('/api/workspaces/ws/board')).status).toBe(200);
    });
  });
});
