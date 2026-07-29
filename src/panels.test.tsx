import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BuildPanel, ConfirmPanel, ResultGrid, CellView, Lightbox, ResetConfirmDialog } from './App.js';
import { palette } from './theme.js';
import { buildMatrix, matrixTotalLabel, type MatrixCell } from './matrix.js';
import type { CheckpointOption, ModifierOption } from './models.js';
import type { MaturityGate } from './persistence.js';

const c = palette();
const gate: MaturityGate = { isSfw: true, isLevelAllowed: (lvl) => lvl <= 1 };

const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'SD XL', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'Pony', baseModel: 'Pony' },
];
const baseline: ModifierOption = { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null };
const cine: ModifierOption = { key: 'cine', label: 'Cinematic', promptSuffix: 'cinematic', loraVersionId: null };
const lora: ModifierOption = {
  key: 'lora-1',
  label: 'LoRA One',
  promptSuffix: '',
  loraVersionId: 407532,
  loraStrength: 1,
  baseModelFamily: 'SDXL 1.0',
};

// ---------------------------------------------------------------------------
// BuildPanel
// ---------------------------------------------------------------------------

function buildProps(over: Record<string, unknown> = {}) {
  return {
    c,
    prompt: 'a cat',
    setPrompt: vi.fn(),
    checkpoints: ckpts,
    modifiers: [baseline, cine, lora],
    selectedCkpts: new Set([1]),
    selectedMods: new Set(['baseline']),
    toggleCkpt: vi.fn(),
    toggleMod: vi.fn(),
    billable: 1,
    over: false,
    previewLabel: matrixTotalLabel([], 8),
    anon: false,
    picking: false,
    loraModifiers: [] as ModifierOption[],
    setLoraStrength: vi.fn(),
    onPickLora: vi.fn(),
    onPickCheckpoint: vi.fn(),
    onBrowseLora: vi.fn(),
    onBrowseCheckpoint: vi.fn(),
    onGenerate: vi.fn(),
    ...over,
  };
}

