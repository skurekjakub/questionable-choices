import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

describe('HTTP API', () => {
  let dir: string;
  let configPath: string;
  let app: Hono;
  let runner: FakeRunner;
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
    const repo = new FakeRepo('app', {
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
    expect(body.issues?.map((issue) => issue.path)).toContain('workspaces.ghost-repo.repo');
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

  it('runs every session action', async () => {
    await post(app, '/api/workspaces/ws/issues/DOC-1/sessions', CREATE);

    const interrupted = await post(app, `/api/sessions/qc-DOC-1-implement/interrupt`);
    expect(interrupted.status).toBe(200);

    const marked = (await (
      await post(app, '/api/sessions/qc-DOC-1-implement/mark-done')
    ).json()) as SessionRecord;
    expect(marked.done).toBe(true);
    const unmarked = (await (
      await post(app, '/api/sessions/qc-DOC-1-implement/unmark-done')
    ).json()) as SessionRecord;
    expect(unmarked.done).toBe(false);

    expect((await post(app, '/api/sessions/qc-DOC-1-implement/resume')).status).toBe(409);
    const killed = (await (
      await post(app, '/api/sessions/qc-DOC-1-implement/kill')
    ).json()) as SessionRecord;
    expect(killed.state).toBe('exited');

    const archived = (await (
      await post(app, '/api/sessions/qc-DOC-1-implement/archive')
    ).json()) as SessionRecord;
    expect(archived.archived).toBe(true);

    const removed = (await (
      await post(app, '/api/sessions/qc-DOC-1-implement/remove-worktree', { force: true })
    ).json()) as RemoveWorktreeResponse;
    expect(removed).toEqual({ path: '/repos/worktrees/DOC-1', removed: true });
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

  it('answers a JSON 404 for an unrouted API path', async () => {
    const response = await app.request('/api/nothing');
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error).toContain('/api/nothing');
  });
});
