// Pure logic for Gen Matrix. No React, no DOM — unit-tested in node (see
// matrix.test.ts). The App glue imports these so the load-bearing money-safety
// decisions (cap enforcement, total-cost estimation, the queue/grid reducer,
// concurrency limiting, insufficient-Buzz detection, dedup/idempotency) live in
// one tested place.

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';
import type { CheckpointOption, ModifierOption } from './models.js';

// ---------------------------------------------------------------------------
// Constants (mirror server / manifest contracts).
// ---------------------------------------------------------------------------

/** Server prompt cap (`blockWorkflowBodySchema` PROMPT_MAX). */
export const PROMPT_MAX = 1500;

/** The scope the page token must carry before any cell can be submitted. */
export const BUDGETED_SCOPE = 'ai:write:budgeted';

/**
 * Manifest budget (page.buzzBudgetPerGen). The SERVER reads the manifest value
 * at mint and clamps to BUZZ_BUDGET_CAP (1000) PER CELL; this constant drives
 * the client-side total-cost fallback and the Top-Up CTA amount. The real
 * per-cell ceiling is enforced server-side. Set to 200 for the LoRA axis: a
 * checkpoint + 1 LoRA gen costs more than a checkpoint alone, and a low budget
 * risked an immediate `insufficient` on every LoRA cell. 200 covers a single
 * SDXL+LoRA gen with ample headroom; worst-case 12 cells × 200 = 2400 Buzz, far
 * under the 50k daily cap. MUST stay in sync with block.manifest.json's
 * page.buzzBudgetPerGen (currently 200).
 */
export const PAGE_BUZZ_BUDGET_PER_CELL = 200;

/**
 * MONEY SAFETY — the hard client-side cap on matrix size. A page cannot read
 * the viewer's balance (`buzz:read:self` is PAGE-forbidden), so the only way to
 * stop a careless matrix from marching toward the platform per-user daily cap
 * (50,000 Buzz) is to bound the cell count up front. 12 cells × the 1000 server
 * per-cell ceiling = 12,000 worst-case, comfortably under 50k even before the
 * real (~8/cell) cost. The UI MUST disable generate when a selection exceeds
 * this, and MUST show the estimated total + an explicit confirm before spend.
 */
export const MAX_CELLS = 12;

/** The platform per-user daily Buzz cap — surfaced in copy, never relied on. */
export const DAILY_BUZZ_CAP = 50_000;

// ---------------------------------------------------------------------------
// Prompt + body building.
// ---------------------------------------------------------------------------

/** Trim + clamp a prompt to the server cap so submit can't be rejected on length. */
export function clampPrompt(raw: string): string {
  return raw.slice(0, PROMPT_MAX);
}

/**
 * Compose a cell's effective prompt = shared prompt + the modifier's suffix
 * (comma-joined, empty suffix = baseline verbatim). Clamped to the server cap.
 */
export function composeCellPrompt(sharedPrompt: string, modifier: ModifierOption): string {
  const base = sharedPrompt.trim();
  const suffix = modifier.promptSuffix.trim();
  const joined = suffix.length === 0 ? base : base.length === 0 ? suffix : `${base}, ${suffix}`;
  return clampPrompt(joined);
}

/** Default LoRA strength when a modifier omits one. Mirrors the server default. */
export const DEFAULT_LORA_STRENGTH = 1;
/** Server strength bounds for an additionalResources entry. */
export const LORA_STRENGTH_MIN = -1;
export const LORA_STRENGTH_MAX = 2;

/** Clamp a LoRA strength into the server-accepted [-1, 2] range. */
export function clampLoraStrength(strength: number | null | undefined): number {
  const s = strength == null || !Number.isFinite(strength) ? DEFAULT_LORA_STRENGTH : strength;
  return Math.min(LORA_STRENGTH_MAX, Math.max(LORA_STRENGTH_MIN, s));
}

/**
 * Build the textToImage workflow body for a cell. ALWAYS submits the cell's
 * CHECKPOINT as the model (modelType=Checkpoint), with the modifier's prompt
 * folded in via `prompt`. When the modifier is a LoRA, it additionally emits a
 * single `additionalResources` entry { modelVersionId: loraVersionId, strength }
 * layered on the checkpoint (#2640/#2641). A baseline / prompt-only modifier
 * emits NO `additionalResources` (backward-compatible, checkpoint-only).
 *
 * Every cell — including a cross-ecosystem LoRA × checkpoint pairing — is now
 * SUBMITTED; the SERVER is the authority on compatibility. The page-LoRA gate is
 * PRE-SPEND (PR #2660 GA): an incompatible pair is rejected with a `BAD_REQUEST`
 * BEFORE any Buzz is reserved, so attempting an incompatible cell costs nothing.
 * That server reject is surfaced per-cell as `blocked` (see
 * `isIncompatibleResourceError`), NOT a red `failed`.
 */
export function buildCellBody(
  checkpoint: CheckpointOption,
  prompt: string,
  modifier?: ModifierOption,
) {
  const body: {
    kind: 'textToImage';
    modelId: number;
    modelVersionId: number;
    params: { prompt: string };
    additionalResources?: Array<{ modelVersionId: number; strength: number }>;
  } = {
    kind: 'textToImage' as const,
    modelId: checkpoint.modelId,
    modelVersionId: checkpoint.versionId,
    params: { prompt: clampPrompt(prompt.trim()) },
  };
  if (modifier?.loraVersionId != null) {
    body.additionalResources = [
      {
        modelVersionId: modifier.loraVersionId,
        strength: clampLoraStrength(modifier.loraStrength),
      },
    ];
  }
  return body;
}

/**
 * Pick the REPRESENTATIVE modifier to estimate during the BUILD phase, so the
 * confirm gate can show a realistic per-cell number BEFORE the first cell runs.
 *
 * All cells share the same body SHAPE, but a LoRA cell costs more than a
 * baseline / prompt-only one (it layers an `additionalResources` entry). To make
 * the pre-run estimate a realistic upper-ish TYPICAL (not the cap, not an
 * artificially-cheap baseline), prefer the first selected LoRA modifier; if none
 * is selected, fall back to the first selected modifier (a prompt-style /
 * baseline cell). Returns `undefined` when there are no modifiers to estimate.
 *
 * PURE — drives only the displayed estimate label; it does NOT change the cap,
 * the spend accounting, or which cells run.
 */
