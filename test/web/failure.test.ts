import { describe, expect, it } from 'vitest';
import type { SessionEventLogEntry } from '../../src/core/api.js';
import { failureReason } from '../../src/web/src/failure.js';

/**
 * Builds one log entry as the ingress writes launcher signals.
 *
 * @param launcher - Name of the launcher signal.
 * @param body - The signal's body.
 * @returns The log entry.
 */
function signal(launcher: string, body: Record<string, unknown>): SessionEventLogEntry {
  return { at: '2026-09-10T12:00:00.000Z', event: { launcher, body }, state: 'failed' };
}

describe('failureReason', () => {
  it('reports the message a bootstrap failure carried', () => {
    const events = [
      signal('bootstrap-start', {}),
      signal('bootstrap-failed', { exitCode: 128, message: 'fatal: invalid reference: DOC-1' }),
    ];
    expect(failureReason(events)).toBe('fatal: invalid reference: DOC-1');
  });

  it('falls back to the exit code when the signal carried no message', () => {
    expect(failureReason([signal('bootstrap-failed', { exitCode: 128 })])).toBe(
      'Bootstrap exited with code 128.',
    );
    expect(failureReason([signal('claude-exit', { exitCode: 1 })])).toBe(
      'Claude exited with code 1.',
    );
  });

  it('reports a bootstrap failure that carried nothing at all', () => {
    expect(failureReason([signal('bootstrap-failed', {})])).toBe('Bootstrap failed.');
  });

  it('reads the newest failure, not the first', () => {
    const events = [
      signal('bootstrap-failed', { message: 'the first attempt' }),
      signal('claude-start', {}),
      signal('bootstrap-failed', { message: 'the second attempt' }),
    ];
    expect(failureReason(events)).toBe('the second attempt');
  });

  it('keeps looking past a signal that says nothing an owner could act on', () => {
    const events = [
      signal('bootstrap-failed', { message: 'the reason' }),
      signal('claude-exit', { exitCode: null }),
    ];
    expect(failureReason(events)).toBe('the reason');
  });

  it('ignores hooks, status-line polls and anything that is not a launcher signal', () => {
    const entries: SessionEventLogEntry[] = [
      { at: 'x', event: { hook_event_name: 'Stop' }, state: 'idle' },
      { at: 'x', event: { type: 'statusline', payload: {} }, state: 'working' },
      { at: 'x', event: null, state: 'working' },
      { at: 'x', event: 'bootstrap-failed', state: 'failed' },
      signal('claude-start', { mode: 'resume' }),
    ];
    expect(failureReason(entries)).toBeNull();
  });

  it('reads nothing out of an empty log', () => {
    expect(failureReason([])).toBeNull();
  });

  it('ignores a message that is only whitespace', () => {
    expect(failureReason([signal('bootstrap-failed', { message: '   ' })])).toBe(
      'Bootstrap failed.',
    );
  });
});
