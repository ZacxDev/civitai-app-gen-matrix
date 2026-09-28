/**
 * Adapts the `@civitai/blocks-react` transport singleton to the `BlockTransport`
 * interface `@civitai/sdk`'s `initialize({ transport })` accepts.
 *
 * WHY THIS EXISTS — and why it is not just `initialize()` with no argument:
 * `@civitai/blocks-react/ui` stays on the bridge until
 * `civitai/civitai-app-starters#328` lands, and this app's `/ui` consumers reach
 * the bridge transport SINGLETON:
 *
 *   - `BlockGate` wraps the PRODUCTION root (`src/main.tsx`)
 *       -> `useDirectLoad` -> `useTransportSnapshot` -> `getTransport()`
 *   - `ReportButton` (`src/GalleryPanel.tsx`) and `ResourceCard`/`Badge`
 *       (`src/App.tsx`, `src/ResourceBrowser.tsx`) come from the same pack.
 *
 * So the bridge transport is constructed on every production boot. A bare
 * `initialize()` would stand up a SECOND transport beside it: two `message`
 * listeners, two `BLOCK_HELLO` senders, two `BLOCK_READY` auto-senders, two
 * token copies and two `TOKEN_REFRESH` handlers. Whether the host tolerates two
 * `BLOCK_READY`s from one frame is a PLATFORM question nobody has measured, and
 * this block spends the viewer's Buzz — it does not ship an unverified protocol
 * change. One transport, adapted.
 *
 * Delete this file and switch to a plain `initialize()` once `/ui` no longer
 * imports from `@civitai/blocks-react` (starters#328).
 */
import { getTransport, sendTypedRequest } from '@civitai/blocks-react';
import type { BlockTransport as BridgeTransport } from '@civitai/blocks-react';
import { BridgeError } from '@civitai/sdk';

/**
 * `HUMAN_INTERACTION_TIMEOUT_MS` from `@civitai/blocks-react`'s
 * `internal/requestTimeouts.js` (`10 * 60_000`), which that package does not
 * export — so it is restated here with its source rather than reached for.
 *
 * Exported so a test can assert the number that actually goes on the wire
 * instead of re-deriving it.
 */
export const HUMAN_INTERACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * One row per request-shaped host operation this app performs: the reply message
 * the bridge requires the caller to NAME, and the deadline it requires the caller
 * to CHOOSE.
 *
 * 🔴 THE BRIDGE REQUIRES BOTH AND THE SDK NAMES NEITHER, WHICH IS WHY THEY LIVE
 * IN ONE TABLE. The SDK's `request(type, params, { signal })` carries no response
 * type and no timeout — it assumes the transport knows. The bridge's
 * `sendRequest(request, responseType, opts = {})` requires the first and applies
 * `DEFAULT_REQUEST_TIMEOUT_MS` (30s) for the second whenever `opts.timeoutMs` is
 * absent (`internal/iframeTransport.js`:209-217). Keeping the pairing and the
 * bound in the same row is the point: they are two halves of one decision per
 * type, and an `undefined` fourth argument is not a neutral default — it SELECTS
 * the wrong bucket.
 *
 * 🔴 `timeoutMs` IS NOT POLISH ON A HUMAN-GATED REQUEST — OMITTING IT REINTRODUCES
 * civitai/civitai#4158, VERBATIM. `@civitai/blocks-react`'s own ledger
 * (`internal/requestTimeouts.js`) buckets every block→parent message by the one
 * question that decides it — *does the reply wait for a person to act?* — and
 * files `OPEN_BUZZ_PURCHASE`, `OPEN_RESOURCE_PICKER` and
 * `PUBLISH_GENERATION_OUTPUTS` as `'human'` with a TEN-MINUTE bound. Its comment
 * on that constant is the incident: `PUBLISH_GENERATION_OUTPUTS` shipped on the
 * 30s default and *"rejected mid-dialog … the generation had already been billed,
 * the publish bridge died at 30s, the outputs reached nothing, and there is no
 * refund path for a dead bridge, so the viewer simply paid for nothing."*
 *
 * In THIS app the damage does not stop at one lost publish. `publishMatrix`
 * (`src/gallery.ts`) calls `publish()` once per cell of a matrix the viewer has
 * already been charged for, and `App.tsx` writes the per-cell publish ledger
 * (`PUBLISHED_CELLS_STORAGE_KEY`) only from what `publishMatrix` reports as
 * LANDED. A 30s rejection against a host that then publishes anyway leaves the
 * images existing as permanent public rows with the ledger empty — so the control
 * re-arms and a second press mints a SECOND permanent public image of the same
 * paid output. That ledger exists precisely to make that impossible.
 *
 * `REQUEST_TOKEN` is `'protocol'` in the same ledger, so it takes the bridge's
 * default — recorded as `undefined` explicitly so a reader sees a decision rather
 * than an omission.
 *
 * Every reply pairing below is verified THREE ways against the installed
 * `@civitai/blocks-react@0.47.0` — the hook that issues it, the mock host that
 * answers it (`internal/mockHost.js`), and the inbound validator
 * (`internal/validate.js`) — and cross-checked against `@civitai/sdk@0.8.0`'s
 * OWN table (`dist/core/transports/iframe-transport.js`, `LEGACY_REPLIES`),
 * which agrees on all four:
 *
 *   REQUEST_TOKEN               -> TOKEN_REFRESH_RESPONSE   (useBlockToken.js:73)        protocol
 *   OPEN_RESOURCE_PICKER        -> RESOURCE_PICKER_RESULT   (useResourcePicker.js:41)    human
 *   OPEN_BUZZ_PURCHASE          -> BUZZ_PURCHASE_RESULT     (useBuzzPurchase.js:24)      human
 *   PUBLISH_GENERATION_OUTPUTS  -> PUBLISH_RESULT           (usePublishGenerationOutputs.js:33) human
 *
 * The SDK issues two more (`SAVE_IMAGE`, `OPEN_IMAGE_UPLOAD`); this app calls
 * neither `host.download` nor `host.openImageUpload`, so they are deliberately
 * absent rather than copied in untested.
 *
 * An unmapped type THROWS rather than guessing: a wrong reply type hangs the
 * request until its timeout and surfaces as a dead host.
 */
