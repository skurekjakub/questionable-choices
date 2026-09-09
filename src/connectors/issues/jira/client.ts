/**
 * Issue fields the board needs from Jira.
 */
export const JIRA_ISSUE_FIELDS: readonly string[] = [
  'summary',
  'issuetype',
  'status',
  'labels',
  'assignee',
  'priority',
  'description',
  'updated',
];

/**
 * Issues requested per page of a JQL search.
 */
export const JIRA_PAGE_SIZE = 100;

/**
 * Pages a single JQL search will walk before giving up.
 */
export const JIRA_MAX_PAGES = 50;

/**
 * The `fields` block of a Jira REST issue, narrowed to what the board reads.
 */
export interface JiraIssueFields {
  /** One-line title. */
  summary?: string | null | undefined;
  /** Issue type, e.g. `Bug`. */
  issuetype?: { name?: string | null | undefined } | null | undefined;
  /** Workflow status plus its coarse category. */
  status?:
    | {
        name?: string | null | undefined;
        statusCategory?: { key?: string | null | undefined } | null | undefined;
      }
    | null
    | undefined;
  /** Label names. */
  labels?: string[] | null | undefined;
  /** Current assignee. */
  assignee?: { displayName?: string | null | undefined } | null | undefined;
  /** Priority, when the project uses one. */
  priority?: { name?: string | null | undefined } | null | undefined;
  /** Description as an Atlassian Document Format tree, or a plain string. */
  description?: unknown;
  /** ISO timestamp of the last tracker-side update. */
  updated?: string | null | undefined;
}

/**
 * One issue as the Jira REST API returns it.
 */
export interface JiraIssueResource {
  /** Issue key, e.g. `DOC-3847`. */
  key: string;
  /** Numeric issue id as a string. */
  id?: string | undefined;
  /** The requested fields. */
  fields?: JiraIssueFields | null | undefined;
}

/**
 * One page of a `POST /rest/api/3/search/jql` response.
 */
export interface JiraSearchResponse {
  /** Issues on this page. */
  issues?: JiraIssueResource[] | null | undefined;
  /** Token that fetches the next page; absent on the last page. */
  nextPageToken?: string | null | undefined;
  /** Whether this page is the last one. */
  isLast?: boolean | null | undefined;
}

/**
 * The subset of the global `fetch` signature this client uses.
 */
export type FetchLike = typeof globalThis.fetch;

/**
 * Thrown when Jira answers a request with a non-2xx status.
 */
export class JiraHttpError extends Error {
  /** HTTP status Jira answered with. */
  readonly status: number;
  /** Request URL, without credentials. */
  readonly url: string;
  /** Response body, truncated for logging. */
  readonly body: string;

  /**
   * Builds a Jira HTTP error.
   *
   * @param status - HTTP status Jira answered with.
   * @param url - Request URL the failure belongs to.
   * @param body - Response body, already truncated.
   */
  constructor(status: number, url: string, body: string) {
    super(`Jira answered ${status} for ${url}${body === '' ? '' : `: ${body}`}`);
    this.name = 'JiraHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * How to reach one Jira Cloud site.
 */
export interface JiraClientOptions {
  /** Site host, e.g. `example.atlassian.net`; a scheme is stripped. */
  site: string;
  /** Account email for basic auth; empty when the environment did not supply it. */
  email: string;
  /** API token for basic auth; empty when the environment did not supply it. */
  token: string;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: FetchLike | undefined;
  /** Pages a search walks before giving up; defaults to `JIRA_MAX_PAGES`. */
  maxPages?: number | undefined;
}

const BODY_SNIPPET_LENGTH = 500;

/**
 * Strips a scheme and any trailing slash from a configured site host.
 *
 * @param site - Site as the configuration spells it.
 * @returns The bare host, e.g. `example.atlassian.net`.
 */
export function normaliseSite(site: string): string {
  return site.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Talks to one Jira Cloud site's REST v3 API with basic auth.
 */
export class JiraClient {
  /** Bare site host requests are sent to. */
  readonly site: string;
  /** Whether both basic-auth credentials were supplied. */
  readonly hasCredentials: boolean;

  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxPages: number;

  /**
   * Builds a client for one site.
   *
   * @param options - Site, credentials and optional `fetch` replacement.
   */
  constructor(options: JiraClientOptions) {
    this.site = normaliseSite(options.site);
    this.hasCredentials = options.email !== '' && options.token !== '';
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxPages = options.maxPages ?? JIRA_MAX_PAGES;
  }

  /**
   * Sends one authenticated request and parses its JSON body.
   *
   * @param path - Path below the site root, starting with a slash.
   * @param init - Method, headers and body for the request.
   * @returns The parsed response body, or null for a 404.
   * @throws {JiraHttpError} When Jira answers any other non-2xx status.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const url = `https://${this.site}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: this.authorization,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new JiraHttpError(response.status, url, body.slice(0, BODY_SNIPPET_LENGTH));
    }
    return (await response.json()) as unknown;
  }

  /**
   * Runs a JQL search and walks every page of the result.
   *
   * @param jql - The query to run.
   * @param fields - Issue fields to request; defaults to `JIRA_ISSUE_FIELDS`.
   * @returns Every issue the query matched, in query order.
   * @throws {JiraHttpError} When Jira rejects the query.
   */
  async searchJql(
    jql: string,
    fields: readonly string[] = JIRA_ISSUE_FIELDS,
  ): Promise<JiraIssueResource[]> {
    const collected: JiraIssueResource[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < this.maxPages; page += 1) {
      const body = {
        jql,
        fields: [...fields],
        maxResults: JIRA_PAGE_SIZE,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      };
      const parsed = (await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as JiraSearchResponse | null;
      if (parsed === null) return collected;
      for (const issue of parsed.issues ?? []) collected.push(issue);
      const token = parsed.nextPageToken;
      if (parsed.isLast === true || typeof token !== 'string' || token === '') return collected;
      // A site that keeps handing back the same token would page forever; the
      // loop bound is the only thing that stops it.
      nextPageToken = token;
    }
    return collected;
  }

  /**
   * Fetches one issue by key.
   *
   * @param key - Issue key, e.g. `DOC-3847`.
   * @param fields - Issue fields to request; defaults to `JIRA_ISSUE_FIELDS`.
   * @returns The issue, or null when Jira has no such issue.
   * @throws {JiraHttpError} When Jira rejects the request for any other reason.
   */
  async getIssue(
    key: string,
    fields: readonly string[] = JIRA_ISSUE_FIELDS,
  ): Promise<JiraIssueResource | null> {
    const query = `?fields=${encodeURIComponent(fields.join(','))}`;
    const parsed = (await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}${query}`, {
      method: 'GET',
    })) as JiraIssueResource | null;
    return parsed;
  }
}
