import { describe, expect, it } from 'vitest';

import {
  buildMatrix,
  matrixReducer,
  initialMatrixState,
  type CellStatus,
  type MatrixCell,
  type MatrixState,
} from './matrix.js';
import {
  RUN_MANIFEST_VERSION,
  type AppWorkflowLike,
  appWorkflowStatusToCell,
  buildRunManifest,
  isPersistableRun,
  reconcileCells,
  restoreStateFromManifest,
  shouldBlurResult,
} from './persistence.js';
import type { CheckpointOption, ModifierOption } from './models.js';

const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'A', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'B', baseModel: 'SDXL 1.0' },
];
const mods: ModifierOption[] = [
  { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null },
  { key: 'cine', label: 'Cine', promptSuffix: 'cinematic', loraVersionId: null },
];

/** Set a cell's status/workflowId for fixtures. */
function withStatus(cell: MatrixCell, status: CellStatus, over: Partial<MatrixCell> = {}): MatrixCell {
  return { ...cell, status, ...over };
}

function runningState(cells: MatrixCell[], perCellEstimate: number | null = 8): MatrixState {
  return { phase: 'running', cells, perCellEstimate };
}

// ---------------------------------------------------------------------------
// isPersistableRun
// ---------------------------------------------------------------------------

describe('isPersistableRun', () => {
  it('is false while still building (nothing to survive a reload)', () => {
    expect(isPersistableRun(initialMatrixState)).toBe(false);
    expect(isPersistableRun({ ...initialMatrixState, phase: 'confirming' })).toBe(false);
  });
  it('is true once running/done with cells', () => {
    const cells = buildMatrix('a cat', ckpts, mods);
    expect(isPersistableRun(runningState(cells))).toBe(true);
    expect(isPersistableRun({ phase: 'done', cells, perCellEstimate: 8 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRunManifest / restoreStateFromManifest — the M1 round-trip
// ---------------------------------------------------------------------------

describe('run manifest round-trip (M1)', () => {
  it('serializes cells + estimate + a version stamp', () => {
    const cells = buildMatrix('a cat', ckpts, mods);
    const m = buildRunManifest(runningState(cells, 12), () => 0);
    expect(m.version).toBe(RUN_MANIFEST_VERSION);
    expect(m.perCellEstimate).toBe(12);
    expect(m.cells).toHaveLength(4);
    expect(m.savedAt).toBe(new Date(0).toISOString());
  });

  it('restore rebuilds a fully-done matrix verbatim as phase=done', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]); // 2 cells
    const done = base.map((c, i) =>
      withStatus(c, 'done', { workflowId: `wf_${i}`, imageUrl: `img_${i}`, cost: 8 }),
    );
    const restored = restoreStateFromManifest(buildRunManifest({ phase: 'done', cells: done, perCellEstimate: 8 }));
    expect(restored).not.toBeNull();
    expect(restored!.phase).toBe('done');
    expect(restored!.cells.every((c) => c.status === 'done')).toBe(true);
    expect(restored!.cells.map((c) => c.cost)).toEqual([8, 8]);
  });

  it('MONEY-SAFETY: an un-submitted (idle/estimating, no workflowId) cell restores as canceled — NEVER auto-runs', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]); // 2 cells
    const cells = [
      withStatus(base[0], 'done', { workflowId: 'wf_0', imageUrl: 'i', cost: 8 }),
      withStatus(base[1], 'idle'), // interrupted before it ever submitted
    ];
    const restored = restoreStateFromManifest(buildRunManifest(runningState(cells)))!;
    // The never-submitted cell must NOT be resumable — it becomes canceled (0 spend).
    const idleCell = restored.cells.find((c) => c.id === base[1].id)!;
    expect(idleCell.status).toBe('canceled');
    // Nothing is re-pollable → the run is already done, so the queue never fires.
    expect(restored.phase).toBe('done');
  });

  it('a still-in-flight SUBMITTED cell restores as polling (recover by re-poll, no re-charge) → phase running', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const cells = [
      withStatus(base[0], 'polling', { workflowId: 'wf_0' }),
      withStatus(base[1], 'submitting', { workflowId: 'wf_1' }), // got an id → recoverable
    ];
    const restored = restoreStateFromManifest(buildRunManifest(runningState(cells)))!;
    expect(restored.cells.every((c) => c.status === 'polling')).toBe(true);
    expect(restored.phase).toBe('running');
  });

  it('a timedout cell restores verbatim (its own recheck path handles it)', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const cells = [
      withStatus(base[0], 'done', { workflowId: 'wf_0', imageUrl: 'i', cost: 8 }),
      withStatus(base[1], 'timedout', { workflowId: 'wf_1' }),
    ];
    const restored = restoreStateFromManifest(buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 }))!;
    expect(restored.cells.find((c) => c.id === base[1].id)!.status).toBe('timedout');
  });

  it('returns null for a missing / malformed / wrong-version manifest', () => {
    expect(restoreStateFromManifest(null)).toBeNull();
    expect(restoreStateFromManifest(undefined)).toBeNull();
    expect(restoreStateFromManifest({})).toBeNull();
    expect(restoreStateFromManifest({ version: 999, cells: [] })).toBeNull();
    expect(restoreStateFromManifest({ version: RUN_MANIFEST_VERSION, cells: 'nope' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileCells (M1/M2) — merge against the useAppWorkflows read-model
// ---------------------------------------------------------------------------

describe('reconcileCells (M1/M2)', () => {
  const wf = (
    workflowId: string,
    status: AppWorkflowLike['status'],
    over: Partial<AppWorkflowLike> = {},
  ): AppWorkflowLike => ({ workflowId, status, images: [], cost: null, ...over });

  it('adopts a server-terminal outcome for a still-polling cell (recovers a gen that finished while closed)', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const cells = [withStatus(base[0], 'polling', { workflowId: 'wf_0' })];
    const { cells: out, resumableIds } = reconcileCells(cells, [
      wf('wf_0', 'succeeded', { images: [{ url: 'done.jpg', nsfwLevel: 1 }], cost: 8 }),
    ]);
    expect(out[0].status).toBe('done');
    expect(out[0].imageUrl).toBe('done.jpg');
    expect(out[0].cost).toBe(8);
    expect(out[0].nsfwLevel).toBe(1);
    expect(resumableIds).toHaveLength(0);
  });

  it('reports a still-running workflow as resumable and marks the cell polling (M2)', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const cells = [withStatus(base[0], 'timedout', { workflowId: 'wf_0' })];
    const { cells: out, resumableIds } = reconcileCells(cells, [wf('wf_0', 'processing')]);
    expect(out[0].status).toBe('polling');
    expect(resumableIds).toEqual([base[0].id]);
  });

  it('ENRICHES a terminal cell (fills nsfwLevel for the maturity gate) but NEVER downgrades its status', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    // A cell finalized from a live poll snapshot: done + image, but nsfwLevel unknown.
    const cells = [withStatus(base[0], 'done', { workflowId: 'wf_0', imageUrl: 'live.jpg', cost: 8, nsfwLevel: null })];
    const { cells: out } = reconcileCells(cells, [
      wf('wf_0', 'succeeded', { images: [{ url: 'read-model.jpg', nsfwLevel: 4 }], cost: 8 }),
    ]);
    expect(out[0].status).toBe('done'); // unchanged
    expect(out[0].imageUrl).toBe('live.jpg'); // keeps its own url
    expect(out[0].nsfwLevel).toBe(4); // BUT gains the maturity level it lacked
  });

  it('does NOT downgrade a locally-known insufficient cell to a generic failed', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const cells = [withStatus(base[0], 'insufficient', { workflowId: 'wf_0', error: 'insufficient buzz' })];
    const { cells: out } = reconcileCells(cells, [wf('wf_0', 'failed')]);
    expect(out[0].status).toBe('insufficient'); // richer local classification preserved
  });

  it('leaves a cell with no workflowId, or one absent from the read-model, untouched', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0], mods[1]]);
    const cells = [
      withStatus(base[0], 'canceled'), // no workflowId
      withStatus(base[1], 'polling', { workflowId: 'gone' }), // not in the read-model
    ];
    const { cells: out } = reconcileCells(cells, [wf('other', 'succeeded')]);
    expect(out[0].status).toBe('canceled');
    expect(out[1].status).toBe('polling');
  });

  it('appWorkflowStatusToCell maps every server status', () => {
    expect(appWorkflowStatusToCell('succeeded')).toBe('done');
    expect(appWorkflowStatusToCell('canceled')).toBe('canceled');
    expect(appWorkflowStatusToCell('failed')).toBe('failed');
    expect(appWorkflowStatusToCell('expired')).toBe('failed');
    expect(appWorkflowStatusToCell('pending')).toBe('polling');
    expect(appWorkflowStatusToCell('processing')).toBe('polling');
  });
});

