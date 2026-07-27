// Catalog client for the in-block resource browser (Pass 2).
//
// TWO READ PATHS, chosen by whether a block token is available:
//
//  1. AUTHORITATIVE (signed-in): when the block has a block-scoped JWT we fetch
//     the block-gated endpoint `/api/v1/blocks/models` with an
//     `Authorization: Bearer <token>` header (civitai PR #2671). It returns the
//     SAME response shape as the public `/api/v1/models` (so parsing is
//     unchanged) but AUTHORITATIVELY CLAMPS the catalog's browsing level to the
//     token's signed `maxBrowsingLevel` domain ceiling. The client therefore
//     NEVER sends `nsfw`/`browsingLevel` — maturity is server-enforced. This is
//     the catalog read that's correctly maturity-clamped to the block's domain.
//
//  2. PUBLIC (anon, or graceful fallback): the public REST endpoint
//     `https://civitai.com/api/v1/models` is a MixedAuthEndpoint that returns
//     `Access-Control-Allow-Origin: *` for anon, so a sandboxed iframe can call
//     it with a plain `fetch`, no SDK bridge. We pass `nsfw=false` for an
//     advisory-SFW view. This path runs for anon viewers AND as a deploy-order
//     fallback when the authoritative endpoint isn't reachable yet (404 = not
//     deployed; 401/403 = token lacks `catalog:read` until the manifest+mint
//     roll out). Discovery only — every pick is re-validated server-side at
//     estimate/submit, so a public read is money-safe.
//
// All non-trivial logic here is pure + node-testable: the URL/param builders, the
// response→Option mappers, and a thin fetch client that takes an injectable
// `fetch` (so tests mock success / empty / error / malformed without a network).

import type { CheckpointOption, ModifierOption, PickedResource } from './models.js';
import { checkpointFromPick, loraModifierFromPick } from './models.js';

/** The public REST base. Overridable for tests / a future env pin. */
export const CATALOG_API_BASE = 'https://civitai.com/api/v1/models';

/**
 * The authoritative, block-token-gated, maturity-clamped catalog base
 * (civitai PR #2671). Same host as the public API; only the path differs. The
 * endpoint is host-agnostic + token-authoritative, so the apex host is fine.
 */
export const CATALOG_API_BASE_BLOCKS = 'https://civitai.com/api/v1/blocks/models';

/** Model types we browse. Maps directly to the REST `types` param. */
export type CatalogType = 'Checkpoint' | 'LORA';

/** Sort options surfaced in the browser (subset of the REST `sort` enum). */
export type CatalogSort = 'Highest Rated' | 'Most Downloaded' | 'Newest';

export interface CatalogQuery {
  type: CatalogType;
  /** Meili text search; empty/whitespace → omitted (default popular view). */
  query?: string;
  /** baseModel NAME strings (repeatable param). Empty → omitted (unfiltered). */
  baseModels?: readonly string[];
  sort?: CatalogSort;
  /** ≤100 (server cap). Defaults to DEFAULT_LIMIT. */
  limit?: number;
  cursor?: string;
}

/** Default page size — small enough to keep the grid + payload light. */
export const DEFAULT_LIMIT = 24;

/** Per-build options that don't belong on the (cache-keyed) query itself. */
export interface BuildUrlOptions {
  base?: string;
  /**
   * Append `nsfw=false` (advisory SFW). Only the PUBLIC endpoint reads this; the
   * authoritative `/blocks/models` IGNORES client maturity (server clamps), so
   * we never send it there. Defaults to `false` (i.e. no nsfw param appended).
   */
  sfwOnly?: boolean;
}

/**
 * Build a catalog URL for a query. Pure + deterministic so the cache key (see
 * catalog-cache.ts) and the request agree. `baseModels` is a repeatable param
 * (`baseModels=A&baseModels=B`). Empty query/baseModels are omitted (the default
 * popular view). `limit` is clamped to [1, 100].
 *
 * When `sfwOnly` is set we append `nsfw=false` — used ONLY for the public
 * endpoint (anon / fallback). Never set it for the authoritative endpoint, which
 * clamps maturity server-side and ignores client maturity params.
 */
