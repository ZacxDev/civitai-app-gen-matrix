// Pure logic for the matrix HISTORY (Release A, change 2). No React, no DOM —
// unit-tested in node (see history.test.ts). `App` wires it to `useAppStorage`,
// the per-viewer KV.
//
// WHY A KEYSPACE INSTEAD OF ONE KEY:
//   Until now the whole feature was a single slot, `gen-matrix:run:v1`, written
//   on every material change, read once on mount and DELETED by "New matrix". So
//   the SECOND matrix a viewer generated destroyed the first, and every run they
//   ever paid for was one click from being unrecoverable. Writing each completed
//   run under its own prefixed key turns the same storage into a list, and
//   `list({ prefix })` is what makes that list readable without knowing the keys.
//
// 🔴 NONE OF THIS WORKS UNTIL THE SCOPES ARE APPROVED. Every call here goes
// through the host's storage procedures, which reject a token lacking
// `apps:storage:read` / `apps:storage:write` with FORBIDDEN. This app declared
// neither until the change that added this module (see src/scopes.ts), and a
// manifest declaration only reaches the token once a moderator has approved a
// version carrying it. Read `loadHistory`'s error branch as the state this app
// is genuinely in on merge — not as a hypothetical.

import { RUN_STORAGE_KEY, restoreStateFromManifest, type RunManifest } from './persistence.js';

/**
 * The prefix every persisted run lives under. `v2` marks the KEYSPACE change
 * (one key per run) — the manifest SHAPE inside is still `RUN_MANIFEST_VERSION`
 * 1, deliberately, so a `v1` blob written by the shipped app restores verbatim.
 */
export const HISTORY_PREFIX = 'gen-matrix:run:v2:';

/**
 * Points at the run the app should REOPEN on mount, or is absent when there is
 * none. Separate from the history rows on purpose: "New matrix" must clear what
 * you are looking at WITHOUT deleting the paid run you were looking at, and a
 * pointer is the only way to distinguish "no active run" from "no runs at all".
 */
export const ACTIVE_RUN_POINTER_KEY = 'gen-matrix:active:v1';

/**
 * How many history rows the UI will show.
 *
 * The list is FETCHED at `HISTORY_LIST_CAP + 1` so the extra row is the evidence
 * that more exist — see `loadHistory`. Keep the two in one place; a cap that is
 * applied in one spot and disclosed from another drifts.
 */
export const HISTORY_LIST_CAP = 12;

/**
 * How many runs are KEPT in storage. Everything older is evicted.
 *
 * 🔴 THE QUOTA IS PER APP, NOT PER VIEWER. The host bills every viewer's rows
 * against one 50 MB budget keyed on `app_block_id`, and a `set` over that cap
 * REJECTS — into a `.catch(() => undefined)`, because a failed save must never
 * interrupt a run someone is paying for. Unbounded growth therefore does not
 * degrade the heavy user who caused it; it silently turns persistence off for
 * EVERY viewer, and nothing on screen says so. A single-slot design could not
 * do that, so keeping every run forever is a shared-fate failure this feature
 * introduced and has to close.
 *
 * Deliberately larger than `HISTORY_LIST_CAP`: the panel shows 12, storage
 * keeps 24, so the "showing your 12 most recent" disclosure stays true and a
 * viewer who raises the cap later still has the rows.
 */
export const HISTORY_RETENTION_CAP = 24;

/** One row of the history index. Values are not fetched — `key` reopens it. */
export interface HistoryEntry {
  key: string;
  updatedAt: Date;
}

/**
 * The outcome of reading the history index.
 *
 * 🔴 `error` IS NOT `ok` WITH ZERO ENTRIES, and the UI must not render them the
 * same way. "You have no past matrices" is a claim about the viewer's data;
 * "we could not read your past matrices" is a claim about the read. Collapsing
 * the second into the first tells a viewer their paid work is gone when it is
 * sitting in storage behind a failed call — which, pre-approval, is exactly the
 * state every viewer is in.
 */
export type HistoryLoad =
  | { kind: 'ok'; entries: HistoryEntry[]; truncated: boolean }
  | { kind: 'error' };

/**
 * The slice of `useAppStorage` this module needs, declared structurally so the
 * pure logic needs no React/SDK import and can be driven by a plain stub in
 * tests — including stubs that REJECT, which the mock host cannot simulate for
 * reads (`MockStorageScenario.failNext` counts down on mutations only).
 */
export interface HistoryStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { key: string; updatedAt: Date }[];
    nextCursor?: string;
  }>;
}

/**
 * Digits in a key's timestamp field. 13 covers every millisecond value from the
 * epoch to the year 2286, which is every timestamp this app can ever mint.
 */
const KEY_STAMP_DIGITS = 13;
/** The value a stamp is subtracted FROM, so bigger times give smaller strings. */
const KEY_STAMP_MAX = 10 ** KEY_STAMP_DIGITS - 1;

