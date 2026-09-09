import { execFile } from 'node:child_process';

/**
 * Columns new tmux sessions are created with.
 */
export const TMUX_WIDTH = 220;

/**
 * Rows new tmux sessions are created with.
 */
export const TMUX_HEIGHT = 50;

/**
 * Terminal type the attach pty advertises.
 */
export const TMUX_TERM = 'xterm-256color';

/**
 * Standard streams of a finished tmux invocation.
 */
export interface TmuxOutput {
  /** Everything tmux wrote to stdout. */
  stdout: string;
  /** Everything tmux wrote to stderr. */
  stderr: string;
}

/**
 * Result of a tmux invocation that is allowed to fail.
 */
export interface TmuxAttempt extends TmuxOutput {
  /** Whether tmux exited zero. */
  ok: boolean;
  /** Exit code, or null when tmux never started. */
  exitCode: number | null;
}

/**
 * Renders a tmux invocation the way a person would type it.
 *
 * @param args - Arguments passed to tmux, without the executable.
 * @returns The command line, e.g. `tmux has-session -t qc-DOC-1-implement`.
 */
export function tmuxCommandLine(args: readonly string[]): string {
  return ['tmux', ...args].join(' ');
}

/**
 * Thrown when tmux exits non-zero or cannot be started.
 */
export class TmuxError extends Error {
  /** Arguments tmux was called with. */
  readonly args: string[];
  /** Exit code, or null when tmux never started. */
  readonly exitCode: number | null;
  /** Everything tmux wrote to stderr. */
  readonly stderr: string;

  /**
   * Builds a tmux error naming the exact command that failed.
   *
   * @param args - Arguments tmux was called with.
   * @param exitCode - Exit code, or null when tmux never started.
   * @param stderr - Everything tmux wrote to stderr.
   */
  constructor(args: string[], exitCode: number | null, stderr: string) {
    const trimmed = stderr.trim();
    const what = exitCode === null ? 'could not be started' : `exited ${exitCode}`;
    super(`${tmuxCommandLine(args)} ${what}${trimmed === '' ? '' : `: ${trimmed}`}`);
    this.name = 'TmuxError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Builds the arguments that create a session's detached tmux window.
 *
 * @param sessionId - tmux session name to create.
 * @param cwd - Directory the window starts in.
 * @param runScript - Absolute path of the generated launcher script.
 * @returns The arguments for tmux.
 */
export function newSessionArgv(sessionId: string, cwd: string, runScript: string): string[] {
  return [
    'new-session',
    '-d',
    '-s',
    sessionId,
    '-c',
    cwd,
    '-x',
    String(TMUX_WIDTH),
    '-y',
    String(TMUX_HEIGHT),
    'bash',
    runScript,
  ];
}

/**
 * Builds the arguments that make a session follow its newest viewer's size.
 *
 * @param sessionId - tmux session name to configure.
 * @returns The arguments for tmux.
 */
export function windowSizeArgv(sessionId: string): string[] {
  return ['set-option', '-t', sessionId, 'window-size', 'latest'];
}

/**
 * Builds the arguments that probe whether a session exists.
 *
 * @param sessionId - tmux session name to probe.
 * @returns The arguments for tmux.
 */
export function hasSessionArgv(sessionId: string): string[] {
  return ['has-session', '-t', sessionId];
}

/**
 * Builds the arguments that send an interrupt to a session.
 *
 * @param sessionId - tmux session name to interrupt.
 * @returns The arguments for tmux.
 */
export function sendEscapeArgv(sessionId: string): string[] {
  return ['send-keys', '-t', sessionId, 'Escape'];
}

/**
 * Builds the arguments that kill a session.
 *
 * @param sessionId - tmux session name to kill.
 * @returns The arguments for tmux.
 */
export function killSessionArgv(sessionId: string): string[] {
  return ['kill-session', '-t', sessionId];
}

/**
 * Builds the arguments that attach a pty to a session.
 *
 * @param sessionId - tmux session name to attach to.
 * @returns The arguments for tmux.
 */
export function attachArgv(sessionId: string): string[] {
  return ['attach-session', '-t', sessionId];
}

/**
 * Runs tmux without letting a non-zero exit throw.
 *
 * Arguments are passed as argv, never interpolated into a shell string.
 *
 * @param args - Arguments passed to tmux, without the executable.
 * @returns The exit code and both streams.
 */
export function tmuxAttempt(args: string[]): Promise<TmuxAttempt> {
  return new Promise((resolve) => {
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      const code = (error as { code?: number | string | undefined }).code;
      resolve({
        ok: false,
        exitCode: typeof code === 'number' ? code : null,
        stdout,
        stderr: stderr === '' ? error.message : stderr,
      });
    });
  });
}

/**
 * Runs tmux and requires it to succeed.
 *
 * @param args - Arguments passed to tmux, without the executable.
 * @returns Both streams of the successful invocation.
 * @throws {TmuxError} When tmux exits non-zero or cannot be started.
 */
export async function tmux(args: string[]): Promise<TmuxOutput> {
  const attempt = await tmuxAttempt(args);
  if (!attempt.ok) throw new TmuxError(args, attempt.exitCode, attempt.stderr);
  return { stdout: attempt.stdout, stderr: attempt.stderr };
}
