// Test/dev-only transport wiring. NOT reached by the production runtime — which
// is the point of the file existing at all.
//
// 🔴 WHY THIS IS SPLIT OUT RATHER THAN LEFT INLINE IN `main.tsx`. The bridge
// transport is a process-wide singleton and the FIRST `getTransport()` call
// decides its origin allowlist. In production that allowlist comes from
// `VITE_BLOCK_ALLOWED_PARENT_ORIGINS`, baked in at build time (`.env.production`
// — a wrong value there means the transport drops every host message and the
// iframe renders blank). But the mock host — the dev harness AND every jsdom test
// — replies from `window.location.origin`, and the transport DROPS any inbound
// message whose origin is not allowlisted, so `BLOCK_INIT` never lands unless
// that origin is allowed BEFORE any binding (or the mock host) runs.
//
// Keeping that call here rather than at the top of `main.tsx` is what takes the
// production entrypoint off the bare `@civitai/blocks-react` import. `main.tsx`
// reaches this module only inside its `VITE_DEV_HARNESS` branch, alongside the
// dynamic `/testing` import it already gates the same way.
//
// `/ui` (`BlockGate`, `injectBlocksStyles`) is a separate matter and stays — see
// `src/lib/sdk-transport.ts` for why that keeps the bridge transport alive in
// production regardless, and why the SDK adapts it instead of building a second.

import { getTransport } from '@civitai/blocks-react';
import { resetTransport } from '@civitai/blocks-react/testing';

/** Initialize the bridge transport with the current page origin allowlisted. */
export function installHarnessTransport(): void {
  getTransport({ allowedParentOrigins: [window.location.origin] });
}

/**
 * Reset + re-initialize the transport for a single test (call in `beforeEach`).
 *
 * 🔴 `resetTransport()` NULLS the singleton, so the next `getTransport()` builds a
 * BRAND-NEW object. `src/lib/sdk-runtime.ts` keys its adapter cache on the bridge
 * transport's identity for exactly this reason — without that, every test after
 * the first would read a disposed transport's snapshot with nothing saying so.
 */
export function resetHarnessTransport(): void {
  resetTransport();
  getTransport({ allowedParentOrigins: [window.location.origin] });
}
