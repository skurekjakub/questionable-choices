import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fatalExit, isProcessEntry } from '../../src/server/util.js';

let scratch = '';

afterEach(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
  scratch = '';
});

describe('isProcessEntry', () => {
  it('answers false when the process was started with no entry path at all', () => {
    expect(isProcessEntry(import.meta.url, undefined)).toBe(false);
  });

  it('answers false for an entry path that is not the module', () => {
    expect(isProcessEntry(import.meta.url, '/nonexistent/some-other-entry.js')).toBe(false);
  });

  it('answers false for an entry path that cannot be resolved at all', () => {
    expect(isProcessEntry('file:///nonexistent/module.js', '/nonexistent/module.js')).toBe(false);
  });

  it('answers true for the module itself', () => {
    const self = new URL(import.meta.url).pathname;
    expect(isProcessEntry(import.meta.url, self)).toBe(true);
  });

  it('answers true when the entry path reaches the module through a symlink', async () => {
    // A checkout reached through a symlink gives `import.meta.url` the real
    // path and `argv[1]` the link, so a string comparison of the two says the
    // module is not the entry and the server silently never boots.
    scratch = await mkdtemp(join(tmpdir(), 'qc-entry-'));
    const real = join(scratch, 'real-main.js');
    const link = join(scratch, 'linked-main.js');
    await writeFile(real, '// entry\n', 'utf8');
    await symlink(real, link);

    expect(isProcessEntry(pathToFileURL(real).href, link)).toBe(true);
    expect(pathToFileURL(real).href === pathToFileURL(link).href).toBe(false);
  });
});

describe('fatalExit', () => {
  it('sets the exit code before waiting for either stream to drain', () => {
    // `process.exit` discards buffered output when the stream is a pipe, which
    // is how a supervisor runs the server and how npm runs `config:check`.
    const before = process.exitCode;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      fatalExit(3);

      expect(process.exitCode).toBe(3);
      expect(out).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.exitCode = before;
    }
  });

  it('waits for stderr once stdout has drained', () => {
    const before = process.exitCode;
    const out = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((_chunk: unknown, done?: unknown) => {
        if (typeof done === 'function') (done as () => void)();
        return true;
      });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      fatalExit(4);

      expect(err).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.exitCode = before;
    }
  });
});
