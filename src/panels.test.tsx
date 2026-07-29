import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BuildPanel, ConfirmPanel, ResultGrid, CellView } from './App.js';
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
    render(<CellView c={c} cell={cells[0]} maturityGate={gate} onRecheck={vi.fn()} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText('no charge')).toBeInTheDocument();
  });
});
