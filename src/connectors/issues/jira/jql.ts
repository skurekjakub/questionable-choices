import type { JiraIssueSourceConfig } from '../../../core/types.js';

/**
 * Ordering clause appended to the default epic query.
 */
export const DEFAULT_JQL_ORDER = 'ORDER BY Rank ASC';

/**
 * Builds the query listing an epic's unfinished children.
 *
 * @param epic - Key of the parent epic.
 * @returns The JQL query.
 */
export function epicChildrenJql(epic: string): string {
  return `parent = ${epic} AND statusCategory != Done ${DEFAULT_JQL_ORDER}`;
}

/**
 * Picks the query a Jira issue source runs.
 *
 * A configured `jql` replaces the whole query; otherwise the epic's
 * unfinished children are listed in rank order.
 *
 * @param config - The source's configuration, supplying `jql` or `epic`.
 * @returns The JQL query to send.
 * @throws {Error} When the configuration names neither `jql` nor `epic`.
 */
export function buildJql(config: Pick<JiraIssueSourceConfig, 'epic' | 'jql'>): string {
  const raw = config.jql;
  if (raw !== undefined && raw !== '') return raw;
  const epic = config.epic;
  if (epic !== undefined && epic !== '') return epicChildrenJql(epic);
  throw new Error("a jira issue source needs either 'epic' or 'jql'");
}
