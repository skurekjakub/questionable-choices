import { describe, expect, it } from 'vitest';
import { LIVE_STATES, NEEDS_YOU_STATES } from '../../src/core/api.js';
import { isLive, needsYou } from '../../src/core/state-machine.js';
import { project } from '../../src/core/projection.js';
import { SESSION_STATES } from '../../src/core/types.js';
import { makeIssue, makeRecord, makeRepo, makeWorkspace } from './helpers.js';

describe('state sets on the contract', () => {
  it('reports every needs-you state as live, which is what `CardSession.needsYou` assumes', () => {
    for (const state of NEEDS_YOU_STATES) {
      expect(LIVE_STATES.has(state)).toBe(true);
    }
  });

  it.each(SESSION_STATES)(
    'answers the reducer predicates from the contract sets for %s',
    (state) => {
      // The reducer reads the sets rather than restating them, so a second copy
      // of either list cannot drift from the one the SPA imports.
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
