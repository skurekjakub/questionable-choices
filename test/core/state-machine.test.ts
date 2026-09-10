import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CACHE_TTL_1H_SECONDS, CACHE_TTL_5M_SECONDS } from '../../src/core/cache-clock.js';
import { LIVE_STATES, NEEDS_YOU_STATES } from '../../src/core/api.js';
import {
  SNIPPET_MAX_LENGTH,
  asHookEvent,
  isHookEventName,
  isLive,
  needsYou,
  reduce,
} from '../../src/core/state-machine.js';
import type { HookEvent, SessionEvent } from '../../src/core/state-machine.js';
import { SESSION_STATES, type SessionState } from '../../src/core/types.js';
import { makeRecord } from './helpers.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const NOW_ISO = '2026-09-09T12:00:00.000Z';

/**
 * Wraps a hook payload as the reducer's event.
 *
 * @param hook - The hook payload.
 * @returns The session event.
 */
function hookEvent(hook: HookEvent): SessionEvent {
  return { type: 'hook', hook };
}

describe('state sets', () => {
  it('marks every state except exited and failed as live', () => {
    const live = SESSION_STATES.filter((state) => isLive(state));
    expect(live).toEqual(SESSION_STATES.filter((s) => s !== 'exited' && s !== 'failed'));
    expect(LIVE_STATES.size).toBe(live.length);
  });

  it('marks the three waiting-for-you states as needing you', () => {
    expect([...NEEDS_YOU_STATES].sort()).toEqual([
      'idle',
      'waiting-permission',
      'waiting-question',
    ]);
    expect(SESSION_STATES.filter((state) => needsYou(state)).length).toBe(3);
  });
});

describe('reduce transition table', () => {
  const cases: Array<{
    name: string;
    from: SessionState;
    event: SessionEvent;
    to: SessionState;
    pending: string | null;
    notify: boolean;
  }> = [
    {
      name: 'bootstrap-start from any state',
      from: 'exited',
      event: { type: 'bootstrap-start' },
      to: 'bootstrapping',
      pending: null,
      notify: false,
    },
    {
      name: 'bootstrap-failed from bootstrapping',
      from: 'bootstrapping',
      event: { type: 'bootstrap-failed', exitCode: 1 },
      to: 'failed',
      pending: null,
      notify: false,
    },
    {
      name: 'claude-start from bootstrapping',
      from: 'bootstrapping',
      event: { type: 'claude-start', mode: 'start' },
      to: 'starting',
      pending: null,
      notify: false,
    },
    {
      name: 'claude-start from exited resumes',
      from: 'exited',
      event: { type: 'claude-start', mode: 'resume' },
      to: 'starting',
      pending: null,
      notify: false,
    },
    {
      name: 'claude-exit from working',
      from: 'working',
      event: { type: 'claude-exit', exitCode: 0 },
      to: 'exited',
      pending: null,
      notify: false,
    },
    {
      name: 'UserPromptSubmit clears a pending permission',
      from: 'waiting-permission',
      event: hookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }),
      to: 'working',
      pending: null,
      notify: false,
    },
    {
      name: 'PreToolUse for an ordinary tool',
      from: 'idle',
      event: hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
      to: 'working',
      pending: null,
      notify: false,
    },
    {
      name: 'PreToolUse for AskUserQuestion',
      from: 'working',
      event: hookEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which format?', header: 'Format' }] },
      }),
      to: 'waiting-question',
      pending: 'Which format?',
      notify: true,
    },
    {
      name: 'PostToolUse returns to working',
      from: 'waiting-question',
      event: hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }),
      to: 'working',
      pending: null,
      notify: false,
    },
    {
      name: 'PostToolUseFailure returns to working',
      from: 'waiting-permission',
      event: hookEvent({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }),
      to: 'working',
      pending: null,
      notify: false,
    },
    {
      name: 'PermissionDenied returns to working',
      from: 'waiting-permission',
      event: hookEvent({ hook_event_name: 'PermissionDenied', tool_name: 'Bash' }),
      to: 'working',
      pending: null,
      notify: false,
    },
    {
      name: 'PermissionRequest names the tool and its command',
      from: 'working',
      event: hookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /', description: 'Delete everything' },
      }),
      to: 'waiting-permission',
      pending: 'Bash: rm -rf /',
      notify: true,
    },
    {
      name: 'PermissionRequest for AskUserQuestion is a question, not a permission',
      from: 'working',
      event: hookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which format?' }] },
      }),
      to: 'waiting-question',
      pending: 'Which format?',
      notify: true,
    },
    {
      name: 'Stop ends the turn',
      from: 'working',
      event: hookEvent({ hook_event_name: 'Stop', last_assistant_message: 'done' }),
      to: 'idle',
      pending: null,
      notify: true,
    },
    {
      name: 'interrupt from working',
      from: 'working',
      event: { type: 'interrupt' },
      to: 'idle',
      pending: null,
      notify: false,
    },
    {
      name: 'interrupt from waiting-permission',
      from: 'waiting-permission',
      event: { type: 'interrupt' },
      to: 'idle',
      pending: null,
      notify: false,
    },
    {
      name: 'SessionEnd from working',
      from: 'working',
      event: hookEvent({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
      to: 'exited',
      pending: null,
      notify: false,
    },
  ];

  it.each(cases)('$name', ({ from, event, to, pending, notify }) => {
    const before = makeRecord({
      state: from,
      pending: from === 'waiting-permission' ? { kind: 'permission', summary: 'Bash: ls' } : null,
    });
    const result = reduce(before, event, NOW);
    expect(result.record.state).toBe(to);
    expect(result.record.pending?.summary ?? null).toBe(pending);
    expect(result.notify).toBe(notify);
    expect(result.changed).toBe(true);
    expect(result.record.stateSince).toBe(NOW_ISO);
  });
});

