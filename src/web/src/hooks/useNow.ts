import { useEffect, useState } from 'react';

/**
 * Tracks the current time, re-rendering the caller once a second so countdowns
 * and "time in state" readings tick without the server pushing anything.
 *
 * @returns The current time in epoch milliseconds.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
