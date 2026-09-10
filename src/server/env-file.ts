import { readFileSync } from 'node:fs';

/**
 * Parses the text of a `.env` file into name/value pairs.
 *
 * Accepts one `NAME=value` per line, an optional `export ` prefix, blank lines
 * and `#` comments. A value wrapped in matching single or double quotes has the
 * quotes removed; anything else is taken verbatim, trailing whitespace trimmed.
 *
 * @param text - Contents of the file.
 * @returns The variables in file order; a repeated name keeps its last value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const name = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    variables[name] = value;
  }
  return variables;
}

/**
 * Loads a `.env` file into an environment without overriding what is already
 * set, so a variable exported by the shell always wins over the file.
 *
 * @param path - Absolute path of the file; a missing file is not an error.
 * @param env - Environment to fill in, normally `process.env`.
 * @returns The names the file supplied that the environment did not have.
 * @throws {Error} When the file exists but cannot be read.
 */
export function applyEnvFile(path: string, env: Record<string, string | undefined>): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  const applied: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}
