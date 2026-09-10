import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  applyWorkspaceChange,
  checkEnvironment,
  expandHome,
  formatConfigIssues,
  parseConfig,
  removeWorkspace,
  resolveConfigPath,
  serializeConfig,
  startDefaults,
  workspaceIdFor,
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
        path: '~/repos/app',
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
    workspaces: {
      ws: {
        name: 'Workspace',
        epic: 'DOC-1',
        connector: 'tracker',
        repo: 'app',
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
    expect(Object.keys(config.workspaces)).toEqual(['docs-nextjs', 'docs-nextjs-migration']);
    const workspace = config.workspaces['docs-nextjs'];
    expect(workspace?.name).toBe('Docs · Next.js');
    expect(workspace?.epic).toBe('DOC-3807');
    expect(workspace?.connector).toBe('kentico-jira');
    expect(config.connectors['kentico-jira']?.site).toBe('kentico.atlassian.net');
    expect(config.repos['docs-workspace']?.playbooks.map((playbook) => playbook.id)).toEqual([
      'implement',
      'test',
    ]);
  });

  it('defaults the review statuses, the checklist and the poll interval of a bare workspace', () => {
    const config = parseConfig(exampleDocument(), { home: HOME });
    const workspace = config.workspaces['docs-nextjs-migration'];
    expect(workspace?.reviewStatuses).toEqual(['Ready for review']);
    expect(workspace?.checklist).toEqual([]);
    expect(workspace?.pollSeconds).toBe(120);
  });

  it('tells the implement playbook to open the "How to test" comment with the PR link', () => {
    const config = parseConfig(exampleDocument(), { home: HOME });
    const implement = config.repos['docs-workspace']?.playbooks.find(
      (playbook) => playbook.id === 'implement',
    );
    expect(implement?.promptTemplate).toContain('titled "How to test" that opens with the PR link');
    expect(implement?.promptTemplate).toContain(
      'the "How to test" comment, with the PR link, is on {{key}}',
    );
  });

  it('carries the checklist template of the workspace that names one', () => {
    const config = parseConfig(exampleDocument(), { home: HOME });
    expect(config.workspaces['docs-nextjs']?.checklist).toHaveLength(3);
  });

  it('round-trips through serializeConfig', () => {
    const config = parseConfig(exampleDocument(), { home: HOME });
    expect(parseConfig(JSON.parse(JSON.stringify(serializeConfig(config))), { home: '' })).toEqual(
      config,
    );
  });

  it('validates without the optional editor block', () => {
    const document = exampleDocument();
    delete document['editor'];
    expect(parseConfig(document, { home: HOME }).editor).toEqual({
      command: 'code',
      args: ['{{path}}'],
    });
  });

  it('refuses a key the schema does not know', () => {
    const document = exampleDocument();
    document['typoKey'] = true;
    expect(() => parseConfig(document, { home: HOME })).toThrow(ConfigError);
  });

  it('refuses a misspelled workspace field instead of silently defaulting it', () => {
    const document = exampleDocument();
    const workspaces = document['workspaces'] as Record<string, Record<string, unknown>>;
    const workspace = workspaces['docs-nextjs'] as Record<string, unknown>;
    delete workspace['pollSeconds'];
    workspace['pollSecs'] = 30;
    expect(issuesOf(document).join('\n')).toContain('pollSecs');
  });

  it('refuses two playbooks claiming the same column as their primary action', () => {
    const document = exampleDocument();
    const repos = document['repos'] as Record<string, Record<string, unknown>>;
    const playbooks = (repos['docs-workspace'] as Record<string, unknown>)['playbooks'] as Array<
      Record<string, unknown>
    >;
    (playbooks[1] as Record<string, unknown>)['primaryFor'] = ['backlog'];
    expect(issuesOf(document)).toContain(
      "repos.docs-workspace.playbooks[1].primaryFor[0]: column 'backlog' is already the primary action of playbook 'implement'",
    );
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
    expect(config.runner.compactModel).toBe('claude-sonnet-5');
    const repo = config.repos['app'];
    expect(repo?.baseRef).toBe('origin/main');
    expect(repo?.branchPattern).toBe('{{key}}-{{slug}}');
    expect(repo?.bootstrap).toBeUndefined();
    expect(repo?.playbooks[0]?.primaryFor).toEqual([]);
    expect(repo?.playbooks[0]?.description).toBe('');
    const workspace = config.workspaces['ws'];
    expect(workspace?.pollSeconds).toBe(120);
    expect(workspace?.reviewStatuses).toEqual(['Ready for review']);
  });

  it('accepts a compactModel that names one of the offered models', () => {
    const document = minimal();
    const runner = document['runner'] as Record<string, unknown>;
    const models = runner['models'] as Array<Record<string, unknown>>;
    runner['compactModel'] = models[0]?.['id'];
    expect(parseConfig(document, { home: HOME }).runner.compactModel).toBe(models[0]?.['id']);
  });

  it('accepts a jql override alongside the epic', () => {
    const document = minimal();
    const workspaces = document['workspaces'] as Record<string, Record<string, unknown>>;
    (workspaces['ws'] as Record<string, unknown>)['jql'] = 'project = DOC';
    expect(parseConfig(document, { home: HOME }).workspaces['ws']?.jql).toBe('project = DOC');
  });
});

