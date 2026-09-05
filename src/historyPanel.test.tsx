import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HistoryPanel, ResultGrid, Lightbox } from './App.js';
import {
  HISTORY_LIST_CAP,
  HISTORY_RETENTION_CAP,
  historyKeyFor,
  type HistoryLoad,
} from './history.js';
import { buildMatrix, type MatrixCell } from './matrix.js';
import { palette } from './theme.js';
import type { CheckpointOption, ModifierOption } from './models.js';

const c = palette();
const gate = { isLevelAllowed: (l: number) => l <= 1, isSfw: true };
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function entries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: historyKeyFor(NOW - (i + 1) * 3_600_000),
    updatedAt: new Date(NOW - (i + 1) * 3_600_000),
  }));
}

// ---------------------------------------------------------------------------
// Change 2 — the history surface
// ---------------------------------------------------------------------------

describe('HistoryPanel', () => {
  it('renders nothing at all before the read resolves', () => {
    // Neither "you have matrices" nor "you have none" is known yet, and any
    // output here would flash one of them and then contradict itself.
    const { container } = render(<HistoryPanel c={c} load={null} now={NOW} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an honest empty state for a viewer with no matrices', () => {
    const load: HistoryLoad = { kind: 'ok', entries: [], truncated: false };
    render(<HistoryPanel c={c} load={load} now={NOW} onOpen={vi.fn()} />);
    expect(screen.getByTestId('gm-history-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-history-error')).toBeNull();
  });

  it('🔴 renders a FAILED read differently from an empty one', () => {
    // THE DISTINCTION THAT MATTERS. "You have no past matrices" is a claim about
    // the viewer's data; "we could not read them" is a claim about the read.
    // Collapsing the second into the first tells someone their paid work is gone
    // while it sits safe in storage behind a rejected call — which is the state
    // every viewer is in until this app's storage scopes are approved.
    render(<HistoryPanel c={c} load={{ kind: 'error' }} now={NOW} onOpen={vi.fn()} />);

    const err = screen.getByTestId('gm-history-error');
    expect(err).toBeInTheDocument();
    // It must not assert an absence of matrices...
    expect(err.textContent).not.toMatch(/no past matrices/i);
    // ...and it must say they are still saved, so nobody re-runs a paid matrix
    // believing the first one was lost.
    expect(err.textContent).toMatch(/still saved/i);
    // The empty state is genuinely absent, not merely styled differently.
    expect(screen.queryByTestId('gm-history-empty')).toBeNull();
  });

  it('lists saved matrices and reopens the one that was clicked', async () => {
    const onOpen = vi.fn();
    const rows = entries(3);
    render(
      <HistoryPanel c={c} load={{ kind: 'ok', entries: rows, truncated: false }} now={NOW} onOpen={onOpen} />,
    );

    expect(screen.getAllByTestId('gm-history-item')).toHaveLength(3);
    await userEvent.click(screen.getAllByTestId('gm-history-open')[1]);
    // The SECOND row's key, not the first — a mutant that always opens
    // `entries[0]` would pass a "was called" assertion.
    expect(onOpen).toHaveBeenCalledWith(rows[1].key);
  });

  it('does NOT claim truncation when the cap does not bind', () => {
    const rows = entries(HISTORY_LIST_CAP);
    render(
      <HistoryPanel c={c} load={{ kind: 'ok', entries: rows, truncated: false }} now={NOW} onOpen={vi.fn()} />,
    );
    expect(screen.getAllByTestId('gm-history-item')).toHaveLength(HISTORY_LIST_CAP);
    expect(screen.queryByTestId('gm-history-truncated')).toBeNull();
  });

  it('discloses the cap, naming the number, when it does bind', () => {
    const rows = entries(HISTORY_LIST_CAP);
    render(
      <HistoryPanel c={c} load={{ kind: 'ok', entries: rows, truncated: true }} now={NOW} onOpen={vi.fn()} />,
    );
    const note = screen.getByTestId('gm-history-truncated');
    expect(note.textContent).toContain(String(HISTORY_LIST_CAP));
    expect(note.textContent).toMatch(/most recent/i);
  });

  it('🔴 also discloses that older matrices are DELETED, not merely hidden', () => {
    // 🔴 TWO DIFFERENT TRUNCATIONS, AND ONLY ONE WAS DISCLOSED. "Showing your 12
    // most recent" describes the LIST. It does not describe storage, which now
    // keeps `HISTORY_RETENTION_CAP` runs and evicts the rest — because the quota
    // is per APP and unbounded rows silently disable persistence for every
    // viewer. Saying only the first leaves someone believing their 30th matrix
    // is still behind this list somewhere. It is not.
    const rows = entries(HISTORY_LIST_CAP);
    render(
      <HistoryPanel c={c} load={{ kind: 'ok', entries: rows, truncated: true }} now={NOW} onOpen={vi.fn()} />,
    );
    const note = screen.getByTestId('gm-history-truncated');
    expect(note.textContent).toContain(String(HISTORY_RETENTION_CAP));
    expect(note.textContent).toMatch(/we keep your last/i);
  });
});

// ---------------------------------------------------------------------------
// Changes 3 + 5 — the results header
// ---------------------------------------------------------------------------

const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'SD XL', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'Pony', baseModel: 'Pony' },
];
const baseline: ModifierOption = { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null };
const cine: ModifierOption = { key: 'cine', label: 'Cinematic', promptSuffix: 'cinematic', loraVersionId: null };
const anime: ModifierOption = { key: 'anime', label: 'Anime', promptSuffix: 'anime', loraVersionId: null };

