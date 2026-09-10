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
  wrapPty,
  type PtyLike,
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
  compactModel: 'claude-sonnet-5',
};

let root = '';
let dataDir = '';
let home = '';

/**
 * Stands in for the store's own session-directory resolver.
 *
 * @param sessionId - Id of the session.
 * @returns The directory the session's generated files belong in.
 */
function sessionDir(sessionId: string): string {
  return join(dataDir, 'sessions', sessionId);
}

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
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });
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
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });

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
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });

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
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });

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
      sessionDir,
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
      sessionDir,
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
      sessionDir,
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
      sessionDir,
      home,
    });

    await expect(runner.resume(makeRecord({ claudeSessionId: null }))).rejects.toBeInstanceOf(
      ResumeUnavailableError,
    );
  });
});

describe('createRunner', () => {
  it('builds the claude-tmux runner', () => {
    const runner = createRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });
    expect(runner.type).toBe('claude-tmux');
  });

  it('refuses an unknown runner type', () => {
    const config = { ...RUNNER_CONFIG, type: 'screen' } as unknown as RunnerConfig;
    expect(() => createRunner({ config, port: 4400, home, sessionDir })).toThrow(
      /unknown runner type/,
    );
  });
});

describe('ClaudeTmuxRunner.sessionDir', () => {
  it('puts one directory per session under the data directory', () => {
    const runner = new ClaudeTmuxRunner({ config: RUNNER_CONFIG, port: 4400, home, sessionDir });
    expect(runner.sessionDir('qc-DOC-1-implement')).toBe(
      join(dataDir, 'sessions', 'qc-DOC-1-implement'),
    );
  });

  it('writes where an injected resolver says, so the store reads the same files', async () => {
    const runner = new ClaudeTmuxRunner({
      config: RUNNER_CONFIG,
      port: 4400,
      home,
      sessionDir: (sessionId: string) => join(dataDir, 'elsewhere', sessionId),
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

describe('wrapPty', () => {
  /**
   * Builds a pty stand-in whose calls can be made to throw.
   *
   * @param throwing - Which calls raise `EBADF` instead of running.
   * @returns The pty and the calls it recorded.
   */
  function fakePty(throwing: Set<'write' | 'resize' | 'kill'> = new Set()): {
    pty: PtyLike;
    calls: string[];
    emitData: (chunk: string) => void;
    emitExit: (exitCode: number) => void;
  } {
    const calls: string[] = [];
    let onData = (_chunk: string): void => undefined;
    let onExit = (_event: { exitCode: number }): void => undefined;
    const raise = (name: 'write' | 'resize' | 'kill', args: unknown[] = []): void => {
      // The arguments, not just the name: a wrapper that dropped a payload or
      // transposed a reflow would otherwise leave every assertion here green.
      calls.push(args.length === 0 ? name : `${name}(${args.map(String).join(',')})`);
      if (throwing.has(name)) throw new Error(`ioctl(2) failed, EBADF (${name})`);
    };
    return {
      pty: {
        onData: (listener) => (onData = listener),
        onExit: (listener) => (onExit = listener),
        write: (data: string) => raise('write', [JSON.stringify(data)]),
        resize: (cols: number, rows: number) => raise('resize', [cols, rows]),
        kill: () => raise('kill'),
      },
      calls,
      emitData: (chunk) => onData(chunk),
      emitExit: (exitCode) => onExit({ exitCode }),
    };
  }

  it('pipes output through and reports the exit code alone', () => {
    const { pty, emitData, emitExit } = fakePty();
    const terminal = wrapPty(pty);
    const chunks: string[] = [];
    const exits: number[] = [];
    terminal.onData((chunk) => chunks.push(chunk));
    terminal.onExit((exitCode) => exits.push(exitCode));

    emitData('hello');
    emitExit(130);

    expect(chunks).toEqual(['hello']);
    expect(exits).toEqual([130]);
  });

  it.each(['write', 'resize', 'kill'] as const)(
    'swallows the EBADF a closed descriptor raises from %s',
    (name) => {
      // node-pty reports a descriptor closed by its tmux client by throwing on
      // the next call, so an unguarded one takes the viewer's socket with it.
      const { pty, calls } = fakePty(new Set([name]));
      const terminal = wrapPty(pty);

      expect(() => {
        terminal.write('ls\r');
        terminal.resize(80, 24);
        terminal.dispose();
      }).not.toThrow();
      expect(calls).toEqual(['write("ls\\r")', 'resize(80,24)', 'kill']);
    },
  );

  it('passes a write, a resize and a dispose straight through when the pty is healthy', () => {
    const { pty, calls } = fakePty();
    const terminal = wrapPty(pty);

    terminal.write('ls\r');
    terminal.resize(100, 30);
    terminal.dispose();

    // Columns before rows: node-pty takes (cols, rows) and a terminal takes
    // (rows, cols) in half the APIs that touch it, so a transposed reflow is
    // the mistake this pins.
    expect(calls).toEqual(['write("ls\\r")', 'resize(100,30)', 'kill']);
  });
});
