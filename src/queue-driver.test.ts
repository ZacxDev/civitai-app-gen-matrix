import { describe, expect, it } from 'vitest';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';
import type { CheckpointOption, ModifierOption } from './models.js';
import {
  buildMatrix,
  generatableCells,
  initialMatrixState,
  inFlightCells,
  isIncompatibleResourceError,
  isInsufficientBuzz,
  matrixReducer,
  nextCellsToStart,
  totalSpent,
  type MatrixAction,
  type MatrixCell,
  type MatrixState,
} from './matrix.js';

// A headless simulation of the App's queue driver: the SAME loop the React
// effect runs (nextCellsToStart → start cell → reducer transitions), but driven
// by a deterministic fake orchestrator instead of timers/postMessage. This
// proves the concurrency limit holds and the run terminates correctly through
// the real reducer + scheduler — without a DOM.

const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'A', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'B', baseModel: 'SDXL 1.0' },
];
const mods: ModifierOption[] = [
  { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null },
  { key: 'cine', label: 'Cine', promptSuffix: 'cinematic', loraVersionId: null },
  // A LoRA whose family label (Pony) differs from the checkpoints (SDXL 1.0).
  // The block NO LONGER pre-blocks on family — this cell builds `idle` and is
  // attempted; the SERVER decides compatibility (modeled by the `serverReject`
  // outcome below). A family-COMPATIBLE LoRA is exercised separately.
  { key: 'lora', label: 'LoRA', promptSuffix: '', loraVersionId: 999, baseModelFamily: 'Pony' },
];

// A LoRA whose family MATCHES the SDXL checkpoints → server accepts it.
const modLoraCompat: ModifierOption = {
  key: 'lora-ok',
  label: 'LoRA OK',
  promptSuffix: '',
  loraVersionId: 407532,
  loraStrength: 1,
  baseModelFamily: 'SDXL 1.0',
};

/** The server's pre-spend incompatibility reject string (PR #2660 GA). */
const INCOMPATIBLE_MSG = 'a selected LoRA is not compatible with the checkpoint base model';

interface SimResult {
  finalState: MatrixState;
  maxConcurrentObserved: number;
  startedOrder: string[];
}

/**
 * Drive the queue to completion. Each "cell run" is modeled as: start (idle →
 * estimating, immediately accounted as in-flight), then resolved. An outcome may
 * be a terminal SNAPSHOT (applied via CELL_RESULT) OR a thrown Error modeling a
 * submit/estimate reject (applied via CELL_ERROR with the same insufficient /
 * incompatible sniffing the live `runCell` does). By interleaving (start as many
 * as the limit allows, then resolve ONE), we exercise the same scheduling
 * decisions the live driver makes and can assert the in-flight count never
 * exceeds the limit.
 */
function simulateRun(
  cells: MatrixCell[],
  concurrency: number,
  outcome: (cell: MatrixCell, i: number) => BlockWorkflowSnapshot | Error,
): SimResult {
  let state: MatrixState = matrixReducer(initialMatrixState, { type: 'BUILD', cells });
  state = matrixReducer(state, { type: 'START_RUN' });

  const apply = (action: MatrixAction) => {
    state = matrixReducer(state, action);
  };

  let maxConcurrentObserved = 0;
  const startedOrder: string[] = [];
  // A FIFO of cells that have been started and are awaiting resolution.
  const inFlight: MatrixCell[] = [];
  let resolvedCount = 0;
  let guard = 0;

  while (state.phase === 'running') {
    if (++guard > 1000) throw new Error('runaway driver');

    // 1) Start as many pending cells as the limit allows.
    const toStart = nextCellsToStart(state.cells, concurrency);
    for (const cell of toStart) {
      apply({ type: 'CELL_STATUS', id: cell.id, status: 'estimating' });
      startedOrder.push(cell.id);
      inFlight.push(cell);
    }
    maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlightCells(state.cells).length);

    // 2) Resolve exactly one in-flight cell (oldest first).
    const next = inFlight.shift();
    if (!next) break; // nothing in flight and nothing started — done
    const result = outcome(next, resolvedCount);
    if (result instanceof Error) {
      // Mirror the live runCell submit catch: sniff the message for the buzz /
      // incompatible cases the reducer maps to insufficient / blocked.
      const msg = result.message;
      apply({
        type: 'CELL_ERROR',
        id: next.id,
        error: msg,
        insufficient: isInsufficientBuzz(msg),
        incompatible: isIncompatibleResourceError(msg),
      });
    } else {
      apply({ type: 'CELL_RESULT', id: next.id, snapshot: result });
    }
    resolvedCount += 1;
  }

  return { finalState: state, maxConcurrentObserved, startedOrder };
}

