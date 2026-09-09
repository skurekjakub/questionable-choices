import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  checkEnvironment,
  formatConfigIssues,
  resolveConfigPath,
} from '../core/config.js';
import { loadConfig } from './config-file.js';

/**
 * Everything the check needs, so a test can point it at a temporary file.
 */
export interface ConfigCheckOptions {
  /** Environment `QC_CONFIG` and the named credential variables are read from. */
  env: Record<string, string | undefined>;
  /** Home directory used to resolve the default path and expand `~`. */
  home: string;
  /** Sink for the report; one call per line. */
  log: (line: string) => void;
}

/**
 * Describes what is at a configured repo path.
 *
 * @param path - Absolute path of the main checkout.
 * @returns A one-word verdict: `missing`, `not-a-git-checkout` or `ok`.
 */
function describeRepoPath(path: string): 'missing' | 'not-a-git-checkout' | 'ok' {
  if (!existsSync(path)) return 'missing';
  // A worktree's `.git` is a file, not a directory, so existence is the test.
  return existsSync(join(path, '.git')) ? 'ok' : 'not-a-git-checkout';
}

/**
 * Loads the configuration the server would load and reports what it names.
 *
 * @param options - Environment, home directory and the report sink.
 * @returns 0 when the configuration is usable, 1 when it is not.
 */
export function checkConfig(options: ConfigCheckOptions): number {
  const { env, home, log } = options;
  const path = resolveConfigPath(env, home);
  log(`config: ${path}`);

  let config;
  try {
    config = loadConfig(path, { home });
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    log(cause.message);
    log(formatConfigIssues(cause.issues));
    return 1;
  }

  for (const [id, workspace] of Object.entries(config.workspaces)) {
    log(`workspace ${id} · ${workspace.epic} · ${workspace.connector} · ${workspace.repo}`);
  }

  let usable = true;
  for (const [id, repo] of Object.entries(config.repos)) {
    const verdict = describeRepoPath(repo.path);
    if (verdict !== 'ok') usable = false;
    log(`repo ${id} · ${repo.path} · ${verdict}`);
  }

  for (const warning of checkEnvironment(config, env)) log(warning);
  return usable ? 0 : 1;
}

// Running under `tsx src/server/config-check.ts` is the only case that should
// exit the process; importing the module from a test must not.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(
    checkConfig({
      env: process.env,
      home: homedir(),
      log: (line) => {
        console.log(line);
      },
    }),
  );
}
