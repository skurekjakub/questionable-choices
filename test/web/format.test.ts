import { describe, expect, it } from 'vitest';
import {
  attachCommand,
  endedHint,
  syncedAgo,
  timeInState,
  typeGlyph,
} from '../../src/web/src/format.js';

/**
 * A fixed instant the durations below are measured back from.
 */
const NOW = Date.parse('2026-09-10T12:00:00.000Z');

/**
 * Builds the ISO timestamp a number of seconds before {@link NOW}.
 *
 * @param seconds - How far back the timestamp should sit.
 * @returns The timestamp in ISO form.
 */
function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe('timeInState', () => {
  it('reads seconds up to the minute boundary and minutes from it', () => {
    expect(timeInState(ago(0), NOW)).toBe('0s');
    expect(timeInState(ago(59), NOW)).toBe('59s');
    expect(timeInState(ago(60), NOW)).toBe('1m');
    expect(timeInState(ago(119), NOW)).toBe('1m');
  });

  it('reads hours with zero-padded minutes, so the column does not jitter', () => {
    expect(timeInState(ago(3599), NOW)).toBe('59m');
    expect(timeInState(ago(3600), NOW)).toBe('1h 00m');
    expect(timeInState(ago(3660), NOW)).toBe('1h 01m');
    expect(timeInState(ago(86_399), NOW)).toBe('23h 59m');
  });

  it('reads days past 24 hours', () => {
    expect(timeInState(ago(86_400), NOW)).toBe('1d');
    expect(timeInState(ago(3 * 86_400 + 500), NOW)).toBe('3d');
  });

  it('floors a timestamp in the future at zero rather than counting backwards', () => {
    expect(timeInState(ago(-120), NOW)).toBe('0s');
  });

  it('reads nothing at all from an unparsable timestamp', () => {
    expect(timeInState('not a date', NOW)).toBe('');
    expect(timeInState('', NOW)).toBe('');
  });
});

describe('syncedAgo', () => {
  it('phrases the duration since the last successful refresh', () => {
    expect(syncedAgo(ago(12), NOW)).toBe('synced 12s ago');
    expect(syncedAgo(ago(3600), NOW)).toBe('synced 1h 00m ago');
  });

  it('says the board has never synced when the timestamp is unreadable', () => {
    expect(syncedAgo('never', NOW)).toBe('never synced');
  });
});

describe('typeGlyph', () => {
  it('gives each recognised type its own glyph, whatever the tracker capitalises', () => {
    expect(typeGlyph('Bug')).toBe('▲');
    expect(typeGlyph('defect')).toBe('▲');
    expect(typeGlyph('Epic')).toBe('⬢');
    expect(typeGlyph('Sub-task')).toBe('◦');
    expect(typeGlyph('Story')).toBe('◆');
  });

  it('falls back to the plain glyph for a type it does not know', () => {
    expect(typeGlyph('Task')).toBe('■');
    expect(typeGlyph('')).toBe('■');
  });

  it('reads a defect before a sub-task, so a sub-bug is still a bug', () => {
    expect(typeGlyph('Sub-bug')).toBe('▲');
  });
});

describe('attachCommand', () => {
  it('uses the command the server reported, verbatim', () => {
    expect(attachCommand('qc-DOC-1-implement', 'tmux -L qc attach -t other')).toBe(
      'tmux -L qc attach -t other',
    );
  });

  it('builds the tmux default when the server named none', () => {
    expect(attachCommand('qc-DOC-1-implement')).toBe('tmux attach -t qc-DOC-1-implement');
    expect(attachCommand('qc-DOC-1-implement', null)).toBe('tmux attach -t qc-DOC-1-implement');
  });
});

describe('endedHint', () => {
  it('names the exit code the launcher reported for a failed session', () => {
    expect(endedHint('qc-DOC-1-implement', 'failed', 1)?.label).toBe('failed, exit 1');
    expect(endedHint('qc-DOC-1-implement', 'failed', 127)?.label).toBe('failed, exit 127');
  });

  it('says only that it failed when no code reached the record', () => {
    expect(endedHint('qc-DOC-1-implement', 'failed', null)?.label).toBe('failed');
  });

  it('keeps a zero code on a failure, which is a real outcome and not a missing one', () => {
    expect(endedHint('qc-DOC-1-implement', 'failed', 0)?.label).toBe('failed, exit 0');
  });

  it('points at the shell by the tmux name, which is the session id', () => {
    expect(endedHint('qc-DOC-1-implement', 'failed', 1)?.shell).toBe(
      'shell open in tmux qc-DOC-1-implement',
    );
    expect(endedHint('qc-DOC-1-implement', 'failed', null)?.shell).toBe(
      'shell open in tmux qc-DOC-1-implement',
    );
  });

  it('names the exit code of a CLI that ran and died, which otherwise looks like a clean exit', () => {
    expect(endedHint('qc-DOC-1-implement', 'exited', 1)?.label).toBe('exited, code 1');
    expect(endedHint('qc-DOC-1-implement', 'exited', 137)?.label).toBe('exited, code 137');
  });

  it('leaves an exited session no shell to point at, because it left none open', () => {
    expect(endedHint('qc-DOC-1-implement', 'exited', 1)?.shell).toBeNull();
  });

  it('says nothing extra about an exit the state word already describes', () => {
    expect(endedHint('qc-DOC-1-implement', 'exited', 0)).toBeNull();
    expect(endedHint('qc-DOC-1-implement', 'exited', null)).toBeNull();
  });

  it('says nothing about a session that has not ended, whatever code it last carried', () => {
    expect(endedHint('qc-DOC-1-implement', 'working', 1)).toBeNull();
    expect(endedHint('qc-DOC-1-implement', 'idle', 1)).toBeNull();
    expect(endedHint('qc-DOC-1-implement', 'bootstrapping', null)).toBeNull();
  });
});
