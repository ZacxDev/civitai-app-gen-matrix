// Pure logic for the Gen Matrix persistent read-model (M1 / M2) and the result
// maturity gate (G1). No React, no DOM, no host — unit-tested in node (see
// persistence.test.ts). The App wires these to `useAppStorage` (the per-viewer
// KV that survives reload) + `useAppWorkflows` (the host's authoritative,
// per-app-tag-scoped workflow read-model) so a reload / timeout / device-switch
// rebuilds the in-flight + done matrix instead of "paying for nothing".
//
// WHY a local manifest AND the host read-model:
//   `useAppWorkflows()` returns this app's recent workflows (workflowId, status,
//   images[{url,nsfwLevel}], cost, createdAt) — but NOT which (checkpoint ×
//   modifier) CELL each workflow was, and NOT the axis selection. So it can't
//   rebuild the GRID on its own. We persist a compact run manifest (the cells +
//   their workflowIds + the estimate) to `useAppStorage`, rebuild the grid from
//   it on mount, then RECONCILE each cell against `useAppWorkflows` for the
//   authoritative status / image / nsfwLevel / cost. The two together give a
//   faithful, money-safe rebuild.

import {
  type CellStatus,
  type MatrixCell,
  type MatrixState,
  isRunComplete,
  MAX_CELLS,
} from './matrix.js';

/** The per-viewer `useAppStorage` key the current run is persisted under. */
export const RUN_STORAGE_KEY = 'gen-matrix:run:v1';

/** Current manifest schema version — bump + migrate/discard on shape changes. */
export const RUN_MANIFEST_VERSION = 1 as const;

/**
 * The persisted run. A near-verbatim capture of the matrix cells (each carries
 * its own checkpoint/modifier plain-data, so the grid axes rebuild from the
 * cells alone) plus the per-cell estimate. Small + JSON-serializable.
 */
export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  /** ISO-8601 timestamp of the last save (for staleness / debugging). */
  savedAt: string;
  perCellEstimate: number | null;
  cells: MatrixCell[];
}

/**
 * The minimal shape of one `useAppWorkflows()` row we reconcile against. Mirrors
 * the SDK's `AppWorkflow` (`@civitai/app-sdk/blocks`) — declared structurally
 * here so the pure module needs no SDK import and stays node-testable.
 */
export interface AppWorkflowImageLike {
  url: string;
  nsfwLevel: number | null;
}
export interface AppWorkflowLike {
  workflowId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  images: AppWorkflowImageLike[];
  cost: number | null;
}

// ---------------------------------------------------------------------------
// Serialize / restore.
// ---------------------------------------------------------------------------

/**
 * Should this run be persisted at all? Only once it has left the build phase
 * (i.e. real cells exist / a spend path has begun). A pure `building` state has
 * nothing worth surviving a reload.
 */
export function isPersistableRun(state: MatrixState): boolean {
  return (
    (state.phase === 'running' || state.phase === 'done') && state.cells.length > 0
  );
}

/** Serialize the live matrix state to a persistable manifest. */
export function buildRunManifest(state: MatrixState, now: () => number = Date.now): RunManifest {
  return {
    version: RUN_MANIFEST_VERSION,
    savedAt: new Date(now()).toISOString(),
    perCellEstimate: state.perCellEstimate,
    cells: state.cells,
  };
}

/** Terminal cell statuses (no further local action needed). */
function isTerminalCell(status: CellStatus): boolean {
  return (
    status === 'done' ||
    status === 'failed' ||
    status === 'insufficient' ||
    status === 'blocked' ||
    status === 'canceled' ||
    status === 'timedout'
  );
}

/**
 * Statuses reconcile treats as FINAL (enrich-only, never re-activate). This is
 * `isTerminalCell` MINUS `timedout`: a `timedout` cell is deliberately
 * re-activatable so reconcile can auto-recover it (M2) — if the read-model shows
 * its workflow now succeeded it becomes `done`, if still running it re-polls.
 */
