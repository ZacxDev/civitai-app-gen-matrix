import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { getTransport } from '@civitai/blocks-react';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';
import { ToastProvider } from '@civitai/components-react';

// Design-system styles as an explicit FIRST-PAINT source (the host can't inject
// CSS into the block iframe). `@civitai/theme` defines the `--civitai-*` tokens
// (theme.ts reads them); `@civitai/components` styles the attribute-driven
// primitives (Slider/Toast/Tooltip/Image/SegmentedControl). Both flip on the
// root `data-theme` App sets from useBlockContext().theme.
import '@civitai/theme/styles.css';
import '@civitai/components/styles.css';

import { App } from './App.js';
import { RootBoundary } from './ErrorBoundary.js';
import './index.css';

// Idempotent runtime re-inject (covers the BlockGate landing + any style that a
// static import order missed).
injectBlocksStyles();

// `pnpm dev:harness` sets VITE_DEV_HARNESS=true to mount the SHARED SDK mock
// host (`@civitai/blocks-react/testing` → `<Harness>`), which posts a fake
// BLOCK_INIT (page context, entity=none), answers the consent + token-refresh
// round-trip, simulates the orchestrator money path, AND now serves the
// `useAppWorkflows` / `useAppStorage` read-model + KV so the M1 persistence path
// is exercisable locally. Never set VITE_DEV_HARNESS in a prod build.
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
  // BlockGate shows an "Open on Civitai" landing when the app is loaded top-level
  // at its bare origin (no BLOCK_INIT); it is inert on the embedded happy path.
  // RootBoundary (G2) is mounted INSIDE it so useBlockAnalytics() has host
  // context when it reports a caught render crash. ToastProvider supplies the
  // design-system toast queue App's useToast() consumes.
  const inner = useHarness ? (
    // Dynamic import keeps the `/testing` mock host out of any non-harness
    // bundle path (it's a dev-only subpath; never shipped to prod).
    await (async () => {
      const { Harness } = await import('@civitai/blocks-react/testing');
      return (
        <Harness>
          <App />
        </Harness>
      );
    })()
  ) : (
    <App />
  );

  createRoot(container!).render(
    <StrictMode>
      <BlockGate>
        <RootBoundary>
          <ToastProvider>{inner}</ToastProvider>
        </RootBoundary>
      </BlockGate>
    </StrictMode>,
  );
}

void bootstrap();
