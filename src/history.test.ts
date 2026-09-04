import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_RUN_POINTER_KEY,
  HISTORY_LIST_CAP,
  HISTORY_PREFIX,
  historyAgeLabel,
  historyKeyFor,
  loadHistory,
  migrateLegacyRun,
  type HistoryStorage,
} from './history.js';
import { RUN_STORAGE_KEY } from './persistence.js';

/**
 * A stub `useAppStorage`. Hand-rolled rather than driven through the mock host
 * because the host CANNOT simulate the case that matters most here: its
 * `MockStorageScenario.failNext` counts down on MUTATIONS only, so there is no
 * way to make a READ reject through it — and a failing read is precisely the
 * state this app is in until its new storage scopes are approved.
 */
function stubStorage(
  rows: Record<string, unknown> = {},
  opts: { listRejects?: boolean; getRejects?: boolean; setRejects?: boolean } = {},
): HistoryStorage & { rows: Record<string, unknown>; deleted: string[] } {
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    async get(key: string) {
      if (opts.getRejects) throw new Error('FORBIDDEN');
      return (rows[key] ?? null) as never;
    },
    async set(key: string, value: unknown) {
      if (opts.setRejects) throw new Error('FORBIDDEN');
      rows[key] = value;
      return { ok: true };
    },
    async delete(key: string) {
      deleted.push(key);
      delete rows[key];
      return { ok: true, deleted: true };
    },
    async list({ prefix = '', limit = 100 } = {}) {
      if (opts.listRejects) throw new Error('FORBIDDEN');
      const keys = Object.keys(rows)
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key, updatedAt: new Date(keyTime(key)) }));
      return { keys };
    },
  };
}

/** Recover the ms a history key encodes, so the stub can stamp `updatedAt`. */
function keyTime(key: string): number {
  const iso = key.slice(HISTORY_PREFIX.length);
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** N history rows, oldest first, one minute apart. */
function seedRuns(n: number, startMs = Date.UTC(2026, 0, 1)): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) {
    rows[historyKeyFor(startMs + i * 60_000)] = { version: 1, cells: [] };
  }
  return rows;
}

describe('loadHistory', () => {
  it('returns an empty, NON-error list when the viewer has no matrices', async () => {
    const load = await loadHistory(stubStorage({}));
    expect(load).toEqual({ kind: 'ok', entries: [], truncated: false });
  });

  it('is the ordinary empty state for an anonymous viewer, not an error', async () => {
    // The host resolves `list` EMPTY for an anon viewer rather than rejecting.
    // Pinned separately from the case above because the two arrive by different
    // routes and only one of them may ever become an error.
    const anonStorage = stubStorage({});
    const load = await loadHistory(anonStorage);
    expect(load.kind).toBe('ok');
  });

  it('lists saved runs newest first', async () => {
    const rows = seedRuns(3);
    const load = await loadHistory(stubStorage(rows));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('unreachable');

    const times = load.entries.map((e) => e.updatedAt.getTime());
    expect(load.entries).toHaveLength(3);
    // Strictly descending — a stable-but-wrong order (e.g. the host's ascending
    // key order passed through) would put the viewer's oldest matrix on top.
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });

  it('only lists keys under the history prefix', async () => {
    const rows = { ...seedRuns(2), 'gen-matrix:something-else': { x: 1 }, [ACTIVE_RUN_POINTER_KEY]: { key: 'k' } };
    const load = await loadHistory(stubStorage(rows));
    if (load.kind !== 'ok') throw new Error('unreachable');
    expect(load.entries).toHaveLength(2);
    for (const e of load.entries) expect(e.key.startsWith(HISTORY_PREFIX)).toBe(true);
  });

  it('does NOT claim truncation when the cap is exactly filled', async () => {
    // 🔴 The "a cap that never binds must not claim to" half. Exactly CAP rows
    // is the boundary a naive `length >= CAP` test gets wrong, and it is the
    // most likely real population for a heavy user — so the false notice would
    // show to exactly the people who read it most carefully.
    const load = await loadHistory(stubStorage(seedRuns(HISTORY_LIST_CAP)));
    if (load.kind !== 'ok') throw new Error('unreachable');
    expect(load.entries).toHaveLength(HISTORY_LIST_CAP);
    expect(load.truncated).toBe(false);
  });

  it('reports truncation, and still returns exactly the cap, when it binds', async () => {
    const load = await loadHistory(stubStorage(seedRuns(HISTORY_LIST_CAP + 5)));
    if (load.kind !== 'ok') throw new Error('unreachable');
    expect(load.truncated).toBe(true);
    // The over-fetched probe row must not leak into what is rendered.
    expect(load.entries).toHaveLength(HISTORY_LIST_CAP);
  });

  it('distinguishes a FAILED read from an empty one', async () => {
    // 🔴 THE LOAD-BEARING DISTINCTION. `{kind:'error'}` and `{kind:'ok',
    // entries:[]}` must never be the same value, because the UI renders one as
    // "you have no matrices" — a claim about the viewer's data — and the other
    // as "we could not look". Until this app's storage scopes are approved
    // every real viewer is in the error case.
    const load = await loadHistory(stubStorage(seedRuns(3), { listRejects: true }));
    expect(load).toEqual({ kind: 'error' });
    expect(load).not.toHaveProperty('entries');
  });
});

