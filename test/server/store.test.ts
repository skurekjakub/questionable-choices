import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_MEMBERS_MAX,
  EVENT_STRING_MAX_LENGTH,
  Store,
  writeJsonAtomic,
} from '../../src/server/store.js';
import type { SessionRecord } from '../../src/core/types.js';
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

  it.each([
    ['sessions.json', '{}', (store: Store) => store.sessions()],
    ['sessions.json', '"text"', (store: Store) => store.sessions()],
    ['flags.json', '[]', (store: Store) => Object.keys(store.flagsOf('ws'))],
    ['worktrees.json', '3', (store: Store) => Object.keys(store.worktreesOf('ws'))],
  ])(
    'treats %s holding %s as empty, since a cast would only defer the failure',
    async (file, text, read) => {
      await writeFile(join(dir, file), text, 'utf8');
      const store = new Store(dir);

      await store.load();

      expect(read(store)).toEqual([]);
    },
  );

  it('leaves every write either fully applied or not applied at all', async () => {
    const store = new Store(dir);
    await store.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.saveSession(makeRecord({ id: `qc-DOC-${index}-implement` })),
      ),
    );

    const entries = await readdir(dir);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    // The document parses after twenty interleaved writes, which is what the
    // temp-file-and-rename buys: no reader ever sees a half-written file.
    const text = await readFile(join(dir, 'sessions.json'), 'utf8');
    expect(JSON.parse(text)).toHaveLength(20);
  });

  it('never lets a reader see the document missing or half-written', async () => {
    // The property is not "the inode changed" — an unlink followed by a write
    // changes it too, and has exactly the window a rename exists to close. It
    // is that every read during the write answers one whole document.
    const path = join(dir, 'probe.json');
    await writeJsonAtomic(path, { version: 1 });
    const seen: unknown[] = [];
    let reading = true;
    const reader = (async () => {
      while (reading) {
        try {
          seen.push(JSON.parse(await readFile(path, 'utf8')));
        } catch (cause) {
          seen.push(cause);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    for (let round = 2; round <= 40; round += 1) await writeJsonAtomic(path, { version: round });
    reading = false;
    await reader;

    expect(seen.length).toBeGreaterThan(1);
    for (const document of seen) expect(document).toEqual({ version: expect.any(Number) });
    expect(await readdir(dir)).toEqual(['probe.json']);
  });

  it('keeps the old document when a write fails, in memory as well as on disk', async () => {
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord());
    const before = await readFile(join(dir, 'sessions.json'), 'utf8');

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const doomed = makeRecord({ id: 'qc-DOC-2-implement' });
    (doomed as unknown as Record<string, unknown>)['loop'] = circular;

    await expect(store.saveSession(doomed)).rejects.toThrow();

    expect(await readFile(join(dir, 'sessions.json'), 'utf8')).toBe(before);
    // A failed write must take its in-memory value with it, or the dashboard
    // shows a session that vanishes on the next boot.
    expect(store.session('qc-DOC-2-implement')).toBeUndefined();
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

  it('reports a log it cannot read as a failure, not as an empty log', async () => {
    // "the hooks never fired" and "the log could not be opened" are different
    // answers, and only one of them is the owner's problem to fix.
    const store = new Store(dir);
    await store.load();
    await mkdir(join(store.sessionDir('qc-DOC-1-implement'), 'events.jsonl'), { recursive: true });

    await expect(store.readEvents('qc-DOC-1-implement')).rejects.toThrow();
  });

  it('caps a long string in a raw payload so one event cannot swallow the log', async () => {
    const store = new Store(dir);
    await store.load();
    const huge = 'x'.repeat(EVENT_STRING_MAX_LENGTH * 3);

    await store.appendEvent('qc-DOC-1-implement', {
      at: '2026-09-09T10:00:00.000Z',
      event: { hook_event_name: 'PostToolUse', tool_response: { text: huge }, keep: 'short' },
      state: 'working',
    });

    const [entry] = await store.readEvents('qc-DOC-1-implement');
    const event = entry?.event as { tool_response: { text: string }; keep: string };
    expect(event.tool_response.text.length).toBeLessThan(huge.length);
    expect(event.tool_response.text).toContain('truncated');
    expect(event.keep).toBe('short');
  });

  it('leaves the worktrees document untouched when there is nothing to clear', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setWorktree('ws', 'DOC-1', { path: '/w/DOC-1', branch: 'x' });
    const before = await stat(join(dir, 'worktrees.json'));

    await store.clearWorktree('ws', 'DOC-404');

    // The inode, not the mtime: a rewrite of identical bytes inside the same
    // millisecond leaves the mtime byte-identical and the file replaced.
    expect((await stat(join(dir, 'worktrees.json'))).ino).toBe(before.ino);
  });

  it('keeps a document it refuses instead of letting the next write destroy it', async () => {
    // The next `saveSession` renames a fresh document over this file, so a
    // hand-edit that lost a comma would otherwise cost every record it held.
    const warnings: string[] = [];
    await writeFile(join(dir, 'sessions.json'), '[{"id":"qc-DOC-1-implement"},', 'utf8');
    const store = new Store(dir, (message) => warnings.push(message));

    await store.load();
    await store.saveSession(makeRecord({ id: 'qc-DOC-2-implement' }));

    expect(await readFile(join(dir, 'sessions.json.rejected'), 'utf8')).toBe(
      '[{"id":"qc-DOC-1-implement"},',
    );
    expect(warnings.join('\n')).toContain('sessions.json.rejected');
    expect(store.sessions().map((record) => record.id)).toEqual(['qc-DOC-2-implement']);
  });

  it('drops the members of sessions.json that are not usable records', async () => {
    // The outermost shape is not the whole story: a member with no `state` or
    // `repoId` reaches the projection and every board request throws on it.
    const warnings: string[] = [];
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify([{ nonsense: 1 }, makeRecord(), 3, null]),
      'utf8',
    );
    const store = new Store(dir, (message) => warnings.push(message));

    await store.load();

    expect(store.sessions().map((record) => record.id)).toEqual(['qc-DOC-1-implement']);
    expect(warnings.join('\n')).toContain('3 session record(s) were dropped');
  });

  it('rolls a failed save back by identity, not by an array snapshot', async () => {
    // Two saves overlap: a rollback that restored the whole array would drop
    // the record the other one has already inserted and written.
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord({ id: 'qc-DOC-1-implement' }));
    const doomed = makeRecord({ id: 'qc-DOC-2-implement' }) as SessionRecord & {
      toJSON?: () => unknown;
    };
    let attempts = 0;
    doomed.toJSON = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ENOSPC: no space left on device');
      const { toJSON: _drop, ...rest } = doomed;
      return rest;
    };

    const failing = store.saveSession(doomed);
    const surviving = store.saveSession(makeRecord({ id: 'qc-DOC-3-implement' }));
    await expect(failing).rejects.toThrow('ENOSPC');
    await surviving;

    expect(store.session('qc-DOC-2-implement')).toBeUndefined();
    expect(store.session('qc-DOC-3-implement')).toBeDefined();
  });

  it('caps the members of an array or an object in a raw payload', async () => {
    // A string cap bounds one field; a `tool_response` holding fifty thousand
    // short strings is the other half of the same problem.
    const store = new Store(dir);
    await store.load();

    await store.appendEvent('qc-DOC-1-implement', {
      at: '2026-09-09T10:00:00.000Z',
      event: {
        hook_event_name: 'PostToolUse',
        tool_response: Array.from({ length: 5000 }, () => 'x'),
      },
      state: 'working',
    });

    const [entry] = await store.readEvents('qc-DOC-1-implement');
    const event = entry?.event as { tool_response: string[] };
    expect(event.tool_response).toHaveLength(EVENT_MEMBERS_MAX + 1);
    expect(event.tool_response.at(-1)).toContain('truncated 4800 members');
  });

  it('recreates a session directory that went away under the running store', async () => {
    // The mkdir is cached per session, so without a retry every later append
    // for that session fails for the life of the process.
    const store = new Store(dir);
    await store.load();
    const entry = {
      at: '2026-09-09T10:00:00.000Z',
      event: { hook_event_name: 'Stop' },
      state: 'idle' as const,
    };
    await store.appendEvent('qc-DOC-1-implement', entry);
    await rm(store.sessionDir('qc-DOC-1-implement'), { recursive: true, force: true });

    await store.appendEvent('qc-DOC-1-implement', entry);

    expect(await store.readEvents('qc-DOC-1-implement')).toHaveLength(1);
  });
});
