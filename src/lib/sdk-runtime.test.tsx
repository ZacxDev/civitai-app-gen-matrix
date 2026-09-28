// Tests for the fifteen runtime bindings, against the REAL `@civitai/sdk`.
//
// 🔴 `initialize` IS NOT MOCKED, AND THAT IS THE POINT. The port's whole risk is
// in the SEAM — which route a call lands on, what shape comes back, whether a
// snapshot field reaches React without looping. A mocked `initialize` would move
// every one of those behind a fake and leave the suite asserting my own guesses:
// exactly the "verified in isolation" failure. So these tests drive the real SDK
// with two injected edges, both of which the SDK itself supports:
//
//   - a fake TRANSPORT, whose snapshot says `ready: true`, which is all the SDK's
//     own readiness gate requires;
//   - a fake FETCH, so `app.site` / `app.storage` / `app.sharedStorage` build
//     their real URLs and bodies and this file asserts on them.
//
// What that buys: the five workflow routes, the three app-layer shared-storage
// routes, the gated-image route and the storage routes are asserted as the STRINGS
// THAT GO ON THE WIRE, not as calls to a stub.

import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureSdkRuntime,
  resetSdkRuntime,
  useAppStorage,
  useAppWorkflows,
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzPurchase,
  useBuzzWorkflow,
  useDomainMaturity,
  useGatedImages,
  usePublishGenerationOutputs,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
  useSharedStorage,
  WorkflowEstimateError,
  WorkflowSubmitError,
} from './sdk-runtime.js';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeSnapshot {
  ready: boolean;
  renderMode: 'iframe';
  context: Record<string, unknown>;
  token: { raw: string; scopes: string[]; expiresAt: Date };
  settings: Record<string, unknown>;
  viewer: { id: number; username: string } | null;
  theme: 'light' | 'dark';
  blockInstanceId: string;
  hostOrigin: string | null;
  domain?: string | null;
  maxBrowsingLevel?: number;
}

function baseSnapshot(over: Partial<FakeSnapshot> = {}): FakeSnapshot {
  return {
    ready: true,
    renderMode: 'iframe',
    context: { slotId: 'page', viewerUserId: 7 },
    token: { raw: 'jwt-1', scopes: ['ai:write:budgeted'], expiresAt: new Date('2030-01-01') },
    settings: {},
    viewer: { id: 7, username: 'zed' },
    theme: 'dark',
    blockInstanceId: 'inst-1',
    hostOrigin: 'https://civitai.com',
    ...over,
  };
}

/**
 * A transport whose snapshot the test owns.
 *
 * 🔴 `set()` REPLACES THE OBJECT rather than mutating it, because identity is what
 * the store compares. A mutating fake would make every `useSyncExternalStore`
 * assertion below vacuous — the value would change while the identity did not, so
 * React would correctly skip the re-render and the test would be asserting on the
 * fake's design instead of the code's.
 */