describe('reduce refusals', () => {
  it.each(['starting', 'working', 'idle', 'exited', 'failed'] as SessionState[])(
    'ignores bootstrap-failed from %s',
    (state) => {
      const result = reduce(makeRecord({ state }), { type: 'bootstrap-failed' }, NOW);
      expect(result).toEqual({
        record: expect.objectContaining({ state }),
        changed: false,
        notify: false,
      });
    },
  );

  it.each(['working', 'waiting-permission', 'idle'] as SessionState[])(
    'ignores claude-start from %s',
    (state) => {
      const result = reduce(makeRecord({ state }), { type: 'claude-start', mode: 'start' }, NOW);
      expect(result.changed).toBe(false);
    },
  );

  it.each(['idle', 'starting', 'bootstrapping', 'exited'] as SessionState[])(
    'ignores interrupt from %s',
    (state) => {
      expect(reduce(makeRecord({ state }), { type: 'interrupt' }, NOW).changed).toBe(false);
    },
  );

  it.each(['exited', 'failed'] as SessionState[])('ignores hook events from %s', (state) => {
    const events: SessionEvent[] = [
      hookEvent({ hook_event_name: 'UserPromptSubmit' }),
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      hookEvent({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
      hookEvent({ hook_event_name: 'Stop' }),
    ];
    for (const event of events) {
      expect(reduce(makeRecord({ state }), event, NOW).changed).toBe(false);
    }
  });

  it('leaves the record untouched for a status-line payload that moved nothing', () => {
    const before = makeRecord({
      state: 'working',
      cache: { expiresAt: 999, ttlSeconds: CACHE_TTL_1H_SECONDS, warm: true, source: 'statusline' },
    });
    const result = reduce(
      before,
      { type: 'statusline', payload: { prompt_cache: { ttl: '1h', expires_at: 999, warm: true } } },
      NOW,
    );
    expect(result.changed).toBe(false);
    expect(result.record).toBe(before);
  });

  it('stamps lastEventAt for an accepted event that moves nothing else', () => {
    // The stamp is the evidence the session is being heard from, and an event
    // that leaves every other field alone is evidence too: without it a record
    // flagged at a restart stays flagged while its log fills with proof of life.
    const before = makeRecord({
      state: 'working',
      pending: null,
      staleSince: '2026-09-09T11:00:00.000Z',
      lastEventAt: '2026-09-09T09:00:00.000Z',
    });

    const result = reduce(
      before,
      hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
      NOW,
    );

    expect(result.record.state).toBe('working');
    expect(result.record.lastEventAt).toBe(NOW_ISO);
    expect(result.record.staleSince).toBeNull();
    expect(result.changed).toBe(true);
  });

  it('never stamps lastEventAt for a status-line payload, which reports no state', () => {
    const before = makeRecord({ state: 'working', lastEventAt: '2026-09-09T09:00:00.000Z' });

    const result = reduce(
      before,
      { type: 'statusline', payload: { prompt_cache: { ttl: '1h', expires_at: 999, warm: true } } },
      NOW,
    );

    expect(result.changed).toBe(true);
    expect(result.record.lastEventAt).toBe('2026-09-09T09:00:00.000Z');
  });

  it('never stamps lastEventAt for an event it refuses outright', () => {
    const before = makeRecord({ state: 'exited', lastEventAt: '2026-09-09T09:00:00.000Z' });

    const result = reduce(before, hookEvent({ hook_event_name: 'Stop' }), NOW);

    expect(result.changed).toBe(false);
    expect(result.record.lastEventAt).toBe('2026-09-09T09:00:00.000Z');
  });

  it('never notifies twice for the same demand', () => {
    const first = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
      NOW,
    );
    expect(first.notify).toBe(true);
    const second = reduce(
      first.record,
      hookEvent({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission',
      }),
      NOW,
    );
    expect(second.changed).toBe(false);
  });
});

describe('a Notification never moves the session', () => {
  const PROMPT = 'prompt-1';
  const LATE = hookEvent({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    prompt_id: PROMPT,
    message: 'Claude needs your permission',
  });

  it('records a hint and leaves the state where it was', () => {
    const before = makeRecord({ state: 'working', pending: null });

    const result = reduce(before, LATE, NOW);

    expect(result.record.state).toBe('working');
    expect(result.record.stateSince).toBe(before.stateSince);
    expect(result.record.pending).toBeNull();
    expect(result.record.hint).toEqual({ summary: 'Claude needs your permission', at: NOW_ISO });
    expect(result.notify).toBe(false);
    expect(result.changed).toBe(true);
  });

  it.each(['waiting-permission', 'waiting-question', 'idle'] as SessionState[])(
    'says nothing on a session already waiting for the owner in %s',
    (state) => {
      const before = makeRecord({ state, pending: { kind: 'permission', summary: 'Bash: ls' } });

      const result = reduce(before, LATE, NOW);

      expect(result.changed).toBe(false);
      expect(result.record).toBe(before);
    },
  );

  it.each(['exited', 'failed'] as SessionState[])('is ignored on a %s session', (state) => {
    expect(reduce(makeRecord({ state }), LATE, NOW).changed).toBe(false);
  });

  it('cannot open a dialog on the turn after the one it belongs to', () => {
    // The notification lags the dialog by ~6 s, so the owner answering and
    // typing the next prompt inside that window used to land a false "needs
    // you" — with a desktop notification — on a session that is mid-turn.
    let record = makeRecord({ state: 'working', pending: null });
    const steps: SessionEvent[] = [
      hookEvent({ hook_event_name: 'UserPromptSubmit', prompt_id: PROMPT }),
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', prompt_id: PROMPT }),
      hookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        prompt_id: PROMPT,
        tool_input: { command: 'rm -rf x' },
      }),
      hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', prompt_id: PROMPT }),
      hookEvent({ hook_event_name: 'Stop', prompt_id: PROMPT }),
      hookEvent({ hook_event_name: 'UserPromptSubmit', prompt_id: 'prompt-2' }),
    ];
    for (const [index, step] of steps.entries()) record = reduce(record, step, NOW + index).record;
    expect(record.state).toBe('working');

    const late = reduce(record, LATE, NOW + 10_000);

    expect(late.record.state).toBe('working');
    expect(late.record.pending).toBeNull();
    expect(late.notify).toBe(false);
    expect(late.record.hint?.summary).toBe('Claude needs your permission');
  });

  it('cannot open a dialog on a run that has only just started', () => {
    // `starting` means the launcher has posted `claude-start` and no hook has
    // arrived; a dead run's notification landing there reported a dialog
    // belonging to a process that no longer exists.
    const exited = reduce(
      makeRecord({ state: 'working', pending: null }),
      { type: 'claude-exit', exitCode: 0 },
      NOW,
    );
    const restarted = reduce(exited.record, { type: 'claude-start', mode: 'start' }, NOW + 1_000);
    expect(restarted.record.state).toBe('starting');

    const late = reduce(restarted.record, LATE, NOW + 2_000);

    expect(late.record.state).toBe('starting');
    expect(late.record.pending).toBeNull();
    expect(late.notify).toBe(false);
    expect(late.record.hint?.summary).toBe('Claude needs your permission');
  });

  it('survives two tool calls running at once without losing either of them', () => {
    // Two PreToolUse events before either result is the shape that made a
    // boolean "a tool call is open" wrong; nothing is keyed on it now, so the
    // record follows the dialogs the server was actually told about.
    let record = makeRecord({ state: 'working', pending: null });
    const steps: SessionEvent[] = [
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a' }),
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b' }),
      hookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf x' },
      }),
    ];
    for (const [index, step] of steps.entries()) record = reduce(record, step, NOW + index).record;
    expect(record.state).toBe('waiting-permission');

    const late = reduce(record, LATE, NOW + 6_000);

    expect(late.changed).toBe(false);
    expect(late.record.state).toBe('waiting-permission');
    expect(late.record.pending?.summary).toBe('Bash: rm -rf x');
  });

  it('leaves a dropped PermissionRequest showing as a hint, not as a dialog', () => {
    // The hook is `curl … || true`, so a lost PermissionRequest is real. The
    // notification is the only trace of it, and it is reported as one.
    let record = makeRecord({ state: 'working', pending: null });
    const steps: SessionEvent[] = [
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a' }),
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b' }),
      hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'a' }),
    ];
    for (const [index, step] of steps.entries()) record = reduce(record, step, NOW + index).record;

    const late = reduce(record, LATE, NOW + 6_000);

    expect(late.record.state).toBe('working');
    expect(late.record.pending).toBeNull();
    expect(needsYou(late.record.state)).toBe(false);
    expect(late.record.hint?.summary).toBe('Claude needs your permission');
    expect(late.notify).toBe(false);
  });

  it.each<[string, SessionEvent, boolean]>([
    ['UserPromptSubmit', hookEvent({ hook_event_name: 'UserPromptSubmit' }), true],
    ['PreToolUse', hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), true],
    ['Stop', hookEvent({ hook_event_name: 'Stop' }), true],
    ['claude-exit', { type: 'claude-exit', exitCode: 0 } as SessionEvent, true],
    // A SessionStart whose id the record already has patches nothing, so the
    // reducer answers `unchanged` before it ever reaches the clear. It is the
    // one lifecycle event that leaves a hint standing, and the rule is written
    // as "the next event the reducer accepts", not "the next event".
    [
      'SessionStart the reducer refuses',
      hookEvent({ hook_event_name: 'SessionStart', session_id: 'claude-1', source: 'startup' }),
      false,
    ],
  ])('is cleared by the next %s only when the reducer accepts it', (_name, event, clears) => {
    const hint = { summary: 'Claude needs your permission', at: NOW_ISO };
    const hinted = makeRecord({
      state: 'working',
      pending: null,
      claudeSessionId: 'claude-1',
      hint,
    });

    const next = reduce(hinted, event, NOW + 1_000);

    expect(next.changed).toBe(clears);
    expect(next.record.hint).toEqual(clears ? null : hint);
  });

  it('is left alone by a status-line payload, which is not a lifecycle event', () => {
    const hint = { summary: 'Claude needs your permission', at: NOW_ISO };
    const hinted = makeRecord({ state: 'working', hint });

    const next = reduce(
      hinted,
      { type: 'statusline', payload: { prompt_cache: { ttl: '1h', expires_at: 999, warm: true } } },
      NOW + 1_000,
    );

    expect(next.changed).toBe(true);
    expect(next.record.hint).toEqual(hint);
  });

  it('caps the hint the way an assistant snippet is capped', () => {
    const message = `noise  ${'x'.repeat(600)}`;

    const result = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Notification', message }),
      NOW,
    );

    expect(result.record.hint?.summary.length).toBe(SNIPPET_MAX_LENGTH);
    expect(result.record.hint?.summary.endsWith('…')).toBe(true);
  });

  it('stands a payload with no message in for one, so the hint is never blank', () => {
    const result = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
      NOW,
    );

    expect(result.record.hint?.summary).toBe('Claude sent a notification');
  });
});

