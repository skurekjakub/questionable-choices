import { describe, expect, it } from 'vitest';
import {
  SLUG_MAX_LENGTH,
  branchName,
  editorCommand,
  promptVariables,
  renderPrompt,
  renderTemplate,
  sessionName,
  slug,
} from '../../src/core/prompt.js';
import { makeIssue, makePlaybook } from './helpers.js';

describe('renderTemplate', () => {
  it.each([
    ['substitutes a known variable', 'Work on {{key}}', { key: 'DOC-1' }, 'Work on DOC-1'],
    ['substitutes every occurrence', '{{k}} and {{k}}', { k: 'x' }, 'x and x'],
    ['leaves an unknown variable as written', 'a {{nope}} b', { key: 'x' }, 'a {{nope}} b'],
    ['leaves a malformed placeholder alone', '{{ key }} {key}', { key: 'x' }, '{{ key }} {key}'],
    ['substitutes an empty value', 'branch: {{branch}}', { branch: '' }, 'branch: '],
    ['is a literal replace, not a rerender', '{{a}}', { a: '{{b}}', b: 'x' }, '{{b}}'],
  ])('%s', (_name, template, variables, expected) => {
    expect(renderTemplate(template, variables)).toBe(expected);
  });
});

describe('slug', () => {
  it.each([
    ['Fix the thing', 'fix-the-thing'],
    ['DOC-3847: Consolidate  reporting', 'doc-3847-consolidate-reporting'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['Mixed_CASE/and.punctuation!', 'mixed-case-and-punctuation'],
    ['résumé wörk', 'r-sum-w-rk'],
    ['---', ''],
    ['', ''],
  ])('turns %o into %o', (input, expected) => {
    expect(slug(input)).toBe(expected);
  });

  it('caps the length and drops a trailing separator', () => {
    const long = slug('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(long.endsWith('-')).toBe(false);
    expect(long.startsWith('word-word-')).toBe(true);
  });
});

describe('branchName', () => {
  it('renders the default pattern', () => {
    const issue = makeIssue({ key: 'DOC-3847', summary: 'Consolidate reporting' });
    expect(branchName('{{key}}-{{slug}}', issue)).toBe('DOC-3847-consolidate-reporting');
  });

  it('honours a pattern that uses only the key', () => {
    expect(branchName('feature/{{key}}', makeIssue({ key: 'DOC-1' }))).toBe('feature/DOC-1');
  });
});

describe('sessionName', () => {
  it.each([
    [['qc', 'DOC-3847', 'implement'], 'qc-DOC-3847-implement'],
    [['qc', 'DOC.1', 'test'], 'qc-DOC-1-test'],
    [['qc', 'A:B', 'play book'], 'qc-A-B-play-book'],
  ])('builds %o into %s', (parts, expected) => {
    const [prefix, key, playbook] = parts as [string, string, string];
    expect(sessionName(prefix, key, playbook)).toBe(expected);
  });
});

describe('promptVariables', () => {
  it('supplies a string for every documented placeholder', () => {
    const variables = promptVariables(makeIssue({ labels: ['a', 'b'], description: 'text' }), {
      branch: 'DOC-1-x',
      worktree: '/repos/worktrees/DOC-1',
    });
    expect(Object.keys(variables).sort()).toEqual([
      'branch',
      'description',
      'key',
      'labels',
      'status',
      'summary',
      'type',
      'url',
      'worktree',
    ]);
    expect(variables['labels']).toBe('a, b');
    expect(Object.values(variables).every((value) => typeof value === 'string')).toBe(true);
  });

  it('renders a missing description and a null branch as empty strings', () => {
    const variables = promptVariables(makeIssue(), { branch: null, worktree: '/repos/app' });
    expect(variables['description']).toBe('');
    expect(variables['branch']).toBe('');
  });
});

describe('renderPrompt', () => {
  it('renders a playbook template against an issue and its checkout', () => {
    const playbook = makePlaybook({ promptTemplate: '{{key}} on {{branch}} in {{worktree}}' });
    const prompt = renderPrompt(playbook, makeIssue({ key: 'DOC-9' }), {
      branch: 'DOC-9-x',
      worktree: '/repos/worktrees/DOC-9',
    });
    expect(prompt).toBe('DOC-9 on DOC-9-x in /repos/worktrees/DOC-9');
  });
});

describe('editorCommand', () => {
  it.each([
    [
      'the default local editor',
      { command: 'code', args: ['{{path}}'] },
      { command: 'code', args: ['/repos/worktrees/DOC-1'] },
    ],
    [
      'the WSL remote invocation',
      {
        command: 'cmd.exe',
        args: ['/c', 'code', '--remote', 'wsl+Ubuntu', '{{path}}'],
      },
      {
        command: 'cmd.exe',
        args: ['/c', 'code', '--remote', 'wsl+Ubuntu', '/repos/worktrees/DOC-1'],
      },
    ],
    [
      'a path embedded in a larger argument',
      { command: 'code', args: ['--folder-uri=file://{{path}}'] },
      { command: 'code', args: ['--folder-uri=file:///repos/worktrees/DOC-1'] },
    ],
  ])('renders %s', (_name, editor, expected) => {
    expect(editorCommand(editor, '/repos/worktrees/DOC-1')).toEqual(expected);
  });

  it('keeps a path with spaces in a single argument', () => {
    const invocation = editorCommand({ command: 'code', args: ['{{path}}'] }, '/a b/c');
    expect(invocation.args).toEqual(['/a b/c']);
  });
});