/**
 * A run's timestamp, encoded so that LEXICALLY SMALLEST = MOST RECENT.
 *
 * 🔴 THE INVERSION IS THE WHOLE FIX, AND IT IS FORCED BY THE HOST'S QUERY.
 * `storage.list` runs `… AND key > $cursor ORDER BY key LIMIT $limit` — the
 * LIMIT is applied by the database AFTER the ordering but BEFORE anything the
 * client can do, so whatever `ORDER BY key ASC` puts first is what comes back
 * and nothing else exists to sort. Under the previous ISO-8601 key that was the
 * viewer's OLDEST runs: asking for 13 rows returned the thirteen oldest, and
 * re-sorting them descending on the client could only reorder the wrong dozen.
 * Measured with 30 seeded runs, clicking the TOP history row opened run 0.
 *
 * Inverting the stamp makes the host's own ascending scan a newest-first scan,
 * so `LIMIT n` returns the n most recent by construction — no paging, and the
 * "showing your 12 most recent" disclosure becomes true again.
 *
 * Zero-padded to a FIXED width, because lexical order only tracks numeric order
 * when every string is the same length ('999' < '1000' as text).
 */
function invertedStamp(savedAtMs: number): string {
  const ms = Number.isFinite(savedAtMs) ? Math.trunc(savedAtMs) : 0;
  const clamped = Math.min(Math.max(ms, 0), KEY_STAMP_MAX);
  return String(KEY_STAMP_MAX - clamped).padStart(KEY_STAMP_DIGITS, '0');
}

/**
 * The storage key for a run saved at `savedAtMs` — DETERMINISTIC.
 *
 * Derived from the timestamp rather than a counter or a random id so the legacy
 * migration is IDEMPOTENT: re-running it writes the same key rather than minting
 * a second copy of the same run on every mount.
 *
 * 🔴 Being a pure function of the millisecond, it CANNOT be unique for two runs
 * minted in the same one. Use `mintHistoryKey` for a NEW run; this form is for
 * the migration, where determinism is the point and there is exactly one blob.
 */
export function historyKeyFor(savedAtMs: number): string {
  return `${HISTORY_PREFIX}${invertedStamp(savedAtMs)}`;
}

/**
 * A UNIQUE key for a newly-started run.
 *
 * `historyKeyFor` plus a random discriminator: two runs begun in the same
 * millisecond must not collide, because a collision does not fail loudly — the
 * second run's manifest simply OVERWRITES the first one's row, and a matrix the
 * viewer paid for disappears from their history with nothing to indicate it.
 * The discriminator sorts after the stamp, so it never disturbs the ordering
 * between different milliseconds.
 */
