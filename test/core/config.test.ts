import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  checkEnvironment,
  expandHome,
  formatConfigIssues,
  loadConfig,
  parseConfig,
  resolveConfigPath,
  startDefaults,
} from '../../src/core/config.js';

const HOME = '/home/tester';
const EXAMPLE_PATH = new URL('../../config.example.json', import.meta.url);

/**
 * Reads `config.example.json` as an unvalidated document.
 *
 * @returns The parsed JSON.
 */
function exampleDocument(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
}

/**
 * Builds the smallest configuration that validates.
 *
 * @param overrides - Top-level keys to replace.
 * @returns The document.
 */
function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runner: {
      type: 'claude-tmux',
      models: [{ id: 'm1', label: 'M1' }],
      defaultModel: 'm1',
    },
    workspaces: {
      ws: {
        name: 'Workspace',
        issues: {
          type: 'jira',
          site: 'example.atlassian.net',
          emailEnv: 'JIRA_EMAIL',
          tokenEnv: 'JIRA_TOKEN',
          epic: 'DOC-1',
        },
        repo: '~/repos/app',
        worktreeDir: '~/repos/worktrees',
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
    ...overrides,
  };
}

/**
 * Parses a document and returns the issue locators it was rejected with.
 *
 * @param document - The document to parse.
 * @returns One `path: message` string per issue.
 * @throws {Error} When the document validates instead of failing.
 */
function issuesOf(document: unknown): string[] {
  try {
    parseConfig(document, { home: HOME });
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
  throw new Error('expected the document to be rejected');
}

describe('the shipped example', () => {
  it('validates', () => {
    const config = parseConfig(exampleDocument(), { home: HOME });
    expect(config.port).toBe(4400);
    expect(config.editor).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'code', '--remote', 'wsl+Ubuntu', '{{path}}'],
    });
    expect(Object.keys(config.workspaces)).toEqual(['docs-workspace']);
    const workspace = config.workspaces['docs-workspace'];
    expect(workspace?.name).toBe('Docs · Next.js');
    expect(workspace?.issues.epic).toBe('DOC-3807');
    expect(workspace?.playbooks.map((playbook) => playbook.id)).toEqual(['implement', 'test']);
  });

  it('validates without the optional editor block', () => {
    const document = exampleDocument();
    delete document['editor'];
    expect(parseConfig(document, { home: HOME }).editor).toEqual({
      command: 'code',
      args: ['{{path}}'],
    });
  });

  it('loads from disk', () => {
    const config = loadConfig(EXAMPLE_PATH.pathname, { home: HOME });
    expect(config.runner.defaultModel).toBe('claude-fable-5-1');
  });
});

describe('defaults', () => {
  it('fills in every optional field', () => {
    const config = parseConfig(minimal(), { home: HOME });
    expect(config.port).toBe(4400);
    expect(config.dataDir).toBe(`${HOME}/.local/share/questionable-choices`);
    expect(config.editor).toEqual({ command: 'code', args: ['{{path}}'] });
    expect(config.runner.claudeBin).toBe('claude');
    expect(config.runner.tmuxPrefix).toBe('qc');
    expect(config.runner.defaultEffort).toBe('medium');
    expect(config.runner.defaultPermissionMode).toBe('default');
    const workspace = config.workspaces['ws'];
    expect(workspace?.baseRef).toBe('origin/main');
    expect(workspace?.branchPattern).toBe('{{key}}-{{slug}}');
    expect(workspace?.bootstrap).toBeUndefined();
    expect(workspace?.issues.pollSeconds).toBe(120);
    expect(workspace?.issues.reviewStatuses).toEqual([]);
    expect(workspace?.playbooks[0]?.primaryFor).toEqual([]);
    expect(workspace?.playbooks[0]?.description).toBe('');
  });

  it('accepts a jql override instead of an epic', () => {
    const document = minimal();
    const workspaces = document['workspaces'] as Record<string, Record<string, unknown>>;
    (workspaces['ws'] as Record<string, unknown>)['issues'] = {
      type: 'jira',
      site: 'example.atlassian.net',
      emailEnv: 'E',
      tokenEnv: 'T',
      jql: 'project = DOC',
    };
    expect(parseConfig(document, { home: HOME }).workspaces['ws']?.issues.jql).toBe(
      'project = DOC',
    );
  });
});