describe('a hook payload carrying a field that is not the type it is declared as', () => {
  // §8.2: the payload is asserted, not parsed, so a field read without
  // narrowing takes whatever the body carried. A throw out of `reduce` is
  // unrecoverable in a way a wrong value is not: the launcher posts hooks with
  // `curl … || true`, so the 500 is discarded and the event is lost from the
  // record and from `events.jsonl` with nothing left to say it happened.
  it.each<[string, string, Record<string, unknown>, boolean]>([
    ['message', 'Notification', { message: { text: 'needs you' } }, true],
    ['tool_name', 'PermissionRequest', { tool_name: 7, tool_input: { command: 'ls' } }, true],
    ['session_id', 'SessionStart', { session_id: 42, source: 'startup' }, false],
    ['last_assistant_message', 'Stop', { last_assistant_message: ['done'] }, true],
  ])('is absorbed when %s arrives on a %s', (_field, name, body, changed) => {
    const hook = asHookEvent(name, body);
    if (hook === null) throw new Error(`asHookEvent refused ${name}, which is a test bug`);
    const record = makeRecord({ state: 'working', pending: null, claudeSessionId: 'claude-1' });

    const result = reduce(record, { type: 'hook', hook }, NOW);

    expect(result.changed).toBe(changed);
    // Every field the reducer may write from the payload still holds the type
    // the record declares, so nothing downstream is handed the raw value.
    expect(result.record.claudeSessionId).toBe('claude-1');
    expect(result.record.hint?.summary ?? '').toBeTypeOf('string');
    expect(result.record.pending?.summary ?? '').toBeTypeOf('string');
    expect(result.record.lastAssistantMessage ?? '').toBeTypeOf('string');
  });
});

