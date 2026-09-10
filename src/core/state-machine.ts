import { LIVE_STATES, NEEDS_YOU_STATES } from './api.js';
import {
  CACHE_TTL_5M_SECONDS,
  cacheChanged,
  cacheDerived,
  cacheFromStatusline,
  modelFromStatusline,
} from './cache-clock.js';
import type { StatuslinePayload } from './cache-clock.js';
import type { SessionRecord, SessionRun, SessionState } from './types.js';

/**
 * Reports whether a state counts as live.
 *
 * @param state - State to test.
 * @returns True for every state except `exited` and `failed`.
 */
export function isLive(state: SessionState): boolean {
  return LIVE_STATES.has(state);
}

/**
 * Reports whether a state means the session is waiting for the owner.
 *
 * @param state - State to test.
 * @returns True for `waiting-permission`, `waiting-question` and `idle`.
 */
export function needsYou(state: SessionState): boolean {
  return NEEDS_YOU_STATES.has(state);
}

/**
 * Fields every Claude Code hook payload carries.
 *
 * `permission_mode` is absent from SessionStart, Notification and SessionEnd,
 * so the session record is the only reliable source for it.
 */
export interface HookEventBase {
  /** Claude Code's own session id. */
  session_id?: string | undefined;
  /** Absolute path of the session transcript. */
  transcript_path?: string | undefined;
  /** Working directory of the Claude process. */
  cwd?: string | undefined;
  /** Scratchpad directory of the session. */
  scratchpad_dir?: string | undefined;
  /** Id of the prompt the event belongs to; absent on SessionStart. */
  prompt_id?: string | undefined;
  /** Permission mode the session is currently in, when the payload carries it. */
  permission_mode?: string | undefined;
}

/**
 * Payload of the `SessionStart` hook.
 */
export interface SessionStartHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'SessionStart';
  /** Why the session started, e.g. `startup`, `resume`, `clear`. */
  source?: string | undefined;
  /**
   * The model the session runs on: a bare id on the hook payload, an object on
   * the status-line payload.
   */
  model?: string | { id?: string | undefined; display_name?: string | undefined } | undefined;
}

/**
 * Payload of the `UserPromptSubmit` hook.
 */
export interface UserPromptSubmitHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'UserPromptSubmit';
  /** The prompt the owner submitted. */
  prompt?: string | undefined;
}

/**
 * Payload of the `PreToolUse` hook.
 */
export interface PreToolUseHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PreToolUse';
  /** Name of the tool about to run, e.g. `Bash` or `AskUserQuestion`. */
  tool_name: string;
  /**
   * The tool's arguments, shaped by the tool. User-level hooks may rewrite
   * these between PreToolUse and the tool's later events, so a summary taken
   * here can disagree with one taken from PermissionRequest or PostToolUse.
   */
  tool_input?: unknown;
  /** Id correlating this call's Pre/Post events. */
  tool_use_id?: string | undefined;
}

/**
 * Payload of the `PostToolUse` hook.
 */
export interface PostToolUseHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PostToolUse';
  /** Name of the tool that ran. */
  tool_name: string;
  /** The tool's arguments, shaped by the tool. */
  tool_input?: unknown;
  /** The tool's result, shaped by the tool. */
  tool_response?: unknown;
  /** Id correlating this call's Pre/Post events. */
  tool_use_id?: string | undefined;
  /** How long the tool ran, in milliseconds. */
  duration_ms?: number | undefined;
}

/**
 * Payload of the `PostToolUseFailure` hook.
 */
export interface PostToolUseFailureHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PostToolUseFailure';
  /** Name of the tool that failed. */
  tool_name: string;
  /** The tool's arguments, shaped by the tool. */
  tool_input?: unknown;
  /** Failure text, when the payload carries one. */
  error?: string | undefined;
}

/**
 * Payload of the `PermissionRequest` hook.
 */
export interface PermissionRequestHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PermissionRequest';
  /** Name of the tool asking for permission; `AskUserQuestion` means a question. */
  tool_name: string;
  /** The tool's arguments, shaped by the tool. */
  tool_input?: unknown;
  /** The "don't ask again" options the dialog offers. */
  permission_suggestions?: unknown;
}

/**
 * Payload of the `PermissionDenied` hook.
 */
