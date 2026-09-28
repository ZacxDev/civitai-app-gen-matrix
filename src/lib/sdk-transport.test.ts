// Tests for the one bridge transport the SDK is handed.
//
// This file runs in the `node` project (`*.test.ts`), so there is no DOM and no
// bridge singleton: `getTransport` is mocked to THROW, which is the cheapest
// possible proof that every case here drives the fake it passed in rather than a
// real iframe transport it accidentally reached.

import { describe, expect, it, vi } from 'vitest';

const sendTypedRequest = vi.hoisted(() => vi.fn());

vi.mock('@civitai/blocks-react', () => ({
  getTransport: () => {
    throw new Error('the singleton must not be reached in these tests — pass a fake');
  },
  sendTypedRequest,
}));

const { createSdkTransportAdapter, HUMAN_INTERACTION_TIMEOUT_MS } = await import(
  './sdk-transport.js'
);

/**
 * A stand-in for the bridge transport. Only the five members the adapter touches
 * are real; `getSnapshot` returns whatever object the test last set, so identity
 * is under the test's control — which is the point of most of these cases.
 */
function fakeBridge(overrides: Record<string, unknown> = {}) {
  const base = { ready: true, token: null, viewer: null } as Record<string, unknown>;
  const state = { snapshot: base, hostOrigin: null as string | null };
  const listeners = new Set<() => void>();
  const bridge = {
    getSnapshot: () => state.snapshot,
    getHostOrigin: () => state.hostOrigin,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sendMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    ...overrides,
  };
  return { bridge, state, listeners };
}