describe('exit codes and staleness', () => {
  it('keeps the exit code of a failed bootstrap, the only reason a failed card has', () => {
    const bootstrapping = reduce(
      makeRecord({ state: 'starting' }),
      { type: 'bootstrap-start' },
      NOW,
    );

    const failed = reduce(
      bootstrapping.record,
      { type: 'bootstrap-failed', exitCode: 1 },
      NOW + 1_000,
    );

    expect(failed.record.state).toBe('failed');
    expect(failed.record.lastExitCode).toBe(1);
  });

  it('keeps the exit code of a CLI that ended', () => {
    const result = reduce(
      makeRecord({ state: 'working' }),
      { type: 'claude-exit', exitCode: 130 },
      NOW,
    );
    expect(result.record.lastExitCode).toBe(130);
  });

  it('forgets the previous run’s assistant snippet when a new run starts', () => {
    // The snippet is what a card presents as "what this session is waiting on";
    // carried into the next run it advertises the last one's last word.
    const ended = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Stop', last_assistant_message: 'the previous run said this' }),
      NOW,
    );
    const exited = reduce(ended.record, { type: 'claude-exit', exitCode: 0 }, NOW + 1_000);
    expect(exited.record.lastAssistantMessage).toBe('the previous run said this');

    const restarted = reduce(exited.record, { type: 'claude-start', mode: 'resume' }, NOW + 2_000);

    expect(restarted.record.state).toBe('starting');
    expect(restarted.record.lastAssistantMessage).toBeNull();
  });

  it('forgets the assistant snippet when the owner interrupts', () => {
    const idle = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Stop', last_assistant_message: 'mid-thought' }),
      NOW,
    );
    const working = reduce(
      idle.record,
      hookEvent({ hook_event_name: 'UserPromptSubmit' }),
      NOW + 1_000,
    );
    expect(working.record.lastAssistantMessage).toBe('mid-thought');

    const interrupted = reduce(working.record, { type: 'interrupt' }, NOW + 2_000);

    expect(interrupted.record.state).toBe('idle');
    expect(interrupted.record.lastAssistantMessage).toBeNull();
  });

  it('forgets the previous exit code when a new run starts', () => {
    const result = reduce(
      makeRecord({ state: 'exited', lastExitCode: 1 }),
      { type: 'claude-start', mode: 'start' },
      NOW,
    );
    expect(result.record.lastExitCode).toBeNull();
  });

  it('clears the staleness marker on the first event that reaches the record', () => {
    // The marker means "nobody told this record anything while the server was
    // down"; one event that does is the whole of the evidence needed.
    const stale = makeRecord({ state: 'working', staleSince: '2026-09-09T12:00:00.000Z' });

    const result = reduce(stale, hookEvent({ hook_event_name: 'Stop' }), NOW);

    expect(result.record.staleSince).toBeNull();
  });

  it('leaves the marker alone for an event the reducer refuses outright', () => {
    const stale = makeRecord({ state: 'exited', staleSince: '2026-09-09T12:00:00.000Z' });

    const result = reduce(stale, hookEvent({ hook_event_name: 'Stop' }), NOW);

    expect(result.changed).toBe(false);
    expect(result.record.staleSince).toBe('2026-09-09T12:00:00.000Z');
  });
});