describe('home expansion', () => {
  it.each([
    ['~', HOME],
    ['~/repos', `${HOME}/repos`],
    ['/absolute', '/absolute'],
    ['~notme/repos', '~notme/repos'],
    ['relative/~', 'relative/~'],
  ])('expands %o to %o', (input, expected) => {
    expect(expandHome(input, HOME)).toBe(expected);
  });

  it('leaves paths alone when no home is known', () => {
    expect(expandHome('~/repos', '')).toBe('~/repos');
  });

  it('expands every path field of a config', () => {
    const config = parseConfig(minimal({ dataDir: '~/data' }), { home: HOME });
    expect(config.dataDir).toBe(`${HOME}/data`);
    expect(config.workspaces['ws']?.repo).toBe(`${HOME}/repos/app`);
    expect(config.workspaces['ws']?.worktreeDir).toBe(`${HOME}/repos/worktrees`);
  });
});

describe('rejections', () => {
  /**
   * Applies a mutation to the minimal document.
   *
   * @param mutate - Callback that breaks the document.
   * @returns The broken document.
   */
  const broken = (mutate: (document: Record<string, unknown>) => void): Record<string, unknown> => {
    const document = minimal();
    mutate(document);
    return document;
  };

  /**
   * Reads the single workspace out of a document under construction.
   *
   * @param document - The document.
   * @returns The workspace object.
   */
  const workspaceOf = (document: Record<string, unknown>): Record<string, unknown> =>
    (document['workspaces'] as Record<string, Record<string, unknown>>)['ws'] as Record<
      string,
      unknown
    >;

  const cases: Array<{ name: string; document: unknown; locator: string }> = [
    {
      name: 'an unknown effort',
      document: broken((document) => {
        (document['runner'] as Record<string, unknown>)['defaultEffort'] = 'turbo';
      }),
      locator: 'runner.defaultEffort',
    },
    {
      name: 'an unknown permission mode',
      document: broken((document) => {
        (document['runner'] as Record<string, unknown>)['defaultPermissionMode'] = 'yolo';
      }),
      locator: 'runner.defaultPermissionMode',
    },
    {
      name: 'a default model that is not offered',
      document: broken((document) => {
        (document['runner'] as Record<string, unknown>)['defaultModel'] = 'ghost';
      }),
      locator: 'runner.defaultModel',
    },
    {
      name: 'an unknown runner type',
      document: broken((document) => {
        (document['runner'] as Record<string, unknown>)['type'] = 'ssh';
      }),
      locator: 'runner.type',
    },
    {
      name: 'a playbook default naming an unoffered model',
      document: broken((document) => {
        const playbooks = workspaceOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['defaults'] = { model: 'ghost' };
      }),
      locator: 'workspaces.ws.playbooks[0].defaults.model',
    },
    {
      name: 'duplicate playbook ids',
      document: broken((document) => {
        const playbooks = workspaceOf(document)['playbooks'] as Record<string, unknown>[];
        playbooks.push({ ...(playbooks[0] as Record<string, unknown>) });
      }),
      locator: 'workspaces.ws.playbooks[1].id',
    },
    {
      name: 'a playbook claiming a lane that does not exist',
      document: broken((document) => {
        const playbooks = workspaceOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['primaryFor'] = ['icebox'];
      }),
      locator: 'workspaces.ws.playbooks[0].primaryFor[0]',
    },
    {
      name: 'an unknown isolation',
      document: broken((document) => {
        const playbooks = workspaceOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['isolation'] = 'container';
      }),
      locator: 'workspaces.ws.playbooks[0].isolation',
    },
    {
      name: 'a workspace with no playbooks',
      document: broken((document) => {
        workspaceOf(document)['playbooks'] = [];
      }),
      locator: 'workspaces.ws.playbooks',
    },
    {
      name: 'a workspace with no name',
      document: broken((document) => {
        delete workspaceOf(document)['name'];
      }),
      locator: 'workspaces.ws.name',
    },
    {
      name: 'an issue source naming neither epic nor jql',
      document: broken((document) => {
        const issues = workspaceOf(document)['issues'] as Record<string, unknown>;
        delete issues['epic'];
      }),
      locator: 'workspaces.ws.issues.epic',
    },
    {
      name: 'an issue source with no credentials named',
      document: broken((document) => {
        const issues = workspaceOf(document)['issues'] as Record<string, unknown>;
        issues['emailEnv'] = '';
      }),
      locator: 'workspaces.ws.issues.emailEnv',
    },
    {
      name: 'an unknown issue source type',
      document: broken((document) => {
        const issues = workspaceOf(document)['issues'] as Record<string, unknown>;
        issues['type'] = 'github';
      }),
      locator: 'workspaces.ws.issues.type',
    },
    {
      name: 'a poll interval below the floor',
      document: broken((document) => {
        const issues = workspaceOf(document)['issues'] as Record<string, unknown>;
        issues['pollSeconds'] = 1;
      }),
      locator: 'workspaces.ws.issues.pollSeconds',
    },
    {
      name: 'a port outside the valid range',
      document: broken((document) => {
        document['port'] = 70000;
      }),
      locator: 'port',
    },
    { name: 'no workspaces at all', document: minimal({ workspaces: {} }), locator: 'workspaces' },
    { name: 'no runner block', document: { workspaces: {} }, locator: 'runner' },
  ];

  it.each(cases)('rejects $name at $locator', ({ document, locator }) => {
    expect(issuesOf(document).map((issue) => issue.split(':')[0])).toContain(locator);
  });

  it('reports every problem at once', () => {
    const document = broken((doc) => {
      (doc['runner'] as Record<string, unknown>)['defaultEffort'] = 'turbo';
      (doc['runner'] as Record<string, unknown>)['defaultPermissionMode'] = 'yolo';
    });
    expect(issuesOf(document).length).toBe(2);
  });

  it('formats issues one indented line each', () => {
    expect(
      formatConfigIssues([
        { path: 'runner.type', message: 'wrong' },
        { path: '', message: 'root' },
      ]),
    ).toBe('  runner.type: wrong\n  <root>: root');
  });
});

