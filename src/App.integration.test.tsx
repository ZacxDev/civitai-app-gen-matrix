import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import { ToastProvider } from '@civitai/components-react';

import { App } from './App.js';
import { CHECKPOINTS, MODIFIERS } from './models.js';
import { buildMatrix, type MatrixCell } from './matrix.js';
import { RUN_STORAGE_KEY, buildRunManifest } from './persistence.js';

// The block bundles its allowed-parent-origins from env; in the test env the mock
// host fires from window.location.origin, so allow it via the transport (main.tsx
// does this in the harness path; tests must too or BLOCK_INIT never lands).
import { getTransport } from '@civitai/blocks-react';

function renderApp(harnessProps: Record<string, unknown>): void {
  getTransport({ allowedParentOrigins: [window.location.origin] });
  const wrap = (children: ReactNode) => (
    <ToastProvider>
      <Harness applyUrlToggles={false} showLog={false} {...harnessProps}>
        {children}
      </Harness>
    </ToastProvider>
  );
  render(wrap(<App />));
}

const viewer = { id: 42, username: 'tester' };

describe('App money-path integration (mock host)', () => {
  it('happy path: build → confirm → run spends real Buzz and shows the total', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      buzzBudget: 200,
      generation: { costPerGen: 8, images: ['https://img.example/out.jpeg'] },
    });

    // Wait for the block to be ready (build panel visible).
    const promptBox = await screen.findByLabelText('Shared generation prompt');
    await userEvent.type(promptBox, 'a serene lake');

    // Generate → the confirm gate (nothing spent yet).
    await userEvent.click(await screen.findByTestId('gm-generate'));
    const confirm = await screen.findByTestId('gm-confirm');
    expect(screen.getByText(/nothing is spent until you confirm/i)).toBeInTheDocument();

    // Confirm → the TWO default cells (SD XL × [No style, Cinematic]) run to done.
    // The out-of-box default selects a 2nd style so the first run demonstrates a
    // real comparison (I4), so the run spends 2 × 8 = 16 Buzz.
    await userEvent.click(confirm);

    // The run reaches done and the spent total reflects the real (mock) charge.
    await waitFor(
      () => expect(screen.getByText(/spent 16 Buzz/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );
    // Both paid results rendered through the maturity gate.
    expect(screen.getAllByTestId('gm-maturity-image').length).toBe(2);
  });

  it('M1: a persisted run is rebuilt on mount from storage (paid outputs not lost)', async () => {
    // Seed a completed 2-cell run into the per-viewer KV under the run key.
    const cells = buildMatrix('a cat', [CHECKPOINTS[0]], [MODIFIERS[0], MODIFIERS[1]]).map(
      (cell, i): MatrixCell => ({
        ...cell,
        status: 'done',
        workflowId: `wf_${i}`,
        imageUrl: `https://img.example/${i}.jpeg`,
        cost: 8,
        nsfwLevel: 1,
      }),
    );
    const manifest = buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 });

    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: manifest } },
      appWorkflows: {
        workflows: [
          { workflowId: 'wf_0', status: 'succeeded', images: [{ url: 'https://img.example/0.jpeg', width: 1, height: 1, nsfwLevel: 1 }], cost: 8, createdAt: new Date().toISOString() },
          { workflowId: 'wf_1', status: 'succeeded', images: [{ url: 'https://img.example/1.jpeg', width: 1, height: 1, nsfwLevel: 1 }], cost: 8, createdAt: new Date().toISOString() },
        ],
      },
    });

    // Without any user action, the grid rebuilds the paid matrix: 2 done cells,
    // spent 16 Buzz total — proving the reload didn't "pay for nothing".
    await waitFor(
      () => expect(screen.getByText(/spent 16 Buzz/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(screen.getAllByTestId('gm-maturity-image').length).toBe(2);
    // The build panel is NOT shown — we resumed straight into the results grid.
    expect(screen.queryByLabelText('Shared generation prompt')).toBeNull();
  });

  it('I4: the default selection pre-picks TWO styles so the first run is a comparison', async () => {
    renderApp({ viewer, consentGranted: true, buzzBudget: 200 });
    await screen.findByLabelText('Shared generation prompt');
    // No-style (baseline) + Cinematic are both pre-selected out of the box.
    expect(screen.getByRole('button', { name: 'No style (plain prompt)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Cinematic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A non-default style stays unselected.
    expect(screen.getByRole('button', { name: 'Anime' })).toHaveAttribute('aria-pressed', 'false');
    // → 2 default cells (1 checkpoint × 2 styles).
    expect(screen.getByTestId('gm-generate')).toHaveTextContent(/2 cells/);
  });

  it('I2: "New matrix" asks to confirm before clearing paid results; cancel keeps them', async () => {
    // Reuse the M1 restore path to land directly in the DONE results grid.
    const cells = buildMatrix('a cat', [CHECKPOINTS[0]], [MODIFIERS[0], MODIFIERS[1]]).map(
      (cell, i): MatrixCell => ({
        ...cell,
        status: 'done',
        workflowId: `wf_${i}`,
        imageUrl: `https://img.example/${i}.jpeg`,
        cost: 8,
        nsfwLevel: 1,
      }),
    );
    const manifest = buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 });
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: manifest } },
      appWorkflows: {
        workflows: [
          { workflowId: 'wf_0', status: 'succeeded', images: [{ url: 'https://img.example/0.jpeg', width: 1, height: 1, nsfwLevel: 1 }], cost: 8, createdAt: new Date().toISOString() },
          { workflowId: 'wf_1', status: 'succeeded', images: [{ url: 'https://img.example/1.jpeg', width: 1, height: 1, nsfwLevel: 1 }], cost: 8, createdAt: new Date().toISOString() },
        ],
      },
    });

    // Wait for the restored results grid.
    await waitFor(() => expect(screen.getByTestId('gm-newrun')).toBeInTheDocument(), {
      timeout: 4000,
    });

    // Clicking "New matrix" does NOT immediately clear — it asks to confirm.
    await userEvent.click(screen.getByTestId('gm-newrun'));
    expect(await screen.findByTestId('gm-reset-confirm')).toBeInTheDocument();
    // Results are still on screen behind the dialog.
    expect(screen.getAllByTestId('gm-maturity-image').length).toBe(2);

    // Cancel → dialog closes, results preserved, still no build panel.
    await userEvent.click(screen.getByTestId('gm-reset-cancel'));
    await waitFor(() => expect(screen.queryByTestId('gm-reset-confirm')).toBeNull());
    expect(screen.getAllByTestId('gm-maturity-image').length).toBe(2);
    expect(screen.queryByLabelText('Shared generation prompt')).toBeNull();

    // New matrix again → confirm → the run clears back to the build panel.
    await userEvent.click(screen.getByTestId('gm-newrun'));
    await userEvent.click(await screen.findByTestId('gm-reset-confirm'));
    expect(await screen.findByLabelText('Shared generation prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-newrun')).toBeNull();
  });
});

