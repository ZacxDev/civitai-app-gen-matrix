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
 * The request-shaped host operations this app performs, each with the reply
 * message the bridge requires the caller to NAME.
 *
 * 🔴 The SDK's `request(type, params)` does NOT carry a response type — it
 * assumes the transport knows. The bridge's `sendRequest` REQUIRES one
 * (`sendTypedRequest(t, req, responseType)`), so the mapping has to live here.
 *
 * Every pairing below is verified THREE ways against the installed
 * `@civitai/blocks-react@0.47.0` — the hook that issues it, the mock host that
 * answers it (`internal/mockHost.js`), and the inbound validator
 * (`internal/validate.js`) — and cross-checked against `@civitai/sdk@0.8.0`'s
 * OWN table (`dist/core/transports/iframe-transport.js`, `LEGACY_REPLIES`),
 * which agrees on all four:
 *
 *   REQUEST_TOKEN               -> TOKEN_REFRESH_RESPONSE   (useBlockToken.js:73)
 *   OPEN_RESOURCE_PICKER        -> RESOURCE_PICKER_RESULT   (useResourcePicker.js:41)
 *   OPEN_BUZZ_PURCHASE          -> BUZZ_PURCHASE_RESULT     (useBuzzPurchase.js:24)
 *   PUBLISH_GENERATION_OUTPUTS  -> PUBLISH_RESULT           (usePublishGenerationOutputs.js:33)
 *
 * The SDK issues two more (`SAVE_IMAGE`, `OPEN_IMAGE_UPLOAD`); this app calls
 * neither `host.download` nor `host.openImageUpload`, so they are deliberately
 * absent rather than copied in untested.
 *
 * An unmapped type THROWS rather than guessing: a wrong reply type hangs the
 * request until its timeout and surfaces as a dead host.
 */
const RESPONSE_TYPE: Readonly<Record<string, string>> = Object.freeze({
  REQUEST_TOKEN: 'TOKEN_REFRESH_RESPONSE',
  OPEN_RESOURCE_PICKER: 'RESOURCE_PICKER_RESULT',
  OPEN_BUZZ_PURCHASE: 'BUZZ_PURCHASE_RESULT',
  PUBLISH_GENERATION_OUTPUTS: 'PUBLISH_RESULT',
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
 * The SDK's snapshot is the bridge's plus `hostOrigin`, which the bridge exposes
 * as a separate accessor.
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

  return function get() {
    const base = bridge.getSnapshot();
    const hostOrigin = bridge.getHostOrigin();
    if (base === lastBase && hostOrigin === lastHostOrigin) {
      return lastComposed;
    }
    lastBase = base;
    lastHostOrigin = hostOrigin;
    lastComposed = { ...base, hostOrigin };
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
      const responseType = RESPONSE_TYPE[type];
      if (!responseType) {
        throw new Error(
          `sdk-transport: no response type mapped for request '${type}'. ` +
            'The bridge requires the caller to name the reply message; add it to ' +
            'RESPONSE_TYPE with a source for the pairing rather than guessing, ' +
            'because a wrong reply type hangs until timeout and reads as a dead host.',
        );
      }
      const inflight = sendTypedRequest(
        bridge,
        { type, payload: params } as Parameters<typeof sendTypedRequest>[1],
        responseType as Parameters<typeof sendTypedRequest>[2],
        // 🔴 NOT a pass-through, and not castable: the SDK's opts is
        // `{ signal?: AbortSignal }` and the bridge's is `{ timeoutMs?: number }`
        // — no common property. Casting one to the other would compile and
        // silently discard the caller's cancellation, so the signal is honoured
        // below instead of smuggled through a cast.
        undefined,
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
