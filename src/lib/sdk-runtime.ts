// The fifteen runtime bindings this app used to take from `@civitai/blocks-react`,
// re-expressed on `@civitai/sdk`'s `initialize({ transport })`.
//
// WHY A MODULE AND NOT FIFTEEN INLINE REWRITES: the SDK is not hook-shaped. It is
// one async `initialize()` returning clients, so every consumer would otherwise
// have to solve the same three problems — when the client exists, how a snapshot
// field reaches React without re-rendering forever, and which operations are
// still messages rather than HTTP. Those answers belong in one place.
//
// THE SPLIT, WHICH IS THE WHOLE DESIGN. Three groups, and they differ in kind:
//
//   1. SNAPSHOT (ready/viewer/theme/context/token/maturity) — available
//      SYNCHRONOUSLY from the transport, before `initialize()` resolves, because
//      the bridge transport already holds `BLOCK_INIT`. These must not wait on
//      anything: the app paints its boot skeleton off `ready`/`theme`
//      (`src/bootTheme.ts` documents why the pre-`ready` value matters).
//   2. HOST-MEDIATED (resize, sign-in, consent, resource picker, Buzz purchase,
//      publish) — still postMessage, and `createHost(transport)` is synchronous,
//      so these need no await either.
//   3. REST (app storage, shared storage, the workflow money path, the app's
//      workflow read-model, gated images) — these moved off the bridge onto
//      `/api/v1/blocks/*`, and they are the only group that must wait for
//      `initialize({ transport })` to resolve, because only the AppClient carries
//      the http clients bound to the token session.
//
// 🔴 ONE TRANSPORT, AND IT IS THE BRIDGE'S. `./sdk-transport.ts` explains why
// (`/ui` keeps constructing the bridge singleton, so a bare `initialize()` would
// stand up a second one). The consequence that matters HERE: the
// `@civitai/blocks-react/testing` mock host drives that same singleton, so every
// existing mock-host test keeps answering group 1 and group 2 unchanged. Only
// group 3 leaves the mock host's reach — it answers HTTP now — which is why
// `configureSdkRuntime({ fetch })` and `src/dev-rest.ts` exist rather than a
// mock-host seam.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';

