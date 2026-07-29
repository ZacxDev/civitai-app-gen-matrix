import { describe, expect, it } from 'vitest';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import type { CheckpointOption, ModifierOption, PickedResource } from './models.js';
import {
  BASELINE_MODIFIER,
  CHECKPOINTS,
  MODIFIERS,
  PICKED_LORA_DEFAULT_STRENGTH,
  checkpointFromPick,
  loraModifierFromPick,
  pickedCheckpointLabel,
  pickedLoraLabel,
} from './models.js';
import {
  DAILY_BUZZ_CAP,
  DEFAULT_CONCURRENCY,
  MAX_CELLS,
  PAGE_BUZZ_BUDGET_PER_CELL,
  PROMPT_MAX,
  billableCellCount,
  buildCellBody,
  buildMatrix,
  cellId,
  cellStatusForSnapshot,
  clampPrompt,
  composeCellPrompt,
  distinctLoraModifierCount,
  estimateMatrixTotal,
  estimateSignature,
  exceedsCap,
  failedCellDetail,
  failedCellLabel,
  firstImageUrl,
  formatCost,
  generatableCells,
  hasBudgetedScope,
  inFlightCells,
  initialMatrixState,
  isIncompatibleResourceError,
  isInsufficientBuzz,
  isRunComplete,
  isTerminalStatus,
  isUncancelableInFlight,
  matrixReducer,
  matrixTotalLabel,
  MIN_TOPUP_SUGGESTION,
  nextCellsToStart,
  pendingCells,
  perCellBudgetCopy,
  POLL_MAX_ATTEMPTS,
  representativeEstimateBody,
  representativeModifier,
  runProgress,
  snapshotErrorCode,
  runProgressLabel,
  stopInProgressWarning,
  suggestedTopUpAmount,
  timedOutCellLabel,
  uncancelableInFlightCount,
  totalSpent,
  type MatrixCell,
  type MatrixState,
} from './matrix.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ckptA: CheckpointOption = { versionId: 1, modelId: 11, label: 'A', baseModel: 'SDXL 1.0' };
const ckptB: CheckpointOption = { versionId: 2, modelId: 22, label: 'B', baseModel: 'SDXL 1.0' };

const modBase: ModifierOption = BASELINE_MODIFIER;
const modCine: ModifierOption = {
  key: 'cine',
  label: 'Cine',
  promptSuffix: 'cinematic lighting',
  loraVersionId: null,
};
// A LoRA whose family label DIFFERS from the SDXL checkpoints. The block no
// longer pre-blocks on family — every LoRA cell now builds `idle` and the SERVER
// decides compatibility. (Kept as a fixture to prove no client pre-block.)
const modLora: ModifierOption = {
  key: 'lora-x',
  label: 'LoRA X',
  promptSuffix: '',
  loraVersionId: 407532,
  loraStrength: 1,
  baseModelFamily: 'Pony',
};
// A LoRA whose family label matches the SDXL checkpoints. Also builds `idle`.
const modLoraCompat: ModifierOption = {
  key: 'lora-sdxl',
  label: 'LoRA SDXL',
  promptSuffix: '',
  loraVersionId: 407532,
  loraStrength: 0.8,
  baseModelFamily: 'SDXL 1.0',
};

function snap(over: Partial<BlockWorkflowSnapshot>): BlockWorkflowSnapshot {
  return { workflowId: 'wf', status: 'pending', ...over };
}

// ---------------------------------------------------------------------------
// Curated model set — guard the live-verified invariants.
// ---------------------------------------------------------------------------