export interface PermissionDeniedHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PermissionDenied';
  /** Name of the tool that was denied, when the payload carries one. */
  tool_name?: string | undefined;
  /** The tool's arguments, shaped by the tool. */
  tool_input?: unknown;
}

/**
 * Payload of the `Notification` hook.
 */
export interface NotificationHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'Notification';
  /**
   * Which notification fired. A question raises `permission_prompt` too, so
   * this never decides question versus permission on its own.
   */
  notification_type?: string | undefined;
  /** Text Claude Code would have shown, e.g. "Claude needs your permission". */
  message?: string | undefined;
}

/**
 * Payload of the `Stop` hook, which fires after every assistant turn.
 */
export interface StopHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'Stop';
  /** The assistant's final message, in full. */
  last_assistant_message?: string | undefined;
  /** Whether the stop hook is already running for this turn. */
  stop_hook_active?: boolean | undefined;
}

/**
 * Payload of the `PreCompact` hook, which fires as a compaction is asked for.
 *
 * It is the "started" edge and not a promise that anything will be compacted: a
 * context too small to compact raises it and then refuses on screen, with no
 * further hook at all.
 */
export interface PreCompactHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PreCompact';
  /** `manual` for a typed `/compact`, `auto` for one Claude Code started itself. */
  trigger?: string | undefined;
  /** Extra instructions the `/compact` argument carried, when it had any. */
  custom_instructions?: string | null | undefined;
}

/**
 * Payload of the `PostCompact` hook, which fires once the new context exists.
 */
export interface PostCompactHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'PostCompact';
  /** `manual` for a typed `/compact`, `auto` for one Claude Code started itself. */
  trigger?: string | undefined;
  /** The summary the compaction produced, in full. */
  compact_summary?: string | undefined;
}

/**
 * Payload of the `SessionEnd` hook.
 */
export interface SessionEndHookEvent extends HookEventBase {
  /** Hook discriminator. */
  hook_event_name: 'SessionEnd';
  /** Why the session ended, when the payload carries a reason. */
  reason?: string | undefined;
}

/**
 * Any hook payload the dashboard subscribes to.
 */
export type HookEvent =
  | SessionStartHookEvent
  | UserPromptSubmitHookEvent
  | PreToolUseHookEvent
  | PostToolUseHookEvent
  | PostToolUseFailureHookEvent
  | PermissionRequestHookEvent
  | PermissionDeniedHookEvent
  | NotificationHookEvent
  | StopHookEvent
  | PreCompactHookEvent
  | PostCompactHookEvent
  | SessionEndHookEvent;

/**
 * Value `PreCompact` and `PostCompact` carry for a compaction the owner typed,
 * as opposed to one Claude Code started for itself.
 */
export const MANUAL_COMPACT_TRIGGER = 'manual';

/**
 * Value `SessionStart.source` carries on the session that a compaction
 * produced. It arrives ~20 ms before `PostCompact` and says the same thing, so
 * whichever comes first is the end of the compaction.
 */
export const COMPACT_SESSION_SOURCE = 'compact';

/**
 * Hook names the generated settings file subscribes to.
 */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;

/**
 * One subscribed hook name.
 */
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Reports whether a string names a hook the dashboard subscribes to.
 *
 * @param name - Candidate hook name, typically from the ingress URL.
 * @returns True when the name is one of `HOOK_EVENT_NAMES`.
 */
