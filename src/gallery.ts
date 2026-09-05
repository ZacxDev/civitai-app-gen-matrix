// Pure logic for the PUBLISHED-MATRIX GALLERY. No React, no DOM, no host —
// unit-tested in node (see gallery.test.ts). `App` wires it to three host
// surfaces:
//
//   usePublishGenerationOutputs()  the WRITE side: hand the host a workflowId +
//                                  image indexes, get back real `Image` row ids.
//   useSharedStorage()             the INDEX: append/list/get/vote/report/withdraw
//                                  over app-scoped, community-votable entries.
//   useGatedImages()               the READ side: ids → per-VIEWER clamped
//                                  projections (`visible` with a url, `hidden`
//                                  with none).
//
// 🔴 WHY THE ENTRY STORES IMAGE IDS AND NOTHING ELSE ABOUT THE IMAGES.
// A shared entry's `data` is written by a CLIENT and is UNMODERATED — the
// content-safety belt runs on `title`/`body` only. So every byte in `data`
// is a value the publishing client chose, and any safety decision taken from it
// is a safety decision taken by the untrusted side. Persisting a per-image
// `nsfwLevel` was considered and RETRACTED for exactly that reason: a malicious
// client writes `0` for a mature image and the maturity gate is defeated for
// every viewer who reads the entry. Storing ids instead makes the gate the
// PLATFORM's — `getImages` re-derives maturity server-side against the
// REQUESTING viewer's own ceiling, per viewer, unforgeably, and returns no url
// at all for an image that viewer may not see.
//
// The same argument bans urls: a url in `data` is a pointer the client picked,
// so an entry could smuggle an arbitrary image (or an off-platform tracker) into
// a grid the app renders. An id can only ever resolve to a bare, scanned
// `Image` row this app published.
//
// 🔴 AND IT BANS TEXT. `data` is structural app state ONLY — ids, grid
// coordinates, resource version ids. Every user-visible string lives in
// `title`/`body`, which the platform moderates. Nothing in this module renders a
// string that came out of `data`; the label helpers below resolve an id against
// the app's OWN curated tables and otherwise derive a label from numbers.
//
// 🔴 NONE OF THIS WORKS UNTIL THE SCOPES ARE APPROVED. Every shared-storage call
// is re-checked against the token's scopes server-side, and a manifest
// declaration only reaches the token once a moderator has approved a version
// carrying it (see src/scopes.ts). Read `loadGallery`'s error branch as the
// state this app is genuinely in on merge — not as a hypothetical — and note
// that it is deliberately NOT the same value as an empty gallery.

import { MAX_CELLS, PROMPT_MAX, type MatrixCell } from './matrix.js';
import { CHECKPOINTS, MODIFIERS } from './models.js';

/**
 * Schema version of the `data` payload. Bumped on any shape change; a payload
 * carrying anything else is rejected outright rather than half-read, because a
 * half-read grid renders cells in the wrong places.
 */
export const GALLERY_DATA_VERSION = 1 as const;

/**
 * How many gallery entries the panel shows.
 *
 * Fetched at `GALLERY_LIST_CAP + 1` so the extra row is the EVIDENCE that more
 * exist — the same over-fetch `loadHistory` uses, for the same reason: asking
 * for N and getting N cannot distinguish "exactly N" from "hundreds", so a
 * truncation notice built on it would either claim what it cannot see or stay
 * silent while hiding rows.
 */
export const GALLERY_LIST_CAP = 12;

/**
 * Hard bound on images per entry, and on ids sent to `getImages` per entry.
 *
 * `MAX_CELLS` rather than a fresh literal: a matrix cannot exceed the cell cap,
 * so an entry claiming more images than that is corrupt or forged, and a second
 * number here would drift from the one the run path enforces.
 */
export const MAX_GALLERY_IMAGES = MAX_CELLS;

/**
 * How many candidate ids one grid coordinate may carry.
 *
 * A published matrix writes exactly one, so this only ever binds on a forged or
 * hand-edited blob — where its job is to stop a single coordinate consuming the
 * whole `MAX_GALLERY_IMAGES` budget and hiding every other cell.
 */
export const MAX_CELL_CANDIDATES = 3;

/** Hard bound on ids in ONE `getImages` call across every listed entry. */
export const MAX_GATED_IMAGE_IDS = GALLERY_LIST_CAP * MAX_GALLERY_IMAGES;

/** Longest title accepted from the author (the host also enforces its own cap). */
export const GALLERY_TITLE_MAX = 120;

/** The literal `composeGalleryBody` prefixes a body with. */
export const BODY_PROMPT_PREFIX = 'Prompt: ';

/**
 * Longest body rendered from a gallery row.
 *
 * 🔴 THE WRITE BOUND IS NOT A READ BOUND, and that gap was a real defect: this
 * app clamps what IT writes, but `SHARED_APPEND` is open to any authenticated
 * viewer past the min-trust gate (`resolveSharedContext` deliberately does NOT
 * reuse `assertViewerIsAppDeveloper` — that would forbid all general users), so
 * every row this app READS was written by somebody else's client under somebody
 * else's limits. A 5,000-character title is a wall of text in every viewer's
 * gallery. The app applies its own bound to what it renders.
 *
 * 🔴 BUT A READ BOUND CHOSEN WITHOUT LOOKING AT THE WRITE BOUND TRUNCATES YOUR
 * OWN CONTENT, WHICH IS WHAT HAPPENED. This was a flat `600`, picked as "long
 * enough for a card". The app's own textarea admits `PROMPT_MAX` (1500)
 * characters and `composeGalleryBody` prefixes them, so an ordinary 700-character
 * prompt — under half the app's own cap, and entirely legal — produced a
 * 708-character body that this bound then cut, for every viewer including the
 * author, with no expand control. It is now DERIVED: exactly the longest body
 * this app can legally write, so the app's own maximum can never be truncated
 * while a row from somebody else's client still gets bounded.
 */