export function representativeModifier(
  modifiers: readonly ModifierOption[],
): ModifierOption | undefined {
  if (modifiers.length === 0) return undefined;
  const firstLora = modifiers.find((m) => m.loraVersionId != null);
  return firstLora ?? modifiers[0];
}

/**
 * Build the body to fire ONE representative `estimate()` during the BUILD phase
 * (debounced by the caller, only once the prompt is non-empty AND ≥1 checkpoint
 * is selected). Uses the first selected checkpoint + the representative modifier
 * (a LoRA cell if any LoRA is selected, else baseline) so the estimate reflects
 * a realistic typical cell rather than the per-cell safety cap.
 *
 * Returns `null` when there's nothing meaningful to estimate (no checkpoint, no
 * modifier, or an empty prompt) — the caller then keeps the cap-based fallback.
 *
 * PURE — TIMING + shape only. This is the SAME `estimate()` call the run already
 * makes per cell, just fired earlier against a representative body; it touches
 * neither the cap nor the spend accounting.
 */
export function representativeEstimateBody(
  sharedPrompt: string,
  checkpoints: readonly CheckpointOption[],
  modifiers: readonly ModifierOption[],
): ReturnType<typeof buildCellBody> | null {
  if (sharedPrompt.trim().length === 0) return null;
  const checkpoint = checkpoints[0];
  if (!checkpoint) return null;
  const modifier = representativeModifier(modifiers);
  if (!modifier) return null;
  const prompt = composeCellPrompt(sharedPrompt, modifier);
  return buildCellBody(checkpoint, prompt, modifier);
}

/**
 * A stable signature of the current build-phase selection that materially
 * affects the estimate. When it changes, the caller re-fires the representative
 * estimate (debounced). Keyed on the prompt + the representative checkpoint +
 * the representative modifier (a different checkpoint/LoRA can change the cost);
 * adding/removing a NON-representative modifier doesn't change the per-cell
 * estimate, so it intentionally doesn't re-trigger.
 */
export function estimateSignature(
  sharedPrompt: string,
  checkpoints: readonly CheckpointOption[],
  modifiers: readonly ModifierOption[],
): string {
  const checkpoint = checkpoints[0];
  const modifier = representativeModifier(modifiers);
  return [
    sharedPrompt.trim(),
    checkpoint?.versionId ?? 'none',
    modifier?.key ?? 'none',
    modifier?.loraVersionId ?? 'none',
    modifier?.loraStrength ?? 'none',
  ].join('|');
}

// ---------------------------------------------------------------------------
// Combo / matrix building.
// ---------------------------------------------------------------------------

export type CellStatus =
  | 'idle' // queued, not yet started
  | 'estimating'
  | 'submitting'
  | 'polling'
  | 'done'
  | 'failed'
  | 'insufficient' // failed specifically for insufficient Buzz
  | 'blocked' // the SERVER rejected the pairing as incompatible (pre-spend, costs 0)
  | 'canceled' // the user stopped the run before this cell started (idle → canceled, no spend)
  | 'timedout'; // polling gave up after the cap; the gen is STILL running server-side (may finish + bill) — terminal-ish, NOT retryable (no re-charge)

export interface MatrixCell {
  /** Stable, deduped id = `${checkpoint.versionId}::${modifier.key}`. */
  id: string;
  checkpoint: CheckpointOption;
  modifier: ModifierOption;
  /** Grid position. */
  row: number;
  col: number;
  status: CellStatus;
  /** Effective prompt for this cell (shared + modifier suffix). */
  prompt: string;
  workflowId: string | null;
  imageUrl: string | null;
  /** Actual Buzz spent (from the succeeded snapshot). */
  cost: number | null;
  error: string | null;
  /**
   * Per-image maturity level for the result image (G1). `null` = unknown.
   *
   * The LIVE poll/submit path (`BlockWorkflowSnapshot`) carries NO maturity, so
   * this stays `null` for a cell finalized purely from a poll snapshot. It is
   * populated when the cell is reconciled against the persistent read-model
   * (`useAppWorkflows` → `AppWorkflowImage.nsfwLevel`), which the host DOES
   * project. The result image is maturity-gated off this + the domain ceiling
   * (`shouldBlurResult`): a known level above the ceiling — or, fail-closed, an
   * UNKNOWN level on a SFW domain — is blurred-until-revealed so a `g`-rated
   * page never renders ungated mature pixels.
   */
  nsfwLevel?: number | null;
}

/**
 * Build the full set of cells for the selected checkpoints × modifiers, in
 * row-major order (rows=checkpoints, cols=modifiers). Cells are DEDUPED by id
 * so a duplicated selection can't double-bill. EVERY cell — including a
 * cross-ecosystem LoRA × checkpoint pairing — starts `idle` and WILL be
 * attempted; the SERVER is the authority on resource compatibility and rejects
 * an incompatible pair PRE-SPEND (costs 0). The block no longer pre-blocks any
 * cell client-side: the old exact-string family check FALSE-blocked valid
 * cross-ecosystem combos (e.g. a Pony LoRA on an SDXL checkpoint = `'partial'`
 * support the GA gate now accepts). A cell only becomes `blocked` from the
 * server's per-cell reject (see `runCell` → `isIncompatibleResourceError`).
 *
 * Does NOT enforce the cap — that's `exceedsCap` / the caller's gate — so the
 * UI can show the count and the warning before refusing.
 */
export function buildMatrix(
  sharedPrompt: string,
  checkpoints: readonly CheckpointOption[],
  modifiers: readonly ModifierOption[],
): MatrixCell[] {
  const cells: MatrixCell[] = [];
  const seen = new Set<string>();
  checkpoints.forEach((checkpoint, row) => {
    modifiers.forEach((modifier, col) => {
      const id = cellId(checkpoint, modifier);
      if (seen.has(id)) return; // dedup / idempotency
      seen.add(id);
      cells.push({
        id,
        checkpoint,
        modifier,
        row,
        col,
        status: 'idle',
        prompt: composeCellPrompt(sharedPrompt, modifier),
        workflowId: null,
        imageUrl: null,
        cost: null,
        error: null,
        nsfwLevel: null,
      });
    });
  });
  return cells;
}