export function isHookEventName(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * Tags a raw hook body with the hook name from the ingress URL.
 *
 * Only the name is checked; the body is asserted, not parsed. The payload's
 * shape is the CLI's and moves between its releases, and every field the
 * reducer reads is narrowed where it is read, so a schema here would be a
 * second thing to keep in step for no guarantee the use sites do not give.
 * See spec §8.2.
 *
 * @param name - Hook name taken from the ingress URL.
 * @param body - The hook's stdin JSON, already parsed.
 * @returns The typed hook event, or null when the name is not subscribed to.
 */
export function asHookEvent(name: string, body: Record<string, unknown>): HookEvent | null {
  if (!isHookEventName(name)) return null;
  // The name from the URL wins over any `hook_event_name` in the body: the URL
  // is what the generated settings file controls, the body is not.
  return { ...body, hook_event_name: name } as HookEvent;
}

/**
 * Every input the session state machine accepts.
 */
export type SessionEvent =
  | { type: 'bootstrap-start' }
  | { type: 'bootstrap-failed'; exitCode?: number | undefined; message?: string | undefined }
  | { type: 'claude-start'; mode: 'start' | 'resume' }
  | { type: 'claude-exit'; exitCode: number | null }
  | { type: 'interrupt' }
  | { type: 'statusline'; payload: StatuslinePayload }
  | { type: 'hook'; hook: HookEvent };

/**
 * Options that tune how events are reduced.
 */
export interface ReduceOptions {
  /**
   * TTL in seconds used for the derived cache fallback on `Stop`. Pass 3600
   * when the owner's settings enable the one-hour prompt cache.
   */
  derivedCacheTtlSeconds?: number | undefined;
}

/**
 * The outcome of reducing one event into a session record.
 */
export interface ReduceResult {
  /** The record after the event; the same object when nothing changed. */
  record: SessionRecord;
  /** Whether the record changed and should be persisted and broadcast. */
  changed: boolean;
  /** Whether the owner should be notified, i.e. the session now wants them. */
  notify: boolean;
}

/**
 * Longest pending summary kept on a record, in characters.
 */
const SUMMARY_MAX_LENGTH = 140;

/**
 * Longest assistant-message snippet kept on a record, in characters.
 */
export const SNIPPET_MAX_LENGTH = 280;

/**
 * Collapses whitespace and truncates text to one line.
 *
 * @param text - Text to condense.
 * @param max - Maximum length of the result, including the ellipsis.
 * @returns A single line of at most `max` characters.
 */
function oneLine(text: string, max: number = SUMMARY_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

const DIGEST_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt'];

/**
 * Condenses a tool's arguments into one readable line.
 *
 * @param input - The hook payload's `tool_input`, shaped by the tool.
 * @returns A one-line digest, or an empty string when there is nothing to show.
 */
function digestToolInput(input: unknown): string {
  if (typeof input === 'string') return oneLine(input);
  if (input === null || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of DIGEST_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return oneLine(value);
  }
  return oneLine(JSON.stringify(input));
}

/**
 * Tool name Claude Code uses to ask the owner a question.
 */
const QUESTION_TOOL = 'AskUserQuestion';

/**
 * Extracts the question text from an `AskUserQuestion` tool input.
 *
 * @param input - The hook payload's `tool_input` for `AskUserQuestion`.
 * @returns The question as one line, falling back to a generic label.
 */
function questionSummary(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const questions = record['questions'];
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0] as Record<string, unknown> | undefined;
      for (const key of ['question', 'header']) {
        const value = first?.[key];
        if (typeof value === 'string' && value !== '') return oneLine(value);
      }
    }
    const single = record['question'];
    if (typeof single === 'string' && single !== '') return oneLine(single);
  }
  const digest = digestToolInput(input);
  return digest === '' ? 'Claude asked you a question' : digest;
}

/**
 * Fields an event may write. `stateSince` is managed by `reduce` itself.
 */
type SessionPatch = Partial<
  Pick<
    SessionRecord,
    | 'state'
    | 'pending'
    | 'claudeSessionId'
    | 'hint'
    | 'lastAssistantMessage'
    | 'lastExitCode'
    | 'staleSince'
    | 'cache'
    | 'currentModel'
    | 'compacting'
    | 'endedAt'
    | 'runs'
  >
>;

/**
 * Records an exit code on the newest run.
 *
 * @param runs - Existing runs, oldest first.
 * @param exitCode - Exit code to record, or null when it is unknown.
 * @returns A new array, or the original when there is no run to close.
 */
function closeLastRun(runs: SessionRun[], exitCode: number | null): SessionRun[] {
  if (runs.length === 0) return runs;
  const last = runs[runs.length - 1] as SessionRun;
  if (last.exitCode !== null) return runs;
  return [...runs.slice(0, -1), { ...last, exitCode }];
}

