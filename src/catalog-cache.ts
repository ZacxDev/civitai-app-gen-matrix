// Two-layer cache for the in-block resource browser (Pass 2). Discovery-only —
// the SUBMIT gate re-validates everything server-side, so a slightly-stale
// catalog page is harmless and worth the speed.
//
// Layer 1: in-memory Map (process lifetime), instant.
// Layer 2: a persistent KV (sessionStorage by default) so results survive a
//          reload within the tab. Injectable so tests use a fake store and the
//          App can swap in something else (or none) without code change.
//
// Everything here is pure/deterministic given an injected clock + store, so it
// is fully node-testable. `Date.now` may be restricted in some sandbox envs, so
// the clock is ALWAYS injected (default `() => Date.now()` only at the App edge).

import type { CatalogPage, CatalogQuery } from './catalog-api.js';

/** Default TTL: 10 minutes. Catalog popularity moves slowly; submit re-validates. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Monotonic-ish time source (ms). Injected so tests control expiry. */
export type Clock = () => number;

/** Minimal KV the persistent layer needs (sessionStorage satisfies this). */
export interface KvStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Deterministic cache key for a query. Normalizes the bits that materially
 * change the result set: type, trimmed-lowercased query, SORTED baseModels (so
 * order doesn't fork the key), sort, limit. The `cursor` is INCLUDED so paged
 * fetches don't collide. Pure + stable.
 *
 * `authoritative` is a REQUIRED scope dimension: the authoritative
 * (token, maturity-clamped) path and the public/anon path can return DIFFERENT
 * result sets for an identical query (a SFW-clamped view vs the public
 * advisory-SFW view, or — once a red-domain token unclamps — a broader view).
 * Folding it into the key keeps a broad anon result from being served into a
 * signed-in clamped view, or vice-versa.
 */
export function cacheKey(q: CatalogQuery, authoritative = false): string {
  const query = (q.query ?? '').trim().toLowerCase();
  const baseModels = [...(q.baseModels ?? [])]
    .map((b) => b.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  const sort = q.sort ?? '';
  const limit = q.limit ?? '';
  const cursor = q.cursor ?? '';
  const auth = authoritative ? 'auth' : 'pub';
  return `gm:cat:${auth}|${q.type}|q=${query}|bm=${baseModels}|s=${sort}|l=${limit}|c=${cursor}`;
}

interface CacheEntry {
  /** ms timestamp (from the injected clock) when the entry was written. */
  at: number;
  page: CatalogPage;
}

/** Is an entry still fresh given now + ttl? */
export function isFresh(entry: CacheEntry, now: number, ttlMs: number): boolean {
  return now - entry.at < ttlMs;
}

export interface CatalogCacheDeps {
  clock: Clock;
  /** Optional persistent layer. Omit to run memory-only (e.g. SSR / tests). */
  store?: KvStore | null;
  ttlMs?: number;
}

/**
 * The cache. `get` checks memory then the persistent store (promoting a fresh
 * persisted hit into memory). `set` writes both. Expired entries are evicted on
 * read. A failing/throwing store (quota, disabled cookies, private mode) is
 * swallowed — the cache degrades to memory-only, never breaks the browser.
 */
export class CatalogCache {
  private mem = new Map<string, CacheEntry>();
  private clock: Clock;
  private store: KvStore | null;
  private ttlMs: number;

  constructor(deps: CatalogCacheDeps) {
    this.clock = deps.clock;
    this.store = deps.store ?? null;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(q: CatalogQuery, authoritative = false): CatalogPage | null {
    const key = cacheKey(q, authoritative);
    const now = this.clock();

    const hit = this.mem.get(key);
    if (hit) {
      if (isFresh(hit, now, this.ttlMs)) return hit.page;
      this.mem.delete(key); // expired
    }

    const persisted = this.readStore(key);
    if (persisted) {
      if (isFresh(persisted, now, this.ttlMs)) {
        this.mem.set(key, persisted); // promote
        return persisted.page;
      }
      this.removeStore(key); // expired
    }
    return null;
  }

  set(q: CatalogQuery, page: CatalogPage, authoritative = false): void {
    const key = cacheKey(q, authoritative);
    const entry: CacheEntry = { at: this.clock(), page };
    this.mem.set(key, entry);
    this.writeStore(key, entry);
  }

  /** Test/maintenance helper: drop everything (memory only; store left alone). */
  clearMemory(): void {
    this.mem.clear();
  }

  // --- persistent layer (all failures swallowed) ---

  private readStore(key: string): CacheEntry | null {
    if (!this.store) return null;
    try {
      const raw = this.store.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEntry;
      if (parsed && typeof parsed.at === 'number' && parsed.page) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private writeStore(key: string, entry: CacheEntry): void {
    if (!this.store) return;
    try {
      this.store.setItem(key, JSON.stringify(entry));
    } catch {
      /* quota / disabled — degrade to memory-only */
    }
  }

  private removeStore(key: string): void {
    if (!this.store) return;
    try {
      this.store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve the default persistent store at the App edge: sessionStorage when
 * available (browser), else null (SSR / sandbox without storage). Wrapped so a
 * throwing `window.sessionStorage` access (some privacy modes) yields null.
 */
export function defaultKvStore(): KvStore | null {
  try {
    if (typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis) {
      const ss = (globalThis as { sessionStorage?: KvStore }).sessionStorage;
      // Probe it — access can throw in restricted contexts.
      if (ss) {
        const probe = 'gm:cat:__probe__';
        ss.setItem(probe, '1');
        ss.removeItem(probe);
        return ss;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}
