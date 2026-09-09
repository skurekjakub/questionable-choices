import type { Context, Hono } from 'hono';
import type { ErrorResponse } from '../core/api.js';
import type { StatuslinePayload } from '../core/cache-clock.js';
import { asHookEvent } from '../core/state-machine.js';
import type { SessionEvent } from '../core/state-machine.js';
import type { Logger, SessionManager } from './session-manager.js';

/**
 * Launcher signals the generated `run.sh` posts around the `claude` process.
 */
export const LAUNCHER_EVENT_NAMES = [
  'bootstrap-start',
  'bootstrap-failed',
  'claude-start',
  'claude-exit',
] as const;

/**
 * One launcher signal name.
 */
export type LauncherEventName = (typeof LAUNCHER_EVENT_NAMES)[number];

/**
 * What the hook ingress needs.
 */
export interface HookRoutesDeps {
  /** Manager the events are reduced into. */
  manager: SessionManager;
  /** Diagnostics sink for ignored events and unknown sessions. */
  logger: Logger;
}

/**
 * Reads a request body as a JSON object.
 *
 * A body that is missing, malformed or not an object is treated as empty: a
 * hook must never fail because its payload surprised the dashboard.
 *
 * @param c - Request context.
 * @returns The parsed object, or an empty one.
 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json<unknown>();
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/**
 * Reads an exit code out of a launcher body.
 *
 * @param body - The launcher's JSON body.
 * @returns The exit code, or null when the body carries no usable number.
 */
function exitCodeOf(body: Record<string, unknown>): number | null {
  const value = body['exitCode'];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Turns a launcher signal into the event the state machine accepts.
 *
 * `claude-start` may carry `mode: 'resume'`; anything else counts as a fresh
 * start, so a launcher that posts only `{}` still records a run.
 *
 * @param name - Launcher signal name from the URL.
 * @param body - The launcher's JSON body.
 * @returns The event, or null when the name is not a launcher signal.
 */
function launcherEvent(name: string, body: Record<string, unknown>): SessionEvent | null {
  switch (name) {
    case 'bootstrap-start':
      return { type: 'bootstrap-start' };
    case 'bootstrap-failed': {
      const exitCode = exitCodeOf(body);
      const message = body['message'];
      return {
        type: 'bootstrap-failed',
        ...(exitCode === null ? {} : { exitCode }),
        ...(typeof message === 'string' ? { message } : {}),
      };
    }
    case 'claude-start':
      return { type: 'claude-start', mode: body['mode'] === 'resume' ? 'resume' : 'start' };
    case 'claude-exit':
      return { type: 'claude-exit', exitCode: exitCodeOf(body) };
    default:
      return null;
  }
}

/**
 * Registers the three hook-ingress routes on an app.
 *
 * The endpoints are unauthenticated and only ever reachable on loopback; they
 * answer 204 so a hook never blocks the session it belongs to.
 *
 * @param app - App to register the routes on.
 * @param deps - Manager the events are reduced into, plus a logger.
 * @returns Nothing.
 */
export function registerHookRoutes(app: Hono, deps: HookRoutesDeps): void {
  const { manager, logger } = deps;

  const unknownSession = (c: Context, sessionId: string): Response => {
    logger.warn(`hook for unknown session '${sessionId}'`);
    return c.json({ error: `unknown session '${sessionId}'` } satisfies ErrorResponse, 404);
  };

  app.post('/api/hooks/:sessionId/statusline', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!manager.hasSession(sessionId)) return unknownSession(c, sessionId);
    const body = await readJsonBody(c);
    await manager.applyEvent(
      sessionId,
      { type: 'statusline', payload: body as StatuslinePayload },
      { type: 'statusline', payload: body },
    );
    return c.body(null, 204);
  });

  app.post('/api/hooks/:sessionId/launcher/:event', async (c) => {
    const sessionId = c.req.param('sessionId');
    const name = c.req.param('event');
    if (!manager.hasSession(sessionId)) return unknownSession(c, sessionId);
    const body = await readJsonBody(c);
    const event = launcherEvent(name, body);
    if (event === null) {
      logger.warn(`ignored unknown launcher event '${name}' for ${sessionId}`);
      return c.body(null, 204);
    }
    await manager.applyEvent(sessionId, event, { launcher: name, body });
    return c.body(null, 204);
  });

  app.post('/api/hooks/:sessionId/:event', async (c) => {
    const sessionId = c.req.param('sessionId');
    const name = c.req.param('event');
    if (!manager.hasSession(sessionId)) return unknownSession(c, sessionId);
    const body = await readJsonBody(c);
    const hook = asHookEvent(name, body);
    if (hook === null) {
      logger.warn(`ignored unknown hook event '${name}' for ${sessionId}`);
      return c.body(null, 204);
    }
    await manager.applyEvent(sessionId, { type: 'hook', hook }, hook);
    return c.body(null, 204);
  });
}