/**
 * 🔴 THE SEAM THE COMPONENT TESTS CANNOT REACH. `sharedPromptFromCells` is
 * verified as a pure function and `ResultGrid` is verified against a
 * `sharedPrompt` prop, but WHICH string App hands it is decided in App — and the
 * dangerous wrong answer, the live `prompt` state, is available there and
 * nowhere else. Both halves can be individually correct while the screen shows
 * the wrong prompt entirely, and only a test that drives the real restore can
 * see it.
 */
describe('a restored matrix shows the prompt that produced IT', () => {
  const restoredPrompt = 'a lighthouse in fog';

  function seedDoneRun(key: string) {
    const cells = buildMatrix(restoredPrompt, [CHECKPOINTS[0]], [MODIFIERS[0], MODIFIERS[1]]).map(
      (cell, i): MatrixCell => ({
        ...cell,
        status: 'done',
        workflowId: `wf_${i}`,
        imageUrl: `https://img.example/${i}.jpeg`,
        cost: 8,
        nsfwLevel: 1,
      }),
    );
    return { [key]: buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 }) };
  }

  it('shows the run’s own prompt, not the empty form state', async () => {
    // 🔴 THE FORM HAS RESET. On a restore the textarea is empty, so a header
    // that recomputed the prompt from current state would caption a paid matrix
    // with a blank — or, worse, with whatever the viewer typed next. Reading it
    // back off the run's own cells is what makes the caption true.
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: seedDoneRun(RUN_STORAGE_KEY) },
    });

    await waitFor(() => expect(screen.getByTestId('gm-run-prompt')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByTestId('gm-run-prompt').textContent).toContain(restoredPrompt);
  });

  it('migrates the legacy single-slot run instead of stranding it', async () => {
    // The viewer who was mid-run when this shipped: their matrix lives in the
    // OLD `gen-matrix:run:v1` key. If the app only ever looked at the new
    // keyspace they would land on an empty build screen while a run they paid
    // for sat unreachable in storage.
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: seedDoneRun(RUN_STORAGE_KEY) },
    });

    // Restored: the paid images are on screen and the build panel is gone.
    await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(2), {
      timeout: 4000,
    });
    expect(screen.queryByLabelText('Shared generation prompt')).toBeNull();
  });

  it('replays the elapsed time the run RECORDED, not one measured from the reload', async () => {
    // 🔴 The stamps must come off the manifest. Measuring from the restore would
    // give a matrix generated last week a four-second runtime — a fabricated
    // number, which is strictly worse than the blank a stamp-less run gets.
    // (That a stamp-less run shows nothing is `runElapsedLabel`'s own guard.)
    const cells = buildMatrix(restoredPrompt, [CHECKPOINTS[0]], [MODIFIERS[0], MODIFIERS[1]]).map(
      (cell, i): MatrixCell => ({
        ...cell,
        status: 'done',
        workflowId: `wf_${i}`,
        imageUrl: `https://img.example/${i}.jpeg`,
        cost: 8,
        nsfwLevel: 1,
      }),
    );
    const startedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const manifest = buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 }, Date.now, {
      startedAt,
      // 95s later → "1m 35s". Distinct from every other number in this file, and
      // not a round minute, so an off-by-one in either direction is visible.
      finishedAt: startedAt + 95_000,
    });

    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: manifest } },
    });

    await waitFor(() => expect(screen.getByTestId('gm-elapsed')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByTestId('gm-elapsed').textContent).toContain('1m 35s');
  });

  it('names the EFFECTIVE prompt of the cell that was enlarged', async () => {
    // The App→Lightbox half of change 3: the header shows the shared prompt,
    // but the enlarged view must show what THIS cell asked for, suffix and all.
    // Which string reaches the lightbox is decided in App, so no component test
    // can see it.
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: seedDoneRun(RUN_STORAGE_KEY) },
    });

    await waitFor(() => expect(screen.getAllByTestId('gm-enlarge').length).toBeGreaterThan(1), {
      timeout: 4000,
    });
    // MODIFIERS[1] is the second column — a styled one, so its effective prompt
    // is strictly longer than the shared prompt the header shows.
    await userEvent.click(screen.getAllByTestId('gm-enlarge')[1]);

    const shown = (await screen.findByTestId('gm-lightbox-prompt')).textContent ?? '';
    expect(shown).toContain(restoredPrompt);
    expect(shown).toContain(MODIFIERS[1].promptSuffix);
    // And it is genuinely the per-cell string, not the shared one echoed twice.
    expect(shown.length).toBeGreaterThan(restoredPrompt.length);
  });
});

