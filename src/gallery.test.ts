import { describe, expect, it, vi } from 'vitest';

import {
  GALLERY_DATA_VERSION,
  GALLERY_LIST_CAP,
  KEY_SET_CAP,
  MAX_GALLERY_IMAGES,
  addKeyToSet,
  buildGalleryData,
  collectImageIds,
  columnLabel,
  composeGalleryBody,
  defaultGalleryTitle,
  indexGatedImages,
  keySetBlob,
  loadGallery,
  normalizeGalleryTitle,
  parseGalleryData,
  parseKeySet,
  provenanceLabel,
  isOwnEntry,
  clampRenderedText,
  PUBLISHED_CELLS_CAP,
  MAX_CELL_CANDIDATES,
  BODY_PROMPT_PREFIX,
  addPublishedCells,
  cellPublishKey,
  indexPublishedCells,
  mergeGalleryData,
  parsePublishedCells,
  publishTargetKey,
  publishedCellsBlob,
  unpublishedCells,
  GALLERY_BODY_MAX,
  GALLERY_TITLE_MAX,
  publishMatrix,
  publishResultMessage,
  publishableCells,
  resolveEntryImages,
  rowLabel,
  toGalleryEntry,
  type GalleryEntry,
  type GatedImageLike,
  type PublishableCell,
  type PublishDeps,
  type SharedItemLike,
} from './gallery.js';
import { CHECKPOINTS, MODIFIERS } from './models.js';
import { PROMPT_MAX, buildMatrix, type MatrixCell } from './matrix.js';

// ---------------------------------------------------------------------------
// Fixtures.
//
// 🔴 Every numeric fixture below is pairwise DISTINCT and distinct from any
// constant an assertion names, so a mutant that hardcodes a literal cannot
// coincide with a fixture's own value and survive.
// ---------------------------------------------------------------------------

function cellsFor(rows: number, cols: number): MatrixCell[] {
  return buildMatrix(
    'a lighthouse',
    CHECKPOINTS.slice(0, rows),
    MODIFIERS.slice(0, cols),
  ).map((cell, i) => ({
    ...cell,
    status: 'done' as const,
    workflowId: `wf_${i + 3}`,
    imageUrl: `https://img.example/${i}.jpeg`,
    cost: 7,
  }));
}

function entryWith(images: { imageId: number; row: number; col: number }[]): GalleryEntry {
  return {
    key: 'k_entry',
    authorUserId: 91,
    title: 'A matrix',
    body: null,
    count: 5,
    viewerVoted: false,
    updatedAt: new Date(1_700_000_000_000),
    data: { v: GALLERY_DATA_VERSION, rows: [], cols: [], images },
  };
}