describe('loadConfig failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qc-config-'));

  it('rejects a missing file', () => {
    expect(() => loadConfig(join(directory, 'absent.json'), { home: HOME })).toThrow(ConfigError);
  });

  it('rejects a file that is not JSON', () => {
    const path = join(directory, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(() => loadConfig(path, { home: HOME })).toThrow(/not valid JSON/);
  });
});

describe('resolveConfigPath', () => {
  it.each([
    ['falls back to the default location', {}, `${HOME}/.config/questionable-choices/config.json`],
    ['honours QC_CONFIG', { QC_CONFIG: '/etc/qc.json' }, '/etc/qc.json'],
    ['expands ~ in QC_CONFIG', { QC_CONFIG: '~/qc.json' }, `${HOME}/qc.json`],
    [
      'ignores an empty QC_CONFIG',
      { QC_CONFIG: '' },
      `${HOME}/.config/questionable-choices/config.json`,
    ],
  ])('%s', (_name, env, expected) => {
    expect(resolveConfigPath(env, HOME)).toBe(expected);
  });
});

describe('checkEnvironment', () => {
  const config = parseConfig(minimal(), { home: HOME });

  it('is silent when both credentials are set', () => {
    expect(checkEnvironment(config, { JIRA_EMAIL: 'a@b.c', JIRA_TOKEN: 'secret' })).toEqual([]);
  });

  it.each([
    ['both missing', {}, 2],
    ['the token missing', { JIRA_EMAIL: 'a@b.c' }, 1],
    ['the token empty', { JIRA_EMAIL: 'a@b.c', JIRA_TOKEN: '' }, 1],
  ])('warns about %s', (_name, env, expected) => {
    const warnings = checkEnvironment(config, env);
    expect(warnings.length).toBe(expected);
    expect(warnings.every((warning) => warning.includes("workspace 'ws'"))).toBe(true);
  });
});

describe('startDefaults', () => {
  const config = parseConfig(minimal(), { home: HOME });

  it('falls back to the runner defaults', () => {
    expect(startDefaults(config)).toEqual({
      model: 'm1',
      effort: 'medium',
      permissionMode: 'default',
    });
  });

  it('lets a playbook override each value independently', () => {
    expect(startDefaults(config, { permissionMode: 'acceptEdits' })).toEqual({
      model: 'm1',
      effort: 'medium',
      permissionMode: 'acceptEdits',
    });
    expect(startDefaults(config, { effort: 'max', model: 'm1' })).toEqual({
      model: 'm1',
      effort: 'max',
      permissionMode: 'default',
    });
  });
});