export const GALLERY_BODY_MAX = BODY_PROMPT_PREFIX.length + PROMPT_MAX;

/**
 * Clamp text read back off the wire, marking the cut so the truncation is
 * visible rather than silent.
 *
 * 🔴 COUNTS CODE POINTS, NOT UTF-16 CODE UNITS. `String.prototype.slice` cuts
 * between the halves of a surrogate pair, so a title whose boundary lands inside
 * an astral emoji renders a lone surrogate (`\uFFFD` in practice). `Array.from`
 * iterates by code point, so a pair is either wholly kept or wholly dropped.
 */
export function clampRenderedText(raw: string, max: number): string {
  const points = Array.from(raw);
  if (points.length <= max) return raw;
  return `${points.slice(0, max).join('')}…`;
}

/**
 * The viewer's OWN gallery keys, in their PRIVATE per-viewer storage.
 *
 * 🔴 THIS IS WHY THE APP NEEDS NO `user:read:self`. Two controls depend on
 * "is this row mine": Withdraw (author-scoped server-side — offering it on
 * someone else's row is offering an error) and Report (the shared control's own
 * contract says render it only for a viewer who does NOT own the row). The
 * obvious way to answer that is a viewer id, which costs a scope; recording the
 * key `append()` minted answers it exactly, for free, out of a scope this app
 * already declares. It is also the only durable answer for Report's `reported`
 * flag, which `SharedListItem` has no field for at all.
 */
export const PUBLISHED_KEYS_STORAGE_KEY = 'gen-matrix:gallery:published:v1';

/** Keys this viewer has already reported — feeds `ReportButton`'s `reported`. */
export const REPORTED_KEYS_STORAGE_KEY = 'gen-matrix:gallery:reported:v1';

/** How many keys either private set retains (newest first). */
export const KEY_SET_CAP = 200;

// ---------------------------------------------------------------------------
// The `data` payload — structural app state, never text, never urls.
// ---------------------------------------------------------------------------

/** One published image, pinned to its cell in the grid. */
export interface GalleryImageRef {
  imageId: number;
  row: number;
  col: number;
}

/** One grid ROW — a checkpoint, identified only by its ids. */
export interface GalleryRowRef {
  row: number;
  versionId: number;
}

/**
 * One grid COLUMN — a style.
 *
 * `key` is the app's own modifier key, kept ONLY as a lookup into the curated
 * `MODIFIERS` table. 🔴 It is never rendered: it is a client-written string in
 * an unmoderated blob, so echoing it would put arbitrary text on screen with no
 * moderation behind it. See `columnLabel`.
 */
export interface GalleryColRef {
  col: number;
  key: string;
  loraVersionId: number | null;
}

