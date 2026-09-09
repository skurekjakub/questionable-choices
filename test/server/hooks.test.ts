import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateSessionRequest, SessionEventsResponse } from '../../src/core/api.js';
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

const SESSION_ID = 'qc-DOC-1-implement';

const START: CreateSessionRequest = {
  playbookId: 'implement',
  prompt: 'Work on DOC-1',
  model: 'claude-fable-5-1',
  effort: 'high',
  permissionMode: 'acceptEdits',
};

/**
 * One line of the recorded hook probe.
 */
interface FixtureLine {
  /** Hook name the probe's command was registered under. */
  event: string;
  /** The hook's stdin JSON, exactly as it arrived. */
  payload: Record<string, unknown>;
}

/**
 * Reads the recorded hook probe.
 *
 * @returns Every recorded event, in the order it fired.
 */
async function readFixture(): Promise<FixtureLine[]> {
  const path = new URL('../fixtures/hook-events.jsonl', import.meta.url);
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureLine);
}

/**
 * Posts a JSON body to a route.
 *
 * @param app - App under test.
 * @param path - Route path.
 * @param body - Body to send.
 * @returns The response.
 */
async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('hook ingress', () => {
  let dir: string;
  let app: Hono;
  let store: Store;
  let manager: SessionManager;
  let logger: RecordingLogger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qc-hooks-'));
    const config = makeConfig(dir);
    store = new Store(dir);
    await store.load();
    logger = new RecordingLogger();
    const source = new FakeIssueSource('ws', [makeIssue()]);
    const repo = new FakeRepo('app', {
      cwd: '/repos/worktrees/DOC-1',
      branch: 'DOC-1-document-the-thing',
      needsBootstrap: false,
    });
    manager = new SessionManager({
      config,
      configPath: join(dir, 'config.json'),
      store,
      runner: new FakeRunner(),
      workspaces: [makeRuntime(config, 'ws', source, repo)],
      createRuntime: (next, workspaceId) => makeRuntime(next, workspaceId, source, repo),
      derivedCacheTtlSeconds: 300,
      logger,
    });
    await manager.refresh('ws');
    await manager.startSession('ws', 'DOC-1', START);
    app = createApp({ manager, logger });
  });

  afterEach(async () => {
    manager.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('replays the recorded probe end to end', async () => {
    const fixture = await readFixture();
    for (const line of fixture) {
      const response = await post(app, `/api/hooks/${SESSION_ID}/${line.event}`, line.payload);
      expect(response.status).toBe(204);
    }

    const record = store.session(SESSION_ID);
    expect(record?.state).toBe('exited');
    expect(record?.claudeSessionId).toBe('00000000-0000-0000-0000-000000000000');
    expect(record?.pending).toBeNull();
    expect(record?.lastAssistantMessage).toContain('second');
    expect(await store.readEvents(SESSION_ID)).toHaveLength(fixture.length);
  });

  it('exposes the same log through the debug route', async () => {
    const fixture = await readFixture();
    await post(app, `/api/hooks/${SESSION_ID}/${fixture[0]?.event ?? ''}`, fixture[0]?.payload);

    const response = await app.request(`/api/sessions/${SESSION_ID}/events`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionEventsResponse;
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.state).toBe('starting');
  });

  it('moves the record to waiting-question on an AskUserQuestion tool event', async () => {
    const fixture = await readFixture();
    const question = fixture.find(
      (line) => line.event === 'PreToolUse' && line.payload['tool_name'] === 'AskUserQuestion',
    );
    await post(app, `/api/hooks/${SESSION_ID}/PreToolUse`, question?.payload);

    const record = store.session(SESSION_ID);
    expect(record?.state).toBe('waiting-question');
    expect(record?.pending?.kind).toBe('question');
    expect(record?.pending?.summary).toContain('listing format');
  });

  it('answers 404 for an unknown session id', async () => {
    const response = await post(app, '/api/hooks/qc-nope/Stop', {});
    expect(response.status).toBe(404);
    expect(logger.lines.some((line) => line.includes('qc-nope'))).toBe(true);
  });

  it('ignores an unsubscribed hook name with a 204 and a log line', async () => {
    const response = await post(app, `/api/hooks/${SESSION_ID}/PreCompact`, {});
    expect(response.status).toBe(204);
    expect(store.session(SESSION_ID)?.state).toBe('starting');
    expect(logger.lines.some((line) => line.includes('PreCompact'))).toBe(true);
  });

  it('accepts the four launcher signals', async () => {
    expect((await post(app, `/api/hooks/${SESSION_ID}/launcher/bootstrap-start`, {})).status).toBe(
      204,
    );
    expect(store.session(SESSION_ID)?.state).toBe('bootstrapping');

    await post(app, `/api/hooks/${SESSION_ID}/launcher/claude-start`, {});
    expect(store.session(SESSION_ID)?.state).toBe('starting');
    expect(store.session(SESSION_ID)?.runs).toHaveLength(1);

    await post(app, `/api/hooks/${SESSION_ID}/launcher/claude-exit`, { exitCode: 2 });
    const record = store.session(SESSION_ID);
    expect(record?.state).toBe('exited');
    expect(record?.runs[0]?.exitCode).toBe(2);
  });

  it('marks a failed bootstrap as failed', async () => {
    await post(app, `/api/hooks/${SESSION_ID}/launcher/bootstrap-start`, {});
    await post(app, `/api/hooks/${SESSION_ID}/launcher/bootstrap-failed`, { exitCode: 1 });
    expect(store.session(SESSION_ID)?.state).toBe('failed');
  });

  it('ignores an unknown launcher signal with a 204', async () => {
    const response = await post(app, `/api/hooks/${SESSION_ID}/launcher/nonsense`, {});
    expect(response.status).toBe(204);
    expect(logger.lines.some((line) => line.includes('nonsense'))).toBe(true);
  });

  it('takes the prompt cache from a statusline payload', async () => {
    const payload = JSON.parse(
      await readFile(new URL('../fixtures/statusline-payload.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;

    const response = await post(app, `/api/hooks/${SESSION_ID}/statusline`, payload);
    expect(response.status).toBe(204);
    expect(store.session(SESSION_ID)?.cache).toEqual({
      expiresAt: 1788980554,
      ttlSeconds: 3600,
      warm: true,
      source: 'statusline',
    });
  });
});