describe('SessionEnd', () => {
  it.each(SESSION_STATES)('ends a session in state %s', (state) => {
    const result = reduce(makeRecord({ state }), hookEvent({ hook_event_name: 'SessionEnd' }), NOW);
    expect(result.record.state).toBe('exited');
    expect(result.record.endedAt).toBe(NOW_ISO);
  });

  it('forgets the hint, which belongs to a run that has ended', () => {
    const result = reduce(
      makeRecord({
        state: 'working',
        hint: { summary: 'Claude needs your permission', at: NOW_ISO },
      }),
      hookEvent({ hook_event_name: 'SessionEnd' }),
      NOW,
    );
    expect(result.record.hint).toBeNull();
  });
});

describe('runs', () => {
  it('appends a run on claude-start and closes it on claude-exit', () => {
    const started = reduce(
      makeRecord({ state: 'exited', runs: [], endedAt: NOW_ISO }),
      { type: 'claude-start', mode: 'resume' },
      NOW,
    );
    expect(started.record.runs).toEqual([{ startedAt: NOW_ISO, kind: 'resume', exitCode: null }]);
    expect(started.record.endedAt).toBeNull();

    const exited = reduce(started.record, { type: 'claude-exit', exitCode: 130 }, NOW);
    expect(exited.record.runs).toEqual([{ startedAt: NOW_ISO, kind: 'resume', exitCode: 130 }]);
    expect(exited.record.endedAt).toBe(NOW_ISO);
  });

  it('leaves an already-closed run alone', () => {
    const runs = [{ startedAt: NOW_ISO, kind: 'start' as const, exitCode: 0 }];
    const result = reduce(
      makeRecord({ state: 'exited', runs }),
      { type: 'claude-exit', exitCode: 1 },
      NOW,
    );
    expect(result.record.runs).toEqual(runs);
  });
});

