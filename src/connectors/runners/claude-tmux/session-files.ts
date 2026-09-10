import { LAUNCHER_INGRESS, STATUSLINE_INGRESS } from '../../../core/api.js';
import type { LauncherStartBody } from '../../../core/api.js';
import { HOOK_EVENT_NAMES } from '../../../core/state-machine.js';
import type { Effort, PermissionModeSetting } from '../../../core/types.js';

/**
 * Seconds Claude Code waits for one generated hook command.
 */
export const HOOK_TIMEOUT_SECONDS = 5;

/**
 * Notification types the generated settings file subscribes to.
 */
export const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog';

/**
 * Ingress path segment the status-line payload is posted to.
 */
export const STATUSLINE_EVENT = STATUSLINE_INGRESS;

/**
 * Wraps a value so a shell reads it as one literal argument.
 *
 * @param value - Text to quote.
 * @returns The single-quoted value, with embedded quotes escaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds the ingress URL a hook posts its payload to.
 *
 * @param port - Port the dashboard listens on.
 * @param sessionId - Id of the session the hook belongs to.
 * @param event - Hook name, or `statusline`.
 * @returns The loopback URL.
 */
export function hookUrl(port: number, sessionId: string, event: string): string {
  return `http://127.0.0.1:${port}/api/hooks/${sessionId}/${event}`;
}

/**
 * Builds the ingress URL the generated launcher posts its signals to.
 *
 * @param port - Port the dashboard listens on.
 * @param sessionId - Id of the session the launcher runs.
 * @param event - Launcher signal, e.g. `claude-start`.
 * @returns The loopback URL.
 */
export function launcherUrl(port: number, sessionId: string, event: string): string {
  return `${hookUrl(port, sessionId, LAUNCHER_INGRESS)}/${event}`;
}

/**
 * Builds the shell command one hook runs.
 *
 * The command always exits zero: a dashboard that is down must never block the
 * session it is watching.
 *
 * @param port - Port the dashboard listens on.
 * @param sessionId - Id of the session the hook belongs to.
 * @param event - Hook name to post under.
 * @returns The command string for the settings file.
 */
export function hookCommand(port: number, sessionId: string, event: string): string {
  const url = hookUrl(port, sessionId, event);
  return `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- ${shellQuote(url)} >/dev/null 2>&1 || true`;
}

/**
 * One `type: command` hook entry in a settings file.
 */
export interface GeneratedHookCommand {
  /** Hook kind; always `command` here. */
  type: 'command';
  /** Shell command Claude Code runs. */
  command: string;
  /** Seconds Claude Code waits for it. */
  timeout: number;
}

/**
 * One matcher group in a settings file's hook array.
 */
export interface GeneratedHookEntry {
  /** Event filter, present only where the hook needs one. */
  matcher?: string;
  /** Commands this group runs. */
  hooks: GeneratedHookCommand[];
}

/**
 * The settings file the runner passes to `claude --settings`.
 */
export interface GeneratedSettings {
  /** Hook groups, keyed by hook name. */
  hooks: Record<string, GeneratedHookEntry[]>;
  /** Status-line override pointing at the generated script. */
  statusLine: { type: 'command'; command: string; refreshInterval: number };
}

/**
 * What the generated settings file needs to know.
 */
export interface SettingsContext {
  /** Id of the session the file belongs to. */
  sessionId: string;
  /** Port the dashboard listens on. */
  port: number;
  /** Absolute directory holding the session's generated files. */
  dir: string;
}

/**
 * Builds the settings object passed to `claude --settings`.
 *
 * @param context - Session id, dashboard port and generated-file directory.
 * @returns The settings object, ready to serialise.
 */
