import { describe, expect, it } from 'vitest';
import {
  LIVE_STATES as CONTRACT_LIVE_STATES,
  NEEDS_YOU_STATES as CONTRACT_NEEDS_YOU_STATES,
} from '../../src/core/api.js';
import { SESSION_STATES } from '../../src/core/types.js';
import {
  LIVE_STATES,
  NEEDS_YOU_STATES,
  STATE_LABELS,
  compactable,
  type SessionCache,
} from '../../src/web/src/model.js';

describe('the state sets the web reads', () => {
  it('are the contract’s own sets, not a copy that can drift from them', () => {
    expect(LIVE_STATES).toBe(CONTRACT_LIVE_STATES);
    expect(NEEDS_YOU_STATES).toBe(CONTRACT_NEEDS_YOU_STATES);
  });
});

describe('STATE_LABELS', () => {
  // The key list is not restated here: `STATE_LABELS` is typed
  // `Record<SessionState, string>`, so a state added to the contract and
  // forgotten here is a compile error, which lands earlier and reads better
  // than a failing array comparison.
  it('gives every state it words something to render', () => {
    for (const label of Object.values(STATE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('words the needs-you states as what they want rather than as wire names', () => {
    expect(STATE_LABELS['waiting-permission']).toBe('needs permission');
    expect(STATE_LABELS['waiting-question']).toBe('has a question');
    expect(STATE_LABELS.idle).toBe('your turn');
  });

  it('gives no two states the same words', () => {
    const labels = Object.values(STATE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('compactable', () => {
  const NOW = Date.parse('2026-09-10T12:00:00.000Z');
  const cold: SessionCache = {
    expiresAt: Math.floor(NOW / 1000) - 120,
    ttlSeconds: 300,
    warm: false,
    source: 'statusline',
  };
  const warm: SessionCache = { ...cold, warm: true, expiresAt: Math.floor(NOW / 1000) + 240 };

  it('offers the action for an idle session whose cache has gone cold', () => {
    expect(compactable({ state: 'idle', cache: cold, compacting: false }, NOW)).toBe(true);
  });

  it('refuses while the cache is still warm', () => {
    // The action costs a full re-read of the context, so it is only worth
    // offering once that re-read is going to happen anyway.
    expect(compactable({ state: 'idle', cache: warm, compacting: false }, NOW)).toBe(false);
  });

  it('refuses when nothing has reported a cache at all', () => {
    // "Unknown" is not "cold": a session that has never made a request has
    // nothing worth summarising either.
    expect(compactable({ state: 'idle', cache: null, compacting: false }, NOW)).toBe(false);
  });

  it('refuses a session that is already being compacted', () => {
    expect(compactable({ state: 'idle', cache: cold, compacting: true }, NOW)).toBe(false);
  });

  it.each(SESSION_STATES.filter((state) => state !== 'idle'))(
    'refuses a session in state %s, which is not sitting at the prompt',
    (state) => {
      expect(compactable({ state, cache: cold, compacting: false }, NOW)).toBe(false);
    },
  );
});
