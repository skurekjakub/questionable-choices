import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CACHE_TTL_1H_SECONDS,
  CACHE_TTL_5M_SECONDS,
  cacheChanged,
  cacheDerived,
  cacheFromStatusline,
  describeCache,
  secondsLeft,
  ttlSeconds,
} from '../../src/core/cache-clock.js';
import type { StatuslinePayload } from '../../src/core/cache-clock.js';
import type { SessionCache } from '../../src/core/types.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/statusline-payload.json', import.meta.url), 'utf8'),
) as StatuslinePayload;

describe('ttlSeconds', () => {
  it.each([
    ['1h', CACHE_TTL_1H_SECONDS],
    ['5m', CACHE_TTL_5M_SECONDS],
    ['30m', 0],
    ['', 0],
    [undefined, 0],
  ])('maps %o to %i seconds', (label, expected) => {
    expect(ttlSeconds(label)).toBe(expected);
  });
});

describe('cacheFromStatusline', () => {
  it('reads the recorded payload of a real session', () => {
    expect(cacheFromStatusline(fixture)).toEqual({
      expiresAt: 1788980554,
      ttlSeconds: CACHE_TTL_1H_SECONDS,
      warm: true,
      source: 'statusline',
    });
  });

  it.each([
    ['no prompt_cache block', {}],
    ['a null prompt_cache block', { prompt_cache: null }],
  ])('returns null for %s', (_label, payload) => {
    expect(cacheFromStatusline(payload as StatuslinePayload)).toBeNull();
  });

  it('reports a cold cache with a null expiry', () => {
    expect(
      cacheFromStatusline({ prompt_cache: { ttl: '5m', expires_at: null, warm: false } }),
    ).toEqual({
      expiresAt: null,
      ttlSeconds: CACHE_TTL_5M_SECONDS,
      warm: false,
      source: 'statusline',
    });
  });

  it('reports an unrecognised ttl as unknown', () => {
    const cache = cacheFromStatusline({ prompt_cache: { ttl: '2h', expires_at: 100, warm: true } });
    expect(cache?.ttlSeconds).toBe(0);
  });

  it('counts a warm cache down even when its ttl label is unrecognised', () => {
    const cache = cacheFromStatusline({
      prompt_cache: { ttl: '2h', expires_at: 3_000, warm: true },
    });
    expect(describeCache(cache, 0)).toMatchObject({ state: 'warm', secondsLeft: 3_000 });
    expect(describeCache(cache, 4_000_000).state).toBe('cold');
  });
});

describe('cacheDerived', () => {
  it('expires one ttl after the given moment, in epoch seconds', () => {
    expect(cacheDerived(1_700_000_000_500, CACHE_TTL_5M_SECONDS)).toEqual({
      expiresAt: 1_700_000_300,
      ttlSeconds: CACHE_TTL_5M_SECONDS,
      warm: true,
      source: 'derived',
    });
  });
});

describe('cacheChanged', () => {
  const base: SessionCache = {
    expiresAt: 100,
    ttlSeconds: 300,
    warm: true,
    source: 'statusline',
  };

  it.each([
    ['both null', null, null, false],
    ['appearing', null, base, true],
    ['identical', base, { ...base }, false],
    ['different provenance only', base, { ...base, source: 'derived' as const }, false],
    ['different expiry', base, { ...base, expiresAt: 200 }, true],
    ['going cold', base, { ...base, warm: false }, true],
  ])('reports %s', (_label, a, b, expected) => {
    expect(cacheChanged(a, b)).toBe(expected);
  });
});

describe('secondsLeft', () => {
  const cache: SessionCache = {
    expiresAt: 1000,
    ttlSeconds: 300,
    warm: true,
    source: 'statusline',
  };

  it.each([
    ['counts down', 900_000, 100],
    ['caps at the ttl while a turn runs', 0, 300],
    ['is zero at the expiry second', 1_000_000, 0],
    ['is zero once expired', 1_100_000, 0],
  ])('%s', (_label, nowMs, expected) => {
    expect(secondsLeft(cache, nowMs)).toBe(expected);
  });

  it('is zero without a cache', () => {
    expect(secondsLeft(null, 0)).toBe(0);
  });
});

describe('describeCache', () => {
  const at = (left: number, ttl = CACHE_TTL_1H_SECONDS): SessionCache => ({
    expiresAt: 10_000 + left,
    ttlSeconds: ttl,
    warm: true,
    source: 'statusline',
  });
  const now = 10_000_000;

  it('renders no label when nothing has reported a cache', () => {
    expect(describeCache(null, now)).toEqual({
      state: 'unknown',
      secondsLeft: 0,
      label: '',
      tone: 'dim',
    });
  });

  it.each([
    ['dim well before expiry', 1200, 'dim'],
    ['yellow at 15/60 of the ttl', 900, 'yellow'],
    ['yellow just above the red mark', 301, 'yellow'],
    ['red at 5/60 of the ttl', 300, 'red'],
    ['red in the final seconds', 1, 'red'],
  ])('is %s', (_label, left, tone) => {
    expect(describeCache(at(left), now).tone).toBe(tone);
  });

  it('scales the thresholds with a short ttl', () => {
    expect(describeCache(at(80, CACHE_TTL_5M_SECONDS), now).tone).toBe('dim');
    expect(describeCache(at(75, CACHE_TTL_5M_SECONDS), now).tone).toBe('yellow');
    expect(describeCache(at(25, CACHE_TTL_5M_SECONDS), now).tone).toBe('red');
  });

  it.each([
    [247, '⏳ 4:07'],
    [60, '⏳ 1:00'],
    [5, '⏳ 0:05'],
  ])('formats %i seconds as %s', (left, label) => {
    expect(describeCache(at(left), now).label).toBe(label);
  });

  it('goes cold once the expiry has passed', () => {
    expect(describeCache(at(-1), now)).toEqual({
      state: 'cold',
      secondsLeft: 0,
      label: '❄ cold',
      tone: 'red',
    });
  });

  it('goes cold when the payload says the cache is not warm', () => {
    expect(describeCache({ ...at(1200), warm: false }, now).state).toBe('cold');
  });
});
