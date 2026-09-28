// Setup for the `dom` vitest project (jsdom + Testing Library). Loaded per
// *.test.tsx file. Registers jest-dom matchers, stubs matchMedia (jsdom has
// none), and resets the bridge transport singleton, the SDK runtime and the DOM
// between tests so one test's fakes never leak into the next.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetTransport } from '@civitai/blocks-react/testing';

import { resetSdkRuntime } from './lib/sdk-runtime.js';

// The design-system components inject a stylesheet on mount that uses modern CSS
// (`@property`, `@layer`, `color-mix()`, nesting) which jsdom's CSS parser can't
// handle — it throws "Could not parse CSS stylesheet". The injected styling is
// irrelevant to behaviour/attribute assertions, so no-op the injector in tests.
vi.mock('@civitai/components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@civitai/components')>();
  return { ...actual, injectStyles: () => {} };
});

/** A matchMedia stub (default: desktop — the wide layout). */
function makeMatchMedia(matches: boolean) {
  return (query: string): MediaQueryList =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

beforeEach(() => {
  resetTransport();
  vi.stubGlobal('matchMedia', makeMatchMedia(false));
});

afterEach(() => {
  cleanup();
  resetTransport();
  // 🔴 THE COUNTERPART `resetTransport()` ALONE NO LONGER COVERS. `sdk-runtime`
  // holds three process-wide things — the adapted transport, the AppClient built
  // on it, and the `fetch` a test installed via `configureSdkRuntime`. The first
  // two are keyed on the bridge transport's identity, so `resetTransport()` does
  // invalidate them; the `fetch` is NOT, so without this a test's REST fake
  // answers every later test in the same file. The direction of that leak is a
  // false PASS: a case that seeded nothing would silently read the previous
  // case's store.
  resetSdkRuntime();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
