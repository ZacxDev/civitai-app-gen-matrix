import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { getTransport } from '@civitai/blocks-react';

import { App } from './App.js';
import './index.css';

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
    createRoot(container!).render(
      <StrictMode>
        <Harness>
          <App />
        </Harness>
      </StrictMode>,
    );
    return;
  }

  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
