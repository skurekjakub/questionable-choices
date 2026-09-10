import { describe, expect, it } from 'vitest';
import { LIVE_STATES, NEEDS_YOU_STATES } from '../../src/core/api.js';
import {
  LIVE_STATES as MACHINE_LIVE_STATES,
  NEEDS_YOU_STATES as MACHINE_NEEDS_YOU_STATES,
} from '../../src/core/state-machine.js';

describe('state sets on the contract', () => {
  it('re-exports the reducer sets themselves, so a client cannot drift from them', () => {
    expect(LIVE_STATES).toBe(MACHINE_LIVE_STATES);
    expect(NEEDS_YOU_STATES).toBe(MACHINE_NEEDS_YOU_STATES);
  });

  it('reports every needs-you state as live, which is what `CardSession.needsYou` assumes', () => {
    for (const state of NEEDS_YOU_STATES) {
      expect(LIVE_STATES.has(state)).toBe(true);
    }
  });
});
