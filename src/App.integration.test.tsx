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