describe('curated model set', () => {
  it('ships at least 2 checkpoints, each with distinct ids', () => {
    expect(CHECKPOINTS.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(CHECKPOINTS.map((c) => c.versionId));
    expect(ids.size).toBe(CHECKPOINTS.length);
  });
  it('includes the baseline modifier first', () => {
    expect(MODIFIERS[0]).toBe(BASELINE_MODIFIER);
    expect(BASELINE_MODIFIER.promptSuffix).toBe('');
    expect(BASELINE_MODIFIER.loraVersionId).toBeNull();
  });
  it('has unique modifier keys', () => {
    const keys = new Set(MODIFIERS.map((m) => m.key));
    expect(keys.size).toBe(MODIFIERS.length);
  });
  it('the sample LoRA is attempted on EVERY checkpoint (no client pre-block) and emits additionalResources', () => {
    const lora = MODIFIERS.find((m) => m.loraVersionId != null)!;
    expect(lora.loraVersionId).toBe(407532);
    expect(lora.loraStrength).toBeGreaterThanOrEqual(-1);
    expect(lora.loraStrength).toBeLessThanOrEqual(2);
    // It emits an additionalResources entry on any checkpoint.
    const body = buildCellBody(CHECKPOINTS[0], 'a cat', lora);
    expect(body.additionalResources).toEqual([
      { modelVersionId: 407532, strength: lora.loraStrength },
    ]);
    // Built into a matrix against ALL curated checkpoints, every cell starts
    // `idle` (none pre-blocked client-side — the server decides compatibility).
    const cells = buildMatrix('a cat', CHECKPOINTS, [lora]);
    expect(cells.every((cell) => cell.status === 'idle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resource-picker → axis-member helpers (useResourcePicker wiring)
// ---------------------------------------------------------------------------

describe('picker → axis member', () => {
  const pickedSdxlLora: PickedResource = {
    versionId: 666002,
    modelId: 555002,
    modelName: 'Sinfully Stylish',
    versionName: 'v2.0',
    baseModel: 'SDXL 1.0',
    modelType: 'LORA',
  };
  const pickedPonyLora: PickedResource = {
    versionId: 555001,
    modelId: 444001,
    modelName: 'Incompatible Pony LoRA',
    versionName: 'v1.0',
    baseModel: 'Pony',
    modelType: 'LORA',
  };
  const sdxlCkpt = CHECKPOINTS.find((c) => c.baseModel === 'SDXL 1.0')!;
  const ponyCkpt = CHECKPOINTS.find((c) => c.baseModel === 'Pony')!;

  it('loraModifierFromPick builds a LoRA column carrying the picked versionId + family', () => {
    const mod = loraModifierFromPick(pickedSdxlLora);
    expect(mod.loraVersionId).toBe(666002);
    expect(mod.baseModelFamily).toBe('SDXL 1.0');
    expect(mod.loraStrength).toBe(PICKED_LORA_DEFAULT_STRENGTH);
    expect(mod.promptSuffix).toBe(''); // a LoRA column, not a prompt-style one
    // The column header now renders the resource's real name, not "#666002".
    expect(mod.label).toBe('Sinfully Stylish — v2.0');
    // key is derived from versionId so re-picking the same LoRA DEDUPES.
    expect(mod.key).toBe('lora-picked-666002');
    expect(loraModifierFromPick(pickedSdxlLora).key).toBe(mod.key);
  });

  it('a picker-added LoRA builds the right additionalResources on the checkpoint', () => {
    const mod = loraModifierFromPick(pickedSdxlLora);
    const body = buildCellBody(sdxlCkpt, 'a cat', mod);
    expect(body.modelVersionId).toBe(sdxlCkpt.versionId); // checkpoint is the model
    expect(body.additionalResources).toEqual([
      { modelVersionId: 666002, strength: PICKED_LORA_DEFAULT_STRENGTH },
    ]);
  });

  it('a picker-added LoRA is attempted (idle) on every checkpoint — no client pre-block', () => {
    const mod = loraModifierFromPick(pickedSdxlLora);
    // Cross-family pairing is NO LONGER pre-blocked; the server decides.
    const cells = buildMatrix('a cat', [ponyCkpt], [mod]);
    expect(cells[0].status).toBe('idle');
  });

  it('a picker-added Pony LoRA is attempted (idle) on BOTH SDXL and Pony checkpoints', () => {
    const mod = loraModifierFromPick(pickedPonyLora);
    const cells = buildMatrix('a cat', [sdxlCkpt, ponyCkpt], [mod]);
    const onSdxl = cells.find((c) => c.checkpoint === sdxlCkpt)!;
    const onPony = cells.find((c) => c.checkpoint === ponyCkpt)!;
    expect(onSdxl.status).toBe('idle'); // cross-ecosystem now attempted (server decides)
    expect(onPony.status).toBe('idle');
  });

  it('the same picked LoRA dedupes in the matrix (no double-bill)', () => {
    const mod = loraModifierFromPick(pickedSdxlLora);
    // Two columns with the same derived key on one checkpoint → 1 cell.
    const cells = buildMatrix('a cat', [sdxlCkpt], [mod, loraModifierFromPick(pickedSdxlLora)]);
    expect(cells).toHaveLength(1);
  });

  it('a picker-added LoRA counts against the cap exactly like a curated one', () => {
    const mod = loraModifierFromPick(pickedSdxlLora);
    const cells = buildMatrix('a cat', [sdxlCkpt], [BASELINE_MODIFIER, mod]);
    expect(billableCellCount(cells)).toBe(2); // both generatable on SDXL
    expect(exceedsCap(cells)).toBe(false);
  });

  it('checkpointFromPick builds a checkpoint row carrying the picked ids + family', () => {
    const picked: PickedResource = {
      versionId: 691639,
      modelId: 618692,
      modelName: 'FLUX.1 [dev]',
      versionName: 'fp8',
      baseModel: 'Flux.1 D',
      modelType: 'Checkpoint',
    };
    const ckpt = checkpointFromPick(picked);
    expect(ckpt.versionId).toBe(691639);
    expect(ckpt.modelId).toBe(618692);
    expect(ckpt.baseModel).toBe('Flux.1 D');
    // The row header now renders the resource's real name, not "#691639".
    expect(ckpt.label).toBe('FLUX.1 [dev] — fp8');
    // It submits as the model on a baseline cell.
    const body = buildCellBody(ckpt, 'a cat', BASELINE_MODIFIER);
    expect(body.modelVersionId).toBe(691639);
    expect(body.modelId).toBe(618692);
    expect(body.additionalResources).toBeUndefined();
  });

  it('labels PREFER the picked resource name when present', () => {
    expect(pickedLoraLabel(666002, 'SDXL 1.0', { modelName: 'Sinfully Stylish', versionName: 'v2.0' })).toBe(
      'Sinfully Stylish — v2.0',
    );
    expect(
      pickedCheckpointLabel(691639, 'Flux.1 D', { modelName: 'FLUX.1 [dev]', versionName: 'fp8' }),
    ).toBe('FLUX.1 [dev] — fp8');
    // A single name (only model, or only version) is used as-is.
    expect(pickedLoraLabel(1, 'SDXL 1.0', { modelName: 'Just A Model' })).toBe('Just A Model');
    expect(pickedCheckpointLabel(2, 'Pony', { versionName: 'Only A Version' })).toBe('Only A Version');
  });

  it('labels FALL BACK to versionId + baseModel when no name is present (older host/SDK)', () => {
    expect(pickedLoraLabel(666002, 'SDXL 1.0')).toBe('LoRA #666002 (SDXL 1.0)');
    expect(pickedCheckpointLabel(691639, 'Flux.1 D')).toBe('Model #691639 (Flux.1 D)');
    // Whitespace-only names are treated as absent → fallback.
    expect(pickedLoraLabel(3, 'Pony', { modelName: '  ', versionName: '' })).toBe('LoRA #3 (Pony)');
  });
});

// ---------------------------------------------------------------------------
// Prompt composition + body building
// ---------------------------------------------------------------------------

describe('clampPrompt', () => {
  it('trims to the server cap', () => {
    expect(clampPrompt('x'.repeat(PROMPT_MAX + 100)).length).toBe(PROMPT_MAX);
  });
  it('leaves a short prompt untouched', () => {
    expect(clampPrompt('hello')).toBe('hello');
  });
});

describe('composeCellPrompt', () => {
  it('baseline returns the shared prompt verbatim (trimmed)', () => {
    expect(composeCellPrompt('  a cat  ', modBase)).toBe('a cat');
  });
  it('comma-joins a modifier suffix', () => {
    expect(composeCellPrompt('a cat', modCine)).toBe('a cat, cinematic lighting');
  });
  it('uses suffix alone when shared prompt is empty', () => {
    expect(composeCellPrompt('   ', modCine)).toBe('cinematic lighting');
  });
  it('clamps the composed result to the server cap', () => {
    const out = composeCellPrompt('y'.repeat(PROMPT_MAX), modCine);
    expect(out.length).toBe(PROMPT_MAX);
  });
});

describe('buildCellBody', () => {
  it('always submits the checkpoint as the model with the cell prompt', () => {
    expect(buildCellBody(ckptA, '  a dog  ')).toEqual({
      kind: 'textToImage',
      modelId: 11,
      modelVersionId: 1,
      params: { prompt: 'a dog' },
    });
  });
  it('clamps an over-long prompt', () => {
    const body = buildCellBody(ckptA, 'z'.repeat(PROMPT_MAX + 50));
    expect(body.params.prompt.length).toBe(PROMPT_MAX);
  });
  it('emits NO additionalResources for a baseline / prompt-only modifier', () => {
    expect(buildCellBody(ckptA, 'a dog', modBase).additionalResources).toBeUndefined();
    expect(buildCellBody(ckptA, 'a dog', modCine).additionalResources).toBeUndefined();
  });
  it('emits a single additionalResources entry for a compatible LoRA modifier', () => {
    const body = buildCellBody(ckptA, 'a dog', modLoraCompat);
    expect(body.additionalResources).toEqual([{ modelVersionId: 407532, strength: 0.8 }]);
  });
  it('defaults LoRA strength to 1 when the modifier omits it', () => {
    const mod: ModifierOption = { ...modLoraCompat, loraStrength: undefined };
    const body = buildCellBody(ckptA, 'a dog', mod);
    expect(body.additionalResources).toEqual([{ modelVersionId: 407532, strength: 1 }]);
  });
  it('clamps LoRA strength into the server [-1, 2] range', () => {
    const hi = buildCellBody(ckptA, 'p', { ...modLoraCompat, loraStrength: 9 });
    expect(hi.additionalResources![0].strength).toBe(2);
    const lo = buildCellBody(ckptA, 'p', { ...modLoraCompat, loraStrength: -5 });
    expect(lo.additionalResources![0].strength).toBe(-1);
  });
});

describe('isIncompatibleResourceError', () => {
  it('matches the server pre-spend incompatibility reject (case-insensitive)', () => {
    expect(
      isIncompatibleResourceError('a selected LoRA is not compatible with the checkpoint base model'),
    ).toBe(true);
    expect(
      isIncompatibleResourceError('NOT COMPATIBLE WITH THE CHECKPOINT BASE MODEL'),
    ).toBe(true);
    // Wrapped in a longer TRPC/BAD_REQUEST envelope still matches the substring.
    expect(
      isIncompatibleResourceError(
        'BAD_REQUEST: a selected LoRA is not compatible with the checkpoint base model.',
      ),
    ).toBe(true);
  });
  it('is false for unrelated / buzz / empty errors', () => {
    expect(isIncompatibleResourceError('Insufficient Buzz')).toBe(false);
    expect(isIncompatibleResourceError('prompt rejected by audit')).toBe(false);
    expect(isIncompatibleResourceError(null)).toBe(false);
    expect(isIncompatibleResourceError(undefined)).toBe(false);
    expect(isIncompatibleResourceError('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combo / matrix builder — incl. baseline, dedup, cap, blocked LoRA
// ---------------------------------------------------------------------------

describe('buildMatrix', () => {
  it('builds checkpoints × modifiers in row-major order', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]);
    expect(cells).toHaveLength(4);
    expect(cells.map((c) => [c.row, c.col])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    // rows=checkpoints
    expect(cells[0].checkpoint).toBe(ckptA);
    expect(cells[2].checkpoint).toBe(ckptB);
    // cols=modifiers
    expect(cells[0].modifier).toBe(modBase);
    expect(cells[1].modifier).toBe(modCine);
  });

  it('includes the no-modifier baseline column', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modCine]);
    const baseline = cells.find((c) => c.modifier.key === 'baseline');
    expect(baseline).toBeDefined();
    expect(baseline!.prompt).toBe('a cat');
    expect(baseline!.status).toBe('idle');
  });

  it('dedups duplicate (checkpoint, modifier) selections (idempotency)', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptA], [modBase, modBase]);
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe(cellId(ckptA, modBase));
  });

  it('does NOT pre-block a cross-family LoRA × checkpoint cell — it builds idle', () => {
    // ckptA is SDXL 1.0; modLora is labeled Pony. The block no longer pre-blocks
    // on family: the cell starts `idle` and the server decides compatibility.
    const cells = buildMatrix('a cat', [ckptA], [modBase, modLora]);
    const lora = cells.find((c) => c.modifier.key === 'lora-x')!;
    expect(lora.status).toBe('idle');
    const base = cells.find((c) => c.modifier.key === 'baseline')!;
    expect(base.status).toBe('idle');
  });

  it('builds every LoRA cell idle regardless of family label', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modLoraCompat]);
    const lora = cells.find((c) => c.modifier.key === 'lora-sdxl')!;
    expect(lora.status).toBe('idle');
  });

  it('builds the SAME LoRA idle on every checkpoint (no client-side per-cell pre-block)', () => {
    const ponyCkpt: CheckpointOption = { ...ckptB, baseModel: 'Pony' };
    const cells = buildMatrix('a cat', [ckptA, ponyCkpt], [modLoraCompat]);
    const onSdxl = cells.find((c) => c.checkpoint === ckptA)!;
    const onPony = cells.find((c) => c.checkpoint === ponyCkpt)!;
    expect(onSdxl.status).toBe('idle');
    expect(onPony.status).toBe('idle'); // NOT pre-blocked — server decides
  });

  it('initializes cells with empty result fields', () => {
    const [cell] = buildMatrix('a cat', [ckptA], [modBase]);
    expect(cell).toMatchObject({
      workflowId: null,
      imageUrl: null,
      cost: null,
      error: null,
      status: 'idle',
    });
  });
});

describe('cellId', () => {
  it('is stable per (checkpoint, modifier)', () => {
    expect(cellId(ckptA, modBase)).toBe(cellId(ckptA, modBase));
    expect(cellId(ckptA, modBase)).not.toBe(cellId(ckptB, modBase));
    expect(cellId(ckptA, modBase)).not.toBe(cellId(ckptA, modCine));
  });
});

describe('cap enforcement', () => {
  const many = (n: number): MatrixCell[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      checkpoint: ckptA,
      modifier: modBase,
      row: 0,
      col: i,
      status: 'idle' as const,
      prompt: 'p',
      workflowId: null,
      imageUrl: null,
      cost: null,
      error: null,
    }));

  it('builds all LoRA cells idle → ALL count against the cap (conservative over-estimate)', () => {
    // The block no longer pre-blocks cross-family LoRA cells, so the preview
    // counts EVERY cell as billable (a conservative MAX — server may reject some
    // pre-spend at 0 cost). All 4 cells are billable here.
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modLora]);
    expect(cells).toHaveLength(4);
    expect(billableCellCount(cells)).toBe(4);
    expect(generatableCells(cells)).toHaveLength(4);
  });

  it('SERVER-blocked cells (status set post-submit) drop out of the billable count', () => {
    // A cell only becomes `blocked` from the server reject; once it does, it
    // stops counting against the cap / actual spend.
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modLora]);
    cells.filter((c) => c.modifier.key === 'lora-x').forEach((c) => (c.status = 'blocked'));
    expect(billableCellCount(cells)).toBe(2); // the 2 baseline cells remain
    expect(generatableCells(cells)).toHaveLength(2);
  });

  it('exceedsCap is false at the cap and true above it', () => {
    expect(exceedsCap(many(MAX_CELLS))).toBe(false);
    expect(exceedsCap(many(MAX_CELLS + 1))).toBe(true);
  });

  it('user-canceled cells drop out of the billable count + generatable set (cost 0)', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]); // 4 idle
    cells[2].status = 'canceled';
    cells[3].status = 'canceled';
    expect(billableCellCount(cells)).toBe(2); // only the 2 non-canceled remain
    expect(generatableCells(cells)).toHaveLength(2);
  });

  it('server-blocked cells do not push a selection over the cap', () => {
    const blockedCell: MatrixCell = {
      id: 'blk',
      checkpoint: ckptA,
      modifier: modLora,
      row: 0,
      col: 99,
      status: 'blocked',
      prompt: 'p',
      workflowId: null,
      imageUrl: null,
      cost: null,
      error: 'Incompatible — base model mismatch',
    };
    const cells = [...many(MAX_CELLS), blockedCell];
    // MAX_CELLS billable + 1 blocked → still at cap, not over
    expect(exceedsCap(cells)).toBe(false);
  });

  it('the cap keeps worst-case spend under the daily cap', () => {
    // 12 cells × 1000 server per-cell ceiling = 12,000 << 50,000.
    expect(MAX_CELLS * 1000).toBeLessThan(DAILY_BUZZ_CAP);
  });
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe('estimateMatrixTotal', () => {
  it('multiplies billable cells by the per-cell estimate', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]); // 4 billable
    expect(estimateMatrixTotal(cells, 8)).toBe(32);
  });
  it('excludes SERVER-blocked cells from the total (once rejected)', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modLora]); // builds 4 idle
    // Pre-run all 4 count (conservative): 4 × 8 = 32.
    expect(estimateMatrixTotal(cells, 8)).toBe(32);
    // After the server rejects the 2 LoRA cells pre-spend, they drop out.
    cells.filter((c) => c.modifier.key === 'lora-x').forEach((c) => (c.status = 'blocked'));
    expect(estimateMatrixTotal(cells, 8)).toBe(16);
  });
  it('falls back to the manifest per-cell budget when estimate is unknown', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modCine]); // 2 billable
    expect(estimateMatrixTotal(cells, null)).toBe(2 * PAGE_BUZZ_BUDGET_PER_CELL);
    expect(estimateMatrixTotal(cells, 0)).toBe(2 * PAGE_BUZZ_BUDGET_PER_CELL);
    expect(estimateMatrixTotal(cells, NaN)).toBe(2 * PAGE_BUZZ_BUDGET_PER_CELL);
  });
});