describe('sdk-transport adapter — snapshot identity', () => {
  // 🔴 THE INFINITE-RENDER REGRESSION. Composing `{ ...snap, hostOrigin }` fresh on
  // every call returns a new object each time; `useSyncExternalStore` bails out on
  // `Object.is`, so a non-memoised adapter re-renders forever. Watched to FAIL
  // against a `composeSnapshot` with the cache stripped (mutation A in the PR
  // body: `return { ...bridge.getSnapshot(), hostOrigin: bridge.getHostOrigin() }`)
  // — that turns the first two assertions red with "expected … to be … (same
  // object)".
  it('returns the SAME object identity while neither input has changed', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const a = t.snapshot.get();
    const b = t.snapshot.get();
    const c = t.snapshot.get();

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a NEW identity when the underlying snapshot changes', () => {
    const { bridge, state } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const before = t.snapshot.get();
    state.snapshot = { ready: true, token: 'fresh', viewer: null };
    const after = t.snapshot.get();

    expect(after).not.toBe(before);
    expect((after as { token: string }).token).toBe('fresh');
  });

  // The other half of the cache: a cache keyed on the BASE snapshot alone would
  // pass the case above and fail here, because `hostOrigin` arrives from a
  // separate accessor and lands AFTER `BLOCK_INIT` without the base changing.
  it('returns a NEW identity when hostOrigin alone changes', () => {
    const { bridge, state } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const before = t.snapshot.get();
    expect((before as { hostOrigin: string | null }).hostOrigin).toBeNull();

    state.hostOrigin = 'https://civitai.com';
    const after = t.snapshot.get();

    expect(after).not.toBe(before);
    expect((after as { hostOrigin: string | null }).hostOrigin).toBe('https://civitai.com');
  });

  // 🔴 SECURITY INVARIANT, not a null-handling nit. The bridge documents
  // `getHostOrigin()` as returning only an allowlist-VALIDATED origin, because the
  // value becomes the base URL a money-scoped bearer token is sent to. A
  // not-yet-established origin must stay `null`; substituting `location.origin`,
  // `document.referrer` or a parent's origin here would convert a not-ready state
  // into an exfiltration vector. This pins that the adapter invents nothing.
  it('propagates a null hostOrigin as null and never substitutes a fallback', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const snap = t.snapshot.get() as Record<string, unknown>;

    // `toBeNull()` is the WHOLE guard, and it is sufficient: any substituted
    // default — `location.origin`, `document.referrer`, `''`, a parent origin —
    // makes this non-null and fails here. Watched red against mutation B
    // (`?? 'https://civitai.com'` on the `getHostOrigin()` read).
    //
    // ⚠ DELIBERATELY NOT also asserting `not.toContain(location.origin)`: this
    // file runs in vitest's `node` environment, which defines no `location`, so
    // that would reduce to `not.toContain(undefined)` and could never fail. An
    // assertion that reads as covering the exfiltration case while covering
    // nothing is worse than its absence — it stops the next reader looking. The
    // jsdom half of that claim lives in `sdk-runtime.test.tsx`, where `location`
    // really is defined.
    expect(snap.hostOrigin).toBeNull();
  });

  it('forwards subscribe through to the bridge', () => {
    const { bridge, listeners } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const listener = vi.fn();
    const off = t.snapshot.subscribe(listener);
    expect(listeners.size).toBe(1);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe('sdk-transport adapter — the reply-type table', () => {
  // The four pairings this app's host operations depend on. Asserted as the
  // LITERAL reply names, because a wrong one does not fail loudly — it waits out
  // the bridge's request timeout and surfaces as an unresponsive host.
  const PAIRINGS: ReadonlyArray<[string, string]> = [
    ['REQUEST_TOKEN', 'TOKEN_REFRESH_RESPONSE'],
    ['OPEN_RESOURCE_PICKER', 'RESOURCE_PICKER_RESULT'],
    ['OPEN_BUZZ_PURCHASE', 'BUZZ_PURCHASE_RESULT'],
    ['PUBLISH_GENERATION_OUTPUTS', 'PUBLISH_RESULT'],
  ];

  it.each(PAIRINGS)('maps %s to %s', async (type, replyType) => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ ok: 1 });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await t.request(type, { some: 'params' });

    expect(sendTypedRequest).toHaveBeenCalledTimes(1);
    const [passedBridge, request, passedReplyType] = sendTypedRequest.mock.calls[0]!;
    expect(passedBridge).toBe(bridge);
    expect(request).toEqual({ type, payload: { some: 'params' } });
    expect(passedReplyType).toBe(replyType);
  });

  /**
   * 🔴 THE MERGE BLOCKER THIS FILE PREVIOUSLY COULD NOT SEE, AND IT IS A MONEY
   * DEFECT. The bridge's `sendRequest(request, responseType, opts = {})` reads
   * `opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS` = **30_000**, so an `undefined`
   * fourth argument is not a neutral default — it SELECTS the protocol bucket for
   * a request whose reply waits on a person. `@civitai/blocks-react`'s own ledger
   * (`internal/requestTimeouts.js`) files all three types below as `'human'` at
   * `HUMAN_INTERACTION_TIMEOUT_MS` (10 minutes) and quotes the incident:
   * `PUBLISH_GENERATION_OUTPUTS` shipped on the 30s default and rejected while the
   * consent dialog was still on screen, after the generation had been billed, with
   * no refund path for a dead bridge (civitai/civitai#4158).
   *
   * 🔴 THE ASSERTION IS ON THE ACTUAL FOURTH ARGUMENT, PER TYPE — not on "some
   * timeout exists". A test that only checked truthiness is walkable by any wrong
   * number, and the defect this pins IS a wrong number (30s standing in for 600s).
   * So: the literal object, and `10 * 60_000` restated as the expected value
   * rather than read back off the module under test.
   *
   * Watched to FAIL on `30f30b0` (the unfixed adapter, which passed a bare
   * `undefined`): all three rows go red with
   * "expected undefined to deeply equal { timeoutMs: 600000 }".
   */
  const BOUNDS: ReadonlyArray<[string, { timeoutMs: number } | undefined]> = [
    // 'human' in the bridge's ledger — the viewer walks a purchase flow.
    ['OPEN_BUZZ_PURCHASE', { timeoutMs: 600_000 }],
    // 'human' — the viewer browses a catalog and picks.
    ['OPEN_RESOURCE_PICKER', { timeoutMs: 600_000 }],
    // 'human' — the viewer answers a consent confirm. #4158 itself.
    ['PUBLISH_GENERATION_OUTPUTS', { timeoutMs: 600_000 }],
    // 'protocol' — no person in the loop, so the bridge's own 30s default, passed
    // as `undefined`. Pinned so a blanket "give everything 10 minutes" fix, which
    // would let a genuinely dead host hang a token re-mint for ten minutes, fails
    // here rather than passing as a generalisation.
    ['REQUEST_TOKEN', undefined],
  ];

  it.each(BOUNDS)('passes the %s bucket bound to sendTypedRequest', async (type, expected) => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ ok: 1 });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await t.request(type, {});

    expect(sendTypedRequest).toHaveBeenCalledTimes(1);
    expect(sendTypedRequest.mock.calls[0]![3]).toEqual(expected);
  });

  // The constant the three human-gated rows above are built from, pinned to the
  // bridge's own value. Its own guard, because the rows spell the number out: if
  // this module's constant ever drifts from `internal/requestTimeouts.js` the rows
  // would keep passing on a literal while production sent something else.
  it('states the bridge ledger HUMAN_INTERACTION_TIMEOUT_MS as ten minutes', () => {
    expect(HUMAN_INTERACTION_TIMEOUT_MS).toBe(600_000);
  });

  // 🔴 A wrong reply type does not fail loudly — it waits for the request timeout
  // and surfaces as an unresponsive host. So an unmapped type must REFUSE rather
  // than guess, and the refusal must say what to do.
  it('throws for an unmapped request type instead of guessing a reply type', async () => {
    sendTypedRequest.mockReset();
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await expect(t.request('SAVE_IMAGE', {})).rejects.toThrow(/no response type mapped/i);
    expect(sendTypedRequest).not.toHaveBeenCalled();
  });
});

