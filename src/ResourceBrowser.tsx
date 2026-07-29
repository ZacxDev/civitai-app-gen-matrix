// In-block resource browser overlay (Pass 2) — the fast, visual, curated path.
//
// AUGMENTS the native host-chrome picker (kept as the "All resources" fallback).
// This is an in-IFRAME panel (NOT the host modal): a searchable grid of model
// cards backed by the PUBLIC REST endpoint (see catalog-api.ts), heavily cached
// (catalog-cache.ts). Click a card → adds it to the matrix axis via the shared
// models.ts mappers (dedup-safe).
//
// This component is deliberately THIN: every non-trivial decision (URL/params,
// mapping, ecosystem filter + count, cache) lives in the pure node-tested
// modules. The vitest env here is `node`-only, so the component is kept to a
// minimum render + state shell and the logic is covered exhaustively elsewhere.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SegmentedControl } from '@civitai/components-react';

import {
  DEFAULT_LIMIT,
  THUMB_WIDTH,
  cardToCheckpoint,
  cardToLoraModifier,
  fetchCatalog,
  type CatalogCard,
  type CatalogQuery,
  type CatalogResult,
  type CatalogSort,
  type FetchLike,
} from './catalog-api.js';
import { CatalogCache } from './catalog-cache.js';
import {
  compatibleForLabel,
  countCompatible,
  distinctFamilies,
  ecosystemOptions,
  effectiveBaseModelFilter,
  familyLabel,
  type EcosystemFamily,
} from './ecosystem.js';
import type { CheckpointOption, ModifierOption } from './models.js';

