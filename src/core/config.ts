import { z } from 'zod';
import type { ConfigIssue, CreateWorkspaceRequest } from './api.js';
import { slug } from './prompt.js';
import {
  COLUMN_IDS,
  EFFORTS,
  PERMISSION_MODE_SETTINGS,
  type Config,
  type Effort,
  type PermissionModeSetting,
  type PlaybookDefaults,
} from './types.js';

export type { ConfigIssue } from './api.js';

/**
 * Status names a workspace lands in the Review column when it names none.
 */
export const DEFAULT_REVIEW_STATUSES = ['Ready for review'];

/**
 * Seconds between issue-list polls when a workspace names no interval.
 */
export const DEFAULT_POLL_SECONDS = 120;

/**
 * Thrown when a configuration document is unreadable or fails validation.
 */
export class ConfigError extends Error {
  /** Every problem found, not just the first. */
  readonly issues: ConfigIssue[];
  /** Whether the document was rejected because an id is already taken. */
  readonly duplicate: boolean;

  /**
   * Builds a configuration error.
   *
   * @param message - Summary line, shown before the issue list.
   * @param issues - Every problem found in the document.
   * @param duplicate - Whether an already-taken id is what caused the refusal.
   */
  constructor(message: string, issues: ConfigIssue[], duplicate = false) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
    this.duplicate = duplicate;
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

const modelChoiceSchema = z.strictObject({
  id: nonEmpty('model id'),
  label: nonEmpty('model label'),
});

const runnerSchema = z.strictObject({
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

const editorSchema = z.strictObject({
  command: nonEmpty('editor.command').default('code'),
  args: z.array(z.string()).default(['{{path}}']),
});

const playbookSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'playbook id must be lowercase letters, digits and dashes'),
  label: nonEmpty('playbook label'),
  description: z.string().default(''),
  isolation: z.enum(['worktree', 'issue-worktree', 'shared']),
  primaryFor: z.array(z.enum(COLUMN_IDS)).default([]),
  defaults: z
    .strictObject({
      model: nonEmpty('defaults.model').optional(),
      effort: z.enum(EFFORTS).optional(),
      permissionMode: z.enum(PERMISSION_MODE_SETTINGS).optional(),
    })
    .optional(),
  promptTemplate: nonEmpty('promptTemplate'),
});

const connectorSchema = z.strictObject({
  type: z.literal('jira'),
  site: nonEmpty('site'),
  emailEnv: nonEmpty('emailEnv'),
  tokenEnv: nonEmpty('tokenEnv'),
});

const workspaceSchema = z.strictObject({
  name: nonEmpty('workspace name'),
  epic: z
    .string()
    .regex(
      /^([A-Za-z][A-Za-z0-9]*-\d+|\d+)$/,
      'epic must be an issue key such as DOC-3807, or a numeric issue id',
    ),
  jql: nonEmpty('jql').optional(),
  connector: nonEmpty('connector'),
  repo: nonEmpty('repo'),
  reviewStatuses: z.array(nonEmpty('review status')).default(DEFAULT_REVIEW_STATUSES),
  pollSeconds: z
    .number()
    .int()
    .min(10, 'pollSeconds must be at least 10')
    .default(DEFAULT_POLL_SECONDS),
});

const idSchema = (label: string): z.ZodString =>
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/, `${label} must be lowercase letters, digits and dashes`);

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
 * Builds the repo schema for one home directory.
 *
 * @param home - Home directory used to expand `~` in `path` and `worktreeDir`.
 * @returns A schema producing a validated repo.
 */
