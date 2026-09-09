import type { JSX } from 'react';
import { describeCache } from '../../../core/cache-clock.js';
import type { SessionCache } from '../model.js';

/**
 * Renders the prompt-cache countdown as a label over a depleting gauge.
 *
 * The gauge is the only one in the product; it reads as an instrument needle
 * rather than as decoration precisely because nothing else has one.
 *
 * @param props - Component props.
 * @param props.cache - Cache state, or null when nothing has reported one.
 * @param props.nowMs - Current time in epoch milliseconds.
 * @returns The readout, or null when no cache has been reported.
 */
export function CacheReadout({
  cache,
  nowMs,
}: {
  cache: SessionCache | null;
  nowMs: number;
}): JSX.Element | null {
  const described = describeCache(cache, nowMs);
  if (described.state === 'unknown') return null;
  const ttl = cache?.ttlSeconds ?? 0;
  const fraction = ttl > 0 ? Math.min(1, described.secondsLeft / ttl) : 0;
  return (
    <span
      className="cache"
      data-tone={described.tone}
      title={described.state === 'cold' ? 'Prompt cache is cold' : 'Prompt cache time left'}
    >
      <span className="cache-label">{described.label}</span>
      <span className="cache-gauge">
        <span style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </span>
  );
}
