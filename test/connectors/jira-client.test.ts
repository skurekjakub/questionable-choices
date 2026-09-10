import { describe, expect, it } from 'vitest';
import {
  JIRA_ISSUE_FIELDS,
  JiraClient,
  JiraHttpError,
  JiraTruncatedError,
  normaliseSite,
  type FetchLike,
} from '../../src/connectors/issues/jira/client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: unknown;
}

/**
 * Builds a client for one site over a fetch replacement.
 *
 * @param fetch - Transport the client sends through.
 * @param overrides - Page cap and timeout overrides.
 * @returns The client.
 */
function makeClient(
  fetch: FetchLike,
  overrides: { maxPages?: number; timeoutMs?: number } = {},
): JiraClient {
  return new JiraClient({
    site: 'example.atlassian.net',
    email: 'me@example.com',
    token: 'secret',
    fetch,
    ...overrides,
  });
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
      signal: init?.signal,
    });
    // A call past the queue answers with a distinguishable extra page rather
    // than throwing, so an over-fetching walk fails on the call-count
    // assertion instead of on the fake.
    return queue.shift() ?? json({ issues: [{ key: 'EXTRA-1' }], isLast: true });
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

  it('fails rather than pass a truncated page walk off as the whole epic', async () => {
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

    await expect(client.searchJql('parent = DOC-100')).rejects.toBeInstanceOf(JiraTruncatedError);
    expect(calls).toHaveLength(2);
  });

  it('reports a 2xx body that is not JSON as a Jira error', async () => {
    const { fetch } = recordingFetch([
      new Response('<html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ]);

    const failure = makeClient(fetch).searchJql('parent = DOC-100');

    // A raw SyntaxError also mentions the body, so the type is what pins the
    // branch: only the client's own wrapper carries the site and the URL.
    await expect(failure).rejects.toBeInstanceOf(JiraHttpError);
    await expect(failure).rejects.toThrow(/login/);
  });

  it('reports a 404 on the search as a failure rather than an empty epic', async () => {
    const { fetch } = recordingFetch([new Response('gone', { status: 404 })]);

    await expect(makeClient(fetch).searchJql('parent = DOC-100')).rejects.toBeInstanceOf(
      JiraHttpError,
    );
  });

  it('throws a JiraHttpError carrying the status and body', async () => {
    const { fetch } = recordingFetch([new Response('jql is broken', { status: 400 })]);

    await expect(makeClient(fetch).searchJql('nonsense')).rejects.toBeInstanceOf(JiraHttpError);
  });

  it('refuses a non-2xx whose body is real JSON, which parses without complaint', async () => {
    const { fetch } = recordingFetch([json({ errorMessages: ['bad jql'] }, 400)]);

    const failure = makeClient(fetch).searchJql('nonsense');

    await expect(failure).rejects.toBeInstanceOf(JiraHttpError);
    await expect(failure).rejects.toMatchObject({ status: 400 });
  });

  it('carries an abort signal on every request', async () => {
    const { fetch, calls } = recordingFetch([json({ issues: [], isLast: true })]);

    await makeClient(fetch).searchJql('parent = DOC-100');

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a request that outlived its timeout as a Jira error naming the url', async () => {
    const honoursTheSignal: FetchLike = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });

    const failure = makeClient(honoursTheSignal, { timeoutMs: 1 }).searchJql('parent = DOC-100');

    await expect(failure).rejects.toBeInstanceOf(JiraHttpError);
    await expect(failure).rejects.toMatchObject({ status: 0 });
    await expect(failure).rejects.toThrow(/example\.atlassian\.net/);
    await expect(failure).rejects.toThrow(/timed out after 1 ms/);
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