/** The whole `data` payload of one gallery entry. */
export interface GalleryData {
  v: typeof GALLERY_DATA_VERSION;
  rows: GalleryRowRef[];
  cols: GalleryColRef[];
  images: GalleryImageRef[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** A finite, non-negative integer — the only numbers this payload may carry. */
function index(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : null;
}

/** A real Civitai row id: a POSITIVE integer. `0` is not an image. */
function rowId(v: unknown): number | null {
  const n = index(v);
  return n != null && n > 0 ? n : null;
}

/**
 * Build the `data` payload for a run whose outputs have just been published.
 *
 * Takes the landed `(cell, imageId)` pairs rather than the whole run, because a
 * partially-published matrix is a real outcome (see `publishMatrix`) and the
 * entry must describe what actually landed, not what was attempted.
 */
export function buildGalleryData(landed: readonly PublishedCell[]): GalleryData {
  const rows = new Map<number, GalleryRowRef>();
  const cols = new Map<number, GalleryColRef>();
  const images: GalleryImageRef[] = [];
  for (const item of landed.slice(0, MAX_GALLERY_IMAGES)) {
    images.push({ imageId: item.imageId, row: item.cell.row, col: item.cell.col });
    if (!rows.has(item.cell.row)) {
      rows.set(item.cell.row, { row: item.cell.row, versionId: item.cell.checkpoint.versionId });
    }
    if (!cols.has(item.cell.col)) {
      cols.set(item.cell.col, {
        col: item.cell.col,
        key: item.cell.modifier.key,
        loraVersionId: item.cell.modifier.loraVersionId ?? null,
      });
    }
  }
  return {
    v: GALLERY_DATA_VERSION,
    rows: [...rows.values()].sort((a, b) => a.row - b.row),
    cols: [...cols.values()].sort((a, b) => a.col - b.col),
    images,
  };
}

/**
 * Fold newly-landed cells into an existing entry's payload.
 *
 * The prior images keep their coordinates, so extending a matrix never moves a
 * cell that was already published; a coordinate republished (which the per-cell
 * ledger normally prevents) keeps the ORIGINAL id, because that is the one
 * viewers may already have voted on and reported.
 */
export function mergeGalleryData(
  existing: GalleryData,
  landed: readonly PublishedCell[],
): GalleryData {
  const fresh = buildGalleryData(landed);
  const seenIds = new Set(existing.images.map((i) => i.imageId));
  const rows = new Map(existing.rows.map((r) => [r.row, r]));
  const cols = new Map(existing.cols.map((col) => [col.col, col]));
  for (const r of fresh.rows) if (!rows.has(r.row)) rows.set(r.row, r);
  for (const col of fresh.cols) if (!cols.has(col.col)) cols.set(col.col, col);
  const images = [...existing.images];
  for (const image of fresh.images) {
    if (seenIds.has(image.imageId)) continue;
    if (images.length >= MAX_GALLERY_IMAGES) break;
    seenIds.add(image.imageId);
    images.push(image);
  }
  return {
    v: GALLERY_DATA_VERSION,
    rows: [...rows.values()].sort((a, b) => a.row - b.row),
    cols: [...cols.values()].sort((a, b) => a.col - b.col),
    images,
  };
}

/**
 * Read a `data` blob back, or `null` when it is not a matrix this app wrote.
 *
 * 🔴 EVERY FIELD IS UNTRUSTED. The blob is client-written and unmoderated, so
 * this is a validator, not a cast: a wrong `v` is rejected outright (a
 * half-understood payload paints cells in the wrong places), a structurally
 * broken image ref is dropped rather than rendered, and the image list is
 * clamped to `MAX_GALLERY_IMAGES` so a forged blob cannot make the app ask the
 * host for ten thousand ids.
 *
 * Returns `null` when no valid image survives: an entry with no resolvable
 * image is not a matrix, and rendering it as an empty grid would look like a
 * grid still loading.
 */
export function parseGalleryData(raw: unknown): GalleryData | null {
  if (!isObj(raw)) return null;
  // 🔴 STRICT VERSION EQUALITY. A blob from a future schema may place cells
  // differently; reading it with today's field meanings is worse than refusing.
  if (raw.v !== GALLERY_DATA_VERSION) return null;

  const images: GalleryImageRef[] = [];
  const seenIds = new Set<number>();
  const perCell = new Map<string, number>();
  const rawImages = Array.isArray(raw.images) ? raw.images : [];
  for (const entry of rawImages) {
    if (images.length >= MAX_GALLERY_IMAGES) break;
    if (!isObj(entry)) continue;
    const imageId = rowId(entry.imageId);
    const row = index(entry.row);
    const col = index(entry.col);
    if (imageId == null || row == null || col == null) continue;
    // A repeated id would ask the host for it twice and paint it twice.
    if (seenIds.has(imageId)) continue;
    // 🔴 SEVERAL IDS MAY SHARE A COORDINATE, AND DROPPING THE EXTRAS WAS NOT A
    // DEFENCE. The previous version kept only the FIRST id at each `(row, col)`
    // and claimed that stopped a forged blob steering what a cell says. It did
    // not: ordering is attacker-controlled on BOTH sides, so a blob listing an
    // unresolvable id first still produced "No longer available" — and for a
    // single-cell entry it was marginally WORSE, because dropping the resolvable
    // id made the whole entry read as `allGone`. The candidates are kept here and
    // `resolveEntryImages` prefers the first one the HOST resolved, which is the
    // half an attacker does not control. Bounded per cell so one coordinate
    // cannot eat the whole image budget and hide the rest of the grid.
    const cell = `${row}:${col}`;
    const seenAtCell = perCell.get(cell) ?? 0;
    if (seenAtCell >= MAX_CELL_CANDIDATES) continue;
    seenIds.add(imageId);
    perCell.set(cell, seenAtCell + 1);
    images.push({ imageId, row, col });
  }
  if (images.length === 0) return null;

  const rows: GalleryRowRef[] = [];
  for (const entry of Array.isArray(raw.rows) ? raw.rows : []) {
    if (rows.length >= MAX_GALLERY_IMAGES) break;
    if (!isObj(entry)) continue;
    const row = index(entry.row);
    const versionId = rowId(entry.versionId);
    if (row == null || versionId == null) continue;
    rows.push({ row, versionId });
  }

  const cols: GalleryColRef[] = [];
  for (const entry of Array.isArray(raw.cols) ? raw.cols : []) {
    if (cols.length >= MAX_GALLERY_IMAGES) break;
    if (!isObj(entry)) continue;
    const col = index(entry.col);
    if (col == null) continue;
    cols.push({
      col,
      // Kept as an opaque lookup token; `columnLabel` never echoes it.
      key: typeof entry.key === 'string' ? entry.key : '',
      loraVersionId: rowId(entry.loraVersionId),
    });
  }

  return { v: GALLERY_DATA_VERSION, rows, cols, images };
}

// ---------------------------------------------------------------------------
// Labels — derived from ids, NEVER echoed out of `data`.
// ---------------------------------------------------------------------------

const CURATED_CHECKPOINT_LABELS = new Map(CHECKPOINTS.map((c) => [c.versionId, c.label]));
const CURATED_MODIFIER_LABELS = new Map(MODIFIERS.map((m) => [m.key, m.label]));

/**
 * A row's display label.
 *
 * Resolved against the app's own curated checkpoint table when the version is
 * one this app ships; otherwise DERIVED from the number ("Model 12345"). A
 * picked resource's real name is not available here and is deliberately not
 * stored — a name is text, and text belongs in the moderated fields.
 */
export function rowLabel(ref: GalleryRowRef | undefined, position: number): string {
  if (ref == null) return `Model ${position + 1}`;
  return CURATED_CHECKPOINT_LABELS.get(ref.versionId) ?? `Model version ${ref.versionId}`;
}

/**
 * A column's display label.
 *
 * 🔴 THE KEY IS A LOOKUP, NOT A LABEL. `ref.key` came out of an unmoderated
 * client-written blob, so it is only ever used to `get` from the app's own
 * curated table. An unknown key falls back to the LoRA's version id, and then to
 * the column's position — both derived from numbers this module validated.
 */
export function columnLabel(ref: GalleryColRef | undefined, position: number): string {
  if (ref == null) return `Style ${position + 1}`;
  const curated = CURATED_MODIFIER_LABELS.get(ref.key);
  if (curated != null) return curated;
  if (ref.loraVersionId != null) return `LoRA ${ref.loraVersionId}`;
  return `Style ${position + 1}`;
}

// ---------------------------------------------------------------------------
// The moderated text fields.
// ---------------------------------------------------------------------------

/**
 * The default title offered to the author — the run's shared prompt, clamped.
 *
 * This is TEXT, so it goes in `title`, which the platform moderates. The author
 * can replace it before publishing.
 */
export function defaultGalleryTitle(sharedPrompt: string | null | undefined): string {
  const trimmed = (sharedPrompt ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'Untitled matrix';
  return trimmed.slice(0, GALLERY_TITLE_MAX);
}

/** Clamp an author-supplied title; an all-whitespace title falls back. */
export function normalizeGalleryTitle(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'Untitled matrix';
  return trimmed.slice(0, GALLERY_TITLE_MAX);
}

/**
 * The moderated long-form body — the prompt every cell in the matrix shares.
 *
 * Returns `undefined` (not `''`) when there is no prompt: an empty body renders
 * as a blank line that reads like a prompt nobody typed, and the field is
 * optional precisely so it can be absent.
 */
export function composeGalleryBody(sharedPrompt: string | null | undefined): string | undefined {
  const trimmed = (sharedPrompt ?? '').trim();
  if (trimmed.length === 0) return undefined;
  return `Prompt: ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Publishing.
// ---------------------------------------------------------------------------

/** A cell that can be published: finished, billed, and backed by a workflow. */
export interface PublishableCell {
  cell: MatrixCell;
  workflowId: string;
}

/** A cell whose output the host turned into a real `Image` row. */
export interface PublishedCell {
  cell: MatrixCell;
  imageId: number;
}

/**
 * The cells of a run that can be published, in row-major order.
 *
 * A cell qualifies only when it is `done` AND carries a `workflowId`: the host
 * re-derives `(viewer, app, workflowId)` ownership server-side, so a cell with
 * no workflow has nothing to publish, and a non-`done` cell has no output.
 */
export function publishableCells(cells: readonly MatrixCell[]): PublishableCell[] {
  const out: PublishableCell[] = [];
  for (const cell of cells) {
    if (cell.status !== 'done') continue;
    const workflowId = cell.workflowId;
    if (workflowId == null || workflowId.length === 0) continue;
    if (out.length >= MAX_GALLERY_IMAGES) break;
    out.push({ cell, workflowId });
  }
  return out.sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col);
}

/**
 * The durable identity of ONE publishable cell: which cell, and which workflow
 * produced the output. Both survive a reload (`persistence.ts` sanitises `id`
 * and `workflowId` back out of the run manifest).
 */
export function cellPublishKey(cellId: string, workflowId: string): string {
  return `${cellId}@${workflowId}`;
}

/**
 * What this viewer has already published, per cell.
 *
 * 🔴 THIS REPLACES A SESSION-HELD SIGNATURE OF THE WHOLE PUBLISHABLE SET, WHICH
 * FAILED TWO WAYS, BOTH MEASURED, BOTH CREATING DUPLICATE PERMANENT PUBLIC
 * IMAGES:
 *
 *  - **A superset re-armed it.** A grid with 3 `done` + 1 `failed` reaches
 *    `phase === 'done'`, so Publish and "Retry failed" are offered together.
 *    Publish the 3; retry the 4th; `RETRY_FAILED` preserves every done cell WITH
 *    its id and workflowId, so the set becomes 4, the exact-set key misses, the
 *    button re-arms as "Publish 4 images" — and republishes all four.
 *  - **A reload re-armed it.** The signature lived in `useState`, so remounting
 *    against the same storage lost it entirely while the cell ids and workflow
 *    ids came back intact.
 *
 * The question is per CELL, not per set — "has this `(cellId, workflowId)` been
 * published by this viewer?" — and the answer has to outlive the session, so it
 * lives in the viewer's own private KV alongside the other gallery bookkeeping.
 * `entryKey` is what lets a later publish EXTEND the matrix's existing gallery
 * row instead of minting a second one for the same grid.
 */
export const PUBLISHED_CELLS_STORAGE_KEY = 'gen-matrix:gallery:cells:v1';

/** How many per-cell publish records are retained (newest first). */
export const PUBLISHED_CELLS_CAP = 200;

export interface PublishedCellRecord {
  /** `cellPublishKey(cellId, workflowId)`. */
  cell: string;
  /** The `Image` row the host created for it. */
  imageId: number;
  /** The gallery entry that carries it. */
  entryKey: string;
}

/** Read the per-cell publish ledger defensively — it is a JSON blob like any other. */
export function parsePublishedCells(raw: unknown): PublishedCellRecord[] {
  if (!isObj(raw)) return [];
  const rows = raw.cells;
  if (!Array.isArray(rows)) return [];
  const out: PublishedCellRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= PUBLISHED_CELLS_CAP) break;
    if (!isObj(row)) continue;
    const cell = typeof row.cell === 'string' ? row.cell : null;
    const imageId = rowId(row.imageId);
    // 🔴 An EMPTY entryKey is not a usable entry reference — it would make
    // `publishTargetKey` resolve to `''` and send `update('')` at the host. The
    // length check is the guard; `typeof` alone lets it through.
    const entryKey =
      typeof row.entryKey === 'string' && row.entryKey.length > 0 ? row.entryKey : null;
    if (cell == null || cell.length === 0 || imageId == null || entryKey == null) continue;
    if (seen.has(cell)) continue;
    seen.add(cell);
    out.push({ cell, imageId, entryKey });
  }
  return out;
}

/** Add records, newest-first, deduped by cell, bounded. Pure. */
export function addPublishedCells(
  existing: readonly PublishedCellRecord[],
  added: readonly PublishedCellRecord[],
): PublishedCellRecord[] {
  const addedKeys = new Set(added.map((r) => r.cell));
  return [...added, ...existing.filter((r) => !addedKeys.has(r.cell))].slice(
    0,
    PUBLISHED_CELLS_CAP,
  );
}

/** The stored shape of the ledger. */
export function publishedCellsBlob(rows: readonly PublishedCellRecord[]): {
  cells: PublishedCellRecord[];
} {
  return { cells: [...rows] };
}

/** Index a ledger by cell key. */
export function indexPublishedCells(
  rows: readonly PublishedCellRecord[],
): Map<string, PublishedCellRecord> {
  return new Map(rows.map((r) => [r.cell, r]));
}

/**
 * The cells of `plan` this viewer has NOT already published.
 *
 * This is what a Publish click acts on, so a retry that adds a fourth cell
 * publishes ONE image rather than four.
 */
export function unpublishedCells(
  plan: readonly PublishableCell[],
  published: ReadonlyMap<string, PublishedCellRecord>,
): PublishableCell[] {
  return plan.filter(
    (item) => !published.has(cellPublishKey(item.cell.id, item.workflowId)),
  );
}

/**
 * The gallery entry this matrix's already-published cells live in, or `null`
 * when none of them have been published (or they disagree).
 *
 * 🔴 EXTEND, DON'T MINT A SECOND ROW. Publishing the one retried cell of a 2×2
 * as its OWN gallery entry would leave two rows for one matrix — a 3-cell grid
 * and a 1-cell grid, with the votes and reports split between them and neither
 * showing what the viewer actually ran. `update` is author-scoped and preserves
 * the key, the vote total and the report total, which is exactly the semantics
 * this needs. When the prior cells disagree about their entry (a withdrawn row,
 * a ledger carried across a republish) there is no single row to extend, so a
 * new one is the honest fallback.
 */
export function publishTargetKey(
  plan: readonly PublishableCell[],
  published: ReadonlyMap<string, PublishedCellRecord>,
): string | null {
  const keys = new Set<string>();
  for (const item of plan) {
    const record = published.get(cellPublishKey(item.cell.id, item.workflowId));
    if (record != null) keys.add(record.entryKey);
  }
  return keys.size === 1 ? [...keys][0] : null;
}

/** The host calls `publishMatrix` needs. Structural, so tests need no SDK. */
export interface PublishDeps {
  publish(args: { workflowId: string; imageIndexes?: number[]; title?: string }): Promise<number[]>;
  append(value: { title: string; body?: string; data?: unknown }): Promise<{ key: string }>;
  /** Author-scoped in-place update — preserves the key, votes and reports. */
  update(key: string, value: { title: string; body?: string; data?: unknown }): Promise<void>;
}

/** An existing gallery row to EXTEND rather than duplicate. */
export interface PublishTarget {
  entryKey: string;
  /** The row's own moderated text — kept, not overwritten with the current form. */
  title: string;
  body?: string;
  /** The images already in the row, so the merge preserves them. */
  data: GalleryData;
}

/** What one publish attempt ended as. */
export type PublishResult =
  /** Nothing was publishable — no host call was made and nothing was spent. */
  | { kind: 'empty' }
  /**
   * Every cell landed and the gallery entry exists.
   *
   * `landed` carries the actual `(cell, imageId)` pairs rather than leaving the
   * caller to infer them from `published` as a prefix of the plan. The prefix
   * reasoning was correct but fragile — it depends on the loop's stop-and-skip
   * behaviour staying exactly as it is — and the caller needs the real image ids
   * for its durable per-cell ledger anyway.
   */
  | {
      kind: 'ok';
      key: string;
      published: number;
      total: number;
      landed: PublishedCell[];
      extended?: true;
    }
  /** Some cells landed; the entry describes exactly those. */
  | {
      kind: 'partial';
      key: string;
      published: number;
      total: number;
      error: string;
      landed: PublishedCell[];
      extended?: true;
    }
  /** No image landed, so no entry was created. */
  | { kind: 'failed'; error: string }
  /**
   * 🔴 Images WERE published — they are real, public `Image` rows now — but the
   * gallery entry could not be created, so nothing points at them and the author
   * has no Withdraw to press. There is no un-publish, so this state exists to be
   * SAID OUT LOUD rather than folded into a generic failure.
   */
  | { kind: 'orphaned'; published: number; total: number; error: string };

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return fallback;
}

/**
 * Publish a finished matrix and index it in the shared gallery.
 *
 * ONE `publish()` CALL PER CELL, SEQUENTIALLY, and that is forced by the host
 * contract rather than chosen: `publish` takes a single `workflowId`, and in
 * this app every cell IS its own workflow. Each call opens the host's consent
 * confirm, so they cannot be fired in parallel without stacking dialogs on the
 * viewer, and the first rejection stops the loop rather than asking them to
 * dismiss a dialog per remaining cell.
 *
 * Indexes, never urls: the block sends `imageIndexes: [0]` (a cell has exactly
 * one output) and the host resolves the orchestrator url itself from the
 * ownership-verified workflow.
 *
 * @param onProgress called before each cell's publish, so the UI can say which
 *                   confirm the viewer is looking at.
 */
export async function publishMatrix(
  plan: readonly PublishableCell[],
  meta: { title: string; body?: string },
  deps: PublishDeps,
  onProgress?: (done: number, total: number) => void,
  target?: PublishTarget | null,
): Promise<PublishResult> {
  // 🔴 An empty plan is its OWN state, and the guard is what makes it one.
  // Measured by removing it: the loop simply never runs, so nothing is
  // published and nothing is appended either way — what changes is the ANSWER.
  // Without the guard this falls through to `{kind:'failed'}`, whose copy is
  // "Nothing was published. no image could be published" — a rejected-request
  // reading, offered to someone whose only mistake was having no finished cells.
  // (The earlier version of this comment claimed the guard stopped an `append()`
  // of an image-less entry. It does not: `landed.length === 0` already does
  // that, and the mutation sweep is what showed the claim was wrong.)
  if (plan.length === 0) return { kind: 'empty' };

  const landed: PublishedCell[] = [];
  let failure: string | null = null;
  for (const [i, item] of plan.entries()) {
    onProgress?.(i, plan.length);
    let ids: number[];
    try {
      ids = await deps.publish({ workflowId: item.workflowId, imageIndexes: [0] });
    } catch (err) {
      failure = errorText(err, 'the host refused to publish this image');
      break;
    }
    const imageId = ids.find((id) => rowId(id) != null);
    // A resolve carrying no usable id published nothing for this cell. Skip it
    // and carry on — unlike a rejection, the host did not fail.
    if (imageId == null) continue;
    landed.push({ cell: item.cell, imageId });
  }
  onProgress?.(landed.length, plan.length);

  if (landed.length === 0) {
    return { kind: 'failed', error: failure ?? 'no image could be published' };
  }

  let key: string;
  const extended = target != null;
  try {
    if (target != null) {
      // Extend the matrix's existing row. Its OWN title/body are re-sent, not the
      // current form's — the author already chose them, and `update` replaces the
      // whole value.
      await deps.update(target.entryKey, {
        title: target.title,
        ...(target.body !== undefined ? { body: target.body } : {}),
        data: mergeGalleryData(target.data, landed),
      });
      key = target.entryKey;
    } else {
      const appended = await deps.append({
        title: meta.title,
        ...(meta.body !== undefined ? { body: meta.body } : {}),
        data: buildGalleryData(landed),
      });
      key = appended.key;
    }
  } catch (err) {
    return {
      kind: 'orphaned',
      published: landed.length,
      total: plan.length,
      error: errorText(
        err,
        extended
          ? 'the existing gallery entry could not be updated'
          : 'the gallery entry could not be saved',
      ),
    };
  }

  if (failure != null || landed.length < plan.length) {
    return {
      kind: 'partial',
      key,
      published: landed.length,
      total: plan.length,
      error: failure ?? 'some images could not be published',
      landed: [...landed],
      ...(extended ? { extended: true as const } : {}),
    };
  }
  return {
    kind: 'ok',
    key,
    published: landed.length,
    total: plan.length,
    landed: [...landed],
    ...(extended ? { extended: true as const } : {}),
  };
}

/**
 * The single line shown after a publish attempt.
 *
 * Centralised so the wording of the two states that are easy to get wrong —
 * "some of it landed" and "the images exist but the entry does not" — cannot
 * drift into reading like a clean success.
 */
export function publishResultMessage(result: PublishResult): string {
  switch (result.kind) {
    case 'empty':
      return 'There is nothing to publish yet — finish a matrix first.';
    case 'ok':
      return result.extended === true
        ? `Added ${result.published} ${result.published === 1 ? 'image' : 'images'} to this matrix’s gallery entry.`
        : `Published ${result.published} ${result.published === 1 ? 'image' : 'images'} to the gallery.`;
    case 'partial':
      return `Published ${result.published} of ${result.total} images. The gallery entry shows the ones that landed. ${result.error}`;
    case 'orphaned':
      return `${result.published} ${result.published === 1 ? 'image is' : 'images are'} now public on Civitai, but the gallery entry could not be saved, so nothing links to them. ${result.error}`;
    case 'failed':
      return `Nothing was published. ${result.error}`;
  }
}

// ---------------------------------------------------------------------------
// Reading the gallery.
// ---------------------------------------------------------------------------

/** The slice of one `useSharedStorage().list()` item this module reads. */
export interface SharedItemLike {
  key: string;
  authorUserId: number;
  value: { title: string; body?: string; data?: unknown };
  count: number;
  updatedAt: Date;
  viewerVoted: boolean;
}

/** The slice of `useSharedStorage()` this module needs. */
export interface GalleryStore {
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    items: SharedItemLike[];
    nextCursor?: string;
  }>;
}

/** One gallery entry, validated. */
export interface GalleryEntry {
  key: string;
  authorUserId: number;
  /** Moderated. */
  title: string;
  /** Moderated. `null` when the entry carries none. */
  body: string | null;
  count: number;
  viewerVoted: boolean;
  updatedAt: Date;
  data: GalleryData;
}

/**
 * 🔴 `error` IS NOT `ok` WITH ZERO ENTRIES.
 *
 * "No one has published a matrix yet" is a claim about the gallery's contents;
 * "we could not read the gallery" is a claim about the read. Collapsing the
 * second into the first tells every viewer the gallery is empty during exactly
 * the period when it is not readable — which, until the shared-storage scopes
 * are approved, is every viewer, every time. The app already draws this
 * distinction for private history (`HistoryLoad`); it is not regressed here.
 */
export type GalleryLoad =
  | { kind: 'ok'; entries: GalleryEntry[]; truncated: boolean }
  | { kind: 'error' };

/** Validate one shared item into a gallery entry, or drop it. */
export function toGalleryEntry(item: SharedItemLike): GalleryEntry | null {
  if (item == null || typeof item.key !== 'string' || item.key.length === 0) return null;
  const value = item.value;
  if (!isObj(value) || typeof value.title !== 'string') return null;
  const data = parseGalleryData(value.data);
  if (data == null) return null;
  const rawBody =
    typeof value.body === 'string' && value.body.trim().length > 0 ? value.body : null;
  return {
    key: item.key,
    // 🔴 `-1` is deliberately an id no Civitai account can hold, so a row whose
    // author the host did not stamp can never coincide with a real viewer's id
    // and be labelled "Published by you". See `isOwnEntry`.
    authorUserId: typeof item.authorUserId === 'number' ? item.authorUserId : -1,
    // Bounded on READ, not just on write — see `GALLERY_BODY_MAX`.
    title: clampRenderedText(value.title, GALLERY_TITLE_MAX),
    body: rawBody == null ? null : clampRenderedText(rawBody, GALLERY_BODY_MAX),
    count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 0,
    viewerVoted: item.viewerVoted === true,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt : new Date(0),
    data,
  };
}

/**
 * Read the gallery index, newest-first (the host's own `list` ordering).
 *
 * 🔴 `nextCursor` IS THE AUTHORITY ON TRUNCATION; THE OVER-FETCH IS A BACKSTOP.
 * This used to derive `truncated` purely from `items.length > cap` after asking
 * for `cap + 1`, which measures the HOST'S WILLINGNESS TO HONOUR `limit`, not
 * the gallery's size: a host that caps `limit` at or below `cap` returns a full
 * page, the length test reads `false`, the notice never renders, and viewers
 * silently see a partial gallery — the exact silent omission the over-fetch was
 * built to prevent, reached from the other side. `SharedListResult.nextCursor`
 * is documented "absent on the last page", so its PRESENCE is the fact.
 *
 * Both signals are kept and OR-ed. They fail in opposite directions — a host
 * that always sends a cursor over-warns, a host that clamps `limit` under-warns
 * — so requiring either to fire is the only combination that cannot go silent.
 *
 * Entries whose `data` does not validate are DROPPED, not rendered: a shared
 * store is a cross-user surface, so a blob written by something that is not this
 * app must not reach the renderer.
 */
export async function loadGallery(
  store: GalleryStore,
  cap: number = GALLERY_LIST_CAP,
): Promise<GalleryLoad> {
  let items: SharedItemLike[];
  let truncated: boolean;
  try {
    const res = await store.list({ limit: cap + 1 });
    const all = res?.items ?? [];
    truncated = res?.nextCursor != null || all.length > cap;
    items = all.slice(0, cap);
  } catch {
    // No `entries: []` fallback here on purpose — see `GalleryLoad`.
    return { kind: 'error' };
  }
  const entries: GalleryEntry[] = [];
  for (const item of items) {
    const entry = toGalleryEntry(item);
    if (entry != null) entries.push(entry);
  }
  return { kind: 'ok', entries, truncated };
}

// ---------------------------------------------------------------------------
// Provenance — what the app can actually PROVE about who published a row.
// ---------------------------------------------------------------------------

/**
 * Is this row the VIEWER's own?
 *
 * 🔴 THE APP CANNOT PROVE APP-AUTHORSHIP, AND IT USED TO CLAIM IT. The gallery
 * header said "Grids the app author has published", which is false: creating the
 * IMAGES is cohort-gated (`assertViewerIsAppDeveloper`, civitai
 * `src/server/routers/blocks.router.ts:3632`) but creating the shared ENTRY is
 * not — `resolveSharedContext` (`src/server/routers/apps-shared.router.ts:161`)
 * deliberately does not reuse that assert, because copying it "would FORBID all
 * general users". Its write path asks only for an approved block token, the
 * shared-write scope, a fail-closed kill-switch, an authenticated subject and a
 * min-trust gate.
 *
 * So any authenticated viewer past min-trust can `append`. And because
 * `getImages` resolves images THE APP published — not "images this viewer
 * published" — a non-author can read a genuine entry's ids straight out of the
 * gallery and append their own row carrying the same ids. It renders REAL
 * images. Under a header asserting app-authorship that is impersonation, not a
 * cosmetic provenance slip.
 *
 * `authorUserId` is stamped by the HOST, not by the writing client, so it is the
 * one provenance fact here that cannot be forged. The viewer's own id comes from
 * the slot context (`PageSlotContext.viewerUserId`) — free, and NOT the
 * `@deprecated` `ViewerInfo.id`/`useViewer()` path, so no `user:read:self`.
 *
 * 🔴 FAIL-CLOSED ON AN UNKNOWN VIEWER. With no id to compare, nothing is "yours":
 * Withdraw is author-scoped server-side, so offering it wrongly guarantees an
 * error, while withholding it costs a viewer one refresh. `ownKeys` (the rows
 * this viewer's own private storage says they published) is a supplement for the
 * same-session case, never a substitute — and it is gated on `signedIn` so a
 * sign-out cannot leave a stale key offering an enabled Remove.
 */
export function isOwnEntry(
  entry: Pick<GalleryEntry, 'key' | 'authorUserId'>,
  viewer: { signedIn: boolean; viewerUserId: number | null | undefined },
  ownKeys: ReadonlySet<string>,
): boolean {
  if (!viewer.signedIn) return false;
  // 🔴 FAIL-CLOSED COMES FROM STRICT EQUALITY, NOT FROM A TYPE CHECK. This line
  // used to read `typeof id === 'number' && Number.isFinite(id) && … === id`.
  // The mutation sweep showed that clause SURVIVED, and it was right to: with
  // `authorUserId` already a number (`toGalleryEntry` guarantees it), `=== id`
  // returns false for `null`, `undefined`, `NaN` and a numeric STRING alike —
  // measured across all five — so the extra clause could never change the
  // answer. An unreachable guard that reads as coverage is worse than none,
  // because it stops the next person looking; it is deleted rather than kept
  // and re-described.
  if (entry.authorUserId === viewer.viewerUserId) return true;
  return ownKeys.has(entry.key);
}

/**
 * The provenance label for one row — rendered on EVERY row, deliberately.
 *
 * Showing a badge only on your own rows leaves every other row unlabelled, and
 * an unlabelled row in a gallery is read as the app's own. Labelling both sides
 * is what stops a stranger's entry from inheriting the app's voice.
 */
export function provenanceLabel(isOwn: boolean): string {
  return isOwn ? 'Published by you' : 'Published by another Civitai member';
}

// ---------------------------------------------------------------------------
// The gated read.
// ---------------------------------------------------------------------------

/** The slice of `BlockGatedImage` this module reads. Mirrors the SDK union. */
export type GatedImageLike =
  | { imageId: number; status: 'visible'; url: string; nsfwLevel: number }
  | { imageId: number; status: 'hidden' };

/**
 * Index gated images BY ID.
 *
 * 🔴 THE HOST OMITS IDS IT CANNOT RESOLVE, so the returned array may be SHORTER
 * than the one asked for and its order carries no meaning. Zipping by index
 * would silently paint image B into image A's cell — the one bug in this whole
 * feature that produces a plausible-looking wrong answer rather than a visible
 * error. A map keyed on `imageId` cannot do that.
 */
export function indexGatedImages(
  images: readonly GatedImageLike[],
): Map<number, GatedImageLike> {
  const byId = new Map<number, GatedImageLike>();
  for (const image of images) {
    if (image == null || typeof image.imageId !== 'number') continue;
    byId.set(image.imageId, image);
  }
  return byId;
}

/** Every image id the listed entries reference, deduped and bounded. */
export function collectImageIds(entries: readonly GalleryEntry[]): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const entry of entries) {
    for (const image of entry.data.images) {
      if (ids.length >= MAX_GATED_IMAGE_IDS) return ids;
      if (seen.has(image.imageId)) continue;
      seen.add(image.imageId);
      ids.push(image.imageId);
    }
  }
  return ids;
}

/** One rendered cell of a gallery entry's grid. */
export type GalleryCellView =
  | { kind: 'visible'; imageId: number; row: number; col: number; url: string; nsfwLevel: number }
  /** Withheld from THIS viewer by the host's per-viewer clamp. Carries no url. */
  | { kind: 'hidden'; imageId: number; row: number; col: number }
  /** The host could not resolve the id at all — removed, or never resolvable. */
  | { kind: 'gone'; imageId: number; row: number; col: number };

export interface GalleryEntryView {
  cells: GalleryCellView[];
  /** Distinct row indexes, ascending — the grid's shape. */
  rows: number[];
  /** Distinct column indexes, ascending. */
  cols: number[];
  /**
   * Every image in this entry is `gone`.
   *
   * 🔴 Rendered as its own honest state, never as an empty grid: an empty grid
   * is what a grid still loading looks like, so collapsing the two tells a
   * viewer to keep waiting for images that will never arrive.
   */
  allGone: boolean;
}

/**
 * Resolve one entry's images against the host's per-viewer projection.
 *
 * Matches on `imageId`. An id the host omitted is `gone` — NOT skipped, because
 * the cell still occupies a position in the grid and a silently missing cell
 * shifts every other cell's meaning.
 */
export function resolveEntryImages(
  entry: GalleryEntry,
  byId: ReadonlyMap<number, GatedImageLike>,
): GalleryEntryView {
  // One view per COORDINATE. A coordinate may carry several candidate ids (see
  // `MAX_CELL_CANDIDATES`); the one that gets rendered is the first the HOST
  // resolved, which is the half of the decision an attacker does not control.
  // Listing an unresolvable id first therefore no longer forces "No longer
  // available" over an image that is right there.
  const byCell = new Map<string, GalleryImageRef[]>();
  for (const image of entry.data.images) {
    const key = `${image.row}:${image.col}`;
    const at = byCell.get(key);
    if (at == null) byCell.set(key, [image]);
    else at.push(image);
  }
  const cells: GalleryCellView[] = [...byCell.values()].map((candidates) => {
    const chosen = candidates.find((c) => byId.has(c.imageId)) ?? candidates[0];
    const found = byId.get(chosen.imageId);
    if (found == null) {
      return { kind: 'gone', imageId: chosen.imageId, row: chosen.row, col: chosen.col };
    }
    if (found.status === 'visible') {
      return {
        kind: 'visible',
        imageId: chosen.imageId,
        row: chosen.row,
        col: chosen.col,
        url: found.url,
        nsfwLevel: found.nsfwLevel,
      };
    }
    return { kind: 'hidden', imageId: chosen.imageId, row: chosen.row, col: chosen.col };
  });
  const rows = [...new Set(cells.map((cell) => cell.row))].sort((a, b) => a - b);
  const cols = [...new Set(cells.map((cell) => cell.col))].sort((a, b) => a - b);
  return {
    cells,
    rows,
    cols,
    allGone: cells.length > 0 && cells.every((cell) => cell.kind === 'gone'),
  };
}

// ---------------------------------------------------------------------------
// The viewer's private key sets (own entries / reported entries).
// ---------------------------------------------------------------------------

/** Read a persisted key set defensively — it is a JSON blob like any other. */
export function parseKeySet(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const keys = raw.keys;
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (out.length >= KEY_SET_CAP) break;
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Add a key, newest-first, deduped, bounded. Pure — returns a new array. */
export function addKeyToSet(existing: readonly string[], key: string): string[] {
  const next = [key, ...existing.filter((k) => k !== key)];
  return next.slice(0, KEY_SET_CAP);
}

/** The stored shape of a key set. */
export function keySetBlob(keys: readonly string[]): { keys: string[] } {
  return { keys: [...keys] };
}