interface BridgeRequestBinding {
  readonly responseType: string;
  /**
   * `undefined` means "the bridge's own 30s default" — spelled out so a
   * `'protocol'` bucketing reads as a choice, not as a forgotten argument.
   */
  readonly timeoutMs?: number;
}

const BRIDGE_REQUESTS: Readonly<Record<string, BridgeRequestBinding>> = Object.freeze({
  REQUEST_TOKEN: { responseType: 'TOKEN_REFRESH_RESPONSE' },
  OPEN_RESOURCE_PICKER: {
    responseType: 'RESOURCE_PICKER_RESULT',
    timeoutMs: HUMAN_INTERACTION_TIMEOUT_MS,
  },
  OPEN_BUZZ_PURCHASE: {
    responseType: 'BUZZ_PURCHASE_RESULT',
    timeoutMs: HUMAN_INTERACTION_TIMEOUT_MS,
  },
  PUBLISH_GENERATION_OUTPUTS: {
    responseType: 'PUBLISH_RESULT',
    timeoutMs: HUMAN_INTERACTION_TIMEOUT_MS,
  },
});

/**
 * Turn a bridge reply PAYLOAD into the value the SDK's `request()` contract says
 * it resolves.
 *
 * 🔴 THIS IS NOT A PASS-THROUGH, AND A PASS-THROUGH SILENTLY BREAKS PUBLISHING
 * AFTER THE VIEWER HAS ALREADY PAID. The two packages disagree about what
 * `request()` resolves:
 *
 *   - the bridge's `sendTypedRequest` resolves the RAW reply payload and never
 *     rejects on a payload-level `error` (`internal/iframeTransport.js` —
 *     `pending.resolve(payload)`; each consuming hook unwraps for itself);
 *   - the SDK's `request()` resolves the UNWRAPPED RESULT and throws a
 *     `BridgeError` on failure (`dist/core/transports/iframe-transport.js` —
 *     `unwrap(type, await this.#exchange(...), framing)`).
 *
 * For three of the four types above the two happen to coincide, because the
 * host puts the fields straight in the payload and the SDK reads one of them by
 * name (`.token`, `.selected`, `.purchased`) — an extra `requestId` alongside is
 * harmless. `PUBLISH_GENERATION_OUTPUTS` is the one that does NOT: the host
 * nests its value, replying `{ requestId, result: { imageIds } }`
 * (`internal/mockHost.js:1364`, and `usePublishGenerationOutputs.js` reads
 * `reply.result.imageIds`), while the SDK destructures `{ imageIds }` off the
 * TOP level. A raw pass-through therefore resolves `imageIds: undefined` for a
 * publish that SUCCEEDED — and this app calls `publish()` once per cell of a
 * matrix the viewer has already been charged for, so the images would be
 * created as permanent public rows with the app believing nothing was published.
 *
 * So this replicates the SDK's own `fromLegacyReply` + `unwrap` rather than
 * approximating them: strip `requestId`, treat a NON-EMPTY `error` string as a
 * failure (the host spells "no failure" as `error: ''`), and take `result` when
 * the payload nests one.
 */