export function buildCatalogUrl(
  q: CatalogQuery,
  baseOrOpts: string | BuildUrlOptions = CATALOG_API_BASE,
): string {
  const opts: BuildUrlOptions =
    typeof baseOrOpts === 'string' ? { base: baseOrOpts } : baseOrOpts;
  const base = opts.base ?? CATALOG_API_BASE;
  const params = new URLSearchParams();
  params.set('types', q.type);
  const query = q.query?.trim();
  if (query) params.set('query', query);
  // baseModels is repeatable; append each so the server sees an array.
  for (const bm of q.baseModels ?? []) {
    if (bm && bm.trim()) params.append('baseModels', bm);
  }
  if (q.sort) params.set('sort', q.sort);
  const limit = clampLimit(q.limit ?? DEFAULT_LIMIT);
  params.set('limit', String(limit));
  if (q.cursor) params.set('cursor', q.cursor);
  // Advisory SFW — public endpoint only (server-clamped endpoint ignores it).
  if (opts.sfwOnly) params.set('nsfw', 'false');
  // Stable param order (URLSearchParams preserves insertion order) → stable URL.
  return `${base}?${params.toString()}`;
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Response shapes (minimal — only the fields we read). The REST payload is much
// larger; we narrow to what the browser needs and tolerate missing fields.
// ---------------------------------------------------------------------------

interface RawImage {
  url?: string;
  width?: number;
  height?: number;
  nsfwLevel?: number;
}
interface RawModelVersion {
  id?: number;
  name?: string;
  baseModel?: string;
  images?: RawImage[];
}
interface RawModel {
  id?: number;
  name?: string;
  type?: string;
  nsfw?: boolean;
  modelVersions?: RawModelVersion[];
}
interface RawResponse {
  items?: RawModel[];
  metadata?: { nextCursor?: string | null };
}

/**
 * A normalized card the browser grid renders. One per model (its top version).
 * Carries everything needed to (a) show a thumbnail + name + baseModel and
 * (b) turn the pick into a matrix-axis member via the existing models.ts mappers.
 */
export interface CatalogCard {
  modelId: number;
  versionId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  /** Edge thumbnail URL (already width-shrunk where the URL format allows). */
  thumbnailUrl: string | null;
  /** True when the model is flagged nsfw (UI may dim/skip the thumbnail). */
  nsfw: boolean;
}

export interface CatalogPage {
  cards: CatalogCard[];
  nextCursor: string | null;
}

/**
 * Map ONE raw model → a card using its FIRST modelVersion (the REST default
 * order puts the latest/primary version first) and that version's first image.
 * Returns `null` for an unusable row (no version id) so the caller can drop it.
 * Tolerant of any missing field (malformed payload → skipped, never throws).
 */
export function modelToCard(
  raw: RawModel | null | undefined,
  imageWidth = THUMB_WIDTH,
): CatalogCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const version = raw.modelVersions?.[0];
  const versionId = version?.id;
  if (typeof versionId !== 'number' || !Number.isFinite(versionId)) return null;
  const modelId = typeof raw.id === 'number' ? raw.id : 0;
  const firstImage = version?.images?.find((im) => typeof im?.url === 'string' && im.url);
  return {
    modelId,
    versionId,
    modelName: (raw.name ?? '').trim() || `Model #${modelId || versionId}`,
    versionName: (version?.name ?? '').trim(),
    baseModel: (version?.baseModel ?? '').trim(),
    modelType: (raw.type ?? '').trim(),
    thumbnailUrl: firstImage?.url ? edgeThumb(firstImage.url, imageWidth) : null,
    nsfw: raw.nsfw === true,
  };
}