describe('SessionStart', () => {
  it('records the Claude session id without moving the state', () => {
    const result = reduce(
      makeRecord({ state: 'starting' }),
      hookEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup' }),
      NOW,
    );
    expect(result.record.claudeSessionId).toBe('abc');
    expect(result.record.state).toBe('starting');
    expect(result.changed).toBe(true);
  });

  it('ignores a repeat of the id it already has', () => {
    const before = makeRecord({ claudeSessionId: 'abc' });
    expect(
      reduce(before, hookEvent({ hook_event_name: 'SessionStart', session_id: 'abc' }), NOW)
        .changed,
    ).toBe(false);
  });

  it('hands a resumed session back to the owner', () => {
    const before = makeRecord({ state: 'starting', claudeSessionId: 'abc' });
    const result = reduce(
      before,
      hookEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'resume' }),
      NOW,
    );
    expect(result.record.state).toBe('idle');
    expect(result.changed).toBe(true);
    expect(result.notify).toBe(false);
  });

  it('keeps a known id when the payload carries an empty one', () => {
    // Blanking the id would make Resume impossible for the rest of the
    // session's life: `--resume` has nothing to name.
    const before = makeRecord({ state: 'starting', claudeSessionId: 'abc' });

    const result = reduce(
      before,
      hookEvent({ hook_event_name: 'SessionStart', session_id: '', source: 'startup' }),
      NOW,
    );

    expect(result.record.claudeSessionId).toBe('abc');
    expect(result.changed).toBe(false);
  });

  it('leaves a resumed session that already moved on alone', () => {
    const before = makeRecord({ state: 'working', claudeSessionId: 'abc' });
    expect(
      reduce(
        before,
        hookEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'resume' }),
        NOW,
      ).changed,
    ).toBe(false);
  });
});

