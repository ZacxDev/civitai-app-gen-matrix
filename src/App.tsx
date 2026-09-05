import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  useAppStorage,
  useAppWorkflows,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useDomainMaturity,
  useBuzzPurchase,
  useBuzzWorkflow,
  useGatedImages,
  usePublishGenerationOutputs,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
  useSharedStorage,
} from '@civitai/blocks-react';
import { Slider, Tooltip, useToast } from '@civitai/components-react';
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
  cellKindKey,
  composeCellPrompt,
  incompatibleCellReason,
  clampLoraStrength,
  DEFAULT_LORA_STRENGTH,
  LORA_STRENGTH_MAX,
  LORA_STRENGTH_MIN,
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
  runElapsedLabel,
  sharedPromptFromCells,
  timedOutCellLabel,
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
import { noteStyle, palette, primaryBtn, secondaryBtn, type Palette } from './theme.js';
import { paintTheme } from './bootTheme.js';
import { MaturityImage } from './MaturityImage.js';
import {
  archiveStateFromManifest,
  buildRunManifest,
  isPersistableRun,
  reconcileCells,
  restoreStateFromManifest,
  runTimingFromManifest,
  type AppWorkflowLike,
  type MaturityGate,
} from './persistence.js';
import { GalleryPanel, type GalleryImages } from './GalleryPanel.js';
import { PublishMatrixPanel, type PublishPhase } from './PublishMatrixPanel.js';
import {
  PUBLISHED_KEYS_STORAGE_KEY,
  REPORTED_KEYS_STORAGE_KEY,
  addKeyToSet,
  collectImageIds,
  composeGalleryBody,
  defaultGalleryTitle,
  indexGatedImages,
  keySetBlob,
  loadGallery,
  normalizeGalleryTitle,
  parseKeySet,
  publishMatrix,
  publishResultMessage,
  publishableCells,
  PUBLISHED_CELLS_STORAGE_KEY,
  ORPHANED_ENTRY_KEY,
  addPublishedCells,
  cellPublishKey,
  indexPublishedCells,
  parsePublishedCells,
  publishTargetKey,
  publishedCellsBlob,
  unpublishedCells,
  type PublishedCellRecord,
  type GalleryEntry,
  type GalleryLoad,
} from './gallery.js';
import {
  ACTIVE_RUN_POINTER_KEY,
  HISTORY_LIST_CAP,
  HISTORY_RETENTION_CAP,
  evictBeyondRetention,
  historyAgeLabel,
  loadHistory,
  migrateLegacyRun,
  mintHistoryKey,
  readActiveRunKey,
  type HistoryLoad,
} from './history.js';

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
  const { ready, viewer, theme, context } = useBlockContext();
  const token = useBlockToken();
  // The block's domain maturity ceiling (fail-closed SFW). Threaded into the
  // anon catalog read so a red-domain block's anon browse can show mature while
  // green/blue stay SFW. The token (signed-in) path ignores it — server clamps.
  // ALSO drives the G1 result-image maturity gate (below).
  const domainMaturity = useDomainMaturity();
  const { isSfw: domainIsSfw } = domainMaturity;
  const { estimate, submit, poll, cancel } = useBuzzWorkflow();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const { openPurchaseModal } = useBuzzPurchase();
  const { open: openResourcePicker } = useResourcePicker();
  // M1 — the persistent read-model. `useAppStorage` (per-viewer KV that survives
  // reload) holds the run manifest; `useAppWorkflows` is the host's authoritative,
  // per-app-tag-scoped list we reconcile against for status/image/nsfwLevel/cost.
  const storage = useAppStorage();
  const { workflows: appWorkflows, refetch: refetchWorkflows } = useAppWorkflows();
  // The gallery's three host surfaces. `shared` is the app-scoped index every
  // viewer reads; `publish` turns this viewer's own workflow outputs into real
  // public Image rows; `getImages` reads those ids back under the REQUESTING
  // viewer's own maturity clamp (see gallery.ts for why ids, not urls).
  const shared = useSharedStorage();
  const { publish } = usePublishGenerationOutputs();
  const { getImages } = useGatedImages();
  const toast = useToast();

  // G1 — the domain ceiling the result-image gate consults (stable identity for
  // deps). `isLevelAllowed`/`isSfw` are re-read live from useDomainMaturity.
  const maturityGate = useMemo<MaturityGate>(
    () => ({ isLevelAllowed: domainMaturity.isLevelAllowed, isSfw: domainMaturity.isSfw }),
    [domainMaturity.isLevelAllowed, domainMaturity.isSfw],
  );

  // 🔴 NEVER the bare `theme` here, and in THIS app it drives more than an
  // attribute: `palette(isDark)` is JS-derived, so the sentinel picked the whole
  // light colour set for the `!ready` commit. Before `ready` the SDK's snapshot
  // hardcodes the string 'light' (blocks-react dist/internal/transport.js,
  // EMPTY_SNAPSHOT), so every pre-init viewer got a LIGHT skeleton — repainting
  // index.html's dark boot skeleton white, then dark again at BLOCK_INIT. After
  // `ready` the host's answer wins outright, exactly as before. See src/bootTheme.ts.
  const isDark = paintTheme(ready, theme) === 'dark';
  const c = palette(isDark);
  const anon = ready && !viewer;
  // 🔴 THE SLOT CONTEXT, NOT `viewer.id`. `ViewerInfo.id`/`username` are
  // `@deprecated` ("Init-time identity disclosure … scheduled for removal") and
  // their supported replacement `useViewer()` is scope-gated on
  // `user:read:self`. `PageSlotContext.viewerUserId` is neither: it is part of
  // the context `PageBlockHost.buildContext()` already sends, carries no
  // deprecation marker, and costs no scope. It is used for ONE thing — deciding
  // whether a gallery row is this viewer's own — and it fails CLOSED when absent.
  // This does NOT touch the sign-in gate above, which stays `ready && !viewer`.
  const viewerUserId =
    context != null && 'viewerUserId' in context && typeof context.viewerUserId === 'number'
      ? context.viewerUserId
      : null;
  const granted = hasBudgetedScope(token.scopes);

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // ---- Selection state (the "build" surface) ----
  const [prompt, setPrompt] = useState('');
  const [selectedCkpts, setSelectedCkpts] = useState<Set<number>>(
    () => new Set([CHECKPOINTS[0]?.versionId].filter((v): v is number => v != null)),
  );
  // Default-select TWO styles so the out-of-box matrix demonstrates a real
  // comparison (a 1-cell "matrix" doesn't). Baseline (no-style reference) +
  // Cinematic — both prompt-style (non-LoRA), so the default run never hinges on
  // a server compatibility check.
  const [selectedMods, setSelectedMods] = useState<Set<string>>(
    () => new Set(['baseline', 'cinematic']),
  );

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

  // Per-LoRA strength overrides (design-system Slider). Keyed by modifier key so
  // a picked/curated LoRA column's strength is user-tunable before spend. Applied
  // when composing the chosen modifiers; server-clamped to [-1, 2] regardless.
  const [strengthOverrides, setStrengthOverrides] = useState<Map<string, number>>(
    () => new Map(),
  );

  // ---- Run state (the matrix reducer) ----
  const [state, dispatch] = useReducer(matrixReducer, initialMatrixState);

  // Per-cell enlarge lightbox (shows the UNCROPPED paid output + copy-URL). Null
  // = closed. Reached only from a revealed/safe thumbnail (see MaturityImage).
  const [lightbox, setLightbox] = useState<{
    src: string;
    alt: string;
    nsfwLevel: number | null | undefined;
    /** The cell's EFFECTIVE prompt (shared + this style's suffix). */
    prompt: string;
  } | null>(null);
  // "New matrix" confirm gate — deleting a paid run must be intentional.
  const [confirmReset, setConfirmReset] = useState(false);

  // ---- Release A — run history + elapsed time ----
  // The history index. `null` means "not read yet" and renders NOTHING: before
  // the read resolves we know neither that the viewer has matrices nor that they
  // have none, and a component that guesses at that moment will flash the wrong
  // one of those two claims on every mount.
  const [history, setHistory] = useState<HistoryLoad | null>(null);
  // Bumped to force a re-read (after a run completes / is cleared).
  const [historyNonce, setHistoryNonce] = useState(0);
  // True while showing a matrix reopened FROM history: it is already paid for
  // and already finished, so the run controls that could spend Buzz are withheld.
  const [viewingHistory, setViewingHistory] = useState(false);
  // The storage key the live/open run is written to — one key per run, which is
  // what turns the old single slot into a list. Null before a run has started.
  const currentRunKeyRef = useRef<string | null>(null);
  // Wall-clock stamps for change 5. Kept OUT of `matrixReducer` deliberately:
  // that reducer is pure and takes no clock, and threading a timestamp through
  // every action to stamp two of them would make every other transition harder
  // to reason about for no gain.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runFinishedAt, setRunFinishedAt] = useState<number | null>(null);
  // Only a run STARTED in this session may stamp its own finish — see the effect.
  const startedThisSessionRef = useRef(false);
  // Ticks once a second while running so the elapsed label advances.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // ---- The published-matrix gallery ----
  // `null` renders "loading", never "empty" — before the read resolves we know
  // neither that the gallery has entries nor that it has none.
  const [galleryLoad, setGalleryLoad] = useState<GalleryLoad | null>(null);
  const [galleryImages, setGalleryImages] = useState<GalleryImages | null>(null);
  const [galleryNonce, setGalleryNonce] = useState(0);
  // The viewer's OWN gallery keys and the ones they have reported, both read
  // from their PRIVATE per-viewer storage. This is what lets the app answer
  // "is this row mine" without a `user:read:self` scope — see gallery.ts.
  const [ownKeys, setOwnKeys] = useState<Set<string>>(() => new Set());
  const [reportedKeys, setReportedKeys] = useState<Set<string>>(() => new Set());
  const [galleryBusyKeys, setGalleryBusyKeys] = useState<Set<string>>(() => new Set());
  const [galleryErrors, setGalleryErrors] = useState<Map<string, string>>(() => new Map());
  const [publishTitle, setPublishTitle] = useState('');
  const [publishTitleTouched, setPublishTitleTouched] = useState(false);
  const [publishPhase, setPublishPhase] = useState<PublishPhase>({ kind: 'idle' });
  // 🔴 THE PER-CELL PUBLISH LEDGER, READ FROM DURABLE PER-VIEWER STORAGE.
  // This replaces a session-held signature of the whole publishable set, which
  // re-armed the control both when the set GREW (retry a failed cell → the other
  // three republish) and when the SESSION ended (a reload lost the Set while the
  // cell ids came back intact). Both produced duplicate permanent public images.
  // The durable answer is per cell — see `PUBLISHED_CELLS_STORAGE_KEY`.
  const [publishedCells, setPublishedCells] = useState<PublishedCellRecord[]>([]);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [publishProblem, setPublishProblem] = useState(false);

  // Auto-resume intent across the consent round-trip.
  const consentPendingRef = useRef(false);
  // Per-cell poll cancellation tokens, torn down on unmount / reset.
  const pollTokensRef = useRef<Map<string, { cancelled: boolean }>>(new Map());
  // M4 — submit idempotency guard. Cell ids that have entered `runCell` this run,
  // so a StrictMode double-invoke / re-entrant queue tick can't fire a SECOND
  // submit (a second real spend) for the same cell. Belt-and-suspenders: the
  // platform's per-app Redis idempotency cap is the authoritative backstop, but
  // this stops a duplicate leaving the client at all. Cleared on BUILD / RESET.
  const submittedRef = useRef<Set<string>>(new Set());
  // M1 — guards so the mount-time restore fires once and reconcile re-runs only
  // when the read-model actually changes.
  const restoredRef = useRef(false);
  const reconciledSigRef = useRef<string>('');

  // Keep the latest hook fns in refs so the queue driver (an effect) always
  // calls the current instances without re-subscribing.
  const fns = useRef({ estimate, submit, poll, cancel });
  fns.current = { estimate, submit, poll, cancel };
  // Toast API in a ref so the stable runCell/poll callbacks reach the current one.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // refetch in a ref so the done-count effect doesn't churn on hook identity.
  const refetchRef = useRef(refetchWorkflows);
  refetchRef.current = refetchWorkflows;

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
    () =>
      allModifiers
        .filter((m) => selectedMods.has(m.key))
        .map((m) =>
          // Apply a user LoRA-strength override (Slider) to the selected column.
          m.loraVersionId != null && strengthOverrides.has(m.key)
            ? { ...m, loraStrength: clampLoraStrength(strengthOverrides.get(m.key)) }
            : m,
        ),
    [allModifiers, selectedMods, strengthOverrides],
  );

  // The selected LoRA columns whose strength the Slider can tune (build phase).
  const selectedLoraModifiers = useMemo(
    () => chosenModifiers.filter((m) => m.loraVersionId != null),
    [chosenModifiers],
  );
  const setLoraStrength = useCallback((key: string, value: number) => {
    setStrengthOverrides((prev) => {
      const next = new Map(prev);
      next.set(key, clampLoraStrength(value));
      return next;
    });
  }, []);

  // The result-grid axes are derived FROM the run's cells (their row/col), not
  // the live selection — so a RESTORED run (M1) renders its own grid even though
  // the build-panel selection has reset to the default. row/col are contiguous
  // from buildMatrix, so the sorted maps reproduce the original axes.
  const { gridCheckpoints, gridModifiers } = useMemo(() => {
    const ckMap = new Map<number, CheckpointOption>();
    const modMap = new Map<number, ModifierOption>();
    for (const cell of state.cells) {
      if (!ckMap.has(cell.row)) ckMap.set(cell.row, cell.checkpoint);
      if (!modMap.has(cell.col)) modMap.set(cell.col, cell.modifier);
    }
    const byIndex = <T,>(m: Map<number, T>): T[] =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return { gridCheckpoints: byIndex(ckMap), gridModifiers: byIndex(modMap) };
  }, [state.cells]);

  // Preview cells (for the count / cost gate) — independent of the run state.
  const previewCells = useMemo(
    () => buildMatrix(prompt, chosenCheckpoints, chosenModifiers),
    [prompt, chosenCheckpoints, chosenModifiers],
  );
  const billable = billableCellCount(previewCells);
  const over = exceedsCap(previewCells);

  // ---- Build-phase PER-KIND estimate (best-effort, debounced) ----
  // Fire one estimate() per DISTINCT billing kind (baseline/prompt-style = the
  // 'base' kind; each distinct LoRA = its own kind) while the user is still
  // building, so the summary + confirm gate can HEADLINE a real "≈ N Buzz" total
  // — and, crucially, that "≈" SURVIVES the multi-LoRA compare case (a single
  // representative estimate would undercount when ≥2 distinct LoRAs differ). At
  // most a few estimates fire (kinds ≤ selected columns ≤ the cell cap).
  // Best-effort: a slow/failed estimate never blocks the UI or Generate and never
  // changes the cap/spend logic — a kind with no estimate falls to the ceiling.
  const [buildKindEstimates, setBuildKindEstimates] = useState<Record<string, number>>({});
  const firstCheckpoint = chosenCheckpoints[0];
  // One representative modifier per distinct kind (first wins), stable-keyed.
  const kindReps = useMemo(() => {
    const map = new Map<string, ModifierOption>();
    for (const m of chosenModifiers) {
      const k = cellKindKey(m);
      if (!map.has(k)) map.set(k, m);
    }
    return map;
  }, [chosenModifiers]);
  // The material signature — re-estimate (debounced) only when the prompt, the
  // representative checkpoint, or the set of distinct kinds changes.
  const kindSig = [
    prompt.trim(),
    firstCheckpoint?.versionId ?? 'none',
    [...kindReps.keys()].sort().join(','),
  ].join('|');
  useEffect(() => {
    if (prompt.trim().length === 0 || !firstCheckpoint || kindReps.size === 0) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      const reps = [...kindReps.entries()];
      Promise.all(
        reps.map(async ([kind, modifier]) => {
          const body = buildCellBody(firstCheckpoint, composeCellPrompt(prompt, modifier), modifier);
          try {
            const e = await fns.current.estimate(body);
            const total = e.cost?.total;
            if (total != null && Number.isFinite(total) && total > 0) {
              return [kind, total] as const;
            }
          } catch {
            /* best-effort — this kind falls to the ceiling in the total */
          }
          return null;
        }),
      ).then((results) => {
        if (cancelled) return;
        // Replace wholesale for this signature so a stale kind's estimate can't
        // linger after the prompt/checkpoint (which changes ALL costs) changes.
        const next: Record<string, number> = {};
        for (const r of results) if (r) next[r[0]] = r[1];
        setBuildKindEstimates(next);
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // kindSig captures the material selection bits; the effect body reads the
    // current prompt/checkpoint/kindReps. Keying on kindSig debounces per-change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindSig]);

  // A single representative per-cell number (the priciest known kind, so it
  // over-covers) to seed the run + the Top-Up suggestion. The DISPLAY total uses
  // the full per-kind map (below); this is only the run/topup scalar.
  const repCellEstimate = useMemo(() => {
    const vals = Object.values(buildKindEstimates).filter(
      (v) => Number.isFinite(v) && v > 0,
    );
    return vals.length ? Math.max(...vals) : null;
  }, [buildKindEstimates]);

  // The preview total HEADLINES the real per-kind "≈ N" once estimates land
  // (surviving multi-LoRA); until then it's the cap-based MAXIMUM ("up to M"),
  // with the ceiling always available as a demoted "safety max" hint.
  const previewLabel = matrixTotalLabel(previewCells, buildKindEstimates);

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
    // M4 — idempotency guard: never enter the estimate→submit path twice for the
    // same cell in a run (StrictMode double-invoke / re-entrant queue tick). The
    // first entry claims the id; a second is a no-op, so it can never re-spend.
    if (submittedRef.current.has(cell.id)) return;
    submittedRef.current.add(cell.id);

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
      const insufficient = isInsufficientBuzz(msg);
      const incompatible = isIncompatibleResourceError(msg);
      dispatch({ type: 'CELL_ERROR', id: cell.id, error: msg, insufficient, incompatible });
      // A genuine failure (not the expected pre-spend `blocked`, not the
      // Top-Up-handled `insufficient`) gets a non-blocking Toast so it's noticed
      // even if the cell scrolled out of view. Design-system Toast (STEP 2).
      if (!insufficient && !incompatible) {
        toastRef.current?.show({
          title: 'A cell failed to generate',
          message: `${cell.checkpoint.label} · ${cell.modifier.label} — you can Retry failed.`,
          color: 'error',
        });
      }
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

  // Re-attach a poll loop to any `polling` cell that has a workflowId but no live
  // poll token (a restored / reconciled in-flight cell). runPollLoop cancels any
  // stale token first, so this is idempotent. M2's recovery path.
  const resumePolling = useCallback(
    (cells: readonly MatrixCell[]) => {
      for (const cell of cells) {
        if (cell.status !== 'polling' || cell.workflowId == null) continue;
        const tok = pollTokensRef.current.get(cell.id);
        if (tok && !tok.cancelled) continue; // already polling
        runPollLoop(cell.id, cell.workflowId);
      }
    },
    [runPollLoop],
  );

  // ---- M1 — restore a prior run on mount (once, for a signed-in viewer) ----
  // Reload / device-switch rebuilds the in-flight + done matrix from the
  // persisted manifest so paid outputs are never "lost". No auto-spend: an
  // un-submitted cell restores as `canceled` (see restoreStateFromManifest).
  useEffect(() => {
    if (restoredRef.current || !ready || !viewer) return;
    restoredRef.current = true;
    let cancelled = false;
    void (async () => {
      // 1) Rescue the legacy single-slot run into the history keyspace. A viewer
      //    mid-generation when this ships has their matrix in the OLD key; if we
      //    only ever looked at the new one they would boot into an empty build
      //    screen while a run they are paying for sat unreachable.
      const migrated = await migrateLegacyRun(storage);
      let activeKey: string | null = migrated.key;
      let raw: unknown = migrated.manifest;

      // 2) Otherwise follow the active-run pointer. The pointer is what makes
      //    "New matrix" able to clear the screen WITHOUT deleting the paid run:
      //    the row stays in history, only the pointer goes.
      if (raw == null) {
        try {
          // `readActiveRunKey` is the single owner of "what does the pointer
          // say" — open-coding the shape check here would let the two readings
          // drift apart, and eviction depends on this one being right.
          const key = await readActiveRunKey(storage);
          if (key) {
            activeKey = key;
            raw = await storage.get<unknown>(key);
          }
        } catch {
          /* best-effort — an unreadable pointer just starts on the build screen */
        }
      }
      if (cancelled || raw == null) return;

      const restored = restoreStateFromManifest(raw);
      if (!restored) return;
      currentRunKeyRef.current = activeKey;
      // The stamps come from the MANIFEST, never from the restore itself — see
      // `runElapsedLabel`. An older manifest carries neither, and that run's
      // elapsed time is then correctly shown as nothing.
      const timing = runTimingFromManifest(raw);
      setRunStartedAt(timing.startedAt ?? null);
      setRunFinishedAt(timing.finishedAt ?? null);
      // Mark every already-submitted cell so the M4 guard won't re-submit it.
      for (const cell of restored.cells) {
        if (cell.workflowId != null) submittedRef.current.add(cell.id);
      }
      dispatch({ type: 'RESTORE', state: restored });
      resumePolling(restored.cells);
      refetchWorkflows();
    })().catch(() => {
      /* best-effort — a missing/malformed manifest just starts fresh */
    });
    return () => {
      cancelled = true;
    };
  }, [ready, viewer, storage, resumePolling, refetchWorkflows]);

  // ---- Release A — read the history index ----
  // Runs for anon too: `list` resolves EMPTY for an anonymous viewer rather than
  // rejecting, so they get the ordinary empty state instead of an error.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setHistory(null);
    void (async () => {
      // Trim the keyspace BEFORE reading it, so the list the viewer sees is the
      // list that survives. Signed-in only: an anon viewer cannot write, and the
      // deletes would simply reject. See `HISTORY_RETENTION_CAP` — the quota is
      // per APP, so one heavy viewer's unbounded rows turn persistence off for
      // everyone, silently.
      // 🔴 `currentRunKeyRef.current` IS `null` HERE ON MOUNT, MEASURED — it is
      // assigned two awaits deep in the restore effect above, and `handleReset`
      // clears it just before bumping the nonce. It is passed anyway because
      // mid-session it IS the key (minted by `beginRun`, before the 250 ms
      // persist write has told storage about it), but the guard that actually
      // protects the active run is `evictBeyondRetention`'s own pointer read —
      // see its doc comment.
      if (viewer) {
        await evictBeyondRetention(storage, HISTORY_RETENTION_CAP, [currentRunKeyRef.current]);
      }
      if (cancelled) return;
      const h = await loadHistory(storage).catch(
        // `loadHistory` already maps a rejection to `{kind:'error'}`; this is the
        // belt for anything thrown before it. Never a silent empty list.
        () => ({ kind: 'error' }) as HistoryLoad,
      );
      if (!cancelled) setHistory(h);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, viewer, storage, historyNonce]);

  // ---- Gallery — read the shared index ----
  // Runs for anon too: reading the gallery is NOT behind the publish cohort gate
  // and `list` has an anonymous read path, so a signed-out viewer browses it.
  // 🔴 A REJECTION MUST NOT BECOME AN EMPTY LIST. `loadGallery` already maps one
  // to `{kind:'error'}`; the `.catch` is the belt for anything thrown before it.
  // Until a version carrying the shared scopes is APPROVED this is the branch
  // every viewer lands in, so it is the one that has to be honest.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setGalleryLoad(null);
    setGalleryImages(null);
    void (async () => {
      const load = await loadGallery(shared).catch(() => ({ kind: 'error' }) as GalleryLoad);
      if (!cancelled) setGalleryLoad(load);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, shared, galleryNonce]);

  // ---- Gallery — read the images, per viewer, through the host's clamp ----
  // ONE call for every listed entry's ids, then distributed BY ID. The host
  // OMITS ids it cannot resolve, so the reply may be shorter than the request
  // and its order means nothing — `indexGatedImages` is what makes that safe.
  const galleryEntryIds = galleryLoad?.kind === 'ok' ? collectImageIds(galleryLoad.entries) : null;
  // A stable signature so the effect fires on a real change of ids, not on the
  // new array identity `collectImageIds` returns every render.
  const galleryIdSig = galleryEntryIds?.join(',') ?? '';
  useEffect(() => {
    if (galleryEntryIds == null) return;
    if (galleryEntryIds.length === 0) {
      setGalleryImages({ kind: 'ok', byId: new Map() });
      return;
    }
    let cancelled = false;
    setGalleryImages(null);
    void getImages(galleryEntryIds)
      .then((images) => {
        if (!cancelled) setGalleryImages({ kind: 'ok', byId: indexGatedImages(images) });
      })
      .catch(() => {
        if (!cancelled) setGalleryImages({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryIdSig, getImages]);

  // ---- Gallery — the viewer's own + reported keys, from PRIVATE storage ----
  useEffect(() => {
    if (!ready) return;
    // 🔴 CLEAR ON SIGN-OUT, DON'T JUST STOP READING. Early-returning without
    // clearing left the previous viewer's keys in state: `Remove` stayed offered
    // and ENABLED on rows the new (or anonymous) viewer does not own, and
    // `withdraw` is author-scoped server-side, so pressing it is a guaranteed
    // rejection — offering an error, which is the exact failure the id-free
    // ownership design existed to avoid. Stale `reportedKeys` also suppressed
    // Report for a viewer who never reported anything.
    if (!viewer) {
      setOwnKeys(new Set());
      setReportedKeys(new Set());
      setPublishedCells([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [own, reported, cells] = await Promise.all([
        storage.get(PUBLISHED_KEYS_STORAGE_KEY).catch(() => null),
        storage.get(REPORTED_KEYS_STORAGE_KEY).catch(() => null),
        storage.get(PUBLISHED_CELLS_STORAGE_KEY).catch(() => null),
      ]);
      if (cancelled) return;
      setOwnKeys(new Set(parseKeySet(own)));
      setReportedKeys(new Set(parseKeySet(reported)));
      // 🔴 This is what makes the publish disarm survive a reload.
      setPublishedCells(parsePublishedCells(cells));
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, viewer, storage]);

  // ---- Release A — stamp the run's finish, once, in the session that ran it ----
  // 🔴 GATED ON `startedThisSessionRef`. Stamping any run that merely LOOKS done
  // would give a matrix restored from storage a finish time of "now", so a run
  // from last week would report a week-long duration. Only the session that
  // watched the run end knows when it ended.
  useEffect(() => {
    if (state.phase !== 'done') return;
    if (!startedThisSessionRef.current) return;
    setRunFinishedAt((prev) => prev ?? Date.now());
  }, [state.phase]);

  // Advance the elapsed clock while a run is in progress.
  useEffect(() => {
    if (state.phase !== 'running') return;
    setNowTick(Date.now());
    const handle = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [state.phase]);

  // ---- M1/M2 — reconcile against the authoritative read-model ----
  // Whenever useAppWorkflows changes, merge status/image/nsfwLevel/cost onto the
  // matrix cells (by workflowId) and resume polling anything still running
  // server-side. Only acts on cells that carry a workflowId, and never during a
  // fresh (unstarted) build — reconcile can't re-charge.
  //
  // 🔴 AN ARCHIVE IS INERT TO RECONCILE, AND THAT IS A SEAM, NOT A TIDY-UP.
  // `archiveStateFromManifest` maps a `polling` cell to `timedout`, and
  // `isReconcileFinal` is `isTerminalCell(status) && status !== 'timedout'` — so
  // reconcile treats exactly the cells the archive form produced as NON-final
  // and re-activates them. Measured at unit level: archive statuses
  // `done,timedout` reconcile to `done,polling` with one resumable id. Both
  // halves are individually correct; only their composition is wrong. The
  // trigger exists too — `handleOpenHistory` does not reset `reconciledSigRef`,
  // and the `doneCount` effect below fires a refetch 400 ms after the archive
  // loads. The result a viewer would see: a "terminal, read-only" archive back
  // on "Generating…", with no Stop and no Re-check (both withheld by
  // `readOnly`), polling the network and discarding what it learns.
  //
  // The guard is FIRST, before the signature is consumed, so leaving the archive
  // reconciles normally instead of skipping the page it never processed.
  useEffect(() => {
    if (viewingHistory) return;
    if (appWorkflows.length === 0) return;
    if (!state.cells.some((c) => c.workflowId != null)) return;
    // Re-run only when the read-model actually changed (avoid a reconcile loop).
    const sig = appWorkflows.map((w) => `${w.workflowId}:${w.status}`).join('|');
    if (reconciledSigRef.current === sig) return;
    reconciledSigRef.current = sig;
    const { cells, resumableIds } = reconcileCells(
      state.cells,
      appWorkflows as unknown as AppWorkflowLike[],
    );
    dispatch({ type: 'RECONCILE', cells });
    if (resumableIds.length > 0) resumePolling(cells);
    // state.cells intentionally omitted: keyed on the read-model signature so a
    // reconcile-driven cell change doesn't immediately re-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appWorkflows, resumePolling, viewingHistory]);

  // ---- M1 — persist the run as it progresses (signed-in only) ----
  // Written on every material state change so a reload mid-run recovers. anon /
  // over-quota writes reject silently (best-effort).
  useEffect(() => {
    if (!viewer) return;
    if (!isPersistableRun(state)) return;
    const key = currentRunKeyRef.current;
    if (key == null) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const manifest = buildRunManifest(state, Date.now, {
        startedAt: runStartedAt,
        finishedAt: runFinishedAt,
      });
      // 🔴 STILL BEST-EFFORT, DELIBERATELY. A failed save must never interrupt a
      // run the viewer is paying for. What changed is only that a failed READ is
      // no longer allowed to masquerade as an empty history — see `HistoryLoad`.
      storage.set(key, manifest).catch(() => undefined);
      storage.set(ACTIVE_RUN_POINTER_KEY, { key }).catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [state, viewer, storage, runStartedAt, runFinishedAt]);

  // ---- G1 — pull maturity for freshly-completed cells ----
  // The LIVE poll snapshot carries NO nsfwLevel, so a just-finished result is
  // fail-closed BLURRED on a SFW domain until the read-model confirms its
  // maturity. Refetch useAppWorkflows shortly after each new `done` cell so the
  // reconcile effect fills nsfwLevel and a safe image auto-reveals (a mature one
  // stays blurred). Keyed on the done-count so it only fires as results land.
  const doneCount = useMemo(
    () => state.cells.filter((cell) => cell.status === 'done').length,
    [state.cells],
  );
  useEffect(() => {
    if (doneCount === 0 || !viewer) return;
    const handle = setTimeout(() => refetchRef.current(), 400);
    return () => clearTimeout(handle);
  }, [doneCount, viewer]);

  // ---- Actions ----
  const handleGenerateClick = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (over || billable === 0) return; // gated by the cap / empty selection
    // A brand-new run: reset the M4 submit guard + reconcile signature so this
    // build's cells can submit cleanly (and don't inherit a prior run's ids).
    submittedRef.current.clear();
    reconciledSigRef.current = '';
    // Build the matrix and move to the confirm gate (show total + confirm).
    dispatch({ type: 'BUILD', cells: buildMatrix(prompt, chosenCheckpoints, chosenModifiers) });
    // Seed the confirm gate with the build-phase representative estimate (if it
    // landed) so it shows "≈ N" immediately instead of the cap-based "up to M".
    // BUILD resets perCellEstimate to null, so re-apply it here; the first cell's
    // own estimate will refine it during the run. Best-effort: null is fine.
    if (repCellEstimate != null) {
      dispatch({ type: 'SET_PER_CELL_ESTIMATE', estimate: repCellEstimate });
    }
    dispatch({ type: 'REQUEST_CONFIRM' });
  }, [viewer, over, billable, prompt, chosenCheckpoints, chosenModifiers, repCellEstimate, requestSignIn]);

  // Begin a run: mint the storage key it will live under and stamp its start.
  // Both happen HERE rather than at BUILD because a build that is never
  // confirmed spends nothing and is not a matrix anyone should find in history.
  const beginRun = useCallback(() => {
    const at = Date.now();
    // `mintHistoryKey`, not `historyKeyFor`: two runs begun in the same
    // millisecond must not share a row, because the collision is silent — the
    // second manifest overwrites the first and a paid matrix leaves the history.
    currentRunKeyRef.current = mintHistoryKey(at);
    setRunStartedAt(at);
    setRunFinishedAt(null);
    setNowTick(at);
    startedThisSessionRef.current = true;
    setViewingHistory(false);
    dispatch({ type: 'START_RUN' });
  }, []);

  const startRun = useCallback(() => {
    if (!granted) {
      consentPendingRef.current = true;
      dispatch({ type: 'NEEDS_CONSENT' });
      requestConsent({ scopes: ['ai:write:budgeted'] });
      return;
    }
    beginRun();
  }, [granted, requestConsent, beginRun]);

  // Auto-resume the run once consent lands.
  useEffect(() => {
    if (granted && consentPendingRef.current) {
      consentPendingRef.current = false;
      beginRun();
    }
  }, [granted, beginRun]);

  const handleConfirm = useCallback(() => startRun(), [startRun]);

  const handleCancelConfirm = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const handleReset = useCallback(() => {
    pollTokensRef.current.forEach((t) => (t.cancelled = true));
    pollTokensRef.current.clear();
    submittedRef.current.clear();
    reconciledSigRef.current = '';
    // 🔴 CLEAR THE POINTER, NEVER THE RUN. This used to `delete` the run itself,
    // which is why there was no history: "New matrix" destroyed the matrix you
    // had just paid for. Dropping only the pointer means the next mount starts
    // on the build screen, and the run stays listed and reopenable.
    storage.delete(ACTIVE_RUN_POINTER_KEY).catch(() => undefined);
    currentRunKeyRef.current = null;
    startedThisSessionRef.current = false;
    setRunStartedAt(null);
    setRunFinishedAt(null);
    setViewingHistory(false);
    // The run being cleared away should appear in the list it is being cleared to.
    setHistoryNonce((n) => n + 1);
    dispatch({ type: 'RESET' });
  }, [storage]);

  // Reopen a matrix from history — VIEWING AN ARCHIVE, not resuming a run.
  //
  // 🔴 THE DISTINCTION IS THE FIX FOR THREE DEFECTS AT ONCE, and the reason it
  // is spelled out here rather than left implicit:
  //
  //  - `archiveStateFromManifest`, not `restoreStateFromManifest`. The restore
  //    form reports `running` for any run interrupted mid-flight, which on this
  //    screen means: every cell frozen on "Generating…" (nothing re-attaches a
  //    poll loop here, deliberately), an elapsed clock ticking from a start
  //    weeks ago, and "New matrix" withheld because it is gated on
  //    `phase === 'done'` — leaving Stop as the only control, which marks paid
  //    cells `canceled` / "no charge". The archive form forces a terminal view.
  //  - THE ACTIVE-RUN POINTER IS NOT MOVED. Pointing it at an archive made
  //    "which run am I in" a lie that survived a reload: the mount path follows
  //    the pointer but never sets `viewingHistory`, so after a refresh the same
  //    archive came back with `readOnly` undefined and "Retry failed" on it —
  //    one click, no confirm, real Buzz, on a matrix the viewer had treated as
  //    finished weeks ago.
  //  - `currentRunKeyRef` IS CLEARED, NOT SET. It is the persist effect's gate,
  //    and setting it made merely LOOKING at a matrix rewrite its row 250 ms
  //    later. Rows are labelled and ordered by their write time, so opening a
  //    three-week-old matrix relabelled it "just now" and moved it to the top of
  //    the list — a read that edits the thing it read.
  const handleOpenHistory = useCallback(
    async (key: string) => {
      try {
        const raw = await storage.get<unknown>(key);
        const archived = archiveStateFromManifest(raw);
        if (!archived) return;
        const timing = runTimingFromManifest(raw);
        currentRunKeyRef.current = null;
        startedThisSessionRef.current = false;
        setRunStartedAt(timing.startedAt ?? null);
        setRunFinishedAt(timing.finishedAt ?? null);
        setViewingHistory(true);
        for (const cell of archived.cells) {
          if (cell.workflowId != null) submittedRef.current.add(cell.id);
        }
        dispatch({ type: 'RESTORE', state: archived });
      } catch {
        /* best-effort — a failed reopen leaves the build screen as it was */
      }
    },
    [storage],
  );

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
    // Release the M4 guard for the cells about to be re-queued so they CAN run
    // again — without this, the idempotency guard would block their retry. Only
    // failed/insufficient cells re-run (done cells are never touched → never
    // re-charged; RETRY_FAILED enforces that in the reducer).
    for (const cell of state.cells) {
      if (cell.status === 'failed' || cell.status === 'insufficient') {
        submittedRef.current.delete(cell.id);
      }
    }
    dispatch({ type: 'RETRY_FAILED' });
  }, [state.cells]);

  // M2 — re-check a `timedout` cell by re-polling its existing workflow (never a
  // re-submit → never a re-charge). Flip it back to polling + re-attach the loop.
  const handleRecheckTimedout = useCallback((cell: MatrixCell) => {
    if (cell.status !== 'timedout' || cell.workflowId == null) return;
    dispatch({ type: 'RECHECK_TIMEDOUT', id: cell.id });
    runPollLoop(cell.id, cell.workflowId);
  }, [runPollLoop]);

  const handleTopUp = useCallback(() => {
    // Suggest an amount proportionate to the run's actual cost (landed per-cell
    // estimate × cells, with a floor) — not the per-cell SAFETY cap × 10 (LOW-2).
    openPurchaseModal(suggestedTopUpAmount(billable, state.perCellEstimate)).catch(
      () => undefined,
    );
  }, [openPurchaseModal, billable, state.perCellEstimate]);

  // ---- Gallery actions ----

  /** Mark one entry's request in flight (or not), keyed by entry. */
  const setEntryBusy = useCallback((key: string, busy: boolean) => {
    setGalleryBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const setEntryError = useCallback((key: string, message: string | null) => {
    setGalleryErrors((prev) => {
      const next = new Map(prev);
      if (message == null) next.delete(key);
      else next.set(key, message);
      return next;
    });
  }, []);

  /** Replace one loaded entry in place, leaving the rest of the list alone. */
  const patchEntry = useCallback((key: string, patch: Partial<GalleryEntry>) => {
    setGalleryLoad((prev) => {
      if (prev == null || prev.kind !== 'ok') return prev;
      return {
        ...prev,
        entries: prev.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
      };
    });
  }, []);

  /** Write one of the viewer's private key sets. Best-effort, like every write. */
  const persistKeySet = useCallback(
    (storageKey: string, keys: readonly string[]) => {
      storage.set(storageKey, keySetBlob(keys)).catch(() => undefined);
    },
    [storage],
  );

  // 🔴 THE VOTE STATE COMES FROM `viewerVoted`, AND THE NEW STATE COMES FROM THE
  // ACTION — never from a local guess. Guessing "not voted" on load is what
  // produces the "click twice to unvote" bug; guessing the post-click state is
  // the same error one step later, and it survives a failed request.
  const handleToggleVote = useCallback(
    (entry: GalleryEntry) => {
      if (galleryBusyKeys.has(entry.key)) return;
      const wasVoted = entry.viewerVoted;
      setEntryBusy(entry.key, true);
      setEntryError(entry.key, null);
      const request = wasVoted ? shared.unvote(entry.key) : shared.vote(entry.key);
      void request
        .then((count) => {
          patchEntry(entry.key, { count, viewerVoted: !wasVoted });
        })
        .catch((err: unknown) => {
          setEntryError(
            entry.key,
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Your vote could not be saved.',
          );
        })
        .finally(() => setEntryBusy(entry.key, false));
    },
    [shared, galleryBusyKeys, setEntryBusy, setEntryError, patchEntry],
  );

  // 🔴 RE-THROWS. `ReportButton`'s contract is that a rejected `onReport` keeps
  // the control armed rather than settling — swallowing the error here would
  // render "Reported for review" for a report that was never filed.
  const handleReportEntry = useCallback(
    async (entry: GalleryEntry) => {
      await shared.report(entry.key);
      setReportedKeys((prev) => {
        const next = addKeyToSet([...prev], entry.key);
        persistKeySet(REPORTED_KEYS_STORAGE_KEY, next);
        return new Set(next);
      });
    },
    [shared, persistKeySet],
  );

  const handleWithdrawEntry = useCallback(
    (entry: GalleryEntry) => {
      if (galleryBusyKeys.has(entry.key)) return;
      setEntryBusy(entry.key, true);
      setEntryError(entry.key, null);
      void shared
        .withdraw(entry.key)
        .then(() => {
          setGalleryLoad((prev) =>
            prev == null || prev.kind !== 'ok'
              ? prev
              : { ...prev, entries: prev.entries.filter((e) => e.key !== entry.key) },
          );
          setOwnKeys((prev) => {
            const next = [...prev].filter((k) => k !== entry.key);
            persistKeySet(PUBLISHED_KEYS_STORAGE_KEY, next);
            return new Set(next);
          });
        })
        .catch((err: unknown) => {
          setEntryError(
            entry.key,
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'This entry could not be removed.',
          );
        })
        .finally(() => setEntryBusy(entry.key, false));
    },
    [shared, galleryBusyKeys, setEntryBusy, setEntryError, persistKeySet],
  );

  // The cells of the open matrix that can be published: `done`, with a
  // workflowId the host can re-derive ownership from.
  const publishPlan = useMemo(() => publishableCells(state.cells), [state.cells]);
  const publishedIndex = useMemo(() => indexPublishedCells(publishedCells), [publishedCells]);
  // What a click would actually publish: the cells NOT already in the gallery.
  const publishRemaining = useMemo(
    () => unpublishedCells(publishPlan, publishedIndex),
    [publishPlan, publishedIndex],
  );
  const alreadyPublishedCount = publishPlan.length - publishRemaining.length;
  const alreadyPublished = publishPlan.length > 0 && publishRemaining.length === 0;
  // The row this matrix's earlier cells landed in, so a later publish EXTENDS it
  // rather than minting a second entry for one grid.
  const publishTarget = useMemo(
    () => publishTargetKey(publishPlan, publishedIndex),
    [publishPlan, publishedIndex],
  );
  // The title offered until the author edits it. Derived from the run's own
  // shared prompt, so it describes the matrix on screen rather than the form.
  const suggestedPublishTitle = defaultGalleryTitle(sharedPromptFromCells(state.cells));
  const effectivePublishTitle = publishTitleTouched ? publishTitle : suggestedPublishTitle;

  // 🔴 THE SDK'S OWN DOC-COMMENT IS INCOMPLETE ABOUT WHY THIS REJECTS, AND AN
  // AUDIT ALREADY GOT IT WRONG FROM THE CLIENT TYPES. `usePublishGenerationOutputs`
  // enumerates its rejection causes as "anon viewer / missing scope / not-owned
  // workflow / rate-limit / upload or scan failure" and OMITS the cohort gate
  // entirely — and `assertViewerIsAppDeveloper` appears in the vendored `.d.ts`
  // only on inline `customComfy` submission, so reading the client types alone
  // yields the confident, wrong conclusion that publishing is open to everyone.
  //
  // The server is the authority, and it gates: civitai/civitai
  // `src/server/routers/blocks.router.ts:3604` declares `publishGenerationOutputs`
  // a `publicProcedure`, then `:3631` runs `assertAppBlocksEnabledForTokenUser`
  // and `:3632` runs `assertViewerIsAppDeveloper(userId)` — BEFORE any image is
  // created. So the cohort note in `PublishMatrixPanel` is true, and an ordinary
  // viewer clicking Publish creates nothing.
  //
  // Do not re-derive "there is no cohort gate" from the client's declarations.
  const handlePublish = useCallback(() => {
    if (publishPhase.kind === 'busy') return;
    // Belt for the disabled button: a duplicate publish is unrecoverable.
    if (publishRemaining.length === 0) return;
    setPublishMessage(null);
    setPublishProblem(false);
    setPublishPhase({ kind: 'busy', done: 0, total: publishRemaining.length });
    // 🔴 THE KEY, NOT A SNAPSHOT. `publishMatrix` re-reads the row through
    // `shared.get` immediately before merging — see `PublishDeps.getEntry`.
    // Resolving it here from the loaded 12-row page silently appended a second
    // row whenever the matrix's entry was off-page, or the gallery read had
    // failed, or it had not resolved yet; and even when found, the snapshot
    // could be stale enough to drop another tab's image out of the entry.
    void publishMatrix(
      publishRemaining,
      {
        // Every user-visible string goes in the MODERATED fields. `data` carries
        // ids and grid coordinates only — see gallery.ts.
        title: normalizeGalleryTitle(effectivePublishTitle),
        ...(composeGalleryBody(sharedPromptFromCells(state.cells)) !== undefined
          ? { body: composeGalleryBody(sharedPromptFromCells(state.cells)) }
          : {}),
      },
      {
        publish,
        append: (value) => shared.append(value),
        update: (key, value) => shared.update(key, value),
        // The authoritative single-row read. Its own contract covers exactly this
        // case — an item past the first page — and it returns `null` for a
        // withdrawn or moderated row, which is the one case where appending a
        // fresh entry is right.
        getEntry: async (key) => {
          const item = await shared.get(key);
          return item == null
            ? null
            : {
                title: item.value.title,
                ...(item.value.body !== undefined ? { body: item.value.body } : {}),
                data: item.value.data,
              };
        },
      },
      (done, total) => setPublishPhase({ kind: 'busy', done, total }),
      publishTarget,
    )
      .then((result) => {
        setPublishMessage(publishResultMessage(result));
        setPublishProblem(result.kind !== 'ok');
        // 🔴 `orphaned` IS INCLUDED, AND THAT IS THE POINT. Its images were
        // created — they are permanent public Civitai rows — even though the
        // entry write failed. Recording only the successes left the control
        // enabled over a cell that had already cost the viewer an irreversible
        // act, so a second click made a second permanent image of it. The
        // ledger's question is "did this already cost something irreversible",
        // never "did the operation succeed".
        if (result.kind === 'ok' || result.kind === 'partial' || result.kind === 'orphaned') {
          // Record the minted key as OURS, in the viewer's private storage — the
          // same-session supplement to the host-stamped `authorUserId` check.
          // An orphaned result has no entry, so there is nothing to own.
          if (result.kind !== 'orphaned') {
            const ownedKey = result.key;
            setOwnKeys((prev) => {
              const next = addKeyToSet([...prev], ownedKey);
              persistKeySet(PUBLISHED_KEYS_STORAGE_KEY, next);
              return new Set(next);
            });
          }
          // 🔴 Record EVERY cell that landed, durably. Disarming on a
          // session-held signature of the whole set re-armed on a retry (the set
          // grew) and on a reload (the Set was gone) — both republishing images
          // that already existed, permanently and with no un-publish.
          //
          // The result carries the actual `(cell, workflowId, imageId)` triples,
          // so both halves of the ledger key come from the same object the
          // publish used — no `?? ''` fallback that could mint a key which never
          // matches. An orphaned result has no entry key; `''` is rejected by
          // `parsePublishedCells`, so it is recorded against a sentinel that says
          // what it is and can never resolve as a target to extend.
          const entryKey = result.kind === 'orphaned' ? ORPHANED_ENTRY_KEY : result.key;
          const landedCells = result.landed.map((item) => ({
            cell: cellPublishKey(item.cell.id, item.workflowId),
            imageId: item.imageId,
            entryKey,
          }));
          setPublishedCells((prev) => {
            const next = addPublishedCells(prev, landedCells);
            storage.set(PUBLISHED_CELLS_STORAGE_KEY, publishedCellsBlob(next)).catch(
              () => undefined,
            );
            return next;
          });
          setPublishTitle('');
          setPublishTitleTouched(false);
          setGalleryNonce((n) => n + 1);
        }
      })
      .catch((err: unknown) => {
        // `publishMatrix` maps every host failure to a result, so reaching here
        // means something unexpected threw — still say so rather than sit silent.
        setPublishMessage(
          err instanceof Error && err.message.length > 0
            ? `Nothing was published. ${err.message}`
            : 'Nothing was published.',
        );
        setPublishProblem(true);
      })
      .finally(() => setPublishPhase({ kind: 'idle' }));
  }, [
    publishPhase.kind,
    publishRemaining,
    publishTarget,
    galleryLoad,
    effectivePublishTitle,
    state.cells,
    publish,
    shared,
    storage,
    persistKeySet,
  ]);

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
  // The confirm gate HEADLINES the real per-kind "≈ N" once estimates have landed
  // (surviving the multi-LoRA compare case); until then it is a cap-based maximum,
  // surfaced as "up to N" with the ceiling demoted to a "safety max" hint.
  const confirmLabel = matrixTotalLabel(state.cells, buildKindEstimates);
  const anyInsufficient = state.cells.some((cell) => cell.status === 'insufficient');
  // Change 3 — the SHARED prompt, recovered from the run's OWN cells.
  // 🔴 Never `prompt` (the live textarea). A restored run's form has reset to
  // empty, so reading current form state would caption someone's paid matrix
  // with a prompt they did not run — usually a blank one.
  const runSharedPrompt = sharedPromptFromCells(state.cells);
  // Change 5 — elapsed, from the run's own stamps.
  // `startedThisSession` is what separates a clock we can vouch for from one
  // measured against a start we only read out of storage — see runElapsedLabel.
  const runElapsed = runElapsedLabel(
    { startedAt: runStartedAt, finishedAt: runFinishedAt },
    state.phase === 'running',
    nowTick,
    { startedThisSession: startedThisSessionRef.current },
  );
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
          {/* The concept example now covers ONLY the state where there is no
              shape to draw. With a selection, BuildPanel renders the real grid
              instead — so the explainer appears exactly when an explainer is
              useful, and the screen never carries a fixed "4 cells" alongside a
              live count that says something else. This is the live-state stand-in
              for "first run": it needs no persisted flag, which matters because
              the per-viewer KV that would hold one is gated to mods +
              app-dev-testers. */}
          {inBuild && billable === 0 && <MatrixConceptExample c={c} />}
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
            chosenCheckpoints={chosenCheckpoints}
            chosenModifiers={chosenModifiers}
            loraModifiers={selectedLoraModifiers}
            setLoraStrength={setLoraStrength}
            onPickLora={handlePickLora}
            onPickCheckpoint={handlePickCheckpoint}
            onBrowseLora={() => openBrowse('LORA')}
            onBrowseCheckpoint={() => openBrowse('Checkpoint')}
            onGenerate={handleGenerateClick}
          />
        )}

        {inBuild && (
          <HistoryPanel c={c} load={history} now={nowTick} onOpen={handleOpenHistory} />
        )}

        {/* Browsing the gallery is NOT behind the publish cohort gate, and not
            behind sign-in either — an anonymous viewer reads it, and simply
            cannot vote, report or withdraw. */}
        {inBuild && (
          <GalleryPanel
            c={c}
            load={galleryLoad}
            images={galleryImages}
            maturityGate={maturityGate}
            signedIn={!anon}
            viewerUserId={viewerUserId}
            ownKeys={ownKeys}
            reportedKeys={reportedKeys}
            busyKeys={galleryBusyKeys}
            actionErrors={galleryErrors}
            onToggleVote={handleToggleVote}
            onReport={handleReportEntry}
            onWithdraw={handleWithdrawEntry}
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
            checkpoints={gridCheckpoints}
            modifiers={gridModifiers}
            phase={state.phase}
            canRetry={canRetry}
            maturityGate={maturityGate}
            sharedPrompt={runSharedPrompt}
            elapsed={runElapsed}
            readOnly={viewingHistory}
            onReset={() => setConfirmReset(true)}
            onStop={handleStop}
            onRetry={handleRetryFailed}
            onRecheck={handleRecheckTimedout}
            onEnlarge={(cell) =>
              cell.imageUrl &&
              setLightbox({
                src: cell.imageUrl,
                alt: `${cell.checkpoint.label} · ${cell.modifier.label}`,
                nsfwLevel: cell.nsfwLevel,
                // The EFFECTIVE prompt — shared + this column's style suffix.
                // Taken off the cell, so it is the string that actually produced
                // this image rather than a recomposition from current state.
                prompt: cell.prompt,
              })
            }
          />
        )}

        {/* Offered on a FINISHED matrix with something to publish — including one
            reopened from history, which is equally publishable: publishing does
            not re-run anything, so `readOnly` does not apply. */}
        {showGrid && state.phase === 'done' && publishPlan.length > 0 && (
          <PublishMatrixPanel
            c={c}
            publishable={publishRemaining.length}
            alreadyPublishedCount={alreadyPublishedCount}
            title={effectivePublishTitle}
            setTitle={(value) => {
              setPublishTitleTouched(true);
              setPublishTitle(value);
            }}
            phase={publishPhase}
            message={publishMessage}
            messageIsProblem={publishProblem}
            signedIn={!anon}
            alreadyPublished={alreadyPublished}
            onPublish={handlePublish}
          />
        )}

        {confirmReset && (
          <ResetConfirmDialog
            c={c}
            onConfirm={() => {
              setConfirmReset(false);
              handleReset();
            }}
            onCancel={() => setConfirmReset(false)}
          />
        )}

        {lightbox && (
          <Lightbox
            c={c}
            src={lightbox.src}
            alt={lightbox.alt}
            nsfwLevel={lightbox.nsfwLevel}
            prompt={lightbox.prompt}
            gate={maturityGate}
            onClose={() => setLightbox(null)}
            onCopied={() =>
              toastRef.current?.show({ message: 'Image URL copied', color: 'success' })
            }
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

export function BuildPanel(props: {
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
  /**
   * The SELECTED axes, in the same order `buildMatrix` assigns row/col — passed
   * down rather than re-derived here so the preview and the count cannot drift
   * apart. REQUIRED on purpose: optional, a missed wiring would render no
   * preview at all with every test still green, which is the "declared but
   * nothing reads it" failure.
   */
  chosenCheckpoints: CheckpointOption[];
  chosenModifiers: ModifierOption[];
  /** Selected LoRA columns whose strength the Slider can tune (STEP 2). */
  loraModifiers: ModifierOption[];
  setLoraStrength: (key: string, value: number) => void;
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
    chosenCheckpoints,
    chosenModifiers,
    loraModifiers,
    setLoraStrength,
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
        <legend style={legendStyle}>Models (checkpoints)</legend>
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
        {loraModifiers.length > 0 && (
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }} data-testid="gm-lora-strengths">
            {loraModifiers.map((m) => {
              const strength = m.loraStrength ?? DEFAULT_LORA_STRENGTH;
              return (
                <Slider
                  key={m.key}
                  data-testid={`gm-lora-strength-${m.key}`}
                  label={`${m.label} strength`}
                  min={LORA_STRENGTH_MIN}
                  max={LORA_STRENGTH_MAX}
                  step={0.1}
                  value={strength}
                  valueLabel={strength.toFixed(1)}
                  onChange={(e) => setLoraStrength(m.key, Number(e.currentTarget.value))}
                />
              );
            })}
          </div>
        )}
      </fieldset>

      {/* The shape you are about to buy, immediately above the count and the
          cost of buying it. Withheld at 0 cells: an empty table is not a
          preview, and the header's concept example covers that state. */}
      {billable > 0 && (
        <MatrixShapePreview c={c} checkpoints={chosenCheckpoints} modifiers={chosenModifiers} />
      )}

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
        {previewLabel.isCeiling ? (
          <span style={{ opacity: 0.7 }}> max — real cost is usually far less</span>
        ) : (
          // The "≈" real estimate is the headline; the cap-based ceiling is
          // demoted to a small "safety max" hint (never the anchor). I3.
          <Tooltip
            label={`Safety max ${previewLabel.ceilingAmount} Buzz — the per-cell safety cap × cells. Real cost is usually far less.`}
          >
            <span
              tabIndex={0}
              data-testid="gm-safety-max"
              style={{ opacity: 0.7, marginLeft: 6, cursor: 'help', fontSize: 12 }}
            >
              safety max {previewLabel.ceilingAmount}
            </span>
          </Tooltip>
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

export function ConfirmPanel(props: {
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
            : ` Safety max ${label.ceilingAmount} Buzz total.`}{' '}
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
// Enlarge lightbox + copy-image-URL (the only sandbox-legal "keep" path)
// ---------------------------------------------------------------------------

/**
 * Copy a URL to the clipboard from inside the opaque-origin sandboxed iframe.
 * Prefers the async Clipboard API; falls back to a hidden-textarea +
 * `document.execCommand('copy')` because the async API can be unavailable in an
 * `allow-scripts`-only iframe. A real file download is a host-bridge capability
 * (out of scope) — copying the URL is the sandbox-legal "keep" action. Returns
 * whether the copy succeeded.
 */
export async function copyImageUrl(url: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    /* fall through to the execCommand fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Per-cell enlarge lightbox (I1): shows the FULL paid output UNCROPPED (the grid
 * thumbnail force-crops to a square) + a copy-image-URL action. A real modal
 * (focus trap / Escape / restore via useModalA11y). The image renders through
 * the SAME `MaturityImage` gate (fail-closed blur preserved) with `crop={false}`.
 */
export function Lightbox({
  c,
  src,
  alt,
  nsfwLevel,
  prompt,
  gate,
  onClose,
  onCopied,
}: {
  c: Palette;
  src: string;
  alt: string;
  nsfwLevel: number | null | undefined;
  /**
   * The EFFECTIVE prompt for this one cell — the shared prompt plus the column's
   * style suffix, i.e. the exact string that produced the image on screen.
   *
   * 🔴 THIS IS PER-CELL AND THE HEADER'S IS NOT. Showing the shared prompt here
   * would be wrong in the way that matters most: the enlarged view is where
   * someone decides which model/style combination they want, so it has to say
   * what THIS cell actually asked for, suffix included. Optional so the existing
   * call sites and tests that predate it still compile.
   */
  prompt?: string;
  gate: MaturityGate;
  onClose: () => void;
  onCopied: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, true, onClose);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const handleCopy = useCallback(async () => {
    const ok = await copyImageUrl(src);
    if (!ok) return;
    setCopied(true);
    onCopied();
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1600);
  }, [src, onCopied]);

  return (
    <div
      className="gm-backdrop"
      style={backdropStyle()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="gm-lightbox-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Enlarged image: ${alt}`}
        className="gm-dialog-enter"
        style={lightboxBox(c)}
        data-testid="gm-lightbox"
      >
        <MaturityImage src={src} alt={alt} nsfwLevel={nsfwLevel} gate={gate} crop={false} />
        {prompt != null && prompt.trim().length > 0 && (
          <p
            style={{ ...noteStyle(c), margin: 0, display: 'block' }}
            data-testid="gm-lightbox-prompt"
          >
            <span style={{ fontWeight: 700, color: c.fg }}>Prompt: </span>
            {prompt}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleCopy}
            style={primaryBtn(c)}
            className="gm-chip"
            data-autofocus
            data-testid="gm-copy-url"
          >
            {copied ? 'Copied!' : 'Copy image URL'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={secondaryBtn(c)}
            className="gm-chip"
            data-testid="gm-lightbox-close"
          >
            Close
          </button>
        </div>
        {/* The raw URL is shown so it can be selected/copied by hand if the
            clipboard write is blocked by the sandbox. */}
        <p
          style={{ ...noteStyle(c), margin: 0, wordBreak: 'break-all' }}
          data-testid="gm-lightbox-url"
        >
          {src}
        </p>
      </div>
    </div>
  );
}

/**
 * "New matrix" confirm gate (I2): `handleReset` deletes the paid run, so require
 * an explicit confirm first. A real modal (useModalA11y).
 */
export function ResetConfirmDialog({
  c,
  onConfirm,
  onCancel,
}: {
  c: Palette;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, true, onCancel);
  return (
    <div
      className="gm-backdrop"
      style={backdropStyle()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      data-testid="gm-reset-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gm-reset-title"
        aria-describedby="gm-reset-desc"
        className="gm-dialog-enter"
        style={confirmBox(c)}
      >
        <p id="gm-reset-title" style={{ margin: 0, fontSize: 15 }}>
          Start a new matrix?
        </p>
        <p id="gm-reset-desc" style={noteStyle(c)}>
          Your current results will be cleared.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onConfirm}
            style={primaryBtn(c)}
            className="gm-chip"
            data-autofocus
            data-testid="gm-reset-confirm"
          >
            Start new matrix
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={secondaryBtn(c)}
            className="gm-chip"
            data-testid="gm-reset-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History — the list of matrices this viewer has already generated
// ---------------------------------------------------------------------------

/**
 * The viewer's past matrices, on the configure screen.
 *
 * 🔴 FOUR STATES, AND THREE OF THEM MUST NOT LOOK ALIKE:
 *
 *  - `null` (not read yet) renders NOTHING. Before the read resolves we know
 *    neither that they have matrices nor that they have none, so any output
 *    here is a guess that flashes and then contradicts itself.
 *  - `error` says the READ failed. It is not "you have no matrices" — that is a
 *    claim about their data, and making it when we simply could not look tells
 *    someone their paid work is gone while it sits safe in storage.
 *  - `ok` + zero entries is the honest empty state, and it is also what an
 *    ANONYMOUS viewer gets: `list` resolves empty for them rather than
 *    rejecting, so signed-out is an ordinary empty list, never an error.
 *  - `ok` + entries is the list.
 */
export function HistoryPanel({
  c,
  load,
  now,
  onOpen,
}: {
  c: Palette;
  load: HistoryLoad | null;
  now: number;
  onOpen: (key: string) => void;
}) {
  if (load == null) return null;

  if (load.kind === 'error') {
    return (
      <p style={{ ...noteStyle(c), margin: 0 }} role="status" data-testid="gm-history-error">
        We couldn&rsquo;t load your past matrices just now. They&rsquo;re still saved — reload to
        try again.
      </p>
    );
  }

  if (load.entries.length === 0) {
    return (
      <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-history-empty">
        No past matrices yet. Generate one and it will show up here.
      </p>
    );
  }

  return (
    <section style={{ display: 'grid', gap: 6 }} data-testid="gm-history">
      <h2 style={{ fontSize: 14, margin: 0, fontWeight: 700 }}>Your past matrices</h2>
      <ul
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}
        data-testid="gm-history-list"
      >
        {load.entries.map((entry) => (
          <li key={entry.key} data-testid="gm-history-item">
            <button
              type="button"
              onClick={() => onOpen(entry.key)}
              style={secondaryBtn(c)}
              className="gm-chip"
              data-testid="gm-history-open"
            >
              Open matrix from {historyAgeLabel(entry.updatedAt, now)}
            </button>
          </li>
        ))}
      </ul>
      {/* 🔴 RENDERED ONLY WHEN THE CAP ACTUALLY BINDS. `loadHistory` fetches one
          row beyond the cap purely so this can be true or false honestly; a
          notice that shows unconditionally would tell a viewer with three
          matrices that some are being withheld.

          It names the RETENTION cap as well, because the list being shorter than
          your history and your history being shorter than everything you ever
          ran are two different truncations. Storage keeps HISTORY_RETENTION_CAP
          runs and drops the rest (see `evictBeyondRetention`); saying only "12
          most recent" would leave a viewer believing the 30th matrix is still
          somewhere behind this list. */}
      {load.truncated && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-history-truncated">
          Showing your {HISTORY_LIST_CAP} most recent matrices. We keep your last{' '}
          {HISTORY_RETENTION_CAP}.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result grid — rows=checkpoints, cols=modifiers
// ---------------------------------------------------------------------------

export function ResultGrid(props: {
  c: Palette;
  cells: MatrixCell[];
  checkpoints: CheckpointOption[];
  modifiers: ModifierOption[];
  phase: string;
  canRetry: boolean;
  maturityGate: MaturityGate;
  /**
   * The run's SHARED prompt (change 3), or null when it cannot be recovered.
   * Null renders no prompt line at all — never an empty one, which would read as
   * "you ran a blank prompt".
   */
  sharedPrompt?: string | null;
  /** Elapsed time (change 5), or null when unknown. Null renders nothing. */
  elapsed?: string | null;
  /** True for a matrix reopened from history: already paid, already finished. */
  readOnly?: boolean;
  onReset: () => void;
  onStop: () => void;
  onRetry: () => void;
  onRecheck: (cell: MatrixCell) => void;
  onEnlarge: (cell: MatrixCell) => void;
}) {
  const { c, cells, checkpoints, modifiers, phase, canRetry, maturityGate, sharedPrompt, elapsed, readOnly, onReset, onStop, onRetry, onRecheck, onEnlarge } =
    props;
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }} role="status">
            {running ? runProgressLabel(cells) : 'Done'} · spent {formatCost(spent)} Buzz
          </span>
          {/* 🔴 OUTSIDE the role="status" region on purpose. The elapsed label
              re-renders every second while a run is in progress; inside a live
              region that is a screen reader announcing the clock once a second,
              drowning out the progress it is meant to accompany. */}
          {elapsed != null && (
            <span style={{ fontSize: 13, color: c.muted }} data-testid="gm-elapsed">
              · {elapsed}
            </span>
          )}
        </div>
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
          {phase === 'done' && canRetry && !readOnly && (
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

      {/* Change 3 — the shared prompt this whole grid was generated from. Comes
          from the run's own cells, so a matrix reopened after a reload shows the
          prompt that produced it rather than whatever is in the form now. */}
      {sharedPrompt != null && sharedPrompt.trim().length > 0 && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-run-prompt">
          <span style={{ fontWeight: 700, color: c.fg }}>Prompt: </span>
          {sharedPrompt}
        </p>
      )}

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
                        <CellView c={c} cell={cell} maturityGate={maturityGate} readOnly={readOnly} onRecheck={onRecheck} onEnlarge={onEnlarge} />
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

/**
 * The height reserved for a cell's caption row, in px, in EVERY status.
 *
 * Exported so a test can assert the reservation rather than re-typing the
 * number — a duplicated literal would let the shell and its guard drift apart.
 */
export const CELL_CAPTION_HEIGHT = 16;

/**
 * The class every `Tooltip` INSIDE a cell must carry.
 *
 * 🔴 A TOOLTIP WAS SILENTLY SHRINKING THE CELL IT WRAPPED, AND THE SHELL COULD
 * NOT SEE IT. `CellShell` reserves the caption row so a cell's height is a
 * function of its WIDTH — the media row is an `aspect-ratio: 1 / 1` square. That
 * holds only while the square actually gets the column's width. The design-system
 * `Tooltip` renders its trigger inside an `inline-flex` wrapper, and an
 * inline-level box shrink-wraps to its content instead of stretching to its
 * containing block: measured in Chromium at a 136px column, the `blocked` cell's
 * wrapper came back **86px** wide, so its square was 86px and the whole cell was
 * **106px tall against every other status's 156px**. The `failed` cell uses the
 * same Tooltip and happened to measure 136 only because its label's max-content
 * width already exceeded the column — an accident of copy length, not a
 * property, which is why this is a shared class rather than a fix at one site.
 *
 * The rule lives in `index.css` (`display: block`), which is UNLAYERED and
 * therefore beats the component library's `@layer civitai.components` regardless
 * of injection order. `position: relative` survives, so the bubble still anchors
 * to the wrapper.
 *
 * ⚠️ Setting `aspect-ratio` on the inner span does NOT fix this — verified in a
 * real engine, the height stayed 106. The WIDTH is what is wrong.
 *
 * 🔴 NOT TEST-ENFORCED AS A HEIGHT. jsdom performs no layout, so this suite
 * cannot assert 156 === 156; `cellShell.test.tsx` pins the class and the CSS rule
 * that produce it, which is the strongest claim this harness supports.
 */
export const CELL_TOOLTIP_CLASS = 'gm-cell-tooltip';

/**
 * The one shell every cell renders through, whatever its status.
 *
 * 🔴 THIS IS THE LAYOUT-SHIFT FIX. Before it, an in-flight cell was a bare
 * square (`SkeletonCell`, `aspectRatio: 1/1`) and a finished one was that square
 * PLUS a `<figcaption>` carrying the Buzz cost. The caption's height was
 * reserved nowhere, so every cell that completed grew taller than its
 * neighbours and shoved its whole row down — during a run, which is exactly when
 * the viewer is watching the grid and trying to compare cells. With nine cells
 * landing at different times that is nine separate jumps.
 *
 * The fix is to reserve the caption's row in every status rather than to delete
 * the caption: the per-cell cost is the app's core money disclosure and removing
 * it would trade a layout bug for a transparency one. A fixed second row means
 * the shell's height is a function of the cell's WIDTH alone (the media row is a
 * square), so it is identical across statuses by construction.
 */
function CellShell({
  c,
  caption,
  children,
}: {
  c: Palette;
  /** The caption's content, or null/undefined for a status that has none. */
  caption?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <figure
      data-testid="gm-cell-shell"
      style={{
        margin: 0,
        display: 'grid',
        gridTemplateRows: `1fr ${CELL_CAPTION_HEIGHT}px`,
        gap: 4,
      }}
    >
      <div style={{ minWidth: 0 }}>{children}</div>
      {/* Present and EMPTY until the cell is done — the slot is the reservation.
          Rendering it conditionally would put the shift straight back. */}
      <figcaption
        data-testid="gm-cell-caption"
        style={{
          height: CELL_CAPTION_HEIGHT,
          lineHeight: `${CELL_CAPTION_HEIGHT}px`,
          fontSize: 11,
          color: c.muted,
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        {caption}
      </figcaption>
    </figure>
  );
}

export function CellView({
  c,
  cell,
  maturityGate,
  readOnly,
  onRecheck,
  onEnlarge,
}: {
  c: Palette;
  cell: MatrixCell | undefined;
  maturityGate: MaturityGate;
  /** True for a matrix reopened from history — see `cellContent`'s timedout arm. */
  readOnly?: boolean;
  onRecheck: (cell: MatrixCell) => void;
  onEnlarge: (cell: MatrixCell) => void;
}) {
  const { body, caption } = cellContent({ c, cell, maturityGate, readOnly, onRecheck, onEnlarge });
  return (
    <CellShell c={c} caption={caption}>
      {body}
    </CellShell>
  );
}

/**
 * The per-status content of a cell: what goes in the media row, and what (if
 * anything) goes in the caption row. Split out from `CellView` so that the
 * shell wrapping it is applied in exactly ONE place — a `switch` that returned
 * a fully-formed element per branch is how the missing caption reservation got
 * in, and it would let the next status skip the shell just as quietly.
 */
function cellContent({
  c,
  cell,
  maturityGate,
  readOnly,
  onRecheck,
  onEnlarge,
}: {
  c: Palette;
  cell: MatrixCell | undefined;
  maturityGate: MaturityGate;
  readOnly?: boolean;
  onRecheck: (cell: MatrixCell) => void;
  onEnlarge: (cell: MatrixCell) => void;
}): { body: React.ReactNode; caption?: React.ReactNode } {
  if (!cell) return { body: <CellBox c={c} label="—" tone="muted" /> };
  switch (cell.status) {
    case 'blocked': {
      // Give the muted "Incompatible" chip a reason (I5) — WHY it's blocked and
      // what to change — in a design-system Tooltip so the cell isn't a dead end.
      const reason = incompatibleCellReason(cell);
      return {
        body: (
          <Tooltip label={reason} className={CELL_TOOLTIP_CLASS}>
            <span tabIndex={0} data-testid="gm-incompatible-detail" style={{ display: 'block' }}>
              <CellBox c={c} label="Incompatible" sub="no charge" tone="muted" />
            </span>
          </Tooltip>
        ),
      };
    }
    case 'canceled':
      return { body: <CellBox c={c} label="Canceled" sub="no charge" tone="muted" /> };
    case 'idle':
      return { body: <CellBox c={c} label="Queued" tone="muted" /> };
    // The in-flight states render an animated shimmer skeleton with the small
    // status label on top (D4.2), instead of a static text box.
    // estimating / submitting with no workflowId yet can't be cleanly canceled
    // by Stop (it may still complete + charge) — label it honestly so the user
    // can distinguish it from a cleanly-canceled cell.
    case 'estimating':
      return {
        body: (
          <SkeletonCell
            c={c}
            label={isUncancelableInFlight(cell) ? 'Submitting (may charge)…' : 'Estimating…'}
          />
        ),
      };
    case 'submitting':
      return {
        body: (
          <SkeletonCell
            c={c}
            label={isUncancelableInFlight(cell) ? 'Submitting (may charge)…' : 'Submitting…'}
          />
        ),
      };
    case 'polling':
      return { body: <SkeletonCell c={c} label="Generating…" /> };
    case 'insufficient':
      return { body: <CellBox c={c} label="Out of Buzz" sub="top up & retry" tone="danger" /> };
    case 'timedout':
      // Polling gave up; the gen may still finish + bill — so it's a muted
      // "still working" state, never a failure and never "no charge". M2: a
      // Re-check re-polls the SAME workflow (no re-submit → no re-charge).
      // 🔴 NO Re-check ON AN ARCHIVE. `RECHECK_TIMEDOUT` puts the whole run back
      // into `phase: 'running'`, which is the exact state a reopened matrix is
      // forced out of — it would restore the Stop-only screen this fix removes.
      // The label stays; only the re-entry into a live run is withheld.
      return {
        body: (
          <CellBox c={c} label={timedOutCellLabel()} sub="may still finish" tone="muted">
            {!readOnly && <button
              type="button"
              onClick={() => onRecheck(cell)}
              className="gm-chip"
              data-testid="gm-recheck"
              style={{
                marginTop: 4,
                padding: '3px 10px',
                borderRadius: 999,
                border: `1px solid ${c.accent}`,
                background: 'transparent',
                color: c.accent,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Re-check
            </button>}
          </CellBox>
        ),
      };
    case 'failed': {
      // Friendly label; keep the raw server detail in a design-system Tooltip so
      // it's never lost — just demoted from the primary label (STEP 2).
      const detail = failedCellDetail(cell.error);
      const box = <CellBox c={c} label={failedCellLabel()} tone="danger" />;
      return {
        body: detail ? (
          <Tooltip label={detail} className={CELL_TOOLTIP_CLASS}>
            <span tabIndex={0} data-testid="gm-failed-detail" style={{ display: 'block' }}>
              {box}
            </span>
          </Tooltip>
        ) : (
          box
        ),
      };
    }
    case 'done':
      return {
        body: cell.imageUrl ? (
          <MaturityImage
            src={cell.imageUrl}
            alt={`${cell.checkpoint.label} · ${cell.modifier.label}`}
            nsfwLevel={cell.nsfwLevel}
            gate={maturityGate}
            onEnlarge={() => onEnlarge(cell)}
            fallback={<span style={{ fontSize: 12, color: c.muted }}>Image unavailable</span>}
          />
        ) : (
          // A `done` cell with no imageUrl: the gen succeeded + was charged but
          // the snapshot carried no image — show an explicit, non-blank state.
          <CellBox c={c} label="Image unavailable" sub="generated · charged" tone="muted" />
        ),
        caption: `${formatCost(cell.cost)} Buzz`,
      };
  }
}

// The result image now renders through `MaturityImage` (G1), which wraps the
// design-system `<Image>` primitive — it owns the decode fade, the load-error
// fallback (a paid `done` cell is never left blank), AND the maturity gate. The
// old hand-rolled `CellImage` was replaced by it (STEP 2 primitive adoption).

/** An animated shimmer skeleton with a status label on top (D4.2). */
export function SkeletonCell({ c, label }: { c: Palette; label: string }) {
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
  children,
}: {
  c: Palette;
  label: string;
  sub?: string;
  tone: 'muted' | 'busy' | 'danger';
  /** Optional native tooltip — legacy detail hint on a cell. */
  title?: string;
  /** Optional extra content (e.g. the timedout Re-check button). */
  children?: React.ReactNode;
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
      {children}
    </div>
  );
}

export function Chip({
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
 * docs-like paragraph. Dots are aria-hidden; the text beside them is the label.
 *
 * 🔴 THE NUMBERS HERE ARE A FIXED EXAMPLE, NOT A READOUT — and saying so in the
 * VISIBLE text is the whole point of this component's shape. It renders directly
 * above BuildPanel's live counter, which says the real thing ("N of 12 cells"),
 * and the example's own "2 models × 2 styles = 4 cells" is hardcoded. Measured
 * live on 0.8.6 at the default selection, the screen showed THREE different cell
 * counts at once — this band's 4, the counter's "2 of 12", and the button's
 * "· 2 cells" — because the example reuses the same "2" the live selection had
 * and nothing on screen marked it as illustrative.
 *
 * 🔴 IT USED TO BE MARKED, IN A PLACE NOBODY COULD READ IT. The marker lived in
 * an `aria-label="Example: …"` on this bare `<div>` — which has no role, so the
 * label is not reliably exposed by AT at all, AND it made the accessible name
 * disagree with the visible text. That is why the a11y sweep reads 0 violations
 * on this screen: every axe check (interactive-name, img-alt, control-label,
 * heading-order) passes on a non-interactive div with a name. The label was
 * removed rather than fixed: with "Example" in the visible text the element
 * describes itself, and the a11y tree and the screen now say the SAME thing,
 * which is the property worth having.
 *
 * 🔴 RENAMED FROM `FirstRunExample`, WHICH WAS FALSE. Its call site is
 * `{inBuild && …}` — the build phase, which you re-enter via "New run" — so it
 * renders on EVERY visit to the configure screen, not once. It cannot be made
 * genuinely first-run either: remembering a dismissal needs `useAppStorage`, and
 * that surface is reachable only by mods + app-dev-testers
 * (`assertViewerIsAppDeveloper` on the apps.router storage procedures), so for an
 * ordinary viewer the flag could never be read back.
 */
/**
 * The grid you are ABOUT to generate, drawn before you spend — same table shape
 * as `ResultGrid`, same axis headers, empty cells.
 *
 * 🔴 WHY THIS EXISTS: THE APP IS NAMED FOR A MATRIX AND NEVER SHOWED ONE. The
 * two axes render as two stacked chip rows, which do not read as a grid, and the
 * only grid on the configure screen was the 2x2 dot glyph inside
 * {@link MatrixConceptExample} — an explainer standing in for the layout, which
 * is the classic tell that the layout failed. Drawing the real shape is what
 * lets that explainer retire to the empty state where it belongs.
 *
 * 🔴 IT COMPUTES NOTHING. `App` already builds `previewCells` on every render
 * (it is what feeds the "N of 12 cells" counter, the cap gate and the estimate);
 * this only draws the axes it is handed. So the preview and the counter cannot
 * disagree — they are the same selection — which is the property the hardcoded
 * concept band did NOT have.
 *
 * 🔴 IT DELIBERATELY DOES NOT PREDICT INCOMPATIBILITY. A LoRA x checkpoint
 * pairing is rejected by the SERVER, pre-spend, and `CellStatus` only becomes
 * `'blocked'` after that round trip — at preview time every cell is `'idle'`.
 * So these boxes promise a SHAPE, never that every cell will produce an image.
 * Claiming otherwise here would be the more dangerous kind of wrong, because it
 * is a claim about money.
 */
export function MatrixShapePreview({
  c,
  checkpoints,
  modifiers,
}: {
  c: Palette;
  checkpoints: CheckpointOption[];
  modifiers: ModifierOption[];
}) {
  // Mirrors ResultGrid: a 3rd column can overflow at ~390px, so the swipe cue
  // and edge fade are surfaced only when overflow is actually possible.
  const canOverflow = modifiers.length > 2;

  return (
    <div style={{ display: 'grid', gap: 6 }} data-testid="gm-shape-preview">
      <span style={{ ...noteStyle(c), margin: 0 }}>
        {checkpoints.length} model{checkpoints.length === 1 ? '' : 's'} ×{' '}
        {modifiers.length} style{modifiers.length === 1 ? '' : 's'} — this is the grid you
        will get.
      </span>
      <div className="gm-grid-scroll" style={{ ['--gm-fade-color' as string]: c.fadeColor }}>
        {/* 🔴 THE WHOLE TABLE IS aria-hidden, AND THE CAPTION ABOVE IS ITS
            ACCESSIBLE EQUIVALENT. Every cell here is an empty dashed box: the
            grid is a picture of a SHAPE, not data. To a screen-reader user it
            was a table to be traversed cell by cell — six, twelve, up to twenty
            announcements of nothing — while the one sentence that actually
            carries the information ("2 models × 3 styles — this is the grid you
            will get") sits right above it, and the axis names are already
            announced by the chip rows further up. Hiding a redundant decorative
            table behind an equivalent text alternative is the standard remedy;
            nothing here is available only inside the table. */}
        <table style={{ borderCollapse: 'collapse', width: '100%' }} aria-hidden>
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
            {checkpoints.map((ckpt) => (
              <tr key={ckpt.versionId}>
                <th scope="row" style={rowTh(c)} className="gm-row-th">
                  {ckpt.label}
                </th>
                {modifiers.map((m) => (
                  <td key={m.key} style={cellTd(c)}>
                    {/* Empty on purpose — a placeholder box, not a promise that
                        this pairing will render. aria-hidden because the axis
                        headers already name every cell for AT; announcing N
                        empty cells would be noise. */}
                    <div
                      aria-hidden
                      style={{
                        minHeight: 34,
                        borderRadius: 6,
                        border: `1px dashed ${c.border}`,
                        background: c.inputBg,
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {canOverflow && <span className="gm-edge-fade" aria-hidden />}
      </div>
    </div>
  );
}

export function MatrixConceptExample({ c }: { c: Palette }) {
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
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Example: 2 models × 2 styles = 4 cells
        </span>
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

// The theme palette (design-system `--civitai-*` tokens) now lives in theme.ts,
// imported at the top of the file. `palette()` is token-driven + theme-invariant
// (light/dark resolve from the root `data-theme` the tokens switch on).

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

function lightboxBox(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    borderRadius: 12,
    padding: 12,
    display: 'grid',
    gap: 10,
    background: c.cardBg,
    width: '100%',
    maxWidth: 720,
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
