import type { Issue, IssueSource, JiraIssueSourceConfig } from '../../../core/types.js';
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
 * Lists the issues of one board from a Jira Cloud epic.
 */
export class JiraIssueSource implements IssueSource {
  /** Id of the board this source belongs to. */
  readonly id: string;

  private readonly config: JiraIssueSourceConfig;
  private readonly client: JiraClient;

  /**
   * Builds a source over an already-configured client.
   *
   * @param id - Id of the board this source belongs to.
   * @param config - The source's configuration.
   * @param client - Client for the site the configuration names.
   */
  constructor(id: string, config: JiraIssueSourceConfig, client: JiraClient) {
    this.id = id;
    this.config = config;
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
    throw new MissingCredentialsError([this.config.emailEnv, this.config.tokenEnv]);
  }

  /**
   * Lists every issue the board should show.
   *
   * @returns The issues in Jira rank order.
   * @throws {MissingCredentialsError} When either credential is missing.
   * @throws {JiraHttpError} When Jira rejects the query.
   */
  async list(): Promise<Issue[]> {
    this.assertCredentials();
    const resources = await this.client.searchJql(buildJql(this.config));
    return resources.map((resource) => mapIssue(resource, this.config.site));
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
    return resource === null ? null : mapIssue(resource, this.config.site);
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
 * @param id - Id of the board this source belongs to.
 * @param config - The source's configuration, naming the credential variables.
 * @param env - Environment the named variables are read from.
 * @param options - Transport overrides.
 * @returns The issue source; missing credentials surface on the first request.
 */
export function createJiraIssueSource(
  id: string,
  config: JiraIssueSourceConfig,
  env: Record<string, string | undefined>,
  options: CreateJiraIssueSourceOptions = {},
): JiraIssueSource {
  const client = new JiraClient({
    site: config.site,
    email: env[config.emailEnv] ?? '',
    token: env[config.tokenEnv] ?? '',
    fetch: options.fetch,
  });
  return new JiraIssueSource(id, config, client);
}

export { JiraClient, JiraHttpError, JIRA_ISSUE_FIELDS, normaliseSite } from './client.js';
export type {
  FetchLike,
  JiraClientOptions,
  JiraIssueFields,
  JiraIssueResource,
  JiraSearchResponse,
} from './client.js';
export { DEFAULT_JQL_ORDER, buildJql, epicChildrenJql } from './jql.js';
export { adfToText, issueUrl, mapIssue, statusCategoryFrom } from './map.js';