const ok = (cell: MatrixCell): BlockWorkflowSnapshot => ({
  workflowId: `wf_${cell.id}`,
  status: 'succeeded',
  cost: { total: 8 },
  imageUrls: ['u'],
});

describe('queue driver simulation', () => {
  it('respects the concurrency limit across a full run', () => {
    const cells = buildMatrix('a cat', ckpts, mods); // 2×3 = 6 cells, all idle
    const { finalState, maxConcurrentObserved } = simulateRun(cells, 2, ok);
    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
    expect(finalState.phase).toBe('done');
  });

  it('ATTEMPTS every cell (incl. cross-family LoRA) — none pre-blocked client-side', () => {
    const cells = buildMatrix('a cat', ckpts, mods);
    // Every cell — including the cross-family LoRA cells — starts idle and is run.
    const { finalState, startedOrder } = simulateRun(cells, 3, ok);
    const done = finalState.cells.filter((c) => c.status === 'done');
    expect(done).toHaveLength(6); // ALL cells attempted + succeeded (server accepted)
    expect(finalState.cells.filter((c) => c.status === 'blocked')).toHaveLength(0);
    // Every cell id was started — nothing was pre-blocked out of the queue.
    expect(startedOrder).toHaveLength(6);
  });

  it('maps a SERVER incompatibility reject to blocked (muted), not failed, and finishes', () => {
    const cells = buildMatrix('a cat', ckpts, mods);
    // The server rejects the cross-family LoRA cells pre-spend; others succeed.
    const { finalState, startedOrder } = simulateRun(cells, 3, (cell) =>
      cell.modifier.key === 'lora' ? new Error(INCOMPATIBLE_MSG) : ok(cell),
    );
    const done = finalState.cells.filter((c) => c.status === 'done');
    const blocked = finalState.cells.filter((c) => c.status === 'blocked');
    const failed = finalState.cells.filter((c) => c.status === 'failed');
    expect(done).toHaveLength(4); // the 4 non-LoRA cells
    expect(blocked).toHaveLength(2); // both checkpoints × the rejected LoRA → muted blocked
    expect(failed).toHaveLength(0); // NOT red failures
    expect(finalState.phase).toBe('done');
    // The rejected cells WERE attempted (server is the authority) — they cost 0.
    const loraIds = cells.filter((c) => c.modifier.key === 'lora').map((c) => c.id);
    expect(loraIds.every((id) => startedOrder.includes(id))).toBe(true);
    // The blocked cells carry the clean reason, not the raw server string.
    expect(blocked.every((c) => c.error === 'Incompatible — base model mismatch')).toBe(true);
  });

  it('runs a family-COMPATIBLE LoRA cell to completion (first-class member)', () => {
    // SDXL checkpoints × an SDXL LoRA → both LoRA cells are submittable.
    const cells = buildMatrix('a cat', ckpts, [mods[0], modLoraCompat]);
    const { finalState, startedOrder } = simulateRun(cells, 3, ok);
    const done = finalState.cells.filter((c) => c.status === 'done');
    const blocked = finalState.cells.filter((c) => c.status === 'blocked');
    expect(blocked).toHaveLength(0);
    expect(done).toHaveLength(4); // 2 checkpoints × (baseline + compatible LoRA)
    // The compatible LoRA cells WERE started.
    const loraCellIds = cells.filter((c) => c.modifier.key === 'lora-ok').map((c) => c.id);
    expect(loraCellIds.every((id) => startedOrder.includes(id))).toBe(true);
  });

  it('starts cells in row-major queue order', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0], mods[1]]); // 4 billable, no blocked
    const { startedOrder } = simulateRun(cells, 1, ok); // serial → strict order
    expect(startedOrder).toEqual(cells.map((c) => c.id));
  });

  it('terminates with a mix of success and insufficient-Buzz failures', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0], mods[1]]); // 4 billable
    const { finalState } = simulateRun(cells, 2, (cell, i) =>
      i % 2 === 0
        ? ok(cell)
        : { workflowId: `wf_${cell.id}`, status: 'failed', error: 'Insufficient Buzz' },
    );
    expect(finalState.phase).toBe('done');
    expect(finalState.cells.filter((c) => c.status === 'insufficient').length).toBeGreaterThan(0);
    expect(finalState.cells.filter((c) => c.status === 'done').length).toBeGreaterThan(0);
  });

  it('a matrix the server rejects entirely ends with all cells blocked (none failed, 0 spent)', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[2]]); // the LoRA col only (now idle)
    // The server rejects every cell pre-spend as incompatible.
    const { finalState, startedOrder } = simulateRun(cells, 3, () => new Error(INCOMPATIBLE_MSG));
    // They WERE attempted (the block doesn't pre-block) but cost nothing.
    expect(startedOrder.length).toBe(cells.length);
    expect(finalState.cells.every((c) => c.status === 'blocked')).toBe(true);
    expect(finalState.cells.some((c) => c.status === 'failed')).toBe(false);
    expect(finalState.phase).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Resume an EXISTING running state to completion (for retry / stop scenarios).
