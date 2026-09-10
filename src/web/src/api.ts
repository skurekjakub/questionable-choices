import type {
  BoardView,
  CreateSessionRequest,
  ConfigIssue,
  CreateWorkspaceRequest,
  ErrorReason,
  ErrorResponse,
  IssueDetailResponse,
  PrefillResponse,
  PublicConfigResponse,
  RemoveWorktreeResponse,
  SessionAction,
  SessionEventsResponse,
  SetFlagsRequest,
  WorkspaceSummary,
} from '../../core/api.js';
import type { IssueFlags, SessionRecord } from './model.js';

/**
 * A non-2xx response from the local API, carrying the server's own wording.
 */
export class ApiError extends Error {
  /** HTTP status of the refusal. */
  readonly status: number;
  /** Extra context the server supplied, e.g. git's stderr. */
  readonly detail: string | null;
  /** Per-field validation problems, empty unless a schema rejected the body. */
  readonly issues: ConfigIssue[];
  /** Why the request was refused, or null when no closed-set reason described it. */
  readonly reason: ErrorReason | null;

  /**
   * Builds an error from a refusal the server described.
   *
   * @param status - HTTP status of the response.
   * @param message - Message to show the owner verbatim.
   * @param detail - Extra context, or null when the server sent none.
   * @param issues - Per-field validation problems, or an empty list.
   * @param reason - Closed-set reason for the refusal, or null when it carried none.
   */
  constructor(
    status: number,
    message: string,
    detail: string | null,
    issues: ConfigIssue[] = [],
    reason: ErrorReason | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.issues = issues;
    this.reason = reason;
  }
}

/**
 * Reads a response, turning any non-2xx into an {@link ApiError}.
 *
 * @param response - Response to interpret.
 * @returns The parsed JSON body, or undefined for a 204.
 * @throws {ApiError} When the status is not 2xx.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (response.ok) return parsed;
  const body = parsed as ErrorResponse | undefined;
  const message = body?.error ?? text.trim();
  throw new ApiError(
    response.status,
    message.length > 0 ? message : `${response.status} ${response.statusText}`,
    body?.detail ?? null,
    body?.issues ?? [],
    body?.reason ?? null,
  );
}

/**
 * Issues a request against the local API.
 *
 * @param path - Path below the origin, starting with `/api`.
 * @param init - Fetch options; a JSON body is serialised by the caller.
 * @returns The parsed response body.
 * @throws {ApiError} When the server refuses the request.
 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    ...(init?.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' } as const }),
  });
  return readBody(response);
}

/**
 * Sends a POST with a JSON body.
 *
 * @param path - Path below the origin.
 * @param body - Value serialised as the request body, or undefined for none.
 * @returns The parsed response body.
 * @throws {ApiError} When the server refuses the request.
 */
