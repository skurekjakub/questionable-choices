import { describe, expect, it } from 'vitest';
import { LIVE_STATES, NEEDS_YOU_STATES } from '../../src/core/api.js';
import { isLive, needsYou } from '../../src/core/state-machine.js';
import { project } from '../../src/core/projection.js';
import { SESSION_STATES, type SessionState } from '../../src/core/types.js';
import { makeIssue, makeRecord, makeRepo, makeWorkspace } from './helpers.js';

describe('state sets on the contract', () => {
  it('reports every needs-you state as live, which is what `CardSession.needsYou` assumes', () => {
    for (const state of NEEDS_YOU_STATES) {
      expect(LIVE_STATES.has(state)).toBe(true);
    }
  });

  it('answers the reducer predicates out of the contract sets themselves', () => {
    // Membership alone would survive the reducer restating either list as a
    // local literal with the same members, which is the drift the sets exist to
    // rule out. Deleting a member from the contract's own set has to change the
    // reducer's answer, so the reducer must be reading this object.
    const live = LIVE_STATES as Set<SessionState>;
    const needy = NEEDS_YOU_STATES as Set<SessionState>;
    try {
      live.delete('working');
      needy.delete('idle');
      expect(isLive('working')).toBe(false);
      expect(needsYou('idle')).toBe(false);
    } finally {
      live.add('working');
      needy.add('idle');
    }
    expect(isLive('working')).toBe(true);
    expect(needsYou('idle')).toBe(true);
  });

  it.each(SESSION_STATES)(
    'answers the reducer predicates from the contract sets for %s',
    (state) => {
      expect(isLive(state)).toBe(LIVE_STATES.has(state));
      expect(needsYou(state)).toBe(NEEDS_YOU_STATES.has(state));
    },
  );

  it.each(SESSION_STATES)('derives the card flags of a %s session from the sets', (state) => {
    const view = project({
      workspaceId: 'docs',
      workspace: makeWorkspace(),
      repo: makeRepo(),
      issues: [makeIssue()],
      sessions: [makeRecord({ state })],
      flags: {},
      worktrees: {},
      sourceError: null,
      fetchedAt: '2026-09-09T10:00:00.000Z',
    });
    const session = view.columns.flatMap((column) => column.cards).flatMap((card) => card.sessions);

    expect(session).toHaveLength(1);
    expect(session[0]?.live).toBe(LIVE_STATES.has(state));
    expect(session[0]?.needsYou).toBe(NEEDS_YOU_STATES.has(state));
  });
});
