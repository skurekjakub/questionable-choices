import type { ConnectorConfig, IssueSource, WorkspaceQuery } from '../../core/types.js';
import { createJiraIssueSource, type CreateJiraIssueSourceOptions } from './jira/index.js';

/**
 * Options shared by every issue-source connector.
 */
export type CreateIssueSourceOptions = CreateJiraIssueSourceOptions;

/**
 * Builds the issue source one workspace reads through.
 *
 * @param workspaceId - Id of the workspace; becomes `IssueSource.id`.
 * @param connector - Account the workspace reads through; several workspaces
 *   may share one.
 * @param query - The workspace's epic, query override and review statuses.
 * @param env - Environment the named credential variables are read from;
 *   defaults to the current process environment.
 * @param options - Transport overrides passed on to the connector.
 * @returns The issue source.
 * @throws {Error} When the connector names an unknown type.
 */
export function createIssueSource(
  workspaceId: string,
  connector: ConnectorConfig,
  query: WorkspaceQuery,
  env: Record<string, string | undefined> = process.env,
  options: CreateIssueSourceOptions = {},
): IssueSource {
  if (connector.type === 'jira') {
    return createJiraIssueSource(workspaceId, connector, query, env, options);
  }
  throw new Error(`unknown connector type '${(connector as { type: string }).type}'`);
}

export {
  JiraClient,
  JiraHttpError,
  JiraIssueSource,
  MissingCredentialsError,
  createJiraIssueSource,
} from './jira/index.js';
export type { CreateJiraIssueSourceOptions } from './jira/index.js';
