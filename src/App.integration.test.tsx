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
import { ACTIVE_RUN_POINTER_KEY, historyKeyFor } from './history.js';
import { GALLERY_DATA_VERSION } from './gallery.js';

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

  it('follows the ACTIVE-RUN POINTER on mount, with no legacy key to fall back on', async () => {
    // 🔴 THE POINTER BRANCH HAD NO TEST AT ALL. Every other restore test seeds
    // the legacy `gen-matrix:run:v1` key, so `migrateLegacyRun` returns the
    // manifest and the mount effect never reaches the pointer at all. Measured:
    // replacing the pointer read with a hardcoded `null` left all 472 tests
    // green — the branch that decides what a RELOAD restores was uncovered,
    // while the PR body claims the pointer is what makes that work.
    //
    // So: no legacy key here. The ONLY route to these images is history key →
    // pointer → restore. And it must restore as the run you are IN, not as a
    // read-only archive: Retry is present, which is the discriminator.
    const key = historyKeyFor(Date.UTC(2026, 0, 3, 4, 5, 6));
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { ...seedDoneRun(key), [ACTIVE_RUN_POINTER_KEY]: { key } } },
    });

    await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(2), {
      timeout: 4000,
    });
    expect(screen.getByTestId('gm-run-prompt').textContent).toContain(restoredPrompt);
    // The build panel is gone — this is a restored run, not the empty screen.
    expect(screen.queryByLabelText('Shared generation prompt')).toBeNull();
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
    // ⚠️ THIS IS AN INVARIANT GUARD, NOT A REGRESSION TEST. Measured after the
    // fact, against the true pre-fix tree (`src/App.tsx` at c111ca0b, rest of
    // the tree at HEAD): this file runs 13/13 GREEN. So the end-to-end path
    // does NOT reproduce as an integration failure, and round 2's original
    // "could not reproduce" was right — the claim that this test is
    // "deterministically red pre-fix" was wrong and is withdrawn.
    //
    // What it DOES pin is reachable and killable: deleting only
    // `if (viewingHistory) return;` from the reconcile effect at HEAD turns
    // this test red. The unit-level seam below is also real. What is missing
    // is a fixture where the read-model SIGNATURE changes after the archive
    // opens, which is what would drive the pre-fix code down the bad branch.
    // Until someone builds that, treat this as a guard on the invariant, and
    // do not count it as evidence that a user-visible defect existed.
    //
    // The seam it guards, at unit level:
    // `archiveStateFromManifest` maps a `polling` cell to `timedout`;
    // `isReconcileFinal` is `isTerminalCell(status) && status !== 'timedout'`,
    // so reconcile treats EXACTLY the cells the archive form produced as
    // non-final and re-activates them. Measured at unit level: archive statuses
    // `done,timedout` reconcile to `done,polling` with `resumableIds`
    // `["128078::cinematic"]`. Neither `persistence.test.ts` nor a component
    // test can see it, because neither ever holds both states at once.
    //
    // The trigger `handleOpenHistory` does not reset `reconciledSigRef`, and
    // the `doneCount` effect fires a refetch 400 ms after the archive loads.
    // In THIS fixture the refetch returns the same rows, so the signature does
    // not move and the reconcile effect does not re-run — which is exactly why
    // the pre-fix tree passes. What the viewer would see if it DID move: a
    // matrix the app calls terminal and read-only back on "Generating…", with Stop and
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

// ---------------------------------------------------------------------------
// The published-matrix GALLERY, end-to-end through the mock host.
//
// These cross the seams no unit test can: `App` is what decides which host
// surface is called with what, and it is the only place the three
// (publish → shared index → gated read) meet. A gallery module that parses
// correctly and a panel that renders correctly can still be wired to each other
// wrongly, and neither file's tests can see it.
// ---------------------------------------------------------------------------

/** A published entry as it sits in the shared store, in the `data` shape. */
function galleryData(images: { imageId: number; row: number; col: number }[]) {
  return {
    v: GALLERY_DATA_VERSION,
    rows: [{ row: 0, versionId: CHECKPOINTS[0].versionId }],
    cols: [
      { col: 0, key: MODIFIERS[0].key, loraVersionId: null },
      { col: 1, key: MODIFIERS[1].key, loraVersionId: null },
    ],
    images,
  };
}

/** A completed ONE-cell run seeded into the legacy slot, so it restores on mount. */
function oneCellRunManifest() {
  const cells = buildMatrix('a lighthouse', [CHECKPOINTS[0]], [MODIFIERS[0]]).map(
    (cell): MatrixCell => ({
      ...cell,
      status: 'done',
      workflowId: 'wf_pub_1',
      imageUrl: 'https://img.example/pub.jpeg',
      cost: 8,
      nsfwLevel: 1,
    }),
  );
  return buildRunManifest({ phase: 'done', cells, perCellEstimate: 8 });
}

