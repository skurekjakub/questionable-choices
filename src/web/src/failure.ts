import type { SessionEventLogEntry } from '../../core/api.js';

/**
 * One launcher signal as it was written to the event log.
 */
interface LoggedLauncherSignal {
  /** Name of the launcher signal, e.g. `bootstrap-failed`. */
  launcher: string;
  /** The signal's JSON body, exactly as the launcher posted it. */
  body?: { exitCode?: unknown; message?: unknown } | undefined;
}

/**
 * Reads a logged event as a launcher signal.
 *
 * @param event - The `event` field of one log entry, whose shape is not typed.
 * @returns The signal, or null when the entry is a hook or a status-line poll.
 */
function asLauncherSignal(event: unknown): LoggedLauncherSignal | null {
  if (typeof event !== 'object' || event === null) return null;
  const candidate = event as { launcher?: unknown; body?: unknown };
  if (typeof candidate.launcher !== 'string') return null;
  const body =
    typeof candidate.body === 'object' && candidate.body !== null
      ? (candidate.body as LoggedLauncherSignal['body'])
      : undefined;
  return { launcher: candidate.launcher, ...(body === undefined ? {} : { body }) };
}

/**
 * Renders what one failing launcher signal has to say.
 *
 * @param signal - The signal read out of the log.
 * @returns A sentence naming the failure, or null when the signal says nothing
 * a reader could act on.
 */
function reasonOf(signal: LoggedLauncherSignal): string | null {
  if (signal.launcher !== 'bootstrap-failed' && signal.launcher !== 'claude-exit') return null;
  const message = signal.body?.message;
  if (typeof message === 'string' && message.trim() !== '') return message.trim();
  const exitCode = signal.body?.exitCode;
  if (typeof exitCode === 'number') {
    return signal.launcher === 'bootstrap-failed'
      ? `Bootstrap exited with code ${exitCode}.`
      : `Claude exited with code ${exitCode}.`;
  }
  return signal.launcher === 'bootstrap-failed' ? 'Bootstrap failed.' : null;
}

/**
 * Finds why a session ended badly, from the raw event log the server keeps.
 *
 * The record keeps only the exit code: the reducer reads `exitCode` off a
 * `bootstrap-failed` or `claude-exit` signal and drops the rest of the body. So
 * the `message` the launcher posts — the tail of the output that ended the run
 * — reaches a reader through the event log or not at all.
 *
 * @param events - A session's accepted events, oldest first.
 * @returns The newest failure reason, or null when the log names none.
 */
export function failureReason(events: readonly SessionEventLogEntry[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (entry === undefined) continue;
    const signal = asLauncherSignal(entry.event);
    if (signal === null) continue;
    const reason = reasonOf(signal);
    if (reason !== null) return reason;
  }
  return null;
}