function unwrapBridgeReply(type: string, payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') {
    throw new BridgeError('malformed', type, `${type} replied with no payload`);
  }
  const { requestId: _requestId, error, ...fields } = payload as Record<string, unknown>;

  // 🔴 `error !== ''` IS THE WHOLE TEST, AND IT IS NOT DEFENSIVE POLISH. The
  // host's `PUBLISH_RESULT` spells "no failure" as the EMPTY STRING, and
  // `@civitai/blocks-react`'s own hook documents the same trap (`||` not `??`,
  // "a host `error: ''` is a VALID reply"). Treating `''` as a failure would
  // reject every successful publish with an Error carrying no message.
  if (typeof error === 'string' && error !== '') {
    // The free-text host message is carried through VERBATIM, because this app
    // classifies spend failures by substring (`isInsufficientBuzz`,
    // `isIncompatibleResourceError` in `matrix.ts`). A code without the sentence
    // would make both of those blind.
    throw new BridgeError('unavailable', type, error);
  }

  // The host was never consistent: some replies nest under `result`, others put
  // the fields straight in the payload. Mirrors the SDK's own comment.
  const result = 'result' in fields ? fields.result : fields;

  // 🔴 A REPLY CARRYING NEITHER A RESULT NOR AN ERROR IS MALFORMED, NOT EMPTY, and
  // the SDK's own `unwrap` refuses it for the same reason: returning `undefined`
  // from a call whose signature says `number[]` would read to the caller as
  // "nothing published", which is a GUESS — the images may well exist. The flat
  // case cannot reach this (it returns the field bag, which is at worst `{}`, and
  // the host client's own guard covers that); the nesting case can, whenever the
  // host sends `result` and drops its value.
  if (result === undefined) {
    throw new BridgeError('malformed', type, `${type} reply carried no result`);
  }
  return result;
}

/**
 * The token `kind` this app's host mints, restated here because the bridge drops
 * the field on the way in.
 *
 * 🔴 THIS IS A CLAIM ABOUT THIS BLOCK'S MANIFEST, NOT A DEFAULT. `@civitai/sdk`
 * documents `kind` as *"`block` is accepted only by the host; `oauth` also by the
 * API and orchestrator. Older hosts send none"* (`core/handshake.d.ts`), and its
 * own guard treats an ABSENT `kind` as "not evidence of a block token" so it
 * behaves as it did before the field existed. Stamping `'block'` is therefore only
 * legitimate where the block cannot receive any other kind — and this one cannot:
 * `block.manifest.json` declares no `auth: "oauth"`, so the host mints a
 * block-scoped JWT and nothing else. Add that opt-in to the manifest and this line
 * becomes a lie; it is spelled as a named constant beside the reason for exactly
 * that reason.
 */
const BLOCK_TOKEN_KIND = 'block' as const;

