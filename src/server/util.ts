import type { Context } from 'hono';

/**
 * Largest JSON request body the server reads, in bytes.
 */
export const MAX_JSON_BODY_BYTES = 1_000_000;

/**
 * Turns anything thrown into a message.
 *
 * @param cause - The thrown value.
 * @returns The error message, or the string form of a non-error.
 */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Reads a request body as a JSON object.
 *
 * @param c - Request context.
 * @param limit - Largest body accepted, in bytes.
 * @returns The parsed object, or null when the body is absent, oversized, not
 *   JSON, or JSON that is not an object.
 */
export async function readJsonObject(
  c: Context,
  limit: number = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const declared = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return null;
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return null;
  }
  if (text.length > limit) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