describe('totalSpent', () => {
  it('sums actual cell costs, treating null as 0', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase]);
    cells[0].cost = 8;
    cells[1].cost = null;
    expect(totalSpent(cells)).toBe(8);
  });
});

describe('formatCost', () => {
  it('renders integers with separators', () => {
    expect(formatCost(1234)).toBe('1,234');
  });
  it('rounds fractional costs', () => {
    expect(formatCost(7.6)).toBe('8');
  });
  it('renders a dash for null / non-finite', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(NaN)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Budget / cost COPY — the wording must never imply spending the cap.
// ---------------------------------------------------------------------------

describe('perCellBudgetCopy (header sub-copy)', () => {
  const copy = perCellBudgetCopy();

  it('states the real cost is small, not the cap', () => {
    expect(copy.toLowerCase()).toContain('real cost');
    expect(copy.toLowerCase()).toContain('few buzz');
  });

  it('frames the 200 as a CAP / safety limit, not the spend', () => {
    expect(copy).toContain(String(PAGE_BUZZ_BUDGET_PER_CELL));
    expect(copy.toLowerCase()).toMatch(/cap|limit|at most|up to/);
  });

  it('does not say each cell SPENDS the budget number', () => {
    // The misleading framings are "spends ~200 / spends 200 Buzz" (200 as the
    // amount spent) and "≈200 budget per cell". "spend is capped at 200" is the
    // CORRECT cap framing and is allowed.
    expect(copy).not.toMatch(/spends?\s*[≈~]?\s*200\b/i);
    expect(copy).not.toMatch(/[≈~]\s*200\s*budget per cell/i);
    expect(copy).not.toMatch(/\b200\s*budget per cell/i);
  });
});

describe('matrixTotalLabel', () => {
  const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]); // 4 billable

  it('marks a CEILING (no estimate yet) as an "up to" maximum, not expected spend', () => {
    const label = matrixTotalLabel(cells, null);
    expect(label.isCeiling).toBe(true);
    expect(label.amount.toLowerCase()).toContain('up to');
    // The cap-based number is 4 × 200 = 800, surfaced only as a maximum.
    expect(label.amount).toContain('800');
    // Never the "estimated"/"≈" expected-spend framing for a ceiling.
    expect(label.amount).not.toContain('≈');
  });

  it('treats 0 / NaN estimate the same as unknown → ceiling', () => {
    expect(matrixTotalLabel(cells, 0).isCeiling).toBe(true);
    expect(matrixTotalLabel(cells, NaN).isCeiling).toBe(true);
  });

  it('uses the REAL per-cell estimate once known (≈, not a ceiling)', () => {
    const label = matrixTotalLabel(cells, 8); // real estimate landed
    expect(label.isCeiling).toBe(false);
    expect(label.amount).toContain('≈');
    expect(label.amount).toContain('32'); // 4 × 8 = 32, the realistic estimate
    expect(label.amount.toLowerCase()).not.toContain('up to');
  });

  it('the real-estimate total is far below the cap-based maximum (honest)', () => {
    const real = matrixTotalLabel(cells, 8); // 32
    const ceiling = matrixTotalLabel(cells, null); // 800
    // The realistic number (32) must read smaller than the worst-case cap (800).
    expect(real.amount).toContain('32');
    expect(ceiling.amount).toContain('800');
    expect(32).toBeLessThan(4 * PAGE_BUZZ_BUDGET_PER_CELL);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-1 — mixed-LoRA honesty: a single representative estimate undercounts
// when the matrix mixes >1 distinct billable kind, so the label must fall back
// to the conservative ceiling ("up to N") instead of a precise "≈ N".
// ---------------------------------------------------------------------------

const modLoraB: ModifierOption = {
  key: 'lora-b',
  label: 'LoRA B',
  promptSuffix: '',
  loraVersionId: 999111, // a DIFFERENT LoRA from modLoraCompat (407532)
  loraStrength: 1,
  baseModelFamily: 'SDXL 1.0',
};

describe('distinctLoraModifierCount', () => {
  it('counts ZERO when there are no LoRA cells (all baseline / prompt-style)', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]);
    expect(distinctLoraModifierCount(cells)).toBe(0);
  });

  it('counts a single LoRA as ONE even alongside prompt-style columns', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modCine, modLoraCompat]);
    expect(distinctLoraModifierCount(cells)).toBe(1);
  });

  it('counts two DIFFERENT LoRAs as 2', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLoraCompat, modLoraB]);
    expect(distinctLoraModifierCount(cells)).toBe(2);
  });

  it('treats the SAME LoRA at a DIFFERENT strength as distinct', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLora, modLoraCompat]); // 407532 @1 vs @0.8
    expect(distinctLoraModifierCount(cells)).toBe(2);
  });

  it('excludes blocked + canceled cells from the count', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLoraCompat, modLoraB]).map((c) =>
      c.modifier.key === 'lora-b' ? { ...c, status: 'blocked' as const } : c,
    );
    // Only the surviving (generatable) LoRA counts.
    expect(distinctLoraModifierCount(cells)).toBe(1);
  });
});