// Same queue loop as simulateRun but seeded from a mid-flight state so we can
// prove retry doesn't re-run done cells and stop doesn't start new ones.
// ---------------------------------------------------------------------------

interface ResumeResult {
  finalState: MatrixState;
  startedOrder: string[];
}

function resumeRun(
  start: MatrixState,
  concurrency: number,
  outcome: (cell: MatrixCell, i: number) => BlockWorkflowSnapshot | Error,
): ResumeResult {
  let state = start;
  const apply = (action: MatrixAction) => {
    state = matrixReducer(state, action);
  };
  const startedOrder: string[] = [];
  const inFlight: MatrixCell[] = [];
  let resolved = 0;
  let guard = 0;

  while (state.phase === 'running') {
    if (++guard > 1000) throw new Error('runaway driver');
    const toStart = nextCellsToStart(state.cells, concurrency);
    for (const cell of toStart) {
      apply({ type: 'CELL_STATUS', id: cell.id, status: 'estimating' });
      startedOrder.push(cell.id);
      inFlight.push(cell);
    }
    const next = inFlight.shift();
    if (!next) break;
    const result = outcome(next, resolved);
    if (result instanceof Error) {
      const msg = result.message;
      apply({
        type: 'CELL_ERROR',
        id: next.id,
        error: msg,
        insufficient: isInsufficientBuzz(msg),
        incompatible: isIncompatibleResourceError(msg),
      });
    } else {
      apply({ type: 'CELL_RESULT', id: next.id, snapshot: result });
    }
    resolved += 1;
  }
  return { finalState: state, startedOrder };
}

describe('retry-failed driver (no double-charge)', () => {
  it('re-runs ONLY failed/insufficient cells; done cells keep cost+image and are NOT re-run', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0], mods[1]]); // 4 billable, all idle
    // First run: cells at even resolve-index succeed, odd ones fail.
    const first = simulateRun(cells, 2, (cell, i) =>
      i % 2 === 0 ? ok(cell) : new Error('transient orchestrator error'),
    );
    const doneAfterFirst = first.finalState.cells.filter((c) => c.status === 'done');
    const failedAfterFirst = first.finalState.cells.filter((c) => c.status === 'failed');
    expect(doneAfterFirst.length).toBeGreaterThan(0);
    expect(failedAfterFirst.length).toBeGreaterThan(0);
    const spentAfterFirst = totalSpent(first.finalState.cells);
    // Capture the done cells' ids + costs to prove they're untouched by retry.
    const doneIds = doneAfterFirst.map((c) => c.id);
    const doneCostById = new Map(doneAfterFirst.map((c) => [c.id, c.cost]));

    // RETRY: re-queue the failed subset, then resume — this time they all succeed.
    const retried = matrixReducer(first.finalState, { type: 'RETRY_FAILED' });
    expect(retried.phase).toBe('running');
    const second = resumeRun(retried, 2, (cell) => ok(cell));

    // Every cell ended done.
    expect(second.finalState.cells.every((c) => c.status === 'done')).toBe(true);
    expect(second.finalState.phase).toBe('done');
    // The retry only STARTED the previously-failed cells — never the done ones.
    expect(second.startedOrder.sort()).toEqual(failedAfterFirst.map((c) => c.id).sort());
    for (const id of doneIds) {
      expect(second.startedOrder).not.toContain(id);
      // Done cells kept their exact cost (no re-charge / reset).
      expect(second.finalState.cells.find((c) => c.id === id)!.cost).toBe(doneCostById.get(id));
    }
    // MONEY INVARIANT: total spend only INCREMENTED for the retried cells.
    const spentAfterRetry = totalSpent(second.finalState.cells);
    const retriedCost = failedAfterFirst.length * 8; // each retried cell costs 8
    expect(spentAfterRetry).toBe(spentAfterFirst + retriedCost);
  });

  it('insufficient cells re-enter on retry; done cells stay done', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0]]); // 2 cells
    const first = simulateRun(cells, 2, (cell, i) =>
      i === 0
        ? ok(cell)
        : { workflowId: `wf_${cell.id}`, status: 'failed', error: 'Insufficient Buzz' },
    );
    expect(first.finalState.cells.filter((c) => c.status === 'insufficient')).toHaveLength(1);
    const doneId = first.finalState.cells.find((c) => c.status === 'done')!.id;

    const retried = matrixReducer(first.finalState, { type: 'RETRY_FAILED' });
    const second = resumeRun(retried, 2, (cell) => ok(cell));
    // The done cell was not re-run.
    expect(second.startedOrder).not.toContain(doneId);
    expect(second.finalState.cells.every((c) => c.status === 'done')).toBe(true);
  });
});

