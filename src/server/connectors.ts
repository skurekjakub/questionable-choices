import { createIssueSource, createRunner, createWorkspace } from '../connectors/index.js';
import type { Config, Runner } from '../core/types.js';
import type { WorkspaceRuntime } from './session-manager.js';

/**
 * Every connector the server runs on, built from one configuration.
 */
export interface Connectors {
  /** Runner shared by every workspace. */
  runner: Runner;
  /** One runtime per configured workspace, in configuration order. */
  workspaces: WorkspaceRuntime[];
}

/**
 * Builds the issue sources, workspaces and runner named by a configuration.
 *
 * This is the server's only import of the connector package, so a new connector
 * type is wired in one place and everything above here stays interface-only.
 *
 * @param config - Validated configuration.
 * @param home - Owner's home directory; the runner reads their own settings from it.
 * @param env - Environment the named credential variables are read from.
 * @returns The runner and one runtime per workspace.
 * @throws {Error} When a configured connector type has no implementation.
 */
export function buildConnectors(
  config: Config,
  home: string,
  env: Record<string, string | undefined> = process.env,
): Connectors {
  const workspaces: WorkspaceRuntime[] = Object.entries(config.workspaces).map(
    ([id, workspace]) => ({
      id,
      config: workspace,
      issues: createIssueSource(id, workspace.issues, env),
      workspace: createWorkspace(id, workspace),
    }),
  );
  const runner = createRunner({
    config: config.runner,
    port: config.port,
    dataDir: config.dataDir,
    home,
  });
  return { runner, workspaces };
}