describe('matrixTotalLabel — mixed-LoRA falls back to the ceiling', () => {
  it('all prompt-style matrix with a landed estimate shows a precise "≈"', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modCine]); // 0 LoRAs
    const label = matrixTotalLabel(cells, 9);
    expect(label.isCeiling).toBe(false);
    expect(label.amount).toContain('≈');
  });

  it('baseline + a SINGLE LoRA shows a precise "≈" (representative over-covers)', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modBase, modLoraCompat]); // 1 distinct LoRA
    expect(distinctLoraModifierCount(cells)).toBe(1);
    const label = matrixTotalLabel(cells, 9);
    expect(label.isCeiling).toBe(false);
    expect(label.amount).toContain('≈');
  });

  it('multi-DISTINCT-LoRA matrix shows the "up to" ceiling EVEN WITH an estimate', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLoraCompat, modLoraB]);
    const label = matrixTotalLabel(cells, 9); // estimate landed, but it can't represent both LoRAs
    // Never a precise "≈" that could be materially exceeded.
    expect(label.isCeiling).toBe(true);
    expect(label.amount.toLowerCase()).toContain('up to');
    expect(label.amount).not.toContain('≈');
    // The ceiling uses the conservative cap, not the (undercounting) estimate.
    expect(label.amount).toContain(formatCost(2 * PAGE_BUZZ_BUDGET_PER_CELL));
  });

  it('no estimate yet still shows the cap-based ceiling (unchanged behavior)', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLoraCompat, modLoraB]);
    expect(matrixTotalLabel(cells, null).isCeiling).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pre-run representative estimate (kills the ~25× cap-based over-estimate)
// ---------------------------------------------------------------------------

describe('representativeModifier', () => {
  it('prefers the first selected LoRA (more expensive) over a baseline', () => {
    const mod = representativeModifier([modBase, modCine, modLoraCompat]);
    expect(mod).toBe(modLoraCompat);
  });
  it('falls back to the first modifier when no LoRA is selected', () => {
    expect(representativeModifier([modBase, modCine])).toBe(modBase);
  });
  it('is undefined when there are no modifiers', () => {
    expect(representativeModifier([])).toBeUndefined();
  });
});

describe('representativeEstimateBody', () => {
  it('builds a LoRA cell body when a LoRA is selected (realistic upper-ish typical)', () => {
    const body = representativeEstimateBody('a cat', [ckptA, ckptB], [modBase, modLoraCompat]);
    expect(body).not.toBeNull();
    // First selected checkpoint × the representative (LoRA) modifier.
    expect(body!.modelVersionId).toBe(ckptA.versionId);
    expect(body!.additionalResources).toEqual([{ modelVersionId: 407532, strength: 0.8 }]);
  });
  it('builds a baseline body when no LoRA is selected (no additionalResources)', () => {
    const body = representativeEstimateBody('a cat', [ckptA], [modBase, modCine]);
    expect(body).not.toBeNull();
    expect(body!.additionalResources).toBeUndefined();
    expect(body!.params.prompt).toBe('a cat'); // baseline = shared prompt verbatim
  });
  it('returns null when the prompt is empty (nothing to price → keep the fallback)', () => {
    expect(representativeEstimateBody('   ', [ckptA], [modBase])).toBeNull();
  });
  it('returns null when no checkpoint is selected', () => {
    expect(representativeEstimateBody('a cat', [], [modBase])).toBeNull();
  });
  it('returns null when no modifier is selected', () => {
    expect(representativeEstimateBody('a cat', [ckptA], [])).toBeNull();
  });
});