/**
 * Serialises a value with object keys sorted and `undefined` members dropped.
 *
 * Two records that differ only in key order or in a field explicitly set to
 * `undefined` produce the same string, so a comparison of the two is a test of
 * content rather than of construction order.
 *
 * @param value - Value to serialise.
 * @returns The JSON text.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return member;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(member as Record<string, unknown>).sort()) {
      const entry = (member as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = entry;
    }
    return sorted;
  });
}

/**
 * Applies one event to a session record.
 *
 * Unknown or out-of-order events leave the record untouched and report
 * `changed: false`, so the caller can log them and move on.
 *
 * @param record - The session record before the event.
 * @param event - The event to apply.
 * @param nowMs - Current time in epoch milliseconds; stamps `stateSince`.
 * @param options - Tuning knobs, currently only the derived cache TTL.
 * @returns The record after the event plus the change and notify flags.
 */
export function reduce(
  record: SessionRecord,
  event: SessionEvent,
  nowMs: number,
  options: ReduceOptions = {},
): ReduceResult {
  const now = new Date(nowMs).toISOString();
  const unchanged: ReduceResult = { record, changed: false, notify: false };

  // A status-line payload is a once-a-second poll that carries no lifecycle
  // information, so it neither proves the record is being told about its
  // session nor clears the marker that says the state may be out of date.
  const lifecycle = event.type !== 'statusline';

  const apply = (patch: SessionPatch, notifiable = true): ReduceResult => {
    const next: SessionRecord = {
      ...record,
      ...(lifecycle ? { staleSince: null, hint: null, lastEventAt: now } : {}),
      ...patch,
    };
    const stateChanged = next.state !== record.state;
    if (stateChanged) next.stateSince = now;
    // `lastEventAt` is stamped above, before this comparison: every lifecycle
    // event the reducer accepts is proof the session is being heard from, and
    // one that happens to leave every other field alone is proof too.
    if (stableJson(next) === stableJson(record)) return unchanged;
    const entered =
      stateChanged &&
      needsYou(next.state) &&
      (!needsYou(record.state) || (record.state === 'idle' && next.state !== 'idle'));
    return { record: next, changed: true, notify: notifiable && entered };
  };

  const live = isLive(record.state);
  const permission = (summary: string): SessionPatch => ({
    state: 'waiting-permission',
    pending: { kind: 'permission', summary },
  });
  const question = (summary: string): SessionPatch => ({
    state: 'waiting-question',
    pending: { kind: 'question', summary },
  });
  const busy: SessionPatch = { state: 'working', pending: null };

  switch (event.type) {
    case 'bootstrap-start':
      return apply({
        state: 'bootstrapping',
        pending: null,
        lastExitCode: null,
        endedAt: null,
      });

    case 'bootstrap-failed':
      if (record.state !== 'bootstrapping') return unchanged;
      // The exit code is the only reason a failed card can give for its state;
      // without it the owner has to attach to tmux to learn anything.
      return apply({ state: 'failed', pending: null, lastExitCode: event.exitCode ?? null });

    case 'claude-start':
      if (!['bootstrapping', 'starting', 'exited', 'failed'].includes(record.state)) {
        return unchanged;
      }
      return apply({
        state: 'starting',
        pending: null,
        // The snippet belongs to the run that has just ended; carried into the
        // new one it would be presented as what this session is waiting on.
        lastAssistantMessage: null,
        lastExitCode: null,
        endedAt: null,
        runs: [...record.runs, { startedAt: now, kind: event.mode, exitCode: null }],
      });

    case 'claude-exit':
      return apply({
        state: 'exited',
        pending: null,
        lastExitCode: event.exitCode,
        endedAt: now,
        runs: closeLastRun(record.runs, event.exitCode),
      });

    case 'interrupt':
      if (!['working', 'waiting-permission', 'waiting-question'].includes(record.state)) {
        return unchanged;
      }
      // The owner pressed the button; telling them their turn has come back
      // would be a notification about their own keystroke.
      return apply({ state: 'idle', pending: null, lastAssistantMessage: null }, false);

    case 'statusline': {
      const patch: SessionPatch = {};
      const cache = cacheFromStatusline(event.payload);
      if (cache !== null && cacheChanged(record.cache, cache)) patch.cache = cache;
      const model = modelFromStatusline(event.payload);
      if (model !== null && model !== record.currentModel) patch.currentModel = model;
      if (Object.keys(patch).length === 0) return unchanged;
      return apply(patch);
    }

    case 'hook':
      break;
  }

  const hook = event.hook;
  switch (hook.hook_event_name) {
    case 'SessionStart': {
      const patch: SessionPatch = {};
      // §8.2: the payload is asserted, not parsed, so every field is narrowed
      // where it is read. Without this a non-string id lands in a field the
      // record declares `string | null` and every later comparison misses.
      const id = hook.session_id;
      if (typeof id === 'string' && id !== '' && id !== record.claudeSessionId)
        patch.claudeSessionId = id;
      // A resumed session replays its transcript and stops at the prompt with
      // nothing queued, so no UserPromptSubmit or Stop ever follows: this is
      // the only event that can report the owner's turn has come back, and a
      // resume of an already-known session carries no new id to report it by.
      if (hook.source === 'resume' && record.state === 'starting') patch.state = 'idle';
      if (Object.keys(patch).length === 0) return unchanged;
      // The owner pressed Resume; announcing their own click helps nobody.
      return apply(patch, false);
    }

    case 'SessionEnd':
      return apply({ state: 'exited', pending: null, endedAt: now });

    case 'UserPromptSubmit':
      return live ? apply(busy) : unchanged;

    case 'PreToolUse':
      if (!live) return unchanged;
      return hook.tool_name === QUESTION_TOOL
        ? apply(question(questionSummary(hook.tool_input)))
        : apply(busy);

    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      // A tool result never reports whether the dialog it answers was the one
      // the record is showing: `PermissionRequest` carries no `tool_use_id`
      // (`test/fixtures/hook-events.jsonl`), so a parallel tool's result cannot
      // be told from the dialog's own. Every result therefore clears `pending`.
      return live ? apply(busy) : unchanged;

    case 'PermissionRequest': {
      if (!live) return unchanged;
      // AskUserQuestion raises this hook too, so the tool name — never the
      // hook — decides whether the dialog is a question or a permission.
      if (hook.tool_name === QUESTION_TOOL) {
        return apply(question(questionSummary(hook.tool_input)));
      }
      // §8.2: the payload is asserted, not parsed, so every field is narrowed
      // where it is read. Without this the summary is `undefined` where the
      // record declares a string, and the notification body is empty.
      const tool =
        typeof hook.tool_name === 'string' && hook.tool_name !== '' ? hook.tool_name : 'a tool';
      const digest = digestToolInput(hook.tool_input);
      return apply(permission(digest === '' ? tool : `${tool}: ${digest}`));
    }

    case 'Notification': {
      if (!live) return unchanged;
      // A notification lags the dialog it describes by ~6 s and carries nothing
      // that places it in a turn, so a state derived from it can outlive the
      // dialog with no event guaranteed to clear it. It is recorded as a hint
      // the owner may act on and never moves the session.
      if (needsYou(record.state)) return unchanged;
      // §8.2: the payload is asserted, not parsed, so every field is narrowed
      // where it is read. Without this a non-string message throws out of
      // `reduce` and the event is lost from the record and the transcript.
      const message =
        typeof hook.message === 'string' ? oneLine(hook.message, SNIPPET_MAX_LENGTH) : '';
      return apply(
        { hint: { summary: message === '' ? 'Claude sent a notification' : message, at: now } },
        false,
      );
    }

    case 'PreCompact': {
      const marker = record.compacting;
      // A compaction nobody asked for arrives on the same hook and finds no
      // marker. It is proof the session is alive and nothing else: there is no
      // sequence to time, and a card that showed "compacting" for it would be
      // showing an action the owner never took and cannot cancel.
      if (marker === null || marker === undefined) return apply({}, false);
      if (marker.startedAt !== null) return apply({}, false);
      return apply({ compacting: { ...marker, startedAt: now } }, false);
    }

    case 'PostCompact':
      // The end of the compaction, but not the end of the sequence: the model
      // still has to be switched back, so the marker is the manager's to clear.
      return apply({}, false);

    case 'Stop': {
      if (!live) return unchanged;
      const patch: SessionPatch = { state: 'idle', pending: null };
      const message = hook.last_assistant_message;
      if (typeof message === 'string' && message !== '') {
        patch.lastAssistantMessage = oneLine(message, SNIPPET_MAX_LENGTH);
      }
      if (record.cache === null || record.cache.source === 'derived') {
        patch.cache = cacheDerived(nowMs, options.derivedCacheTtlSeconds ?? CACHE_TTL_5M_SECONDS);
      }
      return apply(patch);
    }
  }

  return unchanged;
}
