import type { Runner } from '../../core/types.js';
import { ClaudeTmuxRunner, type ClaudeTmuxRunnerOptions } from './claude-tmux/index.js';

/**
 * Options shared by every runner connector.
 */
export type CreateRunnerOptions = ClaudeTmuxRunnerOptions;

/**
 * Builds the runner the configuration names.
 *
 * @param options - Runner settings, dashboard port, data directory and home.
 * @returns The runner connector.
 * @throws {Error} When the configuration names an unknown runner type.
 */
export function createRunner(options: CreateRunnerOptions): Runner {
  if (options.config.type === 'claude-tmux') return new ClaudeTmuxRunner(options);
  throw new Error(`unknown runner type '${(options.config as { type: string }).type}'`);
}

export {
  ClaudeTmuxRunner,
  MissingExecutableError,
  ResumeUnavailableError,
  TmuxError,
  readOwnerStatuslineCommand,
  resolveExecutable,
} from './claude-tmux/index.js';
export type { ClaudeTmuxRunnerOptions } from './claude-tmux/index.js';
