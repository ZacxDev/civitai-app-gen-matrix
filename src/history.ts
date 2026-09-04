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

import { RUN_STORAGE_KEY, type RunManifest } from './persistence.js';

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
 * The storage key for a run saved at `savedAtMs`.
 *
 * DERIVED FROM THE TIMESTAMP, not from a counter or a random id, for two
 * reasons: an ISO-8601 UTC string sorts lexically in chronological order (which
 * is how `list` returns it), and deriving it makes the legacy migration
 * IDEMPOTENT — re-running it writes the same key rather than minting a second
 * copy of the same run on every mount.
 */
export function historyKeyFor(savedAtMs: number): string {
  return `${HISTORY_PREFIX}${new Date(savedAtMs).toISOString()}`;
}

/**
 * Read the history index, newest first.
 *
 * Over-fetches by exactly one row: asking for `CAP + 1` and getting more than
 * `CAP` back is the proof that the cap BINDS. Asking for `CAP` and getting `CAP`
 * cannot distinguish "exactly CAP runs" from "hundreds" — a UI built on that
 * would have to either claim truncation it cannot see, or stay silent when it is
 * really hiding rows. Both are dishonest; one extra row settles it.
 */
export async function loadHistory(storage: HistoryStorage): Promise<HistoryLoad> {
  try {
    const res = await storage.list({
      prefix: HISTORY_PREFIX,
      limit: HISTORY_LIST_CAP + 1,
    });
    const all = (res?.keys ?? []).map((k) => ({ key: k.key, updatedAt: k.updatedAt }));
    // Newest first. `list` sorts ascending by key, and the key embeds the ISO
    // timestamp, so a plain reverse would do — but sorting on `updatedAt` keeps
    // the order correct if the host ever returns rows in another order.
    all.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
    const truncated = all.length > HISTORY_LIST_CAP;
    return { kind: 'ok', entries: all.slice(0, HISTORY_LIST_CAP), truncated };
  } catch {
    // No `entries: []` fallback here on purpose — see `HistoryLoad`.
    return { kind: 'error' };
  }
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