describe('sdk-transport adapter — unwrapping a legacy reply', () => {
  async function replyWith(payload: unknown, type = 'PUBLISH_GENERATION_OUTPUTS') {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue(payload);
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);
    return t.request(type, {});
  }

  /**
   * 🔴 THE MONEY-PATH REGRESSION, AND THE ONE A PASS-THROUGH ADAPTER GETS WRONG.
   *
   * The bridge's `sendTypedRequest` resolves the RAW reply payload; the SDK's
   * `request()` contract resolves the UNWRAPPED RESULT. For `PUBLISH_RESULT` the
   * host NESTS its value (`{ requestId, result: { imageIds } }`) while the SDK's
   * host client destructures `{ imageIds }` off the top level — so a pass-through
   * resolves `imageIds: undefined` for a publish that SUCCEEDED. In this app that
   * means the images exist as permanent public Civitai rows for a matrix the viewer
   * has already been charged for, with the app believing nothing was published.
   *
   * Watched red against mutation C (`return settled` in place of
   * `unwrapBridgeReply(type, settled)`): this case then resolves the whole payload
   * and `toEqual({ imageIds: [7, 8] })` fails on the extra `requestId`.
   */
  it('lifts a NESTED result out of the payload, dropping requestId', async () => {
    await expect(replyWith({ requestId: 'r1', result: { imageIds: [7, 8] } })).resolves.toEqual({
      imageIds: [7, 8],
    });
  });

  it('returns the remaining FIELDS when the payload nests no result', async () => {
    // `RESOURCE_PICKER_RESULT` is the flat shape: `{ requestId, selected }`, and
    // the SDK reads `.selected` off what `request()` resolves.
    await expect(
      replyWith({ requestId: 'r2', selected: { versionId: 42 } }, 'OPEN_RESOURCE_PICKER'),
    ).resolves.toEqual({ selected: { versionId: 42 } });
  });

  /**
   * 🔴 `error: ''` IS A SUCCESS, AND TREATING IT AS A FAILURE BREAKS EVERY
   * PUBLISH. The host spells "no failure" as the empty string —
   * `@civitai/blocks-react`'s own hook carries the same warning ("`||`, not `??`
   * … a host `error: ''` is a VALID reply"). Watched red against mutation D
   * (`typeof error === 'string'` without the `!== ''`), which rejects here with an
   * Error carrying no message at all — on the one path where the viewer has
   * already paid.
   */
  it('treats an EMPTY error string as success, not as a failure', async () => {
    await expect(replyWith({ requestId: 'r3', error: '', result: { imageIds: [1] } })).resolves.toEqual(
      { imageIds: [1] },
    );
  });

  /**
   * 🔴 THE HOST'S SENTENCE MUST SURVIVE VERBATIM. `matrix.ts` classifies spend
   * failures by SUBSTRING (`isInsufficientBuzz`, `isIncompatibleResourceError`), so
   * an adapter that replaced the message with a code would make both blind and
   * every refusal would render as a generic red failure with no Top-Up CTA.
   */
  it('rejects on a non-empty error, carrying the host message unchanged', async () => {
    await expect(
      replyWith({ requestId: 'r4', error: 'Insufficient Buzz to run this generation.' }),
    ).rejects.toThrow('Insufficient Buzz to run this generation.');
  });

  it('rejects a reply that is not an object at all', async () => {
    await expect(replyWith(null)).rejects.toThrow(/replied with no payload/i);
  });

  it('rejects a reply carrying neither a result nor an error', async () => {
    // The host dropped the value. Resolving `undefined` from a promise declared
    // `number[]` would read to the caller as "nothing published" — a guess.
    await expect(replyWith({ requestId: 'r5', result: undefined })).rejects.toThrow(
      /carried no result/i,
    );
  });
});