function buildRepoSchema(home: string) {
  return z
    .strictObject({
      path: pathSchema('path', home),
      worktreeDir: pathSchema('worktreeDir', home),
      baseRef: nonEmpty('baseRef').default('origin/main'),
      branchPattern: nonEmpty('branchPattern').default('{{key}}-{{slug}}'),
      bootstrap: z.string().optional(),
      playbooks: z.array(playbookSchema).min(1, 'a repo needs at least one playbook'),
    })
    .check((ctx) => {
      const seen = new Set<string>();
      const claimed = new Map<string, string>();
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
        playbook.primaryFor.forEach((column, position) => {
          const owner = claimed.get(column);
          if (owner === undefined) {
            claimed.set(column, playbook.id);
            return;
          }
          // The projection takes the first claimant, so a second one would be
          // silently unreachable as a card's primary action.
          ctx.issues.push({
            code: 'custom',
            message: `column '${column}' is already the primary action of playbook '${owner}'`,
            path: ['playbooks', index, 'primaryFor', position],
            input: column,
          });
        });
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
    .strictObject({
      $schema: z.string().optional(),
      port: z.number().int().min(1).max(65535).default(4400),
      // prefault, not default: a default is handed back untouched, so the
      // literal '~' would never reach the expansion this schema pipes through.
      dataDir: pathSchema('dataDir', home).prefault('~/.local/share/questionable-choices'),
      editor: editorSchema.prefault({}),
      runner: runnerSchema,
      connectors: z
        .record(idSchema('connector id'), connectorSchema)
        .refine((value) => Object.keys(value).length > 0, 'at least one connector is required'),
      repos: z
        .record(idSchema('repo id'), buildRepoSchema(home))
        .refine((value) => Object.keys(value).length > 0, 'at least one repo is required'),
      workspaces: z
        .record(idSchema('workspace id'), workspaceSchema)
        .refine((value) => Object.keys(value).length > 0, 'at least one workspace is required'),
    })
    .check((ctx) => {
      const { runner, connectors, repos, workspaces } = ctx.value;
      const modelIds = new Set(runner.models.map((model) => model.id));
      if (!modelIds.has(runner.defaultModel)) {
        ctx.issues.push({
          code: 'custom',
          message: `defaultModel '${runner.defaultModel}' is not one of runner.models`,
          path: ['runner', 'defaultModel'],
          input: runner.defaultModel,
        });
      }

      for (const [repoId, repo] of Object.entries(repos)) {
        repo.playbooks.forEach((playbook, index) => {
          const model = playbook.defaults?.model;
          if (model !== undefined && !modelIds.has(model)) {
            ctx.issues.push({
              code: 'custom',
              message: `defaults.model '${model}' is not one of runner.models`,
              path: ['repos', repoId, 'playbooks', index, 'defaults', 'model'],
              input: model,
            });
          }
        });
      }

      for (const [workspaceId, workspace] of Object.entries(workspaces)) {
        if (connectors[workspace.connector] === undefined) {
          ctx.issues.push({
            code: 'custom',
            message: `connector '${workspace.connector}' is not one of connectors`,
            path: ['workspaces', workspaceId, 'connector'],
            input: workspace.connector,
          });
        }
        if (repos[workspace.repo] === undefined) {
          ctx.issues.push({
            code: 'custom',
            message: `repo '${workspace.repo}' is not one of repos`,
            path: ['workspaces', workspaceId, 'repo'],
            input: workspace.repo,
          });
        }
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
  for (const [connectorId, connector] of Object.entries(config.connectors)) {
    for (const name of [connector.emailEnv, connector.tokenEnv]) {
      const value = env[name];
      if (value === undefined || value === '') {
        warnings.push(`connector '${connectorId}': environment variable ${name} is not set`);
      }
    }
  }
  return warnings;
}

/**
 * Renders a validated configuration back into the document the file holds.
 *
 * Path fields are written absolute: `~` is expanded while parsing and is not
 * reversed here, so a rewritten file names the home directory in full.
 *
 * @param config - Validated configuration.
 * @returns A deep copy that `JSON.stringify` turns into the file.
 */
export function serializeConfig(config: Config): Config {
  // The JSON round-trip drops keys whose value is undefined, which is what
  // keeps unset optional fields such as `bootstrap` out of the written file.
  return JSON.parse(JSON.stringify(config)) as Config;
}

/**
 * Picks the id a workspace-creation request asks for.
 *
 * @param request - The request, whose `id` wins when it names one.
 * @returns The requested id, or one slugged from the name.
 */
export function workspaceIdFor(request: CreateWorkspaceRequest): string {
  const id = request.id?.trim() ?? '';
  return id === '' ? slug(request.name) : id;
}

/**
 * Adds the workspace a request describes, and its inline connector when it
 * carries one, to a configuration.
 *
 * @param config - Configuration to extend; left untouched.
 * @param request - Workspace to add, naming exactly one of `connector` and `newConnector`.
 * @returns The configuration with the workspace in it, revalidated.
 * @throws {ConfigError} When the request is incoherent or the result fails
 *   validation; a duplicate id is reported at path `id`.
 */
export function applyWorkspaceChange(config: Config, request: CreateWorkspaceRequest): Config {
  const id = workspaceIdFor(request);
  const issues: ConfigIssue[] = [];
  let duplicate = false;
  if (id === '') {
    issues.push({ path: 'id', message: 'a workspace needs an id, or a name to derive one from' });
  } else if (config.workspaces[id] !== undefined) {
    duplicate = true;
    issues.push({ path: 'id', message: `a workspace with id '${id}' already exists` });
  }
  const named = request.connector !== undefined && request.connector !== '';
  const inline = request.newConnector;
  if (named === (inline !== undefined)) {
    issues.push({
      path: 'connector',
      message: "name exactly one of 'connector' and 'newConnector'",
    });
  }
  if (inline !== undefined && config.connectors[inline.id] !== undefined) {
    duplicate = true;
    issues.push({
      path: 'newConnector.id',
      message: `a connector with id '${inline.id}' already exists`,
    });
  }
  if (issues.length > 0) throw new ConfigError('Invalid workspace request', issues, duplicate);

  const document = serializeConfig(config);
  const connectorId = inline === undefined ? (request.connector ?? '') : inline.id;
  if (inline !== undefined) {
    document.connectors[inline.id] = {
      type: 'jira',
      site: inline.site,
      emailEnv: inline.emailEnv,
      tokenEnv: inline.tokenEnv,
    };
  }
  document.workspaces[id] = {
    name: request.name,
    epic: request.epic,
    ...(request.jql === undefined ? {} : { jql: request.jql }),
    connector: connectorId,
    repo: request.repo,
    // An empty list is what the dialog sends for a cleared field, and `??`
    // would keep it: the workspace would then have no Review lane at all.
    reviewStatuses:
      request.reviewStatuses !== undefined && request.reviewStatuses.length > 0
        ? request.reviewStatuses
        : [...DEFAULT_REVIEW_STATUSES],
    pollSeconds: DEFAULT_POLL_SECONDS,
  };
  try {
    // Paths in the document are already absolute, so no home is needed to
    // re-expand them; passing one would only re-expand a literal '~' twice.
    return parseConfig(document, { home: '' });
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    throw new ConfigError(
      'Invalid workspace request',
      cause.issues.map((issue) => ({
        path: requestPathOf(issue.path, id, inline?.id),
        message: issue.message,
      })),
      cause.duplicate,
    );
  }
}

/**
 * Rewrites a document locator as the field of the request that produced it.
 *
 * The caller validates a whole configuration to check one workspace, so its
 * issues point into `workspaces.<id>`; a dialog can only show an issue it can
 * match to one of its own inputs.
 *
 * @param path - Locator from the revalidated document.
 * @param workspaceId - Id the workspace was written under.
 * @param connectorId - Id of the inline connector, when the request carried one.
 * @returns The locator relative to the request.
 */
function requestPathOf(path: string, workspaceId: string, connectorId: string | undefined): string {
  // An id that is itself invalid produces a locator with no trailing segment
  // (`connectors.Bad-Id`), which the dialog must still match to the field the
  // id was typed into.
  if (path === `workspaces.${workspaceId}`) return 'id';
  const workspacePrefix = `workspaces.${workspaceId}.`;
  if (path.startsWith(workspacePrefix)) return path.slice(workspacePrefix.length);
  if (connectorId !== undefined) {
    if (path === `connectors.${connectorId}`) return 'newConnector.id';
    const connectorPrefix = `connectors.${connectorId}.`;
    if (path.startsWith(connectorPrefix)) {
      return `newConnector.${path.slice(connectorPrefix.length)}`;
    }
  }
  return path;
}

/**
 * Removes one workspace, and with it any connector nothing else references.
 *
 * @param config - Configuration to shrink; left untouched.
 * @param id - Id of the workspace to remove.
 * @returns The configuration without the workspace, revalidated.
 * @throws {ConfigError} When no workspace has that id.
 */
export function removeWorkspace(config: Config, id: string): Config {
  if (config.workspaces[id] === undefined) {
    throw new ConfigError('Invalid workspace request', [
      { path: 'id', message: `no workspace has id '${id}'` },
    ]);
  }
  const document = serializeConfig(config);
  delete document.workspaces[id];
  // A connector created from the add-workspace dialog has no other way out:
  // there is no route and no control that removes one, so a workspace nothing
  // else references takes its connector with it.
  const stillUsed = new Set(
    Object.values(document.workspaces).map((workspace) => workspace.connector),
  );
  for (const connectorId of Object.keys(document.connectors)) {
    if (!stillUsed.has(connectorId)) delete document.connectors[connectorId];
  }
  return parseConfig(document, { home: '' });
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
