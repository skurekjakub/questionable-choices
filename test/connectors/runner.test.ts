import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunner } from '../../src/connectors/runners/index.js';
import {
  ClaudeTmuxRunner,
  MissingExecutableError,
  ResumeUnavailableError,
  resolveExecutable,
  readOwnerStatuslineCommand,
} from '../../src/connectors/runners/claude-tmux/index.js';
import {
  TMUX_HEIGHT,
  TMUX_WIDTH,
  attachArgv,
  hasSessionArgv,
  killSessionArgv,
  newSessionArgv,
  sendEscapeArgv,
  tmuxCommandLine,
  windowSizeArgv,
} from '../../src/connectors/runners/claude-tmux/tmux.js';
import type { RunnerConfig } from '../../src/core/types.js';
import { makeRecord } from '../core/helpers.js';

const RUNNER_CONFIG: RunnerConfig = {
  type: 'claude-tmux',
  claudeBin: 'claude',
  tmuxPrefix: 'qc',
  models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1' }],
  defaultModel: 'claude-fable-5-1',
  defaultEffort: 'high',
  defaultPermissionMode: 'acceptEdits',
};

let root = '';
let dataDir = '';
let home = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qc-runner-'));
  dataDir = join(root, 'data');
  home = join(root, 'home');
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

/**
 * Writes a user settings file into the temporary home.
 *
 * @param settings - Document to serialise, or raw text to write verbatim.
 * @returns Nothing.
 */
async function writeOwnerSettings(settings: unknown): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings),
    'utf8',
  );
}

describe('tmux argument builders', () => {
  it('creates a detached session sized for the browser terminal', () => {
    expect(newSessionArgv('qc-DOC-1-implement', '/repos/wt/DOC-1', '/data/run.sh')).toEqual([
      'new-session',
      '-d',
      '-s',
      'qc-DOC-1-implement',
      '-c',
      '/repos/wt/DOC-1',
      '-x',
      String(TMUX_WIDTH),
      '-y',
      String(TMUX_HEIGHT),
      'bash',
      '/data/run.sh',
    ]);
  });

  it('makes the window follow the most recent viewer', () => {
    expect(windowSizeArgv('qc-DOC-1-implement')).toEqual([
      'set-option',
      '-t',
      'qc-DOC-1-implement',
      'window-size',
      'latest',
    ]);
  });

  it('probes, interrupts, kills and attaches by session id', () => {
    expect(hasSessionArgv('s')).toEqual(['has-session', '-t', 's']);
    expect(sendEscapeArgv('s')).toEqual(['send-keys', '-t', 's', 'Escape']);
    expect(killSessionArgv('s')).toEqual(['kill-session', '-t', 's']);
    expect(attachArgv('s')).toEqual(['attach-session', '-t', 's']);
  });

  it('renders a command line for error messages', () => {
    expect(tmuxCommandLine(hasSessionArgv('s'))).toBe('tmux has-session -t s');
  });
});

describe('readOwnerStatuslineCommand', () => {
  it('answers null when the owner has no settings file', () => {
    expect(readOwnerStatuslineCommand(home)).toBeNull();
  });

  it('answers null for unparsable settings', async () => {
    await writeOwnerSettings('{ not json');
    expect(readOwnerStatuslineCommand(home)).toBeNull();
  });

  it('answers null when the settings name no status line', async () => {
    await writeOwnerSettings({ env: {} });
    expect(readOwnerStatuslineCommand(home)).toBeNull();
  });

  it('reads the command out of the statusLine block', async () => {
    await writeOwnerSettings({ statusLine: { type: 'command', command: 'bash ~/sl.sh' } });
    expect(readOwnerStatuslineCommand(home)).toBe('bash ~/sl.sh');
  });

  it('answers null for an empty command, which would be chained into the script', async () => {
    await writeOwnerSettings({ statusLine: { type: 'command', command: '' } });
    expect(readOwnerStatuslineCommand(home)).toBeNull();
  });
});

describe('ClaudeTmuxRunner.writeSessionFiles', () => {
  it('writes the four generated files into the session directory', async () => {
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });
    const record = makeRecord({ prompt: 'Work on DOC-1' });

    const dir = await runner.writeSessionFiles({
      record,
      needsBootstrap: true,
      bootstrap: 'npm ci',
      resumeSessionId: null,
    });

    expect(dir).toBe(join(dataDir, 'sessions', record.id));
    expect(await readFile(join(dir, 'prompt.txt'), 'utf8')).toBe('Work on DOC-1');
    expect(await readFile(join(dir, 'run.sh'), 'utf8')).toContain('npm ci');
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toBe(`bash '${dir}/statusline.sh'`);
    expect(await readFile(join(dir, 'statusline.sh'), 'utf8')).toContain(
      `/api/hooks/${record.id}/statusline`,
    );
  });

  it('chains the owner status line captured at construction', async () => {
    await writeOwnerSettings({ statusLine: { type: 'command', command: 'bash ~/sl.sh' } });
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });

    const dir = await runner.writeSessionFiles({
      record: makeRecord(),
      needsBootstrap: false,
      bootstrap: null,
      resumeSessionId: null,
    });

    expect(await readFile(join(dir, 'statusline.sh'), 'utf8')).toContain(
      'printf \'%s\' "$payload" | bash ~/sl.sh',
    );
  });

  it('renders a resume launcher without a prompt', async () => {
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });

    const dir = await runner.writeSessionFiles({
      record: makeRecord({ claudeSessionId: 'abc-123' }),
      needsBootstrap: false,
      bootstrap: null,
      resumeSessionId: 'abc-123',
    });
    const script = await readFile(join(dir, 'run.sh'), 'utf8');

    expect(script).toContain("'--resume' 'abc-123'");
    expect(script).not.toContain('prompt.txt');
  });
});