/**
 * Compose the SDK's snapshot out of the bridge's.
 *
 * 🔴 THERE ARE **TWO** DELTAS AND ONLY ONE OF THEM IS A TOP-LEVEL FIELD. Measured
 * against `@civitai/blocks-react@0.47.0` and `@civitai/sdk@0.8.0`:
 *
 *   - `hostOrigin` — present on the SDK's `BlockSnapshot`, absent from the
 *     bridge's snapshot object, which exposes it through a separate
 *     `getHostOrigin()` accessor instead;
 *   - `token.kind` — NESTED, and therefore invisible to a field-by-field
 *     comparison of the two snapshot types. `@civitai/sdk`'s `tokenFromWrapped`
 *     carries it (`dist/core/transport.js:30-38`); the bridge's function of the
 *     same name builds `{ raw, scopes, expiresAt, buzzBudget }` and DROPS it
 *     (`dist/internal/transport.js:157-164`), and the bridge's own `BlockToken`
 *     type does not declare it.
 *
 * (The bridge's extra `appId`/`blockId` go the other way and are simply ignored.)
 *
 * The rest of the surface was swept for the same shape — a value the bridge expects
 * or the SDK reads that this adapter omits — and it comes back clean, recorded so
 * the next reader does not re-derive it:
 *   - `sendTypedRequest`'s fourth argument: WAS being passed `undefined`, which is
 *     the defect `BRIDGE_REQUESTS` above now closes. It is the only argument of the
 *     bridge's `sendRequest` that the SDK does not supply.
 *   - `notify` (`{ type, payload }`) and `on` (`type`, `handler`) are the bridge's
 *     full signatures for `sendMessage`/`onMessage`; nothing is dropped.
 *   - `effectiveBrowsingLevel` is the one remaining SDK snapshot field the bridge
 *     never sends (zero occurrences anywhere in `@civitai/blocks-react@0.47.0`'s
 *     `dist/`), and no code READS it: `@civitai/sdk@0.8.0` only copies it inside its
 *     own snapshot builder, which this adapter replaces, and `useDomainMaturity`
 *     deliberately reads the domain ceiling instead. So there is nothing to supply
 *     and nothing depending on it — unlike `kind`, which two live guards read.
 *
 * 🔴 DROPPING `token.kind` DISARMS A PLATFORM ALARM AIMED AT THIS EXACT MIGRATION,
 * AND IT FAILS SILENT. `@civitai/sdk` gates two runtime guards on
 * `holdsBlockToken = () => snapshot().viewer !== null && snapshot().token.kind ===
 * 'block'` (`dist/app/index.js:55`):
 *
 *   - `refuseBlockToken` (`:105-111`) rejects every `app.orchestration.*` call
 *     EAGERLY, before the request, because the orchestrator accepts a block token
 *     on no route at all;
 *   - `explainApiRefusal` (`:132-155`) annotates a 401/403 outside the `blocks/*`
 *     namespace with what the token actually reaches.
 *
 * With `kind` undefined both are permanently dead. That matters here more than
 * anywhere: `sdk-runtime.ts`'s money-path docblock records `app.site` vs
 * `app.orchestration` as *"the sharpest trap in the whole migration because the
 * wrong version compiles"* — it type-checks, passes tests, and silently drops the
 * per-call `buzzBudget`, the per-viewer spend caps, the maturity clamp and per-app
 * attribution. `refuseBlockToken` is the one runtime net under that mistake, and
 * without `kind` a future substitution reaches the orchestrator, collects a bare
 * 401 and reads as a scope misconfiguration rather than as the architectural error
 * it is. So the adapter supplies the field the bridge drops.
 *
 * 🔴 IDENTITY IS LOAD-BEARING, NOT AN OPTIMISATION. `snapshot.get()` feeds
 * `useSyncExternalStore`, which bails out on `Object.is`. Composing
 * `{ ...snap, hostOrigin }` fresh on every call returns a new object every time,
 * so the store never compares equal and React re-renders forever. So: cache,
 * and recompute only when an input actually changed.
 *
 * 🔴 AND `hostOrigin` MUST COME FROM `getHostOrigin()` WITH NO FALLBACK. The
 * bridge documents it as a security invariant: the value it returns is the base
 * URL a money-scoped block bearer token is sent to, and it must only ever be an
 * origin that passed the same allowlist gate every inbound message passes.
 * `null` means "not yet established" and must stay `null` — substituting
 * `window.location.origin`, `document.referrer` or a parent's origin here would
 * turn a not-ready state into a token-exfiltration vector.
 */