function fakeTransport(initial: FakeSnapshot = baseSnapshot()) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const notify = vi.fn<(message: { type: string; payload?: unknown }) => void>();
  // Typed with its real THREE parameters, not `() => {}`: several cases below read
  // `mock.calls[n][1]` to assert the PARAMS that went out (the publish payload, the
  // picker's `resourceType`, `REQUEST_TOKEN`'s `blockInstanceId`), and a zero-arity
  // mock types those calls as `[]` so the read does not compile.
  const request = vi.fn<
    (type: string, params: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>
  >(async () => ({}));
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    transport: {
      snapshot: {
        get: () => snap,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      notify,
      request,
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
    notify,
    request,
    handlers,
    set(next: FakeSnapshot) {
      snap = next;
      for (const l of [...listeners]) l();
    },
  };
}

/**
 * A fetch that records every call and answers each route from a table.
 *
 * `signal` is recorded because it is the ONLY observable for the request deadline:
 * the SDK's `createHttp` forwards `opts.signal` straight into `fetch` and nothing
 * else about a bound reaches the wire, so a call that carries none is
 * indistinguishable from a bounded one except right here.
 */
function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const calls: Array<{
    url: string;
    method: string;
    body: unknown;
    auth: string | null;
    signal: AbortSignal | null | undefined;
  }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body == null ? null : JSON.parse(String(init.body)),
      auth: headers.get('Authorization'),
      signal: init?.signal,
    });
    const key = Object.keys(routes).find((route) => url.includes(route));
    const payload = key === undefined ? { error: `no fake route for ${url}` } : routes[key];
    return new Response(JSON.stringify(payload), {
      status: key === undefined ? 404 : status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

afterEach(() => {
  resetSdkRuntime();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// group 1 — the snapshot
// ---------------------------------------------------------------------------

describe('group 1: snapshot bindings', () => {
  function Probe() {
    const { ready, viewer, theme, context } = useBlockContext();
    const renders = useRef(0);
    renders.current += 1;
    return (
      <div>
        <span data-testid="ready">{String(ready)}</span>
        <span data-testid="viewer">{viewer?.username ?? 'anon'}</span>
        <span data-testid="theme">{theme}</span>
        <span data-testid="slot">{String((context as { slotId?: string }).slotId ?? 'none')}</span>
        <span data-testid="renders">{renders.current}</span>
      </div>
    );
  }

  it('reads ready / viewer / theme / context off the transport snapshot', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    render(<Probe />);

    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('viewer').textContent).toBe('zed');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('slot').textContent).toBe('page');
  });

  it('re-renders when the snapshot changes, and SETTLES rather than looping', () => {
    const t = fakeTransport(baseSnapshot({ ready: false, theme: 'light' }));
    configureSdkRuntime({ transport: t.transport as never });

    render(<Probe />);
    expect(screen.getByTestId('ready').textContent).toBe('false');

    const before = Number(screen.getByTestId('renders').textContent);
    act(() => t.set(baseSnapshot()));

    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('theme').textContent).toBe('dark');

    // 🔴 THE LOOP GUARD, AND THE REASON IT IS A RANGE RATHER THAN AN EQUALITY.
    // A selector that composed a fresh object would never compare `Object.is`-equal,
    // so React would re-render on every commit and this count would run away. The
    // assertion needs a ceiling loose enough to survive StrictMode double-invokes
    // and tight enough that a runaway (hundreds) fails. Settling is the claim.
    const after = Number(screen.getByTestId('renders').textContent);
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(6);
  });

  /**
   * 🔴 THE SECURITY ASSERTION, AND THE JSDOM HALF OF IT — the one
   * `sdk-transport.test.ts` deliberately could NOT make, because vitest's `node`
   * environment defines no `location` and `not.toContain(undefined)` can never
   * fail. Here `window.location.origin` really is defined
   * (`http://localhost:3000`), so if anything ever substitutes it for a
   * not-yet-established host origin this reads it back and fails BY NAME.
   *
   * `hostOrigin` becomes the base URL a money-scoped bearer token is sent to, so a
   * not-ready state must stay empty.
   */
  it('keeps a null hostOrigin empty in jsdom and INVENTS NO location fallback', async () => {
    const t = fakeTransport(baseSnapshot({ hostOrigin: null }));
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function HostProbe() {
      // Nothing in this app renders `hostOrigin` directly; the observable is that
      // no request is ever aimed at the page's own origin.
      useAppWorkflows();
      return null;
    }
    render(<HostProbe />);
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    expect(globalThis.location?.origin).toBeTruthy(); // the premise this rests on
    for (const call of f.calls) {
      expect(call.url).not.toContain(globalThis.location.origin);
    }
  });

  it('exposes the domain ceiling and its two derived predicates', () => {
    // 31 is the all-levels ceiling; 1 is SFW-only.
    const t = fakeTransport(baseSnapshot({ domain: 'red', maxBrowsingLevel: 31 }));
    configureSdkRuntime({ transport: t.transport as never });

    function Maturity() {
      const m = useDomainMaturity();
      return (
        <span data-testid="m">{`${m.domain}/${m.maxBrowsingLevel}/${m.isSfw}/${m.isLevelAllowed(4)}`}</span>
      );
    }
    render(<Maturity />);

    // 🔴 The two predicates come from `@civitai/app-sdk/blocks` — the SAME
    // functions the bridge hook called — so this asserts the wiring, not a local
    // reimplementation of the ceiling rules.
    expect(screen.getByTestId('m').textContent).toBe('red/31/false/true');
  });

  it('fails CLOSED when the host sent no ceiling at all', () => {
    const t = fakeTransport(baseSnapshot());
    configureSdkRuntime({ transport: t.transport as never });

    function Maturity() {
      const m = useDomainMaturity();
      return <span data-testid="m">{`${m.isSfw}/${m.isLevelAllowed(4)}`}</span>;
    }
    render(<Maturity />);

    // 🔴 `maxBrowsingLevel` ABSENT MUST READ AS SFW, not as "no limit". This drives
    // the G1 result-image gate: reading an absent ceiling as permissive would paint
    // a mature output on a SFW domain.
    expect(screen.getByTestId('m').textContent).toBe('true/false');
  });

  it('token.refresh() asks the host for a FRESH mint rather than reading the snapshot', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    let refresh: (() => Promise<void>) | null = null;
    function TokenProbe() {
      const token = useBlockToken();
      refresh = token.refresh;
      return (
        <span data-testid="raw">{`${token.raw}/${token.scopes.join(',')}`}</span>
      );
    }
    render(<TokenProbe />);
    expect(screen.getByTestId('raw').textContent).toBe('jwt-1/ai:write:budgeted');

    t.request.mockResolvedValueOnce({
      token: { raw: 'jwt-2', scopes: [], expiresAt: new Date('2030-01-01').toISOString() },
    });
    await act(async () => {
      await refresh!();
    });

    expect(t.request).toHaveBeenCalledWith(
      'REQUEST_TOKEN',
      { blockInstanceId: 'inst-1' },
      expect.anything(),
    );
  });

  /**
   * ⚠ AN ASSERTION THAT THE ANALYTICS SINK IS A NO-OP, which sounds like testing
   * nothing and is the opposite: `ErrorBoundary.tsx` calls `track()` from
   * `componentDidCatch`, so a binding that reached the transport would put a
   * postMessage on the crash path. `TRACK_EVENT` is "not carried" by the SDK AND
   * had no host-side sink on the bridge either, so silence is the correct behaviour
   * and this pins it.
   */
  it('useBlockAnalytics.track is silent and reaches no transport', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    let track: ((n: string, p?: Record<string, unknown>) => void) | null = null;
    function A() {
      track = useBlockAnalytics().track;
      return null;
    }
    render(<A />);

    expect(() => track!('render_error', { name: 'TypeError' })).not.toThrow();
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// group 2 — host-mediated
// ---------------------------------------------------------------------------

describe('group 2: host-mediated bindings', () => {
  /**
   * A minimal ResizeObserver, because jsdom has none.
   *
   * 🔴 WITHOUT THIS THE TEST PROVED THE OPPOSITE OF WHAT IT CLAIMED. Both the SDK's
   * `autoResize` and the bridge hook it replaces bail out when `ResizeObserver` is
   * undefined, so under bare jsdom the code path never runs and a "reports a height"
   * assertion fails while the production path is fine — a fixture problem reading as
   * a defect. Stubbing it means this exercises the REAL branch.
   */
  function stubResizeObserver() {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class RO {
      observe(el: Element) {
        observed.push(el);
      }
      disconnect = disconnect;
    }
    const prior = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      RO as unknown as typeof ResizeObserver;
    return {
      observed,
      disconnect,
      restore: () => {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prior;
      },
    };
  }

  it('useBlockResize reports a height on mount and disconnects on unmount', () => {
    const ro = stubResizeObserver();
    try {
      const t = fakeTransport();
      configureSdkRuntime({ transport: t.transport as never });

      function Resizer() {
        const ref = useRef<HTMLDivElement>(null);
        useBlockResize(ref);
        return <div ref={ref}>content</div>;
      }
      const view = render(<Resizer />);

      const resizes = t.notify.mock.calls.filter(([msg]) => msg.type === 'RESIZE_IFRAME');
      expect(resizes.length).toBe(1);
      expect(ro.observed.length).toBe(1);

      view.unmount();
      // The effect must RETURN the host client's teardown; a hook that swallowed it
      // would leave the observer attached to a detached node for the page's life.
      expect(ro.disconnect).toHaveBeenCalled();
    } finally {
      ro.restore();
    }
  });

  it('useRequestSignIn notifies the host', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    function SignIn() {
      const { requestSignIn } = useRequestSignIn();
      useEffect(() => requestSignIn(), [requestSignIn]);
      return null;
    }
    render(<SignIn />);

    expect(t.notify.mock.calls.some(([msg]) => msg.type === 'REQUEST_SIGN_IN')).toBe(true);
  });

  it('useRequestConsent is FIRE-AND-FORGET and swallows an abandoned dialog', async () => {
    // 🔴 THE SCOPE MUST BE ONE THE FIXTURE TOKEN DOES **NOT** HOLD. The snapshot's
    // token carries `ai:write:budgeted`, and `requestGrants` short-circuits to
    // `true` without notifying when every requested scope is already held (see the
    // case below, which pins that). Asking for a held scope here would have made
    // this whole case vacuous — it would assert an absence of notify that the
    // short-circuit produces for a reason unrelated to the code under test.
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    const unhandled = vi.fn();
    globalThis.addEventListener('unhandledrejection', unhandled);
    try {
      function Consent() {
        const { requestConsent } = useRequestConsent();
        useEffect(() => requestConsent({ scopes: ['buzz:read:self'] }), [requestConsent]);
        return null;
      }
      render(<Consent />);

      await waitFor(() =>
        expect(
          t.notify.mock.calls.some(
            ([msg]) =>
              msg.type === 'REQUEST_CONSENT' &&
              (msg.payload as { scopes: string[] }).scopes.includes('buzz:read:self'),
          ),
        ).toBe(true),
      );

      // 🔴 THE VIEWER WHO CLOSES THE DIALOG SENDS NOTHING. `requestGrants` then
      // resolves neither way, so the only observable is that nothing rejected into
      // the page. A missing `.catch()` here surfaces as a console error a viewer
      // can produce at will.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      globalThis.removeEventListener('unhandledrejection', unhandled);
    }
  });

  /**
   * ⚠ A BEHAVIOUR DIFFERENCE FROM THE BRIDGE, PINNED SO IT IS A DECISION RATHER
   * THAN A SURPRISE. `@civitai/blocks-react`'s `requestConsent` was a bare notify —
   * it asked the host EVERY time. `@civitai/sdk`'s `requestGrants` first checks the
   * token it already holds and resolves `true` without a round trip when every
   * requested scope is present.
   *
   * For this app that is strictly better and changes nothing on screen: the Generate
   * gate is `hasBudgetedScope(token.scopes)`, so the consent path is only reached
   * when the scope is MISSING, and the short-circuit merely removes a dialog the
   * host would have dismissed itself. Recorded because a reader debugging "why is no
   * REQUEST_CONSENT going out" needs this, and because a future call site that asks
   * for a held scope expecting a dialog would be relying on the bridge's behaviour,
   * not this one's.
   */
  it('useRequestConsent SKIPS the host round trip when the token already holds the scopes', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    function Consent() {
      const { requestConsent } = useRequestConsent();
      // The fixture token's own scope.
      useEffect(() => requestConsent({ scopes: ['ai:write:budgeted'] }), [requestConsent]);
      return null;
    }
    render(<Consent />);

    await new Promise((r) => setTimeout(r, 20));
    expect(t.notify.mock.calls.filter(([msg]) => msg.type === 'REQUEST_CONSENT')).toHaveLength(0);
  });

  it('useResourcePicker asks the host and returns the chosen resource', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });
    t.request.mockResolvedValue({ selected: { versionId: 4242, modelName: 'Some LoRA' } });

    let open: ((o: { resourceType: 'LORA' }) => Promise<unknown>) | null = null;
    function Picker() {
      open = useResourcePicker().open as typeof open;
      return null;
    }
    render(<Picker />);

    await expect(open!({ resourceType: 'LORA' })).resolves.toEqual({
      versionId: 4242,
      modelName: 'Some LoRA',
    });
    expect(t.request).toHaveBeenCalledWith(
      'OPEN_RESOURCE_PICKER',
      { resourceType: 'LORA' },
      expect.anything(),
    );
  });

  it('useResourcePicker returns null when the viewer dismisses the picker', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });
    // The host answers with no `selected` at all — the dismiss shape.
    t.request.mockResolvedValue({});

    let open: ((o: { resourceType: 'Checkpoint' }) => Promise<unknown>) | null = null;
    function Picker() {
      open = useResourcePicker().open as typeof open;
      return null;
    }
    render(<Picker />);

    // 🔴 `null`, NOT `undefined`: `addCheckpointRow` is only called when this is
    // non-null, and `undefined` would slip through a `!= null` test identically but
    // read differently at every other site.
    await expect(open!({ resourceType: 'Checkpoint' })).resolves.toBeNull();
  });

  it('useBuzzPurchase opens the host modal with the suggested amount', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });
    t.request.mockResolvedValue({ purchased: true });

    let open: ((n?: number) => Promise<{ purchased: boolean }>) | null = null;
    function Purchase() {
      open = useBuzzPurchase().openPurchaseModal;
      return null;
    }
    render(<Purchase />);

    await expect(open!(500)).resolves.toEqual({ purchased: true });
    expect(t.request).toHaveBeenCalledWith(
      'OPEN_BUZZ_PURCHASE',
      { suggestedAmount: 500 },
      expect.anything(),
    );
  });

  it('usePublishGenerationOutputs sends workflowId + indexes and NEVER a title', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });
    t.request.mockResolvedValue({ imageIds: [9001] });

    let publish:
      | ((a: { workflowId: string; imageIndexes?: number[]; title?: string }) => Promise<number[]>)
      | null = null;
    function Publisher() {
      publish = usePublishGenerationOutputs().publish;
      return null;
    }
    render(<Publisher />);

    await expect(
      publish!({ workflowId: 'wf_7', imageIndexes: [0], title: 'ignored' }),
    ).resolves.toEqual([9001]);

    // 🔴 OUTPUTS ARE NAMED BY INDEX, NEVER BY URL — the host re-derives that this
    // viewer and this app own `workflowId` and resolves the urls itself, which is
    // the whole guarantee. And `title` was DISCARDED by the host's mutation even on
    // the bridge, so the SDK dropped it; asserting its ABSENCE is what stops a
    // future edit from re-adding a field that does nothing.
    const [, params] = t.request.mock.calls.at(-1)!;
    expect(params).toEqual({ workflowId: 'wf_7', imageIndexes: [0] });
    expect(params).not.toHaveProperty('title');
  });
});