function isReconcileFinal(status: CellStatus): boolean {
  return isTerminalCell(status) && status !== 'timedout';
}

/**
 * Rebuild a `MatrixState` from a persisted manifest — the M1 mount-time restore.
 *
 * MONEY-SAFETY (the load-bearing rule): a reload must NEVER auto-spend. So a cell
 * that had NOT yet acquired a `workflowId` — an `idle`/`estimating`/`submitting`
 * cell from an interrupted run that was never actually submitted — is flipped to
 * `canceled` (un-billed, honest "no charge"), NOT resumed. Only cells that were
 * already SUBMITTED (have a `workflowId`) are recoverable: a still-in-flight one
 * (`polling`, or a mid-flight `estimating/submitting` that got its id) is set
 * back to `polling` so the App RE-POLLS the existing workflow (never re-submits),
 * and a `timedout` one is left `timedout` (its own recheck path handles it).
 * Terminal cells (`done`/`failed`/…) are kept verbatim.
 *
 * The rebuilt phase is `running` when anything is re-pollable, else `done`.
 * Returns `null` for a missing / malformed / wrong-version manifest.
 */
export function restoreStateFromManifest(manifest: unknown): MatrixState | null {
  if (!isValidManifest(manifest)) return null;
  const cells: MatrixCell[] = [];
  // Bound a forged-giant-grid render DoS: a legit STARTABLE grid can never exceed
  // MAX_CELLS total cells (exceedsCap blocks a run start when total idle cells >
  // MAX_CELLS, and no transition ADDS cells), so a manifest with more cells than
  // that is corrupt/forged. Clamp before we sanitize+render the whole array.
  const rawCells = manifest.cells.slice(0, MAX_CELLS);
  for (const raw of rawCells) {
    // Defense-in-depth: the manifest is a per-viewer blob that could be corrupt
    // or forged. Sanitize each cell to a known-good shape (dropping structurally
    // broken ones) BEFORE the status normalization, so a bogus blob can never
    // rebuild a bogus grid. A cell that fails validation is simply omitted.
    const cell = sanitizeCell(raw);
    if (!cell) continue;
    const submitted = cell.workflowId != null;
    if (!submitted && !isTerminalCell(cell.status)) {
      // Never acquired a workflowId → never got past the client. Two HONEST
      // outcomes, split by how far the interrupted cell had progressed:
      if (cell.status === 'submitting') {
        // The real-spend `sub(body)` call was in flight when we persisted — it
        // MAY have reached the server and been charged. So this is NOT "no
        // charge": use the same non-committal, terminal-ish "may still finish —
        // check your Buzz" state as a timed-out gen (mirrors the honest
        // stopInProgressWarning wording). NEVER re-submits, NEVER re-charges.
        cells.push({ ...cell, status: 'timedout' });
      } else {
        // idle / estimating / polling without an id → never billed (an estimate
        // does not charge; a `polling`/other non-terminal status with a null
        // workflowId is a corrupt/forged cell that never actually ran). Flip to
        // an honest "no charge" cancel. This is status-agnostic on purpose: a
        // forged non-terminal blob (e.g. `polling` sans id) would otherwise fall
        // through, be pushed verbatim, drive phase:'running', and WEDGE the grid
        // in a state that can never be polled, completed, or stopped.
        cells.push({ ...cell, status: 'canceled' });
      }
    } else if (submitted && (cell.status === 'estimating' || cell.status === 'submitting' || cell.status === 'polling')) {
      // Already submitted + still in flight → recover by re-polling (no re-charge).
      cells.push({ ...cell, status: 'polling' });
    } else {
      cells.push(cell); // terminal (incl. timedout) — keep verbatim
    }
  }
  const anyResumable = cells.some((c) => c.status === 'polling');
  const phase: MatrixState['phase'] = anyResumable ? 'running' : 'done';
  const perCellEstimate =
    typeof manifest.perCellEstimate === 'number' && Number.isFinite(manifest.perCellEstimate)
      ? manifest.perCellEstimate
      : null;
  return { phase, cells, perCellEstimate };
}