// ---------------------------------------------------------------------------
// The reducer actions RESTORE / RECONCILE / RECHECK_TIMEDOUT
// ---------------------------------------------------------------------------

describe('reducer: RESTORE / RECONCILE / RECHECK_TIMEDOUT', () => {
  it('RESTORE swaps in a rebuilt state wholesale', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0]]).map((c) =>
      withStatus(c, 'done', { workflowId: 'w', cost: 8 }),
    );
    const restored = restoreStateFromManifest(buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 }))!;
    const out = matrixReducer(initialMatrixState, { type: 'RESTORE', state: restored });
    expect(out).toEqual(restored);
  });

  it('RECONCILE replaces cells and finalizes running→done when all terminal', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const start: MatrixState = runningState([withStatus(base[0], 'polling', { workflowId: 'wf_0' })]);
    const { cells } = reconcileCells(start.cells, [
      { workflowId: 'wf_0', status: 'succeeded', images: [{ url: 'i', nsfwLevel: 1 }], cost: 8 },
    ]);
    const out = matrixReducer(start, { type: 'RECONCILE', cells });
    expect(out.cells[0].status).toBe('done');
    expect(out.phase).toBe('done');
  });

  it('RECHECK_TIMEDOUT re-polls a timedout cell (never re-submits) → polling + running', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const start: MatrixState = { phase: 'done', cells: [withStatus(base[0], 'timedout', { workflowId: 'wf_0' })], perCellEstimate: 8 };
    const out = matrixReducer(start, { type: 'RECHECK_TIMEDOUT', id: base[0].id });
    expect(out.cells[0].status).toBe('polling');
    expect(out.cells[0].workflowId).toBe('wf_0'); // SAME workflow — no re-submit
    expect(out.phase).toBe('running');
  });

  it('RECHECK_TIMEDOUT is a no-op for a non-timedout cell or one without a workflowId', () => {
    const base = buildMatrix('a cat', ckpts, [mods[0]]);
    const doneState: MatrixState = { phase: 'done', cells: [withStatus(base[0], 'done', { workflowId: 'w' })], perCellEstimate: 8 };
    expect(matrixReducer(doneState, { type: 'RECHECK_TIMEDOUT', id: base[0].id })).toBe(doneState);
    const noId: MatrixState = { phase: 'done', cells: [withStatus(base[0], 'timedout', { workflowId: null })], perCellEstimate: 8 };
    expect(matrixReducer(noId, { type: 'RECHECK_TIMEDOUT', id: base[0].id })).toBe(noId);
  });
});

