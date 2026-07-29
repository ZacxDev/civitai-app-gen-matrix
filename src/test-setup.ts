// Setup for the `dom` vitest project (jsdom + Testing Library). Loaded per
// *.test.tsx file. Registers jest-dom matchers, stubs matchMedia (jsdom has
// none), and resets the SDK transport singleton + DOM between tests so a mock
// host from one test never leaks into the next.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetTransport } from '@civitai/blocks-react/testing';

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