describe('stop driver (no spend on canceled, queue stops starting new cells)', () => {
  it('stop marks idle cells canceled, the queue starts NO new cells, run reaches terminal', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0], mods[1]]); // 4 idle
    let state = matrixReducer(initialMatrixState, { type: 'BUILD', cells });
    state = matrixReducer(state, { type: 'START_RUN' });
    // Start the first 2 cells (concurrency 2).
    const toStart = nextCellsToStart(state.cells, 2);
    for (const cell of toStart) {
      state = matrixReducer(state, { type: 'CELL_STATUS', id: cell.id, status: 'estimating' });
      state = matrixReducer(state, { type: 'CELL_SUBMITTED', id: cell.id, workflowId: `wf_${cell.id}` });
    }
    const startedIds = toStart.map((c) => c.id);

    // USER STOPS. idle cells → canceled; in-flight left for cancel().
    state = matrixReducer(state, { type: 'STOP_RUN' });
    // The queue must NOT start any more cells — none are idle now.
    expect(nextCellsToStart(state.cells, 2)).toHaveLength(0);
    const canceledNow = state.cells.filter((c) => c.status === 'canceled');
    expect(canceledNow).toHaveLength(2); // the 2 that never started
    expect(state.phase).toBe('running'); // 2 still in-flight

    // The in-flight cells resolve via cancel() → canceled snapshots.
    for (const id of startedIds) {
      state = matrixReducer(state, {
        type: 'CELL_RESULT',
        id,
        snapshot: { workflowId: `wf_${id}`, status: 'canceled' },
      });
    }
    expect(state.phase).toBe('done');
    // NOTHING was spent — stop short-circuited before any success.
    expect(totalSpent(state.cells)).toBe(0);
    // Every cell is terminal (canceled), none failed.
    expect(state.cells.every((c) => c.status === 'canceled')).toBe(true);
    expect(generatableCells(state.cells)).toHaveLength(0);
  });

  it('a stop after some cells already succeeded keeps their spend, cancels the rest (no extra spend)', () => {
    const cells = buildMatrix('a cat', ckpts, [mods[0], mods[1]]); // 4 cells
    let state = matrixReducer(initialMatrixState, { type: 'BUILD', cells });
    state = matrixReducer(state, { type: 'START_RUN' });
    // One cell completes successfully first.
    const firstCell = state.cells[0];
    state = matrixReducer(state, { type: 'CELL_STATUS', id: firstCell.id, status: 'estimating' });
    state = matrixReducer(state, {
      type: 'CELL_RESULT',
      id: firstCell.id,
      snapshot: ok(firstCell),
    });
    // Now stop — the remaining 3 idle cells cancel, no spend on them.
    state = matrixReducer(state, { type: 'STOP_RUN' });
    expect(state.phase).toBe('done'); // 1 done + 3 canceled, nothing in-flight
    expect(totalSpent(state.cells)).toBe(8); // only the one that already succeeded
    expect(state.cells.filter((c) => c.status === 'canceled')).toHaveLength(3);
  });
});