describe('the checklist template', () => {
  /**
   * Builds the minimal document with one workspace carrying a checklist.
   *
   * @param checklist - Value to write into the workspace's `checklist` field.
   * @returns The document.
   */
  const withChecklist = (checklist: unknown): Record<string, unknown> => {
    const document = minimal();
    const workspaces = document['workspaces'] as Record<string, Record<string, unknown>>;
    (workspaces['ws'] as Record<string, unknown>)['checklist'] = checklist;
    return document;
  };

  it('accepts a list of items and keeps their order', () => {
    const config = parseConfig(withChecklist(['Read the issue', 'Verify', 'Comment']), {
      home: HOME,
    });
    expect(config.workspaces['ws']?.checklist).toEqual(['Read the issue', 'Verify', 'Comment']);
  });

  it('defaults to no checklist when the workspace names none', () => {
    expect(parseConfig(minimal(), { home: HOME }).workspaces['ws']?.checklist).toEqual([]);
  });

  it('refuses an empty item, naming its index', () => {
    expect(issuesOf(withChecklist(['Read the issue', '']))).toContain(
      'workspaces.ws.checklist[1]: checklist item must not be empty',
    );
  });

  it('refuses a checklist that is not a list, rather than throwing on it', () => {
    expect(issuesOf(withChecklist('Read the issue')).map((issue) => issue.split(':')[0])).toContain(
      'workspaces.ws.checklist',
    );
  });

  it('refuses a duplicate item, naming the index of the repeat', () => {
    expect(issuesOf(withChecklist(['Verify', 'Read the issue', 'Verify']))).toContain(
      "workspaces.ws.checklist[2]: duplicate checklist item 'Verify'",
    );
  });

  it('round-trips through serializeConfig', () => {
    const config = parseConfig(withChecklist(['Read the issue', 'Verify']), { home: HOME });
    const written = JSON.parse(JSON.stringify(serializeConfig(config))) as unknown;
    expect(parseConfig(written, { home: '' }).workspaces['ws']?.checklist).toEqual([
      'Read the issue',
      'Verify',
    ]);
  });

  it('keeps the surviving workspace’s checklist when another is removed', () => {
    const document = withChecklist(['Read the issue', 'Verify']);
    const workspaces = document['workspaces'] as Record<string, Record<string, unknown>>;
    workspaces['other'] = { name: 'Other', epic: 'DOC-2', connector: 'tracker', repo: 'app' };
    const config = parseConfig(document, { home: HOME });
    expect(removeWorkspace(config, 'other').workspaces['ws']?.checklist).toEqual([
      'Read the issue',
      'Verify',
    ]);
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
    expect(config.repos['app']?.path).toBe(`${HOME}/repos/app`);
    expect(config.repos['app']?.worktreeDir).toBe(`${HOME}/repos/worktrees`);
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

  /**
   * Reads the single repo out of a document under construction.
   *
   * @param document - The document.
   * @returns The repo object.
   */
  const repoOf = (document: Record<string, unknown>): Record<string, unknown> =>
    (document['repos'] as Record<string, Record<string, unknown>>)['app'] as Record<
      string,
      unknown
    >;

  /**
   * Reads the single connector out of a document under construction.
   *
   * @param document - The document.
   * @returns The connector object.
   */
  const connectorOf = (document: Record<string, unknown>): Record<string, unknown> =>
    (document['connectors'] as Record<string, Record<string, unknown>>)['tracker'] as Record<
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
      name: 'a compact model that is neither offered nor the shipped default',
      document: broken((document) => {
        (document['runner'] as Record<string, unknown>)['compactModel'] = 'ghost';
      }),
      locator: 'runner.compactModel',
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
        const playbooks = repoOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['defaults'] = { model: 'ghost' };
      }),
      locator: 'repos.app.playbooks[0].defaults.model',
    },
    {
      name: 'duplicate playbook ids',
      document: broken((document) => {
        const playbooks = repoOf(document)['playbooks'] as Record<string, unknown>[];
        playbooks.push({ ...(playbooks[0] as Record<string, unknown>) });
      }),
      locator: 'repos.app.playbooks[1].id',
    },
    {
      name: 'a playbook claiming a lane that does not exist',
      document: broken((document) => {
        const playbooks = repoOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['primaryFor'] = ['icebox'];
      }),
      locator: 'repos.app.playbooks[0].primaryFor[0]',
    },
    {
      name: 'an unknown isolation',
      document: broken((document) => {
        const playbooks = repoOf(document)['playbooks'] as Record<string, unknown>[];
        (playbooks[0] as Record<string, unknown>)['isolation'] = 'container';
      }),
      locator: 'repos.app.playbooks[0].isolation',
    },
    {
      name: 'a repo with no playbooks',
      document: broken((document) => {
        repoOf(document)['playbooks'] = [];
      }),
      locator: 'repos.app.playbooks',
    },
    {
      name: 'a repo with no path',
      document: broken((document) => {
        delete repoOf(document)['path'];
      }),
      locator: 'repos.app.path',
    },
    {
      name: 'a workspace with no name',
      document: broken((document) => {
        delete workspaceOf(document)['name'];
      }),
      locator: 'workspaces.ws.name',
    },
    {
      name: 'a workspace naming no epic',
      document: broken((document) => {
        delete workspaceOf(document)['epic'];
      }),
      locator: 'workspaces.ws.epic',
    },
    {
      name: 'a workspace pointing at a connector that is not configured',
      document: broken((document) => {
        workspaceOf(document)['connector'] = 'ghost';
      }),
      locator: 'workspaces.ws.connector',
    },
    {
      name: 'a workspace pointing at a repo that is not configured',
      document: broken((document) => {
        workspaceOf(document)['repo'] = 'ghost';
      }),
      locator: 'workspaces.ws.repo',
    },
    {
      name: 'a connector with no credentials named',
      document: broken((document) => {
        connectorOf(document)['emailEnv'] = '';
      }),
      locator: 'connectors.tracker.emailEnv',
    },
    {
      name: 'an unknown connector type',
      document: broken((document) => {
        connectorOf(document)['type'] = 'github';
      }),
      locator: 'connectors.tracker.type',
    },
    {
      name: 'a poll interval below the floor',
      document: broken((document) => {
        workspaceOf(document)['pollSeconds'] = 1;
      }),
      locator: 'workspaces.ws.pollSeconds',
    },
    {
      name: 'a port outside the valid range',
      document: broken((document) => {
        document['port'] = 70000;
      }),
      locator: 'port',
    },
    { name: 'no workspaces at all', document: minimal({ workspaces: {} }), locator: 'workspaces' },
    { name: 'no repos at all', document: minimal({ repos: {} }), locator: 'repos' },
    { name: 'no connectors at all', document: minimal({ connectors: {} }), locator: 'connectors' },
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
    expect(warnings.every((warning) => warning.includes("connector 'tracker'"))).toBe(true);
  });
});