describe('Stop', () => {
  it('stores a collapsed snippet of the full assistant message', () => {
    const message = `line one\n\nline  two ${'x'.repeat(400)}`;
    const result = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Stop', last_assistant_message: message }),
      NOW,
    );
    const snippet = result.record.lastAssistantMessage ?? '';
    expect(snippet.length).toBe(SNIPPET_MAX_LENGTH);
    expect(snippet.startsWith('line one line two xxx')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('derives the cache when nothing has reported one', () => {
    const result = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Stop' }),
      NOW,
      { derivedCacheTtlSeconds: CACHE_TTL_1H_SECONDS },
    );
    expect(result.record.cache).toEqual({
      expiresAt: Math.floor(NOW / 1000) + CACHE_TTL_1H_SECONDS,
      ttlSeconds: CACHE_TTL_1H_SECONDS,
      warm: true,
      source: 'derived',
    });
  });

  it('defaults the derived cache to the five-minute ttl', () => {
    const result = reduce(
      makeRecord({ state: 'working' }),
      hookEvent({ hook_event_name: 'Stop' }),
      NOW,
    );
    expect(result.record.cache?.ttlSeconds).toBe(CACHE_TTL_5M_SECONDS);
  });

  it('never overwrites a cache the statusline reported', () => {
    const cache = {
      expiresAt: 42,
      ttlSeconds: CACHE_TTL_1H_SECONDS,
      warm: true,
      source: 'statusline' as const,
    };
    const result = reduce(
      makeRecord({ state: 'working', cache }),
      hookEvent({ hook_event_name: 'Stop' }),
      NOW,
    );
    expect(result.record.cache).toEqual(cache);
  });
});

describe('statusline events', () => {
  it('updates the cache without moving the state', () => {
    const result = reduce(
      makeRecord({ state: 'working' }),
      { type: 'statusline', payload: { prompt_cache: { ttl: '1h', expires_at: 999, warm: true } } },
      NOW,
    );
    expect(result.record.state).toBe('working');
    expect(result.record.stateSince).toBe('2026-09-09T10:00:00.000Z');
    expect(result.record.cache?.expiresAt).toBe(999);
    expect(result.changed).toBe(true);
  });

  it.each([
    ['a payload with no prompt_cache', {}],
    ['an unchanged payload', { prompt_cache: { ttl: '1h', expires_at: 999, warm: true } }],
  ])('reports no change for %s', (_label, payload) => {
    const record = makeRecord({
      cache: { expiresAt: 999, ttlSeconds: CACHE_TTL_1H_SECONDS, warm: true, source: 'statusline' },
    });
    expect(reduce(record, { type: 'statusline', payload }, NOW).changed).toBe(false);
  });
});

describe('asHookEvent', () => {
  it.each([
    ['SessionStart', true],
    ['Stop', true],
    ['PermissionRequest', true],
    ['PreCompact', false],
    ['', false],
  ])('recognises %s as a subscribed hook: %s', (name, expected) => {
    expect(isHookEventName(name)).toBe(expected);
    expect(asHookEvent(name, {}) === null).toBe(!expected);
  });

  it('lets the url name win over the body', () => {
    const event = asHookEvent('Stop', {
      hook_event_name: 'PreToolUse',
      last_assistant_message: 'x',
    });
    expect(event?.hook_event_name).toBe('Stop');
  });
});

describe('replaying a recorded session', () => {
  interface FixtureLine {
    event: string;
    ts: number;
    payload: Record<string, unknown>;
  }

  const lines = readFileSync(new URL('../fixtures/hook-events.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FixtureLine);

  const expected: SessionState[] = [
    'starting', // SessionStart
    'working', // UserPromptSubmit
    'waiting-question', // PreToolUse AskUserQuestion
    'waiting-question', // PermissionRequest AskUserQuestion must not demote it
    'waiting-question', // Notification permission_prompt arrives ~6 s late
    'working', // PostToolUse AskUserQuestion
    'working', // PreToolUse Bash
    'waiting-permission', // PermissionRequest Bash
    'waiting-permission', // Notification permission_prompt
    'working', // PostToolUse Bash
    'idle', // Stop
    'working', // UserPromptSubmit
    'working', // PreToolUse Bash
    'working', // PostToolUse Bash
    'idle', // Stop
    'working', // UserPromptSubmit
    'working', // UserPromptSubmit
    'working', // PreToolUse Bash
    'waiting-permission', // PermissionRequest Bash, answered "No" — nothing reports the refusal
    'waiting-permission', // Notification permission_prompt
    'exited', // SessionEnd
  ];

  it('walks the states a real session produced', () => {
    let record = makeRecord({ state: 'starting', claudeSessionId: null });
    const states: SessionState[] = [];
    for (const line of lines) {
      const hook = asHookEvent(line.event, line.payload);
      expect(hook, `unsubscribed hook ${line.event}`).not.toBeNull();
      record = reduce(record, hookEvent(hook as HookEvent), line.ts * 1000).record;
      states.push(record.state);
    }
    expect(states).toEqual(expected);
  });

  it('carries the question and the command through to the card', () => {
    let record = makeRecord({ state: 'starting' });
    const summaries: string[] = [];
    for (const line of lines) {
      record = reduce(
        record,
        hookEvent(asHookEvent(line.event, line.payload) as HookEvent),
        line.ts * 1000,
      ).record;
      if (record.pending !== null)
        summaries.push(`${record.pending.kind}: ${record.pending.summary}`);
    }
    expect(summaries[0]).toBe(
      'question: Which listing format do you prefer for the directory contents?',
    );
    expect(summaries).toContain('permission: Bash: rtk ls -la');
    expect(summaries).toContain('permission: Bash: touch /tmp/hookprobe-denied');
  });

  it('learns the Claude session id from the first event', () => {
    const first = lines[0] as FixtureLine;
    const record = reduce(
      makeRecord({ state: 'starting' }),
      hookEvent(asHookEvent(first.event, first.payload) as HookEvent),
      first.ts * 1000,
    ).record;
    expect(record.claudeSessionId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('reports a lost Bash PermissionRequest as a hint and keeps the session working', () => {
    // The hook is `curl … || true`, so a dropped hook is real. The Notification
    // that follows is the only trace of the dialog, and it is recorded as a
    // hint: it cannot say which turn it belongs to, so it may not move a card
    // into Needs you and stay there.
    const dropped = lines.filter((_line, index) => index !== 7);
    expect(lines[7]?.event).toBe('PermissionRequest');

    let record = makeRecord({ state: 'starting' });
    const states: SessionState[] = [];
    const hints: Array<string | null> = [];
    for (const line of dropped) {
      record = reduce(
        record,
        hookEvent(asHookEvent(line.event, line.payload) as HookEvent),
        line.ts * 1000,
      ).record;
      states.push(record.state);
      hints.push(record.hint?.summary ?? null);
    }

    // Index 7 is the Notification that now stands alone for the Bash dialog.
    expect(states[7]).toBe('working');
    expect(hints[7]).toBe('Claude needs your permission');
    // The tool result that follows it clears the hint again.
    expect(hints[8]).toBeNull();
    expect(states).toEqual([
      'starting',
      'working',
      'waiting-question',
      'waiting-question',
      'waiting-question',
      'working',
      'working',
      'working',
      'working',
      'idle',
      'working',
      'working',
      'working',
      'idle',
      'working',
      'working',
      'working',
      'waiting-permission',
      'waiting-permission',
      'exited',
    ]);
  });

  it('never lets a notification set a hint on a session already waiting', () => {
    // Every notification in the recorded session lands on a record that is
    // already in a needs-you state, which is the case the rule refuses.
    let record = makeRecord({ state: 'starting' });
    for (const line of lines) {
      const before = record;
      record = reduce(
        record,
        hookEvent(asHookEvent(line.event, line.payload) as HookEvent),
        line.ts * 1000,
      ).record;
      if (line.event !== 'Notification') continue;
      expect(needsYou(before.state)).toBe(true);
      expect(record).toBe(before);
    }
  });
});
