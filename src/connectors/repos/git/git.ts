import { execFile } from 'node:child_process';

/**
 * Largest amount of git output that is captured, in bytes.
 */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Milliseconds a network-bound git invocation may run before it is killed.
 *
 * A remote that black-holes packets rather than refusing them makes `git fetch`
 * block for the kernel's connect timeout, and the caller holds a checkout lock
 * for the whole of it. Bounded by git is not the same as bounded.
 */
export const GIT_NETWORK_TIMEOUT_MS = 20_000;

/**
 * Standard streams of a finished git invocation.
 */
export interface GitOutput {
  /** Everything git wrote to stdout. */
  stdout: string;
  /** Everything git wrote to stderr. */
  stderr: string;
}

/**
 * Result of a git invocation that is allowed to fail.
 */
export interface GitAttempt extends GitOutput {
  /** Whether git exited zero. */
  ok: boolean;
  /** Exit code, or null when git never started. */
  exitCode: number | null;
}

/**
 * Renders a git invocation the way a person would type it.
 *
 * @param args - Arguments passed to git, without the executable.
 * @returns The command line, e.g. `git worktree add /path branch`.
 */
export function gitCommandLine(args: readonly string[]): string {
  return ['git', ...args].join(' ');
}

/**
 * Thrown when git exits non-zero or cannot be started.
 */
export class GitError extends Error {
  /** Arguments git was called with. */
  readonly args: string[];
  /** Directory git ran in. */
  readonly cwd: string;
  /** Exit code, or null when git never started. */
  readonly exitCode: number | null;
  /** Everything git wrote to stderr. */
  readonly stderr: string;

  /**
   * Builds a git error naming the exact command that failed.
   *
   * @param args - Arguments git was called with.
   * @param cwd - Directory git ran in.
   * @param exitCode - Exit code, or null when git never started.
   * @param stderr - Everything git wrote to stderr.
   */
  constructor(args: string[], cwd: string, exitCode: number | null, stderr: string) {
    const trimmed = stderr.trim();
    const where = exitCode === null ? 'could not be started' : `exited ${exitCode}`;
    super(`${gitCommandLine(args)} ${where} in ${cwd}${trimmed === '' ? '' : `\n${trimmed}`}`);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface ExecFailure {
  code?: number | string | undefined;
  killed?: boolean | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

/**
 * How one git invocation is bounded.
 */
export interface GitRunOptions {
  /**
   * Milliseconds before git is killed, or 0 for no deadline. A killed
   * invocation comes back as a failure whose stderr names the signal.
   */
  timeoutMs?: number | undefined;
}

/**
 * Runs git without letting a non-zero exit throw.
 *
 * Arguments are passed as argv, never interpolated into a shell string, so a
 * branch or path containing spaces or quotes needs no escaping.
 *
 * @param args - Arguments passed to git, without the executable.
 * @param cwd - Directory to run git in.
 * @param options - Deadline for the invocation; unbounded when absent.
 * @returns The exit code and both streams.
 */
export function gitAttempt(
  args: string[],
  cwd: string,
  options: GitRunOptions = {},
): Promise<GitAttempt> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: options.timeoutMs ?? 0,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, exitCode: 0, stdout, stderr });
          return;
        }
        const failure = error as ExecFailure;
        const exitCode = typeof failure.code === 'number' ? failure.code : null;
        // A killed invocation reports no exit code and often no stderr, so the
        // deadline has to be named here or the failure reads as "git said
        // nothing at all".
        const killed = failure.killed === true;
        const detail = killed
          ? `timed out after ${String(options.timeoutMs ?? 0)} ms`
          : stderr === ''
            ? error.message
            : stderr;
        resolve({ ok: false, exitCode, stdout, stderr: detail });
      },
    );
  });
}

/**
 * Runs git and requires it to succeed.
 *
 * @param args - Arguments passed to git, without the executable.
 * @param cwd - Directory to run git in.
 * @param options - Deadline for the invocation; unbounded when absent.
 * @returns Both streams of the successful invocation.
 * @throws {GitError} When git exits non-zero, is killed, or cannot be started.
 */
export async function git(
  args: string[],
  cwd: string,
  options: GitRunOptions = {},
): Promise<GitOutput> {
  const attempt = await gitAttempt(args, cwd, options);
  if (!attempt.ok) throw new GitError(args, cwd, attempt.exitCode, attempt.stderr);
  return { stdout: attempt.stdout, stderr: attempt.stderr };
}