describe('applyWorkspaceChange', () => {
  const config = parseConfig(minimal(), { home: HOME });

  it('adds a workspace against an existing connector', () => {
    const next = applyWorkspaceChange(config, {
      id: 'second',
      name: 'Second',
      epic: 'DOC-9',
      repo: 'app',
      connector: 'tracker',
    });

    expect(Object.keys(next.workspaces)).toEqual(['ws', 'second']);
    expect(next.workspaces['second']).toEqual({
      name: 'Second',
      epic: 'DOC-9',
      connector: 'tracker',
      repo: 'app',
      reviewStatuses: ['Ready for review'],
      checklist: [],
      pollSeconds: 120,
    });
    expect(Object.keys(config.workspaces)).toEqual(['ws']);
  });

  it('creates the inline connector alongside the workspace', () => {
    const next = applyWorkspaceChange(config, {
      name: 'Other Tracker',
      epic: 'OPS-1',
      repo: 'app',
      newConnector: {
        id: 'ops',
        site: 'ops.atlassian.net',
        emailEnv: 'OPS_EMAIL',
        tokenEnv: 'OPS_TOKEN',
      },
      reviewStatuses: ['In review'],
      jql: 'project = OPS',
    });

    expect(next.connectors['ops']?.site).toBe('ops.atlassian.net');
    const added = next.workspaces['other-tracker'];
    expect(added?.connector).toBe('ops');
    expect(added?.reviewStatuses).toEqual(['In review']);
    expect(added?.jql).toBe('project = OPS');
  });

  it('falls back to the default review statuses when the request clears the list', () => {
    // An empty list would empty the Review lane for good with no way to tell
    // it apart from "the field was left alone".
    const next = applyWorkspaceChange(config, {
      id: 'cleared',
      name: 'Cleared',
      epic: 'DOC-9',
      repo: 'app',
      connector: 'tracker',
      reviewStatuses: [],
    });

    expect(next.workspaces['cleared']?.reviewStatuses).toEqual(['Ready for review']);
  });

  it('slugs the id out of the name when the request names none', () => {
    expect(workspaceIdFor({ name: 'Docs · Next.js', epic: 'DOC-1', repo: 'app' })).toBe(
      'docs-next-js',
    );
  });

  it.each([
    [
      'a duplicate id',
      { id: 'ws', name: 'Again', epic: 'DOC-2', repo: 'app', connector: 'tracker' },
      'id',
    ],
    [
      'neither connector nor newConnector',
      { name: 'Bare', epic: 'DOC-2', repo: 'app' },
      'connector',
    ],
    [
      'both connector and newConnector',
      {
        name: 'Both',
        epic: 'DOC-2',
        repo: 'app',
        connector: 'tracker',
        newConnector: { id: 'x', site: 's', emailEnv: 'E', tokenEnv: 'T' },
      },
      'connector',
    ],
    [
      'an inline connector whose id is taken',
      {
        name: 'Taken',
        epic: 'DOC-2',
        repo: 'app',
        newConnector: { id: 'tracker', site: 's', emailEnv: 'E', tokenEnv: 'T' },
      },
      'newConnector.id',
    ],
    [
      'an inline connector whose id is not a usable id',
      {
        name: 'Shouty',
        epic: 'DOC-2',
        repo: 'app',
        newConnector: { id: 'Kentico-Jira', site: 's', emailEnv: 'E', tokenEnv: 'T' },
      },
      'newConnector.id',
    ],
    [
      'a repo that is not configured',
      { name: 'Ghost repo', epic: 'DOC-2', repo: 'ghost', connector: 'tracker' },
      'repo',
    ],
    [
      'an epic that is missing',
      { name: 'No epic', epic: '', repo: 'app', connector: 'tracker' },
      'epic',
    ],
  ])('refuses %s at %s', (_name, request, locator) => {
    try {
      applyWorkspaceChange(config, request);
      throw new Error('expected the request to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.map((issue) => issue.path)).toContain(locator);
    }
  });

  it.each([
    [
      'a workspace id that is not a usable id',
      { id: 'Bad-Id', name: 'Shouty', epic: 'DOC-2', repo: 'app', connector: 'tracker' },
      'id',
      'workspace id must be lowercase letters, digits and dashes',
    ],
    [
      'an inline connector id that is not a usable id',
      {
        name: 'Shouty',
        epic: 'DOC-2',
        repo: 'app',
        newConnector: { id: 'Kentico-Jira', site: 's', emailEnv: 'E', tokenEnv: 'T' },
      },
      'newConnector.id',
      'connector id must be lowercase letters, digits and dashes',
    ],
  ])('tells the owner what a valid id looks like for %s', (_name, request, locator, message) => {
    // An id is validated as a record key, so the schema's own message is
    // discarded and zod reports its generic one — which names the problem and
    // not the rule the dialog has to show next to the field.
    try {
      applyWorkspaceChange(config, request);
      throw new Error('expected the request to be rejected');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.find((issue) => issue.path === locator)?.message).toBe(message);
    }
  });
});

