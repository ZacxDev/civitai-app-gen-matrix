import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useDomainMaturity,
  useBuzzPurchase,
  useBuzzWorkflow,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
} from '@civitai/blocks-react';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import {
  CHECKPOINTS,
  MODIFIERS,
  checkpointFromPick,
  loraModifierFromPick,
  type CheckpointOption,
  type ModifierOption,
} from './models.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_CELLS,
  PAGE_BUZZ_BUDGET_PER_CELL,
  PROMPT_MAX,
  billableCellCount,
  buildCellBody,
  buildMatrix,
  exceedsCap,
  failedCellDetail,
  failedCellLabel,
  formatCost,
  hasBudgetedScope,
  matrixTotalLabel,
  perCellBudgetCopy,
  initialMatrixState,
  inFlightCells,
  isIncompatibleResourceError,
  isInsufficientBuzz,
  isTerminalStatus,
  matrixReducer,
  nextCellsToStart,
  POLL_MAX_ATTEMPTS,
  timedOutCellLabel,
  representativeEstimateBody,
  estimateSignature,
  runProgressLabel,
  isUncancelableInFlight,
  uncancelableInFlightCount,
  stopInProgressWarning,
  suggestedTopUpAmount,
  totalSpent,
  type CostLabel,
  type MatrixCell,
} from './matrix.js';
import { ResourceBrowser } from './ResourceBrowser.js';
import { CatalogCache, defaultKvStore } from './catalog-cache.js';
import { DEFAULT_LIMIT, fetchCatalog, type CatalogQuery } from './catalog-api.js';
import { loraBaseModelFilter } from './ecosystem.js';

/**
 * Stable empty-array identity for ResourceBrowser's `checkpointBaseModels` prop
 * on the non-LoRA branch. A fresh `[]` literal each render is a new identity,
 * which re-fires ResourceBrowser's load effect (keyed on the prop) needlessly —
 * hoist a single shared reference instead (LOW-1).
 */
const EMPTY_BASE_MODELS: readonly (string | undefined)[] = [];

/**
 * Gen Matrix — a full-page (W10) app that generates a bounded grid of
 * (checkpoint × modifier) cells so users can compare how each model/style
 * changes the output, spending real Buzz per cell.
 *
 * Page-native constraints (mirrors the buzz-generator dog-food, civitai #2612):
 *  - slot = app.page (entity=none); scopes = ['ai:write:budgeted'] ONLY (a page
 *    HARD-FORBIDS buzz:read:self → no proactive balance; insufficient Buzz is
 *    detected from the failed snapshot, per cell).
 *  - budget comes from manifest page.buzzBudgetPerGen (server-read, clamped
 *    ≤1000) PER CELL; a page is stateless (no install/settings rows).
 *  - the model set is hardcoded + curated (no page model-picker — see models.ts).
 *  - ai:write:budgeted is consent-gated → withheld at mint, requested lazily on
 *    first Generate via useRequestConsent; the grant arrives as TOKEN_REFRESH.
 *
 * Money safety: a client-side cell cap (MAX_CELLS) + a confirm-before-spend
 * total-cost gate + a concurrency-limited queue. All the load-bearing decisions
 * live in the unit-tested matrix.ts; this component is a thin async driver.
 */
/**
 * Make a dialog a real modal: move focus into it on open, trap Tab/Shift+Tab
 * inside it, close on Escape, and restore focus to whatever was focused before
 * (the trigger) on close. Markup/behavior only — no money/queue logic.
 *
 * @param ref      the dialog container
 * @param active   whether the dialog is mounted/open
 * @param onClose  called on Escape (cancel)
 */
