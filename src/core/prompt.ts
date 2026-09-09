import type { EditorConfig, Issue, Playbook } from './types.js';

/**
 * Maximum length of a generated slug, in characters.
 */
export const SLUG_MAX_LENGTH = 60;

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Substitutes `{{name}}` placeholders in a template.
 *
 * Placeholders whose name is not in `variables` are left exactly as written, so
 * a template that mentions an unsupported variable degrades to literal text
 * instead of losing it.
 *
 * @param template - Template text containing `{{name}}` placeholders.
 * @param variables - Replacement values, keyed by placeholder name.
 * @returns The rendered text.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

/**
 * Reduces text to a branch-safe slug.
 *
 * Runs of ASCII letters and digits are lowercased and joined with `-`;
 * everything else is a separator. The result is capped at `SLUG_MAX_LENGTH`
 * characters with no trailing separator.
 *
 * @param text - Free text, typically an issue summary.
 * @returns The slug, or an empty string when the text has no usable characters.
 */
export function slug(text: string): string {
  const runs = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const joined = runs.join('-');
  if (joined.length <= SLUG_MAX_LENGTH) return joined;
  return joined.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/**
 * Renders a repo's branch pattern for an issue.
 *
 * The pattern may use `{{key}}` and `{{slug}}`.
 *
 * @param pattern - Branch-name template from the repo config.
 * @param issue - Issue supplying the key and the summary the slug comes from.
 * @returns The branch name.
 */
export function branchName(pattern: string, issue: Issue): string {
  return renderTemplate(pattern, { key: issue.key, slug: slug(issue.summary) });
}

/**
 * Builds a tmux-safe session name.
 *
 * @param prefix - Runner's `tmuxPrefix`, e.g. `qc`.
 * @param issueKey - Key of the issue the session works on.
 * @param playbookId - Id of the playbook that produced the prompt.
 * @param suffix - Discriminator appended when the plain name is already taken.
 * @returns The session name, e.g. `qc-DOC-3847-implement`.
 */
export function sessionName(
  prefix: string,
  issueKey: string,
  playbookId: string,
  suffix?: string | undefined,
): string {
  // tmux treats '.' and ':' as window/pane separators in target names, so every
  // character outside [A-Za-z0-9_-] is folded to a dash.
  const safe = (part: string): string => part.replace(/[^A-Za-z0-9_-]+/g, '-');
  const base = `${safe(prefix)}-${safe(issueKey)}-${safe(playbookId)}`;
  return suffix === undefined || suffix === '' ? base : `${base}-${safe(suffix)}`;
}

/**
 * An editor invocation, ready to hand to a process spawner.
 */
export interface EditorInvocation {
  /** Executable to spawn. */
  command: string;
  /** Arguments with every `{{path}}` already substituted. */
  args: string[];
}

/**
 * Resolves an editor configuration against one checkout path.
 *
 * The path is substituted into the argument list rather than concatenated into
 * a command string, so a path containing spaces needs no quoting.
 *
 * @param editor - Editor configuration from the config file.
 * @param path - Absolute path to open.
 * @returns The command and its arguments.
 */
export function editorCommand(editor: EditorConfig, path: string): EditorInvocation {
  return { command: editor.command, args: editor.args.map((arg) => renderTemplate(arg, { path })) };
}

/**
 * The checkout a prompt is rendered against.
 */
export interface PromptContext {
  /** Branch the session will work on, or null for isolation `shared`. */
  branch: string | null;
  /** Absolute working directory of the session. */
  worktree: string;
}

/**
 * Builds the variable map a prompt template is rendered with.
 *
 * @param issue - Issue the session is for.
 * @param context - Checkout the session will run in.
 * @returns Values for every supported placeholder, never undefined.
 */
export function promptVariables(issue: Issue, context: PromptContext): Record<string, string> {
  return {
    key: issue.key,
    summary: issue.summary,
    type: issue.type,
    status: issue.status,
    labels: issue.labels.join(', '),
    url: issue.url,
    description: issue.description ?? '',
    branch: context.branch ?? '',
    worktree: context.worktree,
  };
}

/**
 * Renders a playbook's prompt template for one issue and checkout.
 *
 * @param playbook - Playbook supplying the template.
 * @param issue - Issue the session is for.
 * @param context - Checkout the session will run in.
 * @returns The prompt text to prefill the start dialog with.
 */
export function renderPrompt(playbook: Playbook, issue: Issue, context: PromptContext): string {
  return renderTemplate(playbook.promptTemplate, promptVariables(issue, context));
}