async function post(path: string, body?: unknown): Promise<unknown> {
  return request(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Fetches the workspaces, the repos and connectors they can be built from, and
 * the picker options.
 *
 * @returns The public configuration.
 * @throws {ApiError} When the server refuses the request.
 */
export async function getPublicConfig(): Promise<PublicConfigResponse> {
  return (await request('/api/config/public')) as PublicConfigResponse;
}

/**
 * Adds a workspace, optionally creating its connector in the same request.
 *
 * @param body - The workspace to add.
 * @returns The workspace as the switcher will list it.
 * @throws {ApiError} With status 400 when the config is invalid, 409 on a duplicate id.
 */
export async function createWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceSummary> {
  return (await post('/api/workspaces', body)) as WorkspaceSummary;
}

/**
 * Removes a workspace, leaving its repo's sessions and worktrees in place.
 *
 * @param workspaceId - Id of the workspace to remove.
 * @returns Nothing.
 * @throws {ApiError} When the server refuses the request.
 */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
}

/**
 * Fetches a workspace's board.
 *
 * @param workspaceId - Id of the workspace to read.
 * @returns The board view.
 * @throws {ApiError} When the server refuses the request.
 */
export async function getBoard(workspaceId: string): Promise<BoardView> {
  return (await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/board`)) as BoardView;
}

/**
 * Forces a refresh of a workspace's issue source.
 *
 * @param workspaceId - Id of the workspace to refresh.
 * @returns The recomputed board view.
 * @throws {ApiError} When the server refuses the request.
 */
export async function refreshBoard(workspaceId: string): Promise<BoardView> {
  return (await post(`/api/workspaces/${encodeURIComponent(workspaceId)}/refresh`)) as BoardView;
}

/**
 * Fetches one issue with its description and its sessions.
 *
 * @param workspaceId - Id of the workspace the issue belongs to.
 * @param key - Tracker key of the issue.
 * @returns The issue detail.
 * @throws {ApiError} When the server refuses the request.
 */
export async function getIssue(workspaceId: string, key: string): Promise<IssueDetailResponse> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/issues/${encodeURIComponent(key)}`;
  return (await request(path)) as IssueDetailResponse;
}

/**
 * Fetches the start dialog's prefilled prompt and picker selections.
 *
 * @param workspaceId - Id of the workspace the issue belongs to.
 * @param key - Tracker key of the issue.
 * @param playbookId - Playbook whose template should be rendered.
 * @returns The prefill, including any non-blocking warnings.
 * @throws {ApiError} When the server refuses the request.
 */
export async function getPrefill(
  workspaceId: string,
  key: string,
  playbookId: string,
): Promise<PrefillResponse> {
  const path =
    `/api/workspaces/${encodeURIComponent(workspaceId)}/issues/${encodeURIComponent(key)}` +
    `/prefill?playbook=${encodeURIComponent(playbookId)}`;
  return (await request(path)) as PrefillResponse;
}

/**
 * Starts a session for an issue.
 *
 * @param workspaceId - Id of the workspace the issue belongs to.
 * @param key - Tracker key of the issue.
 * @param body - Playbook, final prompt and runner selections.
 * @returns The created session record.
 * @throws {ApiError} When the server refuses the start.
 */
export async function createSession(
  workspaceId: string,
  key: string,
  body: CreateSessionRequest,
): Promise<SessionRecord> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/issues/${encodeURIComponent(key)}/sessions`;
  return (await post(path, body)) as SessionRecord;
}

/**
 * Sets or clears the owner's per-issue flags.
 *
 * @param workspaceId - Id of the workspace the issue belongs to.
 * @param key - Tracker key of the issue.
 * @param body - Flags to set; omitted flags are left alone.
 * @returns The flags after the change.
 * @throws {ApiError} When the server refuses the request.
 */
export async function setFlags(
  workspaceId: string,
  key: string,
  body: SetFlagsRequest,
): Promise<IssueFlags> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/issues/${encodeURIComponent(key)}/flags`;
  return (await post(path, body)) as IssueFlags;
}

/**
 * Opens the issue's checkout in the configured desktop editor.
 *
 * @param workspaceId - Id of the workspace the issue belongs to.
 * @param key - Tracker key of the issue.
 * @returns Nothing.
 * @throws {ApiError} With status 409 when the issue has no worktree to open.
 */
export async function openEditor(workspaceId: string, key: string): Promise<void> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/issues/${encodeURIComponent(key)}/open-editor`;
  await post(path);
}

/**
 * Runs a session-scoped action that takes no body.
 *
 * @param sessionId - Id of the session to act on.
 * @param action - Action to run.
 * @returns The session record after the action.
 * @throws {ApiError} When the server refuses the action.
 */
export async function sessionAction(
  sessionId: string,
  action: SessionAction,
): Promise<SessionRecord> {
  return (await post(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`)) as SessionRecord;
}

/**
 * Removes the worktree a session runs in.
 *
 * @param sessionId - Id of the session whose worktree should go.
 * @param force - Whether to discard a dirty tree.
 * @returns The path that was removed.
 * @throws {ApiError} With status 409 when git refuses a dirty tree without force.
 */
export async function removeWorktree(
  sessionId: string,
  force: boolean,
): Promise<RemoveWorktreeResponse> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/remove-worktree`;
  return (await post(path, { force })) as RemoveWorktreeResponse;
}

/**
 * Reads a session's raw event log.
 *
 * @param sessionId - Id of the session whose log to read.
 * @returns The accepted events, oldest first.
 * @throws {ApiError} With status 404 when no session has that id.
 */
export async function getSessionEvents(sessionId: string): Promise<SessionEventsResponse> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
  return (await request(path)) as SessionEventsResponse;
}

/**
 * Whether a refused worktree removal is one that forcing would get past.
 *
 * Only git's refusal of a dirty checkout is forceable. A live session still
 * working in the checkout, and a path that is the repo's main checkout, are
 * refused with the same 409 and forcing changes neither, so the reason on the
 * wire is the discriminator rather than the wording of the message.
 *
 * @param error - Value caught from {@link removeWorktree}.
 * @returns True when offering to remove anyway is honest.
 */
export function isForceableRemoval(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  return error.reason === 'dirty-worktree';
}

/**
 * Reduces an unknown thrown value to the sentence that names the refusal,
 * leaving out the per-field problems a form places next to its own fields.
 *
 * @param error - Value caught from a failed call.
 * @returns The server's wording plus its detail, or a generic fallback.
 */
export function errorHeadline(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail === null ? error.message : `${error.message}\n${error.detail}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reduces an unknown thrown value to a message worth showing the owner.
 *
 * @param error - Value caught from a failed call.
 * @returns The server's wording, its detail, and every field problem it named.
 */
export function errorMessage(error: unknown): string {
  const lines = [errorHeadline(error)];
  if (error instanceof ApiError) {
    for (const issue of error.issues) lines.push(`${issue.path}: ${issue.message}`);
  }
  return lines.join('\n');
}
