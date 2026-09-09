import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
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
 * Everything the runner needs to launch sessions on this machine.
 */
export interface ClaudeTmuxRunnerOptions {
  /** Runner settings from the configuration file. */
  config: RunnerConfig;
  /** Port the dashboard listens on, baked into every generated hook URL. */
  port: number;
  /** Absolute directory the session directories are created under. */
  dataDir: string;
  /** Owner's home directory, read once for their own status-line command. */
  home: string;
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
  private readonly dataDir: string;
  private readonly ownerStatuslineCommand: string | null;

  /**
   * Builds a runner for one dashboard instance.
   *
   * The owner's status-line command is read once here: the generated override
   * replaces theirs, so the script has to re-invoke whatever it was at start.
   *
   * @param options - Runner settings, dashboard port, data directory and home.
   */
  constructor(options: ClaudeTmuxRunnerOptions) {
    this.config = options.config;
    this.port = options.port;
    this.dataDir = options.dataDir;
    this.ownerStatuslineCommand = readOwnerStatuslineCommand(options.home);
  }

  /**
   * Directory holding one session's generated files.
   *
   * @param sessionId - Id of the session.
   * @returns The absolute directory path.
   */
  sessionDir(sessionId: string): string {
    return join(this.dataDir, 'sessions', sessionId);
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
   * Launches a new `claude` process for a record that has never run.
   *
   * @param request - Record to launch plus its bootstrap decision.
   * @returns Nothing; progress is reported through launcher events.
   * @throws {TmuxError} When tmux is missing or refuses the session.
   */
  async start(request: RunnerStartRequest): Promise<void> {
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
   * @throws {TmuxError} When tmux is missing or refuses the session.
   */
  async resume(record: SessionRecord): Promise<void> {
    const claudeSessionId = record.claudeSessionId;
    if (claudeSessionId === null) throw new ResumeUnavailableError(record.id);
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
    const pty: IPty = spawn('tmux', attachArgv(sessionId), {
      name: TMUX_TERM,
      cols,
      rows,
      env: { ...process.env, TERM: TMUX_TERM },
    });
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
          // The pty's descriptor is closed as soon as its tmux client exits,
          // and node-pty throws on the next call rather than reporting it.
        }
      },
      resize(nextCols: number, nextRows: number): void {
        try {
          pty.resize(nextCols, nextRows);
        } catch {
          // Same closed descriptor as write, raised as `ioctl(2) failed,
          // EBADF` when a viewer left open past a kill reflows its terminal.
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

export {
  BYPASS_PERMISSIONS_FLAG,
  HOOK_TIMEOUT_SECONDS,
  NOTIFICATION_MATCHER,
  STATUSLINE_EVENT,
  buildRunScript,
  buildSettings,
  buildSettingsFile,
  buildStatuslineScript,
  claudeArgv,
  claudeCommandLine,
  hookCommand,
  hookUrl,
  launcherUrl,
  shellQuote,
} from './session-files.js';
export type {
  GeneratedHookCommand,
  GeneratedHookEntry,
  GeneratedSettings,
  RunScriptContext,
  SettingsContext,
  StatuslineContext,
} from './session-files.js';
export {
  TMUX_HEIGHT,
  TMUX_TERM,
  TMUX_WIDTH,
  TmuxError,
  attachArgv,
  hasSessionArgv,
  killSessionArgv,
  newSessionArgv,
  sendEscapeArgv,
  tmux,
  tmuxAttempt,
  tmuxCommandLine,
  windowSizeArgv,
} from './tmux.js';
export type { TmuxAttempt, TmuxOutput } from './tmux.js';
