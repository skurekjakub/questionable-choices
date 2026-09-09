import type { WorkspaceQuery } from '../../../core/types.js';

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
 * Picks the query a workspace's Jira source runs.
 *
 * A configured `jql` replaces the whole query; otherwise the epic's
 * unfinished children are listed in rank order.
 *
 * @param query - The workspace's query, supplying `jql` or `epic`.
 * @returns The JQL query to send.
 * @throws {Error} When the workspace names neither `jql` nor `epic`.
 */
export function buildJql(query: Pick<WorkspaceQuery, 'epic' | 'jql'>): string {
  const raw = query.jql;
  if (raw !== undefined && raw !== '') return raw;
  if (query.epic !== '') return epicChildrenJql(query.epic);
  throw new Error("a jira workspace needs either 'epic' or 'jql'");
}