/**
 * 🔴 THE SEAM NEITHER UNIT TEST CROSSES. `MatrixShapePreview` is tested against
 * BuildPanel's props and `MatrixConceptExample` is tested standalone, but which
 * of the two the SCREEN shows is decided in `App` — `billable === 0` picks the
 * explainer, `billable > 0` picks the real grid. Both components can be
 * individually correct while App shows neither, or both at once, and no test
 * scoped to one component can see that.
 *
 * The relationship is what matters here, so these assert it as a pair: exactly
 * one is present, in both directions, driven through the real default state and
 * a real click rather than by handing a component a prop.
 */
describe('the configure screen shows the grid OR the explainer, never both', () => {
  it('shows the live shape (and no explainer) at the default selection', async () => {
    renderApp({ viewer, consentGranted: true, buzzBudget: 200 });

    // Default is 1 checkpoint x 2 styles = 2 cells, so there IS a shape.
    expect(await screen.findByTestId('gm-shape-preview')).toBeInTheDocument();
    expect(screen.queryByText(/Example: 2 models/)).toBeNull();
  });

  it('falls back to the explainer (and drops the shape) at zero cells', async () => {
    renderApp({ viewer, consentGranted: true, buzzBudget: 200 });
    await screen.findByTestId('gm-shape-preview');

    // Deselect the only selected model -> 0 rows -> 0 cells. This is the state a
    // real user reaches by toggling their last checkpoint off, which is why the
    // explainer is not dead code even though the app boots with a selection.
    await userEvent.click(screen.getByRole('button', { name: /SD XL/i }));

    await waitFor(() => expect(screen.queryByTestId('gm-shape-preview')).toBeNull());
    expect(screen.getByText(/Example: 2 models/)).toBeInTheDocument();
  });
});
