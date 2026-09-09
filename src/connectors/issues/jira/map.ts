import type { Issue, StatusCategory } from '../../../core/types.js';
import { normaliseSite, type JiraIssueResource } from './client.js';

interface AdfMark {
  type?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
}

interface AdfNode {
  type?: string | undefined;
  text?: string | undefined;
  content?: AdfNode[] | undefined;
  marks?: AdfMark[] | undefined;
  attrs?: Record<string, unknown> | undefined;
}

/**
 * Maps a Jira status-category key onto the board's coarse buckets.
 *
 * @param key - The `status.statusCategory.key` value Jira reported.
 * @returns The matching bucket; `todo` for an unknown or missing key.
 */
export function statusCategoryFrom(key: string | null | undefined): StatusCategory {
  if (key === 'indeterminate') return 'inprogress';
  if (key === 'done') return 'done';
  return 'todo';
}

/**
 * Builds the browser URL of an issue.
 *
 * @param site - Jira Cloud site host, with or without a scheme.
 * @param key - Issue key, e.g. `DOC-3847`.
 * @returns The `/browse/<key>` URL on that site.
 */
export function issueUrl(site: string, key: string): string {
  return `https://${normaliseSite(site)}/browse/${key}`;
}

/**
 * Narrows an unknown value to an ADF node.
 *
 * @param value - Candidate value from a parsed JSON document.
 * @returns True when the value can be read as a node.
 */
function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads a string attribute off a node.
 *
 * @param node - Node to read from.
 * @param name - Attribute name.
 * @returns The attribute, or an empty string when it is missing or not a string.
 */
function attr(node: AdfNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Reads a numeric attribute off a node.
 *
 * Jira sends `order` as a number, but hand-written and round-tripped documents
 * carry it as a string, so both shapes have to be accepted.
 *
 * @param node - Node to read from.
 * @param name - Attribute name.
 * @returns The attribute as a finite number, or null when it is neither.
 */
function numericAttr(node: AdfNode, name: string): number | null {
  const value = node.attrs?.[name];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Concatenates the raw text of a node's children, ignoring every mark.
 *
 * @param nodes - Child nodes to read.
 * @returns The concatenated text.
 */
function rawText(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((node) => node.text ?? rawText(node.content)).join('');
}

/**
 * Renders one inline node as plain text.
 *
 * @param node - Inline node to render.
 * @returns The node's text; links render as `text (url)`.
 */
function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.['href'];
      return typeof href === 'string' && href !== '' ? `${text} (${href})` : text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attr(node, 'text');
    case 'emoji':
      return attr(node, 'text') || attr(node, 'shortName');
    case 'inlineCard':
      return attr(node, 'url');
    default:
      return renderInline(node.content);
  }
}

/**
 * Renders a run of inline nodes as plain text.
 *
 * @param nodes - Inline nodes to render.
 * @returns The concatenated text.
 */
function renderInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(renderInlineNode).join('');
}

/**
 * Prefixes every non-empty line of a block.
 *
 * @param text - Block text, possibly multi-line.
 * @param prefix - Prefix to put in front of each non-empty line.
 * @returns The prefixed block.
 */
function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : prefix + line))
    .join('\n');
}

/**
 * Renders a bullet or ordered list, indenting nested content by two spaces.
 *
 * @param list - The `bulletList` or `orderedList` node.
 * @param ordered - Whether items get `1. ` markers instead of `- `.
 * @returns One line per item, nested blocks indented under their marker.
 */
function renderList(list: AdfNode, ordered: boolean): string {
  const order = numericAttr(list, 'order');
  let counter = ordered && order !== null && order > 0 ? order : 1;
  const rendered: string[] = [];
  for (const item of list.content ?? []) {
    if (item.type !== 'listItem') continue;
    const marker = ordered ? `${counter}. ` : '- ';
    counter += 1;
    const body = renderBlocks(item.content).join('\n');
    const lines = body === '' ? [''] : body.split('\n');
    rendered.push(
      lines
        .map((line, index) => (index === 0 ? marker + line : line === '' ? '' : `  ${line}`))
        .join('\n'),
    );
  }
  return rendered.join('\n');
}

/**
 * Renders one block-level node as plain text.
 *
 * @param node - Block node to render.
 * @returns The block's text, or an empty string for a block that carries none.
 */
function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return renderInline(node.content);
    case 'bulletList':
      return renderList(node, false);
    case 'orderedList':
      return renderList(node, true);
    case 'codeBlock': {
      const language = attr(node, 'language');
      return `\`\`\`${language}\n${rawText(node.content)}\n\`\`\``;
    }
    case 'rule':
      return '---';
    case 'blockquote':
      return prefixLines(renderBlocks(node.content).join('\n\n'), '> ');
    case 'media':
    case 'mediaGroup':
    case 'mediaSingle':
      return '';
    default:
      return renderBlocks(node.content).join('\n\n');
  }
}

/**
 * Renders a run of block-level nodes, dropping the ones that carry no text.
 *
 * @param nodes - Block nodes to render.
 * @returns One string per non-empty block.
 */
function renderBlocks(nodes: AdfNode[] | undefined): string[] {
  const blocks: string[] = [];
  for (const node of nodes ?? []) {
    const text = renderBlock(node);
    if (text !== '') blocks.push(text);
  }
  return blocks;
}

/**
 * Flattens an Atlassian Document Format tree to plain text.
 *
 * Paragraphs are joined by blank lines, bullet items render as `- ` and
 * ordered items as `1. `, code blocks are fenced, links render as
 * `text (url)`, and every other inline mark is dropped.
 *
 * @param value - The `description` field as Jira returned it; a plain string
 *   passes through unchanged.
 * @returns The plain text, with leading and trailing blank lines removed.
 */
export function adfToText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isNode(value)) return '';
  const blocks = value.type === 'doc' ? renderBlocks(value.content) : renderBlocks([value]);
  return blocks.join('\n\n').trim();
}

/**
 * Maps a Jira REST issue onto the board's issue shape.
 *
 * @param resource - The issue as the REST API returned it.
 * @param site - Jira Cloud site host, used to build the browser URL.
 * @returns The normalised issue; `description` is absent when the response
 *   carried none.
 */
export function mapIssue(resource: JiraIssueResource, site: string): Issue {
  const fields = resource.fields ?? {};
  const description = fields.description;
  return {
    key: resource.key,
    summary: fields.summary ?? '',
    type: fields.issuetype?.name ?? '',
    status: fields.status?.name ?? '',
    statusCategory: statusCategoryFrom(fields.status?.statusCategory?.key),
    labels: fields.labels ?? [],
    url: issueUrl(site, resource.key),
    description:
      description === undefined || description === null ? undefined : adfToText(description),
    assignee: fields.assignee?.displayName ?? undefined,
    priority: fields.priority?.name ?? undefined,
    updated: fields.updated ?? undefined,
  };
}
