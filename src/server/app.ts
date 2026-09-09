import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type {
  CreateSessionRequest,
  CreateWorkspaceRequest,
  ErrorResponse,
  NewConnectorRequest,
  SetFlagsRequest,
} from '../core/api.js';
import { ConfigError } from '../core/config.js';
import { registerHookRoutes } from './hooks.js';
import { ActionError, consoleLogger, type Logger, type SessionManager } from './session-manager.js';
import { registerWebSocketRoutes, type UpgradeWebSocketFn } from './terminal-ws.js';

/**
 * What the app needs to serve the API, the hooks and the SPA.
 */
export interface AppDeps {
  /** Manager backing every route. */
  manager: SessionManager;
  /** Diagnostics sink; defaults to the console. */
  logger?: Logger | undefined;
  /** Upgrade helper; the WebSocket routes are skipped when it is absent. */
  upgradeWebSocket?: UpgradeWebSocketFn | undefined;
  /** Absolute directory of the built SPA; static serving is skipped when it does not exist. */
  webRoot?: string | undefined;
}

/**
 * Reads a request body as a JSON object.
 *
 * @param body - The already-parsed body, or whatever arrived instead.
 * @returns The object, or an empty one when the body was not one.
 */
function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

/**
 * Reads an optional string field out of a request body.
 *
 * @param body - The parsed body.
 * @param key - Field to read.
 * @returns The value, or undefined when the field is absent or not a string.
 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the inline connector out of a create-workspace body.
 *
 * @param body - The parsed body.
 * @returns The connector, or undefined when the body carries none.
 */
