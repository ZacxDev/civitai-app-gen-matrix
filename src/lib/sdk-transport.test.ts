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

const { createSdkTransportAdapter } = await import('./sdk-transport.js');

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
