import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnvFile, parseEnvFile } from '../../src/server/env-file.js';

describe('parseEnvFile', () => {
  it('reads plain, quoted and exported assignments and skips comments and blanks', () => {
    const text = [
      '# credentials',
      '',
      'PLAIN=one two ',
      'export EXPORTED=three',
      'DOUBLE="four # not a comment"',
      "SINGLE='five'",
      'not an assignment',
      'EMPTY=',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      PLAIN: 'one two',
      EXPORTED: 'three',
      DOUBLE: 'four # not a comment',
      SINGLE: 'five',
      EMPTY: '',
    });
  });

  it('keeps the last value of a name that repeats', () => {
    expect(parseEnvFile('A=1\nA=2')).toEqual({ A: '2' });
  });
});

describe('applyEnvFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qc-env-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('fills in names the environment lacks and reports them', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'JIRA_EMAIL=me@example.com\nJIRA_PAT=secret\n');
    const env: Record<string, string | undefined> = {};
    expect(applyEnvFile(path, env)).toEqual(['JIRA_EMAIL', 'JIRA_PAT']);
    expect(env).toEqual({ JIRA_EMAIL: 'me@example.com', JIRA_PAT: 'secret' });
  });

  it('never overrides a variable the shell already exported', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'JIRA_PAT=from-file\n');
    const env: Record<string, string | undefined> = { JIRA_PAT: 'from-shell' };
    expect(applyEnvFile(path, env)).toEqual([]);
    expect(env['JIRA_PAT']).toBe('from-shell');
  });

  it('treats a missing file as empty and rethrows any other read failure', async () => {
    const env: Record<string, string | undefined> = {};
    expect(applyEnvFile(join(directory, 'absent.env'), env)).toEqual([]);
    expect(env).toEqual({});
    expect(() => applyEnvFile(directory, env)).toThrow();
  });
});