function useModalA11y(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  // Keep the latest onClose without re-binding listeners every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Focus the primary action (or the dialog itself) on open.
    const initial =
      node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node;
    initial.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !node.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !node.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger on close (if it's still in the DOM).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, ref]);
}

export function App() {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  // The block's domain maturity ceiling (fail-closed SFW). Threaded into the
  // anon catalog read so a red-domain block's anon browse can show mature while
  // green/blue stay SFW. The token (signed-in) path ignores it — server clamps.
  const { isSfw: domainIsSfw } = useDomainMaturity();
  const { estimate, submit, poll, cancel } = useBuzzWorkflow();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const { openPurchaseModal } = useBuzzPurchase();
  const { open: openResourcePicker } = useResourcePicker();

  const isDark = theme === 'dark';
  const c = palette(isDark);
  const anon = ready && !viewer;
  const granted = hasBudgetedScope(token.scopes);

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // ---- Selection state (the "build" surface) ----
  const [prompt, setPrompt] = useState('');
  const [selectedCkpts, setSelectedCkpts] = useState<Set<number>>(
    () => new Set([CHECKPOINTS[0]?.versionId].filter((v): v is number => v != null)),
  );
  const [selectedMods, setSelectedMods] = useState<Set<string>>(() => new Set(['baseline']));

  // Picker-added axis members. The host's native resource picker
  // (useResourcePicker) returns one resource at a time; each becomes a LoRA
  // column (second axis) or a checkpoint row (first axis), appended to the
  // curated set and auto-selected. Deduped by versionId so re-picking the same
  // resource is idempotent.
  const [pickedMods, setPickedMods] = useState<ModifierOption[]>([]);
  const [pickedCkpts, setPickedCkpts] = useState<CheckpointOption[]>([]);
  const [picking, setPicking] = useState(false);

  // ---- In-block resource browser (Pass 2 — the fast curated path) ----
  // A single shared catalog cache (memory + sessionStorage), stable for the
  // component lifetime so checkpoint/LoRA browse + reopen reuse it.
  const cacheRef = useRef<CatalogCache | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new CatalogCache({ clock: () => Date.now(), store: defaultKvStore() });
  }
  const [browse, setBrowse] = useState<'Checkpoint' | 'LORA' | null>(null);

  // The full axis sets the UI renders + selection filters against = curated +
  // picked. Curated entries always come first so the seeded LoRA / checkpoints
  // stay a stable starting set.
  const allCheckpoints = useMemo<CheckpointOption[]>(
    () => [...CHECKPOINTS, ...pickedCkpts],
    [pickedCkpts],
  );
  const allModifiers = useMemo<ModifierOption[]>(() => [...MODIFIERS, ...pickedMods], [pickedMods]);

  // ---- Run state (the matrix reducer) ----
  const [state, dispatch] = useReducer(matrixReducer, initialMatrixState);

  // Auto-resume intent across the consent round-trip.
  const consentPendingRef = useRef(false);
  // Per-cell poll cancellation tokens, torn down on unmount / reset.
  const pollTokensRef = useRef<Map<string, { cancelled: boolean }>>(new Map());

  // Keep the latest hook fns in refs so the queue driver (an effect) always
  // calls the current instances without re-subscribing.
  const fns = useRef({ estimate, submit, poll, cancel });
  fns.current = { estimate, submit, poll, cancel };

  useEffect(() => {
    const tokens = pollTokensRef.current;
    return () => {
      tokens.forEach((t) => (t.cancelled = true));
    };
  }, []);

  const chosenCheckpoints = useMemo(
    () => allCheckpoints.filter((c2) => selectedCkpts.has(c2.versionId)),
    [allCheckpoints, selectedCkpts],
  );
  const chosenModifiers = useMemo(
    () => allModifiers.filter((m) => selectedMods.has(m.key)),
    [allModifiers, selectedMods],
  );

  // Preview cells (for the count / cost gate) — independent of the run state.
  const previewCells = useMemo(
    () => buildMatrix(prompt, chosenCheckpoints, chosenModifiers),
    [prompt, chosenCheckpoints, chosenModifiers],
  );
  const billable = billableCellCount(previewCells);
  const over = exceedsCap(previewCells);

  // ---- Build-phase representative estimate (best-effort, debounced) ----
  // Fire ONE estimate() against a REPRESENTATIVE cell while the user is still
  // building, so the summary + confirm gate can show "≈ N Buzz" instead of the
  // ~25× over the cap-based "up to M". Best-effort: a slow/failed estimate never
  // blocks the UI or the Generate button and never changes the cap/spend logic.
  const [buildEstimate, setBuildEstimate] = useState<number | null>(null);
  // The signature of the selection bits that materially change the estimate;
  // re-estimate (debounced) only when it changes.
  const estSig = estimateSignature(prompt, chosenCheckpoints, chosenModifiers);
  const buildEstimateBody = useMemo(
    () => representativeEstimateBody(prompt, chosenCheckpoints, chosenModifiers),
    [prompt, chosenCheckpoints, chosenModifiers],
  );
  useEffect(() => {
    // Nothing meaningful to estimate yet (empty prompt / no checkpoint) → keep
    // the cap-based fallback. Don't clear a prior estimate to null on every
    // keystroke gap; just skip until there's something to price.
    if (!buildEstimateBody) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      fns.current
        .estimate(buildEstimateBody)
        .then((e) => {
          if (cancelled) return;
          const total = e.cost?.total;
          if (total != null && Number.isFinite(total) && total > 0) setBuildEstimate(total);
        })
        .catch(() => {
          /* best-effort — leave the cap-based fallback in place */
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // estSig captures the material selection bits; buildEstimateBody is derived
    // from the same inputs. Keying the effect on estSig debounces per-material-change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estSig]);

  // The preview total uses the real build-phase estimate once it has landed
  // (→ "≈ N"); until then it's the cap-based MAXIMUM ("up to M"). matrixTotalLabel
  // tags it so the UI never presents the ceiling as what you'll spend.
  const previewLabel = matrixTotalLabel(previewCells, buildEstimate);

  // ---- Selection toggles ----
  const toggleCkpt = useCallback((versionId: number) => {
    setSelectedCkpts((prev) => {
      const next = new Set(prev);
      next.has(versionId) ? next.delete(versionId) : next.add(versionId);
      return next;
    });
  }, []);
  const toggleMod = useCallback((key: string) => {
    setSelectedMods((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // ---- Shared axis-add helpers (used by BOTH the native picker and the
  // in-block browser) so the dedup + auto-select behavior is identical. ----
  const addLoraModifier = useCallback((mod: ModifierOption) => {
    setPickedMods((prev) => (prev.some((m) => m.key === mod.key) ? prev : [...prev, mod]));
    setSelectedMods((prev) => new Set(prev).add(mod.key));
  }, []);
  const addCheckpointRow = useCallback((ckpt: CheckpointOption) => {
    setPickedCkpts((prev) =>
      prev.some((c2) => c2.versionId === ckpt.versionId) ? prev : [...prev, ckpt],
    );
    setSelectedCkpts((prev) => new Set(prev).add(ckpt.versionId));
  }, []);

  // ---- Native resource picker (host chrome) — the "All resources" fallback ----
  // Open the host's native LoRA modal; on a non-null pick add a LoRA column
  // (second axis) and auto-select it. Dedupes by versionId. Sign-in gated (the
  // picker is meaningless for an anon viewer who can't generate).
  const handlePickLora = useCallback(async () => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (picking) return;
    setPicking(true);
    try {
      const picked = await openResourcePicker({ resourceType: 'LORA' });
      if (!picked) return; // user dismissed
      addLoraModifier(loraModifierFromPick(picked));
    } catch {
      /* picker errored / timed out — non-fatal, the user can retry */
    } finally {
      setPicking(false);
    }
  }, [viewer, picking, openResourcePicker, requestSignIn, addLoraModifier]);

  // Optionally add a checkpoint row from the picker. The curated checkpoints
  // remain the default starting set; a picked one is appended + auto-selected.
  const handlePickCheckpoint = useCallback(async () => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (picking) return;
    setPicking(true);
    try {
      const picked = await openResourcePicker({ resourceType: 'Checkpoint' });
      if (!picked) return;
      addCheckpointRow(checkpointFromPick(picked));
    } catch {
      /* non-fatal */
    } finally {
      setPicking(false);
    }
  }, [viewer, picking, openResourcePicker, requestSignIn, addCheckpointRow]);

  // ---- In-block browser open/close. Anon may browse (discovery-only); the
  // money actions still gate at Generate, mirroring the existing anon handling. ----
  const openBrowse = useCallback((type: 'Checkpoint' | 'LORA') => setBrowse(type), []);
  const closeBrowse = useCallback(() => setBrowse(null), []);
  // The versionIds already on each axis (for the browser's added/dedupe marks).
  const checkpointVersionIds = useMemo(
    () => new Set(allCheckpoints.map((ck) => ck.versionId)),
    [allCheckpoints],
  );
  const loraVersionIds = useMemo(
    () =>
      new Set(
        allModifiers
          .map((m) => m.loraVersionId)
          .filter((v): v is number => typeof v === 'number'),
      ),
    [allModifiers],
  );
  // baseModels of the currently-selected checkpoints — drives the LoRA browser's
  // ecosystem filter + "N compatible" count.
  const selectedCkptBaseModels = useMemo(
    () => chosenCheckpoints.map((ck) => ck.baseModel),
    [chosenCheckpoints],
  );

  // Prefetch the compatible-LoRA list the moment the checkpoint selection
  // changes, so opening the LoRA browser is instant (cache-first). Best-effort:
  // a failed prefetch just leaves the browser to fetch on open. Skipped for anon
  // is unnecessary — the public endpoint needs no auth.
  const ckptBaseModelsKey = selectedCkptBaseModels.join('|');
  useEffect(() => {
    if (chosenCheckpoints.length === 0) return;
    const cache = cacheRef.current;
    if (!cache) return;
    const baseModels = loraBaseModelFilter(selectedCkptBaseModels);
    const q: CatalogQuery = {
      type: 'LORA',
      sort: 'Highest Rated',
      limit: DEFAULT_LIMIT,
      baseModels: baseModels.length ? baseModels : undefined,
    };
    if (cache.get(q)) return; // already warm
    let cancelled = false;
    fetchCatalog(q, { fetch: (url) => fetch(url) })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === 'ok') cache.set(q, res.page);
      })
      .catch(() => {
        /* best-effort prefetch */
      });
    return () => {
      cancelled = true;
    };
    // ckptBaseModelsKey captures the material checkpoint-family change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ckptBaseModelsKey]);

  // ---- The per-cell generation driver ----
  // Runs ONE cell: estimate (best-effort) → submit → poll to terminal. All
  // transitions go through the reducer; the queue effect below decides WHICH
  // cells run (concurrency limit), this just executes one.
  const runCell = useCallback(async (cell: MatrixCell) => {
    const { estimate: est, submit: sub } = fns.current;
    const body = buildCellBody(cell.checkpoint, cell.prompt, cell.modifier);

    // 1) Estimate (best-effort; failed estimate doesn't block submit). The
    //    first estimate to land seeds the per-cell estimate for the confirm
    //    dialog of a future run; here it's just for the in-cell label.
    dispatch({ type: 'CELL_STATUS', id: cell.id, status: 'estimating' });
    try {
      const e = await est(body);
      if (e.cost?.total != null) dispatch({ type: 'SET_PER_CELL_ESTIMATE', estimate: e.cost.total });
    } catch (err) {
      // Estimate is best-effort and otherwise swallowed — but if it surfaces the
      // server's incompatibility reject cheaply, short-circuit to `blocked` now
      // (avoids the submit round-trip). The submit catch below is the
      // authoritative mapping; this is just a faster path when available.
      const msg = err instanceof Error ? err.message : '';
      if (isIncompatibleResourceError(msg)) {
        dispatch({
          type: 'CELL_ERROR',
          id: cell.id,
          error: msg,
          insufficient: false,
          incompatible: true,
        });
        return;
      }
      /* otherwise non-fatal — submit still runs */
    }

    // 2) Submit (the real spend). The SERVER is the authority on resource
    //    compatibility: an incompatible LoRA × checkpoint pairing is rejected
    //    PRE-SPEND (BAD_REQUEST, costs 0) → map it to muted `blocked`, not red
    //    `failed`. Insufficient Buzz → `insufficient` (Top-Up CTA). Anything
    //    else → `failed`.
    dispatch({ type: 'CELL_STATUS', id: cell.id, status: 'submitting' });
    let snap: BlockWorkflowSnapshot;
    try {
      snap = await sub(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'submit failed';
      dispatch({
        type: 'CELL_ERROR',
        id: cell.id,
        error: msg,
        insufficient: isInsufficientBuzz(msg),
        incompatible: isIncompatibleResourceError(msg),
      });
      return;
    }

    // Instant terminal snapshot (cached / instant-fail)?
    if (isTerminalStatus(snap.status)) {
      dispatch({ type: 'CELL_RESULT', id: cell.id, snapshot: snap });
      return;
    }

    // 3) Poll to terminal.
    dispatch({ type: 'CELL_SUBMITTED', id: cell.id, workflowId: snap.workflowId });
    runPollLoop(cell.id, snap.workflowId);
    // runPollLoop is stable (defined below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPollLoop = useCallback((cellId: string, workflowId: string) => {
    const prior = pollTokensRef.current.get(cellId);
    if (prior) prior.cancelled = true;
    const tok = { cancelled: false };
    pollTokensRef.current.set(cellId, tok);

    const SCHEDULE_MS = [2000, 2000, 3000, 5000, 8000];
    let attempt = 0;

    // Bounded poll: after POLL_MAX_ATTEMPTS ticks (~>4min with the backoff), give
    // up and surface the `timedout` "still working — check back later" state.
    // No money impact — the workflow keeps running server-side; we just stop
    // polling so a wedged/zombie workflow can't poll forever (LOW-3).
    const giveUp = () => {
      pollTokensRef.current.delete(cellId);
      dispatch({ type: 'CELL_TIMEDOUT', id: cellId });
    };

    const tick = async () => {
      if (tok.cancelled) return;
      if (attempt >= POLL_MAX_ATTEMPTS) {
        giveUp();
        return;
      }
      let snap: BlockWorkflowSnapshot;
      try {
        snap = await fns.current.poll(workflowId);
      } catch {
        if (tok.cancelled) return;
        const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
        attempt += 1;
        setTimeout(tick, delay);
        return;
      }
      if (tok.cancelled) return;
      dispatch({ type: 'CELL_RESULT', id: cellId, snapshot: snap });
      if (isTerminalStatus(snap.status)) {
        pollTokensRef.current.delete(cellId);
        return;
      }
      const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
      attempt += 1;
      setTimeout(tick, delay);
    };
    setTimeout(tick, 0);
  }, []);

  // ---- The concurrency-limited queue ----
  // After every reducer change, while running, start as many pending cells as
  // the limit allows. Pure scheduling (nextCellsToStart) decides which; this
  // effect just fires them. Idempotent: a cell flips to 'estimating'
  // synchronously inside runCell's first dispatch, so it won't be re-picked.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const toStart = nextCellsToStart(state.cells, DEFAULT_CONCURRENCY);
    for (const cell of toStart) {
      void runCell(cell);
    }
  }, [state.phase, state.cells, runCell]);

  // ---- Actions ----
  const handleGenerateClick = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (over || billable === 0) return; // gated by the cap / empty selection
    // Build the matrix and move to the confirm gate (show total + confirm).
    dispatch({ type: 'BUILD', cells: buildMatrix(prompt, chosenCheckpoints, chosenModifiers) });
    // Seed the confirm gate with the build-phase representative estimate (if it
    // landed) so it shows "≈ N" immediately instead of the cap-based "up to M".
    // BUILD resets perCellEstimate to null, so re-apply it here; the first cell's
    // own estimate will refine it during the run. Best-effort: null is fine.
    if (buildEstimate != null) {
      dispatch({ type: 'SET_PER_CELL_ESTIMATE', estimate: buildEstimate });
    }
    dispatch({ type: 'REQUEST_CONFIRM' });
  }, [viewer, over, billable, prompt, chosenCheckpoints, chosenModifiers, buildEstimate, requestSignIn]);

  const startRun = useCallback(() => {
    if (!granted) {
      consentPendingRef.current = true;
      dispatch({ type: 'NEEDS_CONSENT' });
      requestConsent({ scopes: ['ai:write:budgeted'] });
      return;
    }
    dispatch({ type: 'START_RUN' });
  }, [granted, requestConsent]);

  // Auto-resume the run once consent lands.
  useEffect(() => {
    if (granted && consentPendingRef.current) {
      consentPendingRef.current = false;
      dispatch({ type: 'START_RUN' });
    }
  }, [granted]);

  const handleConfirm = useCallback(() => startRun(), [startRun]);

  const handleCancelConfirm = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const handleReset = useCallback(() => {
    pollTokensRef.current.forEach((t) => (t.cancelled = true));
    pollTokensRef.current.clear();
    dispatch({ type: 'RESET' });
  }, []);

  // Stop the run: mark not-yet-started cells `canceled` (no spend) and fire the
  // orchestrator cancel() for every in-flight cell that has a workflowId. The
  // STOP_RUN reducer flips idle→canceled; in-flight cells resolve to `canceled`
  // when cancel()/the next poll lands (a server-`canceled` snapshot maps to the
  // muted `canceled` cell status). Already-submitted cells MAY still bill
  // server-side — best-effort cancel is the most we can do; we never re-spend.
  const handleStop = useCallback(() => {
    // Snapshot in-flight cells BEFORE the reducer mutates anything.
    const inflight = inFlightCells(state.cells).filter((cell) => cell.workflowId != null);
    // Stop the local poll loops so a late poll can't re-open a canceled cell.
    pollTokensRef.current.forEach((t) => (t.cancelled = true));
    pollTokensRef.current.clear();
    // Flip idle → canceled immediately (no spend).
    dispatch({ type: 'STOP_RUN' });
    // Best-effort server-side cancel for each in-flight workflow; mark the cell
    // `canceled` when it resolves (or even if it rejects — the user stopped it).
    for (const cell of inflight) {
      const workflowId = cell.workflowId;
      if (!workflowId) continue;
      fns.current
        .cancel(workflowId)
        .then((snap) => {
          dispatch({ type: 'CELL_RESULT', id: cell.id, snapshot: snap });
        })
        .catch(() => {
          // cancel() rejected (e.g. already terminal server-side) — still land
          // the cell in a terminal state so the run can complete. Mark canceled.
          dispatch({ type: 'CELL_STATUS', id: cell.id, status: 'canceled' });
        });
    }
  }, [state.cells]);

  // Retry ONLY the failed + insufficient cells. Done/blocked/canceled cells and
  // their costs/images are preserved and NOT re-charged (RETRY_FAILED re-queues
  // just the retryable subset to idle and resumes the run).
  const handleRetryFailed = useCallback(() => {
    dispatch({ type: 'RETRY_FAILED' });
  }, []);

  const handleTopUp = useCallback(() => {
    // Suggest an amount proportionate to the run's actual cost (landed per-cell
    // estimate × cells, with a floor) — not the per-cell SAFETY cap × 10 (LOW-2).
    openPurchaseModal(suggestedTopUpAmount(billable, state.perCellEstimate)).catch(
      () => undefined,
    );
  }, [openPurchaseModal, billable, state.perCellEstimate]);

  // ---- Render ----
  if (!ready) {
    return (
      <div ref={rootRef} data-theme={isDark ? 'dark' : 'light'} style={pageStyle(c)}>
        <LoadingSkeleton c={c} />
      </div>
    );
  }

  const inBuild = state.phase === 'building';
  const showConfirm = state.phase === 'confirming' || state.phase === 'needs-consent';
  const showGrid = state.phase === 'running' || state.phase === 'done';
  // The confirm gate uses the REAL per-cell estimate once it has landed
  // (perCellEstimate, seeded by the first cell's estimate call); until then it
  // is a cap-based maximum, surfaced as "up to N" rather than expected spend.
  const confirmLabel = matrixTotalLabel(state.cells, state.perCellEstimate);
  const anyInsufficient = state.cells.some((cell) => cell.status === 'insufficient');
  // Retry is offered once the run is done and at least one cell is retryable.
  const canRetry =
    state.phase === 'done' &&
    state.cells.some((cell) => cell.status === 'failed' || cell.status === 'insufficient');

  return (
    <div ref={rootRef} data-theme={isDark ? 'dark' : 'light'} style={pageStyle(c)}>
      <div style={contentStyle()}>
        <header style={{ display: 'grid', gap: 8 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Gen Matrix</h1>
          <p style={{ fontSize: 15, opacity: 0.85, margin: 0, lineHeight: 1.45, fontWeight: 600 }}>
            Same prompt, every model × style — side by side.
          </p>
          {inBuild && <p style={{ ...noteStyle(c), margin: 0 }}>{perCellBudgetCopy()}</p>}
          {inBuild && <FirstRunExample c={c} />}
        </header>

        {inBuild && (
          <BuildPanel
            c={c}
            prompt={prompt}
            setPrompt={setPrompt}
            checkpoints={allCheckpoints}
            modifiers={allModifiers}
            selectedCkpts={selectedCkpts}
            selectedMods={selectedMods}
            toggleCkpt={toggleCkpt}
            toggleMod={toggleMod}
            billable={billable}
            over={over}
            previewLabel={previewLabel}
            anon={anon}
            picking={picking}
            onPickLora={handlePickLora}
            onPickCheckpoint={handlePickCheckpoint}
            onBrowseLora={() => openBrowse('LORA')}
            onBrowseCheckpoint={() => openBrowse('Checkpoint')}
            onGenerate={handleGenerateClick}
          />
        )}

        {inBuild && browse && cacheRef.current && (
          <ResourceBrowser
            c={c}
            type={browse}
            cache={cacheRef.current}
            blockToken={token.raw}
            domainIsSfw={domainIsSfw}
            onClose={closeBrowse}
            checkpointBaseModels={browse === 'LORA' ? selectedCkptBaseModels : EMPTY_BASE_MODELS}
            selectedVersionIds={browse === 'LORA' ? loraVersionIds : checkpointVersionIds}
            onAddCheckpoint={addCheckpointRow}
            onAddLora={addLoraModifier}
            onOpenNativePicker={() => {
              closeBrowse();
              if (browse === 'LORA') void handlePickLora();
              else void handlePickCheckpoint();
            }}
          />
        )}

        {showConfirm && (
          <ConfirmPanel
            c={c}
            cells={state.cells}
            label={confirmLabel}
            phase={state.phase}
            onConfirm={handleConfirm}
            onCancel={handleCancelConfirm}
          />
        )}

        {showGrid && (
          <ResultGrid
            c={c}
            cells={state.cells}
            checkpoints={chosenCheckpoints}
            modifiers={chosenModifiers}
            phase={state.phase}
            canRetry={canRetry}
            onReset={handleReset}
            onStop={handleStop}
            onRetry={handleRetryFailed}
          />
        )}

        {anyInsufficient && (
          <div style={{ display: 'grid', gap: 6 }}>
            <p style={noteStyle(c)}>
              Some cells ran out of Buzz. Top up and run again to fill them.
            </p>
            <button type="button" onClick={handleTopUp} style={primaryBtn(c)} data-testid="gm-topup">
              Top up Buzz
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build panel — selection + cost preview + cap gate
// ---------------------------------------------------------------------------

function BuildPanel(props: {
  c: Palette;
  prompt: string;
  setPrompt: (v: string) => void;
  checkpoints: CheckpointOption[];
  modifiers: ModifierOption[];
  selectedCkpts: Set<number>;
  selectedMods: Set<string>;
  toggleCkpt: (id: number) => void;
  toggleMod: (key: string) => void;
  billable: number;
  over: boolean;
  previewLabel: CostLabel;
  anon: boolean;
  picking: boolean;
  onPickLora: () => void;
  onPickCheckpoint: () => void;
  onBrowseLora: () => void;
  onBrowseCheckpoint: () => void;
  onGenerate: () => void;
}) {
  const {
    c,
    prompt,
    setPrompt,
    checkpoints,
    modifiers,
    selectedCkpts,
    selectedMods,
    toggleCkpt,
    toggleMod,
    billable,
    over,
    previewLabel,
    anon,
    picking,
    onPickLora,
    onPickCheckpoint,
    onBrowseLora,
    onBrowseCheckpoint,
    onGenerate,
  } = props;
  const emptyPrompt = prompt.trim().length === 0;
  const disabled = anon ? false : over || billable === 0 || emptyPrompt;

  // Inline reason for a disabled Generate (I3.2). Anon is never "disabled" (the
  // button becomes Sign-in), so only the signed-in gates surface a reason.
  // Order: empty prompt → no selection → over cap (over-cap also shows in the
  // summary box, but we keep the button-level reason consistent).
  const disabledReason =
    anon || !disabled
      ? null
      : emptyPrompt
        ? 'Enter a prompt to generate.'
        : billable === 0
          ? 'Select at least one checkpoint and one style.'
          : `Over the ${MAX_CELLS}-cell limit — deselect some to continue.`;

  return (
    <>
      <div style={{ display: 'grid', gap: 6 }}>
        <label htmlFor="gm-prompt" style={{ fontSize: 13, fontWeight: 600 }}>
          Shared prompt
        </label>
        <textarea
          id="gm-prompt"
          value={prompt}
          maxLength={PROMPT_MAX}
          placeholder="a serene mountain lake at golden hour, highly detailed"
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Shared generation prompt"
          rows={3}
          style={textareaStyle(c)}
        />
      </div>

      <fieldset style={fieldsetStyle(c)}>
        <legend style={legendStyle}>Checkpoints (rows)</legend>
        <div style={chipRow}>
          {checkpoints.map((ckpt: CheckpointOption) => (
            <Chip
              key={ckpt.versionId}
              c={c}
              label={ckpt.label}
              selected={selectedCkpts.has(ckpt.versionId)}
              onToggle={() => toggleCkpt(ckpt.versionId)}
            />
          ))}
          <button
            type="button"
            onClick={onBrowseCheckpoint}
            style={browseBtn(c)}
            className="gm-chip"
            data-testid="gm-browse-checkpoint"
          >
            Browse checkpoints
          </button>
          <button
            type="button"
            onClick={onPickCheckpoint}
            disabled={picking}
            style={pickBtn(c, picking)}
            className="gm-chip"
            data-testid="gm-pick-checkpoint"
          >
            + All resources
          </button>
        </div>
      </fieldset>

      <fieldset style={fieldsetStyle(c)}>
        <legend style={legendStyle}>Styles (columns)</legend>
        <div style={chipRow}>
          {modifiers.map((m: ModifierOption) => (
            <Chip
              key={m.key}
              c={c}
              label={m.label}
              selected={selectedMods.has(m.key)}
              isLora={m.loraVersionId != null}
              onToggle={() => toggleMod(m.key)}
            />
          ))}
          <button
            type="button"
            onClick={onBrowseLora}
            style={browseBtn(c)}
            className="gm-chip"
            data-testid="gm-browse-lora"
          >
            Browse LoRAs
          </button>
          <button
            type="button"
            onClick={onPickLora}
            disabled={picking}
            style={pickBtn(c, picking)}
            className="gm-chip"
            data-testid="gm-pick-lora"
          >
            + All resources
          </button>
        </div>
        <p style={{ ...noteStyle(c), marginTop: 8 }}>
          <LoraGlyph c={c} /> = a LoRA column (generates as an extra resource on the checkpoint,
          and may cost a little more). Civitai checks each LoRA × checkpoint pairing — an
          incompatible one shows as <em>incompatible</em> and costs nothing.
        </p>
      </fieldset>

      <div
        role="status"
        style={{
          ...summaryBox(c),
          borderColor: over ? c.danger : c.border,
          color: over ? c.danger : c.fg,
        }}
      >
        <strong>
          {billable} of {MAX_CELLS}
        </strong>{' '}
        cell{billable === 1 ? '' : 's'} · <strong>{previewLabel.amount}</strong> Buzz
        {previewLabel.isCeiling && (
          <span style={{ opacity: 0.7 }}> max — real cost is usually far less</span>
        )}
        {over && (
          <>
            {' '}
            — over the {MAX_CELLS}-cell limit. Deselect some to continue.
          </>
        )}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <button
          type="button"
          onClick={onGenerate}
          disabled={disabled}
          style={primaryBtn(c, disabled)}
          className="gm-chip"
          aria-describedby={disabledReason ? 'gm-generate-reason' : undefined}
          data-testid={anon ? 'gm-signin' : 'gm-generate'}
        >
          {anon
            ? 'Sign in to generate'
            : `Generate Matrix · ${billable} cell${billable === 1 ? '' : 's'}`}
        </button>
        {disabledReason && (
          <p
            id="gm-generate-reason"
            role="status"
            style={{ ...noteStyle(c), textAlign: 'center', margin: 0 }}
            data-testid="gm-generate-reason"
          >
            {disabledReason}
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Confirm panel — explicit spend gate
// ---------------------------------------------------------------------------

function ConfirmPanel(props: {
  c: Palette;
  cells: MatrixCell[];
  label: CostLabel;
  phase: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { c, cells, label, phase, onConfirm, onCancel } = props;
  const billable = billableCellCount(cells);
  const needsConsent = phase === 'needs-consent';

  const dialogRef = useRef<HTMLDivElement>(null);
  // Real modal: focus moves in on open, is trapped, Escape cancels, and focus
  // returns to the trigger on close (useModalA11y).
  useModalA11y(dialogRef, true, onCancel);

  return (
    <div
      className="gm-backdrop"
      style={backdropStyle()}
      // A backdrop click cancels (mousedown on the backdrop itself, not a child).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      data-testid="gm-confirm-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gm-confirm-title"
        aria-describedby="gm-confirm-desc"
        className="gm-dialog-enter"
        style={confirmBox(c)}
      >
        <p id="gm-confirm-title" style={{ margin: 0, fontSize: 15 }}>
          Generate <strong>{billable}</strong> cell{billable === 1 ? '' : 's'} for{' '}
          <strong>{label.amount}</strong> Buzz{label.isCeiling ? ' at most' : ''}?
        </p>
        <p id="gm-confirm-desc" style={noteStyle(c)}>
          This spends real Buzz — one charge per cell, only its real cost (usually a few Buzz).
          {label.isCeiling
            ? ` ${PAGE_BUZZ_BUDGET_PER_CELL.toLocaleString()} Buzz per cell is the safety cap, not what you'll spend.`
            : ''}{' '}
          Nothing is spent until you confirm.
        </p>
        {needsConsent && (
          <p role="status" style={noteStyle(c)}>
            Grant access to generate — confirm in the Civitai dialog. If you dismissed it, press
            Confirm again.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onConfirm}
            style={primaryBtn(c)}
            className="gm-chip"
            data-autofocus
            data-testid="gm-confirm"
          >
            {needsConsent ? 'Grant & generate' : 'Confirm & generate'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={secondaryBtn(c)}
            className="gm-chip"
            data-testid="gm-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result grid — rows=checkpoints, cols=modifiers
// ---------------------------------------------------------------------------

function ResultGrid(props: {
  c: Palette;
  cells: MatrixCell[];
  checkpoints: CheckpointOption[];
  modifiers: ModifierOption[];
  phase: string;
  canRetry: boolean;
  onReset: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { c, cells, checkpoints, modifiers, phase, canRetry, onReset, onStop, onRetry } = props;
  const byId = new Map(cells.map((cell) => [`${cell.row}:${cell.col}`, cell]));
  const spent = totalSpent(cells);
  const running = phase === 'running';
  // Cells whose submit is still in flight can't be cleanly canceled (no
  // workflowId yet) — Stop must be honest that they may still complete + bill.
  const uncancelable = uncancelableInFlightCount(cells);
  // A 3rd (or further) column can overflow at ~390px — surface the swipe cue +
  // edge fade only when it can actually happen (>2 columns). At ≤2 the table
  // fits, so no cue (avoids a misleading affordance). The CSS also gates these
  // on the narrow-viewport media query so desktop never shows them.
  const canOverflow = modifiers.length > 2;
  // Total cells already placed — drives the per-cell stagger cap so the last
  // cell never waits more than ~400ms.
  const totalCells = checkpoints.length * modifiers.length;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }} role="status">
          {running ? runProgressLabel(cells) : 'Done'} · spent {formatCost(spent)} Buzz
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {running && (
            <button
              type="button"
              onClick={onStop}
              style={secondaryBtn(c)}
              className="gm-chip"
              data-testid="gm-stop"
            >
              Stop
            </button>
          )}
          {phase === 'done' && canRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={primaryBtn(c)}
              className="gm-chip"
              data-testid="gm-retry"
            >
              Retry failed
            </button>
          )}
          {phase === 'done' && (
            <button
              type="button"
              onClick={onReset}
              style={secondaryBtn(c)}
              className="gm-chip"
              data-testid="gm-newrun"
            >
              New matrix
            </button>
          )}
        </div>
      </div>

      {running && uncancelable > 0 && (
        <p role="status" style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-stop-warning">
          {stopInProgressWarning()}
        </p>
      )}

      {canOverflow && (
        <p
          className="gm-swipe-cue"
          style={{ ...noteStyle(c), alignItems: 'center', gap: 6, margin: 0 }}
          aria-hidden
        >
          <span>← swipe to see every style →</span>
        </p>
      )}

      <div
        className="gm-grid-scroll"
        style={{ ['--gm-fade-color' as string]: c.fadeColor }}
      >
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th
                style={{ ...cornerTh(c), position: 'sticky', left: 0, zIndex: 2 }}
                className="gm-row-th"
                aria-hidden
              />
              {modifiers.map((m) => (
                <th key={m.key} scope="col" style={headTh(c)}>
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checkpoints.map((ckpt, row) => (
              <tr key={ckpt.versionId}>
                <th scope="row" style={rowTh(c)} className="gm-row-th">
                  {ckpt.label}
                </th>
                {modifiers.map((m, col) => {
                  const cell = byId.get(`${row}:${col}`);
                  const idx = row * modifiers.length + col;
                  return (
                    <td key={m.key} style={cellTd(c)}>
                      <div
                        className="gm-cell"
                        style={{
                          ['--gm-stagger' as string]: `${Math.min(idx, totalCells) * 40}ms`,
                        }}
                      >
                        <CellView c={c} cell={cell} />
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {canOverflow && <span className="gm-edge-fade" aria-hidden />}
      </div>
    </div>
  );
}

function CellView({ c, cell }: { c: Palette; cell: MatrixCell | undefined }) {
  if (!cell) return <span style={{ color: c.muted }}>—</span>;
  switch (cell.status) {
    case 'blocked':
      return (
        <CellBox c={c} label="Incompatible" sub="no charge" tone="muted" />
      );
    case 'canceled':
      return <CellBox c={c} label="Canceled" sub="no charge" tone="muted" />;
    case 'idle':
      return <CellBox c={c} label="Queued" tone="muted" />;
    // The in-flight states render an animated shimmer skeleton with the small
    // status label on top (D4.2), instead of a static text box.
    // estimating / submitting with no workflowId yet can't be cleanly canceled
    // by Stop (it may still complete + charge) — label it honestly so the user
    // can distinguish it from a cleanly-canceled cell.
    case 'estimating':
      return (
        <SkeletonCell
          c={c}
          label={isUncancelableInFlight(cell) ? 'Submitting (may charge)…' : 'Estimating…'}
        />
      );
    case 'submitting':
      return (
        <SkeletonCell
          c={c}
          label={isUncancelableInFlight(cell) ? 'Submitting (may charge)…' : 'Submitting…'}
        />
      );
    case 'polling':
      return <SkeletonCell c={c} label="Generating…" />;
    case 'insufficient':
      return <CellBox c={c} label="Out of Buzz" sub="top up & retry" tone="danger" />;
    case 'timedout':
      // Polling gave up; the gen may still finish + bill — so it's a muted
      // "still working" state, never a failure and never "no charge".
      return <CellBox c={c} label={timedOutCellLabel()} sub="may still finish" tone="muted" />;
    case 'failed':
      // Friendly label; keep the raw server detail in the tooltip so it's never lost.
      return (
        <CellBox
          c={c}
          label={failedCellLabel()}
          tone="danger"
          title={failedCellDetail(cell.error)}
        />
      );
    case 'done':
      return (
        <figure style={{ margin: 0, display: 'grid', gap: 4 }}>
          {cell.imageUrl ? (
            <CellImage
              c={c}
              src={cell.imageUrl}
              alt={`${cell.checkpoint.label} · ${cell.modifier.label}`}
            />
          ) : (
            // A `done` cell with no imageUrl: the gen succeeded + was charged but
            // the snapshot carried no image — show an explicit, non-blank state.
            <CellBox c={c} label="Image unavailable" sub="generated · charged" tone="muted" />
          )}
          <figcaption style={{ fontSize: 11, color: c.muted, textAlign: 'center' }}>
            {formatCost(cell.cost)} Buzz
          </figcaption>
        </figure>
      );
  }
}

/**
 * A cell image that fades + scales in once the bytes have DECODED (D4.1) — the
 * gm-img-loaded class (gated behind prefers-reduced-motion) is added on onLoad
 * so the animation runs on the painted image, not the empty element. A cached
 * image that's already complete on mount gets the class immediately.
 *
 * MONEY HONESTY (HIGH-1): a `done` cell is one the user was CHARGED for. The
 * `<img>` uses `opacity:0` until decoded, so without an error path a load
 * failure (expired/missing/NSFW-gated CDN edge, transient network) would leave
 * the paid cell PERMANENTLY blank — and "Retry failed" never picks it up (it's
 * `done`, not failed). `onError` therefore swaps the image for an explicit
 * "Image unavailable" box with an "Open image" link, so the cell is never blank
 * and the parent figure's "N Buzz" caption still tells the user they were
 * charged and the gen exists.
 */
function CellImage({ c, src, alt }: { c: Palette; src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // Re-arm on a new src (e.g. cell reuse) and fast-path a cached/instantly-
    // complete image (onLoad may not fire for an already-decoded image).
    setErrored(false);
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setLoaded(true);
  }, [src]);

  if (errored) {
    // Visibly non-blank, conveys "you were charged; image didn't load", and
    // offers a way to re-open the underlying image directly.
    return (
      <div
        role="img"
        aria-label={`${alt} — image unavailable`}
        style={{
          aspectRatio: '1 / 1',
          display: 'grid',
          placeContent: 'center',
          gap: 4,
          textAlign: 'center',
          background: c.inputBg,
          borderRadius: 6,
          padding: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: c.fg }}>Image unavailable</span>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 10, color: c.accent }}
          data-testid="gm-cell-open-image"
        >
          Open image
        </a>
      </div>
    );
  }

  return (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      onLoad={() => setLoaded(true)}
      // A failed load must NOT leave the cell at opacity:0 forever — surface the
      // explicit unavailable affordance instead (the user was already charged).
      onError={() => setErrored(true)}
      className={loaded ? 'gm-img-loaded' : undefined}
      style={{
        width: '100%',
        borderRadius: 6,
        display: 'block',
        aspectRatio: '1 / 1',
        objectFit: 'cover',
        // Hide until decoded so we never flash a half-painted image, then the
        // class fades it in. (Under reduced-motion the class sets opacity:1.)
        opacity: loaded ? 1 : 0,
      }}
    />
  );
}

/** An animated shimmer skeleton with a status label on top (D4.2). */
function SkeletonCell({ c, label }: { c: Palette; label: string }) {
  return (
    <div
      className="gm-skeleton"
      role="status"
      aria-label={label}
      style={{
        position: 'relative',
        aspectRatio: '1 / 1',
        borderRadius: 6,
        display: 'grid',
        placeContent: 'center',
        background: c.inputBg,
        // The theme-aware shimmer colors consumed by index.css.
        ['--gm-skel-base' as string]: c.skelBase,
        ['--gm-skel-shine' as string]: c.skelShine,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: c.accent }}>{label}</span>
    </div>
  );
}

function CellBox({
  c,
  label,
  sub,
  tone,
  title,
}: {
  c: Palette;
  label: string;
  sub?: string;
  tone: 'muted' | 'busy' | 'danger';
  /** Optional tooltip — used to preserve the raw failure detail on a failed cell. */
  title?: string;
}) {
  const color = tone === 'danger' ? c.danger : tone === 'busy' ? c.accent : c.muted;
  return (
    <div
      title={title}
      style={{
        aspectRatio: '1 / 1',
        display: 'grid',
        placeContent: 'center',
        gap: 2,
        textAlign: 'center',
        background: c.inputBg,
        borderRadius: 6,
        padding: 6,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{label}</span>
      {sub && <span style={{ fontSize: 10, color: c.muted, lineHeight: 1.3 }}>{sub}</span>}
    </div>
  );
}

function Chip({
  c,
  label,
  selected,
  isLora = false,
  onToggle,
}: {
  c: Palette;
  label: string;
  selected: boolean;
  /** LoRA columns read differently (cost, can be server-blocked) — mark them. */
  isLora?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className="gm-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: isLora ? '6px 12px 6px 9px' : '6px 12px',
        borderRadius: 999,
        border: `1px solid ${selected ? c.accent : c.border}`,
        // A faint accent left-tint marks LoRA chips when unselected; selected
        // chips already read as accent so the marker rides on the glyph.
        background: selected ? c.accent : isLora ? c.accentTint : 'transparent',
        color: selected ? c.accentFg : c.fg,
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {isLora && <LoraGlyph c={c} on={selected} />}
      {label}
    </button>
  );
}

/**
 * The small "this is a LoRA" marker — a layered-square resource glyph. Inherits
 * the accent (or accentFg on a selected chip) so it reads in both themes
 * without a paragraph of explanation (S2.2).
 */
function LoraGlyph({ c, on = false }: { c: Palette; on?: boolean }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 12 12"
      aria-hidden
      focusable="false"
      style={{ flex: 'none', verticalAlign: '-1px' }}
    >
      <rect
        x={1}
        y={3}
        width={7}
        height={7}
        rx={1.5}
        fill="none"
        stroke={on ? c.accentFg : c.accent}
        strokeWidth={1.4}
      />
      <rect
        x={4}
        y={1}
        width={7}
        height={7}
        rx={1.5}
        fill="none"
        stroke={on ? c.accentFg : c.accent}
        strokeWidth={1.4}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// First-run example + branded loading skeleton
// ---------------------------------------------------------------------------

/**
 * A one-glance "what is a matrix" affordance (I3.1): a tiny 2×2 grid of accent
 * dots labeled by the two axes, so the concept reads instantly without a
 * docs-like paragraph. Decorative — labeled for AT, dots aria-hidden.
 */
function FirstRunExample({ c }: { c: Palette }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        background: c.cardBg,
        padding: '10px 12px',
      }}
      aria-label="Example: a 2 by 2 grid of two models across two styles"
    >
      <div
        aria-hidden
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 18px)',
          gridAutoRows: '18px',
          gap: 4,
          flex: 'none',
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              borderRadius: 4,
              background: i % 3 === 0 ? c.accent : c.accentTint,
              border: `1px solid ${c.accent}`,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>2 models × 2 styles = 4 cells</span>
        <span style={{ ...noteStyle(c), margin: 0 }}>
          Each cell is one real generation — compare them side by side.
        </span>
      </div>
    </div>
  );
}

/**
 * Branded load skeleton (P5.5) — mirrors the eventual build-form layout (title,
 * prompt box, two chip rows, summary, button) with shimmer placeholders, so the
 * app feels instant on mount instead of a bare "Loading…" line.
 */
function LoadingSkeleton({ c }: { c: Palette }) {
  const shimmer = (style: React.CSSProperties) => (
    <div
      className="gm-skeleton"
      style={{
        background: c.inputBg,
        borderRadius: 8,
        ['--gm-skel-base' as string]: c.skelBase,
        ['--gm-skel-shine' as string]: c.skelShine,
        ...style,
      }}
    />
  );
  return (
    <div style={contentStyle()} role="status" aria-label="Loading Gen Matrix" data-testid="gm-loading">
      {shimmer({ height: 28, width: 180 })}
      {shimmer({ height: 16, width: '60%' })}
      {shimmer({ height: 72 })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {shimmer({ height: 32, width: 96, borderRadius: 999 })}
        {shimmer({ height: 32, width: 96, borderRadius: 999 })}
        {shimmer({ height: 32, width: 120, borderRadius: 999 })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {shimmer({ height: 32, width: 84, borderRadius: 999 })}
        {shimmer({ height: 32, width: 84, borderRadius: 999 })}
        {shimmer({ height: 32, width: 84, borderRadius: 999 })}
        {shimmer({ height: 32, width: 110, borderRadius: 999 })}
      </div>
      {shimmer({ height: 40 })}
      {shimmer({ height: 48 })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Theme — host can't inject CSS into the iframe; colors via inline styles.
// ---------------------------------------------------------------------------

interface Palette {
  bg: string;
  fg: string;
  cardBg: string;
  border: string;
  inputBg: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerBg: string;
  muted: string;
  /** Translucent accent tint — used for the faint LoRA-chip marker. */
  accentTint: string;
  /** Skeleton shimmer base + highlight (theme-aware; consumed by index.css). */
  skelBase: string;
  skelShine: string;
  /** The color the mobile edge-fade fades toward (matches the page bg). */
  fadeColor: string;
}

function palette(dark: boolean): Palette {
  return dark
    ? {
        bg: '#1a1b1e',
        fg: '#e9ecef',
        cardBg: '#25262b',
        border: '#373a40',
        inputBg: '#2c2e33',
        accent: '#fab005',
        accentFg: '#1a1b1e',
        danger: '#ff8787',
        dangerBg: '#2c1f1f',
        muted: '#909296',
        accentTint: 'rgba(250, 176, 5, 0.12)',
        skelBase: 'rgba(255, 255, 255, 0.05)',
        skelShine: 'rgba(255, 255, 255, 0.13)',
        fadeColor: '#1a1b1e',
      }
    : {
        bg: '#ffffff',
        fg: '#1a1b1e',
        cardBg: '#f8f9fa',
        border: '#dee2e6',
        inputBg: '#f1f3f5',
        accent: '#f08c00',
        accentFg: '#ffffff',
        danger: '#e03131',
        dangerBg: '#fff5f5',
        muted: '#868e96',
        accentTint: 'rgba(240, 140, 0, 0.10)',
        skelBase: 'rgba(0, 0, 0, 0.05)',
        skelShine: 'rgba(0, 0, 0, 0.11)',
        fadeColor: '#ffffff',
      };
}

function pageStyle(c: Palette): React.CSSProperties {
  return {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    background: c.bg,
    color: c.fg,
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}

function contentStyle(): React.CSSProperties {
  return {
    margin: '0 auto',
    width: '100%',
    maxWidth: 820,
    padding: 24,
    display: 'grid',
    gap: 16,
    alignContent: 'start',
    boxSizing: 'border-box',
  };
}

function textareaStyle(c: Palette): React.CSSProperties {
  return {
    resize: 'vertical',
    padding: 12,
    borderRadius: 8,
    border: `1px solid ${c.border}`,
    background: c.inputBg,
    color: c.fg,
    fontSize: 15,
    lineHeight: 1.5,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 72,
  };
}

function fieldsetStyle(c: Palette): React.CSSProperties {
  return { border: `1px solid ${c.border}`, borderRadius: 8, padding: 12, margin: 0 };
}

const legendStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, padding: '0 6px' };
const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };

function summaryBox(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums',
  };
}

function confirmBox(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.accent}`,
    borderRadius: 12,
    padding: 16,
    display: 'grid',
    gap: 10,
    background: c.cardBg,
    width: '100%',
    maxWidth: 460,
    boxSizing: 'border-box',
    boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
  };
}

// The modal backdrop — dims the page and centers the dialog. A click on the
// backdrop itself (handled in ConfirmPanel) cancels.
function backdropStyle(): React.CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'grid',
    placeItems: 'center',
    padding: 16,
    zIndex: 60,
    boxSizing: 'border-box',
  };
}

function primaryBtn(c: Palette, disabled = false): React.CSSProperties {
  return {
    padding: '12px 18px',
    border: 'none',
    borderRadius: 8,
    background: disabled ? c.border : c.accent,
    color: disabled ? c.muted : c.accentFg,
    fontWeight: 700,
    fontSize: 15,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function secondaryBtn(c: Palette): React.CSSProperties {
  return {
    padding: '12px 18px',
    border: `1px solid ${c.border}`,
    borderRadius: 8,
    background: 'transparent',
    color: c.fg,
    fontWeight: 600,
    fontSize: 15,
    cursor: 'pointer',
  };
}

function noteStyle(c: Palette): React.CSSProperties {
  return { fontSize: 13, color: c.muted, margin: 0, lineHeight: 1.5 };
}

// A dashed "add" chip for the resource-picker affordance — visually distinct
// from a selectable Chip so it reads as an action, not a toggle.
function pickBtn(c: Palette, busy: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: `1px dashed ${c.accent}`,
    background: 'transparent',
    color: busy ? c.muted : c.accent,
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
  };
}

// The PRIMARY browse affordance — a filled accent chip (the fast curated path),
// visually stronger than the dashed "All resources" fallback next to it.
function browseBtn(c: Palette): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: `1px solid ${c.accent}`,
    background: c.accent,
    color: c.accentFg,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  };
}

function cornerTh(c: Palette): React.CSSProperties {
  return { border: `1px solid ${c.border}`, padding: 6, background: c.cardBg, width: 90 };
}
function headTh(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    padding: 8,
    background: c.cardBg,
    fontSize: 12,
    fontWeight: 700,
  };
}
function rowTh(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    padding: 8,
    background: c.cardBg,
    fontSize: 12,
    fontWeight: 700,
    textAlign: 'left',
    whiteSpace: 'nowrap',
  };
}
function cellTd(c: Palette): React.CSSProperties {
  return { border: `1px solid ${c.border}`, padding: 6, verticalAlign: 'top', minWidth: 110 };
}