describe('estimateSignature', () => {
  it('changes when the prompt changes', () => {
    const a = estimateSignature('a cat', [ckptA], [modBase]);
    const b = estimateSignature('a dog', [ckptA], [modBase]);
    expect(a).not.toBe(b);
  });
  it('changes when the representative checkpoint changes', () => {
    const a = estimateSignature('a cat', [ckptA], [modBase]);
    const b = estimateSignature('a cat', [ckptB], [modBase]);
    expect(a).not.toBe(b);
  });
  it('changes when a LoRA is added (representative modifier changes)', () => {
    const a = estimateSignature('a cat', [ckptA], [modBase]);
    const b = estimateSignature('a cat', [ckptA], [modBase, modLoraCompat]);
    expect(a).not.toBe(b);
  });
  it('is stable when a non-representative prompt-style modifier is toggled', () => {
    // Both have modBase as the representative (no LoRA) → same per-cell estimate.
    const a = estimateSignature('a cat', [ckptA], [modBase]);
    const b = estimateSignature('a cat', [ckptA], [modBase, modCine]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Failed-cell copy — friendly label + preserved raw detail
// ---------------------------------------------------------------------------

describe('failedCellLabel / failedCellDetail', () => {
  it('shows a calm, actionable label (not the raw server string)', () => {
    expect(failedCellLabel()).toBe("Couldn't generate — try again");
  });
  it('preserves the raw error as the tooltip detail', () => {
    expect(failedCellDetail('TRPCError: prompt rejected by audit')).toBe(
      'TRPCError: prompt rejected by audit',
    );
  });
  it('returns undefined (no tooltip) for empty / null detail', () => {
    expect(failedCellDetail(null)).toBeUndefined();
    expect(failedCellDetail(undefined)).toBeUndefined();
    expect(failedCellDetail('   ')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Run progress — "Generating… N of M done"
// ---------------------------------------------------------------------------

describe('runProgress / runProgressLabel', () => {
  const withStatuses = (statuses: MatrixCell['status'][]): MatrixCell[] =>
    statuses.map((status, i) => ({
      id: `c${i}`,
      checkpoint: ckptA,
      modifier: modBase,
      row: 0,
      col: i,
      status,
      prompt: 'p',
      workflowId: null,
      imageUrl: null,
      cost: null,
      error: null,
    }));

  it('counts terminal generatable cells as done, all generatable as total', () => {
    const cells = withStatuses(['done', 'failed', 'polling', 'idle']);
    expect(runProgress(cells)).toEqual({ done: 2, total: 4 }); // done+failed terminal
  });
  it('excludes blocked AND canceled cells from both done and total', () => {
    const cells = withStatuses(['done', 'blocked', 'canceled', 'polling']);
    // generatable = done + polling (2); done terminal = 1
    expect(runProgress(cells)).toEqual({ done: 1, total: 2 });
  });
  it('counts insufficient as done (terminal)', () => {
    const cells = withStatuses(['insufficient', 'idle']);
    expect(runProgress(cells)).toEqual({ done: 1, total: 2 });
  });
  it('renders the status-line copy', () => {
    const cells = withStatuses(['done', 'idle', 'idle']);
    expect(runProgressLabel(cells)).toBe('Generating… 1 of 3 done');
  });
});

// ---------------------------------------------------------------------------
// Insufficient-Buzz / scope / snapshot helpers
// ---------------------------------------------------------------------------

describe('isInsufficientBuzz', () => {
  it('catches the common phrasings', () => {
    expect(isInsufficientBuzz('Insufficient Buzz to run this generation.')).toBe(true);
    expect(isInsufficientBuzz('You do not have enough Buzz')).toBe(true);
    expect(isInsufficientBuzz('budget exceeded')).toBe(true);
    expect(isInsufficientBuzz('Low balance')).toBe(true);
  });
  it('matches the exact host preflight string', () => {
    // The literal string blocks.router mints when estimate > budget (M3).
    expect(
      isInsufficientBuzz('insufficient buzz budget: estimate 900 exceeds budget 200'),
    ).toBe(true);
  });
  it('is false for unrelated / empty errors', () => {
    expect(isInsufficientBuzz('prompt was rejected by the audit')).toBe(false);
    expect(isInsufficientBuzz(null)).toBe(false);
    expect(isInsufficientBuzz(undefined)).toBe(false);
    expect(isInsufficientBuzz('')).toBe(false);
  });
  it('M3: does NOT over-match an unrelated error that merely mentions buzz/budget', () => {
    // These are the false-positives the tightened sniff eliminates — none is a
    // funds shortfall, so none should surface a (wrong) Top-Up CTA.
    expect(isInsufficientBuzz('buzz workflow crashed')).toBe(false);
    expect(isInsufficientBuzz('the buzz service is temporarily unavailable')).toBe(false);
    expect(isInsufficientBuzz('failed to reach the buzz orchestrator')).toBe(false);
    expect(isInsufficientBuzz('render budget for the frame was recalculated')).toBe(false);
  });
});

describe('snapshotErrorCode (M3 — client-ready for the upstream structured code)', () => {
  it('reads a known structured code off the snapshot when present', () => {
    expect(snapshotErrorCode({ status: 'failed', errorCode: 'INSUFFICIENT_BUZZ' })).toBe(
      'INSUFFICIENT_BUZZ',
    );
    expect(snapshotErrorCode({ status: 'failed', errorCode: 'WORKFLOW_FAILED' })).toBe(
      'WORKFLOW_FAILED',
    );
  });
  it('is undefined when absent (today) or unrecognized', () => {
    expect(snapshotErrorCode({ status: 'failed' })).toBeUndefined();
    expect(snapshotErrorCode({ status: 'failed', errorCode: 'SOMETHING_ELSE' })).toBeUndefined();
  });
  it('cellStatusForSnapshot PREFERS the structured code over the text sniff', () => {
    // A failed snapshot whose free-text says nothing about money, but whose
    // structured code IS insufficient → insufficient (structured wins).
    expect(
      cellStatusForSnapshot(snap({ status: 'failed', error: 'generic', errorCode: 'INSUFFICIENT_BUZZ' } as never)),
    ).toBe('insufficient');
    // A structured WORKFLOW_FAILED with money-ish text → still failed (code wins).
    expect(
      cellStatusForSnapshot(snap({ status: 'failed', error: 'insufficient', errorCode: 'WORKFLOW_FAILED' } as never)),
    ).toBe('failed');
  });
});

describe('hasBudgetedScope', () => {
  it('true only when ai:write:budgeted is present', () => {
    expect(hasBudgetedScope(['ai:write:budgeted'])).toBe(true);
    expect(hasBudgetedScope(['x', 'ai:write:budgeted'])).toBe(true);
  });
  it('false when absent / withheld / undefined', () => {
    expect(hasBudgetedScope([])).toBe(false);
    expect(hasBudgetedScope(['x'])).toBe(false);
    expect(hasBudgetedScope(undefined)).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('terminal for end states', () => {
    for (const s of ['succeeded', 'failed', 'expired', 'canceled'] as const) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  it('non-terminal for in-flight states', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
  });
});

describe('firstImageUrl', () => {
  it('returns the first url', () => {
    expect(firstImageUrl(snap({ status: 'succeeded', imageUrls: ['a', 'b'] }))).toBe('a');
  });
  it('null when no images', () => {
    expect(firstImageUrl(snap({ status: 'succeeded', imageUrls: [] }))).toBe(null);
    expect(firstImageUrl(snap({ status: 'succeeded' }))).toBe(null);
    expect(firstImageUrl(null)).toBe(null);
  });
});

describe('cellStatusForSnapshot', () => {
  it('maps in-flight to polling', () => {
    expect(cellStatusForSnapshot(snap({ status: 'pending' }))).toBe('polling');
    expect(cellStatusForSnapshot(snap({ status: 'processing' }))).toBe('polling');
  });
  it('maps success to done', () => {
    expect(cellStatusForSnapshot(snap({ status: 'succeeded' }))).toBe('done');
  });
  it('maps a plain failure to failed', () => {
    expect(cellStatusForSnapshot(snap({ status: 'failed', error: 'audit rejected' }))).toBe(
      'failed',
    );
  });
  it('maps an insufficient-Buzz failure to insufficient', () => {
    expect(cellStatusForSnapshot(snap({ status: 'failed', error: 'Insufficient Buzz' }))).toBe(
      'insufficient',
    );
  });
  it('maps expired (no buzz text) to failed', () => {
    expect(cellStatusForSnapshot(snap({ status: 'expired' }))).toBe('failed');
  });
  it('maps a server-canceled snapshot to the muted canceled status (not failed)', () => {
    // A canceled workflow is the user's own Stop landing — render it muted, not red.
    expect(cellStatusForSnapshot(snap({ status: 'canceled' }))).toBe('canceled');
    // Even if the canceled snapshot carries buzz-ish text, canceled wins (no spend).
    expect(cellStatusForSnapshot(snap({ status: 'canceled', error: 'budget' }))).toBe('canceled');
  });
});

// ---------------------------------------------------------------------------
// The grid/queue reducer — cell status transitions
// ---------------------------------------------------------------------------

describe('matrixReducer', () => {
  const build = (mods: ModifierOption[] = [modBase, modCine]): MatrixState =>
    matrixReducer(initialMatrixState, {
      type: 'BUILD',
      cells: buildMatrix('a cat', [ckptA, ckptB], mods),
    });

  it('BUILD resets to building phase with fresh cells', () => {
    const s = build();
    expect(s.phase).toBe('building');
    expect(s.cells).toHaveLength(4);
    expect(s.perCellEstimate).toBeNull();
  });

  it('REQUEST_CONFIRM → confirming; NEEDS_CONSENT → needs-consent; START_RUN → running', () => {
    let s = build();
    s = matrixReducer(s, { type: 'REQUEST_CONFIRM' });
    expect(s.phase).toBe('confirming');
    s = matrixReducer(s, { type: 'NEEDS_CONSENT' });
    expect(s.phase).toBe('needs-consent');
    s = matrixReducer(s, { type: 'START_RUN' });
    expect(s.phase).toBe('running');
  });

  it('SET_PER_CELL_ESTIMATE records the estimate', () => {
    const s = matrixReducer(build(), { type: 'SET_PER_CELL_ESTIMATE', estimate: 8 });
    expect(s.perCellEstimate).toBe(8);
  });

  it('full lifecycle of one cell: idle → estimating → submitting → polling → done', () => {
    let s = matrixReducer(build(), { type: 'START_RUN' });
    const id = s.cells[0].id;
    s = matrixReducer(s, { type: 'CELL_STATUS', id, status: 'estimating' });
    expect(s.cells.find((c) => c.id === id)!.status).toBe('estimating');
    s = matrixReducer(s, { type: 'CELL_STATUS', id, status: 'submitting' });
    expect(s.cells.find((c) => c.id === id)!.status).toBe('submitting');
    s = matrixReducer(s, { type: 'CELL_SUBMITTED', id, workflowId: 'wf1' });
    const polling = s.cells.find((c) => c.id === id)!;
    expect(polling.status).toBe('polling');
    expect(polling.workflowId).toBe('wf1');
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id,
      snapshot: snap({ status: 'succeeded', cost: { total: 8 }, imageUrls: ['u'] }),
    });
    const done = s.cells.find((c) => c.id === id)!;
    expect(done.status).toBe('done');
    expect(done.cost).toBe(8);
    expect(done.imageUrl).toBe('u');
  });

  it('CELL_RESULT only patches the target cell', () => {
    let s = matrixReducer(build(), { type: 'START_RUN' });
    const [a, b] = s.cells;
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: a.id,
      snapshot: snap({ status: 'succeeded', cost: { total: 5 } }),
    });
    expect(s.cells.find((c) => c.id === a.id)!.status).toBe('done');
    expect(s.cells.find((c) => c.id === b.id)!.status).toBe('idle');
  });

  it('CELL_RESULT with insufficient-Buzz failure → insufficient + error', () => {
    let s = matrixReducer(build(), { type: 'START_RUN' });
    const id = s.cells[0].id;
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id,
      snapshot: snap({ status: 'failed', error: 'Insufficient Buzz' }),
    });
    const cell = s.cells.find((c) => c.id === id)!;
    expect(cell.status).toBe('insufficient');
    expect(cell.error).toBe('Insufficient Buzz');
  });

  it('CELL_ERROR maps a generic failure to failed (with message)', () => {
    const s0 = matrixReducer(build(), { type: 'START_RUN' });
    const id = s0.cells[0].id;
    const s = matrixReducer(s0, { type: 'CELL_ERROR', id, error: 'boom', insufficient: false });
    const cell = s.cells.find((c) => c.id === id)!;
    expect(cell.status).toBe('failed');
    expect(cell.error).toBe('boom');
  });

  it('CELL_ERROR maps an insufficient-Buzz failure to insufficient', () => {
    const s0 = matrixReducer(build(), { type: 'START_RUN' });
    const id = s0.cells[0].id;
    const s = matrixReducer(s0, {
      type: 'CELL_ERROR',
      id,
      error: 'no buzz',
      insufficient: true,
    });
    expect(s.cells.find((c) => c.id === id)!.status).toBe('insufficient');
  });

  it('CELL_ERROR maps a server incompatibility reject to blocked (muted), not failed', () => {
    const s0 = matrixReducer(build(), { type: 'START_RUN' });
    const id = s0.cells[0].id;
    const s = matrixReducer(s0, {
      type: 'CELL_ERROR',
      id,
      error: 'BAD_REQUEST: a selected LoRA is not compatible with the checkpoint base model',
      insufficient: false,
      incompatible: true,
    });
    const cell = s.cells.find((c) => c.id === id)!;
    expect(cell.status).toBe('blocked'); // muted, money-safe — NOT red failed
    // The raw server string is replaced with a clean, unobtrusive reason.
    expect(cell.error).toBe('Incompatible — base model mismatch');
  });

  it('CELL_ERROR: incompatible takes precedence over the insufficient flag', () => {
    const s0 = matrixReducer(build(), { type: 'START_RUN' });
    const id = s0.cells[0].id;
    const s = matrixReducer(s0, {
      type: 'CELL_ERROR',
      id,
      error: 'not compatible with the checkpoint base model',
      insufficient: true,
      incompatible: true,
    });
    expect(s.cells.find((c) => c.id === id)!.status).toBe('blocked');
  });

  it('transitions to done only once every generatable cell is terminal', () => {
    let s = matrixReducer(build([modBase]), { type: 'START_RUN' }); // 2 cells (A,B × baseline)
    const ids = s.cells.map((c) => c.id);
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: ids[0],
      snapshot: snap({ status: 'succeeded', cost: { total: 8 } }),
    });
    expect(s.phase).toBe('running'); // one still pending
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: ids[1],
      snapshot: snap({ status: 'failed', error: 'x' }),
    });
    expect(s.phase).toBe('done'); // both terminal
  });

  it('a matrix where every cell was server-blocked is complete', () => {
    const cells = buildMatrix('a cat', [ckptA, ckptB], [modLora]); // builds idle
    cells.forEach((c) => (c.status = 'blocked')); // server rejected them all
    let s = matrixReducer(initialMatrixState, { type: 'BUILD', cells });
    s = matrixReducer(s, { type: 'START_RUN' });
    // No generatable cells → isRunComplete true; a no-op dispatch finalizes.
    expect(isRunComplete(s.cells)).toBe(true);
  });

  it('RESET returns to the initial state', () => {
    const s = matrixReducer(build(), { type: 'RESET' });
    expect(s).toEqual(initialMatrixState);
  });

  // -- RETRY_FAILED: re-run ONLY failed/insufficient cells, never re-charge done --

  it('RETRY_FAILED re-queues only failed + insufficient cells, preserving done/blocked/canceled', () => {
    // 2×2 matrix (A,B × baseline,cine) = 4 cells.
    let s = matrixReducer(build(), { type: 'START_RUN' });
    const [a, b, c2, d] = s.cells;
    // a → done (with cost+image), b → failed, c → insufficient, d → blocked.
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: a.id,
      snapshot: snap({ status: 'succeeded', cost: { total: 8 }, imageUrls: ['img'] }),
    });
    s = matrixReducer(s, { type: 'CELL_ERROR', id: b.id, error: 'boom', insufficient: false });
    s = matrixReducer(s, { type: 'CELL_ERROR', id: c2.id, error: 'no buzz', insufficient: true });
    s = matrixReducer(s, {
      type: 'CELL_ERROR',
      id: d.id,
      error: 'x',
      insufficient: false,
      incompatible: true,
    });
    expect(s.phase).toBe('done');

    const before = new Map(s.cells.map((c) => [c.id, c]));
    s = matrixReducer(s, { type: 'RETRY_FAILED' });

    // Resumed the run.
    expect(s.phase).toBe('running');
    const after = new Map(s.cells.map((c) => [c.id, c]));
    // Done cell UNCHANGED — same cost + image, NOT re-queued (no double-charge).
    expect(after.get(a.id)!.status).toBe('done');
    expect(after.get(a.id)!.cost).toBe(8);
    expect(after.get(a.id)!.imageUrl).toBe('img');
    // Blocked cell preserved (still terminal, costs 0).
    expect(after.get(d.id)!.status).toBe('blocked');
    // Failed + insufficient re-entered idle with cleared error/workflow.
    expect(after.get(b.id)!.status).toBe('idle');
    expect(after.get(b.id)!.error).toBeNull();
    expect(after.get(c2.id)!.status).toBe('idle');
    expect(after.get(c2.id)!.error).toBeNull();
    // The done cell object's cost was not touched between snapshots.
    expect(before.get(a.id)!.cost).toBe(after.get(a.id)!.cost);
  });

  it('RETRY_FAILED is a no-op when nothing is retryable (all done/blocked)', () => {
    let s = matrixReducer(build([modBase]), { type: 'START_RUN' }); // 2 cells
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: s.cells[0].id,
      snapshot: snap({ status: 'succeeded', cost: { total: 8 } }),
    });
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: s.cells[1].id,
      snapshot: snap({ status: 'succeeded', cost: { total: 8 } }),
    });
    expect(s.phase).toBe('done');
    const after = matrixReducer(s, { type: 'RETRY_FAILED' });
    expect(after).toBe(s); // referential no-op — stays done, nothing re-queued
  });

  // -- STOP_RUN: cancel idle cells (no spend), leave in-flight for the driver --

  it('STOP_RUN marks idle cells canceled (no spend) and leaves in-flight cells alone', () => {
    let s = matrixReducer(build(), { type: 'START_RUN' }); // 4 cells
    const [a, b, c2, d] = s.cells;
    // a polling (in-flight), b done, c/d idle.
    s = matrixReducer(s, { type: 'CELL_SUBMITTED', id: a.id, workflowId: 'wf1' });
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: b.id,
      snapshot: snap({ status: 'succeeded', cost: { total: 8 } }),
    });
    s = matrixReducer(s, { type: 'STOP_RUN' });

    const after = new Map(s.cells.map((c) => [c.id, c]));
    expect(after.get(c2.id)!.status).toBe('canceled'); // idle → canceled
    expect(after.get(d.id)!.status).toBe('canceled');
    expect(after.get(a.id)!.status).toBe('polling'); // in-flight LEFT alone
    expect(after.get(b.id)!.status).toBe('done'); // done preserved
    // Canceled cells carry no cost.
    expect(after.get(c2.id)!.cost).toBeNull();
    expect(after.get(d.id)!.cost).toBeNull();
    // Still running until the in-flight cell resolves.
    expect(s.phase).toBe('running');
  });

  it('STOP_RUN with nothing in-flight finalizes the run to done immediately', () => {
    let s = matrixReducer(build([modBase]), { type: 'START_RUN' }); // 2 idle cells
    s = matrixReducer(s, { type: 'STOP_RUN' });
    expect(s.cells.every((c) => c.status === 'canceled')).toBe(true);
    expect(s.phase).toBe('done'); // no generatable cells left → complete
  });

  it('STOP_RUN then the in-flight cell resolving (canceled snapshot) completes the run, no spend', () => {
    let s = matrixReducer(build([modBase]), { type: 'START_RUN' }); // 2 cells
    const [a, b] = s.cells;
    s = matrixReducer(s, { type: 'CELL_SUBMITTED', id: a.id, workflowId: 'wf1' });
    s = matrixReducer(s, { type: 'STOP_RUN' }); // b idle → canceled, a still polling
    expect(s.phase).toBe('running');
    // The orchestrator cancel() lands a canceled snapshot for a.
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id: a.id,
      snapshot: snap({ status: 'canceled', workflowId: 'wf1' }),
    });
    const aCell = s.cells.find((c) => c.id === a.id)!;
    const bCell = s.cells.find((c) => c.id === b.id)!;
    expect(aCell.status).toBe('canceled'); // canceled snapshot → muted canceled
    expect(bCell.status).toBe('canceled');
    expect(s.phase).toBe('done');
    expect(totalSpent(s.cells)).toBe(0); // STOP spent nothing
  });
});

