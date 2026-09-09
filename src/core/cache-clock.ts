import type { SessionCache } from './types.js';

/**
 * TTL in seconds of a five-minute prompt cache.
 */
export const CACHE_TTL_5M_SECONDS = 300;

/**
 * TTL in seconds of a one-hour prompt cache.
 */
export const CACHE_TTL_1H_SECONDS = 3600;

/**
 * The `prompt_cache` block of a Claude Code status-line payload.
 */
export interface PromptCachePayload {
  /** Configured cache lifetime, `'1h'` or `'5m'`. */
  ttl?: string | undefined;
  /** Epoch **seconds** at which the cached prefix goes cold; null once cold. */
  expires_at?: number | null | undefined;
  /** Whether Claude Code considers the cache warm. */
  warm?: boolean | undefined;
  /** Tokens the next request would have to re-cache while cold. */
  recache_tokens_if_cold?: number | undefined;
}

/**
 * The parts of a Claude Code status-line payload this app reads.
 */
export interface StatuslinePayload {
  /** Claude Code's own session id. */
  session_id?: string | undefined;
  /** Prompt-cache block; absent until the session has made its first request. */
  prompt_cache?: PromptCachePayload | null | undefined;
}

/**
 * Converts a status-line TTL label to seconds.
 *
 * @param ttl - The payload's `prompt_cache.ttl`, e.g. `'1h'` or `'5m'`.
 * @returns The lifetime in seconds, or 0 for an unrecognised or missing label.
 */
export function ttlSeconds(ttl: string | undefined): number {
  if (ttl === '1h') return CACHE_TTL_1H_SECONDS;
  if (ttl === '5m') return CACHE_TTL_5M_SECONDS;
  return 0;
}

/**
 * Reads the prompt-cache state out of a status-line payload.
 *
 * @param payload - The status-line payload as the hook posted it.
 * @returns The cache state, or null when the payload carries no `prompt_cache`.
 */
export function cacheFromStatusline(payload: StatuslinePayload): SessionCache | null {
  const promptCache = payload.prompt_cache;
  if (promptCache === undefined || promptCache === null) return null;
  const expires = promptCache.expires_at;
  return {
    expiresAt: typeof expires === 'number' && expires > 0 ? expires : null,
    ttlSeconds: ttlSeconds(promptCache.ttl),
    warm: promptCache.warm === true,
    source: 'statusline',
  };
}

/**
 * Builds the fallback cache state used when a turn ends before any status-line
 * payload has arrived.
 *
 * @param nowMs - Current time in epoch milliseconds.
 * @param ttl - Cache lifetime in seconds.
 * @returns A warm cache expiring one TTL from now.
 */
export function cacheDerived(nowMs: number, ttl: number): SessionCache {
  return {
    expiresAt: Math.floor(nowMs / 1000) + ttl,
    ttlSeconds: ttl,
    warm: true,
    source: 'derived',
  };
}

/**
 * Reports whether two cache states differ in the fields the UI renders.
 *
 * @param a - Previous cache state, or null.
 * @param b - Next cache state, or null.
 * @returns True when a broadcast is warranted.
 */
export function cacheChanged(a: SessionCache | null, b: SessionCache | null): boolean {
  if (a === null || b === null) return a !== b;
  return a.expiresAt !== b.expiresAt || a.warm !== b.warm || a.ttlSeconds !== b.ttlSeconds;
}

/**
 * Seconds left before the cached prefix goes cold, capped at the TTL.
 *
 * A cache whose TTL is unknown counts down uncapped: the expiry the payload
 * stamped is the fact, the TTL only bounds it.
 *
 * @param cache - Cache state, or null when nothing has reported one.
 * @param nowMs - Current time in epoch milliseconds.
 * @returns Whole seconds remaining; 0 once the cache is cold or unknown.
 */
export function secondsLeft(cache: SessionCache | null, nowMs: number): number {
  if (cache === null || cache.expiresAt === null) return 0;
  const left = cache.expiresAt - Math.floor(nowMs / 1000);
  if (left <= 0) return 0;
  return cache.ttlSeconds > 0 && left > cache.ttlSeconds ? cache.ttlSeconds : left;
}

/**
 * Colour band of the countdown.
 */
export type CacheTone = 'dim' | 'yellow' | 'red';

/**
 * Whether the cached prefix is still usable.
 */
export type CacheState = 'warm' | 'cold' | 'unknown';

/**
 * The countdown as the card renders it.
 */
export interface CacheDescription {
  /** Warm, cold, or unknown because nothing has reported a cache yet. */
  state: CacheState;
  /** Whole seconds left; 0 unless the state is `warm`. */
  secondsLeft: number;
  /** Rendered label, e.g. `⏳ 4:07` or `❄ cold`; empty when unknown. */
  label: string;
  /** Colour band for the label. */
  tone: CacheTone;
}

/**
 * Formats a duration as `m:ss`.
 *
 * @param seconds - Whole seconds to format.
 * @returns The formatted duration, e.g. `4:07`.
 */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Renders the prompt-cache countdown for a card.
 *
 * @param cache - Cache state, or null when nothing has reported one.
 * @param nowMs - Current time in epoch milliseconds.
 * @returns The label, tone and remaining seconds.
 */
export function describeCache(cache: SessionCache | null, nowMs: number): CacheDescription {
  if (cache === null) return { state: 'unknown', secondsLeft: 0, label: '', tone: 'dim' };
  const left = cache.warm ? secondsLeft(cache, nowMs) : 0;
  if (left <= 0) return { state: 'cold', secondsLeft: 0, label: '❄ cold', tone: 'red' };
  // Integer thresholds, matching the statusline's `ttl_s * 5 / 60` shell
  // arithmetic: 5/60 and 15/60 of the TTL, not fixed 5- and 15-minute marks.
  const ttl = cache.ttlSeconds > 0 ? cache.ttlSeconds : CACHE_TTL_5M_SECONDS;
  const red = Math.floor((ttl * 5) / 60);
  const yellow = Math.floor((ttl * 15) / 60);
  const tone: CacheTone = left <= red ? 'red' : left <= yellow ? 'yellow' : 'dim';
  return { state: 'warm', secondsLeft: left, label: `⏳ ${formatDuration(left)}`, tone };
}
