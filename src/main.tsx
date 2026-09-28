import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// `/ui` only. The bare `@civitai/blocks-react` import this file used to carry
// moved to `src/dev-transport.ts` and is now reached dynamically, inside the
// harness branch — see the note on the transport install in `bootstrap()`.
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

// `pnpm dev:harness` sets VITE_DEV_HARNESS=true to mount the SHARED mock host
// (`@civitai/blocks-react/testing` → `<Harness>`), which posts a fake BLOCK_INIT
// (page context, entity=none) and answers the consent + token-refresh round-trip.
// Never set VITE_DEV_HARNESS in a prod build.
//
// 🔴 THE MOCK HOST NO LONGER ANSWERS THE DATA. After the port off the bridge, the
// money path, this app's workflow read-model, app storage, shared storage and the
// gated image read are HTTP (`/api/v1/blocks/*`), and the host never sees them —
// so the harness ALSO installs `src/dev-rest.ts` as the `fetch` the SDK's REST
// clients use. Without it the harness would hand the app a live civitai.com,
// which from `localhost` is a wall of CORS failures rather than a demo.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

async function bootstrap() {
  // BlockGate shows an "Open on Civitai" landing when the app is loaded top-level
  // at its bare origin (no BLOCK_INIT); it is inert on the embedded happy path.
  // RootBoundary (G2) is mounted INSIDE it so useBlockAnalytics() has host
  // context when it reports a caught render crash. ToastProvider supplies the
  // design-system toast queue App's useToast() consumes.
  const inner = useHarness ? (
    // Dynamic imports keep the `/testing` mock host — and `dev-transport`, which
    // reaches the bare `@civitai/blocks-react` and `/testing` entries — out of
    // every non-harness bundle path. Both are dev-only; neither ships to prod.
    await (async () => {
      const { Harness } = await import('@civitai/blocks-react/testing');
      const { installHarnessTransport } = await import('./dev-transport.js');
      const { createRestFake } = await import('./dev-rest.js');
      const { configureSdkRuntime } = await import('./lib/sdk-runtime.js');

      // 🔴 BOTH INSTALLS MUST HAPPEN BEFORE THE FIRST RENDER, and they answer
      // different halves. The mock host replies from `window.location.origin`,
      // and the bridge transport DROPS any inbound postMessage whose origin is
      // not allowlisted — so BLOCK_INIT never lands unless that origin is
      // allowed first. `getTransport`'s first-call-with-options wins, which is
      // why `installHarnessTransport()` runs here rather than lazily. The dev
      // build also bakes VITE_BLOCK_ALLOWED_PARENT_ORIGINS=http://localhost:5187,
      // but naming `window.location.origin` explicitly keeps the harness correct
      // if the dev origin ever drifts.
      installHarnessTransport();
      // ...and the REST half, which the host cannot answer any more.
      //
      // 🔴 `id: 2` IS `DEFAULT_VIEWER.id` FROM THE MOCK HOST, READ OFF THE
      // INSTALLED PACKAGE (`@civitai/blocks-react` `internal/mockHost.js`:
      // `{ id: 2, username: 'dev-viewer', signedIn: true }`) — not a placeholder.
      // The two fakes have to agree on ONE viewer id: the host stamps identity
      // into `BLOCK_INIT`, and this fake derives `viewerVoted` and default row
      // authorship from the id it is given. A mismatch makes the harness's
      // gallery show every row as somebody else's — no Remove, vote state always
      // off — which reads as a UI bug rather than as two fakes disagreeing.
      configureSdkRuntime({ fetch: createRestFake({ viewer: { id: 2 } }) });

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