export function mintHistoryKey(savedAtMs: number, rand: () => number = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${historyKeyFor(savedAtMs)}.${suffix}`;
}

/**
 * The millisecond a history key encodes, or `null` when it is not one of ours.
 * The inverse of `invertedStamp` — exported so the ordering property is
 * checkable rather than merely asserted in prose.
 */
export function historyKeyTimeMs(key: string): number | null {
  if (!key.startsWith(HISTORY_PREFIX)) return null;
  const stamp = key.slice(HISTORY_PREFIX.length, HISTORY_PREFIX.length + KEY_STAMP_DIGITS);
  if (!/^\d+$/.test(stamp) || stamp.length !== KEY_STAMP_DIGITS) return null;
  return KEY_STAMP_MAX - Number(stamp);
}

/**
 * Read the history index, newest first.
 *
 * Over-fetches by exactly one row: asking for `CAP + 1` and getting more than
 * `CAP` back is the proof that the cap BINDS. Asking for `CAP` and getting `CAP`
 * cannot distinguish "exactly CAP runs" from "hundreds" — a UI built on that
 * would have to either claim truncation it cannot see, or stay silent when it is
 * really hiding rows. Both are dishonest; one extra row settles it.
 *
 * 🔴 THE OVER-FETCH ONLY MEANS THAT BECAUSE THE KEY SORTS NEWEST-FIRST. The host
 * applies its LIMIT after `ORDER BY key` and before the client sees anything, so
 * the rows it returns are decided entirely by the key's order — see
 * `invertedStamp`. Sorting here is by KEY for the same reason: the key is the
 * column the host selected on, so ordering by anything else (an `updatedAt` that
 * a later write can move) would present a page in an order the selection did not
 * use, and the top row would stop being the newest of the page.
 */
export async function loadHistory(storage: HistoryStorage): Promise<HistoryLoad> {
  try {
    const res = await storage.list({
      prefix: HISTORY_PREFIX,
      limit: HISTORY_LIST_CAP + 1,
    });
    const all = (res?.keys ?? []).map((k) => ({ key: k.key, updatedAt: k.updatedAt }));
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const truncated = all.length > HISTORY_LIST_CAP;
    return { kind: 'ok', entries: all.slice(0, HISTORY_LIST_CAP), truncated };
  } catch {
    // No `entries: []` fallback here on purpose — see `HistoryLoad`.
    return { kind: 'error' };
  }
}

/** How many rows one eviction page asks for. */
const EVICT_PAGE_SIZE = 64;
/** A hard bound on eviction paging, so a pathological cursor cannot loop. */
const EVICT_MAX_PAGES = 8;

/**
 * Delete every run past `cap`, oldest first. Returns the keys it removed.
 *
 * Best-effort in the same sense every other write here is — a viewer whose
 * scopes are not approved simply evicts nothing. See `HISTORY_RETENTION_CAP`
 * for why unbounded growth is a shared-fate failure rather than a personal one.
 *
 * 🔴 `protect` IS NOT DECORATION. Eviction walks a list the caller did not
 * build, and the one row that must never be deleted is the run currently on
 * screen. The key ordering already puts it first (it is the newest), but that is
 * a property of the key format — an argument the caller controls is the guard
 * that survives the key format changing again.
 */
export async function evictBeyondRetention(
  storage: HistoryStorage,
  cap: number = HISTORY_RETENTION_CAP,
  protect: readonly (string | null | undefined)[] = [],
): Promise<string[]> {
  const keep = new Set(protect.filter((k): k is string => typeof k === 'string'));
  const deleted: string[] = [];
  try {
    let cursor: string | undefined;
    let seen = 0;
    for (let page = 0; page < EVICT_MAX_PAGES; page += 1) {
      const res = await storage.list({
        prefix: HISTORY_PREFIX,
        limit: EVICT_PAGE_SIZE,
        cursor,
      });
      const keys = res?.keys ?? [];
      if (keys.length === 0) break;
      for (const row of keys) {
        if (seen >= cap && !keep.has(row.key)) {
          await storage.delete(row.key).catch(() => undefined);
          deleted.push(row.key);
        }
        seen += 1;
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
  } catch {
    /* best-effort — a failed eviction must never break the history read */
  }
  return deleted;
}

function timeOf(d: Date | string | number): number {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Result of the one-time `gen-matrix:run:v1` → history migration. */
export interface MigrationResult {
  /** The history key the legacy run now lives under, or null if there was none. */
  key: string | null;
  /** The manifest that was migrated, so the caller can restore it without a re-read. */
  manifest: RunManifest | null;
}

/**
 * Move the single legacy `gen-matrix:run:v1` slot into the history keyspace.
 *
 * 🔴 THE POINT IS THE VIEWER WHO IS MID-RUN WHEN THIS SHIPS. Their in-flight
 * matrix lives in the old slot; a change that simply starts writing somewhere
 * else would strand it — the app would boot into an empty build screen while a
 * run they are paying for sits unreachable in storage. So the legacy blob is
 * copied to its history key, pointed at as the ACTIVE run, and only then is the
 * old key deleted.
 *
 * Best-effort in the same sense the existing writes are: a failure anywhere
 * leaves the legacy key in place (nothing is deleted until the copy resolved)
 * and reports "nothing migrated", so the next mount tries again.
 */
export async function migrateLegacyRun(storage: HistoryStorage): Promise<MigrationResult> {
  const empty: MigrationResult = { key: null, manifest: null };
  let legacy: unknown;
  try {
    legacy = await storage.get(RUN_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (legacy == null || typeof legacy !== 'object') return empty;

  // 🔴 VALIDATE BEFORE COPYING, NOT AFTER. A blob that `restoreStateFromManifest`
  // rejects still copies and deletes perfectly happily — and the result is a
  // history row the viewer can see and click that does NOTHING, forever, because
  // `handleOpenHistory` re-runs the same rejected restore and returns. Worse, the
  // original key is gone by then, so there is nothing left to diagnose. A blob we
  // cannot restore is left exactly where it is and reported as "nothing
  // migrated": no dead row, and no destruction of something a later version might
  // be able to read.
  if (restoreStateFromManifest(legacy) == null) return empty;

  const savedAt = (legacy as { savedAt?: unknown }).savedAt;
  const savedAtMs = typeof savedAt === 'string' ? Date.parse(savedAt) : NaN;
  // A manifest with no usable `savedAt` still deserves rescue — fall back to the
  // epoch so it sorts oldest rather than being dropped on the floor.
  const key = historyKeyFor(Number.isFinite(savedAtMs) ? savedAtMs : 0);

  try {
    await storage.set(key, legacy);
    await storage.set(ACTIVE_RUN_POINTER_KEY, { key });
  } catch {
    // The copy did not land — keep the legacy key exactly where it is.
    return empty;
  }
  // Only now is dropping the original safe. An idempotent delete, and a failed
  // one is harmless: the next mount re-copies to the SAME derived key.
  await storage.delete(RUN_STORAGE_KEY).catch(() => undefined);
  return { key, manifest: legacy as RunManifest };
}

/**
 * A short, timezone-independent age label ("4 min ago").
 *
 * Deliberately NOT `toLocaleString()`. A rendered absolute date pins the test to
 * whatever timezone and locale the runner happens to have — the suite would then
 * be structurally blind to every bug on that dimension, and green for the wrong
 * reason on a machine configured differently from CI.
 */
export function historyAgeLabel(updatedAt: Date | string | number, nowMs: number): string {
  const ms = nowMs - timeOf(updatedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
