import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_MEMBERS_MAX,
  EVENT_STRING_MAX_LENGTH,
  Store,
  TRUNCATION_MARKER_KEY,
  writeJsonAtomic,
} from '../../src/server/store.js';
import type { WorktreeRecord } from '../../src/server/store.js';
import type { IssueFlags, SessionRecord, SessionState } from '../../src/core/types.js';
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
    ['checklists.json', '[]', (store: Store) => store.checklist('ws', 'DOC-1', [])],
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

    // A floor proportional to the 39 writes: two reads would let the assertion
    // below pass without the reader ever having raced a rename.
    expect(seen.length).toBeGreaterThanOrEqual(10);
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

  it('projects the ticks onto the template and drops one it no longer names', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setChecklist('ws', 'DOC-1', ['Read it', 'Verify'], 'Verify', true);
    await store.setChecklist('ws', 'DOC-1', ['Read it', 'Verify'], 'Retired', true);

    expect(store.checklist('ws', 'DOC-1', ['Verify', 'Read it'])).toEqual([
      { label: 'Verify', done: true },
      { label: 'Read it', done: false },
    ]);
  });

  it('leaves a dropped tick in the document, so an item that comes back keeps it', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setChecklist('ws', 'DOC-1', ['Retired'], 'Retired', true);
    // A later tick rewrites the whole document, and its template no longer
    // names the first item: pruning here would make a template edit destroy
    // the ticks of every item it touched.
    await store.setChecklist('ws', 'DOC-1', ['Read it'], 'Read it', true);

    const reloaded = new Store(dir);
    await reloaded.load();
    expect(reloaded.checklist('ws', 'DOC-1', ['Retired', 'Read it'])).toEqual([
      { label: 'Retired', done: true },
      { label: 'Read it', done: true },
    ]);
  });

  it('removes a tick set back to false rather than storing it', async () => {
    const store = new Store(dir);
    await store.load();
    const template = ['Read it', 'Verify'];
    await store.setChecklist('ws', 'DOC-1', template, 'Read it', true);
    expect(await store.setChecklist('ws', 'DOC-1', template, 'Verify', true)).toEqual([
      { label: 'Read it', done: true },
      { label: 'Verify', done: true },
    ]);
    expect(await store.setChecklist('ws', 'DOC-1', template, 'Read it', false)).toEqual([
      { label: 'Read it', done: false },
      { label: 'Verify', done: true },
    ]);

    const persisted = JSON.parse(await readFile(join(dir, 'checklists.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(persisted['ws/DOC-1']).toEqual({ Verify: true });
  });

  it('keeps two issues apart under one workspace', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setChecklist('ws', 'DOC-1', ['Verify'], 'Verify', true);
    expect(store.checklist('ws', 'DOC-2', ['Verify'])).toEqual([{ label: 'Verify', done: false }]);
    expect(store.checklist('other', 'DOC-1', ['Verify'])).toEqual([
      { label: 'Verify', done: false },
    ]);
  });

  it('never leaves a tick on disk that the caller was told was refused', async () => {
    const store = new Store(dir);
    await store.load();
    const template = ['Read it', 'Verify'];
    await store.setChecklist('ws', 'DOC-1', template, 'Read it', true);

    // A directory the store cannot write into is what makes the temporary file
    // fail; the rollback has to leave memory saying what the file still says.
    await chmod(dir, 0o555);
    try {
      await expect(store.setChecklist('ws', 'DOC-1', template, 'Verify', true)).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }

    expect(store.checklist('ws', 'DOC-1', template)).toEqual([
      { label: 'Read it', done: true },
      { label: 'Verify', done: false },
    ]);
    const persisted = JSON.parse(await readFile(join(dir, 'checklists.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(persisted['ws/DOC-1']).toEqual({ 'Read it': true });
  });

  it('keeps a checklists document it refuses instead of letting the next write destroy it', async () => {
    const warnings: string[] = [];
    await writeFile(join(dir, 'checklists.json'), '["not the shape this file holds"]', 'utf8');
    const store = new Store(dir, (message) => warnings.push(message));

    await store.load();
    expect(store.checklist('ws', 'DOC-1', ['Verify'])).toEqual([{ label: 'Verify', done: false }]);
    await store.setChecklist('ws', 'DOC-1', ['Verify'], 'Verify', true);

    expect(await readFile(join(dir, 'checklists.json.rejected'), 'utf8')).toBe(
      '["not the shape this file holds"]',
    );
    expect(warnings.join('\n')).toContain('checklists.json.rejected');
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
    expect(warnings.join('\n')).toContain('3 of its members');
  });

  it('refuses a persisted state that is not one the state machine has', async () => {
    // A state outside the set is never live, so the reconciler skips it for
    // ever, the clash check ignores it and the lamp table has no entry.
    const warnings: string[] = [];
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify([makeRecord({ id: 'qc-DOC-9-implement', state: 'wat' as SessionState })]),
      'utf8',
    );
    const store = new Store(dir, (message) => warnings.push(message));

    await store.load();

    expect(store.sessions()).toEqual([]);
    expect(warnings.join('\n')).toContain('qc-DOC-9-implement');
  });

  it('keeps the document whose members it dropped, and names them', async () => {
    // The drop is irreversible and the next write rewrites the file, so without
    // this the owner's mistyped hand-edit costs that record's branch, worktree
    // path, prompt and run history for good.
    const warnings: string[] = [];
    const broken = JSON.stringify([{ id: 'qc-DOC-5-implement', issueKey: 'DOC-5' }, makeRecord()]);
    await writeFile(join(dir, 'sessions.json'), broken, 'utf8');
    const store = new Store(dir, (message) => warnings.push(message));

    await store.load();
    await store.saveSession(makeRecord({ id: 'qc-DOC-6-implement' }));

    expect(await readFile(join(dir, 'sessions.json.rejected'), 'utf8')).toBe(broken);
    expect(warnings.join('\n')).toContain('qc-DOC-5-implement');
  });

  it('never renames one rejected document over another', async () => {
    // The copy of the first rejection is the owner's original file; a second
    // bad edit must not turn their backup into a copy of the second mistake.
    await writeFile(join(dir, 'sessions.json'), 'first { not json', 'utf8');
    await new Store(dir, () => undefined).load();
    await writeFile(join(dir, 'sessions.json'), 'second { not json', 'utf8');

    await new Store(dir, () => undefined).load();

    expect(await readFile(join(dir, 'sessions.json.rejected'), 'utf8')).toBe('first { not json');
    const kept = (await readdir(dir)).filter((name) => name.endsWith('.rejected'));
    expect(kept).toHaveLength(2);
    const second = kept.find((name) => name !== 'sessions.json.rejected') as string;
    expect(await readFile(join(dir, second), 'utf8')).toBe('second { not json');
  });

  it('sweeps the temporary files a process that died mid-write left behind', async () => {
    // `writeJsonAtomic` cleans up after a failed rename, never after a SIGKILL
    // between the write and the rename, and nothing else ever cleans dataDir.
    await writeFile(join(dir, 'sessions.json.999.123.tmp'), '[]', 'utf8');
    await writeFile(join(dir, 'keep-me.json'), '{}', 'utf8');

    await new Store(dir).load();

    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('keep-me.json');
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
    expect(store.session('qc-DOC-3-implement')?.state).toBe('starting');
    // The disk, not just memory: a write that serialises `this.records` when it
    // runs — rather than the snapshot taken at the call — puts the record whose
    // save was refused back on disk, and it returns as a ghost on the next boot.
    const persisted = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as Array<{
      id: string;
    }>;
    expect(persisted.map((record) => record.id)).toEqual([
      'qc-DOC-1-implement',
      'qc-DOC-3-implement',
    ]);
  });

  it('writes the version each save was given, not the one memory holds by then', async () => {
    // A save queued behind another must not decide the earlier one's outcome:
    // with memory written at call time, this save's own version is never
    // serialised at all and its caller is told it succeeded.
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord({ id: 'qc-DOC-1-implement', state: 'starting' }));
    const doomed = makeRecord({ id: 'qc-DOC-1-implement', state: 'working' }) as SessionRecord & {
      toJSON?: () => unknown;
    };
    doomed.toJSON = () => {
      throw new Error('ENOSPC: no space left on device');
    };

    const failing = store.saveSession(doomed);
    const later = store.saveSession(makeRecord({ id: 'qc-DOC-1-implement', state: 'idle' }));
    await expect(failing).rejects.toThrow('ENOSPC');
    await later;

    expect(store.session('qc-DOC-1-implement')?.state).toBe('idle');
    const persisted = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as Array<{
      state: string;
    }>;
    expect(persisted.map((record) => record.state)).toEqual(['idle']);
  });

  it('keeps the old version in memory and on disk when a save fails', async () => {
    const store = new Store(dir);
    await store.load();
    await store.saveSession(makeRecord({ id: 'qc-DOC-1-implement', state: 'working' }));
    const doomed = makeRecord({ id: 'qc-DOC-1-implement', state: 'idle' }) as SessionRecord & {
      toJSON?: () => unknown;
    };
    doomed.toJSON = () => {
      throw new Error('ENOSPC: no space left on device');
    };

    await expect(store.saveSession(doomed)).rejects.toThrow('ENOSPC');

    expect(store.session('qc-DOC-1-implement')?.state).toBe('working');
    const persisted = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as Array<{
      state: string;
    }>;
    expect(persisted.map((record) => record.state)).toEqual(['working']);
  });

  it('never leaves a flag on disk that the caller was told was refused', async () => {
    // Every writer has to change memory inside its own queued work, not at the
    // call: an entry recorded early is serialised by whatever write runs first,
    // so the caller is told the write failed while the value is already on disk
    // and comes back on the next boot.
    const store = new Store(dir);
    await store.load();
    const seeded = (await store.setFlags('ws', 'DOC-9', { done: true })) as IssueFlags & {
      toJSON?: () => unknown;
    };
    let serialisations = 0;
    seeded.toJSON = () => {
      serialisations += 1;
      if (serialisations > 1) throw new Error('ENOSPC: no space left on device');
      const { toJSON: _drop, ...rest } = seeded;
      return rest;
    };

    const first = store.setFlags('ws', 'DOC-1', { done: true });
    const second = store.setFlags('ws', 'DOC-2', { review: true });
    await expect(first).resolves.toEqual({ done: true });
    await expect(second).rejects.toThrow('ENOSPC');

    expect(store.flagsOf('ws')['DOC-2']).toBeUndefined();
    const persisted = JSON.parse(await readFile(join(dir, 'flags.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(persisted['ws'] ?? {})).toEqual(['DOC-9', 'DOC-1']);
  });

  it('never leaves a checkout on disk that the caller was told was refused', async () => {
    const store = new Store(dir);
    await store.load();
    const seeded: WorktreeRecord & { toJSON?: () => unknown } = {
      path: '/w/DOC-9',
      branch: 'DOC-9-x',
    };
    await store.setWorktree('app', 'DOC-9', seeded);
    let serialisations = 0;
    seeded.toJSON = () => {
      serialisations += 1;
      if (serialisations > 1) throw new Error('ENOSPC: no space left on device');
      const { toJSON: _drop, ...rest } = seeded;
      return rest;
    };

    const first = store.setWorktree('app', 'DOC-1', { path: '/w/DOC-1', branch: 'DOC-1-x' });
    const second = store.setWorktree('app', 'DOC-2', { path: '/w/DOC-2', branch: 'DOC-2-x' });
    await first;
    await expect(second).rejects.toThrow('ENOSPC');

    // A checkout on disk the start was told it did not make is a "Remove
    // worktree" button offering to delete a directory nothing created.
    expect(store.worktree('app', 'DOC-2')).toBeUndefined();
    const persisted = JSON.parse(await readFile(join(dir, 'worktrees.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(persisted['app'] ?? {})).toEqual(['DOC-9', 'DOC-1']);
  });

  it('never drops a checkout from disk that the caller was told it kept', async () => {
    const store = new Store(dir);
    await store.load();
    await store.setWorktree('app', 'DOC-1', { path: '/w/DOC-1', branch: 'DOC-1-x' });
    await store.setWorktree('app', 'DOC-2', { path: '/w/DOC-2', branch: 'DOC-2-x' });
    const seeded: WorktreeRecord & { toJSON?: () => unknown } = {
      path: '/w/DOC-9',
      branch: 'DOC-9-x',
    };
    await store.setWorktree('app', 'DOC-9', seeded);
    let serialisations = 0;
    seeded.toJSON = () => {
      serialisations += 1;
      if (serialisations > 1) throw new Error('ENOSPC: no space left on device');
      const { toJSON: _drop, ...rest } = seeded;
      return rest;
    };

    const first = store.clearWorktree('app', 'DOC-1');
    const second = store.clearWorktree('app', 'DOC-2');
    await first;
    await expect(second).rejects.toThrow('ENOSPC');

    expect(store.worktree('app', 'DOC-2')?.path).toBe('/w/DOC-2');
    const persisted = JSON.parse(await readFile(join(dir, 'worktrees.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(persisted['app'] ?? {})).toEqual(['DOC-2', 'DOC-9']);
  });

  it('removes the temporary file when the rename it was written for fails', async () => {
    // Nothing ever cleans dataDir, so a leaked temp file is there for good.
    const destination = join(dir, 'a-directory-in-the-way.json');
    await mkdir(destination, { recursive: true });

    await expect(writeJsonAtomic(destination, { version: 1 })).rejects.toThrow();

    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

  it('caps the keys of an object in a raw payload, not only the members of an array', async () => {
    const store = new Store(dir);
    await store.load();
    const wide = Object.fromEntries(
      Array.from({ length: 500 }, (_value, index) => [`key-${String(index)}`, index]),
    );

    await store.appendEvent('qc-DOC-1-implement', {
      at: '2026-09-09T10:00:00.000Z',
      event: { hook_event_name: 'PostToolUse', tool_response: wide },
      state: 'working',
    });

    const [entry] = await store.readEvents('qc-DOC-1-implement');
    const event = entry?.event as { tool_response: Record<string, unknown> };
    // The count, not just the marker: asserting the marker alone leaves the cap
    // itself deletable, because the marker is written either way.
    expect(Object.keys(event.tool_response)).toHaveLength(EVENT_MEMBERS_MAX + 1);
    expect(JSON.stringify(event.tool_response)).toContain('truncated 300 keys');
  });

  it('never lets the truncation marker overwrite a key the payload itself sent', async () => {
    const store = new Store(dir);
    await store.load();
    const wide: Record<string, unknown> = { [TRUNCATION_MARKER_KEY]: 'the payload said this' };
    for (let index = 0; index < 500; index += 1) wide[`key-${String(index)}`] = index;

    await store.appendEvent('qc-DOC-1-implement', {
      at: '2026-09-09T10:00:00.000Z',
      event: { tool_response: wide },
      state: 'working',
    });

    const [entry] = await store.readEvents('qc-DOC-1-implement');
    const event = entry?.event as { tool_response: Record<string, unknown> };
    expect(event.tool_response[TRUNCATION_MARKER_KEY]).toBe('the payload said this');
    expect(JSON.stringify(event.tool_response)).toContain('truncated 301 keys');
  });

  it('waits for every queued write before it reports the store flushed', async () => {
    // A hook answered 204 has its write on the queue; a shutdown that exits
    // before the queue drains loses the record change it was answered for.
    const store = new Store(dir);
    await store.load();

    void store.saveSession(makeRecord({ id: 'qc-DOC-1-implement' }));
    void store.saveSession(makeRecord({ id: 'qc-DOC-2-implement' }));
    await store.flush();

    const persisted = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as unknown[];
    expect(persisted).toHaveLength(2);
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