/** Stable cell id. Same (checkpoint, modifier) ⇒ same id ⇒ deduped. */
export function cellId(checkpoint: CheckpointOption, modifier: ModifierOption): string {
  return `${checkpoint.versionId}::${modifier.key}`;
}

/**
 * Cells that will actually be submitted (excludes server-`blocked` cells AND
 * user-`canceled` cells). A `canceled` cell never started → it costs 0 and is
 * already terminal, so — like `blocked` — it drops out of the billable count and
 * the run-complete check.
 */
export function generatableCells(cells: readonly MatrixCell[]): MatrixCell[] {
  return cells.filter((c) => c.status !== 'blocked' && c.status !== 'canceled');
}

/**
 * Count of cells that count against the cap (the generatable ones).
 *
 * NOTE — conservative OVER-estimate: pre-run, the block CANNOT know which cells
 * the server will reject as incompatible (compatibility is a server authority we
 * don't replicate client-side). So the preview counts EVERY cell as billable,
 * even cross-ecosystem LoRA cells the server may reject pre-spend (those cost 0).
 * The preview total is therefore a worst-case MAXIMUM, never an under-warning —
 * which is the safe direction. Server-rejected cells flip to `blocked` after
 * their (free) submit and drop out of the actual spend; user-`canceled` cells
 * (stopped before they started) likewise cost 0 and drop out.
 */
export function billableCellCount(cells: readonly MatrixCell[]): number {
  return generatableCells(cells).length;
}

/** Does this selection exceed the money-safety cap? */
export function exceedsCap(cells: readonly MatrixCell[]): boolean {
  return billableCellCount(cells) > MAX_CELLS;
}

// ---------------------------------------------------------------------------
// Cost estimation.
// ---------------------------------------------------------------------------

/**
 * How many DISTINCT LoRA "kinds" the matrix's generatable cells span. A LoRA
 * kind = a unique (`loraVersionId`, `loraStrength`) pair — a different LoRA, or
 * the same LoRA at a different strength, can cost differently. Non-LoRA
 * (baseline / prompt-style) cells are NOT counted: they're the cheap base kind.
 *
 * Why ONLY LoRA kinds drive the honesty fallback: the pre-run total is
 * `billableCellCount × ONE representative estimate`, and `representativeModifier`
 * picks the FIRST LoRA (the priciest kind) when any LoRA is selected. With ≤1
 * distinct LoRA, that representative is the most-expensive cell in the matrix, so
 * the estimate OVER-covers every cheaper (baseline / prompt-style) cell — safe,
 * never materially exceeded. The estimate can only be EXCEEDED when there are
 * ≥2 DISTINCT LoRAs and a non-first one costs more than the representative — so
 * that's exactly when `matrixTotalLabel` must drop to the conservative ceiling.
 *
 * PURE — display-only. Does NOT touch the cap, the confirm gate, or accounting.
 */
export function distinctLoraModifierCount(cells: readonly MatrixCell[]): number {
  const loras = new Set<string>();
  for (const cell of generatableCells(cells)) {
    const m = cell.modifier;
    if (m.loraVersionId != null) {
      loras.add(`${m.loraVersionId}:${m.loraStrength ?? DEFAULT_LORA_STRENGTH}`);
    }
  }
  return loras.size;
}

/**
 * The billing "kind" of a cell — the equivalence class over which ONE estimate
 * applies. A non-LoRA (baseline / prompt-style) cell is the cheap base kind
 * (`'base'`); a LoRA cell's kind is its (`loraVersionId`, `loraStrength`) pair
 * (a different LoRA — or the same LoRA at a different strength — can cost
 * differently). Prompt-style suffixes do NOT change the gen cost (same model,
 * same params shape), so every prompt-style column collapses into `'base'`.
 *
 * This is the granularity of the PER-KIND estimate (see `matrixTotalLabelByKind`)
 * that lets the "≈" real-estimate headline SURVIVE the multi-LoRA compare case:
 * instead of one representative estimate over the whole matrix (which undercounts
 * when ≥2 distinct LoRAs differ), we estimate one cell PER kind and sum.
 *
 * PURE — display/estimate-plumbing only; never touches the cap or accounting.
 */
export function cellKindKey(modifier: ModifierOption): string {
  return modifier.loraVersionId != null
    ? `lora:${modifier.loraVersionId}:${modifier.loraStrength ?? DEFAULT_LORA_STRENGTH}`
    : 'base';
}

/** The distinct billing kinds present among a matrix's generatable cells. */
export function distinctCellKinds(cells: readonly MatrixCell[]): string[] {
  const kinds = new Set<string>();
  for (const cell of generatableCells(cells)) kinds.add(cellKindKey(cell.modifier));
  return [...kinds];
}

/** A per-kind estimate map: kind key (see `cellKindKey`) → per-cell Buzz. */
export type KindEstimates = Readonly<Record<string, number>>;