// ---------------------------------------------------------------------------
// G1 — shouldBlurResult maturity gate
// ---------------------------------------------------------------------------

describe('shouldBlurResult (G1 maturity gate)', () => {
  const sfwGate = { isSfw: true, isLevelAllowed: (lvl: number) => lvl <= 1 };
  const matureGate = { isSfw: false, isLevelAllowed: (lvl: number) => lvl <= 8 };

  it('shows a known-safe level on a SFW domain', () => {
    expect(shouldBlurResult(1, sfwGate)).toBe(false);
  });
  it('BLURS a known-mature level above the SFW ceiling', () => {
    expect(shouldBlurResult(4, sfwGate)).toBe(true);
    expect(shouldBlurResult(16, sfwGate)).toBe(true);
  });
  it('FAIL-CLOSED: blurs an UNKNOWN level on a SFW domain (never ungated mature pixels on a g surface)', () => {
    expect(shouldBlurResult(null, sfwGate)).toBe(true);
    expect(shouldBlurResult(undefined, sfwGate)).toBe(true);
  });
  it('allows an unknown level on a domain that already permits mature content', () => {
    expect(shouldBlurResult(null, matureGate)).toBe(false);
  });
  it('respects a higher ceiling on a mature domain', () => {
    expect(shouldBlurResult(4, matureGate)).toBe(false);
    expect(shouldBlurResult(16, matureGate)).toBe(true);
  });
});