describe('ClaudeTmuxRunner.resume', () => {
  it('refuses a record that never reported a claude session id', async () => {
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });

    await expect(runner.resume(makeRecord({ claudeSessionId: null }))).rejects.toBeInstanceOf(
      ResumeUnavailableError,
    );
  });
});

describe('resolveExecutable', () => {
  it('finds a command on the search path', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const path = join(bin, 'qc-probe');
    await writeFile(path, '#!/bin/sh\n', { mode: 0o755 });

    expect(resolveExecutable('qc-probe', `/nowhere${delimiter}${bin}`)).toBe(path);
  });

  it('answers null for a command nothing on the path provides', () => {
    expect(resolveExecutable('qc-no-such-binary', '/nowhere')).toBeNull();
    expect(resolveExecutable('', '/nowhere')).toBeNull();
  });

  it('answers null for a path that is not executable', async () => {
    const path = join(root, 'not-executable');
    await writeFile(path, 'text\n', { mode: 0o644 });

    expect(resolveExecutable(path, '/nowhere')).toBeNull();
  });

  it('resolves an explicit path without consulting the search path at all', async () => {
    const path = join(root, 'claude-here');
    await writeFile(path, '#!/bin/sh\n', { mode: 0o755 });

    expect(resolveExecutable(path, '')).toBe(path);
  });
});

describe('ClaudeTmuxRunner.start', () => {
  it('refuses to launch when the configured CLI is not on PATH', async () => {
    const runner = new ClaudeTmuxRunner({
      config: { ...RUNNER_CONFIG, claudeBin: 'qc-no-such-binary' },
      port: 4400,
      dataDir,
      home,
    });

    await expect(
      runner.start({ record: makeRecord(), needsBootstrap: false }),
    ).rejects.toBeInstanceOf(MissingExecutableError);
  });

  it('probes the CLI before writing anything, leaving no session directory behind', async () => {
    const runner = new ClaudeTmuxRunner({
      config: { ...RUNNER_CONFIG, claudeBin: 'qc-no-such-binary' },
      port: 4400,
      dataDir,
      home,
    });
    const record = makeRecord();

    await expect(runner.start({ record, needsBootstrap: false })).rejects.toBeInstanceOf(
      MissingExecutableError,
    );

    await expect(readFile(join(dataDir, 'sessions', record.id, 'run.sh'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('ClaudeTmuxRunner.resume', () => {
  it('probes the CLI before killing the session it is replacing', async () => {
    const runner = new ClaudeTmuxRunner({
      config: { ...RUNNER_CONFIG, claudeBin: 'qc-no-such-binary' },
      port: 4400,
      dataDir,
      home,
    });
    const record = makeRecord({ claudeSessionId: 'abc' });

    await expect(runner.resume(record)).rejects.toBeInstanceOf(MissingExecutableError);

    await expect(readFile(join(dataDir, 'sessions', record.id, 'run.sh'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('refuses a record that never reported a claude session id before probing anything', async () => {
    const runner = new ClaudeTmuxRunner({
      config: { ...RUNNER_CONFIG, claudeBin: 'qc-no-such-binary' },
      port: 4400,
      dataDir,
      home,
    });

    await expect(runner.resume(makeRecord({ claudeSessionId: null }))).rejects.toBeInstanceOf(
      ResumeUnavailableError,
    );
  });
});

describe('createRunner', () => {
  it('builds the claude-tmux runner', () => {
    const runner = createRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });
    expect(runner.type).toBe('claude-tmux');
  });

  it('refuses an unknown runner type', () => {
    const config = { ...RUNNER_CONFIG, type: 'screen' } as unknown as RunnerConfig;
    expect(() => createRunner({ config, port: 4400, dataDir, home })).toThrow(
      /unknown runner type/,
    );
  });
});

describe('ClaudeTmuxRunner.sessionDir', () => {
  it('puts one directory per session under the data directory', () => {
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, dataDir, home });
    expect(runner.sessionDir('qc-DOC-1-implement')).toBe(
      join(dataDir, 'sessions', 'qc-DOC-1-implement'),
    );
  });

  it('writes where an injected resolver says, so the store reads the same files', async () => {
    const runner = new ClaudeTmuxRunner({
      config: RUNNER_CONFIG,
      port: 4400,
      dataDir,
      home,
      sessionDir: (sessionId) => join(dataDir, 'elsewhere', sessionId),
    });

    const dir = await runner.writeSessionFiles({
      record: makeRecord(),
      needsBootstrap: false,
      bootstrap: null,
      resumeSessionId: null,
    });

    expect(dir).toBe(join(dataDir, 'elsewhere', 'qc-DOC-1-implement'));
    expect(await readFile(join(dir, 'run.sh'), 'utf8')).toContain(dir);
  });
});