/** True when `v` is a usable positive, finite per-cell estimate. */
function usableEstimate(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/**
 * Sum the matrix total from a PER-KIND estimate map: each generatable cell costs
 * its own kind's estimate. `complete` is true only when EVERY distinct kind
 * present has a usable estimate — the caller shows the precise "≈" headline only
 * then; otherwise it falls back to the conservative cap-based ceiling (a cell
 * whose kind lacks an estimate is charged the safety cap in the sum, so the
 * number can never be materially exceeded regardless).
 *
 * PURE — drives only the displayed label; never the cap, confirm gate, or spend.
 */
export function estimateMatrixTotalByKind(
  cells: readonly MatrixCell[],
  kindEstimates: KindEstimates,
): { total: number; complete: boolean } {
  let total = 0;
  let complete = true;
  for (const cell of generatableCells(cells)) {
    const est = kindEstimates[cellKindKey(cell.modifier)];
    if (usableEstimate(est)) {
      total += est;
    } else {
      complete = false;
      total += PAGE_BUZZ_BUDGET_PER_CELL;
    }
  }
  return { total, complete };
}

/**
 * Total estimated Buzz for a matrix. Uses the per-cell estimate when known
 * (from the orchestrator estimate call), else the manifest per-cell budget as
 * a conservative fallback. Only generatable (non-blocked) cells cost anything.
 *
 * `perCellEstimate` is the orchestrator's estimate for ONE cell (all cells use
 * the same params shape, so one estimate applies to all). When null, fall back
 * to the manifest budget so the confirm dialog always shows a number.
 */
export function estimateMatrixTotal(
  cells: readonly MatrixCell[],
  perCellEstimate: number | null | undefined,
): number {
  const n = billableCellCount(cells);
  const perCell =
    perCellEstimate != null && Number.isFinite(perCellEstimate) && perCellEstimate > 0
      ? perCellEstimate
      : PAGE_BUZZ_BUDGET_PER_CELL;
  return n * perCell;
}

/** Sum of ACTUAL Buzz spent across done cells (for the post-run total). */
export function totalSpent(cells: readonly MatrixCell[]): number {
  return cells.reduce((sum, c) => sum + (c.cost ?? 0), 0);
}

/**
 * A reasonable Buzz amount to pre-fill the purchase modal with when the user
 * needs to top up to finish a matrix. Based on the LANDED per-cell estimate ×
 * the billable cell count (the actual remaining cost), with a sane minimum
 * floor so the modal never suggests a trivially-tiny or zero amount.
 *
 * Replaces the old `cap × 10 × cells` heuristic, which suggested ~24,000 Buzz
 * for a ~100-Buzz matrix (cap is the per-cell SAFETY ceiling, not the cost).
 * Purchase ≠ spend — the user still chooses — but the suggestion should be
 * proportionate to what the run actually costs.
 *
 * Falls back to the per-cell budget (manifest) when no real estimate has landed
 * yet, since that's the only cost signal available pre-estimate. PURE — drives
 * only the suggested purchase amount; never the cap/confirm/accounting.
 */
export const MIN_TOPUP_SUGGESTION = 100;

export function suggestedTopUpAmount(
  billableCells: number,
  perCellEstimate: number | null | undefined,
): number {
  const cells = Math.max(1, billableCells);
  const perCell =
    perCellEstimate != null && Number.isFinite(perCellEstimate) && perCellEstimate > 0
      ? perCellEstimate
      : PAGE_BUZZ_BUDGET_PER_CELL;
  return Math.max(MIN_TOPUP_SUGGESTION, Math.ceil(cells * perCell));
}

/** Format a Buzz cost for display, with thousands separators. `null` → '—'. */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return '—';
  return Math.round(cost).toLocaleString();
}

// ---------------------------------------------------------------------------
// Budget / cost COPY.
//
// All user-facing budget wording lives here so it can be unit-tested in node
// (no DOM) and stays honest: PAGE_BUZZ_BUDGET_PER_CELL (200) is the server-side
// per-gen spend CEILING, NOT the expected cost. The real cost is a few Buzz per
// cell (~3-9). Copy must never imply a cell SPENDS the cap.
// ---------------------------------------------------------------------------

/**
 * Header sub-copy. Frames the 200 as a safety CAP ("capped at"), and states the
 * real cost is small — so the reader does not think each cell spends 200.
 */
export function perCellBudgetCopy(): string {
  return `Each cell spends only its real cost — usually just a few Buzz. (Per-gen spend is capped at ${PAGE_BUZZ_BUDGET_PER_CELL.toLocaleString()} Buzz as a safety limit.)`;
}

/**
 * A displayable cost label for a matrix total. Distinguishes a REAL estimate
 * (the orchestrator's per-cell estimate has landed) from a CEILING-based bound
 * (no estimate yet → the total is the cap × cells, a worst-case MAXIMUM, never
 * the expected spend).
 *
 *  - estimate known  → { amount: "≈ N", isCeiling: false }  (real estimate)
 *  - estimate unknown → { amount: "up to N", isCeiling: true } (cap-based max)
 *
 * The caller renders `amount + " Buzz"`. `isCeiling` lets the UI add a hint that
 * the number is a maximum, not what you'll spend.
 *
 * HONESTY RULE — never show a precise "≈" that can be MATERIALLY EXCEEDED. The
 * total is `billableCellCount × ONE representative per-cell estimate`, and the
 * representative is the FIRST (priciest) LoRA. That over-covers a matrix with
 * ≤1 distinct LoRA. When the matrix mixes ≥2 DISTINCT LoRAs (a non-first one may
 * cost more than the representative), the "≈" could undercount, so we fall back
 * to the conservative ceiling ("up to N") even though an estimate landed — the
 * ceiling can't be exceeded, an undercounting "≈" can.
 */
export interface CostLabel {
  /** The number with its qualifier prefix, e.g. "≈ 24" or "up to 600". */
  amount: string;
  /** True when the number is the cap-based worst case, not a real estimate. */
  isCeiling: boolean;
  /**
   * The cap-based safety maximum (per-cell cap × cells), formatted. ALWAYS
   * present so the UI can demote it to a secondary "safety max N" hint/tooltip
   * even when the headline is the precise "≈" estimate. When `isCeiling` is true
   * this equals the headline number.
   */
  ceilingAmount: string;
}

/**
 * A displayable cost label for a matrix total.
 *
 * The second argument accepts EITHER:
 *  - a single per-cell number (or null) — the LEGACY representative-estimate path
 *    (one estimate applied to every cell). Honest only when ≤1 distinct LoRA is
 *    selected; with ≥2 distinct LoRAs a non-first LoRA may cost more than the
 *    representative, so this path falls back to the cap-based ceiling; or
 *  - a PER-KIND estimate map (`KindEstimates`) — the preferred path that keeps
 *    the precise "≈" headline even when the matrix mixes ≥2 distinct LoRAs, by
 *    estimating one cell per billing kind and summing (`estimateMatrixTotalByKind`).
 *    The "≈" shows only when every distinct kind has a usable estimate.
 *
 * Either way the ceiling (cap × cells) is returned as `ceilingAmount` so the UI
 * can HEADLINE the real "≈" estimate and demote the ceiling to a "safety max …"
 * hint rather than anchoring on the ceiling.
 */
