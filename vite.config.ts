/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base MUST be '/' — the platform serves the build output at the root of the
// app's own subdomain and server-owns the manifest iframe.src (the W10 page
// surface iframes the bundle at /apps/run/gen-matrix). No path prefix.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    // The dev harness fires a fake BLOCK_INIT from window.location.origin and
    // the IframeTransport drops any postMessage whose origin isn't its allowed
    // parent origin. Pin host+port so that origin is stable.
    host: 'localhost',
    port: 5187,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: undefined } },
  },
  test: {
    // Two suites in one `vitest run`:
    //  - `node`: pure-logic unit tests (*.test.ts) — the matrix/queue/cost/cap +
    //            catalog/ecosystem helpers; no DOM.
    //  - `dom` : component a11y tests (*.test.tsx) — jsdom + testing-library,
    //            asserting the design-system affordances (aria-pressed / role=
    //            status / accessible names) so they can't regress silently.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
    ],
  },
});