describe('gallery — browsing published matrices', () => {
  it('lists a published matrix and renders its images under the viewer clamp', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [
          {
            value: {
              title: 'Lighthouse study',
              body: 'Prompt: a lighthouse at dusk',
              data: galleryData([
                { imageId: 9001, row: 0, col: 0 },
                { imageId: 9002, row: 0, col: 1 },
              ]),
            },
          },
        ],
      },
      // The mock's default projection: 9001 visible (with a url), 9002 hidden.
    });

    expect(await screen.findByTestId('gm-gallery-title')).toHaveTextContent('Lighthouse study');
    expect(screen.getByTestId('gm-gallery-body')).toHaveTextContent('a lighthouse at dusk');
    // The visible one paints through the app's own maturity gate; the hidden one
    // never gets a url from the host, so it can only be a placeholder.
    await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(1));
    expect(screen.getByTestId('gm-gallery-cell-hidden')).toBeInTheDocument();
  });

  it('🔴 an id the host omits becomes a `gone` cell, not a shifted grid', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [
          {
            value: {
              title: 'Two cells',
              data: galleryData([
                { imageId: 4101, row: 0, col: 0 },
                { imageId: 4102, row: 0, col: 1 },
              ]),
            },
          },
        ],
      },
      // The host resolved only the SECOND id. Zipping by index would paint 4102
      // into the first cell and leave the second blank — a wrong answer that
      // looks entirely correct on screen.
      gatedImages: [
        { imageId: 4102, status: 'visible', nsfwLevel: 1, contentRating: 'pg', url: 'https://img/4102', width: 8, height: 8 },
      ],
    });

    expect(await screen.findByTestId('gm-gallery-cell-gone')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(1));
    expect(screen.getByAltText(/Cinematic/)).toBeInTheDocument();
  });

  it('renders a matrix whose images have ALL gone as an honest statement', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [{ value: { title: 'Removed', data: galleryData([{ imageId: 7777, row: 0, col: 0 }]) } }],
      },
      gatedImages: [],
    });

    expect(await screen.findByTestId('gm-gallery-all-gone')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-grid')).toBeNull();
  });

  it('🔴 a failed gated-image read is NOT rendered as images that are gone', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [{ value: { title: 'Unreadable', data: galleryData([{ imageId: 9001, row: 0, col: 0 }]) } }],
      },
      gatedImagesError: 'gated images unavailable',
    });

    expect(await screen.findByTestId('gm-gallery-images-error')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-all-gone')).toBeNull();
    // The entry itself still lists — the index read succeeded, only the images failed.
    expect(screen.getByTestId('gm-gallery-title')).toHaveTextContent('Unreadable');
  });

  it('shows an empty gallery to a viewer when nothing has been published', async () => {
    renderApp({ viewer, consentGranted: true });
    expect(await screen.findByTestId('gm-gallery-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-error')).toBeNull();
  });

  it('lets an ANONYMOUS viewer browse, but offers them no vote, report or publish', async () => {
    renderApp({
      viewer: null,
      shared: {
        seed: [{ value: { title: 'Public grid', data: galleryData([{ imageId: 9001, row: 0, col: 0 }]) } }],
      },
    });

    expect(await screen.findByTestId('gm-gallery-title')).toHaveTextContent('Public grid');
    expect(screen.getByTestId('gm-gallery-vote')).toBeDisabled();
    // `report()` rejects for an anonymous viewer, so the control is withheld
    // rather than offered as an error.
    expect(screen.queryByTestId(/-report$/)).toBeNull();
    expect(screen.queryByTestId('gm-publish-panel')).toBeNull();
  });
});