function isValidManifest(manifest: unknown): manifest is RunManifest {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const m = manifest as Partial<RunManifest>;
  return m.version === RUN_MANIFEST_VERSION && Array.isArray(m.cells);
}

/** Every valid `CellStatus` — the allow-list a persisted status is clamped to. */
const VALID_CELL_STATUSES: ReadonlySet<CellStatus> = new Set<CellStatus>([
  'idle',
  'estimating',
  'submitting',
  'polling',
  'done',
  'failed',
  'insufficient',
  'blocked',
  'canceled',
  'timedout',
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Coerce ONE raw persisted cell into a known-good `MatrixCell`, or `null` if it's
 * too broken to render (missing a valid checkpoint/modifier identity or a finite
 * grid position — those would corrupt the grid). The scalar fields are coerced
 * defensively; an UNKNOWN/forged `status` clamps to `canceled` (a terminal,
 * non-billable state — NEVER a billable `idle`), and `workflowId`/`imageUrl`/
 * `error` fall back to `null`, `cost`/`nsfwLevel` to `null`, `prompt` to `''`.
 */
function sanitizeCell(raw: unknown): MatrixCell | null {
  if (!isObj(raw)) return null;
  const ckpt = raw.checkpoint;
  const mod = raw.modifier;
  // Grid identity + position must be structurally valid or the cell is dropped.
  if (!isObj(ckpt) || !finite(ckpt.versionId) || !finite(ckpt.modelId)) return null;
  if (!isObj(mod) || typeof mod.key !== 'string') return null;
  if (!finite(raw.row) || !finite(raw.col)) return null;

  const rawStatus = raw.status;
  const status: CellStatus =
    typeof rawStatus === 'string' && VALID_CELL_STATUSES.has(rawStatus as CellStatus)
      ? (rawStatus as CellStatus)
      : 'canceled'; // unknown/forged → terminal, non-billable

  return {
    id: typeof raw.id === 'string' ? raw.id : `${ckpt.versionId}::${mod.key}`,
    checkpoint: ckpt as unknown as MatrixCell['checkpoint'],
    modifier: mod as unknown as MatrixCell['modifier'],
    row: raw.row,
    col: raw.col,
    status,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    workflowId: strOrNull(raw.workflowId),
    imageUrl: strOrNull(raw.imageUrl),
    cost: finite(raw.cost) ? raw.cost : null,
    error: strOrNull(raw.error),
    nsfwLevel: finite(raw.nsfwLevel) ? raw.nsfwLevel : null,
  };
}

// ---------------------------------------------------------------------------
// Reconcile against the host read-model (useAppWorkflows).
// ---------------------------------------------------------------------------

/** Terminal `AppWorkflow` statuses (server-authoritative). */
function isTerminalAppWorkflow(status: AppWorkflowLike['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'canceled';
}

/**
 * Map an `AppWorkflow` server status → cell status. The read-model carries NO
 * error text, so a failed/expired workflow maps to the generic `failed` (an
 * insufficient-Buzz cell was already classified from its LIVE snapshot's error
 * text before the reload and is preserved by the precedence rule below — reconcile
 * never DOWNGRADES a richer terminal cell).
 */
export function appWorkflowStatusToCell(status: AppWorkflowLike['status']): CellStatus {
  switch (status) {
    case 'succeeded':
      return 'done';
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'pending':
    case 'processing':
      return 'polling';
  }
}

export interface ReconcileResult {
  cells: MatrixCell[];
  /** Cell ids that are STILL in flight server-side and must be re-polled (M2). */
  resumableIds: string[];
}

/**
 * Reconcile rebuilt cells against the authoritative `useAppWorkflows` rows,
 * joined by `workflowId`. Pure + precedence-safe:
 *
 *  - A cell with no `workflowId`, or whose workflow isn't in the read-model
 *    (e.g. it aged out of the window), is left untouched.
 *  - A cell ALREADY terminal is only ENRICHED — its missing `imageUrl` / `cost`
 *    / `nsfwLevel` are filled from the read-model (this is how a cell finalized
 *    from a live poll snapshot, which carries NO maturity, gains its
 *    `nsfwLevel` for the G1 gate) — its status is NEVER downgraded.
 *  - A non-terminal cell whose workflow is now terminal ADOPTS the server
 *    outcome (status + image + cost + nsfwLevel) — recovering a gen that
 *    completed while the app was closed.
 *  - A cell whose workflow is still `pending`/`processing` becomes `polling`
 *    and is reported as resumable so the App re-attaches its poll loop.
 *
 * No submit is ever issued here — reconcile can never re-charge.
 */
export function reconcileCells(
  cells: readonly MatrixCell[],
  workflows: readonly AppWorkflowLike[],
): ReconcileResult {
  const byId = new Map(workflows.map((w) => [w.workflowId, w]));
  const resumableIds: string[] = [];
  const next = cells.map((cell) => {
    if (cell.workflowId == null) return cell;
    const wf = byId.get(cell.workflowId);
    if (!wf) return cell;
    // A forged / partial host row may omit `images` entirely — optional-chain so
    // the reconcile effect can't throw on a missing array.
    const img = wf.images?.[0];
    if (isReconcileFinal(cell.status)) {
      // Enrich-only: fill gaps (notably nsfwLevel for the maturity gate), keep status.
      return {
        ...cell,
        imageUrl: cell.imageUrl ?? img?.url ?? null,
        cost: cell.cost ?? wf.cost ?? null,
        nsfwLevel: cell.nsfwLevel ?? img?.nsfwLevel ?? null,
      };
    }
    if (isTerminalAppWorkflow(wf.status)) {
      return {
        ...cell,
        status: appWorkflowStatusToCell(wf.status),
        imageUrl: img?.url ?? cell.imageUrl ?? null,
        cost: wf.cost ?? cell.cost ?? null,
        nsfwLevel: img?.nsfwLevel ?? cell.nsfwLevel ?? null,
      };
    }
    // Still running server-side → re-poll.
    resumableIds.push(cell.id);
    return { ...cell, status: 'polling' as CellStatus };
  });
  return { cells: next, resumableIds };
}

/** True once every reconciled cell is terminal (drives the run→done flip). */
export function reconciledRunComplete(cells: readonly MatrixCell[]): boolean {
  return isRunComplete(cells);
}

// ---------------------------------------------------------------------------
// G1 — result maturity gate (pure decision).
// ---------------------------------------------------------------------------

/** The domain maturity ceiling the gate consults (mirrors `useDomainMaturity`). */
export interface MaturityGate {
  /** True when the browsing-level bit is permitted by the domain ceiling. */
  isLevelAllowed: (level: number) => boolean;
  /** True when the surrounding domain permits NO NSFW content (fail-closed). */
  isSfw: boolean;
}

/**
 * Should a result image be BLURRED-until-revealed? (G1)
 *
 *  - KNOWN `nsfwLevel` → blur iff the domain ceiling does not allow that level.
 *  - UNKNOWN `nsfwLevel` (e.g. a cell finalized straight from a live poll
 *    snapshot, which carries no maturity, before it has been reconciled against
 *    `useAppWorkflows`) → FAIL-CLOSED: blur on a SFW domain (never render
 *    possibly-mature pixels ungated on a `g`/SFW surface), allow on a domain
 *    that already permits mature content.
 *
 * This is the last line ensuring a `contentRating:"g"` page never paints ungated
 * mature UGC pixels. The App also scopes generation SFW where it can, but the
 * gate is the authoritative render-time guard.
 */
export function shouldBlurResult(
  nsfwLevel: number | null | undefined,
  gate: MaturityGate,
): boolean {
  if (nsfwLevel != null && Number.isFinite(nsfwLevel)) {
    return !gate.isLevelAllowed(nsfwLevel);
  }
  return gate.isSfw;
}
