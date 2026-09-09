import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  COLUMN_IDS,
  EFFORTS,
  PERMISSION_MODE_SETTINGS,
  type Config,
  type Effort,
  type PermissionModeSetting,
  type PlaybookDefaults,
} from './types.js';

/**
 * One reason a configuration was rejected, with the path that caused it.
 */
export interface ConfigIssue {
  /** Dotted path into the config document, e.g. `boards[0].issues.epic`. */
  path: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * Thrown when a configuration document is unreadable or fails validation.
 */
export class ConfigError extends Error {
  /** Every problem found, not just the first. */
  readonly issues: ConfigIssue[];

  /**
   * Builds a configuration error.
   *
   * @param message - Summary line, shown before the issue list.
   * @param issues - Every problem found in the document.
   */
  constructor(message: string, issues: ConfigIssue[]) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Formats configuration issues as one indented line each.
 *
 * @param issues - Issues to format.
 * @returns The lines joined by newlines; an empty string for no issues.
 */
export function formatConfigIssues(issues: ConfigIssue[]): string {
  return issues.map((issue) => `  ${issue.path || '<root>'}: ${issue.message}`).join('\n');
}

/**
 * Replaces a leading `~` with the given home directory.
 *
 * @param path - Path that may start with `~`.
 * @param home - Absolute home directory to substitute; no substitution when empty.
 * @returns The expanded path, or `path` unchanged when nothing applied.
 */
export function expandHome(path: string, home: string): string {
  if (home === '') return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path;
}

/**
 * Options controlling how a configuration document is interpreted.
 */
export interface ParseConfigOptions {
  /** Home directory used to expand `~`; defaults to `$HOME`. */
  home?: string | undefined;
}

/**
 * Default location of the configuration file, relative to the home directory.
 */
export const DEFAULT_CONFIG_RELATIVE_PATH = '.config/questionable-choices/config.json';

/**
 * Resolves which configuration file to load.
 *
 * @param env - Environment to read `QC_CONFIG` from.
 * @param home - Home directory used for the default location.
 * @returns The absolute path of the configuration file.
 */
export function resolveConfigPath(env: Record<string, string | undefined>, home: string): string {
  const override = env['QC_CONFIG'];
  if (override !== undefined && override !== '') return expandHome(override, home);
  return `${home}/${DEFAULT_CONFIG_RELATIVE_PATH}`;
}

const nonEmpty = (label: string): z.ZodString => z.string().min(1, `${label} must not be empty`);

const modelChoiceSchema = z.object({
  id: nonEmpty('model id'),
  label: nonEmpty('model label'),
});

const runnerSchema = z.object({
  type: z.literal('claude-tmux'),
  claudeBin: nonEmpty('claudeBin').default('claude'),
  tmuxPrefix: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'tmuxPrefix may only contain letters, digits, - and _')
    .default('qc'),
  models: z.array(modelChoiceSchema).min(1, 'at least one model must be offered'),
  defaultModel: nonEmpty('defaultModel'),
  defaultEffort: z.enum(EFFORTS).default('medium'),
  defaultPermissionMode: z.enum(PERMISSION_MODE_SETTINGS).default('default'),
});

const editorSchema = z.object({
  command: nonEmpty('editor.command').default('code'),
  args: z.array(z.string()).default(['{{path}}']),
});

const playbookSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'playbook id must be lowercase letters, digits and dashes'),
  label: nonEmpty('playbook label'),
  description: z.string().default(''),
  isolation: z.enum(['worktree', 'issue-worktree', 'shared']),
  primaryFor: z.array(z.enum(COLUMN_IDS)).default([]),
  defaults: z
    .object({
      model: nonEmpty('defaults.model').optional(),
      effort: z.enum(EFFORTS).optional(),
      permissionMode: z.enum(PERMISSION_MODE_SETTINGS).optional(),
    })
    .optional(),
  promptTemplate: nonEmpty('promptTemplate'),
});

const jiraIssueSourceSchema = z
  .object({
    type: z.literal('jira'),
    site: nonEmpty('site'),
    emailEnv: nonEmpty('emailEnv'),
    tokenEnv: nonEmpty('tokenEnv'),
    epic: nonEmpty('epic').optional(),
    jql: nonEmpty('jql').optional(),
    reviewStatuses: z.array(nonEmpty('review status')).default([]),
    pollSeconds: z.number().int().min(10, 'pollSeconds must be at least 10').default(120),
  })
  .check((ctx) => {
    if (ctx.value.epic === undefined && ctx.value.jql === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: "a jira source needs either 'epic' or 'jql'",
        path: ['epic'],
        input: ctx.value,
      });
    }
  });

/**
 * Builds a string schema that expands `~` into the given home directory.
 *
 * @param label - Field name used in the "must not be empty" message.
 * @param home - Home directory to substitute.
 * @returns A schema producing the expanded path.
 */
function pathSchema(label: string, home: string): z.ZodType<string, unknown> {
  return nonEmpty(label).transform((value) => expandHome(value, home));
}

/**
 * Builds the workspace schema for one home directory.
 *
 * @param home - Home directory used to expand `~` in `repo` and `worktreeDir`.
 * @returns A schema producing a validated workspace.
 */