describe('a record key the schema refuses', () => {
  it.each([
    ['repos', 'repo id must be lowercase letters, digits and dashes'],
    ['connectors', 'connector id must be lowercase letters, digits and dashes'],
    ['workspaces', 'workspace id must be lowercase letters, digits and dashes'],
  ])('names the id rule for a bad key under %s', (section, message) => {
    // The repair is keyed on zod's issue `code`, not on the text of its
    // message: a library that rewords the message in a patch release would
    // otherwise turn the repair into a silent no-op.
    const document = minimal() as Record<string, Record<string, unknown>>;
    const entries = document[section] as Record<string, unknown>;
    entries['Bad Id'] = entries[Object.keys(entries)[0] as string];

    try {
      parseConfig(document, { home: HOME });
      throw new Error('expected the document to be rejected');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.find((issue) => issue.path === `${section}.Bad Id`)?.message).toBe(message);
    }
  });

  it('leaves a value problem’s own message alone', () => {
    const document = minimal() as Record<string, Record<string, unknown>>;
    (document['workspaces']?.['ws'] as Record<string, unknown>)['epic'] = '';

    try {
      parseConfig(document, { home: HOME });
      throw new Error('expected the document to be rejected');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.find((issue) => issue.path === 'workspaces.ws.epic')?.message).not.toContain(
        'must be lowercase',
      );
    }
  });
});

