import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/server/store.js';
import { makeRecord } from '../core/helpers.js';

describe('Store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qc-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when the data directory has no documents', async () => {
    const store = new Store(dir);
    await store.load();
    expect(store.sessions()).toEqual([]);
    expect(store.flagsOf('ws')).toEqual({});
    expect(store.worktreesOf('ws')).toEqual({});
  });

  it('treats an unparseable document as empty rather than failing to boot', async () => {
    await writeFile(join(dir, 'sessions.json'), '{ not json', 'utf8');
    const store = new Store(dir);
    await store.load();
    expect(store.sessions()).toEqual([]);
  });

  it('persists a record and reads it back through a fresh store', async () => {
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord());

    const reloaded = new Store(dir);
    await reloaded.load();
    expect(reloaded.session('qc-DOC-1-implement')?.issueKey).toBe('DOC-1');
  });

  it('replaces a record with the same id instead of appending', async () => {
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord());
    await store.saveSession(makeRecord({ state: 'idle' }));
    expect(store.sessions()).toHaveLength(1);
    expect(store.session('qc-DOC-1-implement')?.state).toBe('idle');
  });

  it('leaves no temporary file behind and never writes a partial document', async () => {
    const store = new Store(dir);
    await store.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.saveSession(makeRecord({ id: `qc-DOC-${index}-implement` })),
      ),
    );

    const entries = await readdir(dir);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    const text = await readFile(join(dir, 'sessions.json'), 'utf8');
    expect(JSON.parse(text)).toHaveLength(20);
  });

  it('merges flags and drops the ones set back to false', async () => {
    const store = new Store(dir);
    await store.load();
    expect(await store.setFlags('ws', 'DOC-1', { review: true })).toEqual({ review: true });
    expect(await store.setFlags('ws', 'DOC-1', { done: true })).toEqual({
      review: true,
      done: true,
    });
    expect(await store.setFlags('ws', 'DOC-1', { review: false })).toEqual({ done: true });
    expect(store.flagsOf('ws')).toEqual({ 'DOC-1': { done: true } });
  });

  it('remembers and forgets worktrees', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setWorktree('ws', 'DOC-1', {
      path: '/repos/worktrees/DOC-1',
      branch: 'DOC-1-x',
    });
    expect(store.worktree('ws', 'DOC-1')?.branch).toBe('DOC-1-x');
    await store.clearWorktree('ws', 'DOC-1');
    expect(store.worktree('ws', 'DOC-1')).toBeUndefined();

    const reloaded = new Store(dir);
    await reloaded.load();
    expect(reloaded.worktreesOf('ws')).toEqual({});
  });

  it('appends events and skips a truncated final line when reading them back', async () => {
    const store = new Store(dir);
    await store.load();
    await store.appendEvent('qc-DOC-1-implement', {
      at: '2026-09-09T10:00:00.000Z',
      event: { hook_event_name: 'Stop' },
      state: 'idle',
    });
    await writeFile(
      join(store.sessionDir('qc-DOC-1-implement'), 'events.jsonl'),
      `${JSON.stringify({ at: 'a', event: {}, state: 'idle' })}\n{"at":`,
      'utf8',
    );

    const events = await store.readEvents('qc-DOC-1-implement');
    expect(events).toHaveLength(1);
    expect(events[0]?.state).toBe('idle');
  });

  it('reports no events for a session that never logged any', async () => {
    const store = new Store(dir);
    await store.load();
    expect(await store.readEvents('qc-DOC-9-implement')).toEqual([]);
  });
});