function buildWorkspaceSchema(home: string) {
  return z
    .object({
      name: nonEmpty('workspace name'),
      issues: z.discriminatedUnion('type', [jiraIssueSourceSchema]),
      repo: pathSchema('repo', home),
      worktreeDir: pathSchema('worktreeDir', home),
      baseRef: nonEmpty('baseRef').default('origin/main'),
      branchPattern: nonEmpty('branchPattern').default('{{key}}-{{slug}}'),
      bootstrap: z.string().optional(),
      playbooks: z.array(playbookSchema).min(1, 'a workspace needs at least one playbook'),
    })
    .check((ctx) => {
      const seen = new Set<string>();
      ctx.value.playbooks.forEach((playbook, index) => {
        if (seen.has(playbook.id)) {
          ctx.issues.push({
            code: 'custom',
            message: `duplicate playbook id '${playbook.id}'`,
            path: ['playbooks', index, 'id'],
            input: playbook.id,
          });
        }
        seen.add(playbook.id);
      });
    });
}

/**
 * Builds the configuration schema for one home directory.
 *
 * The home directory is baked into the schema because `~` expansion happens
 * during parsing, so the parsed config carries only absolute paths.
 *
 * @param home - Home directory used to expand `~` in path fields.
 * @returns A zod schema producing a validated configuration.
 */
function buildConfigSchema(home: string) {
  return z
    .object({
      $schema: z.string().optional(),
      port: z.number().int().min(1).max(65535).default(4400),
      // prefault, not default: a default is handed back untouched, so the
      // literal '~' would never reach the expansion this schema pipes through.
      dataDir: pathSchema('dataDir', home).prefault('~/.local/share/questionable-choices'),
      editor: editorSchema.prefault({}),
      runner: runnerSchema,
      workspaces: z
        .record(
          z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace id must be lowercase'),
          buildWorkspaceSchema(home),
        )
        .refine((value) => Object.keys(value).length > 0, 'at least one workspace is required'),
    })
    .check((ctx) => {
      const { runner, workspaces } = ctx.value;
      const modelIds = new Set(runner.models.map((model) => model.id));
      if (!modelIds.has(runner.defaultModel)) {
        ctx.issues.push({
          code: 'custom',
          message: `defaultModel '${runner.defaultModel}' is not one of runner.models`,
          path: ['runner', 'defaultModel'],
          input: runner.defaultModel,
        });
      }

      for (const [workspaceId, workspace] of Object.entries(workspaces)) {
        workspace.playbooks.forEach((playbook, index) => {
          const model = playbook.defaults?.model;
          if (model !== undefined && !modelIds.has(model)) {
            ctx.issues.push({
              code: 'custom',
              message: `defaults.model '${model}' is not one of runner.models`,
              path: ['workspaces', workspaceId, 'playbooks', index, 'defaults', 'model'],
              input: model,
            });
          }
        });
      }
    });
}

/**
 * Renders a zod issue path as a dotted/bracketed locator.
 *
 * @param path - Path segments from a zod issue.
 * @returns A locator such as `boards[0].issues.epic`.
 */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/**
 * Validates a configuration document that is already parsed into objects.
 *
 * Path fields (`dataDir`, `repo`, `worktreeDir`) come back with `~` expanded
 * and defaults filled in.
 *
 * @param input - The parsed JSON document.
 * @param options - Parsing options; `home` controls `~` expansion.
 * @returns The validated configuration.
 * @throws {ConfigError} When the document fails validation, carrying every issue.
 */
export function parseConfig(input: unknown, options: ParseConfigOptions = {}): Config {
  const home = options.home ?? process.env['HOME'] ?? '';
  const result = buildConfigSchema(home).safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    }));
    throw new ConfigError('Invalid configuration', issues);
  }
  return result.data;
}

/**
 * Reads and validates a configuration file.
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

/**
 * Reports credentials the configuration names but the environment does not set.
 *
 * Missing credentials are a warning rather than a failure so the dashboard can
 * boot and show the banner instead of refusing to start.
 *
 * @param config - Validated configuration.
 * @param env - Environment to look the named variables up in.
 * @returns One warning line per missing variable; empty when all are set.
 */
export function checkEnvironment(
  config: Config,
  env: Record<string, string | undefined>,
): string[] {
  const warnings: string[] = [];
  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    for (const name of [workspace.issues.emailEnv, workspace.issues.tokenEnv]) {
      const value = env[name];
      if (value === undefined || value === '') {
        warnings.push(`workspace '${workspaceId}': environment variable ${name} is not set`);
      }
    }
  }
  return warnings;
}

/**
 * The model, effort and permission mode a start dialog preselects.
 */
export interface StartDefaults {
  /** Model id passed to `claude --model`. */
  model: string;
  /** Reasoning effort passed to `claude --effort`. */
  effort: Effort;
  /** Permission mode, or `'default'` meaning "pass no flag". */
  permissionMode: PermissionModeSetting;
}

/**
 * Resolves the effective start defaults for one playbook.
 *
 * @param config - Validated configuration supplying the runner defaults.
 * @param playbookDefaults - The playbook's own overrides, when it has any.
 * @returns The values the start dialog preselects.
 */
export function startDefaults(
  config: Config,
  playbookDefaults?: PlaybookDefaults | undefined,
): StartDefaults {
  return {
    model: playbookDefaults?.model ?? config.runner.defaultModel,
    effort: playbookDefaults?.effort ?? config.runner.defaultEffort,
    permissionMode: playbookDefaults?.permissionMode ?? config.runner.defaultPermissionMode,
  };
}