function composeSnapshot(bridge: BridgeTransport) {
  let lastBase: unknown;
  let lastHostOrigin: string | null | undefined;
  let lastComposed: unknown;
  // The token wrapper is cached on the BRIDGE token's identity, separately from
  // the snapshot cache above: `hostOrigin` lands from its own accessor and can
  // move while the base snapshot does not, and re-minting the token object on that
  // event would give `useBlockToken`'s `useMemo([token])` a new identity for a
  // change that has nothing to do with the token.
  let lastToken: unknown;
  let lastWrappedToken: unknown;

  const withKind = (token: unknown) => {
    // A non-object token is passed through untouched rather than coerced into
    // `{ kind }`: inventing a token shape the bridge never produced would make
    // this adapter the source of a value the host never sent.
    if (token === null || typeof token !== 'object') return token;
    if (token === lastToken) return lastWrappedToken;
    lastToken = token;
    lastWrappedToken = { ...(token as Record<string, unknown>), kind: BLOCK_TOKEN_KIND };
    return lastWrappedToken;
  };

  return function get() {
    const base = bridge.getSnapshot();
    const hostOrigin = bridge.getHostOrigin();
    if (base === lastBase && hostOrigin === lastHostOrigin) {
      return lastComposed;
    }
    lastBase = base;
    lastHostOrigin = hostOrigin;
    lastComposed = { ...base, hostOrigin, token: withKind((base as { token?: unknown }).token) };
    return lastComposed;
  };
}

/**
 * Wrap the bridge's transport singleton for `initialize({ transport })`.
 *
 * Takes the transport as an argument (defaulting to the singleton) so tests can
 * drive it with a fake rather than standing up a real iframe transport.
 */
export function createSdkTransportAdapter(bridge: BridgeTransport = getTransport()) {
  const get = composeSnapshot(bridge);

  return {
    snapshot: {
      get,
      subscribe: (listener: () => void) => bridge.subscribe(listener),
    },

    notify: (message: { type: string; payload?: unknown }) => {
      // The bridge's outbound union is narrower than `string`; the SDK only ever
      // sends types the bridge knows, and an unknown one is rejected by the host
      // rather than silently accepted here.
      bridge.sendMessage(message as Parameters<BridgeTransport['sendMessage']>[0]);
    },

    request: async (type: string, params: unknown, opts?: { signal?: AbortSignal }) => {
      const binding = BRIDGE_REQUESTS[type];
      if (!binding) {
        throw new Error(
          `sdk-transport: no response type mapped for request '${type}'. ` +
            'The bridge requires the caller to name the reply message AND choose a ' +
            'deadline; add it to BRIDGE_REQUESTS with a source for the pairing and ' +
            "its bucket from @civitai/blocks-react's internal/requestTimeouts.js, " +
            'rather than guessing: a wrong reply type hangs until timeout and reads ' +
            'as a dead host, and a human-gated request left on the 30s default ' +
            "rejects while the viewer's dialog is still open (civitai/civitai#4158).",
        );
      }
      const inflight = sendTypedRequest(
        bridge,
        { type, payload: params } as Parameters<typeof sendTypedRequest>[1],
        binding.responseType as Parameters<typeof sendTypedRequest>[2],
        // 🔴 THE DEADLINE COMES FROM THE TABLE, AND `undefined` HERE IS NOT
        // NEUTRAL — the bridge reads `opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS`
        // (30s), so passing nothing SELECTS the protocol bucket for a request that
        // waits on a person. See `BRIDGE_REQUESTS`.
        //
        // The SDK's `opts` cannot be smuggled through here either: it is
        // `{ signal?: AbortSignal }` and the bridge's is `{ timeoutMs?: number }`
        // — no common property. Casting one to the other would compile and
        // silently discard the caller's cancellation, so the signal is honoured
        // below instead.
        binding.timeoutMs === undefined ? undefined : { timeoutMs: binding.timeoutMs },
      ) as Promise<unknown>;

      const signal = opts?.signal;
      let settled: unknown;
      if (!signal) {
        settled = await inflight;
      } else if (signal.aborted) {
        throw signal.reason ?? new Error('aborted');
      } else {
        // ⚠ HONEST LIMITATION: this rejects the CALLER's promise on abort, but the
        // bridge exposes no cancellation, so the in-flight postMessage is NOT
        // recalled and a late reply is simply dropped. That is strictly better than
        // ignoring the signal (the caller unblocks) and strictly worse than real
        // cancellation (the host still does the work) — stated rather than implied,
        // because a reader would otherwise assume `signal` cancels the host call.
        settled = await Promise.race([
          inflight,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
              once: true,
            });
          }),
        ]);
      }
      return unwrapBridgeReply(type, settled);
    },

    on: (type: string, handler: (payload: unknown) => void) =>
      bridge.onMessage(type as Parameters<BridgeTransport['onMessage']>[0], handler),
  };
}