/** Map a full raw response → a page of cards + the next cursor. Never throws. */
export function responseToPage(raw: RawResponse | null | undefined, imageWidth = THUMB_WIDTH): CatalogPage {
  const items = Array.isArray(raw?.items) ? raw!.items! : [];
  const cards: CatalogCard[] = [];
  for (const item of items) {
    const card = modelToCard(item, imageWidth);
    if (card) cards.push(card);
  }
  const nextCursor = raw?.metadata?.nextCursor ?? null;
  return { cards, nextCursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : null };
}

/**
 * Default thumbnail width requested from the image edge.
 *
 * 450 is the EXACT width the civitai web app's native resource picker uses for
 * model-card thumbnails: `IMAGE_CARD_WIDTH = 450` in
 * `src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard.tsx`
 * (rendered via `<EdgeMedia width={450} … />`). 450 is also a value on the
 * image-cacher's CommonSizes ladder (`COMMON_IMAGE_WIDTHS`,
 * `src/client-utils/cf-images-utils.ts`), so requesting it hits an
 * already-CDN-cached variant instead of forcing an origin transcode.
 */
export const THUMB_WIDTH = 450;

/**
 * The transform params the civitai web app requests for these same thumbnails,
 * matching `getEdgeUrl`/`useEdgeUrl` (`src/client-utils/cf-images-utils.ts`):
 * at `width <= 450` the app sets `optimized=true` (`shouldOptimize`), and the
 * params are emitted as a SINGLE comma-joined segment in `getEdgeUrl` order
 * (`width` before `optimized`). For an image card `anim` is left undefined and
 * dropped. So the cache-aligned segment is `width=450,optimized=true` — verified
 * to redirect to the cached `450x<auto>_do` variant (cf-cache-status: HIT).
 */
function thumbTransformSegment(width: number): string {
  return `width=${width},optimized=true`;
}

/**
 * Rewrite a Civitai image edge URL to the SAME small, optimized thumbnail the
 * civitai web app's resource picker requests, so we hit the CDN-cached variant
 * instead of an origin transcode.
 *
 * The edge format is `…/<uuid>/<transform>/<name>` where `<transform>` is a
 * single comma-joined param segment. The PUBLIC REST API
 * (`/api/v1/models`) returns image URLs with `…/<uuid>/original=true/<name>` —
 * i.e. the FULL-SIZE original — so we must replace that segment (the old regex
 * only matched `/width=NNN/` and let `original=true` through unchanged → big
 * images). We handle all three cases:
 *   - an existing `original=true` segment  → replaced with width=450,optimized=true
 *   - an existing `width=NNN[,…]` segment  → replaced
 *   - no transform segment (`…/<uuid>/<name>`) → injected before the filename
 * Unknown formats are returned unchanged (CSS-size + lazy-load still applies).
 * Pure + total — never throws on a weird URL.
 */