// ---------------------------------------------------------------------------
// group 3 — REST: the wire, not a stub
// ---------------------------------------------------------------------------

describe('group 3: the money path — the routes, not app.orchestration', () => {
  let t: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    t = fakeTransport();
  });

  function mountWorkflow(f: ReturnType<typeof fakeFetch>) {
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });
    let api: ReturnType<typeof useBuzzWorkflow> | null = null;
    function W() {
      api = useBuzzWorkflow();
      return null;
    }
    render(<W />);
    return () => api!;
  }

  const BODY = { kind: 'customComfy' } as never;

  it('estimate POSTs blocks/workflows/estimate and unwraps { snapshot }', async () => {
    const f = fakeFetch({
      'blocks/workflows/estimate': {
        snapshot: { workflowId: 'wf_estimate', status: 'pending', cost: { total: 12 } },
      },
    });
    const api = mountWorkflow(f);

    await expect(api().estimate(BODY)).resolves.toMatchObject({ cost: { total: 12 } });

    const call = f.calls.at(-1)!;
    // 🔴 `/api/v1/blocks/workflows/estimate`, NOT an orchestration host. The SDK's
    // own BREAKING.md calls substituting `app.orchestration` "the sharpest trap in
    // the migration, because the wrong version compiles": it drops the per-call
    // buzzBudget, the per-viewer and per-app daily caps, the maturity clamp and
    // per-app attribution. Nothing local can miss that but this assertion.
    expect(call.url).toContain('/api/v1/blocks/workflows/estimate');
    expect(call.url).not.toContain('orchestration');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ body: BODY });
    expect(call.auth).toBe('Bearer jwt-1');
  });

  it('estimate THROWS a WorkflowEstimateError on a failed snapshot', async () => {
    const f = fakeFetch({
      'blocks/workflows/estimate': {
        snapshot: { workflowId: 'failed', status: 'failed', error: 'nope' },
      },
    });
    const api = mountWorkflow(f);
    await expect(api().estimate(BODY)).rejects.toBeInstanceOf(WorkflowEstimateError);
  });

  it('estimate THROWS when a pending snapshot carries no usable price', async () => {
    const f = fakeFetch({
      'blocks/workflows/estimate': { snapshot: { workflowId: 'wf_e', status: 'pending' } },
    });
    const api = mountWorkflow(f);
    await expect(api().estimate(BODY)).rejects.toThrow(/no-cost/);
  });

  /**
   * 🔴 THE ROUTE REQUIRES AN IDEMPOTENCY KEY WHERE THE BRIDGE HOOK MINTED ONE FOR
   * YOU, and the failure is invisible until a submit 400s on the SPEND path.
   * `blocks/workflows/submit`'s schema is
   * `{ body, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }` — not
   * `.optional()` — while `App.tsx` calls `submit(body)` with no options at all.
   */
  it('submit MINTS an idempotency key matching the platform regex', async () => {
    const f = fakeFetch({
      'blocks/workflows/submit': { snapshot: { workflowId: 'wf_1', status: 'pending' } },
    });
    const api = mountWorkflow(f);

    await api().submit(BODY);

    const sent = f.calls.at(-1)!.body as { idempotencyKey?: unknown };
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(sent.idempotencyKey as string).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('submit reuses a caller-supplied idempotency key rather than minting', async () => {
    const f = fakeFetch({
      'blocks/workflows/submit': { snapshot: { workflowId: 'wf_1', status: 'pending' } },
    });
    const api = mountWorkflow(f);

    await api().submit(BODY, { idempotencyKey: 'retry-of-one-logical-op' });

    // An idempotency key must be STABLE across the retry of one logical operation,
    // so a caller that owns one has to win over the mint.
    expect((f.calls.at(-1)!.body as { idempotencyKey: string }).idempotencyKey).toBe(
      'retry-of-one-logical-op',
    );
  });

  it('submit mints a DIFFERENT key per logical submit', async () => {
    const f = fakeFetch({
      'blocks/workflows/submit': { snapshot: { workflowId: 'wf_1', status: 'pending' } },
    });
    const api = mountWorkflow(f);

    await api().submit(BODY);
    await api().submit(BODY);

    const keys = f.calls
      .filter((c) => c.url.includes('workflows/submit'))
      .map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    // 🔴 A SHARED KEY WOULD MAKE THE SECOND CELL A NO-OP AGAINST THE FIRST'S
    // RECORD — the grid would show one paid result where two were expected, and the
    // app would never learn the second never ran. Two cells are two logical
    // operations.
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  /**
   * 🔴 THE TOP-UP PATH, AND THE ASYMMETRY THAT LOOKS LIKE A BUG. `submit` throws
   * only when a `failed` snapshot has NO numeric cost. The platform answers a
   * budget shortfall WITH a cost, so that case must come back as a RESULT — which is
   * what lets `cellStatusForSnapshot` read `snapshot.error` and land the cell on
   * `insufficient` with its Top-Up CTA. Throwing here instead would replace the CTA
   * with a generic red failure on the one path where the viewer can actually fix it.
   */
  it('submit RETURNS an insufficient-Buzz refusal rather than throwing, because it carries a cost', async () => {
    const f = fakeFetch({
      'blocks/workflows/submit': {
        snapshot: {
          workflowId: 'failed',
          status: 'failed',
          cost: { total: 64 },
          error: 'insufficient buzz budget: recipe ceiling 64 exceeds budget 10',
        },
      },
    });
    const api = mountWorkflow(f);

    const snap = await api().submit(BODY);
    expect(snap.status).toBe('failed');
    expect(snap.error).toMatch(/insufficient buzz budget/);
    expect(snap.cost?.total).toBe(64);
  });

  it('submit THROWS a WorkflowSubmitError when a failed snapshot carries NO cost', async () => {
    const f = fakeFetch({
      'blocks/workflows/submit': {
        snapshot: { workflowId: 'failed', status: 'failed', error: 'Generation failed (simulated).' },
      },
    });
    const api = mountWorkflow(f);

    await expect(api().submit(BODY)).rejects.toBeInstanceOf(WorkflowSubmitError);
    // `workflowId: 'failed'` is the host's synthesised sentinel, so the code is
    // `exception` rather than `workflow-failed`.
    await expect(api().submit(BODY)).rejects.toMatchObject({ code: 'exception' });
  });

  it('poll and cancel POST their own routes and unwrap { snapshot }', async () => {
    const f = fakeFetch({
      'blocks/workflows/poll': { snapshot: { workflowId: 'wf_1', status: 'processing' } },
      'blocks/workflows/cancel': { snapshot: { workflowId: 'wf_1', status: 'canceled' } },
    });
    const api = mountWorkflow(f);

    await expect(api().poll('wf_1')).resolves.toMatchObject({ status: 'processing' });
    await expect(api().cancel('wf_1')).resolves.toMatchObject({ status: 'canceled' });

    const poll = f.calls.find((c) => c.url.includes('workflows/poll'))!;
    expect(poll.method).toBe('POST');
    expect(poll.body).toEqual({ workflowId: 'wf_1' });
    expect(f.calls.find((c) => c.url.includes('workflows/cancel'))!.body).toEqual({
      workflowId: 'wf_1',
    });
  });

  /**
   * 🔴 A BARE SNAPSHOT WOULD BE A SILENT WRONG ANSWER. All four of these routes
   * reply `{ snapshot }`, WRAPPED — verified in civitai `blocks.router.ts`. A
   * binding that read the reply as the snapshot itself would see
   * `status: undefined`, `isTerminalStatus(undefined)` is false, and the cell would
   * poll forever on a workflow that had already succeeded. So the malformed case
   * must SAY SO rather than degrade.
   */
  it('a reply that is NOT wrapped in { snapshot } is refused, not read as a snapshot', async () => {
    const f = fakeFetch({
      // The un-wrapped shape — what a reader would assume if they never checked.
      'blocks/workflows/poll': { workflowId: 'wf_1', status: 'succeeded' },
    });
    const api = mountWorkflow(f);
    await expect(api().poll('wf_1')).rejects.toThrow(/malformed response \(no snapshot\)/);
  });
});

describe('group 3: the app workflow read-model', () => {
  it('POSTs blocks/workflows/query and projects { workflows, cursor }', async () => {
    const t = fakeTransport();
    const f = fakeFetch({
      'blocks/workflows/query': {
        workflows: [{ workflowId: 'wf_a', status: 'succeeded', images: [], cost: 8 }],
        cursor: 'c2',
      },
    });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Q() {
      const { workflows, cursor, loading } = useAppWorkflows();
      return <span data-testid="q">{loading ? 'loading' : `${workflows.length}/${cursor}`}</span>;
    }
    render(<Q />);

    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('1/c2'));

    const call = f.calls.find((c) => c.url.includes('workflows/query'))!;
    // 🔴 THE ROUTE, NOT `orchestration.queryWorkflows({ tags })`: the route forces
    // the app tag SERVER-SIDE from the verified token, while the client takes `tags`
    // from the caller. Swapping one for the other relocates a trust boundary into
    // the iframe and nothing about the call site looks different.
    expect(call.url).toContain('/api/v1/blocks/workflows/query');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({});
  });

  it('surfaces a refusal as an error and keeps the list EMPTY, never partial', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'blocks/workflows/query': { error: 'Forbidden' } }, 403);
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Q() {
      const { workflows, error } = useAppWorkflows();
      return <span data-testid="q">{error ? `err/${workflows.length}` : 'ok'}</span>;
    }
    render(<Q />);

    // `persistence.ts` RECONCILES a restored run against these rows, and a terminal
    // status in the read-model is what marks a cell done. An empty list read as
    // authoritative would be wrong; an error is what lets the app leave the
    // restored cells alone.
    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('err/0'));
  });

  it('refetch re-reads the route', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let refetch: (() => void) | null = null;
    function Q() {
      refetch = useAppWorkflows().refetch;
      return null;
    }
    render(<Q />);
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    const before = f.calls.filter((c) => c.url.includes('workflows/query')).length;
    await act(async () => {
      refetch!();
    });
    await waitFor(() =>
      expect(f.calls.filter((c) => c.url.includes('workflows/query')).length).toBe(before + 1),
    );
  });
});

