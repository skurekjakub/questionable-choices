import { describe, expect, it } from 'vitest';
import {
  LIVE_STATES as CONTRACT_LIVE_STATES,
  NEEDS_YOU_STATES as CONTRACT_NEEDS_YOU_STATES,
} from '../../src/core/api.js';
import { LIVE_STATES, NEEDS_YOU_STATES, STATE_LABELS } from '../../src/web/src/model.js';

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