describe('isRunComplete', () => {
  it('false while any generatable cell is non-terminal', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modCine]);
    cells[0].status = 'done';
    cells[1].status = 'polling';
    expect(isRunComplete(cells)).toBe(false);
  });
  it('true when all generatable cells terminal (server-blocked ones ignored)', () => {
    const cells = buildMatrix('a cat', [ckptA], [modBase, modCine, modLora]);
    // Simulate the server rejecting the LoRA cell pre-spend.
    cells.filter((c) => c.modifier.key === 'lora-x').forEach((c) => (c.status = 'blocked'));
    cells.filter((c) => c.status !== 'blocked').forEach((c) => (c.status = 'done'));
    expect(isRunComplete(cells)).toBe(true);
  });
  it('true when every cell was server-blocked (no generatable cells)', () => {
    const cells = buildMatrix('a cat', [ckptA], [modLora]);
    cells.forEach((c) => (c.status = 'blocked'));
    expect(isRunComplete(cells)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency-limited queue scheduling
// ---------------------------------------------------------------------------

describe('queue scheduling', () => {
  const makeCells = (statuses: MatrixCell['status'][]): MatrixCell[] =>
    statuses.map((status, i) => ({
      id: `c${i}`,
      checkpoint: ckptA,
      modifier: modBase,
      row: 0,
      col: i,
      status,
      prompt: 'p',
      workflowId: null,
      imageUrl: null,
      cost: null,
      error: null,
    }));

  it('inFlightCells counts estimating/submitting/polling', () => {
    const cells = makeCells(['idle', 'estimating', 'submitting', 'polling', 'done', 'blocked']);
    expect(inFlightCells(cells).map((c) => c.status)).toEqual([
      'estimating',
      'submitting',
      'polling',
    ]);
  });

  it('pendingCells counts only idle', () => {
    const cells = makeCells(['idle', 'idle', 'polling', 'done', 'blocked']);
    expect(pendingCells(cells)).toHaveLength(2);
  });

  it('nextCellsToStart fills up to the concurrency limit', () => {
    const cells = makeCells(['idle', 'idle', 'idle', 'idle']);
    expect(nextCellsToStart(cells, 2)).toHaveLength(2);
    expect(nextCellsToStart(cells, 3)).toHaveLength(3);
  });

  it('nextCellsToStart accounts for already in-flight cells', () => {
    const cells = makeCells(['polling', 'idle', 'idle', 'idle']);
    // 1 in-flight, limit 3 → start 2 more
    expect(nextCellsToStart(cells, 3)).toHaveLength(2);
  });

  it('nextCellsToStart returns empty when at/over the limit', () => {
    const cells = makeCells(['polling', 'polling', 'polling', 'idle']);
    expect(nextCellsToStart(cells, 3)).toHaveLength(0);
    expect(nextCellsToStart(cells, 2)).toHaveLength(0);
  });

  it('nextCellsToStart never returns blocked cells', () => {
    const cells = makeCells(['blocked', 'blocked', 'idle']);
    expect(nextCellsToStart(cells, 3).every((c) => c.status === 'idle')).toBe(true);
    expect(nextCellsToStart(cells, 3)).toHaveLength(1);
  });

  it('nextCellsToStart preserves row-major (queue) order', () => {
    const cells = makeCells(['idle', 'idle', 'idle']);
    expect(nextCellsToStart(cells, 2).map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('clamps a bogus concurrency to at least 1', () => {
    const cells = makeCells(['idle', 'idle']);
    expect(nextCellsToStart(cells, 0)).toHaveLength(1);
    expect(nextCellsToStart(cells, -5)).toHaveLength(1);
  });

  it('default concurrency is within the spec 2–3 range', () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-2 — Stop honesty: a mid-`submit` cell (no workflowId yet) can't be
// cleanly canceled and may still complete + bill. The UI must distinguish it
// and warn, never imply it was canceled.
// ---------------------------------------------------------------------------

const mkCell = (over: Partial<MatrixCell>): MatrixCell => ({
  id: over.id ?? 'x',
  checkpoint: ckptA,
  modifier: modBase,
  row: 0,
  col: 0,
  status: 'idle',
  prompt: 'p',
  workflowId: null,
  imageUrl: null,
  cost: null,
  error: null,
  ...over,
});

describe('isUncancelableInFlight / uncancelableInFlightCount (MEDIUM-2)', () => {
  it('a submitting cell with NO workflowId is uncancelable (may still bill)', () => {
    expect(isUncancelableInFlight(mkCell({ status: 'submitting', workflowId: null }))).toBe(true);
  });
  it('an estimating cell with NO workflowId is uncancelable', () => {
    expect(isUncancelableInFlight(mkCell({ status: 'estimating', workflowId: null }))).toBe(true);
  });
  it('a polling cell HAS a workflowId → cancelable (Stop can cancel() it)', () => {
    expect(isUncancelableInFlight(mkCell({ status: 'polling', workflowId: 'wf' }))).toBe(false);
  });
  it('a submitting cell that already has a workflowId is cancelable', () => {
    expect(isUncancelableInFlight(mkCell({ status: 'submitting', workflowId: 'wf' }))).toBe(false);
  });
  it('terminal / idle cells are never uncancelable-in-flight', () => {
    for (const status of ['idle', 'done', 'failed', 'canceled', 'blocked'] as const) {
      expect(isUncancelableInFlight(mkCell({ status }))).toBe(false);
    }
  });
  it('counts only the uncancelable in-flight cells', () => {
    const cells = [
      mkCell({ id: 'a', status: 'submitting', workflowId: null }), // uncancelable
      mkCell({ id: 'b', status: 'estimating', workflowId: null }), // uncancelable
      mkCell({ id: 'c', status: 'polling', workflowId: 'wf' }), // cancelable
      mkCell({ id: 'd', status: 'idle' }),
      mkCell({ id: 'e', status: 'done' }),
    ];
    expect(uncancelableInFlightCount(cells)).toBe(2);
  });
  it('stopInProgressWarning is honest about possible charges', () => {
    const w = stopInProgressWarning().toLowerCase();
    expect(w).toContain('charged');
    expect(w).toContain('complete');
  });
});

// ---------------------------------------------------------------------------
// LOW-2 — top-up suggestion sized to the run's actual cost, not the cap × 10.
// ---------------------------------------------------------------------------

describe('suggestedTopUpAmount (LOW-2)', () => {
  it('uses the landed per-cell estimate × cells', () => {
    expect(suggestedTopUpAmount(12, 9)).toBe(12 * 9); // 108, not 200×10×12 = 24,000
  });
  it('is far below the old cap×10×cells heuristic', () => {
    const landed = suggestedTopUpAmount(12, 9);
    const oldHeuristic = PAGE_BUZZ_BUDGET_PER_CELL * 10 * 12;
    expect(landed).toBeLessThan(oldHeuristic);
  });
  it('falls back to the per-cell budget when no estimate landed', () => {
    expect(suggestedTopUpAmount(3, null)).toBe(3 * PAGE_BUZZ_BUDGET_PER_CELL);
    expect(suggestedTopUpAmount(3, 0)).toBe(3 * PAGE_BUZZ_BUDGET_PER_CELL);
    expect(suggestedTopUpAmount(3, NaN)).toBe(3 * PAGE_BUZZ_BUDGET_PER_CELL);
  });
  it('never suggests below the minimum floor', () => {
    expect(suggestedTopUpAmount(1, 1)).toBe(MIN_TOPUP_SUGGESTION); // 1×1 floored
    expect(suggestedTopUpAmount(0, 5)).toBe(MIN_TOPUP_SUGGESTION); // 0 cells → ≥ floor
  });
  it('rounds up a fractional estimate (never under-suggests)', () => {
    // Use values above the floor so the rounding behavior is what's under test.
    expect(suggestedTopUpAmount(40, 8.4)).toBe(Math.ceil(40 * 8.4)); // 336
  });
});

// ---------------------------------------------------------------------------
// LOW-3 — bounded poll: a give-up surfaces the terminal-ish `timedout` state
// (still running server-side; NOT retryable → no re-charge).
// ---------------------------------------------------------------------------

describe('CELL_TIMEDOUT + timedout terminal state (LOW-3)', () => {
  const runningWithPolling = (): MatrixState => {
    let s = matrixReducer(initialMatrixState, {
      type: 'BUILD',
      cells: buildMatrix('a cat', [ckptA], [modBase]),
    });
    s = matrixReducer(s, { type: 'START_RUN' });
    const id = s.cells[0].id;
    s = matrixReducer(s, { type: 'CELL_SUBMITTED', id, workflowId: 'wf' });
    return s;
  };

  it('CELL_TIMEDOUT flips a polling cell to terminal `timedout`', () => {
    const s0 = runningWithPolling();
    const id = s0.cells[0].id;
    const s = matrixReducer(s0, { type: 'CELL_TIMEDOUT', id });
    expect(s.cells.find((c) => c.id === id)!.status).toBe('timedout');
  });

  it('the run reaches `done` once the only cell times out (timedout is terminal)', () => {
    const s0 = runningWithPolling();
    const s = matrixReducer(s0, { type: 'CELL_TIMEDOUT', id: s0.cells[0].id });
    expect(s.phase).toBe('done');
    expect(isRunComplete(s.cells)).toBe(true);
  });

  it('a late CELL_TIMEDOUT after the result landed does NOT clobber a done cell', () => {
    let s = runningWithPolling();
    const id = s.cells[0].id;
    s = matrixReducer(s, {
      type: 'CELL_RESULT',
      id,
      snapshot: snap({ status: 'succeeded', cost: { total: 7 }, imageUrls: ['u'] }),
    });
    s = matrixReducer(s, { type: 'CELL_TIMEDOUT', id }); // fires too late
    const cell = s.cells.find((c) => c.id === id)!;
    expect(cell.status).toBe('done'); // unchanged — no clobber
    expect(cell.cost).toBe(7);
  });

  it('a timedout cell is NOT re-run by RETRY_FAILED (no double-charge)', () => {
    let s = runningWithPolling();
    const id = s.cells[0].id;
    s = matrixReducer(s, { type: 'CELL_TIMEDOUT', id });
    const after = matrixReducer(s, { type: 'RETRY_FAILED' });
    // RETRY_FAILED is a no-op (nothing failed/insufficient) and never re-queues
    // the timedout cell to idle — so the submitted workflow can't be re-charged.
    expect(after.cells.find((c) => c.id === id)!.status).toBe('timedout');
  });

  it('timedout counts as terminal in runProgress', () => {
    const s = matrixReducer(runningWithPolling(), {
      type: 'CELL_TIMEDOUT',
      id: 'never-mind',
    });
    // (id mismatch → no-op) the polling cell is still in-flight, not yet terminal.
    expect(runProgress(s.cells).done).toBe(0);
    const done = matrixReducer(s, { type: 'CELL_TIMEDOUT', id: s.cells[0].id });
    expect(runProgress(done.cells).done).toBe(1);
  });

  it('the poll cap is a sane bound', () => {
    expect(POLL_MAX_ATTEMPTS).toBeGreaterThan(5);
    expect(Number.isFinite(POLL_MAX_ATTEMPTS)).toBe(true);
  });

  it('timedOutCellLabel reads as "still working", not a failure or "no charge"', () => {
    const l = timedOutCellLabel().toLowerCase();
    expect(l).toContain('still working');
    expect(l).not.toContain('failed');
    expect(l).not.toContain('no charge');
  });
});
