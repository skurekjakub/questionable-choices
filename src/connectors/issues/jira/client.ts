import type { PermanentSourceError } from '../../../core/types.js';

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
 * Milliseconds a single Jira request may take before it is aborted.
 */
export const JIRA_TIMEOUT_MS = 15_000;

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
  /** HTTP status Jira answered with, or 0 when no response arrived. */
  readonly status: number;
  /** Request URL, without credentials. */
  readonly url: string;
  /** Response body, truncated for logging. */
  readonly body: string;

  /**
   * Builds a Jira HTTP error.
   *
   * @param status - HTTP status Jira answered with, or 0 when the request never
   *   produced a response.
   * @param url - Request URL the failure belongs to.
   * @param body - Response body, already truncated, or the reason no response
   *   arrived when `status` is 0.
   */
  constructor(status: number, url: string, body: string) {
    const what = status === 0 ? `did not answer ${url}` : `answered ${status} for ${url}`;
    super(`Jira ${what}${body === '' ? '' : `: ${body}`}`);
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
  /** Milliseconds one request may take; defaults to `JIRA_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/**
 * Thrown when a JQL search still has pages left after the page cap.
 *
 * A truncated list read as complete makes the projection treat the issues it
 * never saw as gone, so the search fails instead.
 */
export class JiraTruncatedError extends Error implements PermanentSourceError {
  /** Marks the failure as one repeating the query cannot fix. */
  readonly permanent = true;
  /** The query that matched more issues than the cap allows. */
  readonly jql: string;
  /** Issues collected before the cap was reached. */
  readonly collected: number;

  /**
   * Builds a truncated-search error.
   *
   * @param jql - The query that matched too many issues.
   * @param pages - Pages that were walked before giving up.
   * @param collected - Issues collected before the cap was reached.
   */
  constructor(jql: string, pages: number, collected: number) {
    super(
      `the search still had pages left after ${pages} of them (${collected} issues); narrow the query: ${jql}`,
    );
    this.name = 'JiraTruncatedError';
    this.jql = jql;
    this.collected = collected;
  }
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
  private readonly timeoutMs: number;

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
    this.timeoutMs = options.timeoutMs ?? JIRA_TIMEOUT_MS;
  }

  /**
   * Sends one authenticated request and parses its JSON body.
   *
   * @param path - Path below the site root, starting with a slash.
   * @param init - Method, headers and body for the request.
   * @param missingAsNull - Whether a 404 means "no such resource" rather than a
   *   failure; only true where the path names one resource.
   * @returns The parsed response body, or null for a 404 the caller allowed.
   * @throws {JiraHttpError} When Jira answers a non-2xx status, or answers 2xx
   *   with a body that is not JSON.
   */
  private async request(path: string, init: RequestInit, missingAsNull = false): Promise<unknown> {
    const url = `https://${this.site}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: this.authorization,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
    } catch (cause) {
      // A timeout rejects with a bare DOMException, which reaches the owner's
      // banner as "The operation was aborted" with no site and no URL.
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      ) {
        throw new JiraHttpError(0, url, `timed out after ${this.timeoutMs} ms`);
      }
      throw cause;
    }
    if (missingAsNull && response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new JiraHttpError(response.status, url, body.slice(0, BODY_SNIPPET_LENGTH));
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An SSO or login interstitial answers 200 with HTML; reported raw it
      // reaches the owner's banner as a JSON parser's complaint.
      throw new JiraHttpError(response.status, url, text.slice(0, BODY_SNIPPET_LENGTH));
    }
  }

  /**
   * Runs a JQL search and walks every page of the result.
   *
   * @param jql - The query to run.
   * @param fields - Issue fields to request; defaults to `JIRA_ISSUE_FIELDS`.
   * @returns Every issue the query matched, in query order.
   * @throws {JiraHttpError} When Jira rejects the query.
   * @throws {JiraTruncatedError} When the query still has pages left after the
   *   page cap, which would present a partial epic as the whole one.
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
      })) as JiraSearchResponse;
      for (const issue of parsed.issues ?? []) collected.push(issue);
      const token = parsed.nextPageToken;
      if (parsed.isLast === true || typeof token !== 'string' || token === '') return collected;
      // A site that keeps handing back the same token would page forever; the
      // loop bound is the only thing that stops it.
      nextPageToken = token;
    }
    throw new JiraTruncatedError(jql, this.maxPages, collected.length);
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
    const parsed = (await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}${query}`,
      { method: 'GET' },
      true,
    )) as JiraIssueResource | null;
    return parsed;
  }
}