describe('removeWorkspace', () => {
  const config = applyWorkspaceChange(parseConfig(minimal(), { home: HOME }), {
    id: 'second',
    name: 'Second',
    epic: 'DOC-9',
    repo: 'app',
    connector: 'tracker',
  });

  it('drops one workspace and leaves the repos and connectors alone', () => {
    const next = removeWorkspace(config, 'second');
    expect(Object.keys(next.workspaces)).toEqual(['ws']);
    expect(Object.keys(next.repos)).toEqual(['app']);
    expect(Object.keys(next.connectors)).toEqual(['tracker']);
  });

  it('takes an inline connector with the workspace that was its only user', () => {
    const withInline = applyWorkspaceChange(config, {
      id: 'third',
      name: 'Third',
      epic: 'DOC-10',
      repo: 'app',
      newConnector: { id: 'other', site: 'other.atlassian.net', emailEnv: 'E', tokenEnv: 'T' },
    });

    const next = removeWorkspace(withInline, 'third');

    expect(Object.keys(next.connectors)).toEqual(['tracker']);
  });

  it('keeps a connector the removed workspace never named, even with no user left', () => {
    // A connector written into the file by hand for a board that does not exist
    // yet is valid, unreferenced, and none of a removal's business.
    const document = minimal();
    const connectors = document['connectors'] as Record<string, unknown>;
    connectors['spare'] = {
      type: 'jira',
      site: 'spare.atlassian.net',
      emailEnv: 'SPARE_EMAIL',
      tokenEnv: 'SPARE_TOKEN',
    };
    const withSpare = applyWorkspaceChange(parseConfig(document, { home: HOME }), {
      id: 'second',
      name: 'Second',
      epic: 'DOC-9',
      repo: 'app',
      connector: 'tracker',
    });

    const next = removeWorkspace(withSpare, 'second');

    expect(Object.keys(next.connectors).sort()).toEqual(['spare', 'tracker']);
  });

  it('keeps the connector when another workspace still names it', () => {
    const next = removeWorkspace(config, 'second');
    expect(next.connectors['tracker']?.site).toBe('example.atlassian.net');
    expect(next.workspaces['ws']?.connector).toBe('tracker');
  });

  it('refuses an unknown id at the id path', () => {
    try {
      removeWorkspace(config, 'ghost');
      throw new Error('expected the removal to be rejected');
    } catch (error) {
      expect((error as ConfigError).issues[0]?.path).toBe('id');
    }
  });

  it('refuses to remove the last workspace', () => {
    const single = parseConfig(minimal(), { home: HOME });
    expect(() => removeWorkspace(single, 'ws')).toThrow(ConfigError);
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
