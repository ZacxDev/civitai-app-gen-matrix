import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_RUN_POINTER_KEY,
  HISTORY_LIST_CAP,
  HISTORY_PREFIX,
  HISTORY_RETENTION_CAP,
  evictBeyondRetention,
  historyAgeLabel,
  historyKeyFor,
  historyKeyTimeMs,
  loadHistory,
  migrateLegacyRun,
  mintHistoryKey,
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
    // 🔴 MODELS THE HOST'S QUERY EXACTLY, AND THAT IS THE POINT OF THE STUB.
    // civitai's `apps.router` runs `… AND key > $cursor ORDER BY key LIMIT $n`,
    // so the ORDER decides which rows exist before the client sees anything and
    // the LIMIT is applied by the database, not by us. A stub that sliced after
    // sorting descending — i.e. one that quietly "helped" — would make every
    // ordering bug below untestable, because the wrong dozen would never be the
    // dozen returned.
    async list({ prefix = '', limit = 100, cursor } = {}) {
      if (opts.listRejects) throw new Error('FORBIDDEN');
      const all = Object.keys(rows)
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = cursor ? all.findIndex((k) => k > cursor) : 0;
      const page = (start < 0 ? [] : all.slice(start)).slice(0, limit);
      const keys = page.map((key) => ({ key, updatedAt: new Date(keyTime(key)) }));
      const last = page[page.length - 1];
      const hasMore = last !== undefined && all.indexOf(last) < all.length - 1;
      return hasMore ? { keys, nextCursor: last } : { keys };
    },
  };
}

