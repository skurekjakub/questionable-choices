import { describe, expect, it } from 'vitest';
import {
  JIRA_ISSUE_FIELDS,
  JiraClient,
  JiraHttpError,
  normaliseSite,
  type FetchLike,
} from '../../src/connectors/issues/jira/client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Builds a fetch replacement that answers from a queue and records every call.
 *
 * @param responses - One response per expected call, in order.
 * @returns The fetch replacement and the list it records into.
 */
function recordingFetch(responses: Response[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra fetch call');
    return next;
  };
  return { fetch, calls };
}

/**
 * Builds a JSON response.
 *
 * @param body - Value to serialise as the body.
 * @param status - HTTP status; defaults to 200.
 * @returns The response.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('normaliseSite', () => {
  it('strips a scheme and trailing slashes', () => {
    expect(normaliseSite('https://example.atlassian.net/')).toBe('example.atlassian.net');
    expect(normaliseSite('example.atlassian.net')).toBe('example.atlassian.net');
  });
});

describe('JiraClient.searchJql', () => {
  it('posts the query with basic auth and the requested fields', async () => {
    const { fetch, calls } = recordingFetch([json({ issues: [{ key: 'DOC-1' }], isLast: true })]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    const issues = await client.searchJql('parent = DOC-100');

    expect(issues).toEqual([{ key: 'DOC-1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.atlassian.net/rest/api/3/search/jql');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`,
    );
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({
      jql: 'parent = DOC-100',
      fields: [...JIRA_ISSUE_FIELDS],
      maxResults: 100,
    });
  });

  it('follows nextPageToken until the last page and concatenates the issues', async () => {
    const { fetch, calls } = recordingFetch([
      json({ issues: [{ key: 'DOC-1' }], nextPageToken: 'p2' }),
      json({ issues: [{ key: 'DOC-2' }], nextPageToken: 'p3' }),
      json({ issues: [{ key: 'DOC-3' }] }),
    ]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    const issues = await client.searchJql('parent = DOC-100');

    expect(issues.map((issue) => issue.key)).toEqual(['DOC-1', 'DOC-2', 'DOC-3']);
    expect(calls).toHaveLength(3);
    expect((calls[0]!.body as { nextPageToken?: string }).nextPageToken).toBeUndefined();
    expect((calls[1]!.body as { nextPageToken?: string }).nextPageToken).toBe('p2');
    expect((calls[2]!.body as { nextPageToken?: string }).nextPageToken).toBe('p3');
  });

  it('stops on isLast even when a token is still present', async () => {
    const { fetch, calls } = recordingFetch([
      json({ issues: [{ key: 'DOC-1' }], nextPageToken: 'p2', isLast: true }),
    ]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    await client.searchJql('parent = DOC-100');

    expect(calls).toHaveLength(1);
  });

  it('gives up after maxPages when the site keeps handing back a token', async () => {
    const { fetch, calls } = recordingFetch([
      json({ issues: [{ key: 'DOC-1' }], nextPageToken: 'same' }),
      json({ issues: [{ key: 'DOC-2' }], nextPageToken: 'same' }),
    ]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
      maxPages: 2,
    });

    const issues = await client.searchJql('parent = DOC-100');

    expect(issues).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('throws a JiraHttpError carrying the status and body', async () => {
    const { fetch } = recordingFetch([new Response('jql is broken', { status: 400 })]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    await expect(client.searchJql('nonsense')).rejects.toBeInstanceOf(JiraHttpError);
  });
});

describe('JiraClient.getIssue', () => {
  it('requests the fields as a query parameter', async () => {
    const { fetch, calls } = recordingFetch([json({ key: 'DOC-1' })]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    const issue = await client.getIssue('DOC-1', ['summary', 'status']);

    expect(issue).toEqual({ key: 'DOC-1' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/DOC-1?fields=summary%2Cstatus',
    );
  });

  it('answers null for an issue Jira does not have', async () => {
    const { fetch } = recordingFetch([new Response('', { status: 404 })]);
    const client = new JiraClient({
      site: 'example.atlassian.net',
      email: 'me@example.com',
      token: 'secret',
      fetch,
    });

    await expect(client.getIssue('DOC-404')).resolves.toBeNull();
  });
});

describe('JiraClient.hasCredentials', () => {
  it('is false when either credential is empty', () => {
    const options = { site: 'example.atlassian.net', fetch: recordingFetch([]).fetch };
    expect(new JiraClient({ ...options, email: '', token: 't' }).hasCredentials).toBe(false);
    expect(new JiraClient({ ...options, email: 'e', token: '' }).hasCredentials).toBe(false);
    expect(new JiraClient({ ...options, email: 'e', token: 't' }).hasCredentials).toBe(true);
  });
});
