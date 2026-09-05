import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { Harness, createMockHost, resetTransport } from '@civitai/blocks-react/testing';
import { ToastProvider } from '@civitai/components-react';

import { App } from './App.js';
import { CHECKPOINTS, MODIFIERS } from './models.js';
import { buildMatrix, type MatrixCell } from './matrix.js';
import { RUN_STORAGE_KEY, buildRunManifest } from './persistence.js';
import { historyKeyFor } from './history.js';

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

/**
 * Mount the app against a mock host the TEST owns, so it can be remounted
 * against the SAME backing store.
 *
 * 🔴 `<Harness>` CANNOT EXPRESS A RELOAD, AND A RELOAD IS THE WHOLE DEFECT.
 * `Harness` installs a fresh `createMockHost` on mount and tears it down on
 * unmount, and the KV store is built once from `storage.seed` at CREATION — so
 * re-rendering it hands the app a brand-new store and every write the first
 * mount made is gone. A defect whose symptom is "this state does not survive a
 * reload" is therefore structurally invisible through it: the second mount can
 * only ever see the seed. Installing the host once and rendering twice against
 * it is what makes the second mount read what the first mount actually wrote.
 */
function mountShared(options: Record<string, unknown>): {
  remount: () => void;
  cleanup: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const host = createMockHost(options as any);
  let uninstall: () => void = () => {};
  let view: ReturnType<typeof render> | null = null;

  // 🔴 The host must be UNINSTALLED and re-installed around a remount.
  // `install()` is idempotent and dispatches `BLOCK_INIT` exactly once, so a
  // second `render` against a still-installed host never completes the handshake
  // and sits on the loading skeleton forever — which reads as "the app failed to
  // restore" and would make this test lie in the direction of a false PASS if it
  // were asserting an absence. The KV store is built at `createMockHost` time,
  // outside `install()`, so it survives the cycle: that is what makes this a
  // reload rather than a fresh app.
  const mount = () => {
    resetTransport();
    getTransport({ allowedParentOrigins: [window.location.origin] });
    uninstall = host.install();
    view = render(
      <ToastProvider>
        <App />
      </ToastProvider>,
    );
  };

  mount();
  return {
    remount: () => {
      view?.unmount();
      uninstall();
      mount();
    },
    cleanup: () => {
      view?.unmount();
      uninstall();
    },
  };
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

  it('migrates the legacy single-slot run into a LISTED, REOPENABLE history row', async () => {
    // 🔴 THIS TEST USED TO ASSERT NOTHING ABOUT MIGRATION. Its body was the M1
    // restore test verbatim — two images on screen, no build panel — which is
    // true whether the legacy blob was MIGRATED or merely read in place. It
    // named the copy, the pointer and the delete and checked none of them.
    //
    // What only an App-level test can see is the seam: the legacy blob becoming
    // a row in the history KEYSPACE that the viewer can find and open again. So
    // this drives the whole round trip — migrate, clear the screen, find the row
    // in the list, reopen it, and get the paid images back.
    const shared = mountShared({
      viewer,
      consentGranted: true,
      storage: { seed: seedDoneRun(RUN_STORAGE_KEY) },
    });
    try {
      // Restored: the paid images are on screen and the build panel is gone.
      await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(2), {
        timeout: 4000,
      });
      expect(screen.queryByLabelText('Shared generation prompt')).toBeNull();

      // Clear the screen. This deletes the POINTER, never the run — so if the
      // migration copied the blob into the history keyspace, it is still there.
      await userEvent.click(screen.getByTestId('gm-newrun'));
      await userEvent.click(await screen.findByTestId('gm-reset-confirm'));
      await screen.findByLabelText('Shared generation prompt');

      // Exactly one row: the migrated run, and no duplicate of it.
      const rows = await screen.findByTestId('gm-history-list');
      await waitFor(() => expect(screen.getAllByTestId('gm-history-item')).toHaveLength(1));
      expect(rows).toBeInTheDocument();

      // And it genuinely reopens — a row that lists but cannot be opened would
      // be exactly the dead-row failure the migration's validation guard exists
      // to prevent.
      await userEvent.click(screen.getByTestId('gm-history-open'));
      await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(2), {
        timeout: 4000,
      });
    } finally {
      shared.cleanup();
    }
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
 * 🔴 REOPENING FROM HISTORY IS *VIEWING*, AND THE APP IS THE ONLY PLACE THAT
 * DECIDES SO. `archiveStateFromManifest` is verified as a pure function and
 * `ResultGrid` is verified against a `readOnly` prop, but WHICH restore App
 * calls, and whether it makes the archive your active run, is decided in App and
 * nowhere else. Both halves were individually correct while the screen wedged.
 */
describe('a matrix reopened from history is an archive, not a run you are in', () => {
  const archivedPrompt = 'a lighthouse in fog';
  const ARCHIVE_KEY = historyKeyFor(Date.UTC(2026, 0, 2, 3, 4, 5));

  /** A run interrupted mid-flight: one paid+done cell, one still in flight. */
  function seedInterruptedRun() {
    const cells = buildMatrix(archivedPrompt, [CHECKPOINTS[0]], [MODIFIERS[0], MODIFIERS[1]]).map(
      (cell, i): MatrixCell => ({
        ...cell,
        workflowId: `wf_${i}`,
        status: i === 0 ? 'done' : 'polling',
        imageUrl: i === 0 ? 'https://img.example/0.jpeg' : null,
        cost: i === 0 ? 8 : null,
        nsfwLevel: 1,
      }),
    );
    return {
      [ARCHIVE_KEY]: buildRunManifest({ phase: 'running', cells, perCellEstimate: 8 }, Date.now, {
        // A start stamp and NO finish — the shape every interrupted run persists
        // with, and the one that produced the 247-day clock.
        startedAt: Date.UTC(2026, 0, 2, 3, 0, 0),
      }),
    };
  }

  it('🔴 opens terminal: no Stop, no fabricated clock, and a way out', async () => {
    // 🔴 THE SCREEN THE VIEWER COULD NOT LEAVE. Restored with the mount-time
    // form, this manifest rebuilds as `phase: 'running'` — so "New matrix" was
    // withheld (it is gated on `phase === 'done'`), the elapsed header measured
    // from a start weeks old (measured: `5927h 42m`, ticking once a second), and
    // Stop was the only control left — which marks paid cells `canceled` /
    // "no charge".
    const shared = mountShared({
      viewer,
      consentGranted: true,
      storage: { seed: seedInterruptedRun() },
    });
    try {
      await userEvent.click(await screen.findByTestId('gm-history-open'));

      // A way out exists...
      await waitFor(() => expect(screen.getByTestId('gm-newrun')).toBeInTheDocument(), {
        timeout: 4000,
      });
      // ...Stop is gone, so the only control is no longer one that cancels paid
      // cells...
      expect(screen.queryByTestId('gm-stop')).toBeNull();
      // ...and no duration is claimed for a run whose end was never recorded.
      expect(screen.queryByTestId('gm-elapsed')).toBeNull();
      // The archive really is the one we seeded, not an empty shell.
      expect(screen.getByTestId('gm-run-prompt').textContent).toContain(archivedPrompt);
    } finally {
      shared.cleanup();
    }
  });

  it('🔴 does not become the ACTIVE run — a reload returns to the build screen', async () => {
    // 🔴 `readOnly` LIVED ONLY IN REACT STATE, AND THE POINTER OUTLIVED IT.
    // Opening an archive wrote the active-run pointer at it AND set the persist
    // key to it, so a reload followed the pointer back into the same matrix with
    // `viewingHistory` reset to false — `readOnly` undefined, "Retry failed"
    // rendered, no confirm gate in front of it. One click, real Buzz, on a
    // matrix the viewer had treated as finished.
    //
    // The remount below is a genuine reload against the SAME store, so it sees
    // what the first mount actually wrote. Either the explicit pointer write or
    // the persist effect's 250 ms write is enough to fail it.
    const shared = mountShared({
      viewer,
      consentGranted: true,
      storage: { seed: seedInterruptedRun() },
    });
    try {
      await userEvent.click(await screen.findByTestId('gm-history-open'));
      // Wait on the run PROMPT, not on "New matrix": the prompt line renders in
      // every phase, so this test stays keyed on the reload it is about rather
      // than also failing whenever the terminal-view fix regresses — that is the
      // sibling test's property, and one mutation reddening both would leave
      // neither testing its own.
      await waitFor(() => expect(screen.getByTestId('gm-run-prompt')).toBeInTheDocument(), {
        timeout: 4000,
      });
      // Well past the persist effect's 250 ms debounce, so a write it should not
      // be making has had every chance to land.
      await new Promise((resolve) => setTimeout(resolve, 700));

      shared.remount();

      // The build screen, with the archive still listed and still openable —
      // NOT the archive reopened as if it were the run you were in.
      expect(await screen.findByLabelText('Shared generation prompt')).toBeInTheDocument();
      expect(screen.queryByTestId('gm-newrun')).toBeNull();
      await waitFor(() => expect(screen.getAllByTestId('gm-history-item')).toHaveLength(1));
    } finally {
      shared.cleanup();
    }
  });

  it('🔴 stays terminal: reconcile cannot put it back on “Generating…”', async () => {
    // 🔴 THE SEAM BETWEEN TWO INDIVIDUALLY-CORRECT HALVES.
    // `archiveStateFromManifest` maps a `polling` cell to `timedout`;
    // `isReconcileFinal` is `isTerminalCell(status) && status !== 'timedout'`,
    // so reconcile treats EXACTLY the cells the archive form produced as
    // non-final and re-activates them. Measured at unit level: archive statuses
    // `done,timedout` reconcile to `done,polling` with `resumableIds`
    // `["128078::cinematic"]`. Neither `persistence.test.ts` nor a component
    // test can see it, because neither ever holds both states at once.
    //
    // The trigger is real and lives here too: `handleOpenHistory` does not reset
    // `reconciledSigRef`, and the `doneCount` effect fires a refetch 400 ms
    // after the archive loads — which is what changes the read-model identity
    // and re-runs the reconcile effect. What the viewer would see: a matrix the
    // app calls terminal and read-only back on "Generating…", with Stop and
    // Re-check both withheld by `readOnly` — no way to stop it, no way to
    // re-check it, and a poll loop discarding what it learns.
    //
    // `wf_1` is deliberately still `processing` in the read-model: that is the
    // arm that reports the cell resumable. `wf_0` is `succeeded` so the archive
    // has a done cell and the `doneCount` refetch actually fires.
    const shared = mountShared({
      viewer,
      consentGranted: true,
      storage: { seed: seedInterruptedRun() },
      appWorkflows: {
        workflows: [
          {
            workflowId: 'wf_0',
            status: 'succeeded',
            images: [{ url: 'https://img.example/0.jpeg', width: 1, height: 1, nsfwLevel: 1 }],
            cost: 8,
            createdAt: new Date().toISOString(),
          },
          {
            workflowId: 'wf_1',
            status: 'processing',
            images: [],
            cost: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    try {
      await userEvent.click(await screen.findByTestId('gm-history-open'));
      // The in-flight cell opens on the archive's terminal reading of it.
      await waitFor(() => expect(screen.getByText('may still finish')).toBeInTheDocument(), {
        timeout: 4000,
      });
      // Well past the 400 ms refetch that re-fires reconcile, so the write this
      // test forbids has had every chance to land.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(
        screen.queryByText('Generating…'),
        'a reopened archive re-entered a live poll',
      ).toBeNull();
      expect(screen.getByText('may still finish')).toBeInTheDocument();
    } finally {
      shared.cleanup();
    }
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
