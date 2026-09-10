import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config.js';
import { loadConfig } from '../../src/server/config-file.js';

const HOME = '/home/tester';
// `fileURLToPath`, not `.pathname`: a checkout under a path with a space comes
// back percent-encoded and every read of it fails.
const EXAMPLE_PATH = fileURLToPath(new URL('../../config.example.json', import.meta.url));

describe('loadConfig', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qc-config-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('loads the example configuration from disk', () => {
    const config = loadConfig(EXAMPLE_PATH, { home: HOME });
    expect(config.runner.defaultModel).toBe('claude-fable-5-1');
  });

  it('rejects a missing file', () => {
    expect(() => loadConfig(join(directory, 'absent.json'), { home: HOME })).toThrow(ConfigError);
  });

  it('rejects a file that is not JSON', async () => {
    const path = join(directory, 'broken.json');
    await writeFile(path, '{ not json', 'utf8');
    expect(() => loadConfig(path, { home: HOME })).toThrow(/not valid JSON/);
  });
});
