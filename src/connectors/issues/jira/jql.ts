import type { WorkspaceQuery } from '../../../core/types.js';

/**
 * Ordering clause appended to the default epic query.
 */
export const DEFAULT_JQL_ORDER = 'ORDER BY Rank ASC';

/**
 * Quotes a value so JQL reads it as one string literal.
 *
 * @param value - Text to quote.
 * @returns The double-quoted value, with backslashes and quotes escaped.
 */
export function jqlQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Builds the query listing an epic's unfinished children.
 *
 * A bare numeric epic is emitted unquoted, because JQL resolves a quoted
 * literal as an issue key first and a numeric id has none.
 *
 * @param epic - Key or numeric id of the parent epic.
 * @returns The JQL query.
 */
export function epicChildrenJql(epic: string): string {
  const operand = /^\d+$/.test(epic) ? epic : jqlQuote(epic);
  return `parent = ${operand} AND statusCategory != Done ${DEFAULT_JQL_ORDER}`;
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