export function buildSettings(context: SettingsContext): GeneratedSettings {
  const hooks: Record<string, GeneratedHookEntry[]> = {};
  for (const event of HOOK_EVENT_NAMES) {
    const command: GeneratedHookCommand = {
      type: 'command',
      command: hookCommand(context.port, context.sessionId, event),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
    hooks[event] =
      event === 'Notification'
        ? [{ matcher: NOTIFICATION_MATCHER, hooks: [command] }]
        : [{ hooks: [command] }];
  }
  return {
    hooks,
    statusLine: {
      type: 'command',
      // Claude Code runs this through a shell, so a data directory holding a
      // space would otherwise split into a command and its arguments.
      command: `bash ${shellQuote(`${context.dir}/statusline.sh`)}`,
      refreshInterval: 1,
    },
  };
}

/**
 * Renders the settings file passed to `claude --settings`.
 *
 * @param context - Session id, dashboard port and generated-file directory.
 * @returns The JSON document, newline-terminated.
 */
export function buildSettingsFile(context: SettingsContext): string {
  return `${JSON.stringify(buildSettings(context), null, 2)}\n`;
}

/**
 * What the generated status-line script needs to know.
 */
export interface StatuslineContext {
  /** Id of the session the script belongs to. */
  sessionId: string;
  /** Port the dashboard listens on. */
  port: number;
  /**
   * The owner's own status-line command, as it was read when the runner was
   * built, or null when they have none and the TUI should show nothing.
   */
  chainedCommand: string | null;
}

const GENERATED_HEADER = '# Generated by questionable-choices. Overwritten on every start.';

/**
 * Renders the status-line script the settings file points at.
 *
 * `statusLine` is a scalar setting, so the generated override replaces the
 * owner's instead of merging with it; the script re-invokes theirs to put it back.
 *
 * @param context - Session id, dashboard port and the command to chain into.
 * @returns The script text, newline-terminated.
 */
export function buildStatuslineScript(context: StatuslineContext): string {
  const url = hookUrl(context.port, context.sessionId, STATUSLINE_EVENT);
  const lines = [
    '#!/usr/bin/env bash',
    GENERATED_HEADER,
    '',
    'payload=$(cat)',
    // The background POST must not inherit stdout: Claude Code reads the
    // status line until every writer closes it, so a leaked fd stalls the draw.
    `printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- ${shellQuote(url)} >/dev/null 2>&1 &`,
  ];
  if (context.chainedCommand !== null) {
    lines.push('', `printf '%s' "$payload" | ${context.chainedCommand}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * What the generated launcher script needs to know.
 */
export interface RunScriptContext {
  /** Id of the session the launcher runs. */
  sessionId: string;
  /** Port the dashboard listens on. */
  port: number;
  /** Absolute directory holding the session's generated files. */
  dir: string;
  /** Executable name or path of the Claude CLI. */
  claudeBin: string;
  /** Issue key, passed to `claude --name`. */
  issueKey: string;
  /** Model id passed to `claude --model`. */
  model: string;
  /** Reasoning effort passed to `claude --effort`. */
  effort: Effort;
  /** Permission mode; `default` means no flag is passed. */
  permissionMode: PermissionModeSetting;
  /** Whether the bootstrap command should run before `claude`. */
  needsBootstrap: boolean;
  /** Shell command to run as the bootstrap, or null when there is none. */
  bootstrap: string | null;
  /** Claude session id to resume, or null to send the prompt instead. */
  resumeSessionId: string | null;
}

/**
 * Flag that really bypasses every permission prompt.
 *
 * `--permission-mode bypassPermissions` is accepted but still stops on the
 * prompts an unattended session has nobody to answer.
 */
export const BYPASS_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Builds the argument list `claude` is launched with, without the prompt.
 *
 * @param context - Everything the launcher knows about the session.
 * @returns The arguments in launch order.
 */
export function claudeArgv(context: RunScriptContext): string[] {
  const argv = [
    '--settings',
    `${context.dir}/settings.json`,
    '--name',
    context.issueKey,
    '--model',
    context.model,
    '--effort',
    context.effort,
  ];
  if (context.permissionMode === 'bypassPermissions') {
    argv.push(BYPASS_PERMISSIONS_FLAG);
  } else if (context.permissionMode !== 'default') {
    argv.push('--permission-mode', context.permissionMode);
  }
  if (context.resumeSessionId !== null) {
    argv.push('--resume', context.resumeSessionId);
  }
  return argv;
}

/**
 * Builds the shell line that launches `claude`.
 *
 * A resumed session takes `--resume` instead of a prompt; a fresh one reads
 * the prompt out of `prompt.txt` so no quoting of the prompt is needed.
 *
 * @param context - Everything the launcher knows about the session.
 * @returns The command line for the generated script.
 */
export function claudeCommandLine(context: RunScriptContext): string {
  const parts = [context.claudeBin, ...claudeArgv(context)].map(shellQuote);
  if (context.resumeSessionId === null) {
    parts.push(`"$(cat ${shellQuote(`${context.dir}/prompt.txt`)})"`);
  }
  return parts.join(' ');
}

/**
 * Lines of bootstrap output the failure signal carries back.
 *
 * The exit code alone says nothing the card's own state pill does not; the tail
 * of the output is what names the missing dependency or the bad reference.
 */
export const BOOTSTRAP_TAIL_LINES = 20;

/**
 * Name of the file the bootstrap's combined output is captured to, inside the
 * session directory.
 */
export const BOOTSTRAP_LOG_FILE = 'bootstrap.log';

/**
 * Shell pipeline turning text on stdin into the body of one JSON string.
 *
 * Tabs become spaces and every other control character is dropped, because a
 * raw one inside a JSON string makes the whole hook body unparseable and the
 * server would answer 400 instead of showing the owner why their bootstrap
 * failed. The result carries no surrounding quotes.
 */
const JSON_STRING_BODY = [
  "LC_ALL=C tr '\\011' ' '",
  "LC_ALL=C tr -d '\\000-\\010\\013\\014\\016-\\037\\177'",
  `sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'`,
  `awk '{printf "%s\\\\n", $0}'`,
].join(' | ');

/**
 * Renders the launcher script tmux runs in the session's window.
 *
 * @param context - Everything the launcher knows about the session.
 * @returns The script text, newline-terminated.
 */
export function buildRunScript(context: RunScriptContext): string {
  const url = launcherUrl(context.port, context.sessionId, '$1');
  const lines = [
    '#!/usr/bin/env bash',
    GENERATED_HEADER,
    'set -u',
    '',
    'post() {',
    `  curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary "$2" "${url}" >/dev/null 2>&1 || true`,
    '}',
  ];

  if (context.needsBootstrap && context.bootstrap !== null && context.bootstrap !== '') {
    // Only a run that really bootstraps announces it: the state it opens is
    // also what the reconciler reads as "died before it ever launched".
    lines.push(
      '',
      "post bootstrap-start '{}'",
      '',
      `qc_bootstrap_log=${shellQuote(`${context.dir}/${BOOTSTRAP_LOG_FILE}`)}`,
      // Piped through tee, not redirected: the owner watching the tmux window
      // must still see the bootstrap run, and the dashboard needs a copy. The
      // cost is that the bootstrap's stdout is a pipe rather than the tmux tty,
      // so anything that probes `isatty(1)` — progress bars, colour, a
      // credential prompt, a pager — behaves as it would under a redirect.
      `{ ${context.bootstrap}; } 2>&1 | tee "$qc_bootstrap_log"`,
      'status=${PIPESTATUS[0]}',
      'if [ "$status" -ne 0 ]; then',
      `  qc_message=$(tail -n ${BOOTSTRAP_TAIL_LINES} "$qc_bootstrap_log" 2>/dev/null | ${JSON_STRING_BODY})`,
      '  post bootstrap-failed "{\\"exitCode\\":$status,\\"message\\":\\"$qc_message\\"}"',
      '  exec bash',
      'fi',
      // Nothing prunes <dataDir>/sessions/, so a bootstrap that worked would
      // otherwise leave a full transcript of it there for the life of the data
      // directory. Only a failure has anything to say.
      'rm -f "$qc_bootstrap_log"',
    );
  }

  // The server counts a run per launch and needs to know whether this one
  // continues the previous transcript; no hook reports that.
  const startBody: LauncherStartBody = context.resumeSessionId === null ? {} : { mode: 'resume' };
  lines.push(
    '',
    `post claude-start '${JSON.stringify(startBody)}'`,
    '',
    claudeCommandLine(context),
    'status=$?',
    '',
    'post claude-exit "{\\"exitCode\\":$status}"',
    '',
    'exec bash',
  );
  return `${lines.join('\n')}\n`;
}
