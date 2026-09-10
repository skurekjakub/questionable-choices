import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type {
  Runner,
  RunnerConfig,
  RunnerStartRequest,
  RunnerTerminal,
  SessionRecord,
} from '../../../core/types.js';
import {
  buildRunScript,
  buildSettingsFile,
  buildStatuslineScript,
  type RunScriptContext,
} from './session-files.js';
import {
  TMUX_TERM,
  attachArgv,
  hasSessionArgv,
  killSessionArgv,
  newSessionArgv,
  sendEscapeArgv,
  tmux,
  tmuxAttempt,
  windowSizeArgv,
} from './tmux.js';

/**
 * Thrown when a resume is asked for on a record that never reported a Claude
 * session id.
 */
export class ResumeUnavailableError extends Error {
  /** Id of the session that cannot be resumed. */
  readonly sessionId: string;

  /**
   * Builds a resume-unavailable error.
   *
   * @param sessionId - Id of the session that cannot be resumed.
   */
  constructor(sessionId: string) {
    super(`${sessionId} has no claude session id to resume`);
    this.name = 'ResumeUnavailableError';
    this.sessionId = sessionId;
  }
}

/**
 * Thrown when a command the runner is about to launch is not on the machine.
 */
export class MissingExecutableError extends Error {
  /** The command that could not be resolved. */
  readonly command: string;

  /**
   * Builds a missing-executable error naming the command.
   *
   * @param command - Executable name or path that did not resolve.
   */
  constructor(command: string) {
    super(`${command} is not an executable on PATH`);
    this.name = 'MissingExecutableError';
    this.command = command;
  }
}

/**
 * Reports whether a path names a file this process may execute.
 *
 * @param path - Path to probe.
 * @returns True when the file exists and carries the execute bit.
 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a command the way a shell would.
 *
 * @param command - Executable name, or a path when it contains a separator.
 * @param searchPath - `PATH` value the directories are taken from.
 * @returns The resolved path, or null when nothing on the path matches.
 */
