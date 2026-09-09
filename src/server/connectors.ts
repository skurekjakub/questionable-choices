import { createIssueSource, createRepo, createRunner } from '../connectors/index.js';
import type { Config, Repo, Runner } from '../core/types.js';
import type { WorkspaceRuntime } from './session-manager.js';

/**
 * Every connector the server runs on, built from one configuration.
 */
export interface Connectors {
  /** Runner shared by every workspace. */
  runner: Runner;
  /** One repo connector per configured repo, keyed by repo id. */
  repos: Map<string, Repo>;
  /** One runtime per configured workspace, in configuration order. */
  workspaces: WorkspaceRuntime[];
}

/**
 * Builds the runtime of one workspace over an already-built repo connector.
 *
 * @param config - Validated configuration holding the workspace and its repo.
 * @param workspaceId - Id of the workspace to build.
 * @param repos - Repo connectors, keyed by repo id.
 * @param env - Environment the named credential variables are read from.
 * @returns The runtime.
 * @throws {Error} When the workspace, its repo or its connector is unknown.
 */
export function buildWorkspaceRuntime(
  config: Config,
  workspaceId: string,
  repos: Map<string, Repo>,
  env: Record<string, string | undefined> = process.env,
): WorkspaceRuntime {
  const workspace = config.workspaces[workspaceId];
  if (workspace === undefined) throw new Error(`unknown workspace '${workspaceId}'`);
  const repoConfig = config.repos[workspace.repo];
  const repo = repos.get(workspace.repo);
  if (repoConfig === undefined || repo === undefined) {
    throw new Error(`workspace '${workspaceId}' names unknown repo '${workspace.repo}'`);
  }
  const connector = config.connectors[workspace.connector];
  if (connector === undefined) {
    throw new Error(`workspace '${workspaceId}' names unknown connector '${workspace.connector}'`);
  }
  return {
    id: workspaceId,
    config: workspace,
    repoConfig,
    repo,
    issues: createIssueSource(workspaceId, connector, workspace, env),
  };
}

/**
 * Builds the issue sources, repos and runner named by a configuration.
 *
 * This is the server's only import of the connector package, so a new connector
 * type is wired in one place and everything above here stays interface-only.
 *
 * @param config - Validated configuration.
 * @param home - Owner's home directory; the runner reads their own settings from it.
 * @param sessionDir - Resolver for a session's generated-file directory, so the
 *   runner writes where the store reads.
 * @param env - Environment the named credential variables are read from.
 * @returns The runner, the repo connectors and one runtime per workspace.
 * @throws {Error} When a configured connector type has no implementation.
 */
export function buildConnectors(
  config: Config,
  home: string,
  sessionDir: (sessionId: string) => string,
  env: Record<string, string | undefined> = process.env,
): Connectors {
  const repos = new Map<string, Repo>(
    Object.entries(config.repos).map(([id, repo]) => [id, createRepo(id, repo)]),
  );
  const workspaces = Object.keys(config.workspaces).map((id) =>
    buildWorkspaceRuntime(config, id, repos, env),
  );
  const runner = createRunner({
    config: config.runner,
    port: config.port,
    dataDir: config.dataDir,
    home,
    sessionDir,
  });
  return { runner, repos, workspaces };
}