describe('sdk-transport adapter — abort', () => {
  it('rejects immediately when the caller passes an already-aborted signal', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ token: 'tok' });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const ac = new AbortController();
    ac.abort(new Error('caller gave up'));

    await expect(t.request('REQUEST_TOKEN', {}, { signal: ac.signal })).rejects.toThrow(
      /caller gave up/,
    );
  });

  it('rejects when the signal aborts while the request is in flight', async () => {
    sendTypedRequest.mockReset();
    // Never settles — the abort is the only thing that can end this.
    sendTypedRequest.mockReturnValue(new Promise(() => {}));
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    const ac = new AbortController();
    const pending = t.request('REQUEST_TOKEN', {}, { signal: ac.signal });
    ac.abort(new Error('timed out upstream'));

    await expect(pending).rejects.toThrow(/timed out upstream/);
  });

  it('resolves normally when no signal is supplied', async () => {
    sendTypedRequest.mockReset();
    sendTypedRequest.mockResolvedValue({ token: 'tok' });
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    await expect(t.request('REQUEST_TOKEN', {})).resolves.toEqual({ token: 'tok' });
  });
});

describe('sdk-transport adapter — the SDK is handed a BLOCK token kind', () => {
  /**
   * 🔴 THE FIELD THE BRIDGE DROPS DISARMS THE ONE RUNTIME NET UNDER THIS
   * MIGRATION'S MOST EXPENSIVE MISTAKE.
   *
   * `@civitai/sdk` gates two guards on
   * `holdsBlockToken = () => snapshot().viewer !== null && snapshot().token.kind ===
   * 'block'` (`dist/app/index.js:55`): `refuseBlockToken`, which rejects every
   * `app.orchestration.*` call EAGERLY because the orchestrator accepts a block
   * token on no route at all, and `explainApiRefusal`, which annotates a 401/403
   * outside `blocks/*`. But `@civitai/blocks-react`'s `tokenFromWrapped` builds
   * `{ raw, scopes, expiresAt, buzzBudget }` and DROPS `kind`
   * (`dist/internal/transport.js:157-164`) — the SDK's own version of the same
   * function carries it (`dist/core/transport.js:30-38`). So through an unmodified
   * adapter `token.kind` is `undefined` for ever and both guards are dead.
   *
   * That is not a cosmetic loss here. `sdk-runtime.ts` records `app.site` vs
   * `app.orchestration` as *"the sharpest trap in the whole migration because the
   * wrong version compiles"* — it type-checks, passes tests, and silently drops the
   * per-call `buzzBudget`, the per-viewer spend caps, the maturity clamp and per-app
   * attribution. `refuseBlockToken` is the alarm against exactly that, and without
   * `kind` a substitution reaches the orchestrator, collects a bare 401, and reads as
   * a scope misconfiguration instead of an architectural error.
   *
   * 🔴 THE ASSERTION IS BEHAVIOURAL, NOT STRUCTURAL: a real `initialize()` over this
   * adapter, then a real `app.orchestration` call, which must be refused BEFORE
   * reaching `fetch`. A structural `snapshot.token.kind === 'block'` check would
   * type-check past a guard that had been rewired to read something else.
   *
   * Watched to FAIL on `30f30b0` (adapter without the `kind` stamp): the call is NOT
   * refused, `fetch` records a request to `https://orchestration.civitai.com/...`,
   * and the rejects-assertion goes red.
   */
  async function clientOverAdapter() {
    const { initialize } = await import('@civitai/sdk');
    const { bridge, state } = fakeBridge({
      // Both halves of `holdsBlockToken` have to be true for the guard to be live, so
      // the snapshot carries a signed-in viewer as well as a ready flag.
      getSnapshot: () => state.snapshot,
    });
    state.snapshot = {
      ready: true,
      renderMode: 'iframe',
      context: { slotId: 'page' },
      settings: {},
      viewer: { id: 7, username: 'zed' },
      theme: 'dark',
      blockInstanceId: 'inst-1',
      token: { raw: 'jwt-1', scopes: ['ai:write:budgeted'], expiresAt: new Date('2030-01-01') },
    };
    state.hostOrigin = 'https://civitai.com';

    const seen: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const client = await initialize({
      transport: createSdkTransportAdapter(bridge as never) as never,
      fetch: fetchSpy,
    });
    return { client, seen };
  }

  it('refuses an app.orchestration call eagerly, without reaching the wire', async () => {
    const { client, seen } = await clientOverAdapter();

    await expect(client.orchestration.queryWorkflows()).rejects.toThrow(
      /orchestrator does not accept a block-scoped token/i,
    );
    // The refusal is EAGER: nothing was sent. Asserted separately from the rejection
    // because a guard that rejected only AFTER the request would satisfy the line
    // above while still having leaked a money-scoped token to the orchestrator.
    expect(seen.filter((u) => u.includes('orchestration'))).toEqual([]);
  });

  /**
   * 🔴 THE POSITIVE CONTROL. Without it the case above is indistinguishable from a
   * `fetch` that was never wired to anything: a zero-length `seen` would be
   * "proof" either way. So the same client, the same spy, one call that MUST reach
   * the wire — and the count has to move.
   */
  it('positive control: a blocks/* site call DOES reach the injected fetch', async () => {
    const { client, seen } = await clientOverAdapter();

    await client.site.get('blocks/gated-images', { query: { ids: '1' } });

    expect(seen.filter((u) => u.includes('blocks/gated-images'))).toHaveLength(1);
  });
});

describe('sdk-transport adapter — notify and on', () => {
  it('forwards notify to the bridge sendMessage, shape intact', () => {
    const { bridge } = fakeBridge();
    const t = createSdkTransportAdapter(bridge as never);

    t.notify({ type: 'RESIZE_IFRAME', payload: { height: 480 } });

    expect(bridge.sendMessage).toHaveBeenCalledWith({
      type: 'RESIZE_IFRAME',
      payload: { height: 480 },
    });
  });

  it('forwards on() to onMessage and returns its unsubscribe', () => {
    const off = vi.fn();
    const { bridge } = fakeBridge({ onMessage: vi.fn(() => off) });
    const t = createSdkTransportAdapter(bridge as never);

    const handler = vi.fn();
    const returned = t.on('TOKEN_REFRESH_RESPONSE', handler);

    expect(bridge.onMessage).toHaveBeenCalledWith('TOKEN_REFRESH_RESPONSE', handler);
    returned();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
