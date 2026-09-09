import type { Context, Hono } from 'hono';
import type { ErrorResponse, LauncherStartBody } from '../core/api.js';
import type { StatuslinePayload } from '../core/cache-clock.js';
import { asHookEvent } from '../core/state-machine.js';
import type { SessionEvent } from '../core/state-machine.js';
import type { Logger, SessionManager } from './session-manager.js';
import { readJsonObject } from './util.js';

export { LAUNCHER_EVENT_NAMES } from '../core/api.js';
export type { LauncherEventName } from '../core/api.js';

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
 * Reads an exit code out of a launcher body.
 *
 * The declared shape is `LauncherExitBody`, but the value arrives from a shell
 * through JSON, so a numeric string is accepted as well as a number.
 *
 * @param body - The launcher's JSON body.
 * @returns The exit code, or null when the body carries no usable number.
 */
function exitCodeOf(body: Record<string, unknown>): number | null {
  const value: unknown = body['exitCode'];
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
      return {
        type: 'claude-start',
        mode: (body as LauncherStartBody)['mode'] === 'resume' ? 'resume' : 'start',
      };
    case 'claude-exit':
      return { type: 'claude-exit', exitCode: exitCodeOf(body) };
    default:
      return null;
  }
}

/**
 * Registers the three hook-ingress routes on an app.
 *
 * The endpoints are unauthenticated and only ever reachable on loopback. An
 * accepted payload answers 204, an unknown session id 404 and a body that is
 * not a JSON object 400; a hook ignores the status either way, so a refusal
 * never blocks the session it belongs to.
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

  const badBody = (c: Context, sessionId: string, what: string): Response => {
    logger.warn(`${what} for ${sessionId} carried no readable JSON object`);
    return c.json({ error: `${what} needs a JSON object body` } satisfies ErrorResponse, 400);
  };

  app.post('/api/hooks/:sessionId/statusline', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!manager.hasSession(sessionId)) return unknownSession(c, sessionId);
    const body = await readJsonObject(c);
    if (body === null) return badBody(c, sessionId, 'the statusline payload');
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
    const body = await readJsonObject(c);
    if (body === null) return badBody(c, sessionId, `launcher event '${name}'`);
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
    const body = await readJsonObject(c);
    if (body === null) return badBody(c, sessionId, `hook '${name}'`);
    const hook = asHookEvent(name, body);
    if (hook === null) {
      logger.warn(`ignored unknown hook event '${name}' for ${sessionId}`);
      return c.body(null, 204);
    }
    await manager.applyEvent(sessionId, { type: 'hook', hook }, hook);
    return c.body(null, 204);
  });
}