describe('migrateLegacyRun', () => {
  const legacy = { version: 1, savedAt: '2026-01-02T03:04:05.000Z', perCellEstimate: 8, cells: [] };

  it('does nothing when there is no legacy run', async () => {
    const storage = stubStorage(seedRuns(1));
    const res = await migrateLegacyRun(storage);
    expect(res).toEqual({ key: null, manifest: null });
    expect(storage.deleted).toEqual([]);
  });

  it('copies the legacy run into history, points at it, and drops the old key', async () => {
    // 🔴 THE VIEWER WHO IS MID-RUN WHEN THIS SHIPS. Their matrix lives in the
    // single old slot; without this they boot to an empty build screen while a
    // run they paid for sits unreachable.
    const storage = stubStorage({ [RUN_STORAGE_KEY]: legacy });
    const res = await migrateLegacyRun(storage);

    const expectedKey = historyKeyFor(Date.parse(legacy.savedAt));
    expect(res.key).toBe(expectedKey);
    expect(res.manifest).toEqual(legacy);
    expect(storage.rows[expectedKey]).toEqual(legacy);
    // Pointed at, so the app REOPENS it rather than merely filing it away.
    expect(storage.rows[ACTIVE_RUN_POINTER_KEY]).toEqual({ key: expectedKey });
    // And the old slot is gone, so the migration does not repeat forever.
    expect(storage.deleted).toContain(RUN_STORAGE_KEY);
    expect(storage.rows[RUN_STORAGE_KEY]).toBeUndefined();
  });

  it('is idempotent: re-running writes the SAME key, never a second copy', async () => {
    const storage = stubStorage({ [RUN_STORAGE_KEY]: legacy });
    await migrateLegacyRun(storage);
    // Put the legacy key back to simulate a delete that never landed.
    storage.rows[RUN_STORAGE_KEY] = legacy;
    await migrateLegacyRun(storage);

    const historyKeys = Object.keys(storage.rows).filter((k) => k.startsWith(HISTORY_PREFIX));
    expect(historyKeys).toHaveLength(1);
  });

  it('KEEPS the legacy key when the copy fails — never deletes what it could not save', async () => {
    // The failure ordering is the whole safety property: a delete that ran
    // before a failed write would destroy the run outright.
    const storage = stubStorage({ [RUN_STORAGE_KEY]: legacy }, { setRejects: true });
    const res = await migrateLegacyRun(storage);
    expect(res).toEqual({ key: null, manifest: null });
    expect(storage.deleted).not.toContain(RUN_STORAGE_KEY);
    expect(storage.rows[RUN_STORAGE_KEY]).toEqual(legacy);
  });

  it('rescues a legacy run whose savedAt is unusable rather than dropping it', async () => {
    const storage = stubStorage({ [RUN_STORAGE_KEY]: { version: 1, cells: [], savedAt: 'not-a-date' } });
    const res = await migrateLegacyRun(storage);
    expect(res.key).toBe(historyKeyFor(0));
    expect(storage.rows[res.key!]).toBeTruthy();
  });
});

describe('historyAgeLabel', () => {
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);

  it('formats each magnitude without a locale or timezone dependency', () => {
    // 🔴 Deliberately not `toLocaleString`. A rendered absolute date would pin
    // this suite to the runner's timezone, making it structurally blind to
    // every bug on that dimension and green for the wrong reason elsewhere.
    expect(historyAgeLabel(new Date(base - 5_000), base)).toBe('just now');
    expect(historyAgeLabel(new Date(base - 4 * 60_000), base)).toBe('4 min ago');
    expect(historyAgeLabel(new Date(base - 3 * 3_600_000), base)).toBe('3 h ago');
    expect(historyAgeLabel(new Date(base - 2 * 86_400_000), base)).toBe('2 d ago');
  });

  it('does not render a negative age from a clock that ran backwards', () => {
    expect(historyAgeLabel(new Date(base + 60_000), base)).toBe('just now');
  });
});

describe('historyKeyFor', () => {
  it('produces prefixed keys that sort chronologically as strings', () => {
    // The property `list` relies on: it returns keys in lexical order, so the
    // key has to encode time in a form where lexical order IS time order.
    const early = historyKeyFor(Date.UTC(2026, 0, 1));
    const later = historyKeyFor(Date.UTC(2026, 11, 31));
    expect(early.startsWith(HISTORY_PREFIX)).toBe(true);
    expect(early < later).toBe(true);
  });

  it('is a pure function of the timestamp', () => {
    const spy = vi.spyOn(Date, 'now');
    expect(historyKeyFor(1_000)).toBe(historyKeyFor(1_000));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
