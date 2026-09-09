import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkConfig } from '../../src/server/config-check.js';

let dir = '';
let repoPath = '';
let configPath = '';
let lines: string[] = [];

const ENV = { JIRA_EMAIL: 'me@example.com', JIRA_TOKEN: 'secret' };

/**
 * Writes a configuration document to the temporary config path.
 *
 * @param document - The document to serialise, or raw text to write verbatim.
 * @returns Nothing.
 */
async function writeConfig(document: unknown): Promise<void> {
  await writeFile(
    configPath,
    typeof document === 'string' ? document : JSON.stringify(document),
    'utf8',
  );
}

/**
 * Builds a configuration document pointing at the temporary repo.
 *
 * @param path - Repo path to configure; defaults to the temporary checkout.
 * @returns The document.
 */
function document(path: string = repoPath): Record<string, unknown> {
  return {
    runner: { type: 'claude-tmux', models: [{ id: 'm1', label: 'M1' }], defaultModel: 'm1' },
    connectors: {
      tracker: {
        type: 'jira',
        site: 'example.atlassian.net',
        emailEnv: 'JIRA_EMAIL',
        tokenEnv: 'JIRA_TOKEN',
      },
    },
    repos: {
      app: {
        path,
        worktreeDir: join(dir, 'worktrees'),
        playbooks: [
          {
            id: 'implement',
            label: 'Implement',
            isolation: 'worktree',
            promptTemplate: 'Work on {{key}}',
          },
        ],
      },
    },
    workspaces: {
      ws: { name: 'Workspace', epic: 'DOC-1', connector: 'tracker', repo: 'app' },
    },
  };
}

/**
 * Runs the check against the temporary config file.
 *
 * @param env - Environment the credential variables are read from.
 * @returns The exit code.
 */
function run(env: Record<string, string | undefined> = ENV): number {
  return checkConfig({
    env: { ...env, QC_CONFIG: configPath },
    home: dir,
    log: (line) => lines.push(line),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qc-config-check-'));
  repoPath = join(dir, 'repo');
  configPath = join(dir, 'config.json');
  await mkdir(join(repoPath, '.git'), { recursive: true });
  lines = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkConfig', () => {
  it('reports the path, every workspace and every repo of a usable config', async () => {
    await writeConfig(document());

    expect(run()).toBe(0);
    expect(lines[0]).toBe(`config: ${configPath}`);
    expect(lines).toContain('workspace ws · DOC-1 · tracker · app');
    expect(lines).toContain(`repo app · ${repoPath} · ok`);
  });

  it('names every credential variable that does not resolve', async () => {
    await writeConfig(document());

    expect(run({})).toBe(0);
    expect(lines).toContain("connector 'tracker': environment variable JIRA_EMAIL is not set");
    expect(lines).toContain("connector 'tracker': environment variable JIRA_TOKEN is not set");
  });

  it('fails when a repo path is missing', async () => {
    await writeConfig(document(join(dir, 'absent')));

    expect(run()).toBe(1);
    expect(lines.some((line) => line.endsWith('· missing'))).toBe(true);
  });

  it('fails when a repo path is not a git checkout', async () => {
    const plain = join(dir, 'plain');
    await mkdir(plain, { recursive: true });
    await writeConfig(document(plain));

    expect(run()).toBe(1);
    expect(lines.some((line) => line.endsWith('· not-a-git-checkout'))).toBe(true);
  });

  it('fails with the zod issues when the config does not validate', async () => {
    await writeConfig({ ...document(), workspaces: { ws: { name: 'Workspace', epic: 'DOC-1' } } });

    expect(run()).toBe(1);
    expect(lines.join('\n')).toContain('workspaces.ws.connector');
  });

  it('fails when the file is missing entirely', () => {
    expect(run()).toBe(1);
    expect(lines.join('\n')).toContain('Cannot read config');
  });
});