export function matrixTotalLabel(
  cells: readonly MatrixCell[],
  estimate: number | null | undefined | KindEstimates,
): CostLabel {
  const ceilingAmount = formatCost(estimateMatrixTotal(cells, null));

  // Per-kind path: precise "≈" survives the multi-LoRA compare case.
  if (estimate != null && typeof estimate === 'object') {
    const { total, complete } = estimateMatrixTotalByKind(cells, estimate);
    return complete
      ? { amount: `≈ ${formatCost(total)}`, isCeiling: false, ceilingAmount }
      : { amount: `up to ${ceilingAmount}`, isCeiling: true, ceilingAmount };
  }

  // Legacy single-representative-estimate path (unchanged honesty rule).
  const perCellEstimate = estimate;
  const haveEstimate = usableEstimate(perCellEstimate);
  // The representative estimate uses the FIRST (priciest) LoRA, so it over-covers
  // a matrix with ≤1 distinct LoRA. With ≥2 DISTINCT LoRAs a non-first one may
  // cost more → the "≈" could be materially exceeded → show the ceiling instead.
  const representativeIsTrustworthy = distinctLoraModifierCount(cells) <= 1;
  const known = haveEstimate && representativeIsTrustworthy;
  const total = estimateMatrixTotal(cells, known ? perCellEstimate : null);
  const formatted = formatCost(total);
  return known
    ? { amount: `≈ ${formatted}`, isCeiling: false, ceilingAmount }
    : { amount: `up to ${formatted}`, isCeiling: true, ceilingAmount };
}

/**
 * A friendly label for a `failed` cell. The raw server / orchestrator error
 * string is operator-facing noise to a user staring at a grid cell; show a
 * calm, actionable line instead and keep the raw detail in a tooltip (see
 * `failedCellDetail`). Constant so the copy is tested in one place.
 */
export function failedCellLabel(): string {
  return "Couldn't generate — try again";
}

/**
 * The raw failure detail to surface as a `title`/tooltip on a `failed` cell, so
 * the underlying reason is never LOST — just demoted from the primary label.
 * `null`/empty → undefined (no tooltip).
 */