describe('gallery — voting', () => {
  it('🔴 hydrates from viewerVoted, so one click on an already-voted entry UNVOTES', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [
          {
            value: { title: 'Already voted', data: galleryData([{ imageId: 9001, row: 0, col: 0 }]) },
            // The viewer (id 42) has an active up-vote on this row.
            voters: [42],
          },
        ],
      },
    });

    const button = await screen.findByTestId('gm-gallery-vote');
    // Guessing "not voted" here is what makes the first click a no-op re-vote and
    // forces the viewer to click twice to remove it.
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('1');

    await userEvent.click(button);

    await waitFor(() =>
      expect(screen.getByTestId('gm-gallery-vote')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByTestId('gm-gallery-vote')).toHaveTextContent('0');
  });

  it('surfaces a rejected vote on the entry instead of silently doing nothing', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      shared: {
        seed: [{ value: { title: 'Vote fails', data: galleryData([{ imageId: 9001, row: 0, col: 0 }]) } }],
        failNext: 1,
      },
    });

    await userEvent.click(await screen.findByTestId('gm-gallery-vote'));
    expect(await screen.findByTestId('gm-gallery-action-error')).toHaveTextContent(
      /SHARED_UNAVAILABLE/,
    );
    // The button did not flip to "voted" on a request that failed.
    expect(screen.getByTestId('gm-gallery-vote')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('gallery — publishing', () => {
  it('🔴 a publish refused by the app-developer gate says so, and creates NO entry', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: oneCellRunManifest() } },
      publishError: 'FORBIDDEN: publishing app outputs is limited to app developers',
    });

    await userEvent.click(await screen.findByTestId('gm-publish'));

    const status = await screen.findByTestId('gm-publish-status');
    await waitFor(() =>
      expect(status).toHaveTextContent(/limited to app developers/i),
    );
    // Not a silent no-op, and not a claim that anything was published.
    expect(status).toHaveTextContent(/Nothing was published/i);
  });

  it('publishes a finished matrix and lists it, with Remove offered to its author', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: oneCellRunManifest() } },
      publishImageIds: [9001],
    });

    const publishButton = await screen.findByTestId('gm-publish');
    expect(publishButton).toHaveTextContent('Publish 1 image');
    await userEvent.click(publishButton);

    await waitFor(() =>
      expect(screen.getByTestId('gm-publish-status')).toHaveTextContent(
        /Published 1 image to the gallery/i,
      ),
    );

    // Back to the build screen, where the gallery lives, to read it back.
    await userEvent.click(screen.getByTestId('gm-newrun'));
    await userEvent.click(await screen.findByTestId('gm-reset-confirm'));

    // The title defaulted to the run's own shared prompt — moderated text, in
    // `title`, never in `data`.
    expect(await screen.findByTestId('gm-gallery-title')).toHaveTextContent('a lighthouse');
    // The author sees Remove (recorded in their PRIVATE storage), not Report.
    expect(screen.getByTestId('gm-gallery-withdraw')).toBeInTheDocument();
    expect(screen.queryByTestId(/-report$/)).toBeNull();
  });

  it('offers no publish control on a matrix with nothing publishable', async () => {
    renderApp({ viewer, consentGranted: true });
    // The build screen has no finished matrix at all.
    await screen.findByLabelText('Shared generation prompt');
    expect(screen.queryByTestId('gm-publish-panel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit follow-ups, driven end-to-end.
// ---------------------------------------------------------------------------

describe('gallery — provenance (F1)', () => {
  it('🔴 a row appended by someone else cannot present as the app author’s', async () => {
    renderApp({
      viewer, // id 42
      consentGranted: true,
      shared: {
        seed: [
          {
            // A different account entirely. Appending is NOT cohort-gated — any
            // authenticated viewer past min-trust can add a row, including one
            // carrying image ids read straight out of a genuine entry, which
            // then renders REAL images.
            authorUserId: 777,
            value: {
              title: 'Looks official',
              data: galleryData([{ imageId: 9001, row: 0, col: 0 }]),
            },
          },
        ],
      },
    });

    expect(await screen.findByTestId('gm-gallery-provenance')).toHaveTextContent(
      'Published by another Civitai member',
    );
    // The panel makes no app-authorship claim anywhere — that is what stopped a
    // stranger's row inheriting the app's voice.
    expect(screen.getByTestId('gm-gallery').textContent).not.toMatch(/app author/i);
    // And it is not treated as the viewer's own.
    expect(screen.queryByTestId('gm-gallery-withdraw')).toBeNull();
  });
});

describe('gallery — publishing cannot be repeated (F2)', () => {
  it('🔴 one publish, one gallery row — the control does not re-arm on the same matrix', async () => {
    renderApp({
      viewer,
      consentGranted: true,
      storage: { seed: { [RUN_STORAGE_KEY]: oneCellRunManifest() } },
      publishImageIds: [9001],
    });

    const button = await screen.findByTestId('gm-publish');
    // CONTROL: armed before the click, so the disabled state below is the
    // publish's doing and not the panel's default.
    expect(button).toBeEnabled();

    await userEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId('gm-publish-status')).toHaveTextContent(/Published 1 image/i),
    );

    // PROBE: the same matrix can no longer be published. There is no un-publish,
    // so a second click would mean a second permanent set of public images.
    await waitFor(() =>
      expect(
        screen.getByTestId('gm-publish'),
        'two clicks used to produce two rows, each backed by its own publish() call and its own set of permanent public images — and there is no un-publish',
      ).toBeDisabled(),
    );
    expect(screen.getByTestId('gm-publish')).toHaveTextContent(/already published/i);
    expect(screen.getByTestId('gm-publish-already')).toBeInTheDocument();

    // A second click attempt changes nothing.
    await userEvent.click(screen.getByTestId('gm-publish'));

    await userEvent.click(screen.getByTestId('gm-newrun'));
    await userEvent.click(await screen.findByTestId('gm-reset-confirm'));

    await screen.findByTestId('gm-gallery-item');
    expect(
      screen.getAllByTestId('gm-gallery-item'),
      'two clicks used to produce two rows, each backed by its own publish() call and its own set of permanent public images',
    ).toHaveLength(1);
  });
});
