import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JiraSearchResponse } from '../../src/connectors/issues/jira/client.js';
import {
  adfToText,
  issueUrl,
  mapIssue,
  statusCategoryFrom,
} from '../../src/connectors/issues/jira/map.js';

const page = JSON.parse(
  readFileSync(new URL('./fixtures/jira-search-page.json', import.meta.url), 'utf8'),
) as JiraSearchResponse;

const issues = page.issues ?? [];
const SITE = 'example.atlassian.net';

describe('statusCategoryFrom', () => {
  it('maps the three Jira category keys', () => {
    expect(statusCategoryFrom('new')).toBe('todo');
    expect(statusCategoryFrom('indeterminate')).toBe('inprogress');
    expect(statusCategoryFrom('done')).toBe('done');
  });

  it('treats an unknown or missing key as todo', () => {
    expect(statusCategoryFrom('undefined')).toBe('todo');
    expect(statusCategoryFrom(undefined)).toBe('todo');
    expect(statusCategoryFrom(null)).toBe('todo');
  });
});

describe('issueUrl', () => {
  it('builds a browse URL on the configured site', () => {
    expect(issueUrl(SITE, 'DOC-1')).toBe('https://example.atlassian.net/browse/DOC-1');
  });

  it('tolerates a site that already carries a scheme or trailing slash', () => {
    expect(issueUrl('https://example.atlassian.net/', 'DOC-1')).toBe(
      'https://example.atlassian.net/browse/DOC-1',
    );
  });
});

describe('mapIssue', () => {
  it('maps a fully populated REST issue', () => {
    const issue = mapIssue(issues[0]!, SITE);
    expect(issue.key).toBe('DOC-3847');
    expect(issue.summary).toBe('Consolidate content-validation reporting');
    expect(issue.type).toBe('Story');
    expect(issue.status).toBe('In Progress');
    expect(issue.statusCategory).toBe('inprogress');
    expect(issue.labels).toEqual(['docs', 'pipeline']);
    expect(issue.url).toBe('https://example.atlassian.net/browse/DOC-3847');
    expect(issue.assignee).toBe('Jakub Skurek');
    expect(issue.priority).toBe('Medium');
    expect(issue.updated).toBe('2026-09-08T14:22:11.000+0200');
  });

  it('leaves optional fields undefined when the response nulls them', () => {
    const issue = mapIssue(issues[1]!, SITE);
    expect(issue.assignee).toBeUndefined();
    expect(issue.priority).toBeUndefined();
    expect(issue.description).toBeUndefined();
    expect(issue.labels).toEqual([]);
    expect(issue.statusCategory).toBe('todo');
  });

  it('flattens the description to plain text', () => {
    const issue = mapIssue(issues[0]!, SITE);
    expect(issue.description).toBe(
      [
        'The validator prints two different report shapes.',
        '',
        'See the convention (https://example.com/conventions) first.',
        '',
        '- one stdout format',
        '- one annotation format',
        '',
        '```bash',
        'npm run content:validate',
        '```',
      ].join('\n'),
    );
  });

  it('falls back to empty strings for missing scalar fields', () => {
    const issue = mapIssue({ key: 'DOC-9' }, SITE);
    expect(issue.summary).toBe('');
    expect(issue.type).toBe('');
    expect(issue.status).toBe('');
    expect(issue.statusCategory).toBe('todo');
  });
});

describe('adfToText', () => {
  it('joins paragraphs with a blank line', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    });
    expect(text).toBe('first\n\nsecond');
  });

  it('drops inline marks other than links', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
          ],
        },
      ],
    });
    expect(text).toBe('bold and code');
  });

  it('renders a link as text followed by its url', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'the docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    });
    expect(text).toBe('the docs (https://example.com)');
  });

  it('numbers an ordered list from its start attribute', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { order: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fourth' }] }],
            },
          ],
        },
      ],
    });
    expect(text).toBe('3. third\n4. fourth');
  });

  it('indents a list nested inside a list item', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(text).toBe('- outer\n  - inner');
  });

  it('fences a code block with its language and keeps the code verbatim', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const a = 1;\nconst b = 2;' }],
        },
      ],
    });
    expect(text).toBe('```ts\nconst a = 1;\nconst b = 2;\n```');
  });

  it('turns a hard break into a newline inside its paragraph', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    });
    expect(text).toBe('one\ntwo');
  });

  it('quotes a blockquote and rules a rule', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
        { type: 'rule' },
      ],
    });
    expect(text).toBe('> quoted\n\n---');
  });

  it('drops media blocks and empty paragraphs', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
        { type: 'paragraph' },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      ],
    });
    expect(text).toBe('kept');
  });

  it('renders mentions, emoji and inline cards as their text', () => {
    const text = adfToText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { text: '@Jakub' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':tada:' } },
            { type: 'text', text: ' ' },
            { type: 'inlineCard', attrs: { url: 'https://example.com/card' } },
          ],
        },
      ],
    });
    expect(text).toBe('@Jakub :tada: https://example.com/card');
  });

  it('passes a plain-text description through and ignores anything else', () => {
    expect(adfToText('  already text  ')).toBe('already text');
    expect(adfToText(null)).toBe('');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText(42)).toBe('');
  });
});
