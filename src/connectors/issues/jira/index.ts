import type {
  Issue,
  IssueSource,
  JiraConnectorConfig,
  WorkspaceQuery,
} from '../../../core/types.js';
import { JiraClient, type FetchLike } from './client.js';
import { buildJql } from './jql.js';
import { mapIssue } from './map.js';

/**
 * Thrown when a Jira request is attempted without both basic-auth credentials.
 *
 * Construction never throws this, so the dashboard still boots and shows the
 * board's source error instead of refusing to start.
 */
export class MissingCredentialsError extends Error {
  /** Names of the environment variables that were expected to hold them. */
  readonly variables: string[];

  /**
   * Builds a missing-credentials error.
   *
   * @param variables - Names of the environment variables that are unset.
   */
  constructor(variables: string[]) {
    super(`jira credentials are missing; set ${variables.join(' and ')}`);
    this.name = 'MissingCredentialsError';
    this.variables = variables;
  }
}

/**
 * Lists the issues of one workspace from a Jira Cloud epic.
 */
export class JiraIssueSource implements IssueSource {
  /** Id of the workspace this source belongs to. */
  readonly id: string;

  private readonly connector: JiraConnectorConfig;
  private readonly query: WorkspaceQuery;
  private readonly client: JiraClient;

  /**
   * Builds a source over an already-configured client.
   *
   * @param id - Id of the workspace this source belongs to.
   * @param connector - Account the issues are read through.
   * @param query - The workspace's epic, query override and review statuses.
   * @param client - Client for the site the connector names.
   */
  constructor(
    id: string,
    connector: JiraConnectorConfig,
    query: WorkspaceQuery,
    client: JiraClient,
  ) {
    this.id = id;
    this.connector = connector;
    this.query = query;
    this.client = client;
  }

  /**
   * Refuses the call when the environment supplied no credentials.
   *
   * @returns Nothing.
   * @throws {MissingCredentialsError} When either credential is missing.
   */
  private assertCredentials(): void {
    if (this.client.hasCredentials) return;
    throw new MissingCredentialsError([this.connector.emailEnv, this.connector.tokenEnv]);
  }

  /**
   * Lists every issue the workspace should show.
   *
   * A resource with no usable key is dropped rather than rendered: the key is
   * what the projection maps sessions by and what the browser URL is built
   * from, so a keyless card would be a dead link on a lane of its own.
   *
   * @returns The issues in Jira rank order.
   * @throws {MissingCredentialsError} When either credential is missing.
   * @throws {JiraHttpError} When Jira rejects the query.
   */
  async list(): Promise<Issue[]> {
    this.assertCredentials();
    const resources = await this.client.searchJql(buildJql(this.query));
    return resources
      .filter((resource) => typeof resource.key === 'string' && resource.key !== '')
      .map((resource) => mapIssue(resource, this.connector.site));
  }

  /**
   * Fetches one issue by key, for issues that dropped out of `list`.
   *
   * @param key - Tracker key of the issue.
   * @returns The issue, or null when Jira has no such issue.
   * @throws {MissingCredentialsError} When either credential is missing.
   * @throws {JiraHttpError} When Jira rejects the request.
   */
  async get(key: string): Promise<Issue | null> {
    this.assertCredentials();
    const resource = await this.client.getIssue(key);
    return resource === null ? null : mapIssue(resource, this.connector.site);
  }
}

/**
 * Options that let a caller substitute the transport.
 */
export interface CreateJiraIssueSourceOptions {
  /** Replacement for the global `fetch`, for tests. */
  fetch?: FetchLike | undefined;
}

/**
 * Builds a Jira issue source, reading its credentials from the environment.
 *
 * @param id - Id of the workspace this source belongs to.
 * @param connector - Account to read through, naming the credential variables.
 * @param query - The workspace's epic, query override and review statuses.
 * @param env - Environment the named variables are read from.
 * @param options - Transport overrides.
 * @returns The issue source; missing credentials surface on the first request.
 */
export function createJiraIssueSource(
  id: string,
  connector: JiraConnectorConfig,
  query: WorkspaceQuery,
  env: Record<string, string | undefined>,
  options: CreateJiraIssueSourceOptions = {},
): JiraIssueSource {
  const client = new JiraClient({
    site: connector.site,
    email: env[connector.emailEnv] ?? '',
    token: env[connector.tokenEnv] ?? '',
    fetch: options.fetch,
  });
  return new JiraIssueSource(id, connector, query, client);
}

export {
  JiraClient,
  JiraHttpError,
  JiraTruncatedError,
  JIRA_ISSUE_FIELDS,
  JIRA_TIMEOUT_MS,
  normaliseSite,
} from './client.js';
export type {
  FetchLike,
  JiraClientOptions,
  JiraIssueFields,
  JiraIssueResource,
  JiraSearchResponse,
} from './client.js';
export { DEFAULT_JQL_ORDER, buildJql, epicChildrenJql, jqlQuote } from './jql.js';
export { adfToText, issueUrl, mapIssue, statusCategoryFrom } from './map.js';