describe('group 3: shared storage', () => {
  function mountShared(f: ReturnType<typeof fakeFetch>, t: ReturnType<typeof fakeTransport>) {
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });
    let api: ReturnType<typeof useSharedStorage> | null = null;
    function S() {
      api = useSharedStorage();
      return null;
    }
    render(<S />);
    return () => api!;
  }

  it('list and append reach the SDK client’s own routes, with limit on the query string', async () => {
    const t = fakeTransport();
    const f = fakeFetch({
      'shared-storage/list': { items: [], metadata: { nextCursor: 'c2' } },
      'shared-storage/append': { key: 'k-new' },
    });
    const api = mountShared(f, t);

    const page = await api().list({ limit: 13 });
    expect(page.nextCursor).toBe('c2');
    expect((await api().append({ title: 'hello' })).key).toBe('k-new');

    const list = f.calls.find((c) => c.url.includes('shared-storage/list'))!;
    expect(list.method).toBe('GET');
    expect(list.url).toContain('limit=13');
    expect(f.calls.find((c) => c.url.includes('shared-storage/append'))!.method).toBe('POST');
  });

  /**
   * 🔴 THE THREE APP-LAYER ROUTES, PINNED AGAINST THE ROUTE FILES RATHER THAN
   * AGAINST WHAT THE SDK HAPPENS TO SEND. `starters#479` kept `vote`, `unvote` and
   * `report` OUT of `AppClient.sharedStorage` on purpose — shared storage is
   * generic key/value only and these belong at the app layer — so NOTHING in the
   * SDK will fail if these drift. That is exactly why the assertion lives here.
   *
   * Verified: civitai `src/pages/api/v1/blocks/shared-storage/{vote,unvote,report}.ts`
   * are all POST under `apps:storage:shared:write`; vote/unvote reply `{ count }`
   * and report replies `{ ok: true }`.
   */
  it('vote and unvote POST their own routes and return the new tally', async () => {
    const t = fakeTransport();
    const f = fakeFetch({
      'shared-storage/vote': { count: 12 },
      'shared-storage/unvote': { count: 11 },
    });
    const api = mountShared(f, t);

    await expect(api().vote('row-9')).resolves.toBe(12);
    await expect(api().unvote('row-9')).resolves.toBe(11);

    const vote = f.calls.find((c) => c.url.includes('shared-storage/vote'))!;
    expect(vote.method).toBe('POST');
    expect(vote.body).toEqual({ key: 'row-9' });
    expect(vote.url).toContain('/blocks/shared-storage/vote');
    const unvote = f.calls.find((c) => c.url.includes('shared-storage/unvote'))!;
    expect(unvote.body).toEqual({ key: 'row-9' });
  });

  it('report POSTs the key, and the reason ONLY when one was given', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'shared-storage/report': { ok: true } });
    const api = mountShared(f, t);

    await api().report('row-9');
    expect(f.calls.at(-1)!.body).toEqual({ key: 'row-9' });

    await api().report('row-9', 'spam');
    expect(f.calls.at(-1)!.body).toEqual({ key: 'row-9', reason: 'spam' });
  });

  /**
   * 🔴 THE `?? 0` REGRESSION. `Number(undefined)` is NaN and `?? 0` would report a
   * vote that did not land as a tally of ZERO — and this number is written straight
   * onto the gallery entry the viewer is looking at, so a silent 0 renders "0
   * votes" for a row that has them. A malformed reply is a failure, not a count.
   */
  it('vote THROWS on a reply carrying no numeric count', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'shared-storage/vote': { ok: true } });
    const api = mountShared(f, t);
    await expect(api().vote('row-9')).rejects.toThrow(/numeric `count`/);
  });

  it('vote THROWS on a NON-FINITE count rather than publishing NaN', async () => {
    const t = fakeTransport();
    // JSON cannot carry NaN, but a string that coerces is exactly what a lenient
    // `Number(reply.count)` would have accepted.
    const f = fakeFetch({ 'shared-storage/vote': { count: 'twelve' } });
    const api = mountShared(f, t);
    await expect(api().vote('row-9')).rejects.toThrow(/numeric `count`/);
  });
});