// 2 models x 3 styles = 6 cells.
const built: MatrixCell[] = buildMatrix('a serene lake', ckpts, [baseline, cine, anime]);

function grid(over: Record<string, unknown> = {}) {
  const props = {
    c,
    cells: built,
    checkpoints: ckpts,
    modifiers: [baseline, cine, anime],
    phase: 'done',
    canRetry: false,
    maturityGate: gate,
    onReset: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onRecheck: vi.fn(),
    onEnlarge: vi.fn(),
    ...over,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<ResultGrid {...(props as any)} />);
}

describe('the results header names the prompt and the elapsed time', () => {
  it('shows the shared prompt the grid was generated from', () => {
    grid({ sharedPrompt: 'a serene lake' });
    expect(screen.getByTestId('gm-run-prompt').textContent).toContain('a serene lake');
  });

  it('shows NO prompt line when the prompt could not be recovered', () => {
    // Rather than an empty "Prompt:" label, which reads as a claim that the
    // viewer ran a blank prompt.
    grid({ sharedPrompt: null });
    expect(screen.queryByTestId('gm-run-prompt')).toBeNull();
  });

  it('shows the elapsed time beside the cost', () => {
    grid({ elapsed: '1m 05s' });
    expect(screen.getByTestId('gm-elapsed').textContent).toContain('1m 05s');
    // The cost is still there — elapsed is an addition, not a replacement.
    expect(screen.getByText(/spent 0 Buzz/i)).toBeInTheDocument();
  });

  it('omits elapsed entirely when it is unknown', () => {
    grid({ elapsed: null });
    expect(screen.queryByTestId('gm-elapsed')).toBeNull();
  });

  it('🔴 keeps the ticking elapsed OUT of the role=status live region', () => {
    // It re-renders every second during a run. Inside the live region that is a
    // screen reader announcing a clock once a second, drowning out the progress
    // it accompanies.
    grid({ elapsed: '12s', phase: 'running' });
    const live = screen.getByRole('status');
    expect(live.textContent).not.toContain('12s');
    expect(screen.getByTestId('gm-elapsed')).toBeInTheDocument();
  });

  it('withholds Retry on a matrix reopened from history, so it cannot re-spend', () => {
    const failed = built.map((cell, i) => (i === 0 ? { ...cell, status: 'failed' as const } : cell));
    grid({ cells: failed, canRetry: true, readOnly: true });
    expect(screen.queryByTestId('gm-retry')).toBeNull();
    // "New matrix" is still offered — reopening is a dead end otherwise.
    expect(screen.getByTestId('gm-newrun')).toBeInTheDocument();
  });

  it('still offers Retry on a live run', () => {
    const failed = built.map((cell, i) => (i === 0 ? { ...cell, status: 'failed' as const } : cell));
    grid({ cells: failed, canRetry: true, readOnly: false });
    expect(screen.getByTestId('gm-retry')).toBeInTheDocument();
  });

  it('🔴 withholds Re-check on a reopened matrix, so it cannot re-enter a live run', () => {
    // 🔴 THE LAST DOOR BACK INTO THE WEDGE. `RECHECK_TIMEDOUT` puts the WHOLE
    // run back into `phase: 'running'` — which is precisely the state a reopened
    // matrix is forced out of, and which brings back the screen whose only
    // control is Stop. Reopening is viewing an archive; nothing on it may start
    // a run again.
    const timedout = built.map((cell, i) =>
      i === 0 ? { ...cell, status: 'timedout' as const, workflowId: 'wf_0' } : cell,
    );
    grid({ cells: timedout, readOnly: true });
    expect(screen.queryByTestId('gm-recheck')).toBeNull();
  });

  it('still offers Re-check on a live run, where recovery is the point', () => {
    // The affordance is genuinely useful in-session: it re-polls the SAME
    // workflow, so it never re-submits and never re-charges. Withholding it
    // everywhere would trade one defect for a lost recovery path.
    const timedout = built.map((cell, i) =>
      i === 0 ? { ...cell, status: 'timedout' as const, workflowId: 'wf_0' } : cell,
    );
    grid({ cells: timedout, readOnly: false });
    expect(screen.getByTestId('gm-recheck')).toBeInTheDocument();
  });
});

describe('the lightbox names the EFFECTIVE prompt for that one cell', () => {
  // The POSITIVE case is owned by App.integration.test.tsx, which drives a real
  // enlarge click and can therefore also see WHICH prompt App handed over — the
  // per-cell one rather than the run's shared one. Asserting the same rendering
  // here as well would mean one mutation reddening both, so this file keeps only
  // the branch the integration test cannot reach: a cell with no prompt at all.

  it('renders no prompt block when the cell carries none', () => {
    render(
      <Lightbox
        c={c}
        src="https://img.example/full.jpg"
        alt="x"
        nsfwLevel={1}
        gate={gate}
        onClose={vi.fn()}
        onCopied={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('gm-lightbox-prompt')).toBeNull();
  });
});
