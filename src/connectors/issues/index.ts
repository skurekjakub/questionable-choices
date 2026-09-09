import type { IssueSource, IssueSourceConfig } from '../../core/types.js';
import { createJiraIssueSource, type CreateJiraIssueSourceOptions } from './jira/index.js';

/**
 * Options shared by every issue-source connector.
 */
export type CreateIssueSourceOptions = CreateJiraIssueSourceOptions;

/**
 * Builds the issue source a board's configuration names.
 *
 * @param id - Id of the board the source belongs to; becomes `IssueSource.id`.
 * @param config - The board's issue-source configuration.
 * @param env - Environment the named credential variables are read from;
 *   defaults to the current process environment.
 * @param options - Transport overrides passed on to the connector.
 * @returns The issue source.
 * @throws {Error} When the configuration names an unknown source type.
 */
export function createIssueSource(
  id: string,
  config: IssueSourceConfig,
  env: Record<string, string | undefined> = process.env,
  options: CreateIssueSourceOptions = {},
): IssueSource {
  if (config.type === 'jira') return createJiraIssueSource(id, config, env, options);
  throw new Error(`unknown issue source type '${(config as { type: string }).type}'`);
}

export {
  JiraClient,
  JiraHttpError,
  JiraIssueSource,
  MissingCredentialsError,
  createJiraIssueSource,
} from './jira/index.js';
export type { CreateJiraIssueSourceOptions } from './jira/index.js';
