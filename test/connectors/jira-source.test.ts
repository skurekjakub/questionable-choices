import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIssueSource } from '../../src/connectors/issues/index.js';
import type { FetchLike } from '../../src/connectors/issues/jira/client.js';
import {
  MissingCredentialsError,
  createJiraIssueSource,
} from '../../src/connectors/issues/jira/index.js';
import { buildJql, epicChildrenJql } from '../../src/connectors/issues/jira/jql.js';
import type { JiraConnectorConfig, WorkspaceQuery } from '../../src/core/types.js';

const page = readFileSync(new URL('./fixtures/jira-search-page.json', import.meta.url), 'utf8');

const CONNECTOR: JiraConnectorConfig = {
  type: 'jira',
  site: 'example.atlassian.net',
  emailEnv: 'JIRA_EMAIL',
  tokenEnv: 'JIRA_TOKEN',
};

const QUERY: WorkspaceQuery = {
  epic: 'DOC-3807',
  reviewStatuses: ['Ready for review'],
};

const ENV = { JIRA_EMAIL: 'me@example.com', JIRA_TOKEN: 'secret' };

/**
 * Builds a fetch replacement answering every call with the same body.
 *
 * @param body - JSON text to answer with.
 * @param status - HTTP status; defaults to 200.
 * @returns The fetch replacement and the URLs it saw.
 */
function constantFetch(body: string, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(String(input));
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, urls };
}

describe('buildJql', () => {
  it("lists the epic's unfinished children in rank order", () => {
    expect(buildJql({ epic: 'DOC-3807', jql: undefined })).toBe(
      'parent = "DOC-3807" AND statusCategory != Done ORDER BY Rank ASC',
    );
    expect(epicChildrenJql('DOC-1')).toContain('ORDER BY Rank ASC');
  });

  it('quotes an epic that would otherwise rewrite the query', () => {
    expect(buildJql({ epic: 'X" ORDER BY created DESC', jql: undefined })).toBe(
      'parent = "X\\" ORDER BY created DESC" AND statusCategory != Done ORDER BY Rank ASC',
    );
    expect(buildJql({ epic: 'DOC 1', jql: undefined })).toContain('parent = "DOC 1" AND');
  });

  it('leaves a bare numeric epic id unquoted, which JQL resolves as an id', () => {
    // A quoted operand is matched as an issue key first, and a numeric id has
    // none, so quoting one changes which issues the board lists.
    expect(buildJql({ epic: '12345', jql: undefined })).toBe(
      'parent = 12345 AND statusCategory != Done ORDER BY Rank ASC',
    );
  });

  it('lets a raw jql replace the whole query', () => {
    expect(buildJql({ epic: 'DOC-3807', jql: 'labels = docs ORDER BY created' })).toBe(
      'labels = docs ORDER BY created',
    );
  });

  it('refuses a workspace that names neither', () => {
    expect(() => buildJql({ epic: '', jql: undefined })).toThrow(/epic.*jql|jql.*epic/);
  });
});

describe('JiraIssueSource.list', () => {
  it('maps every issue of every page onto the board issue shape', async () => {
    const { fetch } = constantFetch(
      JSON.stringify({ ...(JSON.parse(page) as object), nextPageToken: undefined, isLast: true }),
    );
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, ENV, { fetch });

    const issues = await source.list();

    expect(source.id).toBe('docs');
    expect(issues.map((issue) => issue.key)).toEqual(['DOC-3847', 'DOC-3848']);
    expect(issues[0]!.url).toBe('https://example.atlassian.net/browse/DOC-3847');
  });

  it('drops a resource with no usable key rather than rendering a dead card', async () => {
    const { fetch } = constantFetch(
      JSON.stringify({
        issues: [{ fields: { summary: 'keyless' } }, { key: 'DOC-9', fields: { summary: 'real' } }],
        isLast: true,
      }),
    );
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, ENV, { fetch });

    const issues = await source.list();

    expect(issues.map((issue) => issue.key)).toEqual(['DOC-9']);
  });

  it('refuses to call Jira when the environment named no credentials', async () => {
    const { fetch, urls } = constantFetch('{}');
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, {}, { fetch });

    await expect(source.list()).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(source.get('DOC-1')).rejects.toThrow(/JIRA_EMAIL and JIRA_TOKEN/);
    expect(urls).toEqual([]);
  });
});

describe('JiraIssueSource.get', () => {
  it('fetches one issue by key', async () => {
    const resource = (JSON.parse(page) as { issues: unknown[] }).issues[1];
    const { fetch, urls } = constantFetch(JSON.stringify(resource));
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, ENV, { fetch });

    const issue = await source.get('DOC-3848');

    expect(issue?.key).toBe('DOC-3848');
    expect(issue?.status).toBe('Ready for review');
    expect(urls[0]).toContain('/rest/api/3/issue/DOC-3848');
  });

  it('answers null when Jira has no such issue', async () => {
    const { fetch } = constantFetch('', 404);
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, ENV, { fetch });

    await expect(source.get('DOC-404')).resolves.toBeNull();
  });

  it('answers null for a resource with no usable key, which would be a dead card', async () => {
    // `get` is how a session-only issue reaches the board, so a keyless
    // resource here becomes a card whose link 404s and whose sessions cannot
    // be matched to it.
    const { fetch } = constantFetch(JSON.stringify({ fields: { summary: 'keyless' } }));
    const source = createJiraIssueSource('docs', CONNECTOR, QUERY, ENV, { fetch });

    await expect(source.get('DOC-9')).resolves.toBeNull();
  });
});

describe('createIssueSource', () => {
  it('builds the jira connector for a jira configuration', () => {
    const source = createIssueSource('docs', CONNECTOR, QUERY, ENV);
    expect(source.id).toBe('docs');
  });

  it('refuses an unknown connector type', () => {
    const unknown = { ...CONNECTOR, type: 'github' } as unknown as JiraConnectorConfig;
    expect(() => createIssueSource('docs', unknown, QUERY, ENV)).toThrow(/unknown connector type/);
  });
});