export function edgeThumb(url: string, width: number = THUMB_WIDTH): string {
  if (!url || typeof url !== 'string') return url;
  const w = Math.max(32, Math.floor(width));
  const seg = thumbTransformSegment(w);
  // Replace an `original=true` transform segment (what the REST API returns).
  if (/\/original=true\//.test(url)) {
    return url.replace(/\/original=true\//, `/${seg}/`);
  }
  // Replace an existing width=NNN transform segment (incl. comma-joined params).
  if (/\/width=\d+(?:,[^/]*)?\//.test(url)) {
    return url.replace(/\/width=\d+(?:,[^/]*)?\//, `/${seg}/`);
  }
  // Inject a transform segment before the trailing filename for the edge host.
  if (url.includes('image.civitai.com') || url.includes('imagecache.civitai.com')) {
    const lastSlash = url.lastIndexOf('/');
    if (lastSlash > 0) {
      return `${url.slice(0, lastSlash)}/${seg}${url.slice(lastSlash)}`;
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Card → matrix-axis member. Reuses the existing models.ts mappers so the
// browser produces EXACTLY the same shapes as the native host picker, keeping
// the dedup + money invariants identical.
// ---------------------------------------------------------------------------

/** A card carries everything PickedResource needs. */
export function cardToPicked(card: CatalogCard): PickedResource {
  return {
    versionId: card.versionId,
    modelId: card.modelId,
    modelName: card.modelName,
    versionName: card.versionName,
    baseModel: card.baseModel,
    modelType: card.modelType,
  };
}

/** Map a browsed checkpoint card → a CheckpointOption (reuses checkpointFromPick). */
export function cardToCheckpoint(card: CatalogCard): CheckpointOption {
  return checkpointFromPick(cardToPicked(card));
}

/** Map a browsed LoRA card → a LoRA ModifierOption (reuses loraModifierFromPick). */
export function cardToLoraModifier(card: CatalogCard): ModifierOption {
  return loraModifierFromPick(cardToPicked(card));
}

// ---------------------------------------------------------------------------
// The fetch client. Takes an injectable `fetch` so tests drive success / empty
// / network-error / non-OK / malformed without a real network. Returns a
// discriminated result instead of throwing so the UI can show retry/empty.
// ---------------------------------------------------------------------------

/**
 * Injectable fetch. Accepts an optional second arg so the authoritative path can
 * send `Authorization`. The default `defaultFetch` (in ResourceBrowser) forwards
 * it to the real `fetch`; tests inject a spy that records the headers.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type CatalogResult =
  | { kind: 'ok'; page: CatalogPage; authoritative: boolean }
  | { kind: 'empty'; authoritative: boolean } // request OK but zero usable cards
  | { kind: 'error'; status?: number; message: string };

/**
 * Which catalog read to perform. The App resolves this from the SDK block token
 * once per render and threads it down: a present `token` selects the
 * authoritative, maturity-clamped path; `null`/`undefined` selects the public
 * anon path.
 */
export interface CatalogAuth {
  /** Raw block JWT (`useBlockToken().raw`). Absent → anon. */
  token?: string | null;
}

/**
 * Status codes from the authoritative endpoint that mean "not available yet,
 * fall back to public" rather than a hard error:
 *  - 404 → endpoint not deployed (PR #2671 not yet in prod)
 *  - 401/403 → the minted token lacks `catalog:read` (manifest + mint not rolled
 *    out yet) or the JWT isn't accepted
 * Any OTHER non-OK (e.g. 500/503) is a real error surfaced to the UI.
 */
function isFallbackStatus(status: number): boolean {
  return status === 404 || status === 401 || status === 403;
}

/**
 * Why the authoritative path fell back to the public endpoint. Fired via the
 * `onFallback` debug hook so the App can log it.
 *  - `{ status }` → the authoritative endpoint RESPONDED with a fallback status
 *    (404 not-deployed / 401|403 token lacks `catalog:read`).
 *  - `{ reason: 'network' }` → the authoritative `fetch` THREW before any
 *    response (CORS/preflight failure, DNS, connection reset). A transient
 *    failure shouldn't break the in-block browser, so we degrade to the public
 *    (advisory-SFW) endpoint exactly like a fallback status.
 */
export type FallbackInfo = { status: number } | { reason: 'network' };

/** Parse a response body → CatalogResult, never throwing. `imageWidth` optional. */
async function toResult(
  res: Awaited<ReturnType<FetchLike>>,
  authoritative: boolean,
  imageWidth?: number,
): Promise<CatalogResult> {
  if (!res.ok) {
    return { kind: 'error', status: res.status, message: `request failed (${res.status})` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      kind: 'error',
      status: res.status,
      message: err instanceof Error ? err.message : 'bad JSON',
    };
  }
  const page = responseToPage(body as RawResponse, imageWidth);
  if (page.cards.length === 0) return { kind: 'empty', authoritative };
  return { kind: 'ok', page, authoritative };
}

/**
 * Fetch one catalog page, choosing the authoritative (token, maturity-clamped)
 * or public (anon, advisory-SFW) endpoint and gracefully falling back from the
 * former to the latter when it isn't deployed / authorized yet.
 *
 * Result paths:
 *  - token present → `/api/v1/blocks/models` with `Authorization: Bearer …`,
 *    NO `nsfw`/`browsingLevel` (server clamps). On 404/401/403 → fall back to
 *    the public endpoint (advisory SFW), flagged for a debug log. On a THROW
 *    (CORS/preflight/network) → ALSO fall back to public (advisory SFW), flagged
 *    `{ reason: 'network' }` — a transient failure shouldn't break the browser.
 *  - anon (no token) → public `/api/v1/models`, advisory SFW gated by
 *    `anonSfwOnly` (the block's domain ceiling; fail-closed SFW by default).
 *
 * `kind:'error'` on a non-fallback non-OK (e.g. 503 from the authoritative path
 * is a HARD error — overload, NOT "fall back"), a JSON parse failure, OR a
 * failure on the PUBLIC path itself (anon or post-fallback — so there's no
 * infinite loop). The UI shows "couldn't load, retry" + keeps the native picker.
 * Never throws. `authoritative` reports which path produced the cards (the cache
 * uses it; the App logs the fallback).
 */
export async function fetchCatalog(
  q: CatalogQuery,
  deps: {
    fetch: FetchLike;
    auth?: CatalogAuth;
    imageWidth?: number;
    /**
     * Advisory SFW filter for the ANON public read (`nsfw=false`). Defaults to
     * `true` (fail-closed SFW). Threaded from `useDomainMaturity().isSfw` so a
     * red-domain block's anon browse can show mature while green/blue stay SFW.
     * Does NOT affect the authoritative path (server-clamped) or the
     * post-fallback advisory read (which stays fail-closed SFW).
     */
    anonSfwOnly?: boolean;
    /** Override the public base (tests). */
    publicBase?: string;
    /** Override the authoritative base (tests). */
    blocksBase?: string;
    /** Called when the authoritative path falls back to public (debug only). */
    onFallback?: (info: FallbackInfo) => void;
  },
): Promise<CatalogResult> {
  const token = deps.auth?.token;
  const publicBase = deps.publicBase ?? CATALOG_API_BASE;
  const blocksBase = deps.blocksBase ?? CATALOG_API_BASE_BLOCKS;
  // Anon advisory SFW: default fail-closed SFW; only a red-domain block (isSfw
  // false) relaxes it. The post-fallback read stays SFW regardless.
  const anonSfwOnly = deps.anonSfwOnly !== false;

  // Shared public read (anon path AND the graceful-fallback path). A failure
  // HERE is a genuine error (`kind:'error'`) — never falls back again, so a
  // broken public endpoint can't loop.
  const fetchPublic = async (sfwOnly: boolean): Promise<CatalogResult> => {
    const url = buildCatalogUrl(q, { base: publicBase, sfwOnly });
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await deps.fetch(url);
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : 'network error' };
    }
    return toResult(res, false, deps.imageWidth);
  };

  // --- Anon: public endpoint, advisory SFW per the domain ceiling. ---
  if (!token) {
    return fetchPublic(anonSfwOnly);
  }

  // --- Signed-in: authoritative, maturity-clamped endpoint. ---
  // NO nsfw/browsingLevel — the server clamps to the token's domain ceiling.
  const authUrl = buildCatalogUrl(q, { base: blocksBase });
  let authRes: Awaited<ReturnType<FetchLike>>;
  try {
    authRes = await deps.fetch(authUrl, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    // The authoritative fetch THREW (CORS/preflight/network) before any
    // response — degrade to the public read (advisory SFW) rather than breaking
    // the browser. Distinct from a 503 RESPONSE, which is a hard error below.
    deps.onFallback?.({ reason: 'network' });
    return fetchPublic(true);
  }

  // Graceful fallback (deploy-order resilience): the authoritative endpoint
  // isn't deployed / authorized yet → use the public endpoint (advisory SFW).
  // A 503 (or any other non-fallback non-OK) is a HARD error — NOT a fallback.
  if (!authRes.ok && isFallbackStatus(authRes.status)) {
    deps.onFallback?.({ status: authRes.status });
    return fetchPublic(true);
  }

  return toResult(authRes, true, deps.imageWidth);
}