function newConnectorOf(body: Record<string, unknown>): NewConnectorRequest | undefined {
  const raw = body['newConnector'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return {
    id: String(value['id'] ?? ''),
    site: String(value['site'] ?? ''),
    emailEnv: String(value['emailEnv'] ?? ''),
    tokenEnv: String(value['tokenEnv'] ?? ''),
  };
}

/**
 * Reads the workspace a `POST /api/workspaces` body describes.
 *
 * Nothing is validated here; the core schema is the one arbiter, so a body
 * that names nothing at all comes back as its zod issues rather than as 500s.
 *
 * @param body - The parsed body.
 * @returns The request.
 */
function createWorkspaceRequestOf(body: Record<string, unknown>): CreateWorkspaceRequest {
  const reviewStatuses = body['reviewStatuses'];
  const newConnector = newConnectorOf(body);
  const id = optionalString(body, 'id');
  const connector = optionalString(body, 'connector');
  const jql = optionalString(body, 'jql');
  return {
    ...(id === undefined ? {} : { id }),
    name: String(body['name'] ?? ''),
    epic: String(body['epic'] ?? ''),
    repo: String(body['repo'] ?? ''),
    ...(connector === undefined ? {} : { connector }),
    ...(newConnector === undefined ? {} : { newConnector }),
    ...(Array.isArray(reviewStatuses)
      ? { reviewStatuses: reviewStatuses.map((status) => String(status)) }
      : {}),
    ...(jql === undefined ? {} : { jql }),
  };
}

/**
 * Builds the Hono app: REST routes, hook ingress, WebSocket endpoints and the
 * built SPA with a history-mode fallback.
 *
 * @param deps - Manager, logger and the optional upgrade helper and web root.
 * @returns The app, ready to hand to `serve` or to drive with `app.request`.
 */
export function createApp(deps: AppDeps): Hono {
  const { manager } = deps;
  const logger = deps.logger ?? consoleLogger;
  const app = new Hono();

  app.onError((cause, c) => {
    if (cause instanceof ConfigError) {
      // A duplicate id is the one refusal the UI can resolve by renaming, so it
      // gets 409; every other issue is a field the dialog can point at.
      const duplicate = cause.issues.some((issue) => issue.path === 'id');
      const body: ErrorResponse = { error: cause.message, issues: cause.issues };
      return c.json(body, duplicate ? 409 : 400);
    }
    if (cause instanceof ActionError) {
      const body: ErrorResponse = {
        error: cause.message,
        ...(cause.detail === undefined ? {} : { detail: cause.detail }),
      };
      return c.json(body, cause.status as ContentfulStatusCode);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error(`${c.req.method} ${c.req.path} failed: ${message}`);
    return c.json({ error: 'internal error', detail: message } satisfies ErrorResponse, 500);
  });

  app.get('/api/config/public', (c) => c.json(manager.publicConfig()));

  app.post('/api/workspaces', async (c) => {
    const body = asObject(await c.req.json<unknown>().catch(() => ({})));
    const summary = await manager.addWorkspace(createWorkspaceRequestOf(body));
    return c.json(summary, 201);
  });

  app.delete('/api/workspaces/:id', async (c) => {
    await manager.removeWorkspace(c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/api/workspaces/:id/board', (c) => c.json(manager.board(c.req.param('id'))));

  app.post('/api/workspaces/:id/refresh', async (c) =>
    c.json(await manager.refresh(c.req.param('id'))),
  );

  app.get('/api/workspaces/:id/issues/:key', async (c) =>
    c.json(await manager.issueDetail(c.req.param('id'), c.req.param('key'))),
  );

  app.get('/api/workspaces/:id/issues/:key/prefill', async (c) => {
    const playbookId = c.req.query('playbook');
    if (playbookId === undefined || playbookId === '') {
      throw new ActionError(400, "the 'playbook' query parameter is required");
    }
    return c.json(await manager.prefill(c.req.param('id'), c.req.param('key'), playbookId));
  });

  app.post('/api/workspaces/:id/issues/:key/sessions', async (c) => {
    const body = asObject(await c.req.json<unknown>().catch(() => ({})));
    const request: CreateSessionRequest = {
      playbookId: String(body['playbookId'] ?? ''),
      prompt: String(body['prompt'] ?? ''),
      model: String(body['model'] ?? ''),
      effort: String(body['effort'] ?? '') as CreateSessionRequest['effort'],
      permissionMode: String(
        body['permissionMode'] ?? '',
      ) as CreateSessionRequest['permissionMode'],
    };
    const record = await manager.startSession(c.req.param('id'), c.req.param('key'), request);
    return c.json(record, 201);
  });

  app.post('/api/workspaces/:id/issues/:key/flags', async (c) => {
    const body = asObject(await c.req.json<unknown>().catch(() => ({})));
    const patch: SetFlagsRequest = {
      ...(typeof body['review'] === 'boolean' ? { review: body['review'] } : {}),
      ...(typeof body['done'] === 'boolean' ? { done: body['done'] } : {}),
    };
    return c.json(await manager.setFlags(c.req.param('id'), c.req.param('key'), patch));
  });

  app.post('/api/workspaces/:id/issues/:key/open-editor', async (c) => {
    await manager.openEditor(c.req.param('id'), c.req.param('key'));
    return c.body(null, 204);
  });

  app.post('/api/sessions/:id/resume', async (c) =>
    c.json(await manager.resumeSession(c.req.param('id'))),
  );
  app.post('/api/sessions/:id/interrupt', async (c) =>
    c.json(await manager.interruptSession(c.req.param('id'))),
  );
  app.post('/api/sessions/:id/kill', async (c) =>
    c.json(await manager.killSession(c.req.param('id'))),
  );
  app.post('/api/sessions/:id/mark-done', async (c) =>
    c.json(await manager.setSessionDone(c.req.param('id'), true)),
  );
  app.post('/api/sessions/:id/unmark-done', async (c) =>
    c.json(await manager.setSessionDone(c.req.param('id'), false)),
  );
  app.post('/api/sessions/:id/archive', async (c) =>
    c.json(await manager.archiveSession(c.req.param('id'))),
  );

  app.post('/api/sessions/:id/remove-worktree', async (c) => {
    const body = asObject(await c.req.json<unknown>().catch(() => ({})));
    return c.json(await manager.removeWorktree(c.req.param('id'), body['force'] === true));
  });

  app.get('/api/sessions/:id/events', async (c) =>
    c.json(await manager.sessionEvents(c.req.param('id'))),
  );

  registerHookRoutes(app, { manager, logger });

  if (deps.upgradeWebSocket !== undefined) {
    registerWebSocketRoutes(app, {
      manager,
      runner: manager.runner,
      upgradeWebSocket: deps.upgradeWebSocket,
      logger,
    });
  }

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
      return c.json({ error: `no route for ${c.req.path}` } satisfies ErrorResponse, 404);
    }
    return c.text('Not found', 404);
  });

  const webRoot = deps.webRoot;
  if (webRoot !== undefined && existsSync(webRoot)) {
    app.use('/*', serveStatic({ root: webRoot }));
    // The SPA owns /session/:id, so anything that is not a real file falls back
    // to index.html rather than 404ing on a deep link.
    app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }));
  }

  return app;
}