describe('group 3: app storage and the gated read', () => {
  it('useAppStorage reaches blocks/app-storage and keeps a STABLE identity', async () => {
    const t = fakeTransport();
    // `sizeBytes` is REQUIRED, not optional: the SDK's storage client throws
    // without it, and the route's docblock states success is always
    // `{ ok: true, sizeBytes }` with "no 2xx path that means not written".
    const f = fakeFetch({
      'app-storage/get': { value: { phase: 'done' } },
      'app-storage/set': { ok: true, sizeBytes: 21 },
    });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    const seen: unknown[] = [];
    function Storage() {
      const storage = useAppStorage();
      const [, bump] = useState(0);
      seen.push(storage);
      useEffect(() => {
        bump(1);
      }, []);
      return null;
    }
    render(<Storage />);

    // 🔴 THE DEPENDENCY-ARRAY CONTRACT. `App.tsx` puts this object in the
    // run-restore and history effects' deps; a fresh identity per render would
    // re-run both forever.
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(new Set(seen).size).toBe(1);

    const storage = seen[0] as ReturnType<typeof useAppStorage>;
    await storage.set('gen-matrix:run:v1', { phase: 'done' });
    const call = f.calls.find((c) => c.url.includes('app-storage/set'))!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ key: 'gen-matrix:run:v1', value: { phase: 'done' } });
  });

  /**
   * 🔴 `blocks/gated-images`, AND `BREAKING.md` NAMES THE WRONG ROUTE. Its
   * migration table maps `GET_IMAGES_BY_IDS` to `blocks/images?ids=`. That route
   * serves the Meilisearch images index, whose source query hard-filters
   * `postId IS NOT NULL`; this route's corpus is the exact COMPLEMENT
   * (`postId IS NULL`, scoped to this app's own published images). So
   * `blocks/images?ids=` returns an EMPTY ARRAY for every id this app published,
   * at any ceiling, for any viewer, forever — which would have rendered an entire
   * gallery of silently-gone images rather than an error. This assertion is the only
   * thing standing between the two.
   */
  it('useGatedImages GETs blocks/gated-images with comma-joined ids', async () => {
    const t = fakeTransport();
    const f = fakeFetch({
      'blocks/gated-images': {
        images: [{ imageId: 9001, status: 'visible', url: 'https://i/9001.jpeg', nsfwLevel: 1 }],
      },
    });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let getImages: ((ids: number[]) => Promise<unknown[]>) | null = null;
    function G() {
      getImages = useGatedImages().getImages as typeof getImages;
      return null;
    }
    render(<G />);

    await expect(getImages!([9001, 9002])).resolves.toHaveLength(1);

    const call = f.calls.at(-1)!;
    expect(call.url).toContain('/api/v1/blocks/gated-images');
    // Not `blocks/images`. Spelled as a negative because the wrong route is the
    // plausible one and it answers 200 with an empty list.
    expect(call.url).not.toMatch(/\/api\/v1\/blocks\/images\b/);
    expect(call.method).toBe('GET');
    // Comma-DELIMITED in one param, which is what `commaDelimitedNumberArray`
    // parses — `ids=9001&ids=9002` is a different wire and the route rejects it.
    expect(call.url).toContain('ids=9001%2C9002');
  });

  /**
   * 🔴 A MALFORMED 200 MUST THROW, NEVER ANSWER "no rows" — AND THIS TEST USED TO
   * PIN THE OPPOSITE. It asserted `resolves.toEqual([])` for a reply carrying no
   * `images` key, which made a guard read as coverage while licensing the wrong
   * answer: an empty map makes `resolveEntryImages` report `allGone`, and
   * `GalleryPanel` then renders `gm-gallery-all-gone` — *"The images in this matrix
   * are no longer available."* That sentence is FALSE for a reply the app failed to
   * understand, and the honest state (`gm-gallery-images-error`) is already wired to
   * `App.tsx`'s own `.catch()` on this very call.
   *
   * Watched to FAIL against the `?? []` this replaced: the old code resolves `[]`
   * and a rejects-assertion goes red with "promise resolved ... instead of rejecting".
   */
  it('useGatedImages THROWS on a malformed 200 rather than reporting "no images"', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'blocks/gated-images': {} });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let getImages: ((ids: number[]) => Promise<unknown[]>) | null = null;
    function G() {
      getImages = useGatedImages().getImages as typeof getImages;
      return null;
    }
    render(<G />);

    // The MESSAGE is asserted, not merely "it rejected": `App.tsx` funnels every
    // rejection from this call into one `{ kind: 'error' }`, so the message is the
    // only thing that tells a reader which failure they are looking at.
    await expect(getImages!([1])).rejects.toThrow(/malformed response \(no `images` array\)/);
  });

  /**
   * The other half, and what stops the fix above from being over-wide: a reply that
   * genuinely carries an EMPTY array still RESOLVES. Misses are reported by omission
   * on this route, so `{ images: [] }` means "none of those ids are visible to you",
   * which the per-cell `gone` state reflects honestly. A fix that threw on emptiness
   * too would turn a legitimate answer into an error, and this is the case that
   * fails if anyone widens it that way.
   */
  it('useGatedImages resolves an explicitly EMPTY images array as an answer', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'blocks/gated-images': { images: [] } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let getImages: ((ids: number[]) => Promise<unknown[]>) | null = null;
    function G() {
      getImages = useGatedImages().getImages as typeof getImages;
      return null;
    }
    render(<G />);

    await expect(getImages!([1])).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the money path's request deadline
// ---------------------------------------------------------------------------

describe('group 3: the money path carries a request deadline', () => {
  /** The bridge's `WORKFLOW_REQUEST_TIMEOUT_MS`, restated rather than imported. */
  const EXPECTED_MS = 120_000;

  function mountWorkflow() {
    let fns: ReturnType<typeof useBuzzWorkflow> | null = null;
    function W() {
      fns = useBuzzWorkflow();
      return null;
    }
    render(<W />);
    return () => fns!;
  }

  /**
   * 🔴 THE FOUR MONEY-PATH CALLS MUST CARRY A DEADLINE, AND POLL IS THE ONE THAT
   * TURNS ITS ABSENCE INTO A PERMANENT STALL. The bridge gave estimate / submit /
   * poll / cancel an explicit `WORKFLOW_REQUEST_TIMEOUT_MS` (120s); the SDK's
   * `createHttp` forwards only `opts.signal`, so a call passing none has no deadline
   * at all. `runPollLoop` advances `attempt` and reaches `giveUp()`
   * (`CELL_TIMEDOUT`) ONLY from its `catch`, so a request that never settles never
   * rejects, never re-ticks, and leaves the cell on `polling` forever with the app's
   * own bounded-poll guard silently disabled.
   *
   * 🔴 THE NUMBER IS ASSERTED, NOT JUST "A SIGNAL EXISTS". `AbortSignal` does not
   * expose its own deadline, so the spy on `AbortSignal.timeout` is the only place
   * the 120_000 is observable — and a test that merely checked `signal != null`
   * would pass on any wrong bound, which is the defect's own shape one level over.
   * Both halves are asserted: the DURATION here, and the WIRING (that the signal
   * actually reaches `fetch` and is honoured) in the case below.
   *
   * Watched to FAIL on `30f30b0`: with no `workflowRequestOpts()` in the call the
   * spy records nothing and `signal` arrives `undefined` — red on both assertions
   * for all four routes.
   */
  const OPS: ReadonlyArray<[string, string, (w: ReturnType<typeof useBuzzWorkflow>) => Promise<unknown>]> =
    [
      ['estimate', 'blocks/workflows/estimate', (w) => w.estimate({} as never)],
      ['submit', 'blocks/workflows/submit', (w) => w.submit({} as never)],
      ['poll', 'blocks/workflows/poll', (w) => w.poll('wf-1')],
      ['cancel', 'blocks/workflows/cancel', (w) => w.cancel('wf-1')],
    ];

  it.each(OPS)('%s passes AbortSignal.timeout(120_000) through to fetch', async (_name, route, call) => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const t = fakeTransport();
    const f = fakeFetch({ [route]: { snapshot: { status: 'succeeded', cost: { total: 3 } } } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    const w = mountWorkflow();
    await call(w());

    const made = f.calls.find((c) => c.url.includes(route))!;
    expect(made).toBeDefined();
    expect(made.signal).toBeInstanceOf(AbortSignal);
    expect(spy.mock.calls.map(([ms]) => ms)).toContain(EXPECTED_MS);
  });

  /**
   * 🔴 THE WIRING HALF — the positive control for the case above, and the one that
   * proves the signal is not merely constructed but OBSERVED. `AbortSignal.timeout`
   * is stubbed to a 10ms deadline (so the assertion fits a test budget) against a
   * fetch that honours the signal and otherwise never settles. `poll` must reject;
   * under the unbounded call it hangs and this times out.
   *
   * The stub is what makes this fast, so the DURATION claim deliberately does not
   * live here — it lives in the case above, which does not stub the value.
   */
  it('a hung poll REJECTS because the deadline signal reaches fetch', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('deadline (stubbed short)')), 10);
      return ac.signal;
    });
    const t = fakeTransport();
    // A fetch that NEVER answers, but does honour a signal — i.e. a wedged
    // orchestrator round-trip, which is precisely the case with no observable.
    const hanging = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    ) as unknown as typeof globalThis.fetch;
    configureSdkRuntime({ transport: t.transport as never, fetch: hanging });

    const w = mountWorkflow();

    await expect(w().poll('wf-1')).rejects.toThrow(/deadline \(stubbed short\)/);
  });
});

