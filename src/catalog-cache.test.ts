import { describe, expect, it } from 'vitest';

import {
  CatalogCache,
  DEFAULT_TTL_MS,
  cacheKey,
  isFresh,
  type KvStore,
} from './catalog-cache.js';
import type { CatalogPage, CatalogQuery } from './catalog-api.js';

// A controllable clock.
function clockAt(ref: { now: number }) {
  return () => ref.now;
}

// An in-memory fake KV store; optionally made to throw to test degradation.
function fakeStore(opts: { throwOnSet?: boolean; throwOnGet?: boolean } = {}): KvStore & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem(k) {
      if (opts.throwOnGet) throw new Error('blocked');
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k, v) {
      if (opts.throwOnSet) throw new Error('quota');
      map.set(k, v);
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

const page = (cursor: string | null = null): CatalogPage => ({ cards: [], nextCursor: cursor });

describe('cacheKey', () => {
  it('is stable + ignores baseModel order and query case/whitespace', () => {
    const a: CatalogQuery = { type: 'LORA', query: ' Anime ', baseModels: ['Pony', 'SDXL 1.0'] };
    const b: CatalogQuery = { type: 'LORA', query: 'anime', baseModels: ['SDXL 1.0', 'Pony'] };
    expect(cacheKey(a)).toBe(cacheKey(b));
  });

  it('differs by type, sort, limit, cursor', () => {
    const base: CatalogQuery = { type: 'LORA' };
    expect(cacheKey({ ...base, type: 'Checkpoint' })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, sort: 'Newest' })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, limit: 50 })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, cursor: 'x' })).not.toBe(cacheKey(base));
  });

  it('differs by the authoritative (scope) dimension so clamped/public views never collide', () => {
    const base: CatalogQuery = { type: 'LORA', query: 'anime' };
    expect(cacheKey(base, true)).not.toBe(cacheKey(base, false));
    expect(cacheKey(base, false)).toBe(cacheKey(base)); // default = public
  });
});

describe('CatalogCache — authoritative scope isolation', () => {
  const q: CatalogQuery = { type: 'LORA', query: 'anime' };

  it('does not serve a public-cached page into an authoritative read (or vice versa)', () => {
    const ref = { now: 0 };
    const cache = new CatalogCache({ clock: clockAt(ref), ttlMs: 1000 });
    cache.set(q, page('public'), false); // public/anon result
    // A signed-in (authoritative) read must MISS the public entry.
    expect(cache.get(q, true)).toBeNull();
    // The public read still hits its own entry.
    expect(cache.get(q, false)?.nextCursor).toBe('public');

    // Now store an authoritative (clamped) result; both coexist independently.
    cache.set(q, page('clamped'), true);
    expect(cache.get(q, true)?.nextCursor).toBe('clamped');
    expect(cache.get(q, false)?.nextCursor).toBe('public');
  });
});

describe('isFresh', () => {
  it('is fresh strictly within the TTL window', () => {
    expect(isFresh({ at: 0, page: page() }, 999, 1000)).toBe(true);
    expect(isFresh({ at: 0, page: page() }, 1000, 1000)).toBe(false); // boundary = expired
    expect(isFresh({ at: 0, page: page() }, 1001, 1000)).toBe(false);
  });
});

describe('CatalogCache (memory + injected store)', () => {
  const q: CatalogQuery = { type: 'LORA', query: 'anime' };

  it('stores + retrieves within TTL, returns null after expiry', () => {
    const ref = { now: 0 };
    const cache = new CatalogCache({ clock: clockAt(ref), ttlMs: 1000 });
    cache.set(q, page('c1'));
    expect(cache.get(q)?.nextCursor).toBe('c1');
    ref.now = 999;
    expect(cache.get(q)?.nextCursor).toBe('c1');
    ref.now = 1000; // expired
    expect(cache.get(q)).toBeNull();
  });

  it('defaults to the 10-minute TTL', () => {
    const ref = { now: 0 };
    const cache = new CatalogCache({ clock: clockAt(ref) });
    cache.set(q, page());
    ref.now = DEFAULT_TTL_MS - 1;
    expect(cache.get(q)).not.toBeNull();
    ref.now = DEFAULT_TTL_MS;
    expect(cache.get(q)).toBeNull();
  });

  it('persists to the injected store and survives a fresh in-memory cache', () => {
    const ref = { now: 0 };
    const store = fakeStore();
    const c1 = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    c1.set(q, page('persisted'));
    // A brand-new cache (simulating a reload) reads the persisted entry.
    const c2 = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    expect(c2.get(q)?.nextCursor).toBe('persisted');
  });

  it('evicts an expired persisted entry on read', () => {
    const ref = { now: 0 };
    const store = fakeStore();
    const c1 = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    c1.set(q, page());
    expect(store.map.size).toBe(1);
    ref.now = 2000;
    const c2 = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    expect(c2.get(q)).toBeNull();
    expect(store.map.size).toBe(0); // removed on expired read
  });

  it('promotes a fresh persisted hit into memory', () => {
    const ref = { now: 0 };
    const store = fakeStore();
    new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 }).set(q, page('p'));
    const c2 = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    expect(c2.get(q)?.nextCursor).toBe('p'); // from store
    store.map.clear(); // wipe the store; memory copy should remain
    expect(c2.get(q)?.nextCursor).toBe('p');
  });

  it('degrades to memory-only when the store throws on set', () => {
    const ref = { now: 0 };
    const store = fakeStore({ throwOnSet: true });
    const cache = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    expect(() => cache.set(q, page('m'))).not.toThrow();
    expect(cache.get(q)?.nextCursor).toBe('m'); // memory still works
    expect(store.map.size).toBe(0);
  });

  it('tolerates a throwing store on get', () => {
    const ref = { now: 0 };
    const store = fakeStore({ throwOnGet: true });
    const cache = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    // memory miss + throwing store → null, no throw
    expect(() => cache.get(q)).not.toThrow();
    expect(cache.get(q)).toBeNull();
  });

  it('ignores corrupt persisted JSON', () => {
    const ref = { now: 0 };
    const store = fakeStore();
    store.map.set(cacheKey(q), '{not json');
    const cache = new CatalogCache({ clock: clockAt(ref), store, ttlMs: 1000 });
    expect(cache.get(q)).toBeNull();
  });

  it('clearMemory drops the memory layer', () => {
    const ref = { now: 0 };
    const cache = new CatalogCache({ clock: clockAt(ref), ttlMs: 1000 });
    cache.set(q, page());
    cache.clearMemory();
    expect(cache.get(q)).toBeNull();
  });

  it('runs memory-only when no store is provided', () => {
    const ref = { now: 0 };
    const cache = new CatalogCache({ clock: clockAt(ref), ttlMs: 1000 });
    cache.set(q, page('x'));
    expect(cache.get(q)?.nextCursor).toBe('x');
  });
});