export function resolveExecutable(command: string, searchPath: string): string | null {
  if (command === '') return null;
  if (command.includes('/')) return isExecutable(command) ? command : null;
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Everything the runner needs to launch sessions on this machine.
 */
export interface ClaudeTmuxRunnerOptions {
  /** Runner settings from the configuration file. */
  config: RunnerConfig;
  /** Port the dashboard listens on, baked into every generated hook URL. */
  port: number;
  /** Owner's home directory, read once for their own status-line command. */
  home: string;
  /**
   * Resolves the directory one session's generated files live in. It is the
   * store's own resolver, so the runner's scripts and the store's event log
   * share one directory and neither side restates the layout.
   */
  sessionDir: (sessionId: string) => string;
}

/**
 * Reads the owner's own status-line command out of their user settings.
 *
 * @param home - Owner's home directory.
 * @returns The command, or null when the file is absent, unreadable or names none.
 */
export function readOwnerStatuslineCommand(home: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const statusLine = (parsed as { statusLine?: unknown }).statusLine;
  if (typeof statusLine !== 'object' || statusLine === null) return null;
  const command = (statusLine as { command?: unknown }).command;
  return typeof command === 'string' && command !== '' ? command : null;
}

/**
 * The part of a `node-pty` process a viewer's terminal drives.
 */
export interface PtyLike {
  /**
   * Registers a listener for bytes the pty emits.
   *
   * @param listener - Called with each chunk.
   * @returns Anything; the return value is not used.
   */
  onData(listener: (chunk: string) => void): unknown;
  /**
   * Registers a listener for the pty ending.
   *
   * @param listener - Called once with the exit code and signal.
   * @returns Anything; the return value is not used.
   */
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  /**
   * Writes bytes into the pty.
   *
   * @param data - Bytes to write.
   * @returns Nothing.
   * @throws {Error} When the descriptor is already closed.
   */
  write(data: string): void;
  /**
   * Resizes the pty.
   *
   * @param cols - New column count.
   * @param rows - New row count.
   * @returns Nothing.
   * @throws {Error} When the descriptor is already closed.
   */
  resize(cols: number, rows: number): void;
  /**
   * Ends the pty.
   *
   * @returns Nothing.
   * @throws {Error} When the process is already gone.
   */
  kill(): void;
}

/**
 * Presents one pty as the terminal a viewer socket drives.
 *
 * Every call is guarded: a pty's descriptor closes as soon as its tmux client
 * exits, and node-pty reports that by throwing on the next call rather than by
 * telling anyone, so an unguarded write or resize takes the socket down with it.
 *
 * @param pty - The pty to wrap.
 * @returns The terminal.
 */
export function wrapPty(pty: PtyLike): RunnerTerminal {
  return {
    onData(listener: (chunk: string) => void): void {
      pty.onData(listener);
    },
    onExit(listener: (exitCode: number) => void): void {
      pty.onExit(({ exitCode }) => listener(exitCode));
    },
    write(data: string): void {
      try {
        pty.write(data);
      } catch {
        // The descriptor is closed; the bytes have nowhere to go and the
        // viewer's socket must not be torn down over it.
      }
    },
    resize(cols: number, rows: number): void {
      try {
        pty.resize(cols, rows);
      } catch {
        // Raised as `ioctl(2) failed, EBADF` when a viewer left open past a
        // kill reflows its terminal.
      }
    },
    dispose(): void {
      try {
        pty.kill();
      } catch {
        // The pty is already gone; detaching a dead viewer is not an error.
      }
    },
  };
}

/**
 * Which generated files one write of a session directory produces.
 */
interface SessionFilesRequest {
  /** The record the files are generated for. */
  record: SessionRecord;
  /** Whether the bootstrap command should run before `claude`. */
  needsBootstrap: boolean;
  /** Shell command to run as the bootstrap, or null when there is none. */
  bootstrap: string | null;
  /** Claude session id to resume, or null to send the record's prompt. */
  resumeSessionId: string | null;
}

/**
 * Launches `claude` in tmux, with generated hook settings reporting back to the
 * dashboard.
 */
export class ClaudeTmuxRunner implements Runner {
  /** Runner type id, matching `RunnerConfig.type`. */
  readonly type = 'claude-tmux';

  private readonly config: RunnerConfig;
  private readonly port: number;
  private readonly resolveSessionDir: (sessionId: string) => string;
  private readonly ownerStatuslineCommand: string | null;

  /**
   * Builds a runner for one dashboard instance.
   *
   * The owner's status-line command is read once here and reused by every
   * generated script, so an edit to their settings needs a restart to apply.
   *
   * @param options - Runner settings, dashboard port, data directory and home.
   */
  constructor(options: ClaudeTmuxRunnerOptions) {
    this.config = options.config;
    this.port = options.port;
    this.resolveSessionDir = options.sessionDir;
    this.ownerStatuslineCommand = readOwnerStatuslineCommand(options.home);
  }

  /**
   * Directory holding one session's generated files.
   *
   * @param sessionId - Id of the session.
   * @returns The absolute directory path; it may not exist yet.
   */
  sessionDir(sessionId: string): string {
    return this.resolveSessionDir(sessionId);
  }

  /**
   * Builds the context the launcher script is rendered from.
   *
   * @param request - Record, bootstrap decision and resume target.
   * @returns The render context.
   */
  private runScriptContext(request: SessionFilesRequest): RunScriptContext {
    return {
      sessionId: request.record.id,
      port: this.port,
      dir: this.sessionDir(request.record.id),
      claudeBin: this.config.claudeBin,
      issueKey: request.record.issueKey,
      model: request.record.model,
      effort: request.record.effort,
      permissionMode: request.record.permissionMode,
      needsBootstrap: request.needsBootstrap,
      bootstrap: request.bootstrap,
      resumeSessionId: request.resumeSessionId,
    };
  }

  /**
   * Writes the four generated files of one session directory.
   *
   * @param request - Record, bootstrap decision and resume target.
   * @returns The directory the files were written to.
   * @throws {Error} When the directory or a file cannot be written.
   */
  async writeSessionFiles(request: SessionFilesRequest): Promise<string> {
    const dir = this.sessionDir(request.record.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prompt.txt'), request.record.prompt, 'utf8');
    await writeFile(
      join(dir, 'settings.json'),
      buildSettingsFile({ sessionId: request.record.id, port: this.port, dir }),
      'utf8',
    );
    await writeFile(
      join(dir, 'statusline.sh'),
      buildStatuslineScript({
        sessionId: request.record.id,
        port: this.port,
        chainedCommand: this.ownerStatuslineCommand,
      }),
      'utf8',
    );
    await writeFile(join(dir, 'run.sh'), buildRunScript(this.runScriptContext(request)), 'utf8');
    return dir;
  }

  /**
   * Creates the detached tmux window that runs a session's launcher.
   *
   * @param record - Record whose id names the tmux session.
   * @param dir - Directory holding the generated launcher script.
   * @returns Nothing.
   * @throws {TmuxError} When tmux is missing or refuses the session.
   */
  private async startWindow(record: SessionRecord, dir: string): Promise<void> {
    await tmux(newSessionArgv(record.id, record.cwd, join(dir, 'run.sh')));
    await tmux(windowSizeArgv(record.id));
  }

  /**
   * Refuses a launch whose CLI is not on the machine.
   *
   * @returns Nothing.
   * @throws {MissingExecutableError} When the configured CLI does not resolve.
   */
  private requireClaude(): void {
    // A missing CLI would otherwise be discovered by bash inside the window,
    // which exits 127 a second after a start the owner was told succeeded.
    if (resolveExecutable(this.config.claudeBin, process.env['PATH'] ?? '') === null) {
      throw new MissingExecutableError(this.config.claudeBin);
    }
  }

  /**
   * Launches a new `claude` process for a record that has never run.
   *
   * @param request - Record to launch plus its bootstrap decision.
   * @returns Nothing; progress is reported through launcher events.
   * @throws {MissingExecutableError} When the configured CLI is not on PATH.
   * @throws {TmuxError} When tmux is missing or refuses the session.
   */
  async start(request: RunnerStartRequest): Promise<void> {
    // Probed before anything is written: a typo in `claudeBin` would otherwise
    // leave an orphan session directory behind on every attempt.
    this.requireClaude();
    const dir = await this.writeSessionFiles({
      record: request.record,
      needsBootstrap: request.needsBootstrap,
      bootstrap: request.bootstrap ?? null,
      resumeSessionId: null,
    });
    await this.startWindow(request.record, dir);
  }

  /**
   * Relaunches a record with `--resume`, reusing its Claude session id.
   *
   * @param record - Record to resume; its `claudeSessionId` must not be null.
   * @returns Nothing; progress is reported through launcher events.
   * @throws {ResumeUnavailableError} When the record has no Claude session id.
   * @throws {MissingExecutableError} When the configured CLI is not on PATH.
   * @throws {TmuxError} When tmux is missing or refuses the session.
   */
  async resume(record: SessionRecord): Promise<void> {
    const claudeSessionId = record.claudeSessionId;
    if (claudeSessionId === null) throw new ResumeUnavailableError(record.id);
    // Probed before the kill below: a resume that cannot succeed must not take
    // down the tmux session it was meant to replace.
    this.requireClaude();
    // A leftover window would make `new-session` fail with "duplicate session",
    // and the old one is dead by definition once a resume is asked for.
    await tmuxAttempt(killSessionArgv(record.id));
    const dir = await this.writeSessionFiles({
      record,
      needsBootstrap: false,
      bootstrap: null,
      resumeSessionId: claudeSessionId,
    });
    await this.startWindow(record, dir);
  }

  /**
   * Attaches a viewer to the session's tmux window.
   *
   * @param sessionId - Id of the session to attach to.
   * @param cols - Initial column count of the viewer.
   * @param rows - Initial row count of the viewer.
   * @returns The attached terminal.
   * @throws {Error} When the pty cannot be spawned.
   */
  async attach(sessionId: string, cols: number, rows: number): Promise<RunnerTerminal> {
    const { spawn } = await import('node-pty');
    return wrapPty(
      spawn('tmux', attachArgv(sessionId), {
        name: TMUX_TERM,
        cols,
        rows,
        env: { ...process.env, TERM: TMUX_TERM },
      }),
    );
  }

  /**
   * Sends an interrupt (Escape) to the session.
   *
   * @param sessionId - Id of the session to interrupt.
   * @returns Nothing.
   * @throws {TmuxError} When tmux refuses the send.
   */
  async interrupt(sessionId: string): Promise<void> {
    await tmux(sendEscapeArgv(sessionId));
  }

  /**
   * Kills the session's tmux session.
   *
   * @param sessionId - Id of the session to kill.
   * @returns Nothing.
   * @throws {TmuxError} When tmux refuses the kill.
   */
  async kill(sessionId: string): Promise<void> {
    await tmux(killSessionArgv(sessionId));
  }

  /**
   * Reports whether the session's tmux session still exists.
   *
   * @param sessionId - Id of the session to probe.
   * @returns True while tmux still holds the session.
   */
  async isAlive(sessionId: string): Promise<boolean> {
    return (await tmuxAttempt(hasSessionArgv(sessionId))).ok;
  }
}
