import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CACHE_TTL_1H_SECONDS, CACHE_TTL_5M_SECONDS } from '../../src/core/cache-clock.js';
import {
  LIVE_STATES,
  NEEDS_YOU_STATES,
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
      name: 'Notification opens a permission when nothing else did',
      from: 'working',
      event: hookEvent({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission',
      }),
      to: 'waiting-permission',
      pending: 'Claude needs your permission',
      notify: true,
    },
    {
      name: 'Notification for an elicitation dialog',
      from: 'working',
      event: hookEvent({
        hook_event_name: 'Notification',
        notification_type: 'elicitation_dialog',
        message: 'Claude wants input',
      }),
      to: 'waiting-question',
      pending: 'Claude wants input',
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

  it('leaves the record untouched when nothing moved', () => {
    const before = makeRecord({ state: 'working', pending: null });
    const result = reduce(
      before,
      hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      NOW,
    );
    expect(result.changed).toBe(false);
    expect(result.record).toBe(before);
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

describe('SessionEnd', () => {
  it.each(SESSION_STATES)('ends a session in state %s', (state) => {
    const result = reduce(makeRecord({ state }), hookEvent({ hook_event_name: 'SessionEnd' }), NOW);
    expect(result.record.state).toBe('exited');
    expect(result.record.endedAt).toBe(NOW_ISO);
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
    expect(record.claudeSessionId).toBe(first.payload['session_id']);
  });
});
