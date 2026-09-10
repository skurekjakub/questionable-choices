import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';

/**
 * Largest JSON request body the server reads, in bytes.
 */
export const MAX_JSON_BODY_BYTES = 1_000_000;

/**
 * Ends the process after giving stderr a chance to drain.
 *
 * `process.exit` discards buffered output when stderr is a pipe rather than a
 * TTY, which is exactly how a supervisor runs the server, so the message that
 * explains the exit would be the thing lost.
 *
 * @param code - Exit status.
 * @returns Nothing.
 */
export function fatalExit(code: number): void {
  process.exitCode = code;
  // Both streams: a supervisor pipes stderr and `npm run config:check` pipes
  // stdout, and the discard costs whichever of them the caller wrote to.
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

/**
 * Reports whether a module is the one the process was started with.
 *
 * Importing a module — which a test must do to reach anything in it — has to be
 * free of side effects, so a boot or a `process.exit` at the bottom of an entry
 * module is gated on this rather than running on every import. Both paths are
 * resolved through `realpath`, so a checkout reached through a symlink is not
 * mistaken for a different file.
 *
 * @param moduleUrl - The candidate module's own `import.meta.url`.
 * @param entry - Path the process was started with; defaults to `argv[1]`.
 * @returns True when the entry path resolves to that module.
 */
export function isProcessEntry(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

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
  // `String.length` counts UTF-16 units, so a multi-byte body would pass a
  // byte cap at up to three times its size.
  if (Buffer.byteLength(text, 'utf8') > limit) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