describe('BuildPanel', () => {
  it('renders the prompt box and Generate, and fires onGenerate on click', async () => {
    const props = buildProps();
    render(<BuildPanel {...props} />);
    expect(screen.getByLabelText('Shared generation prompt')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('gm-generate'));
    expect(props.onGenerate).toHaveBeenCalledOnce();
  });

  it('anon shows a Sign-in button instead of Generate', () => {
    render(<BuildPanel {...buildProps({ anon: true })} />);
    expect(screen.getByTestId('gm-signin')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-generate')).toBeNull();
  });

  it('surfaces the disabled reason for an empty prompt', () => {
    render(<BuildPanel {...buildProps({ prompt: '   ' })} />);
    expect(screen.getByTestId('gm-generate-reason')).toHaveTextContent(/enter a prompt/i);
    expect(screen.getByTestId('gm-generate')).toBeDisabled();
  });

  it('shows the over-cap reason + message', () => {
    render(<BuildPanel {...buildProps({ over: true, billable: 13 })} />);
    expect(screen.getByTestId('gm-generate-reason')).toHaveTextContent(/over the 12-cell limit/i);
  });

  it('renders a LoRA-strength Slider per selected LoRA and fires setLoraStrength on change (STEP 2)', async () => {
    const props = buildProps({ loraModifiers: [lora] });
    render(<BuildPanel {...props} />);
    const region = screen.getByTestId('gm-lora-strengths');
    const slider = within(region).getByRole('slider');
    // A range input's onChange fires deterministically via fireEvent.change.
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(props.setLoraStrength).toHaveBeenCalled();
    expect(props.setLoraStrength.mock.calls[0][0]).toBe('lora-1');
    expect(props.setLoraStrength.mock.calls[0][1]).toBeCloseTo(0.5);
  });

  it('labels the checkpoint axis "Models (checkpoints)" (I6)', () => {
    render(<BuildPanel {...buildProps()} />);
    expect(screen.getByText('Models (checkpoints)')).toBeInTheDocument();
    expect(screen.queryByText('Checkpoints (rows)')).toBeNull();
  });

  it('HEADLINES the "≈" estimate and demotes the ceiling to a "safety max" hint (I3)', () => {
    // matrixTotalLabel([], 8) → a real "≈" estimate (non-ceiling) with a ceilingAmount.
    render(<BuildPanel {...buildProps({ previewLabel: matrixTotalLabel([], 8) })} />);
    expect(screen.getByTestId('gm-safety-max')).toHaveTextContent(/safety max/i);
    // The ceiling is NOT the anchor — the ceiling-only "max — real cost …" line is absent.
    expect(screen.queryByText(/max — real cost is usually far less/i)).toBeNull();
  });

  it('a ceiling-only label anchors on "max — real cost is usually far less" (no ≈ hint)', () => {
    render(<BuildPanel {...buildProps({ previewLabel: matrixTotalLabel([], null) })} />);
    expect(screen.getByText(/real cost is usually far less/i)).toBeInTheDocument();
    expect(screen.queryByTestId('gm-safety-max')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ConfirmPanel
// ---------------------------------------------------------------------------

describe('ConfirmPanel', () => {
  const cells = buildMatrix('a cat', [ckpts[0]], [baseline, cine]); // 2 cells

  it('states nothing is spent until confirm, and fires confirm/cancel', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmPanel c={c} cells={cells} label={matrixTotalLabel(cells, 8)} phase="confirming" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByText(/nothing is spent until you confirm/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('gm-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('gm-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a ceiling label reads "at most" + the safety-cap disclaimer', () => {
    render(
      <ConfirmPanel c={c} cells={cells} label={matrixTotalLabel(cells, null)} phase="confirming" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/at most/i)).toBeInTheDocument();
    expect(screen.getByText(/safety cap, not what you'll spend/i)).toBeInTheDocument();
  });

  it('a real estimate label reads "≈" and omits the safety-cap disclaimer', () => {
    render(
      <ConfirmPanel c={c} cells={cells} label={matrixTotalLabel(cells, 8)} phase="confirming" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/≈/)).toBeInTheDocument();
    expect(screen.queryByText(/safety cap, not what you'll spend/i)).toBeNull();
  });

  it('needs-consent mode swaps the CTA to Grant & generate', () => {
    render(
      <ConfirmPanel c={c} cells={cells} label={matrixTotalLabel(cells, 8)} phase="needs-consent" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('gm-confirm')).toHaveTextContent(/grant & generate/i);
  });

  it('a real "≈" estimate demotes the ceiling to a "safety max … total" line (I3)', () => {
    render(
      <ConfirmPanel c={c} cells={cells} label={matrixTotalLabel(cells, 8)} phase="confirming" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/safety max .* buzz total/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ResultGrid + CellView
// ---------------------------------------------------------------------------

function patched(cells: MatrixCell[], id: string, patch: Partial<MatrixCell>): MatrixCell[] {
  return cells.map((cell) => (cell.id === id ? { ...cell, ...patch } : cell));
}

describe('ResultGrid + CellView', () => {
  const built = buildMatrix('a cat', [ckpts[0], ckpts[1]], [baseline, cine]); // 4 cells

  it('running shows Stop + a progress line + the spent total', () => {
    render(
      <ResultGrid
        c={c}
        cells={built}
        checkpoints={[ckpts[0], ckpts[1]]}
        modifiers={[baseline, cine]}
        phase="running"
        canRetry={false}
        maturityGate={gate}
        onReset={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onEnlarge={vi.fn()}
      />,
    );
    expect(screen.getByTestId('gm-stop')).toBeInTheDocument();
    expect(screen.getByText(/spent 0 Buzz/i)).toBeInTheDocument();
  });

  it('a done cell renders a maturity-gated image; a mature one is blurred (G1)', () => {
    const cells = patched(built, built[0].id, {
      status: 'done',
      imageUrl: 'x.jpg',
      cost: 8,
      nsfwLevel: 16, // mature — above the SFW ceiling
    });
    render(
      <ResultGrid
        c={c}
        cells={cells}
        checkpoints={[ckpts[0], ckpts[1]]}
        modifiers={[baseline, cine]}
        phase="done"
        canRetry={false}
        maturityGate={gate}
        onReset={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onEnlarge={vi.fn()}
      />,
    );
    const imgs = screen.getAllByTestId('gm-maturity-image');
    expect(imgs.some((el) => el.getAttribute('data-blurred') === 'true')).toBe(true);
  });

  it('a timedout cell exposes Re-check which fires onRecheck (M2 — never re-submits)', async () => {
    const onRecheck = vi.fn();
    const cells = patched(built, built[0].id, { status: 'timedout', workflowId: 'wf_0' });
    render(
      <ResultGrid
        c={c}
        cells={cells}
        checkpoints={[ckpts[0], ckpts[1]]}
        modifiers={[baseline, cine]}
        phase="done"
        canRetry={false}
        maturityGate={gate}
        onReset={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRecheck={onRecheck}
        onEnlarge={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('gm-recheck'));
    expect(onRecheck).toHaveBeenCalledOnce();
    expect(onRecheck.mock.calls[0][0].workflowId).toBe('wf_0');
  });

  it('blocked + canceled cells read "no charge"', () => {
    const cells = patched(
      patched(built, built[0].id, { status: 'blocked' }),
      built[1].id,
      { status: 'canceled' },
    );
    render(<CellView c={c} cell={cells[0]} maturityGate={gate} onRecheck={vi.fn()} onEnlarge={vi.fn()} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText('no charge')).toBeInTheDocument();
  });

  it('a blocked cell explains WHY in a tooltip naming both base models (I5)', () => {
    // A LoRA (SDXL family) blocked on the Pony checkpoint (ckpts[1]).
    const loraCells = buildMatrix('a cat', [ckpts[1]], [lora]);
    const cell = { ...loraCells[0], status: 'blocked' as const };
    render(<CellView c={c} cell={cell} maturityGate={gate} onRecheck={vi.fn()} onEnlarge={vi.fn()} />);
    const detail = screen.getByTestId('gm-incompatible-detail');
    expect(detail).toBeInTheDocument();
    // The reason is available (as the tooltip bubble text) and names both families.
    expect(screen.getByText(/SDXL 1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Pony/)).toBeInTheDocument();
  });

  it('a done cell exposes enlarge which fires onEnlarge with that cell (I1)', async () => {
    const onEnlarge = vi.fn();
    const cells = patched(built, built[0].id, {
      status: 'done',
      imageUrl: 'out.jpg',
      cost: 8,
      nsfwLevel: 1, // safe → not blurred → enlarge available
    });
    render(
      <ResultGrid
        c={c}
        cells={cells}
        checkpoints={[ckpts[0], ckpts[1]]}
        modifiers={[baseline, cine]}
        phase="done"
        canRetry={false}
        maturityGate={gate}
        onReset={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onEnlarge={onEnlarge}
      />,
    );
    await userEvent.click(screen.getAllByTestId('gm-enlarge')[0]);
    expect(onEnlarge).toHaveBeenCalledOnce();
    expect(onEnlarge.mock.calls[0][0].id).toBe(built[0].id);
  });
});

// ---------------------------------------------------------------------------
// Lightbox (I1) + ResetConfirmDialog (I2)
// ---------------------------------------------------------------------------

describe('Lightbox (I1 — uncropped view + copy-image-URL)', () => {
  it('renders the uncropped image + the raw URL and a copy control', () => {
    render(
      <Lightbox c={c} src="https://img.example/full.jpg" alt="a cat · Cinematic" nsfwLevel={1} gate={gate} onClose={vi.fn()} onCopied={vi.fn()} />,
    );
    expect(screen.getByTestId('gm-lightbox')).toBeInTheDocument();
    expect(screen.getByTestId('gm-lightbox-url')).toHaveTextContent('https://img.example/full.jpg');
    // The enlarged image is UNCROPPED (no forced 1:1 square).
    expect(screen.getByTestId('gm-maturity-image').style.aspectRatio).toBe('');
    expect(screen.getByTestId('gm-copy-url')).toBeInTheDocument();
  });

  it('copy-image-URL writes the src to the clipboard and calls onCopied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Define only navigator.clipboard (don't replace navigator — jsdom/userEvent
    // depend on it). configurable so it can be removed after.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const onCopied = vi.fn();
      render(
        <Lightbox c={c} src="https://img.example/full.jpg" alt="x" nsfwLevel={1} gate={gate} onClose={vi.fn()} onCopied={onCopied} />,
      );
      await userEvent.click(screen.getByTestId('gm-copy-url'));
      expect(writeText).toHaveBeenCalledWith('https://img.example/full.jpg');
      expect(onCopied).toHaveBeenCalled();
      // The button confirms the copy.
      expect(await screen.findByText(/copied!/i)).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('Close fires onClose', async () => {
    const onClose = vi.fn();
    render(
      <Lightbox c={c} src="x.jpg" alt="x" nsfwLevel={1} gate={gate} onClose={onClose} onCopied={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId('gm-lightbox-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ResetConfirmDialog (I2 — "New matrix" confirm gate)', () => {
  it('shows the warning copy and wires confirm/cancel', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ResetConfirmDialog c={c} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText(/start a new matrix\?/i)).toBeInTheDocument();
    expect(screen.getByText(/your current results will be cleared/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('gm-reset-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('gm-reset-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
