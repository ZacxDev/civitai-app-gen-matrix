import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { getTransport } from '@civitai/blocks-react';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';

// Design-system tokens (`--civitai-*` custom properties, light/dark via
// `[data-theme]`). The pack's injectBlocksStyles() also injects these at
// runtime, but importing the stylesheet makes @civitai/theme an explicit,
// first-paint token source rather than a transitive side-effect of the pack.
import '@civitai/theme/styles.css';

import { App } from './App.js';
import './index.css';

// Inject the /ui pack's themed stylesheet once up-front (idempotent; the pack
// components also self-inject on first render — this just guarantees tokens +
// component CSS exist before the first paint).
injectBlocksStyles();

// `pnpm dev:harness` sets VITE_DEV_HARNESS=true to mount the SHARED SDK mock
// host (`@civitai/blocks-react/testing` → `<Harness>`), which posts a fake
// BLOCK_INIT (page context, entity=none), answers the consent + token-refresh
// round-trip, and simulates the orchestrator money path (estimate / submit /
// poll) for MANY concurrent cells. It honors the same URL toggles the old
// hand-rolled harness did (?viewer/?consent/?fail/?theme/?pick/?pickCkpt).
// Never set VITE_DEV_HARNESS in a prod build.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

if (useHarness) {
  // The SDK mock host replies from `window.location.origin`, and the SDK
  // IframeTransport DROPS any inbound postMessage whose origin isn't in its
  // allowlist — so BLOCK_INIT never lands unless this origin is allowed. The
  // dev build also bakes VITE_BLOCK_ALLOWED_PARENT_ORIGINS=http://localhost:5187
  // (matching the pinned dev server origin), but we instantiate the transport
  // here with `window.location.origin` explicitly so the harness is correct
  // even if the dev origin drifts. getTransport's first-call-with-options wins,
  // so this is authoritative for the dev session before any hook runs.
  getTransport({ allowedParentOrigins: [window.location.origin] });
}

async function bootstrap() {
  if (useHarness) {
    // Dynamic import keeps the `/testing` mock host out of any non-harness
    // bundle path (it's a dev-only subpath; never shipped to prod).
    const { Harness } = await import('@civitai/blocks-react/testing');
    // BlockGate is the OUTER wrapper (Harness + App inside it), so on first
    // render — before BLOCK_INIT lands — BlockGate renders its children (which
    // mounts the Harness → mock host → BLOCK_INIT within the 2s direct-load
    // window), flipping `ready` true before the fallback timer fires. Nesting
    // Harness OUTSIDE BlockGate instead leaves BlockGate showing its direct-load
    // fallback in the harness (the mock host's pushed BLOCK_INIT never clears it).
    createRoot(container!).render(
      <StrictMode>
        <BlockGate>
          <Harness>
            <App />
          </Harness>
        </BlockGate>
      </StrictMode>,
    );
    return;
  }

  // `<BlockGate>` shows an "Open on Civitai" landing when the block is loaded
  // DIRECTLY (top-level at its bare `<slug>.civit.ai` origin, no BLOCK_INIT)
  // instead of hanging on the app's loading state. It's inert on the embedded
  // happy path (BLOCK_INIT arrives), so the app renders unchanged there.
  createRoot(container!).render(
    <StrictMode>
      <BlockGate>
        <App />
      </BlockGate>
    </StrictMode>,
  );
}

void bootstrap();