function sharedItem(over: Partial<SharedItemLike> = {}): SharedItemLike {
  return {
    key: 'k_1',
    authorUserId: 91,
    value: {
      title: 'A matrix',
      data: {
        v: GALLERY_DATA_VERSION,
        rows: [{ row: 0, versionId: 4444 }],
        cols: [{ col: 0, key: MODIFIERS[0].key, loraVersionId: null }],
        images: [{ imageId: 777, row: 0, col: 0 }],
      },
    },
    count: 3,
    updatedAt: new Date(1_700_000_000_000),
    viewerVoted: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// parseGalleryData — the untrusted-blob validator.
// ---------------------------------------------------------------------------

describe('parseGalleryData', () => {
  it('reads back what buildGalleryData wrote', () => {
    const cells = cellsFor(2, 2);
    const landed = cells.map((cell, i) => ({ cell, imageId: 500 + i }));
    const parsed = parseGalleryData(buildGalleryData(landed));
    expect(parsed?.images.map((i) => i.imageId)).toEqual([500, 501, 502, 503]);
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.cols).toHaveLength(2);
  });

  it('rejects a payload carrying another schema version', () => {
    const good = {
      v: GALLERY_DATA_VERSION,
      rows: [],
      cols: [],
      images: [{ imageId: 61, row: 0, col: 0 }],
    };
    // Positive control: the identical payload at the CURRENT version parses, so
    // the null below is attributable to the version and nothing else.
    expect(parseGalleryData(good), 'the current-version control must parse').not.toBeNull();
    expect(
      parseGalleryData({ ...good, v: 2 }),
      'gallery-data-version-guard: a payload whose v is not the current schema version must be refused, not half-read',
    ).toBeNull();
    expect(parseGalleryData({ ...good, v: undefined })).toBeNull();
  });

  it('drops an image ref whose imageId is not a positive integer', () => {
    const parsed = parseGalleryData({
      v: GALLERY_DATA_VERSION,
      rows: [],
      cols: [],
      images: [
        { imageId: 0, row: 0, col: 0 },
        { imageId: -9, row: 0, col: 1 },
        { imageId: 1.5, row: 1, col: 0 },
        { imageId: '31', row: 1, col: 1 },
        { imageId: 31, row: 2, col: 2 },
      ],
    });
    expect(
      parsed?.images.map((i) => i.imageId),
      'gallery-imageid-guard: only a POSITIVE integer id survives — 0, a negative, a fraction and a numeric STRING are all dropped',
    ).toEqual([31]);
  });

  it('drops a duplicate imageId rather than painting it twice', () => {
    const parsed = parseGalleryData({
      v: GALLERY_DATA_VERSION,
      rows: [],
      cols: [],
      images: [
        { imageId: 42, row: 0, col: 0 },
        { imageId: 42, row: 1, col: 1 },
        { imageId: 43, row: 1, col: 0 },
      ],
    });
    expect(parsed?.images.map((i) => i.imageId)).toEqual([42, 43]);
  });

  it('clamps a forged giant image list to MAX_GALLERY_IMAGES', () => {
    // 41 refs — deliberately NOT a multiple of the cap, so a mutant that trims to
    // a different bound cannot land on the same length by arithmetic accident.
    const images = Array.from({ length: 41 }, (_, i) => ({ imageId: 1000 + i, row: 0, col: i }));
    const parsed = parseGalleryData({ v: GALLERY_DATA_VERSION, rows: [], cols: [], images });
    expect(
      parsed?.images.length,
      `gallery-image-cap-guard: a forged blob must be clamped to MAX_GALLERY_IMAGES (${MAX_GALLERY_IMAGES}) before it reaches the renderer or the host`,
    ).toBe(MAX_GALLERY_IMAGES);
  });

  it('returns null when no image ref survives, so an entry is never an empty grid', () => {
    expect(
      parseGalleryData({ v: GALLERY_DATA_VERSION, rows: [], cols: [], images: [] }),
      'gallery-empty-guard: an entry with no valid image is not a matrix — an empty grid is what a LOADING grid looks like',
    ).toBeNull();
    expect(parseGalleryData({ v: GALLERY_DATA_VERSION, rows: [], cols: [] })).toBeNull();
    expect(parseGalleryData(null)).toBeNull();
    expect(parseGalleryData('nope')).toBeNull();
  });

  it('survives a hostile blob without throwing', () => {
    expect(() =>
      parseGalleryData({
        v: GALLERY_DATA_VERSION,
        rows: 'not-an-array',
        cols: { col: 1 },
        images: [null, 7, { imageId: 12, row: 0, col: 0 }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Labels — derived from ids, never echoed out of `data`.
// ---------------------------------------------------------------------------

describe('labels', () => {
  it('resolves a curated checkpoint and a curated style by id/key', () => {
    expect(rowLabel({ row: 0, versionId: CHECKPOINTS[0].versionId }, 0)).toBe(CHECKPOINTS[0].label);
    expect(columnLabel({ col: 0, key: MODIFIERS[0].key, loraVersionId: null }, 0)).toBe(
      MODIFIERS[0].label,
    );
  });

  it('never renders a string taken from the unmoderated data blob', () => {
    const hostile = 'FREE BUZZ — click http://evil.example';
    const label = columnLabel({ col: 0, key: hostile, loraVersionId: null }, 4);
    expect(
      label,
      'gallery-label-guard: `data` is client-written and UNMODERATED, so its key is a LOOKUP token only — an unknown key must fall back to a derived label, never be echoed to the screen',
    ).not.toContain('FREE BUZZ');
    expect(label).toBe('Style 5');
    // Same rule on the row axis: an unknown version id becomes a number, and the
    // number is the only thing on screen.
    expect(rowLabel({ row: 0, versionId: 987_654 }, 0)).toBe('Model version 987654');
  });

  it('falls back to the LoRA version id for an unknown LoRA column', () => {
    expect(columnLabel({ col: 1, key: 'lora-picked-321', loraVersionId: 321 }, 1)).toBe('LoRA 321');
  });

  it('labels a missing axis ref from its position', () => {
    expect(rowLabel(undefined, 2)).toBe('Model 3');
    expect(columnLabel(undefined, 0)).toBe('Style 1');
  });
});

// ---------------------------------------------------------------------------
// The moderated text fields.
// ---------------------------------------------------------------------------

describe('moderated text', () => {
  it('offers the run prompt as the default title, clamped and collapsed', () => {
    expect(defaultGalleryTitle('  a  serene   lake ')).toBe('a serene lake');
    expect(defaultGalleryTitle('')).toBe('Untitled matrix');
    expect(defaultGalleryTitle(null)).toBe('Untitled matrix');
    expect(defaultGalleryTitle('x'.repeat(400))).toHaveLength(120);
  });

  it('never lets a blank title through', () => {
    expect(normalizeGalleryTitle('   ')).toBe('Untitled matrix');
    expect(normalizeGalleryTitle('  Kept  ')).toBe('Kept');
  });

  it('omits the body entirely rather than sending an empty one', () => {
    expect(composeGalleryBody('a cat')).toBe('Prompt: a cat');
    expect(composeGalleryBody('   ')).toBeUndefined();
    expect(composeGalleryBody(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// publishableCells.
// ---------------------------------------------------------------------------

describe('publishableCells', () => {
  it('only offers done cells that carry a workflowId', () => {
    const cells = cellsFor(1, 3);
    cells[1] = { ...cells[1], workflowId: null };
    cells[2] = { ...cells[2], status: 'failed' };
    const plan = publishableCells(cells);
    expect(
      plan.map((p) => p.cell.id),
      'gallery-publishable-guard: the host re-derives (viewer, app, workflowId) ownership, so a cell with no workflow has nothing to publish and a non-done cell has no output',
    ).toEqual([cells[0].id]);
  });

  it('returns cells in row-major order and never more than the cap', () => {
    const cells = cellsFor(3, 4).reverse();
    const plan = publishableCells(cells);
    expect(plan.length).toBeLessThanOrEqual(MAX_GALLERY_IMAGES);
    const positions = plan.map((p) => p.cell.row * 10 + p.cell.col);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// ---------------------------------------------------------------------------
// publishMatrix — the write path.
// ---------------------------------------------------------------------------

function planOf(cells: MatrixCell[]): PublishableCell[] {
  return publishableCells(cells);
}

describe('publishMatrix', () => {
  it('publishes each cell by workflowId + index and indexes the ids', async () => {
    const plan = planOf(cellsFor(1, 2));
    const publish = vi.fn<PublishDeps['publish']>(async () => [900]);
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k_new' }));
    const progress: [number, number][] = [];

    const result = await publishMatrix(
      plan,
      { title: 'T', body: 'Prompt: p' },
      { publish, append, update },
      (done, total) => progress.push([done, total]),
    );

    expect(publish).toHaveBeenCalledTimes(2);
    // 🔴 Indexes, never urls: the host resolves the orchestrator url itself.
    expect(publish.mock.calls[0][0]).toEqual({
      workflowId: plan[0].workflowId,
      imageIndexes: [0],
    });
    expect(
      JSON.stringify(publish.mock.calls[0][0]),
      'gallery-publish-payload-guard: the block must send indexes only — a url in the payload would let the iframe inject an arbitrary blob',
    ).not.toContain('http');
    expect(result).toMatchObject({ kind: 'ok', key: 'k_new', published: 2, total: 2 });
    // Found by the sweep's own negative control: this string was asserted
    // NOWHERE, so a mutant that replaced it survived a fully green suite.
    expect(publishResultMessage(result)).toBe('Published 2 images to the gallery.');
    expect(progress.at(-1)).toEqual([2, 2]);
    // The appended `data` carries ids + coordinates and nothing else.
    const appended = append.mock.calls[0][0];
    expect(Object.keys(appended.data as object).sort()).toEqual(['cols', 'images', 'rows', 'v']);
  });

  it('makes no host call at all for an empty plan', async () => {
    const publish = vi.fn<PublishDeps['publish']>(async () => [1]);
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k' }));
    const result = await publishMatrix([], { title: 'T' }, { publish, append, update });
    expect(
      result,
      'gallery-empty-plan-guard: an empty plan is its own honest state — without the guard it falls through to the generic {kind:"failed"}, whose copy reads as a REJECTED request to someone whose only mistake was having no finished cells',
    ).toEqual({ kind: 'empty' });
    // Supporting, not the guard's own observable: the loop makes no call either
    // way when the plan is empty, so this cannot attribute the guard.
    expect(publish.mock.calls.length + append.mock.calls.length).toBe(0);
    expect(publishResultMessage(result)).toContain('nothing to publish yet');
  });

  it('stops publishing after the first rejection instead of stacking dialogs', async () => {
    const plan = planOf(cellsFor(1, 4));
    expect(plan).toHaveLength(4);
    let call = 0;
    const publish = vi.fn<PublishDeps['publish']>(async () => {
      call += 1;
      if (call === 2) throw new Error('not an app developer');
      return [600 + call];
    });
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k_part' }));

    const result = await publishMatrix(plan, { title: 'T' }, { publish, append, update });

    expect(
      publish.mock.calls.length,
      'gallery-publish-stop-guard: each publish opens a host consent dialog, so the loop must STOP at the first rejection rather than ask the viewer to dismiss one per remaining cell',
    ).toBe(2);
    expect(result).toMatchObject({ kind: 'partial', published: 1, total: 4 });
    expect(publishResultMessage(result)).toContain('Published 1 of 4 images');
  });

  it('creates no gallery entry when nothing landed', async () => {
    const plan = planOf(cellsFor(1, 2));
    const publish = vi.fn<PublishDeps['publish']>(async () => {
      throw new Error('publishing is limited to app developers');
    });
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k' }));

    const result = await publishMatrix(plan, { title: 'T' }, { publish, append, update });

    expect(
      append.mock.calls.length,
      'gallery-no-landed-guard: with zero images published there is nothing for an entry to point at, so append must not be called',
    ).toBe(0);
    expect(result).toEqual({
      kind: 'failed',
      error: 'publishing is limited to app developers',
    });
    expect(publishResultMessage(result)).toContain('Nothing was published');
  });

  it('says so out loud when the images landed but the entry did not', async () => {
    const plan = planOf(cellsFor(1, 2));
    const publish = vi.fn<PublishDeps['publish']>(async () => [808]);
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => {
      throw new Error('shared append failed');
    });

    const result = await publishMatrix(plan, { title: 'T' }, { publish, append, update });

    expect(
      result.kind,
      'gallery-orphan-guard: images that were published are REAL public rows with no un-publish, so a failed append is its own state — folding it into a generic failure would tell the author nothing happened',
    ).toBe('orphaned');
    const message = publishResultMessage(result);
    expect(message).toContain('now public on Civitai');
    expect(message).toContain('nothing links to them');
  });

  it('skips a cell whose publish resolved with no usable id, and carries on', async () => {
    const plan = planOf(cellsFor(1, 3));
    let call = 0;
    const publish = vi.fn<PublishDeps['publish']>(async () => {
      call += 1;
      return call === 1 ? [] : [700 + call];
    });
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k_skip' }));

    const result = await publishMatrix(plan, { title: 'T' }, { publish, append, update });

    // A resolve is not a failure, so every remaining cell is still attempted.
    expect(publish).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ kind: 'partial', published: 2, total: 3 });
  });
});

// ---------------------------------------------------------------------------
// loadGallery + toGalleryEntry.
// ---------------------------------------------------------------------------

describe('loadGallery', () => {
  it('maps a failed list to error, never to an empty gallery', async () => {
    const store = {
      list: async () => {
        throw new Error('FORBIDDEN: apps:storage:shared:read');
      },
    };
    const load = await loadGallery(store);
    expect(
      load,
      'gallery-read-error-guard: "we could not read the gallery" and "the gallery is empty" are different facts — until the shared scopes are approved, EVERY viewer is in the first one',
    ).toEqual({ kind: 'error' });
  });

  it('reports an empty gallery as ok-with-no-entries, distinctly', async () => {
    const load = await loadGallery({ list: async () => ({ items: [] }) });
    expect(load).toEqual({ kind: 'ok', entries: [], truncated: false });
  });

  it('drops an item whose data is not a matrix this app wrote', async () => {
    const load = await loadGallery({
      list: async () => ({
        items: [
          sharedItem({ key: 'k_good' }),
          sharedItem({ key: 'k_nodata', value: { title: 'no data' } }),
          sharedItem({ key: 'k_wrongv', value: { title: 'v2', data: { v: 9, images: [] } } }),
        ],
      }),
    });
    expect(load.kind).toBe('ok');
    expect(load.kind === 'ok' && load.entries.map((e) => e.key)).toEqual(['k_good']);
  });

  it('over-fetches by one so `truncated` is a fact rather than a guess', async () => {
    const seen: (number | undefined)[] = [];
    const items = Array.from({ length: GALLERY_LIST_CAP + 1 }, (_, i) =>
      sharedItem({ key: `k_${i}` }),
    );
    const load = await loadGallery({
      list: async (opts) => {
        seen.push(opts?.limit);
        return { items };
      },
    });
    expect(seen).toEqual([GALLERY_LIST_CAP + 1]);
    expect(load.kind === 'ok' && load.entries).toHaveLength(GALLERY_LIST_CAP);
    expect(load.kind === 'ok' && load.truncated).toBe(true);
  });

  it('hydrates viewerVoted from the host rather than defaulting it', () => {
    expect(toGalleryEntry(sharedItem({ viewerVoted: true }))?.viewerVoted).toBe(true);
    expect(toGalleryEntry(sharedItem({ viewerVoted: false }))?.viewerVoted).toBe(false);
  });

  it('treats a blank body as absent', () => {
    const entry = toGalleryEntry(
      sharedItem({ value: { ...sharedItem().value, body: '   ' } }),
    );
    expect(entry?.body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gated read — the id-matching rule.
// ---------------------------------------------------------------------------

describe('gated image resolution', () => {
  it('resolves each cell by imageId, never by position', () => {
    // The host returned them REVERSED and one short. Zipping by index would put
    // image 303 in cell (0,0) and image 301 in cell (1,0).
    const entry = entryWith([
      { imageId: 301, row: 0, col: 0 },
      { imageId: 302, row: 0, col: 1 },
      { imageId: 303, row: 1, col: 0 },
    ]);
    const byId = indexGatedImages([
      { imageId: 303, status: 'visible', url: 'https://img/303', nsfwLevel: 1 },
      { imageId: 301, status: 'visible', url: 'https://img/301', nsfwLevel: 1 },
    ] satisfies GatedImageLike[]);

    const view = resolveEntryImages(entry, byId);
    const at = (row: number, col: number) =>
      view.cells.find((cell) => cell.row === row && cell.col === col);

    expect(
      at(0, 0)?.kind === 'visible' && at(0, 0),
      'gallery-id-match-guard: getImages OMITS ids it cannot resolve, so the reply may be SHORTER and out of order — matching by position paints one entry’s image into another cell and looks perfectly fine',
    ).toMatchObject({ imageId: 301, url: 'https://img/301' });
    expect(at(1, 0)).toMatchObject({ imageId: 303, url: 'https://img/303' });
    // The id the host omitted is `gone`, and it keeps its grid position.
    expect(at(0, 1)).toEqual({ kind: 'gone', imageId: 302, row: 0, col: 1 });
  });

  it('never surfaces a url for an image the host hid from this viewer', () => {
    const entry = entryWith([{ imageId: 404, row: 0, col: 0 }]);
    const view = resolveEntryImages(
      entry,
      indexGatedImages([{ imageId: 404, status: 'hidden' }]),
    );
    // 🔴 The leak assertion goes FIRST, on purpose. Ordered the other way, a
    // mutant that turns a hidden cell into a visible one trips the shape check
    // above and the test goes red for a message that says nothing about urls —
    // which is how a guard ends up "covered" by a test that cannot name it.
    expect(
      JSON.stringify(view.cells[0]),
      'gallery-hidden-guard: a hidden result carries NO url from the host, and the view must not invent one — the block can never obtain an unclamped url for an image this viewer may not see',
    ).not.toContain('http');
    expect(view.cells[0]).toEqual({ kind: 'hidden', imageId: 404, row: 0, col: 0 });
  });

  it('reports allGone only when EVERY image is gone', () => {
    const entry = entryWith([
      { imageId: 501, row: 0, col: 0 },
      { imageId: 502, row: 0, col: 1 },
    ]);
    const noneResolved = resolveEntryImages(entry, indexGatedImages([]));
    const oneResolved = resolveEntryImages(
      entry,
      indexGatedImages([{ imageId: 502, status: 'hidden' }]),
    );
    expect(
      noneResolved.allGone,
      'gallery-allgone-guard: a matrix whose images have ALL been removed must say so — rendering it as an empty grid leaves the viewer waiting for images that will never arrive',
    ).toBe(true);
    expect(
      oneResolved.allGone,
      'gallery-allgone-guard: one surviving image means the grid still has something to show, so allGone must be false',
    ).toBe(false);
  });

  it('exposes the grid shape from the entry coordinates', () => {
    const entry = entryWith([
      { imageId: 601, row: 2, col: 5 },
      { imageId: 602, row: 0, col: 1 },
    ]);
    const view = resolveEntryImages(entry, indexGatedImages([]));
    expect(view.rows).toEqual([0, 2]);
    expect(view.cols).toEqual([1, 5]);
  });

  it('collects every entry id once, in order', () => {
    const ids = collectImageIds([
      entryWith([
        { imageId: 11, row: 0, col: 0 },
        { imageId: 12, row: 0, col: 1 },
      ]),
      entryWith([
        { imageId: 12, row: 0, col: 0 },
        { imageId: 13, row: 0, col: 1 },
      ]),
    ]);
    expect(ids).toEqual([11, 12, 13]);
  });
});

// ---------------------------------------------------------------------------
// The viewer's private key sets.
// ---------------------------------------------------------------------------

describe('private key sets', () => {
  it('reads a forged blob defensively', () => {
    expect(parseKeySet(null)).toEqual([]);
    expect(parseKeySet({ keys: 'nope' })).toEqual([]);
    expect(parseKeySet({ keys: ['a', 1, '', 'a', 'b'] })).toEqual(['a', 'b']);
  });

  it('adds newest-first, deduped and bounded', () => {
    expect(addKeyToSet(['b', 'a'], 'a')).toEqual(['a', 'b']);
    const many = Array.from({ length: KEY_SET_CAP + 7 }, (_, i) => `k${i}`);
    expect(addKeyToSet(many, 'new')).toHaveLength(KEY_SET_CAP);
    expect(addKeyToSet(many, 'new')[0]).toBe('new');
  });

  it('round-trips through the stored shape', () => {
    expect(parseKeySet(keySetBlob(['x', 'y']))).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// F1 — provenance. `authorUserId` is host-stamped; everything else is a guess.
// ---------------------------------------------------------------------------

describe('isOwnEntry', () => {
  const row = { key: 'k_x', authorUserId: 91 };
  const none = new Set<string>();

  it('matches on the host-stamped authorUserId', () => {
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: 91 }, none)).toBe(true);
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: 42 }, none)).toBe(false);
  });

  // 🔴 AN INVARIANT GUARD, NOT A REGRESSION TEST — labelled as one deliberately.
  // Fail-closed on an unknown viewer id is a property of strict equality against
  // a number, so there is no mutation of `isOwnEntry` that breaks it while
  // leaving the function otherwise intact: the sweep proved exactly that by
  // SURVIVING the removal of the belt-and-braces type check that used to sit
  // here. It is kept because the property is load-bearing and someone may later
  // widen `authorUserId`'s type; it is NOT counted as coverage.
  it('[invariant guard] treats an unknown viewer id as owning nothing', () => {
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: null }, none)).toBe(false);
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: undefined }, none)).toBe(false);
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: Number.NaN }, none)).toBe(false);
  });

  it('🔴 owns nothing when signed out, even with a private key saying otherwise', () => {
    expect(
      isOwnEntry(row, { signedIn: false, viewerUserId: 91 }, new Set(['k_x'])),
      'gallery-signedout-own-guard: a sign-out must not leave a stale own-key (or a stale id) offering an enabled Remove that can only reject',
    ).toBe(false);
  });

  it('falls back to the private key set for a same-session row', () => {
    expect(isOwnEntry(row, { signedIn: true, viewerUserId: null }, new Set(['k_x']))).toBe(true);
  });

  it('labels both sides, so no row is left unlabelled', () => {
    // The messaged assertion goes FIRST: ordered the other way, a mutant that
    // breaks BOTH branches trips the unmessaged one and the test goes red
    // without ever naming what it guards.
    expect(
      provenanceLabel(false),
      'gallery-provenance-badge-guard: a stranger’s row must be labelled as one — an unlabelled row in an app’s gallery reads as the app’s own',
    ).toBe('Published by another Civitai member');
    expect(provenanceLabel(true)).toBe('Published by you');
  });

  it('🔴 an unstamped author can never collide with a real viewer id', () => {
    const entry = toGalleryEntry(sharedItem({ authorUserId: undefined as unknown as number }));
    expect(
      entry?.authorUserId,
      'gallery-author-sentinel-guard: the fallback must be an id no Civitai account can hold, or a row the host never stamped could match a real viewer and be labelled "Published by you"',
    ).toBe(-1);
    expect(isOwnEntry({ key: 'k', authorUserId: -1 }, { signedIn: true, viewerUserId: 0 }, new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F2 — a matrix already published must not re-arm the control.
// ---------------------------------------------------------------------------

describe('the per-cell publish ledger', () => {
  const plan = () => publishableCells(cellsFor(1, 3));

  it('🔴 a SUPERSET does not re-arm: only the genuinely new cell is publishable', () => {
    // The shape a "Retry failed" run leaves behind. `RETRY_FAILED` preserves
    // every done cell WITH its id and workflowId, so the publishable set GROWS —
    // and an exact-set key misses, re-arming the button as "Publish 4 images"
    // over three cells that are already public and cannot be un-published.
    const full = plan();
    const publishedFirstTwo = indexPublishedCells(
      full.slice(0, 2).map((item) => ({
        cell: cellPublishKey(item.cell.id, item.workflowId),
        imageId: 400 + item.cell.col,
        entryKey: 'k_entry',
      })),
    );
    expect(
      unpublishedCells(full, publishedFirstTwo).map((i) => i.cell.id),
      'gallery-percell-ledger-guard: the question is per CELL, not per set — a set that GREW must publish only what is new, or a retry republishes every cell that was already public',
    ).toEqual([full[2].cell.id]);
  });

  it('reports nothing left when every cell is in the ledger', () => {
    const full = plan();
    const all = indexPublishedCells(
      full.map((item) => ({
        cell: cellPublishKey(item.cell.id, item.workflowId),
        imageId: 500,
        entryKey: 'k_entry',
      })),
    );
    expect(unpublishedCells(full, all)).toEqual([]);
  });

  it('re-arms for a DIFFERENT matrix', () => {
    const full = plan();
    const other = publishableCells(
      cellsFor(1, 3).map((cell, i) => ({ ...cell, workflowId: `re_${i}` })),
    );
    const ledger = indexPublishedCells(
      full.map((item) => ({
        cell: cellPublishKey(item.cell.id, item.workflowId),
        imageId: 600,
        entryKey: 'k_entry',
      })),
    );
    // Same cell ids, different workflows — a re-run is legitimately publishable.
    expect(unpublishedCells(other, ledger)).toHaveLength(3);
  });

  it('🔴 survives a round-trip through storage, which is what survives a RELOAD', () => {
    const full = plan();
    const rows = full.map((item) => ({
      cell: cellPublishKey(item.cell.id, item.workflowId),
      imageId: 700 + item.cell.col,
      entryKey: 'k_entry',
    }));
    const readBack = parsePublishedCells(publishedCellsBlob(rows));
    expect(
      unpublishedCells(full, indexPublishedCells(readBack)),
      'gallery-ledger-durable-guard: the disarm used to live in useState, so a remount against the same store lost it while the cell ids and workflow ids came back intact — and the next click republished every one of them',
    ).toEqual([]);
  });

  it('reads a forged ledger defensively', () => {
    expect(parsePublishedCells(null)).toEqual([]);
    expect(parsePublishedCells({ cells: 'nope' })).toEqual([]);
    // A record with no usable imageId or entryKey is not a publish record.
    expect(
      parsePublishedCells({
        cells: [
          { cell: 'a@1', imageId: 0, entryKey: 'k' },
          { cell: 'b@2', imageId: 5, entryKey: '' },
          { cell: '', imageId: 5, entryKey: 'k' },
          { cell: 'c@3', imageId: 5, entryKey: 'k' },
        ],
      }).map((r) => r.cell),
    ).toEqual(['c@3']);
  });

  it('adds newest-first, deduped by cell, bounded', () => {
    const many = Array.from({ length: PUBLISHED_CELLS_CAP + 5 }, (_, i) => ({
      cell: `c${i}`,
      imageId: i + 1,
      entryKey: 'k',
    }));
    const next = addPublishedCells(many, [{ cell: 'c0', imageId: 99, entryKey: 'k2' }]);
    expect(next).toHaveLength(PUBLISHED_CELLS_CAP);
    expect(next[0]).toEqual({ cell: 'c0', imageId: 99, entryKey: 'k2' });
    expect(next.filter((r) => r.cell === 'c0')).toHaveLength(1);
  });

  it('resolves the entry to EXTEND, and declines when the prior cells disagree', () => {
    const full = plan();
    const same = indexPublishedCells(
      full.slice(0, 2).map((item) => ({
        cell: cellPublishKey(item.cell.id, item.workflowId),
        imageId: 800,
        entryKey: 'k_one',
      })),
    );
    expect(publishTargetKey(full, same)).toBe('k_one');

    const split = indexPublishedCells([
      { cell: cellPublishKey(full[0].cell.id, full[0].workflowId), imageId: 1, entryKey: 'k_one' },
      { cell: cellPublishKey(full[1].cell.id, full[1].workflowId), imageId: 2, entryKey: 'k_two' },
    ]);
    expect(
      publishTargetKey(full, split),
      'gallery-extend-target-guard: with the prior cells in two different rows there is no single row to extend, so a fresh entry is the honest fallback rather than picking one arbitrarily',
    ).toBeNull();

    expect(publishTargetKey(full, indexPublishedCells([]))).toBeNull();
  });
});

describe('publishMatrix extending an existing entry', () => {
  it('🔴 adds the new cell to the SAME row instead of minting a second one', async () => {
    const full = publishableCells(cellsFor(1, 2));
    const publish = vi.fn<PublishDeps['publish']>(async () => [910]);
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k_new' }));
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const existingData = buildGalleryData([{ cell: full[0].cell, imageId: 900 }]);

    const result = await publishMatrix(
      [full[1]],
      { title: 'ignored', body: 'ignored' },
      { publish, append, update },
      undefined,
      { entryKey: 'k_one', title: 'Original title', body: 'Prompt: p', data: existingData },
    );

    expect(
      append.mock.calls.length,
      'gallery-extend-guard: a second row for one matrix splits its votes and reports across two entries, neither of which shows the grid the viewer actually ran — `update` preserves the key, the vote total and the report total',
    ).toBe(0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe('k_one');
    // The row's OWN moderated text is kept, not overwritten by the live form.
    expect(update.mock.calls[0][1].title).toBe('Original title');
    const merged = update.mock.calls[0][1].data as { images: { imageId: number }[] };
    expect(merged.images.map((i) => i.imageId)).toEqual([900, 910]);
    expect(result).toMatchObject({ kind: 'ok', key: 'k_one', extended: true });
    expect(publishResultMessage(result)).toContain('Added 1 image to this matrix');
  });

  it('reports the images as orphaned when the update fails', async () => {
    const full = publishableCells(cellsFor(1, 2));
    const publish = vi.fn<PublishDeps['publish']>(async () => [911]);
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k' }));
    const update = vi.fn<PublishDeps['update']>(async () => {
      throw new Error('NOT_FOUND');
    });
    const result = await publishMatrix(
      [full[1]],
      { title: 'T' },
      { publish, append, update },
      undefined,
      { entryKey: 'k_gone', title: 'T', data: buildGalleryData([]) },
    );
    expect(result.kind).toBe('orphaned');
    expect(publishResultMessage(result)).toContain('now public on Civitai');
  });

  it('returns the landed pairs so the caller records real image ids', async () => {
    const full = publishableCells(cellsFor(1, 2));
    let call = 0;
    const publish = vi.fn<PublishDeps['publish']>(async () => [920 + ++call]);
    const append = vi.fn<PublishDeps['append']>(async () => ({ key: 'k_l' }));
    const update = vi.fn<PublishDeps['update']>(async () => {});
    const result = await publishMatrix(full, { title: 'T' }, { publish, append, update });
    expect(result.kind === 'ok' && result.landed.map((l) => l.imageId)).toEqual([921, 922]);
    expect(result.kind === 'ok' && result.landed.map((l) => l.cell.id)).toEqual([
      full[0].cell.id,
      full[1].cell.id,
    ]);
  });
});

describe('mergeGalleryData', () => {
  it('keeps the ORIGINAL id when a coordinate is republished', () => {
    const cells = cellsFor(1, 2);
    const existing = buildGalleryData([{ cell: cells[0], imageId: 950 }]);
    const merged = mergeGalleryData(existing, [{ cell: cells[0], imageId: 951 }]);
    // Same coordinate, new id — the original is what viewers may already have
    // voted on and reported, so it stays and the duplicate is not appended.
    expect(merged.images.map((i) => i.imageId)).toEqual([950, 951]);
    expect(merged.rows).toHaveLength(1);
  });

  it('never exceeds the image cap', () => {
    const cells = cellsFor(3, 4);
    const existing = buildGalleryData(cells.map((cell, i) => ({ cell, imageId: 960 + i })));
    const merged = mergeGalleryData(existing, [{ cell: cells[0], imageId: 9999 }]);
    expect(merged.images.length).toBeLessThanOrEqual(MAX_GALLERY_IMAGES);
  });
});

// ---------------------------------------------------------------------------
// F3 — nextCursor is the authority on truncation.
// ---------------------------------------------------------------------------

describe('loadGallery truncation', () => {
  it('🔴 reports truncation from nextCursor even when the page is SHORT', async () => {
    // The failure this closes: a host that clamps `limit` below `cap + 1` returns
    // a full-but-short page, so the length test reads false and viewers silently
    // see a partial gallery.
    const load = await loadGallery({
      list: async () => ({ items: [sharedItem({ key: 'k_only' })], nextCursor: 'more' }),
    });
    expect(
      load.kind === 'ok' && load.truncated,
      'gallery-truncation-guard: `items.length > cap` measures the HOST’S WILLINGNESS TO HONOUR `limit`, not the gallery’s size — nextCursor is documented "absent on the last page", so its presence is the fact',
    ).toBe(true);
  });

  it('still reports truncation from the over-fetch when no cursor is sent', async () => {
    const items = Array.from({ length: GALLERY_LIST_CAP + 1 }, (_, i) => sharedItem({ key: `k_${i}` }));
    const load = await loadGallery({ list: async () => ({ items }) });
    expect(load.kind === 'ok' && load.truncated).toBe(true);
  });

  it('reports no truncation when NEITHER signal fires', async () => {
    const load = await loadGallery({ list: async () => ({ items: [sharedItem()] }) });
    expect(load.kind === 'ok' && load.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F4 — moderated text is bounded on READ, not only on write.
// ---------------------------------------------------------------------------

describe('rendered text bounds', () => {
  it('🔴 never truncates the app’s OWN maximum legal body', () => {
    // The regression this closes: a flat 600 cut an ordinary 700-character
    // prompt — legal, under half the app's own PROMPT_MAX — for every viewer
    // including the author, with no expand control. Before that fix the full
    // body rendered.
    const longestOwnPrompt = 'p'.repeat(PROMPT_MAX);
    const body = composeGalleryBody(longestOwnPrompt);
    expect(body).toBeDefined();
    expect(
      clampRenderedText(body as string, GALLERY_BODY_MAX),
      'gallery-own-body-guard: the read bound must be DERIVED from the write bound the same app enforces — a bound chosen for "long enough for a card" truncates the app’s own content on the happy path',
    ).toBe(body);
    expect(GALLERY_BODY_MAX).toBe(BODY_PROMPT_PREFIX.length + PROMPT_MAX);
  });

  it('still bounds a body from somebody else’s client', () => {
    const entry = toGalleryEntry(
      sharedItem({ value: { ...sharedItem().value, body: 'B'.repeat(GALLERY_BODY_MAX + 500) } }),
    );
    expect(entry?.body?.length).toBe(GALLERY_BODY_MAX + 1);
  });

  it('🔴 slices by CODE POINT, never mid-surrogate-pair', () => {
    // '🜛' is astral (2 UTF-16 code units). A code-unit slice at an odd boundary
    // cuts it in half and renders a lone surrogate.
    const emoji = '🜛';
    const raw = `${'a'.repeat(9)}${emoji}${'b'.repeat(50)}`;
    const cut = clampRenderedText(raw, 10);
    expect(
      cut,
      'gallery-codepoint-guard: String.prototype.slice cuts between the halves of a surrogate pair, so a title whose boundary lands inside an astral emoji renders a lone surrogate',
    ).toBe(`${'a'.repeat(9)}${emoji}…`);
    // No unpaired surrogate survived the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(
      false,
    );
  });

  it('🔴 clamps a title and body written by somebody else’s client', () => {
    const entry = toGalleryEntry(
      sharedItem({
        value: { ...sharedItem().value, title: 'T'.repeat(5000), body: 'B'.repeat(5000) },
      }),
    );
    expect(
      entry?.title.length,
      'gallery-read-bound-guard: this app clamps what IT writes, but SHARED_APPEND is open to any authenticated viewer past min-trust — so every row it READS was written under somebody else’s limits',
    ).toBe(GALLERY_TITLE_MAX + 1); // + the ellipsis that marks the cut
    expect(entry?.body?.length).toBe(GALLERY_BODY_MAX + 1);
    expect(entry?.title.endsWith('…')).toBe(true);
  });

  it('leaves text within the bound untouched', () => {
    expect(clampRenderedText('short', 100)).toBe('short');
    expect(clampRenderedText('abcdef', 3)).toBe('abc…');
  });
});

// ---------------------------------------------------------------------------
// F6 — one image per cell, decided here rather than by the renderer.
// ---------------------------------------------------------------------------

describe('several ids at one coordinate', () => {
  const blob = (images: { imageId: number; row: number; col: number }[]) => ({
    v: GALLERY_DATA_VERSION,
    rows: [],
    cols: [],
    images,
  });

  it('🔴 renders the id the HOST resolved, whichever order the blob listed them', () => {
    // The probe that refuted the previous "first wins" fix: a blob listing an
    // unresolvable id FIRST. Dropping the second id made it worse — the whole
    // entry read as `allGone` — because ordering is attacker-controlled on both
    // sides. Which id the host can resolve is the half an attacker does not
    // control, so that is what decides.
    const parsed = parseGalleryData(
      blob([
        { imageId: 5001, row: 0, col: 0 },
        { imageId: 5002, row: 0, col: 0 },
      ]),
    );
    expect(parsed?.images).toHaveLength(2);
    const entry = { ...entryWith(parsed!.images), data: parsed! };
    const view = resolveEntryImages(
      entry,
      indexGatedImages([
        { imageId: 5002, status: 'visible', url: 'https://img/5002', nsfwLevel: 1 },
      ]),
    );
    expect(view.cells).toHaveLength(1);
    expect(
      view.cells[0],
      'gallery-cell-resolution-guard: with the unresolvable id listed first, keeping only the first candidate painted "No longer available" over an image that was right there — and for a one-cell entry it made the whole row read as gone',
    ).toMatchObject({ kind: 'visible', imageId: 5002 });
    expect(view.allGone).toBe(false);
  });

  it('still resolves when the FIRST candidate is the resolvable one', () => {
    const parsed = parseGalleryData(
      blob([
        { imageId: 5003, row: 0, col: 0 },
        { imageId: 5004, row: 0, col: 0 },
      ]),
    );
    const entry = { ...entryWith(parsed!.images), data: parsed! };
    const view = resolveEntryImages(
      entry,
      indexGatedImages([
        { imageId: 5003, status: 'visible', url: 'https://img/5003', nsfwLevel: 1 },
      ]),
    );
    expect(view.cells[0]).toMatchObject({ kind: 'visible', imageId: 5003 });
  });

  it('reports the cell gone only when NO candidate resolves', () => {
    const parsed = parseGalleryData(
      blob([
        { imageId: 5005, row: 0, col: 0 },
        { imageId: 5006, row: 0, col: 0 },
      ]),
    );
    const entry = { ...entryWith(parsed!.images), data: parsed! };
    const view = resolveEntryImages(entry, indexGatedImages([]));
    expect(view.cells).toHaveLength(1);
    expect(view.allGone).toBe(true);
  });

  it('🔴 bounds candidates per cell so one coordinate cannot hide the grid', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ imageId: 5100 + i, row: 0, col: 0 }));
    const parsed = parseGalleryData(blob([...many, { imageId: 5200, row: 0, col: 1 }]));
    expect(
      parsed?.images.filter((i) => i.col === 0).length,
      'gallery-candidate-cap-guard: without a per-cell cap one coordinate consumes the whole MAX_GALLERY_IMAGES budget and every other cell of the grid is dropped',
    ).toBe(MAX_CELL_CANDIDATES);
    // The other cell survived, which is the point.
    expect(parsed?.images.some((i) => i.imageId === 5200)).toBe(true);
  });
});