import { getTransport } from '@civitai/blocks-react';
import { createHost, initialize } from '@civitai/sdk';
import type {
  AppClient,
  BlockAppClient,
  BlockSnapshot,
  BlockTransport,
  Host,
  Scope,
  SharedItem,
  SharedValue,
  StorageClient,
} from '@civitai/sdk';
import { isLevelAllowed as isLevelAllowedCeiling, isSfwCeiling } from '@civitai/app-sdk/blocks';
import type {
  AppWorkflow,
  BlockContext,
  BlockGatedImage,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockWorkflowSnapshot,
  ColorDomain,
  Theme,
  ViewerInfo,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import { createSdkTransportAdapter } from './sdk-transport.js';

export interface SdkRuntimeOptions {
  /**
   * The transport the SDK reads. Defaults to the bridge singleton adapted by
   * `createSdkTransportAdapter()`; a test passes a fake so no iframe is needed.
   */
  transport?: BlockTransport;
  /**
   * Injected into `initialize`, so group 3 (the REST clients) can be answered at
   * the `fetch` boundary. 🔴 THIS IS THE SEAM THE PORT CREATES. Before the port
   * a test seeded storage, shared storage, the workflow money path and the gated
   * images through the mock HOST; after it those are HTTP and the host never sees
   * them, so a test that kept seeding the host would pass while exercising
   * nothing. `src/dev-rest.ts` is what answers here.
   */
  fetch?: typeof globalThis.fetch;
  /** Override the site base URL (`/api/v1` by default) — dev harness only. */
  siteUrl?: string;
}

let options: SdkRuntimeOptions = {};
let transportSingleton: BlockTransport | null = null;
let bridgeWrapped: unknown = null;
let appPromise: Promise<BlockAppClient> | null = null;

/**
 * Set the runtime's options — the transport, the `fetch` the REST clients use, and
 * the site base URL. `src/main.tsx` calls it for the dev harness; production needs
 * no call at all, because every default is already right there.
 *
 * 🔴 IT DISCARDS ANY AppClient BUILT UNDER THE PREVIOUS OPTIONS, and that is the
 * whole contract: the hazard is a STALE CLIENT still holding the previous
 * `fetch`, and dropping the client removes it where refusing would merely report
 * it — and refusing would also reject a legitimate case this repo's own suite
 * contains (`mountShared` in `App.integration.test.tsx` renders the app twice
 * against one backing store).
 *
 * It is NOT a full reset: `resetSdkRuntime` is what tests use between cases,
 * because that also clears options back to the defaults.
 */
export function configureSdkRuntime(next: SdkRuntimeOptions): void {
  options = next;
  transportSingleton = next.transport ?? null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * Drop all runtime state. A test seam, and the counterpart every singleton needs:
 * without it the first test's transport and fetch leak into every later test in
 * the same file.
 */
export function resetSdkRuntime(): void {
  options = {};
  transportSingleton = null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * The one transport.
 *
 * 🔴 THE CACHE IS KEYED ON THE BRIDGE TRANSPORT'S IDENTITY, AND THAT IS NOT
 * DEFENSIVE POLISH — IT IS REQUIRED BY THIS REPO'S TEST SETUP. The bridge's
 * transport is a process-wide singleton that `resetTransport()` NULLS, so the next
 * `getTransport()` returns a brand-new object; `src/test-setup.ts` calls
 * `resetTransport()` in a global `beforeEach`, i.e. before EVERY dom test, and
 * `App.integration.test.tsx` calls it again per mount. A plain `??=` would
 * therefore wrap the first test's transport and keep wrapping it after it had been
 * disposed — every later test reading a dead snapshot. The AppClient is bound to
 * the transport too (its session and host both close over it), so a swap must drop
 * that as well.
 *
 * An explicitly configured transport is never re-derived: a test that passed one
 * owns it, and silently replacing it with the singleton would be worse than any
 * staleness this guards against.
 */
function transport(): BlockTransport {
  if (options.transport) return options.transport;
  const bridge = getTransport();
  if (transportSingleton === null || bridge !== bridgeWrapped) {
    bridgeWrapped = bridge;
    transportSingleton = createSdkTransportAdapter(bridge) as BlockTransport;
    appPromise = null;
  }
  return transportSingleton;
}

/** The one AppClient promise, created on first use. */
function app(): Promise<BlockAppClient> {
  appPromise ??= initialize({
    transport: transport(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
  });
  return appPromise;
}

/** The host client. Synchronous — `createHost` needs only the transport. */
function host(): Host {
  return createHost(transport());
}

/**
 * The `site` client, for the routes the SDK carries no typed client for.
 *
 * Every caller below goes through this rather than reaching into `app()` inline,
 * so there is ONE place that knows group 3 has to await the AppClient.
 */
async function site(): Promise<AppClient['site']> {
  return (await app()).site;
}

// ---------------------------------------------------------------------------
// Group 1 — the snapshot
// ---------------------------------------------------------------------------

/**
 * Read one field out of the live snapshot.
 *
 * 🔴 `select` MUST RETURN A FIELD, NEVER A FRESH OBJECT. `useSyncExternalStore`
 * bails out on `Object.is`, so a selector composing `{ a, b }` returns a new
 * identity every call, never compares equal, and re-renders forever. The
 * transport adapter memoises the snapshot itself for exactly this reason; a
 * composing selector here would throw that away one layer up. Compose with
 * `useMemo` on the fields instead, as `useBlockContext` does below.
 */
export function useBlockSnapshot<T>(select: (snapshot: BlockSnapshot) => T): T {
  const t = transport();
  const subscribe = useCallback((onChange: () => void) => t.snapshot.subscribe(onChange), [t]);
  const get = useCallback(() => select(t.snapshot.get()), [t, select]);
  return useSyncExternalStore(subscribe, get, get);
}

const selectReady = (s: BlockSnapshot) => s.ready;
const selectViewer = (s: BlockSnapshot) => s.viewer;
const selectTheme = (s: BlockSnapshot) => s.theme;
const selectContext = (s: BlockSnapshot) => s.context;
const selectToken = (s: BlockSnapshot) => s.token;
const selectDomain = (s: BlockSnapshot) => s.domain;
const selectMaxBrowsingLevel = (s: BlockSnapshot) => s.maxBrowsingLevel;

export interface BlockContextValue {
  ready: boolean;
  viewer: ViewerInfo | null;
  theme: Theme;
  context: BlockContext;
}

/**
 * `{ ready, viewer, theme, context }` — the four fields `App.tsx` destructures
 * from the bridge hook of the same name.
 *
 * The bridge hook returned nine fields; only these four are read here, and
 * narrowing the surface is deliberate: an unused field in the return type is a
 * claim this module would have to keep true across SDK versions for nothing.
 */
export function useBlockContext(): BlockContextValue {
  const ready = useBlockSnapshot(selectReady);
  const viewer = useBlockSnapshot(selectViewer);
  const theme = useBlockSnapshot(selectTheme);
  const context = useBlockSnapshot(selectContext) as BlockContext;
  return useMemo(() => ({ ready, viewer, theme, context }), [ready, viewer, theme, context]);
}

export interface BlockTokenValue {
  raw: string;
  scopes: string[];
  /**
   * Force an immediate re-mint. Resolves once the new token has been applied to
   * the snapshot.
   */
  refresh: () => Promise<void>;
}

/**
 * The block JWT plus a `refresh()`.
 *
 * ⚠ ONE DELIBERATE IMPROVEMENT ON THE BRIDGE HOOK: the bridge returned
 * `{ ...token, refresh }`, a FRESH object every render. This returns a value
 * memoised on the snapshot's token identity, so the object is stable between
 * mints. `App.tsx` reads only `token.raw` and `token.scopes`, so neither the old
 * churn nor the new stability changes what it renders — recorded because the
 * difference is real, not because anything depends on it.
 *
 * `refresh` goes out as `REQUEST_TOKEN` over the adapter, which is one of the
 * four request types `sdk-transport.ts` maps (to `TOKEN_REFRESH_RESPONSE`) — so
 * the bridge transport applies the new token to the snapshot this hook reads, and
 * the re-render follows from the same place it always did.
 */
export function useBlockToken(): BlockTokenValue {
  const token = useBlockSnapshot(selectToken);
  return useMemo(
    () => ({
      raw: token.raw,
      scopes: token.scopes,
      refresh: async () => {
        const client = await app();
        await client.getToken({ fresh: true });
      },
    }),
    [token],
  );
}

export interface DomainMaturity {
  domain?: ColorDomain | null;
  maxBrowsingLevel?: number;
  isSfw: boolean;
  isLevelAllowed: (level: number) => boolean;
}

/**
 * The block's DOMAIN maturity ceiling, fail-closed.
 *
 * 🔴 THE TWO PREDICATES COME FROM `@civitai/app-sdk/blocks`, NOT FROM A LOCAL
 * REIMPLEMENTATION, and that is the point of the binding. `isSfwCeiling` and
 * `isLevelAllowed` are the SAME functions the bridge hook called
 * (`@civitai/blocks-react` `dist/hooks/useDomainMaturity.js` imports them from
 * exactly this module), so the fail-closed behaviour for an ABSENT ceiling — the
 * case that decides whether a red-domain block blurs a mature result — is not
 * re-derived here and cannot drift from it. `@civitai/app-sdk` is not the bridge;
 * it stays a dependency of this app either way, and `matrix.ts` already imports
 * its types.
 *
 * `effectiveBrowsingLevel` is deliberately NOT read: the bridge's snapshot
 * (`@civitai/blocks-react@0.47.0`) does not carry it, so through the adapter it
 * is always `undefined`, and reading it would be a field that looks like a
 * per-viewer narrowing while always being absent.
 */
export function useDomainMaturity(): DomainMaturity {
  const domain = useBlockSnapshot(selectDomain);
  const maxBrowsingLevel = useBlockSnapshot(selectMaxBrowsingLevel);
  return useMemo(
    () => ({
      domain,
      maxBrowsingLevel,
      isSfw: isSfwCeiling(maxBrowsingLevel),
      isLevelAllowed: (level: number) => isLevelAllowedCeiling(level, maxBrowsingLevel),
    }),
    [domain, maxBrowsingLevel],
  );
}

/**
 * The host analytics sink, as a NO-OP — and it is not a regression.
 *
 * 🔴 `TRACK_EVENT` is listed "not carried" in `@civitai/sdk`'s `BREAKING.md`, AND
 * IT HAS NO HOST HANDLER TODAY EITHER: the platform's own handler-parity ledger
 * marks both hosts N/A, *"analytics fire-and-forget; no host-side sink wired
 * (dropped, never hangs)"*. So `RootBoundary`'s `track('render_error', …)` is
 * ALREADY a no-op on `main` — this keeps one shim function rather than deleting
 * the call site, so the day a sink exists there is one place to wire it.
 */
export function useBlockAnalytics(): {
  track: (eventName: string, properties?: Record<string, unknown>) => void;
} {
  return useMemo(() => ({ track: () => {} }), []);
}

// ---------------------------------------------------------------------------
// Group 2 — host-mediated, still postMessage
// ---------------------------------------------------------------------------

/**
 * Keep the host iframe sized to `ref`'s content.
 *
 * `host.autoResize(element)` owns the observer and the initial report, and
 * returns its own teardown — so this hook is a lifecycle wrapper and nothing
 * more. It waits for the element: `ref.current` is null on the first effect run
 * for a ref attached below it in the tree.
 */
export function useBlockResize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return host().autoResize(element);
  }, [ref]);
}

/** `{ requestSignIn }` — asks the host to open its sign-in flow. */
export function useRequestSignIn(): { requestSignIn: () => void } {
  const requestSignIn = useCallback(() => host().requestSignIn(), []);
  return useMemo(() => ({ requestSignIn }), [requestSignIn]);
}

/**
 * How long a pending consent request is held open before its listeners are
 * released. The viewer is not on a clock — the host's dialog is theirs to leave
 * open — so this is deliberately generous; it exists only so a declined request
 * cannot retain a snapshot subscription for the life of the page.
 */
const CONSENT_WAIT_MS = 5 * 60_000;

/**
 * `{ requestConsent }` — fire-and-forget, exactly as the bridge hook was.
 *
 * 🔴 THE SDK's `requestGrants` IS AWAITABLE AND THE BRIDGE's WAS NOT, AND THAT
 * DIFFERENCE HAD TO BE HANDLED RATHER THAN CAST AWAY. `requestGrants` resolves
 * `true` when the re-minted token carries the scopes, `false` on
 * `CONSENT_UNAVAILABLE` — and against a viewer who simply closes the dialog it
 * resolves NEITHER, holding a snapshot subscription and a message listener per
 * press. This app's call site is fire-and-forget by design (on grant the host
 * re-mints and `hasBudgetedScope(token.scopes)` flips the gate; declining changes
 * nothing and must raise no error), so:
 *
 *   - the promise is not awaited, preserving the call site's semantics;
 *   - it is bounded by a signal, so an abandoned dialog releases its listeners;
 *   - the rejection that abort produces is swallowed HERE, because an unhandled
 *     rejection in a click handler is a console error a viewer can produce at
 *     will by closing a dialog.
 *
 * ⚠ `scopes` IS THE SDK's `Scope` UNION, NOT `string[]`, and that is a deliberate
 * tightening rather than an accident of the signature: a scope this platform does
 * not define is now a compile error at the call site instead of a runtime
 * `CONSENT_UNAVAILABLE` nobody traces back to a typo. This app's own constants in
 * `src/scopes.ts` are `const` string literals, so they satisfy it unchanged.
 */
export function useRequestConsent(): {
  requestConsent: (args: { scopes: readonly Scope[] }) => void;
} {
  const requestConsent = useCallback(({ scopes }: { scopes: readonly Scope[] }) => {
    void app()
      .then((client) =>
        client.requestGrants(scopes, { signal: AbortSignal.timeout(CONSENT_WAIT_MS) }),
      )
      .catch(() => {
        /* declined, abandoned, or aborted — all "nothing changed", never an error */
      });
  }, []);
  return useMemo(() => ({ requestConsent }), [requestConsent]);
}

/**
 * civitai's own resource picker. `{ open }`, matching the bridge hook's shape so
 * `App.tsx`'s `const { open: openResourcePicker }` is unchanged.
 *
 * `null` means the viewer dismissed it. The SDK's `PickedResource` and the
 * bridge's `BlockResourceInfo` are the same wire object; the return is declared
 * as the app's own `PickedResource` mirror in `src/models.ts` terms via
 * `BlockResourceInfo`, which is what `addLoraModifier` / `addCheckpointRow`
 * already take.
 */
export function useResourcePicker(): {
  open: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
} {
  const open = useCallback(
    async (opts: { resourceType: BlockResourcePickerType; baseModelGroup?: string }) =>
      (await host().openResourcePicker(opts)) as BlockResourceInfo | null,
    [],
  );
  return useMemo(() => ({ open }), [open]);
}

/**
 * The host's Buzz top-up modal.
 *
 * ⚠ `newBalance` IS GONE, and dropping it from the type is the honest move
 * rather than a loss. The bridge hook resolved `{ purchased, newBalance? }`;
 * `@civitai/sdk@0.8.0`'s `host.openBuzzPurchase` resolves `{ purchased }` only
 * (`dist/host/index.js` destructures `{ purchased }` and rebuilds the object).
 * This app never read `newBalance` — its one call site is
 * `openPurchaseModal(suggestedTopUpAmount(...)).catch(...)`, which discards the
 * resolution entirely — so declaring a field the SDK does not carry would be a
 * type that lies.
 */
export function useBuzzPurchase(): {
  openPurchaseModal: (suggestedAmount?: number) => Promise<{ purchased: boolean }>;
} {
  const openPurchaseModal = useCallback(
    (suggestedAmount?: number) =>
      host().openBuzzPurchase(suggestedAmount === undefined ? {} : { suggestedAmount }),
    [],
  );
  return useMemo(() => ({ openPurchaseModal }), [openPurchaseModal]);
}

/**
 * Publish outputs of ONE of this app's own workflows as public Civitai images.
 *
 * 🔴 STILL THE BRIDGE, DELIBERATELY, AND THE SDK SAYS SO: the host draws the
 * viewer's confirmation and binds what they were shown to what gets written, so
 * `PUBLISH_GENERATION_OUTPUTS` is *"not getting a plain REST equivalent … Moving
 * it would remove a consent control, not relocate one"* (`BREAKING.md` § Post
 * creation stays on the bridge). It is carried on `app.host`.
 *
 * ⚠ `title` IS DROPPED, and that costs this app nothing: the SDK's signature is
 * `{ workflowId, imageIndexes? }` because `title` *"reached the host's validator
 * and was then discarded before the mutation"*. `publishMatrix`
 * (`src/gallery.ts`) calls `deps.publish({ workflowId, imageIndexes: [0] })` and
 * has never passed one — the gallery row's title is a SHARED-STORAGE value, not
 * an image field. The parameter stays in the signature so `PublishDeps` is
 * satisfied structurally, and is explicitly not forwarded.
 */
export function usePublishGenerationOutputs(): {
  publish: (args: {
    workflowId: string;
    imageIndexes?: number[];
    title?: string;
  }) => Promise<number[]>;
} {
  const publish = useCallback(
    async (args: { workflowId: string; imageIndexes?: number[]; title?: string }) =>
      host().publishGenerationOutputs({
        workflowId: args.workflowId,
        ...(args.imageIndexes === undefined ? {} : { imageIndexes: args.imageIndexes }),
      }),
    [],
  );
  return useMemo(() => ({ publish }), [publish]);
}

// ---------------------------------------------------------------------------
// Group 3 — REST
// ---------------------------------------------------------------------------

/**
 * Per-(app, viewer) KV.
 *
 * Returns a STABLE façade whose methods await the AppClient internally, rather
 * than `StorageClient | null`. Two reasons, both load-bearing:
 *   - the object goes into `useEffect` dependency arrays (`App.tsx` passes
 *     `storage` to the run-restore and history effects), and the bridge hook
 *     documented itself as stable;
 *   - a `null` would make every call site grow a branch for a state that lasts
 *     milliseconds and that the app already gates on `ready`.
 *
 * ⚠ ONE MIGRATION DELTA THE APP ALREADY HANDLES: an ANONYMOUS viewer now gets
 * **403** where the bridge resolved an anonymous read to `null`. Every consumer
 * here is already gated on `viewer` (`App.tsx`'s restore and history effects both
 * return early when `!viewer`), so no call site had to change — recorded because
 * a future consumer that skips that gate would read a rejection, not an empty
 * store.
 */
export function useAppStorage(): StorageClient {
  return useMemo<StorageClient>(
    () => ({
      get: async (key, opts) => (await app()).storage.get(key, opts),
      set: async (key, value, opts) => (await app()).storage.set(key, value, opts),
      delete: async (key, opts) => (await app()).storage.delete(key, opts),
      list: async (query, opts) => (await app()).storage.list(query, opts),
      getQuota: async (opts) => (await app()).storage.getQuota(opts),
    }),
    [],
  );
}

/**
 * Where the shared-storage ops the SDK does not carry live, relative to the site
 * base URL.
 *
 * 🔴 SPELLED OUT HERE BECAUSE THE SDK DELIBERATELY DOES NOT CARRY THEM.
 * `starters#479` decided `AppClient.sharedStorage` is GENERIC KEY-VALUE ONLY —
 * `list`/`get`/`append`/`update`/`withdraw`. `vote`, `unvote`, `counts`, `top`,
 * `increment` and `report` are app-layer by that decision, so the eleven routes
 * existing is *not* a gap the SDK is expected to close, and adding a
 * platform-shaped helper to this file would be re-litigating it.
 *
 * Verified against the routes rather than guessed (civitai `origin/main`,
 * `src/pages/api/v1/blocks/shared-storage/{vote,unvote,report}.ts`), all three
 * POST under scope `apps:storage:shared:write`:
 *
 *   vote(key)            -> `{ count }`   the row's new aggregate tally
 *   unvote(key)          -> `{ count }`
 *   report(key, reason?) -> `{ ok: true }`
 *
 * `voteSharedRow`'s own body records the property that makes a retry safe: an
 * "atomic insert-gated counter", so a double vote is a no-op and the tally never
 * inflates. `reportSharedRow` dedups a repeat report by the same reporter.
 */
const SHARED_VOTE_ROUTE = 'blocks/shared-storage/vote';
const SHARED_UNVOTE_ROUTE = 'blocks/shared-storage/unvote';
const SHARED_REPORT_ROUTE = 'blocks/shared-storage/report';

/**
 * The shared-storage operations this app performs. Seven of the eleven routes:
 * five from the SDK client (`list`/`get`/`append`/`update`/`withdraw`), and
 * `vote`/`unvote`/`report` app-layer over `app.site` per the decision recorded on
 * the route constants above.
 */
export interface SharedStorageFacade {
  list(query?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    items: SharedItem[];
    nextCursor?: string;
  }>;
  get(key: string): Promise<SharedItem | null>;
  append(value: SharedValue): Promise<{ key: string }>;
  update(key: string, value: SharedValue): Promise<void>;
  withdraw(key: string): Promise<{ ok: boolean; deleted: boolean }>;
  vote(key: string): Promise<number>;
  unvote(key: string): Promise<number>;
  report(key: string, reason?: string): Promise<void>;
}

/**
 * Read a `{ count }` reply as a number, or FAIL.
 *
 * 🔴 ASSERTED, NOT COERCED. `Number(undefined)` is `NaN` and `?? 0` would report
 * a vote that did not land as a tally of zero — and this number is written
 * straight onto the gallery entry the viewer is looking at
 * (`patchEntry({ count })`), so a silent 0 would render "0 votes" for a row that
 * has them. A malformed reply is a failure, not a count.
 */
function countOf(route: string, reply: { count?: unknown } | undefined): number {
  if (typeof reply?.count !== 'number' || !Number.isFinite(reply.count)) {
    throw new Error(`${route}: reply carried no numeric \`count\``);
  }
  return reply.count;
}

/**
 * Cross-user shared storage — the gallery index every viewer of this app reads.
 *
 * Stable identity, for the same reason as `useAppStorage`: `App.tsx` puts
 * `shared` in the gallery-load effect's dependency array.
 *
 * ⚠ `SharedItem.value` IS `unknown` HERE AND WAS THE WRITE SHAPE ON THE BRIDGE,
 * and that is the wire-honest reading rather than a loss of typing: a listed row
 * was written by some OTHER viewer's copy of this app, possibly an older or newer
 * version, so its shape is a fact about stored data and not a promise a client
 * can keep. `gallery.ts`'s `toGalleryEntry` already validates every field it
 * reads (`isObj(value) && typeof value.title === 'string'`, then
 * `parseGalleryData`), so the narrowing this demands was already written — see
 * the widened `SharedItemLike.value` there.
 */
export function useSharedStorage(): SharedStorageFacade {
  return useMemo<SharedStorageFacade>(
    () => ({
      list: async (query) => (await app()).sharedStorage.list(query),
      get: async (key) => (await app()).sharedStorage.get(key),
      append: async (value) => (await app()).sharedStorage.append(value),
      // The bridge hook resolved `void`; the SDK client resolves `{ ok: true }`.
      // `PublishDeps.update` is declared `Promise<void>`, so the reply is dropped
      // here rather than widening the app's own contract for a constant.
      update: async (key, value) => {
        await (await app()).sharedStorage.update(key, value);
      },
      withdraw: async (key) => (await app()).sharedStorage.withdraw(key),
      vote: async (key) =>
        countOf(
          SHARED_VOTE_ROUTE,
          await (await site()).post<{ count?: unknown }>(SHARED_VOTE_ROUTE, { key }),
        ),
      unvote: async (key) =>
        countOf(
          SHARED_UNVOTE_ROUTE,
          await (await site()).post<{ count?: unknown }>(SHARED_UNVOTE_ROUTE, { key }),
        ),
      report: async (key, reason) => {
        await (await site()).post(SHARED_REPORT_ROUTE, {
          key,
          ...(reason === undefined ? {} : { reason }),
        });
      },
    }),
    [],
  );
}

// ---------------------------------------------------------------------------
// Group 3 — the money path
// ---------------------------------------------------------------------------

/**
 * Where the block workflow money path lives.
 *
 * 🔴 `app.site`, NOT `app.orchestration`, AND THIS IS THE SHARPEST TRAP IN THE
 * WHOLE MIGRATION BECAUSE THE WRONG VERSION COMPILES. `BREAKING.md` § *What a
 * direct orchestrator call loses* states it outright: substituting
 * `app.orchestration` for these routes *"type-checks and passes tests"* while
 * dropping server-side policy no local check can miss — the per-call `buzzBudget`
 * and the per-viewer/per-app daily spend caps, the viewer's browsing-level
 * maturity clamp, and per-app attribution. These five routes delegate to the SAME
 * procedures the bridge messages called, so they keep all of it.
 *
 * Verified against the route files (civitai `origin/main`,
 * `src/pages/api/v1/blocks/workflows/*.ts`) — all POST, all bound to scope
 * `ai:write:budgeted`, and all four of the ones used here reply with the snapshot
 * WRAPPED as `{ snapshot }` (`blocks.router.ts` — `estimateCustomComfyWorkflow`,
 * `submitCustomComfyWorkflow`, `pollWorkflow` and `cancelWorkflow` each return
 * `{ snapshot }` and the routes `res.json(result)` it unchanged). `query` is the
 * one that does not: it replies `{ workflows, cursor }`.
 */
const WORKFLOW_ESTIMATE_ROUTE = 'blocks/workflows/estimate';
const WORKFLOW_SUBMIT_ROUTE = 'blocks/workflows/submit';
const WORKFLOW_POLL_ROUTE = 'blocks/workflows/poll';
const WORKFLOW_CANCEL_ROUTE = 'blocks/workflows/cancel';
const WORKFLOW_QUERY_ROUTE = 'blocks/workflows/query';

/** The sentinel `workflowId` the platform stamps on a synthesised failure. */
const HOST_SYNTHESISED_WORKFLOW_ID = 'failed';

/**
 * An idempotency key for one logical submit.
 *
 * 🔴 THE REST ROUTE REQUIRES ONE WHERE THE BRIDGE HOOK MINTED IT FOR YOU, and
 * that difference is invisible until a submit 400s. `submit.ts`'s body schema is
 * `{ body, idempotencyKey: z.string().regex(BLOCK_IDEMPOTENCY_KEY_REGEX) }` —
 * NOT `.optional()` — while `useBuzzWorkflow.submit`'s `idempotencyKey` was an
 * option and `generateIdempotencyKey()` filled it in. `App.tsx` calls
 * `submit(body)` with no options, so minting here is what keeps that call site
 * working.
 *
 * The regex is `/^[A-Za-z0-9_-]{1,64}$/` (`block-gen-idempotency.ts:77`), which a
 * `crypto.randomUUID()` satisfies. The fallback matters: `randomUUID` is absent
 * in non-secure contexts and in some test environments, and a key that fails the
 * regex is a 400 on the SPEND path.
 */
function mintIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/**
 * The bridge's `WorkflowEstimateError`, reproduced BYTE-FOR-BYTE in `message`.
 *
 * 🔴 THE MESSAGE IS PART OF THE CONTRACT, NOT DECORATION. `App.tsx`'s estimate
 * `catch` runs `isIncompatibleResourceError(err.message)`, and `matrix.ts`
 * classifies purely by substring. Changing this sentence changes which cells
 * render muted-`blocked` rather than red-`failed` — a UI change smuggled inside a
 * transport port. So the text, the `name`, the `code` values and the `snapshot`
 * property all match `@civitai/blocks-react@0.47.0`'s class exactly.
 */
export class WorkflowEstimateError extends Error {
  readonly code: 'failed' | 'no-cost';
  readonly snapshot: BlockWorkflowSnapshot;
  constructor(snapshot: BlockWorkflowSnapshot, code: 'failed' | 'no-cost') {
    super(`estimate did not return a usable price (${code}) — reason on .snapshot.error`);
    this.name = 'WorkflowEstimateError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

export type WorkflowSubmitErrorCode = 'exception' | 'workflow-failed';

/** The bridge's `WorkflowSubmitError`, reproduced for the same reason. */
export class WorkflowSubmitError extends Error {
  readonly code: WorkflowSubmitErrorCode;
  readonly snapshot: BlockWorkflowSnapshot;
  constructor(snapshot: BlockWorkflowSnapshot, code: WorkflowSubmitErrorCode) {
    super(`submit did not return a usable workflow (${code}) — reason on .snapshot.error`);
    this.name = 'WorkflowSubmitError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

/** Pull the snapshot out of a `{ snapshot }` reply, or say the reply was malformed. */
function snapshotOf(route: string, reply: { snapshot?: unknown } | undefined): BlockWorkflowSnapshot {
  const snapshot = reply?.snapshot as BlockWorkflowSnapshot | undefined;
  if (snapshot == null || typeof snapshot.status !== 'string') {
    throw new Error(`${route}: malformed response (no snapshot)`);
  }
  return snapshot;
}

export interface BuzzWorkflowValue {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (
    body: WorkflowBody,
    options?: { idempotencyKey?: string },
  ) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  cancel: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
}

/**
 * The four money-path operations `App.tsx` destructures — estimate, submit, poll,
 * cancel. The bridge hook also exposed `watch`, `status`, `result` and `error`;
 * this app reads none of them (it drives its own bounded poll loop with its own
 * backoff in `runPollLoop`), so they are deliberately absent rather than carried
 * as untested surface.
 *
 * 🔴 EVERY THROW RULE BELOW IS COPIED FROM THE BRIDGE HOOK, NOT INVENTED, and
 * the two that matter are asymmetric in a way that looks like a bug and is not:
 *
 *   - `estimate` throws when the snapshot is `failed`, AND when it carries no
 *     numeric `cost.total`.
 *   - `submit` throws ONLY when the snapshot is `failed` **and** `cost.total` is
 *     not a number.
 *
 * That second condition is what routes the INSUFFICIENT-BUZZ case through the
 * RESULT rather than the throw: the platform answers a budget refusal with
 * `{ workflowId: 'failed', status: 'failed', cost: { total: ceiling }, error:
 * 'insufficient buzz budget: …' }` — a failed snapshot that DOES carry a cost —
 * so `submit` returns it, `App.tsx` dispatches `CELL_RESULT`, and
 * `cellStatusForSnapshot` reads `snapshot.error` to land the cell on
 * `insufficient` with its Top-Up CTA. Tightening this to "throw on any failed
 * status" would silently replace that CTA with a generic red failure.
 *
 * ⚠ ONE BEHAVIOUR DIFFERENCE THE TRANSPORT FORCES, reported rather than hidden.
 * On the bridge, a host-side tRPC throw was wrapped by host chrome into a
 * `failureSnapshot` (`civitai src/components/AppBlocks/failureSnapshot.ts`) whose
 * reason sat on `snapshot.error`, so `App.tsx`'s `err.message` checks could never
 * see it — an incompatible LoRA × checkpoint pairing therefore reached the viewer
 * as plain `failed`. Over REST the same throw is `handleEndpointError`, so it
 * arrives as an `ApiError` whose `message` IS the server's sentence, and those
 * checks start matching. The port does not choose this: the host-chrome wrapper
 * is simply not in the path any more. The direction is toward the classification
 * the code always intended (`blocked`/`insufficient` instead of `failed`), and no
 * spend decision depends on it — the cap, the confirm gate and the per-cell
 * budget are all upstream of the reply.
 */
export function useBuzzWorkflow(): BuzzWorkflowValue {
  return useMemo<BuzzWorkflowValue>(
    () => ({
      estimate: async (body) => {
        const snapshot = snapshotOf(
          WORKFLOW_ESTIMATE_ROUTE,
          await (await site()).post<{ snapshot?: unknown }>(WORKFLOW_ESTIMATE_ROUTE, { body }),
        );
        if (snapshot.status === 'failed') throw new WorkflowEstimateError(snapshot, 'failed');
        if (typeof snapshot.cost?.total !== 'number') {
          throw new WorkflowEstimateError(snapshot, 'no-cost');
        }
        return snapshot;
      },

      submit: async (body, submitOptions) => {
        const idempotencyKey = submitOptions?.idempotencyKey ?? mintIdempotencyKey();
        const snapshot = snapshotOf(
          WORKFLOW_SUBMIT_ROUTE,
          await (await site()).post<{ snapshot?: unknown }>(WORKFLOW_SUBMIT_ROUTE, {
            body,
            idempotencyKey,
          }),
        );
        if (snapshot.status === 'failed' && typeof snapshot.cost?.total !== 'number') {
          throw new WorkflowSubmitError(
            snapshot,
            snapshot.workflowId === HOST_SYNTHESISED_WORKFLOW_ID ? 'exception' : 'workflow-failed',
          );
        }
        return snapshot;
      },

      poll: async (workflowId) =>
        snapshotOf(
          WORKFLOW_POLL_ROUTE,
          await (await site()).post<{ snapshot?: unknown }>(WORKFLOW_POLL_ROUTE, { workflowId }),
        ),

      cancel: async (workflowId) =>
        snapshotOf(
          WORKFLOW_CANCEL_ROUTE,
          await (await site()).post<{ snapshot?: unknown }>(WORKFLOW_CANCEL_ROUTE, { workflowId }),
        ),
    }),
    [],
  );
}

export interface AppWorkflowsValue {
  workflows: AppWorkflow[];
  cursor: string | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * This app's own recent workflows — the authoritative read-model `persistence.ts`
 * reconciles a restored run against (status / image / nsfwLevel / cost).
 *
 * 🔴 `POST blocks/workflows/query`, NOT `orchestration.queryWorkflows({ tags })`,
 * and the reason is a trust boundary rather than a shape: *"the route forces the
 * app tag server-side from the verified token; the client takes `tags` from the
 * caller. Swapping one for the other relocates a trust boundary into the iframe,
 * and nothing about the call site looks different"* (`BREAKING.md`). The route
 * replies `{ workflows, cursor }` (`blocks.router.ts` `queryAppWorkflows`).
 *
 * 🔴 LATE REPLIES ARE DROPPED ON UNMOUNT, which the bridge hook also did. Under
 * React 18+ a `setState` after unmount is a silent no-op rather than a warning,
 * so this guard is invisible to a mutation that deletes it — it is here for the
 * abandoned-fetch case (a `refetch` in flight when the run view closes), not for
 * a console warning that no longer exists.
 */
export function useAppWorkflows(): AppWorkflowsValue {
  const [workflows, setWorkflows] = useState<AppWorkflow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const reply = await (
          await site()
        ).post<{ workflows?: AppWorkflow[]; cursor?: string | null }>(WORKFLOW_QUERY_ROUTE, {});
        if (!current || !live.current) return;
        setWorkflows(reply?.workflows ?? []);
        setCursor(reply?.cursor ?? null);
      } catch (cause) {
        if (!current || !live.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (current && live.current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return useMemo(
    () => ({ workflows, cursor, loading, error, refetch }),
    [workflows, cursor, loading, error, refetch],
  );
}

/**
 * The per-viewer GATED image read, for the gallery.
 *
 * 🔴 `blocks/gated-images`, AND `BREAKING.md` NAMES THE WRONG ROUTE. Its
 * migration table maps `GET_IMAGES_BY_IDS` to `GET /api/v1/blocks/images?ids=`;
 * that route cannot serve this call, and the reason is in `gated-images.ts`'s own
 * docblock: the two corpora are COMPLEMENTARY. `blocks/images` searches the
 * Meilisearch images index, whose source query hard-filters
 * `i."postId" IS NOT NULL`; this route's corpus is exactly the complement —
 * `postId IS NULL`, further scoped to `blockPublishedAppId = claims.appId`, i.e.
 * the images THIS app published through its own workflows. So `blocks/images?ids=`
 * *"returns an EMPTY ARRAY for every id in this route's corpus — at any ceiling,
 * for any viewer, forever"*, which would have read as an entire gallery of
 * silently-gone images rather than as an error.
 *
 * The right route is `GET /api/v1/blocks/gated-images?ids=1,2,3` →
 * `{ images: BlockGatedImage[] }`, a thin adapter over the SAME
 * `resolveGatedImagesForBlockClaims` the bridge procedure called; it requires any
 * valid block token and declares NO scope.
 *
 * 🔴 MISSES ARE REPORTED BY OMISSION, so the reply may be SHORTER than the
 * request and its order carries no meaning — `indexGatedImages` in `gallery.ts`
 * keys on `imageId` for exactly that reason.
 *
 * ⚠ PRE-EXISTING, NOT INTRODUCED: the route caps `ids` at `IMAGE_IDS_BATCH_MAX`
 * (100), held equal to the bridge procedure's own inline `.max(100)` by a parity
 * test, while `MAX_GATED_IMAGE_IDS` in `gallery.ts` is `GALLERY_LIST_CAP *
 * MAX_GALLERY_IMAGES` = 144. A fully-populated gallery therefore over-asks on
 * BOTH transports and the read fails the same way (the app renders its honest
 * "could not read" state). Left as found — narrowing that cap is a `gallery.ts`
 * change, not a transport one.
 */
export function useGatedImages(): { getImages: (imageIds: number[]) => Promise<BlockGatedImage[]> } {
  const getImages = useCallback(async (imageIds: number[]) => {
    const reply = await (
      await site()
    ).get<{ images?: BlockGatedImage[] }>('blocks/gated-images', {
      query: { ids: imageIds.join(',') },
    });
    return reply?.images ?? [];
  }, []);
  return useMemo(() => ({ getImages }), [getImages]);
}