// ---------------------------------------------------------------------------
// where the REST calls are AIMED
// ---------------------------------------------------------------------------

describe('the site base URL is derived from the validated host origin', () => {
  const PREVIEW = 'https://pr-42.civitaic.com';

  /**
   * 🔴 EVERY REST CALL USED TO BE HARDCODED TO PRODUCTION, WHICH BREAKS THIS REPO'S
   * OWN DOCUMENTED PREVIEW FLOW. `@civitai/sdk`'s fallback is the ABSOLUTE
   * `DEFAULT_SITE_URL = 'https://civitai.com/api/v1'`, and nothing read
   * `snapshot.hostOrigin` — so a block rendered inside the preview page host
   * `.env.production` tells the operator to allow (`https://pr-<N>.civitaic.com`)
   * would talk to PRODUCTION. On the bridge every data call went to whichever host
   * was the parent.
   *
   * `hostOrigin` is the right source and the safe one: the bridge sets it once from
   * the `event.origin` of the first `BLOCK_INIT` that cleared the allowlist gate,
   * and `@civitai/blocks-react`'s `useHostOrigin` documents it as *"the validated
   * host (parent) origin the block may safely direct-fetch the civitai App Blocks
   * HTTP API against"*.
   *
   * Watched to FAIL on `30f30b0`: the URL comes back
   * `https://civitai.com/api/v1/blocks/workflows/query`, so `toContain(PREVIEW)`
   * goes red.
   */
  it('aims REST at the parent host, not at production', async () => {
    const t = fakeTransport(baseSnapshot({ hostOrigin: PREVIEW }));
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Q() {
      useAppWorkflows();
      return null;
    }
    render(<Q />);
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    expect(f.calls[0]!.url).toBe(`${PREVIEW}/api/v1/blocks/workflows/query`);
    // Spelled as a negative too, because production is the plausible wrong answer
    // and it answers 200 — a preview run would spend real Buzz against the real
    // gallery rather than failing visibly.
    expect(f.calls[0]!.url).not.toContain('civitai.com/api/v1');
  });

  /**
   * 🔴 THE ORDERING CASE, AND THE ONE A SYNCHRONOUS READ GETS WRONG WHILE LOOKING
   * FIXED. `initialize`'s `siteUrl` is captured at CALL time, and `app()`'s first
   * caller is `useAppWorkflows`'s mount effect — which runs BEFORE `BLOCK_INIT`
   * lands, because `BlockGate` renders children immediately when embedded. So a
   * plain `snapshot.get().hostOrigin` read here would find `null` on essentially
   * every production boot and fall back to the SDK default, leaving the defect
   * entirely in place. This mounts with NO host origin and supplies it afterwards.
   *
   * Watched to FAIL against a synchronous read (`siteUrlFromHostOrigin(t.snapshot.
   * get().hostOrigin)` with no wait): the call goes to `civitai.com` and this is red.
   */
  it('WAITS for a host origin that arrives after mount', async () => {
    const t = fakeTransport(baseSnapshot({ ready: false, hostOrigin: null }));
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Q() {
      useAppWorkflows();
      return null;
    }
    render(<Q />);

    // Nothing may have gone out yet — the runtime has no destination to aim at.
    expect(f.calls.length).toBe(0);

    act(() => t.set(baseSnapshot({ hostOrigin: PREVIEW })));
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    expect(f.calls[0]!.url).toBe(`${PREVIEW}/api/v1/blocks/workflows/query`);
  });

  /**
   * The termination case. A snapshot that reports `ready` and carries NO host origin
   * will never gain one — the bridge sets `parentOrigin` and the ready snapshot in
   * the same `BLOCK_INIT` branch and emits once — so the runtime must stop waiting
   * and let the SDK's own default stand rather than stall for its whole timeout.
   * Without this rule every test fake and the inline transport would block for 10s.
   */
  it('does not wait once ready is true with no host origin', async () => {
    const t = fakeTransport(baseSnapshot({ hostOrigin: null }));
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Q() {
      useAppWorkflows();
      return null;
    }
    render(<Q />);
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    expect(f.calls[0]!.url).toBe('https://civitai.com/api/v1/blocks/workflows/query');
  });

  /** An explicit override still wins — the dev harness depends on it. */
  it('an explicit siteUrl override beats the derived one', async () => {
    const t = fakeTransport(baseSnapshot({ hostOrigin: PREVIEW }));
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({
      transport: t.transport as never,
      fetch: f.impl,
      siteUrl: 'http://localhost:5187/api/v1',
    });

    function Q() {
      useAppWorkflows();
      return null;
    }
    render(<Q />);
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));

    expect(f.calls[0]!.url).toBe('http://localhost:5187/api/v1/blocks/workflows/query');
  });
});

