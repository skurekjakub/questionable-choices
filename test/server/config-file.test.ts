import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config.js';
import { loadConfig } from '../../src/server/config-file.js';

const HOME = '/home/tester';
const EXAMPLE_PATH = new URL('../../config.example.json', import.meta.url);

describe('loadConfig', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qc-config-'));

  it('loads the example configuration from disk', () => {
    const config = loadConfig(EXAMPLE_PATH.pathname, { home: HOME });
    expect(config.runner.defaultModel).toBe('claude-fable-5-1');
  });

  it('rejects a missing file', () => {
    expect(() => loadConfig(join(directory, 'absent.json'), { home: HOME })).toThrow(ConfigError);
  });

  it('rejects a file that is not JSON', () => {
    const path = join(directory, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(() => loadConfig(path, { home: HOME })).toThrow(/not valid JSON/);
  });
});