export function failedCellDetail(error: string | null | undefined): string | undefined {
  const trimmed = error?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A plain-language reason for a `blocked` (server-incompatible) cell, so the
 * muted "Incompatible" chip isn't a dead end — the user learns WHY and what to
 * do. When the LoRA carries a `baseModelFamily` we name both families and the
 * fix ("This LoRA is SDXL; your checkpoint is Pony — pick an SDXL checkpoint").
 * Falls back to the stored server error, then a generic line, so a tooltip is
 * ALWAYS available. PURE + constant-ish so the copy is tested in one place.
 */
export function incompatibleCellReason(cell: {
  checkpoint: Pick<CheckpointOption, 'baseModel'>;
  modifier: Pick<ModifierOption, 'baseModelFamily'>;
  error?: string | null;
}): string {
  const family = cell.modifier.baseModelFamily?.trim();
  const ckpt = cell.checkpoint.baseModel?.trim();
  if (family && ckpt) {
    return `This LoRA is ${family}; your checkpoint is ${ckpt} — pick a ${family} checkpoint (or a LoRA that matches ${ckpt}).`;
  }
  const stored = cell.error?.trim();
  if (stored && stored.length > 0) return stored;
  return 'This LoRA is not compatible with the selected checkpoint — pick a checkpoint that matches the LoRA, or a compatible LoRA.';
}

/**
 * Max poll TICKS before `runPollLoop` gives up on a still-`processing` workflow
 * and surfaces the `timedout` state. With the SCHEDULE_MS backoff
 * ([2,2,3,5,8]s, then 8s steady) this is ~> 4 minutes of polling — generous for
 * a normal gen, but bounded so a wedged/zombie workflow can't poll forever.
 * No money impact: the workflow keeps running server-side; we just stop waiting.
 */
export const POLL_MAX_ATTEMPTS = 40;

/**
 * Copy for a `timedout` cell: polling gave up but the gen is still running, so
 * the honest message is "still working — check back later", NOT a failure (and
 * NOT "no charge", since it may still complete + bill). Constant for testing.
 */
export function timedOutCellLabel(): string {
  return 'Still working — check back later';
}

// ---------------------------------------------------------------------------
// Run progress (state-derived).
// ---------------------------------------------------------------------------

export interface RunProgress {
  /** Terminal generatable cells (done / failed / insufficient). */
  done: number;
  /** Total generatable cells (excludes blocked + canceled). */
  total: number;
}

/**
 * Derive run progress for the "Generating… N of M done" line. N = generatable
 * cells that have reached a terminal status; M = total generatable cells (i.e.
 * excluding `blocked` server-rejects and `canceled` cells, which never count
 * toward the running tally). PURE.
 */
export function runProgress(cells: readonly MatrixCell[]): RunProgress {
  const gen = generatableCells(cells);
  const done = gen.filter(
    (c) =>
      c.status === 'done' ||
      c.status === 'failed' ||
      c.status === 'insufficient' ||
      c.status === 'timedout',
  ).length;
  return { done, total: gen.length };
}

/** The running status-line copy: "Generating… N of M done". */
export function runProgressLabel(cells: readonly MatrixCell[]): string {
  const { done, total } = runProgress(cells);
  return `Generating… ${done} of ${total} done`;
}

// ---------------------------------------------------------------------------
// Insufficient-Buzz / error sniffing.
// ---------------------------------------------------------------------------

/**
 * Structured failure discriminator on the snapshot.
 *
 * TODAY the published `BlockWorkflowSnapshot` carries only a free-text `error`
 * (no `error.code`); the host mints the insufficient-Buzz message itself as a
 * preflight string ("insufficient buzz budget: estimate N exceeds budget M").
 * A follow-up civitai PR is scoped to add a structured `errorCode` to the
 * snapshot (schema `blocks/workflow.schema.ts` + the SDK `blocks/types.d.ts`
 * mirror, set at the two router over-budget return sites + `failureSnapshot`).
 *
 * This reader is the CLIENT SIDE of that fix, shipped now: it reads `errorCode`
 * off the snapshot DEFENSIVELY (the field is optional / absent on today's SDK),
 * so the moment the host starts emitting it, classification becomes exact with
 * no further client change. Until then the tightened text sniff below is used.
 */
export type BlockErrorCode = 'INSUFFICIENT_BUZZ' | 'WORKFLOW_FAILED' | 'INCOMPATIBLE_RESOURCE';

export function snapshotErrorCode(
  snapshot: Pick<BlockWorkflowSnapshot, 'status'> & { errorCode?: unknown },
): BlockErrorCode | undefined {
  const code = snapshot.errorCode;
  if (code === 'INSUFFICIENT_BUZZ' || code === 'WORKFLOW_FAILED' || code === 'INCOMPATIBLE_RESOURCE') {
    return code;
  }
  return undefined;
}

/**
 * Sniff a workflow failure / error string for insufficient-Buzz language so a
 * cell can swap to a Top-Up CTA.
 *
 * TIGHTENED (M3): the old heuristic OR-matched bare substrings `budget`,
 * `balance`, `buzz` — so ANY failure text containing the word "buzz" (e.g. "buzz
 * workflow crashed", "buzz service unavailable") was mis-classified as
 * insufficient and shown a wrong Top-Up CTA. The host's real preflight string is
 * `insufficient buzz budget: estimate N exceeds budget M`. Require the
 * load-bearing CONJUNCTION — "insufficient"/"not enough" WITH a money noun, or
 * the literal "exceeds budget" — so an unrelated error mentioning "buzz" can no
 * longer over-match. Prefer `snapshotErrorCode()` when the structured field is
 * present; this text path is the fallback for today's free-text-only snapshot.
 */
export function isInsufficientBuzz(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // A "money noun" — a word that grounds a shortfall as a FUNDS shortfall.
  const moneyNoun =
    m.includes('buzz') || m.includes('budget') || m.includes('balance') || m.includes('credit');
  // A generic shortfall token that, on its OWN, can describe a NON-money failure
  // ("insufficient VRAM", "insufficient permissions", "not enough disk"). It only
  // counts as insufficient-Buzz in CONJUNCTION with a money noun — this is the
  // load-bearing rule that keeps a wrong "Out of Buzz — top up" CTA (and the
  // unnecessary purchase it could induce) off an unrelated failure. The bare
  // `buzz`/`budget`/`balance` OR-matchers were already removed.
  const shortfall = m.includes('insufficient') || m.includes('not enough');
  return (
    (shortfall && moneyNoun) || // "insufficient buzz budget…", "not enough balance"
    m.includes('enough buzz') || // "you do not have enough Buzz"
    m.includes('out of buzz') ||
    // Budget/balance-SPECIFIC phrases are self-grounding (no separate noun needed):
    m.includes('exceeds budget') || // the host preflight string's tail
    m.includes('budget exceeded') ||
    m.includes('over budget') ||
    m.includes('low balance') ||
    m.includes('balance too low')
  );
}

/**
 * Sniff a submit/estimate error for the SERVER's page-LoRA incompatibility
 * reject so the cell can render `blocked` (muted) instead of a red `failed`.
 *
 * The page-LoRA gate (PR #2660 GA) rejects an incompatible LoRA × checkpoint
 * pairing PRE-SPEND with a `BAD_REQUEST`: 'a selected LoRA is not compatible
 * with the checkpoint base model'. The server is the authority on compatibility
 * (ecosystem / cross-ecosystem rules we deliberately do NOT replicate here), so
 * we defer to its verdict and only key off its stable reject substring. Matched
 * defensively (case-insensitive, on the load-bearing phrase) so a minor copy
 * tweak server-side doesn't silently turn these back into red failures.
 */
export function isIncompatibleResourceError(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.toLowerCase().includes('not compatible with the checkpoint base model');
}

/** Snapshot statuses that mean "stop polling". Mirrors the SDK's TERMINAL set. */
const TERMINAL: ReadonlySet<BlockWorkflowSnapshot['status']> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

export function isTerminalStatus(status: BlockWorkflowSnapshot['status']): boolean {
  return TERMINAL.has(status);
}

/** Does the token carry the budgeted-spend scope? Drives the consent gate. */
export function hasBudgetedScope(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(BUDGETED_SCOPE);
}

/** Pull the single displayable image url from a succeeded snapshot, if any. */
export function firstImageUrl(snapshot: BlockWorkflowSnapshot | null): string | null {
  if (!snapshot || !snapshot.imageUrls || snapshot.imageUrls.length === 0) return null;
  return snapshot.imageUrls[0] ?? null;
}

/**
 * Reduce a polled/submitted snapshot to the next CELL status. Keeps the
 * status→status mapping in one tested place so the poll loop stays a thin
 * driver. Insufficient-Buzz failures map to `insufficient` so the cell shows a
 * Top-Up CTA instead of a generic error.
 */
export function cellStatusForSnapshot(snapshot: BlockWorkflowSnapshot): CellStatus {
  switch (snapshot.status) {
    case 'succeeded':
      return 'done';
    // A server-`canceled` workflow is the user's own Stop landing — render it as
    // the muted, money-safe `canceled` state, NOT a red failure.
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'expired': {
      // Prefer the structured discriminator when the host emits it (client-ready
      // for the scoped upstream fix); else fall back to the tightened text sniff.
      const code = snapshotErrorCode(snapshot);
      if (code === 'INSUFFICIENT_BUZZ') return 'insufficient';
      if (code === 'WORKFLOW_FAILED' || code === 'INCOMPATIBLE_RESOURCE') return 'failed';
      return isInsufficientBuzz(snapshot.error) ? 'insufficient' : 'failed';
    }
    case 'pending':
    case 'processing':
      return 'polling';
  }
}

// ---------------------------------------------------------------------------
// The grid/queue reducer.
//
// A pure (state, action) → state reducer drives every cell transition so the
// React layer is a thin dispatcher. This is the most heavily-tested unit.
// ---------------------------------------------------------------------------

export type RunPhase =
  | 'building' // selecting checkpoints/modifiers/prompt (pre-confirm)
  | 'confirming' // total cost shown, awaiting explicit confirm
  | 'needs-consent' // budgeted scope withheld; consent requested
  | 'running' // queue draining
  | 'done'; // all cells terminal

export interface MatrixState {
  phase: RunPhase;
  cells: MatrixCell[];
  /** Orchestrator per-cell estimate (one applies to all), once known. */
  perCellEstimate: number | null;
}

export type MatrixAction =
  | { type: 'BUILD'; cells: MatrixCell[] }
  | { type: 'REQUEST_CONFIRM' }
  | { type: 'NEEDS_CONSENT' }
  | { type: 'START_RUN' }
  | { type: 'SET_PER_CELL_ESTIMATE'; estimate: number | null }
  | { type: 'CELL_STATUS'; id: string; status: CellStatus }
  | { type: 'CELL_SUBMITTED'; id: string; workflowId: string }
  | { type: 'CELL_RESULT'; id: string; snapshot: BlockWorkflowSnapshot }
  | {
      type: 'CELL_ERROR';
      id: string;
      error: string;
      insufficient: boolean;
      /** Server rejected the pairing as incompatible (pre-spend) → `blocked`. */
      incompatible?: boolean;
    }
  /**
   * Re-run ONLY the failed + insufficient cells. `done`/`blocked`/`canceled`
   * cells (and their costs / images) are PRESERVED and NOT re-charged; the
   * failed/insufficient ones re-enter `idle` and the run resumes. No-op if there
   * are none to retry.
   */
  | { type: 'RETRY_FAILED' }
  /**
   * Polling for this cell gave up after the cap (`POLL_MAX_ATTEMPTS`) — the gen
   * is STILL running server-side and may finish + bill, so the cell becomes the
   * terminal-ish `timedout` state ("still working — check back later"). It is
   * deliberately NOT retryable (RETRY_FAILED skips it) so we never re-charge a
   * workflow that may still complete. No money impact — it's a polling-give-up.
   */
  | { type: 'CELL_TIMEDOUT'; id: string }
  /**
   * User stopped the run. Not-yet-started (`idle`) cells become terminal
   * `canceled` (never spent). In-flight cells (estimating/submitting/polling)
   * are LEFT as-is — the React layer calls the orchestrator `cancel()` for each
   * and their CELL_RESULT / CELL_ERROR lands them in a terminal state.
   */
  | { type: 'STOP_RUN' }
  /**
   * M1 — rehydrate a prior run wholesale from the persisted read-model on mount
   * (see persistence.ts). Replaces the entire state (cells + phase + estimate)
   * so a reload / device-switch rebuilds the in-flight + done matrix instead of
   * losing paid outputs. No spend — pure state reconstruction.
   */
  | { type: 'RESTORE'; state: MatrixState }
  /**
   * M1/M2 — reconcile the rebuilt cells against the authoritative
   * `useAppWorkflows` read-model (status / image / nsfwLevel / cost). Replaces
   * the cells array with the merged result (the pure `reconcileCells` decides
   * precedence — a terminal read-model row wins over a stale stored `polling`),
   * then finalizes. No submit → no re-charge; a workflow that completed while the
   * app was closed is simply picked up.
   */
  | { type: 'RECONCILE'; cells: MatrixCell[] }
  /**
   * M2 — a `timedout` cell (polling gave up; the gen may still be running
   * server-side) is re-checked by RE-POLLING its retained `workflowId`. Flip it
   * back to `polling` so the App's poll loop re-attaches. MONEY-SAFE: it re-polls
   * an EXISTING workflow — it never re-submits, so it can never re-charge. No-op
   * unless the cell is actually `timedout` and has a workflowId.
   */
  | { type: 'RECHECK_TIMEDOUT'; id: string }
  | { type: 'RESET' };

export const initialMatrixState: MatrixState = {
  phase: 'building',
  cells: [],
  perCellEstimate: null,
};

/** Apply a per-cell patch by id, leaving every other cell untouched. */
function patchCell(
  cells: MatrixCell[],
  id: string,
  patch: Partial<MatrixCell>,
): MatrixCell[] {
  return cells.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

/**
 * Are all generatable cells terminal? (Blocked cells are already terminal by
 * definition.) Drives the run→done transition.
 */
export function isRunComplete(cells: readonly MatrixCell[]): boolean {
  const gen = generatableCells(cells);
  if (gen.length === 0) return true;
  return gen.every(
    (c) =>
      c.status === 'done' ||
      c.status === 'failed' ||
      c.status === 'insufficient' ||
      c.status === 'timedout',
  );
}

export function matrixReducer(state: MatrixState, action: MatrixAction): MatrixState {
  switch (action.type) {
    case 'BUILD':
      return { ...initialMatrixState, cells: action.cells, perCellEstimate: null };
    case 'REQUEST_CONFIRM':
      return { ...state, phase: 'confirming' };
    case 'NEEDS_CONSENT':
      return { ...state, phase: 'needs-consent' };
    case 'START_RUN':
      return { ...state, phase: 'running' };
    case 'SET_PER_CELL_ESTIMATE':
      return { ...state, perCellEstimate: action.estimate };
    case 'CELL_STATUS': {
      const cells = patchCell(state.cells, action.id, { status: action.status });
      return { ...state, cells };
    }
    case 'CELL_SUBMITTED': {
      const cells = patchCell(state.cells, action.id, {
        workflowId: action.workflowId,
        status: 'polling',
      });
      return { ...state, cells };
    }
    case 'CELL_RESULT': {
      const { snapshot } = action;
      const status = cellStatusForSnapshot(snapshot);
      const patch: Partial<MatrixCell> = { status };
      if (snapshot.cost?.total != null) patch.cost = snapshot.cost.total;
      const url = firstImageUrl(snapshot);
      if (url) patch.imageUrl = url;
      if (status === 'failed' || status === 'insufficient') {
        patch.error = snapshot.error ?? 'Generation failed.';
      }
      const cells = patchCell(state.cells, action.id, patch);
      return finalize({ ...state, cells });
    }
    case 'CELL_ERROR': {
      // Server-driven `blocked` (incompatible pairing, pre-spend reject) takes
      // precedence over the buzz/failed mapping — it's a muted, money-safe state,
      // not a red failure.
      const status: CellStatus = action.incompatible
        ? 'blocked'
        : action.insufficient
          ? 'insufficient'
          : 'failed';
      const cells = patchCell(state.cells, action.id, {
        status,
        // A `blocked` cell shows the muted "incompatible" CellBox, not the raw
        // server string — keep its error so the reason is available but unobtrusive.
        error: status === 'blocked' ? 'Incompatible — base model mismatch' : action.error,
      });
      return finalize({ ...state, cells });
    }
    case 'RETRY_FAILED': {
      // Re-queue ONLY failed + insufficient cells back to `idle`, clearing their
      // (failed-run) error but PRESERVING every done/blocked/canceled cell and
      // its cost/image. This is the money-correct path: done cells are NEVER
      // re-run, so they can't be double-charged. If nothing is retryable, no-op.
      const hasRetryable = state.cells.some(
        (c) => c.status === 'failed' || c.status === 'insufficient',
      );
      if (!hasRetryable) return state;
      const cells = state.cells.map((c) =>
        c.status === 'failed' || c.status === 'insufficient'
          ? { ...c, status: 'idle' as CellStatus, error: null, workflowId: null }
          : c,
      );
      return { ...state, phase: 'running', cells };
    }
    case 'CELL_TIMEDOUT': {
      // Polling gave up — the gen may still complete + bill server-side, so this
      // is a non-blank, NON-retryable terminal state (never re-charged). Only
      // applies to a still-polling cell; a cell that already reached a terminal
      // state (a late timeout firing after the result landed) is left untouched.
      const cell = state.cells.find((c) => c.id === action.id);
      if (!cell || cell.status !== 'polling') return state;
      const cells = patchCell(state.cells, action.id, { status: 'timedout' });
      return finalize({ ...state, cells });
    }
    case 'STOP_RUN': {
      // Mark only NOT-yet-started cells terminal-`canceled` (no spend). In-flight
      // cells are left untouched — the React layer fires the orchestrator
      // cancel() for them and their result/error dispatch finalizes the run.
      const cells = state.cells.map((c) =>
        c.status === 'idle' ? { ...c, status: 'canceled' as CellStatus } : c,
      );
      // finalize so a stop with nothing in-flight reaches `done` immediately.
      return finalize({ ...state, cells });
    }
    case 'RESTORE':
      return action.state;
    case 'RECONCILE':
      return finalize({ ...state, cells: action.cells });
    case 'RECHECK_TIMEDOUT': {
      const cell = state.cells.find((c) => c.id === action.id);
      if (!cell || cell.status !== 'timedout' || cell.workflowId == null) return state;
      // Re-poll an existing workflow — never a re-submit. Re-enter `running` so
      // the poll loop re-attaches; finalize() flips back to `done` when it lands.
      const cells = patchCell(state.cells, action.id, { status: 'polling' });
      return { ...state, phase: 'running', cells };
    }
    case 'RESET':
      return initialMatrixState;
    default:
      return state;
  }
}

/** Flip the run to `done` once every generatable cell is terminal. */
function finalize(state: MatrixState): MatrixState {
  if (state.phase === 'running' && isRunComplete(state.cells)) {
    return { ...state, phase: 'done' };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Concurrency-limited queue scheduling (pure).
//
// The React layer owns the async submit/poll; this module owns the DECISION of
// which cells to start next given an in-flight count, so the limit is tested
// independently of any timers.
// ---------------------------------------------------------------------------

/** Cells currently occupying an in-flight slot. */
export function inFlightCells(cells: readonly MatrixCell[]): MatrixCell[] {
  return cells.filter(
    (c) => c.status === 'estimating' || c.status === 'submitting' || c.status === 'polling',
  );
}

/** Cells waiting to start (queued, not blocked, not yet touched). */
export function pendingCells(cells: readonly MatrixCell[]): MatrixCell[] {
  return cells.filter((c) => c.status === 'idle');
}

/**
 * True when a cell's `submit()` is still pending — it's `estimating`/`submitting`
 * and has NO `workflowId` yet. Stop() can't cancel such a cell (there's nothing
 * to call `cancel()` on); it may resolve and bill server-side AFTER the user
 * pressed Stop. The UI must NOT imply these were canceled. A `polling` cell, by
 * contrast, already has a workflowId and gets a best-effort `cancel()`.
 */
export function isUncancelableInFlight(cell: MatrixCell): boolean {
  return (
    (cell.status === 'estimating' || cell.status === 'submitting') && cell.workflowId == null
  );
}

/**
 * Count of in-flight cells Stop CANNOT cleanly cancel (mid-submit, no workflowId
 * — see `isUncancelableInFlight`). Drives the honest "in-progress generations
 * may still complete and be charged" warning near the Stop control. Display-only.
 */
export function uncancelableInFlightCount(cells: readonly MatrixCell[]): number {
  return cells.filter(isUncancelableInFlight).length;
}

/**
 * Honest copy for the Stop control: pressing Stop cancels everything not yet
 * started (no spend) and asks the server to cancel already-submitted cells, but
 * a cell whose submit is still in flight may still complete and be charged.
 * Constant so the wording is tested in one place.
 */
export function stopInProgressWarning(): string {
  return 'In-progress generations may still complete and be charged.';
}

/**
 * Given the current cells and a concurrency limit, return the next batch of
 * pending cells to START so that (in-flight + started) never exceeds the limit.
 * Pure + deterministic (row-major order) — the scheduler driver calls this
 * after every transition and starts whatever it returns.
 */
export function nextCellsToStart(
  cells: readonly MatrixCell[],
  concurrency: number,
): MatrixCell[] {
  const limit = Math.max(1, Math.floor(concurrency));
  const free = limit - inFlightCells(cells).length;
  if (free <= 0) return [];
  return pendingCells(cells).slice(0, free);
}

/** Default in-flight concurrency for the queue (2–3 per the spec). */
export const DEFAULT_CONCURRENCY = 3;