/** Recover the ms a history key encodes, so the stub can stamp `updatedAt`. */
function keyTime(key: string): number {
  return historyKeyTimeMs(key) ?? 0;
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

  it('🔴 returns the NEWEST runs, not the oldest, when far more exist than the cap', async () => {
    // 🔴 THE PANEL SHOWED THE VIEWER'S OLDEST MATRICES WHILE SAYING THEY WERE
    // THE NEWEST. The host applies its LIMIT after `ORDER BY key` and before the
    // client sees anything, so `limit: CAP + 1` returns whichever rows the KEY
    // order puts first — under the old ISO-8601 key that was the CAP+1 OLDEST,
    // and no client-side sort can recover rows that were never sent. Measured
    // with 30 seeded runs, clicking the TOP row opened run 0.
    //
    // 30 is deliberately far more than CAP+1, so the returned set and the
    // correct set are DISJOINT: a mutant that merely reverses the client sort
    // still returns twelve wrong rows and cannot pass by accident.
    const total = 30;
    const start = Date.UTC(2026, 0, 1);
    const load = await loadHistory(stubStorage(seedRuns(total, start)));
    if (load.kind !== 'ok') throw new Error('unreachable');

    const expected = Array.from({ length: HISTORY_LIST_CAP }, (_, i) =>
      historyKeyFor(start + (total - 1 - i) * 60_000),
    );
    expect(load.entries.map((e) => e.key)).toEqual(expected);
    // Named separately because it is the click the audit actually made: the top
    // row must be the most recent matrix, not the first one ever generated.
    expect(load.entries[0].updatedAt.getTime()).toBe(start + (total - 1) * 60_000);
    expect(load.truncated).toBe(true);
  });

  it('orders the page by KEY even when the host hands it back unordered', async () => {
    // The key is the column the host selected on, so it is the only order that
    // agrees with the selection. `updatedAt` moves on any later write — under an
    // `updatedAt` sort, merely re-saving an old run would float it to the top of
    // a page it does not belong at the top of.
    //
    // 🔴 THE STUB DELIBERATELY SCRAMBLES THE PAGE, because the real host's
    // guarantee is what makes the client sort look redundant — and a defensive
    // sort that is never exercised is not a guard, it is a comment. Rows come
    // back REVERSED, with `updatedAt` inverted relative to the keys, so passing
    // the host's order through and sorting on `updatedAt` both produce the wrong
    // answer and only sorting on the key produces the right one.
    const older = historyKeyFor(Date.UTC(2026, 0, 1));
    const newer = historyKeyFor(Date.UTC(2026, 0, 2));
    const storage = stubStorage({ [older]: {}, [newer]: {} });
    const inner = storage.list.bind(storage);
    storage.list = async (o) => {
      const res = await inner(o);
      return {
        ...res,
        keys: [...res.keys]
          .reverse()
          .map((k) => ({
            key: k.key,
            updatedAt: new Date(k.key === newer ? 0 : 9_000_000_000),
          })),
      };
    };

    const load = await loadHistory(storage);
    if (load.kind !== 'ok') throw new Error('unreachable');
    expect(load.entries.map((e) => e.key)).toEqual([newer, older]);
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

  it('🔴 does not mint a DEAD history row from a blob it cannot restore', async () => {
    // 🔴 THE ROW WOULD BE CLICKABLE AND INERT, FOREVER. The old order was copy,
    // point, delete, and only then — at `handleOpenHistory`, days later — did
    // anything try to restore the blob. A manifest that fails validation
    // therefore became a permanent history entry whose button silently did
    // nothing, and the original key was already gone, so there was nothing left
    // to diagnose or recover. Validate first; leave what we cannot read exactly
    // where it is.
    const storage = stubStorage({ [RUN_STORAGE_KEY]: { version: 99, cells: 'not-an-array' } });
    const res = await migrateLegacyRun(storage);

    expect(res).toEqual({ key: null, manifest: null });
    expect(Object.keys(storage.rows).filter((k) => k.startsWith(HISTORY_PREFIX))).toEqual([]);
    expect(storage.rows[ACTIVE_RUN_POINTER_KEY]).toBeUndefined();
    // And it is NOT destroyed: a later version may be able to read it.
    expect(storage.deleted).not.toContain(RUN_STORAGE_KEY);
    expect(storage.rows[RUN_STORAGE_KEY]).toBeTruthy();
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
  it('🔴 sorts NEWEST-FIRST as a string, because the host pages on key order', () => {
    // 🔴 THE INVERSION IS THE FIX, NOT A STYLE CHOICE. `list` runs
    // `ORDER BY key LIMIT n` server-side, so the first n keys in LEXICAL order
    // are the only rows that ever reach the client. Ascending-chronological keys
    // therefore hand back the viewer's OLDEST runs; making the key descend by
    // time turns the host's own scan into a newest-first scan.
    const early = historyKeyFor(Date.UTC(2026, 0, 1));
    const later = historyKeyFor(Date.UTC(2026, 11, 31));
    expect(early.startsWith(HISTORY_PREFIX)).toBe(true);
    expect(later < early).toBe(true);
  });

  it('keeps that order across a digit-count change, because the stamp is padded', () => {
    // Lexical order only tracks numeric order at a FIXED width — unpadded, the
    // inverted stamps '999…' and '1000…' compare the wrong way round. These two
    // times sit either side of a decade boundary in the inverted value.
    const a = historyKeyFor(9_999_999_999_999 - 999);
    const b = historyKeyFor(9_999_999_999_999 - 1_000);
    expect(a < b).toBe(true);
    expect(a.length).toBe(b.length);
  });

  it('is a pure function of the timestamp', () => {
    const spy = vi.spyOn(Date, 'now');
    expect(historyKeyFor(1_000)).toBe(historyKeyFor(1_000));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('round-trips through historyKeyTimeMs, and rejects a foreign key', () => {
    const at = Date.UTC(2026, 6, 4, 13, 45, 12, 345);
    expect(historyKeyTimeMs(historyKeyFor(at))).toBe(at);
    expect(historyKeyTimeMs(mintHistoryKey(at, () => 0.5))).toBe(at);
    expect(historyKeyTimeMs(ACTIVE_RUN_POINTER_KEY)).toBeNull();
    expect(historyKeyTimeMs(`${HISTORY_PREFIX}not-a-stamp`)).toBeNull();
  });
});

describe('mintHistoryKey', () => {
  it('🔴 is UNIQUE for two runs begun in the same millisecond', () => {
    // A collision here does not fail loudly: the second run's manifest simply
    // OVERWRITES the first one's row, and a matrix the viewer paid for vanishes
    // from their history with nothing on screen to indicate it. The deterministic
    // `historyKeyFor` cannot provide this — it is a pure function of the ms — so
    // a new run must not be keyed with it.
    const at = 1_700_000_000_000;
    const seq = [0.1, 0.9];
    let i = 0;
    const a = mintHistoryKey(at, () => seq[i++]);
    const b = mintHistoryKey(at, () => seq[i++]);
    expect(a).not.toBe(b);
    expect(historyKeyFor(at)).toBe(historyKeyFor(at)); // the contrast, stated
  });

  it('still sorts newest-first across different milliseconds', () => {
    // The discriminator must not disturb the ordering it is appended to.
    const older = mintHistoryKey(1_000, () => 0.999);
    const newer = mintHistoryKey(2_000, () => 0.001);
    expect(newer < older).toBe(true);
  });
});

describe('evictBeyondRetention', () => {
  it('🔴 deletes the OLDEST rows past the retention cap and keeps the rest', async () => {
    // 🔴 THE QUOTA IS PER APP, NOT PER VIEWER. Every run minted a permanent row
    // and nothing ever deleted one, so a heavy user's rows could cross the 50 MB
    // app budget and make `set` reject — into a `.catch(() => undefined)` — for
    // EVERY viewer, with nothing on screen saying persistence had stopped.
    const start = Date.UTC(2026, 0, 1);
    const total = HISTORY_RETENTION_CAP + 7;
    const storage = stubStorage(seedRuns(total, start));

    const deleted = await evictBeyondRetention(storage);

    expect(deleted).toHaveLength(7);
    // The seven OLDEST, named exactly — a mutant that trimmed from the other end
    // would also delete seven rows, and would delete the newest matrices.
    const oldest = Array.from({ length: 7 }, (_, i) => historyKeyFor(start + i * 60_000));
    expect(new Set(deleted)).toEqual(new Set(oldest));
    for (const key of oldest) expect(storage.rows[key]).toBeUndefined();
    // And the newest survivor is untouched.
    expect(storage.rows[historyKeyFor(start + (total - 1) * 60_000)]).toBeTruthy();
    expect(Object.keys(storage.rows)).toHaveLength(HISTORY_RETENTION_CAP);
  });

  it('deletes nothing when the viewer is under the cap', async () => {
    const storage = stubStorage(seedRuns(HISTORY_RETENTION_CAP));
    expect(await evictBeyondRetention(storage)).toEqual([]);
    expect(storage.deleted).toEqual([]);
  });

  it('🔴 never deletes a PROTECTED key, however old it is', async () => {
    // Eviction walks a list the caller did not build, and the one row that must
    // survive is the run on screen. The ordering already puts it first — but
    // that is a property of the key FORMAT, and this argument is the guard that
    // outlives the format changing again.
    const start = Date.UTC(2026, 0, 1);
    const rows = seedRuns(HISTORY_RETENTION_CAP + 3, start);
    const oldest = historyKeyFor(start);
    const storage = stubStorage(rows);

    const deleted = await evictBeyondRetention(storage, HISTORY_RETENTION_CAP, [oldest, null]);

    expect(deleted).not.toContain(oldest);
    expect(storage.rows[oldest]).toBeTruthy();
    expect(deleted).toHaveLength(2);
  });

  it('pages past the list limit rather than stopping at the first page', async () => {
    // The eviction page size is smaller than a pathological history, so a
    // single-page implementation would silently stop trimming exactly when the
    // trimming matters most.
    const start = Date.UTC(2026, 0, 1);
    const total = 150;
    const storage = stubStorage(seedRuns(total, start));
    const deleted = await evictBeyondRetention(storage);
    expect(deleted).toHaveLength(total - HISTORY_RETENTION_CAP);
    expect(Object.keys(storage.rows)).toHaveLength(HISTORY_RETENTION_CAP);
  });

  it('is best-effort: a rejected list evicts nothing and does not throw', async () => {
    const storage = stubStorage(seedRuns(HISTORY_RETENTION_CAP + 3), { listRejects: true });
    await expect(evictBeyondRetention(storage)).resolves.toEqual([]);
  });

  it('🔴 never evicts the run the POINTER names, with the empty `protect` the app really passes', async () => {
    // 🔴 THE ARGUMENT WAS THE DOCUMENTED GUARD AND IT WAS INERT. At the app's
    // only eviction call site `protect` is `[currentRunKeyRef.current]`, and
    // that ref is `null` there: it is assigned two awaits deep inside the
    // mount-restore effect, and `handleReset` clears it immediately before
    // bumping the nonce that re-triggers eviction. So this passes `[null]`
    // VERBATIM — a test that handed the function the key it is meant to protect
    // would be testing a call site that does not exist.
    //
    // The scenario is the reachable one: `migrateLegacyRun` keys a blob with an
    // unusable `savedAt` at the EPOCH, which under the inversion is the
    // lexically LAST key — the first row eviction reaches — while being the run
    // the active-run pointer names.
    const start = Date.UTC(2026, 0, 1);
    const rows = seedRuns(HISTORY_RETENTION_CAP + 3, start);
    const activeKey = historyKeyFor(0);
    expect(activeKey, 'the epoch key must be the lexically last one').toBe(
      `${HISTORY_PREFIX}9999999999999`,
    );
    rows[activeKey] = { version: 1, cells: [] };
    rows[ACTIVE_RUN_POINTER_KEY] = { key: activeKey };
    const storage = stubStorage(rows);

    const deleted = await evictBeyondRetention(storage, HISTORY_RETENTION_CAP, [null]);

    expect(deleted, 'the active run was evicted').not.toContain(activeKey);
    expect(storage.rows[activeKey], 'the active run was deleted from storage').toBeTruthy();
  });

  it('🔴 stops instead of deleting EVERY run when the host ignores the cursor it issued', async () => {
    // 🔴 `seen` IS A RUNNING COUNTER ACROSS PAGES. A host that returns a
    // `nextCursor` it does not honour hands page 2 the same rows page 1 already
    // counted — every one of them now sitting past the cap, so the whole page is
    // deleted, newest run included. Measured against the stub below without the
    // progress guard: deleted 150, survivors 0, newest run survived FALSE.
    //
    // The client cannot observe that contract (it is asserted only in prose at
    // `invertedStamp`), and what it loses is irreversible paid work — so the
    // client has to be able to notice the host is not advancing.
    const start = Date.UTC(2026, 0, 1);
    const total = 150;
    const rows = seedRuns(total, start);
    const newest = historyKeyFor(start + (total - 1) * 60_000);
    const deleted: string[] = [];
    const cursorIgnoringHost: HistoryStorage = {
      async get() {
        return null;
      },
      async set() {
        return { ok: true };
      },
      async delete(key: string) {
        deleted.push(key);
        delete rows[key];
        return { ok: true };
      },
      // Honours `prefix` and `limit`, ORDERS correctly, and returns a
      // `nextCursor` — and silently ignores the cursor it is given. Every page
      // is therefore the head of the remaining keyspace.
      async list({ prefix = '', limit = 100 } = {}) {
        const all = Object.keys(rows)
          .filter((k) => k.startsWith(prefix))
          .sort();
        const page = all.slice(0, limit);
        const last = page[page.length - 1];
        const keys = page.map((key) => ({ key, updatedAt: new Date(keyTime(key)) }));
        return last !== undefined && page.length < all.length ? { keys, nextCursor: last } : { keys };
      },
    };

    const removed = await evictBeyondRetention(cursorIgnoringHost, HISTORY_RETENTION_CAP);

    expect(removed, 'the newest run was evicted by a non-advancing host').not.toContain(newest);
    expect(rows[newest], 'the newest run was deleted from storage').toBeTruthy();
    // And the history is not emptied: at least the cap's worth of rows survive.
    expect(Object.keys(rows).length).toBeGreaterThanOrEqual(HISTORY_RETENTION_CAP);
  });
});