// A minimal palette shape (mirrors App's Palette; passed in so the browser
// respects the existing light/dark theme without re-deriving it).
interface Palette {
  bg: string;
  fg: string;
  cardBg: string;
  border: string;
  inputBg: string;
  accent: string;
  accentFg: string;
  danger: string;
  muted: string;
  /** Optional shimmer tokens (App's palette provides them; harness-safe). */
  skelBase?: string;
  skelShine?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Default fetch at the App edge; injectable for tests. Forwards the optional
 * `headers` so the authoritative (`Authorization: Bearer …`) path works.
 */
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export interface ResourceBrowserProps {
  c: Palette;
  /** Which axis we're browsing. */
  type: 'Checkpoint' | 'LORA';
  /** Close the overlay. */
  onClose: () => void;
  /**
   * Selected-checkpoint baseModels — used to ecosystem-filter the LoRA list +
   * drive the "N compatible" count. Empty for the Checkpoint browser.
   */
  checkpointBaseModels: readonly (string | undefined)[];
  /** versionIds already on this axis (to mark/dedupe cards as added). */
  selectedVersionIds: ReadonlySet<number>;
  /** Add a browsed checkpoint card to the rows axis. */
  onAddCheckpoint: (ckpt: CheckpointOption) => void;
  /** Add a browsed LoRA card to the columns axis. */
  onAddLora: (mod: ModifierOption) => void;
  /** "Open the native picker instead" — the All-resources fallback. */
  onOpenNativePicker: () => void;
  /** Injected cache + fetch for tests; the App wires the real ones. */
  cache: CatalogCache;
  fetchImpl?: FetchLike;
  /**
   * Raw block JWT (`useBlockToken().raw`) for the authoritative, maturity-clamped
   * catalog read. Absent/empty → the public anon path (advisory SFW). The App
   * threads this through from the SDK.
   */
  blockToken?: string | null;
  /**
   * `useDomainMaturity().isSfw` — the block's domain maturity ceiling. Drives the
   * ANON public read's advisory `nsfw=false` filter so a red-domain block's anon
   * browse can show mature content while green/blue stay SFW. Fail-closed SFW
   * (default `true`): a missing value (pre-`BLOCK_INIT` / pre-#2670 host) keeps
   * the SFW filter. Ignored on the authoritative (token) path (server clamps).
   */
  domainIsSfw?: boolean;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; cards: CatalogCard[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

/**
 * Debounce a value (~300ms by default). Keeps the search input snappy while
 * collapsing keystrokes into one fetch.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return debounced;
}

export function ResourceBrowser(props: ResourceBrowserProps) {
  const {
    c,
    type,
    onClose,
    checkpointBaseModels,
    selectedVersionIds,
    onAddCheckpoint,
    onAddLora,
    onOpenNativePicker,
    cache,
    fetchImpl,
    blockToken,
    domainIsSfw,
  } = props;
  const fetchFn = fetchImpl ?? defaultFetch;
  // A present token selects the authoritative (maturity-clamped) read; absent →
  // public anon. Normalize empty-string to null so the build agrees.
  const token = blockToken && blockToken.length > 0 ? blockToken : null;
  const expectAuthoritative = token != null;
  // Anon advisory SFW filter from the domain ceiling. Fail-closed SFW: an absent
  // value (pre-init / pre-#2670 host) → SFW. Only the anon path reads this.
  const anonSfwOnly = domainIsSfw !== false;

  // Modal a11y (light polish): focus the search input on open, close on Escape,
  // restore focus to the trigger on unmount. Markup/behavior only.
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    const node = panelRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  const [rawQuery, setRawQuery] = useState('');
  const [sort, setSort] = useState<CatalogSort>('Highest Rated');
  const query = useDebounced(rawQuery, SEARCH_DEBOUNCE_MS);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [compatibleCount, setCompatibleCount] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Explicit ecosystem selection (the multiselect pills). When non-empty it
  // takes precedence over the implicit checkpoint-derived filter (Fix 2).
  const [explicitFamilies, setExplicitFamilies] = useState<EcosystemFamily[]>([]);

  const isLora = type === 'LORA';

  // The effective REST baseModels filter: explicit selection wins; otherwise
  // implicit checkpoint-derived (LoRA only); else unfiltered. Empty = show all.
  const baseModelsFilter = useMemo<string[]>(
    () => effectiveBaseModelFilter({ explicitFamilies, isLora, checkpointBaseModels }),
    [explicitFamilies, isLora, checkpointBaseModels],
  );
  // The implicit-mode "N compatible / mixed" hints only make sense when there is
  // NO explicit selection (otherwise the pills already say what's filtered).
  const usingImplicit = explicitFamilies.length === 0;
  const mixedEcosystems = isLora && usingImplicit && distinctFamilies(checkpointBaseModels).length > 1;
  const compatLabel = isLora && usingImplicit ? compatibleForLabel(checkpointBaseModels) : '';

  const addFamily = useCallback((fam: EcosystemFamily) => {
    setExplicitFamilies((prev) => (prev.includes(fam) ? prev : [...prev, fam]));
  }, []);
  const removeFamily = useCallback((fam: EcosystemFamily) => {
    setExplicitFamilies((prev) => prev.filter((f) => f !== fam));
  }, []);

  const catalogQuery = useMemo<CatalogQuery>(
    () => ({
      type,
      query: query.trim() || undefined,
      baseModels: baseModelsFilter.length ? baseModelsFilter : undefined,
      sort,
      limit: DEFAULT_LIMIT,
    }),
    [type, query, baseModelsFilter, sort],
  );

  // Track the latest request so a stale (slow) response can't clobber a newer one.
  const reqIdRef = useRef(0);

  const load = useCallback(
    async (q: CatalogQuery) => {
      const reqId = ++reqIdRef.current;
      // Cache-first: an instant hit skips the spinner entirely. Read under the
      // EXPECTED scope dimension so a clamped (signed-in) view and the public
      // (anon) view never serve each other's results.
      const cached = cache.get(q, expectAuthoritative);
      if (cached) {
        setState({ kind: 'ok', cards: cached.cards });
        if (isLora) {
          setCompatibleCount(
            countCompatible(cached.cards.map((card) => card.baseModel), checkpointBaseModels),
          );
        }
        return;
      }
      setState({ kind: 'loading' });
      let res: CatalogResult;
      try {
        res = await fetchCatalog(q, {
          fetch: fetchFn,
          auth: { token },
          anonSfwOnly,
          onFallback: (info) => {
            // Deploy-order resilience: the authoritative endpoint isn't live /
            // authorized yet (status), OR the authoritative fetch threw
            // (CORS/preflight/network) — either way we used the public read.
            // Debug-only — the selector still works; expected until
            // #2670+#2671 deploy, or on a transient blip.
            if (typeof console !== 'undefined') {
              const why = 'status' in info ? `unavailable (${info.status})` : 'fetch failed (network)';
              console.debug(
                `[gen-matrix] authoritative catalog endpoint ${why}; fell back to public /api/v1/models (nsfw=false)`,
              );
            }
          },
        });
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'load failed' });
        return;
      }
      if (reqId !== reqIdRef.current) return; // a newer request superseded us
      if (res.kind === 'ok') {
        // Cache under the ACTUAL path that produced the cards (authoritative vs
        // public fallback) so the scope dimension stays honest.
        cache.set(q, res.page, res.authoritative);
        setState({ kind: 'ok', cards: res.page.cards });
        if (isLora) {
          setCompatibleCount(
            countCompatible(res.page.cards.map((card) => card.baseModel), checkpointBaseModels),
          );
        }
      } else if (res.kind === 'empty') {
        setState({ kind: 'empty' });
        if (isLora) setCompatibleCount(0);
      } else {
        setState({ kind: 'error', message: res.message });
      }
    },
    [cache, fetchFn, isLora, checkpointBaseModels, token, expectAuthoritative, anonSfwOnly],
  );

  useEffect(() => {
    void load(catalogQuery);
  }, [load, catalogQuery, reloadNonce]);

  const addCard = useCallback(
    (card: CatalogCard) => {
      if (selectedVersionIds.has(card.versionId)) return; // already added
      if (isLora) onAddLora(cardToLoraModifier(card));
      else onAddCheckpoint(cardToCheckpoint(card));
    },
    [isLora, selectedVersionIds, onAddCheckpoint, onAddLora],
  );

  return (
    <div
      className="gm-backdrop"
      aria-label={`Browse ${isLora ? 'LoRAs' : 'checkpoints'}`}
      style={overlay(c)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" className="gm-dialog-enter" style={panel(c)}>
        <div style={headerRow}>
          <strong style={{ fontSize: 16 }}>{isLora ? 'Browse LoRAs' : 'Browse checkpoints'}</strong>
          <button
            type="button"
            onClick={onClose}
            style={closeBtn(c)}
            className="gm-chip"
            data-testid="gm-browse-close"
          >
            Close
          </button>
        </div>

        <input
          ref={searchRef}
          type="search"
          value={rawQuery}
          placeholder={isLora ? 'Search LoRAs…' : 'Search checkpoints…'}
          aria-label={`Search ${isLora ? 'LoRAs' : 'checkpoints'}`}
          onChange={(e) => setRawQuery(e.target.value)}
          style={searchInput(c)}
          data-testid="gm-browse-search"
        />

        <SegmentedControl
          aria-label="Sort results"
          data-testid="gm-browse-sort"
          value={sort}
          onChange={(v) => setSort(v as CatalogSort)}
          size="sm"
          data={[
            { value: 'Highest Rated', label: 'Top rated' },
            { value: 'Most Downloaded', label: 'Most used' },
            { value: 'Newest', label: 'Newest' },
          ]}
        />

        <EcosystemMultiselect
          c={c}
          selected={explicitFamilies}
          onAdd={addFamily}
          onRemove={removeFamily}
        />

        {isLora && usingImplicit && compatibleCount != null && state.kind === 'ok' && (
          <p style={{ ...note(c), margin: 0 }} role="status">
            <strong>{compatibleCount}</strong> compatible {compatLabel}
            {mixedEcosystems && ' · mixed ecosystems selected'}
          </p>
        )}

        <div style={gridScroll}>
          {state.kind === 'loading' && <SkeletonGrid c={c} />}
          {state.kind === 'empty' && (
            <EmptyOrError
              c={c}
              title="No results"
              detail="Try a different search, or use the full resource picker."
              onNative={onOpenNativePicker}
            />
          )}
          {state.kind === 'error' && (
            <EmptyOrError
              c={c}
              title="Couldn't load"
              detail={state.message}
              onRetry={() => setReloadNonce((n) => n + 1)}
              onNative={onOpenNativePicker}
            />
          )}
          {state.kind === 'ok' && (
            <div style={cardGrid}>
              {state.cards.map((card) => (
                <CardTile
                  key={card.versionId}
                  c={c}
                  card={card}
                  added={selectedVersionIds.has(card.versionId)}
                  onAdd={() => addCard(card)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={footerRow(c)}>
          <button
            type="button"
            onClick={onOpenNativePicker}
            style={linkBtn(c)}
            data-testid="gm-browse-native"
          >
            Browse all resources (full picker)
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The explicit ecosystem filter (Fix 2): a searchable multiselect that appends
 * a removable pill per chosen family. Deliberately thin — the option list +
 * label come from `ecosystem.ts` (the tested source of truth); this is just a
 * text-filtered popover + a row of chips. Keyboard: typing filters; Enter picks
 * the first match; Escape closes the popover (without closing the dialog — it
 * stops propagation so the browser overlay's Escape handler doesn't also fire).
 */
function EcosystemMultiselect({
  c,
  selected,
  onAdd,
  onRemove,
}: {
  c: Palette;
  selected: readonly EcosystemFamily[];
  onAdd: (fam: EcosystemFamily) => void;
  onRemove: (fam: EcosystemFamily) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const allOptions = useMemo(() => ecosystemOptions(), []);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return allOptions.filter(
      (o) => !selectedSet.has(o.family) && (!f || o.label.toLowerCase().includes(f)),
    );
  }, [allOptions, selectedSet, filter]);

  // Close the popover on an outside click (markup-only; no global key trap).
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const pick = useCallback(
    (fam: EcosystemFamily) => {
      onAdd(fam);
      setFilter('');
    },
    [onAdd],
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'grid', gap: 6 }}>
      <div style={ecoControlRow}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={ecoTrigger(c)}
          className="gm-chip"
          data-testid="gm-eco-trigger"
        >
          {selected.length ? `Ecosystems · ${selected.length}` : 'Filter by ecosystem'}
          <span aria-hidden style={{ marginLeft: 6, opacity: 0.7 }}>▾</span>
        </button>
        {selected.map((fam) => (
          <span key={fam} style={ecoPill(c)} data-testid="gm-eco-pill">
            {familyLabel(fam)}
            <button
              type="button"
              onClick={() => onRemove(fam)}
              aria-label={`Remove ${familyLabel(fam)}`}
              style={ecoPillX(c)}
              data-testid="gm-eco-pill-remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {open && (
        <div style={ecoPopover(c)} role="listbox" aria-label="Ecosystems" data-testid="gm-eco-popover">
          <input
            type="search"
            autoFocus
            value={filter}
            placeholder="Search ecosystems…"
            aria-label="Search ecosystems"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'Enter' && visible.length) {
                e.preventDefault();
                pick(visible[0].family);
              }
            }}
            style={ecoSearch(c)}
            data-testid="gm-eco-search"
          />
          <div style={ecoOptionList}>
            {visible.length === 0 ? (
              <span style={{ ...note(c), padding: '6px 4px' }}>No ecosystems</span>
            ) : (
              visible.map((o) => (
                <button
                  key={o.family}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pick(o.family)}
                  style={ecoOption(c)}
                  className="gm-chip"
                  data-testid="gm-eco-option"
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CardTile({
  c,
  card,
  added,
  onAdd,
}: {
  c: Palette;
  card: CatalogCard;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={added}
      aria-pressed={added}
      title={`${card.modelName}${card.versionName ? ` — ${card.versionName}` : ''} (${card.baseModel || 'unknown base'})`}
      style={tile(c, added)}
      className={added ? undefined : 'gm-chip'}
      data-testid="gm-browse-card"
    >
      <div style={thumbWrap(c)}>
        {card.thumbnailUrl ? (
          <img
            src={card.thumbnailUrl}
            alt=""
            loading="lazy"
            width={THUMB_WIDTH}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span style={{ color: c.muted, fontSize: 11 }}>no preview</span>
        )}
        {added && <span style={addedBadge(c)}>Added</span>}
      </div>
      <span style={tileName(c)}>{card.modelName}</span>
      <span style={{ fontSize: 10, color: c.muted }}>{card.baseModel || '—'}</span>
    </button>
  );
}

function SkeletonGrid({ c }: { c: Palette }) {
  // Shimmer tokens (fall back to neutral translucent grays if a caller's
  // palette lacks them — e.g. the harness's minimal palette).
  const skelVars: React.CSSProperties = {
    ['--gm-skel-base' as string]: c.skelBase ?? 'rgba(128,128,128,0.10)',
    ['--gm-skel-shine' as string]: c.skelShine ?? 'rgba(128,128,128,0.22)',
  };
  return (
    <div style={cardGrid} aria-hidden data-testid="gm-browse-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ ...tile(c, false), cursor: 'default' }}>
          <div className="gm-skeleton" style={{ ...thumbWrap(c), background: c.inputBg, ...skelVars }} />
          <div
            className="gm-skeleton"
            style={{ height: 10, background: c.inputBg, borderRadius: 4, width: '80%', ...skelVars }}
          />
          <div
            className="gm-skeleton"
            style={{ height: 8, background: c.inputBg, borderRadius: 4, width: '50%', ...skelVars }}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyOrError({
  c,
  title,
  detail,
  onRetry,
  onNative,
}: {
  c: Palette;
  title: string;
  detail: string;
  onRetry?: () => void;
  onNative: () => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 10, placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <span style={{ ...note(c) }}>{detail}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        {onRetry && (
          <button type="button" onClick={onRetry} style={smallPrimary(c)} data-testid="gm-browse-retry">
            Retry
          </button>
        )}
        <button type="button" onClick={onNative} style={linkBtn(c)}>
          Use full picker
        </button>
      </div>
    </div>
  );
}

// ---- inline styles (host can't inject CSS into the iframe) ----

function overlay(c: Palette): React.CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'grid',
    placeItems: 'center',
    padding: 16,
    zIndex: 50,
    boxSizing: 'border-box',
    color: c.fg,
  };
}
function panel(c: Palette): React.CSSProperties {
  return {
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: 12,
    width: '100%',
    maxWidth: 640,
    maxHeight: '85dvh',
    display: 'grid',
    // header · search · ecosystem-multiselect · compat-note · grid(1fr) · footer.
    // The compat-note is conditionally rendered; `auto` tracks collapse to 0 when
    // their child is absent, so the explicit count here is an upper bound.
    gridTemplateRows: 'auto auto auto auto 1fr auto',
    gap: 10,
    padding: 16,
    boxSizing: 'border-box',
  };
}
const headerRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};
function closeBtn(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    background: 'transparent',
    color: c.fg,
    borderRadius: 8,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
}
function searchInput(c: Palette): React.CSSProperties {
  return {
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${c.border}`,
    background: c.inputBg,
    color: c.fg,
    fontSize: 14,
    width: '100%',
    boxSizing: 'border-box',
  };
}
const gridScroll: React.CSSProperties = { overflowY: 'auto', minHeight: 120 };
const cardGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
  gap: 10,
};
function tile(c: Palette, added: boolean): React.CSSProperties {
  return {
    display: 'grid',
    gap: 4,
    padding: 6,
    border: `1px solid ${added ? c.accent : c.border}`,
    borderRadius: 8,
    background: c.cardBg,
    color: c.fg,
    textAlign: 'left',
    cursor: added ? 'default' : 'pointer',
    opacity: added ? 0.7 : 1,
  };
}
function thumbWrap(c: Palette): React.CSSProperties {
  return {
    position: 'relative',
    aspectRatio: '1 / 1',
    borderRadius: 6,
    overflow: 'hidden',
    background: c.inputBg,
    display: 'grid',
    placeItems: 'center',
  };
}
function addedBadge(c: Palette): React.CSSProperties {
  return {
    position: 'absolute',
    top: 4,
    right: 4,
    background: c.accent,
    color: c.accentFg,
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    padding: '2px 6px',
  };
}
function tileName(c: Palette): React.CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 600,
    color: c.fg,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}
function footerRow(c: Palette): React.CSSProperties {
  return { borderTop: `1px solid ${c.border}`, paddingTop: 10 };
}
function linkBtn(c: Palette): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color: c.accent,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  };
}
function smallPrimary(c: Palette): React.CSSProperties {
  return {
    background: c.accent,
    color: c.accentFg,
    border: 'none',
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  };
}
function note(c: Palette): React.CSSProperties {
  return { fontSize: 13, color: c.muted, lineHeight: 1.5 };
}

// ---- ecosystem multiselect styles ----

const ecoControlRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
};
function ecoTrigger(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    background: c.inputBg,
    color: c.fg,
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
  };
}
function ecoPill(c: Palette): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: c.accent,
    color: c.accentFg,
    borderRadius: 999,
    padding: '3px 6px 3px 10px',
    fontSize: 12,
    fontWeight: 600,
  };
}
function ecoPillX(c: Palette): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color: c.accentFg,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: '0 2px',
    fontWeight: 700,
  };
}
function ecoPopover(c: Palette): React.CSSProperties {
  return {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 4,
    zIndex: 60,
    width: 'min(260px, 90%)',
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: 8,
    padding: 8,
    display: 'grid',
    gap: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
  };
}
function ecoSearch(c: Palette): React.CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 6,
    border: `1px solid ${c.border}`,
    background: c.inputBg,
    color: c.fg,
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
  };
}
const ecoOptionList: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  maxHeight: 200,
  overflowY: 'auto',
};
function ecoOption(c: Palette): React.CSSProperties {
  return {
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    color: c.fg,
    borderRadius: 6,
    padding: '7px 8px',
    fontSize: 13,
    cursor: 'pointer',
  };
}
