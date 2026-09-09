import { readFileSync } from 'node:fs';
import { ConfigError, parseConfig, type ParseConfigOptions } from '../core/config.js';
import type { Config } from '../core/types.js';

/**
 * Reads and validates a configuration file.
 *
 * File access lives here rather than in `core` so the domain stays free of node
 * built-ins and the browser bundle can keep importing the same module.
 *
 * @param path - Absolute path of the JSON configuration file.
 * @param options - Parsing options; `home` controls `~` expansion.
 * @returns The validated configuration.
 * @throws {ConfigError} When the file is unreadable, is not JSON, or fails validation.
 */
export function loadConfig(path: string, options: ParseConfigOptions = {}): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read config at ${path}`, [
      { path: '', message: cause instanceof Error ? cause.message : String(cause) },
    ]);
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ConfigError(`Config at ${path} is not valid JSON`, [
      { path: '', message: cause instanceof Error ? cause.message : String(cause) },
    ]);
  }

  return parseConfig(document, options);
}