// ---------------------------------------------------------------------------
// the configuration seam itself
// ---------------------------------------------------------------------------

describe('configureSdkRuntime', () => {
  /**
   * 🔴 A RECONFIGURE MUST TAKE EFFECT. `mountShared` in
   * `App.integration.test.tsx` reconfigures per mount (the transport is reset, so
   * the AppClient bound to it has to be rebuilt) while keeping ONE `fetch` as the
   * "disk" the reload reads back. A configure that kept the old client would serve
   * the previous mount's stale client — the exact hazard this drops it to avoid.
   */
  it('a reconfigure DROPS the client, so the new fetch is the one that answers', async () => {
    const t = fakeTransport();
    const first = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: 'one' } });
    configureSdkRuntime({ transport: t.transport as never, fetch: first.impl });

    function Q() {
      const { cursor } = useAppWorkflows();
      return <span data-testid="c">{cursor ?? 'none'}</span>;
    }
    const one = render(<Q />);
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('one'));
    one.unmount();

    const second = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: 'two' } });
    configureSdkRuntime({ transport: t.transport as never, fetch: second.impl });

    render(<Q />);
    // Reads 'two' only if the client was rebuilt on the new fetch. Under a
    // configure that kept the old promise this stays 'one'.
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('two'));
    expect(second.calls.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE REGRESSION GUARD FOR THIS REPO'S OWN TEST SETUP.
   *
   * `src/test-setup.ts` calls `resetTransport()` in a global `beforeEach`, which
   * NULLS the bridge's process-wide transport so the next `getTransport()` builds a
   * new object. A runtime caching its adapter with a plain `??=` would keep wrapping
   * the DISPOSED transport, and every later test in the process would read a dead
   * snapshot with nothing saying so.
   *
   * 🔴 THE OBSERVABLE HAS TO BE A FIELD WHOSE VALUE DIFFERS BETWEEN THE TWO
   * TRANSPORTS. "Does not throw" is no discriminator — `dispose()` only drops
   * listeners, so `getSnapshot()` on a disposed transport still answers with its
   * last value — and neither is `ready`, which is already `true` on the old one. So:
   * anonymous on the first, signed-in on the second. Under an unkeyed cache the
   * second render reads transport #1 and reports 'anon'.
   */
  it('follows the bridge transport across a resetTransport()', async () => {
    const { installHarnessTransport, resetHarnessTransport } = await import('../dev-transport.js');
    const { getTransport } = await import('@civitai/blocks-react');
    const { Harness } = await import('@civitai/blocks-react/testing');

    function Who() {
      const { viewer } = useBlockContext();
      return <span data-testid="who">{viewer?.username ?? 'anon'}</span>;
    }

    installHarnessTransport();
    const first = getTransport();
    // No explicit transport: this is the branch that derives one from the bridge.
    configureSdkRuntime({});

    const one = render(
      <Harness viewer={null} applyUrlToggles={false} showLog={false}>
        <Who />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('anon'));
    one.unmount();

    resetHarnessTransport();
    // The premise the guard rests on. Without this the test could not tell a keyed
    // cache from an unkeyed one and would pass either way.
    expect(getTransport()).not.toBe(first);

    render(
      <Harness viewer={{ id: 42, username: 'porter' }} applyUrlToggles={false} showLog={false}>
        <Who />
      </Harness>,
    );

    // Reads the NEW transport, or it does not read the port at all.
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('porter'));
  });

  it('resetSdkRuntime clears an installed fetch', async () => {
    const t = fakeTransport();
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: null } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });
    resetSdkRuntime();
    // 🔴 The leak this closes is a FALSE PASS: without it one test's REST fake
    // answers every later test in the same file, so a case that seeded nothing
    // silently reads the previous case's store. Re-configuring with a transport but
    // NO fetch must not resurrect the old one.
    configureSdkRuntime({ transport: t.transport as never });
    function Q() {
      useAppWorkflows();
      return null;
    }
    render(<Q />);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.length).toBe(0);
  });

  /**
   * 🔴 A REJECTED `initialize()` MUST NOT POISON THE PAGE FOR ITS WHOLE LIFE. The
   * runtime cached the AppClient with `appPromise ??= initialize({...})`, and `??=`
   * assigns only when the left side is nullish — so a promise that SETTLED REJECTED
   * is never reassigned. `initialize` awaits `ready(transport, 10_000)` and rejects
   * on timeout, and its first caller is `useAppWorkflows`'s mount effect, which is
   * not gated on `ready` and starts that clock before `BLOCK_INIT` has landed. One
   * slow host handshake therefore killed app storage, the gallery AND the money path
   * for the rest of the page, with nothing retrying because every caller awaited the
   * same dead promise.
   *
   * ⚠ HOW THE REJECTION IS PRODUCED HERE, STATED PLAINLY: a transport whose
   * `snapshot.get()` throws, which makes `ready()` throw on its very first line
   * inside `initialize` and gives a REAL rejected `initialize()` with no 10-second
   * wait and no dangling timer. `siteUrl` is supplied so the base-URL derivation
   * does not read the snapshot first and pre-empt it. The predicate under test — is
   * a rejected `app()` cached forever — is the same one either way, and the `retry`
   * below is the observable that separates the two implementations.
   *
   * Watched to FAIL on `30f30b0` (`appPromise ??= …`): the retry re-awaits the same
   * rejected promise, `cursor` never leaves 'none', and the final `waitFor` times
   * out.
   */
  it('does NOT cache a rejected initialize() — a later call retries', async () => {
    const inner = fakeTransport();
    let broken = true;
    const brittle = {
      ...inner.transport,
      snapshot: {
        get: () => {
          if (broken) throw new Error('BLOCK_INIT never landed');
          return inner.transport.snapshot.get();
        },
        subscribe: inner.transport.snapshot.subscribe,
      },
    };
    const f = fakeFetch({ 'blocks/workflows/query': { workflows: [], cursor: 'landed' } });
    configureSdkRuntime({
      transport: brittle as never,
      fetch: f.impl,
      siteUrl: 'https://civitai.com/api/v1',
    });

    function Q() {
      const { cursor, error, refetch } = useAppWorkflows();
      return (
        <div>
          <span data-testid="c">{cursor ?? 'none'}</span>
          <span data-testid="e">{error ? 'err' : 'ok'}</span>
          <button type="button" data-testid="retry" onClick={refetch}>
            retry
          </button>
        </div>
      );
    }
    render(<Q />);

    // The first attempt fails, and nothing reached the wire.
    await waitFor(() => expect(screen.getByTestId('e').textContent).toBe('err'));
    expect(f.calls.length).toBe(0);

    broken = false;
    act(() => screen.getByTestId('retry').click());

    // Only reachable if the failed promise was dropped and a fresh initialize ran.
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('landed'));
  });

  // ⚠ NOT COVERED, SAID RATHER THAN IMPLIED: the `appPromise === pending` identity
  // check inside that `catch` has no test of its own. Its failure mode — a late
  // rejection clearing a client a concurrent `configureSdkRuntime` had already
  // installed — costs one extra rebuild and is not observable through any binding
  // this module exports, so a test for it would have to assert on private state.
  // The guard stays because dropping it makes a reconfigure racing a doomed init
  // non-deterministic; it is not claimed as covered.
});
