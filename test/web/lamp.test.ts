import { describe, expect, it } from 'vitest';
import type { SessionState } from '../../src/core/api.js';
import { lampFor } from '../../src/web/src/components/Lamp.js';
import { STATE_LABELS } from '../../src/web/src/model.js';

/**
 * Every state the contract can send, read off the label table so a new one
 * cannot be added to the machine and forgotten here.
 */
const STATES = Object.keys(STATE_LABELS) as SessionState[];

describe('lampFor', () => {
  it('gives a session that has stopped a silhouette no live state uses', () => {
    expect(lampFor('exited').shape).toBe('bar');
    expect(lampFor('failed').shape).toBe('square');
    const live = STATES.filter((state) => state !== 'exited' && state !== 'failed');
    for (const state of live) {
      expect(['disc', 'ring']).toContain(lampFor(state).shape);
    }
  });

  it('separates the two states that share a colour by silhouette', () => {
    // Cyan is a ring while the worktree is still being built and a disc once
    // the CLI is running; without the silhouette the two are one signal.
    expect(lampFor('bootstrapping')).toEqual({ shape: 'ring', tone: 'cyan', pulse: false });
    expect(lampFor('working')).toEqual({ shape: 'disc', tone: 'cyan', pulse: false });
  });

  it('draws a permission prompt as a disc and an open-ended wait as a ring', () => {
    expect(lampFor('waiting-permission').shape).toBe('disc');
    expect(lampFor('waiting-question').shape).toBe('ring');
    expect(lampFor('idle').shape).toBe('ring');
  });

  it('breathes only on a wait that has one specific answer', () => {
    expect(STATES.filter((state) => lampFor(state).pulse)).toEqual([
      'waiting-permission',
      'waiting-question',
    ]);
  });

  it('leaves starting dim, the one live state that is not cyan', () => {
    expect(lampFor('starting').tone).toBe('dim');
  });

  it('bands the tones the way the palette does', () => {
    expect(lampFor('failed').tone).toBe('red');
    expect(lampFor('exited').tone).toBe('dim');
    for (const state of ['waiting-permission', 'waiting-question', 'idle'] as const) {
      expect(lampFor(state).tone).toBe('amber');
    }
  });

  it('answers for every state the contract can send', () => {
    for (const state of STATES) {
      expect(lampFor(state)).toBeDefined();
    }
  });
});
