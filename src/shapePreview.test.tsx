import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BuildPanel, MatrixShapePreview } from './App.js';
import { palette } from './theme.js';
import type { CheckpointOption, ModifierOption } from './models.js';

const c = palette();

// 🔴 Pairwise-distinct on BOTH axes and distinct from every count this file
// asserts. Three styles against two models gives 3 x 2 = 6 — a product that
// equals neither of its factors and is not a power-of-two multiple of either, so
// a mutant that swaps rows for columns, or renders one axis twice, cannot land on
// the same numbers. A 2x2 fixture would have hidden all of that.
const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'SD XL', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'Pony', baseModel: 'Pony' },
];
const mods: ModifierOption[] = [
  { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null },
  { key: 'cine', label: 'Cinematic', promptSuffix: 'cinematic', loraVersionId: null },
  { key: 'anime', label: 'Anime', promptSuffix: 'anime', loraVersionId: null },
];

describe('MatrixShapePreview draws the grid that is about to be generated', () => {
  it('renders one row per model and one column per style', () => {
    render(<MatrixShapePreview c={c} checkpoints={ckpts} modifiers={mods} />);
    const table = screen.getByRole('table');

    // Column headers: the corner cell is aria-hidden, so only the styles are
    // exposed as column headers.
    const colHeaders = within(table).getAllByRole('columnheader');
    expect(colHeaders.map((h) => h.textContent)).toEqual(['Baseline', 'Cinematic', 'Anime']);

    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders.map((h) => h.textContent)).toEqual(['SD XL', 'Pony']);

    // 2 models x 3 styles. Asserted as the PRODUCT, because a mutant that
    // renders one axis for both would still produce a plausible-looking table.
    expect(within(table).getAllByRole('cell')).toHaveLength(6);
  });

  it('describes the shape in words that match the table it drew', () => {
    render(<MatrixShapePreview c={c} checkpoints={ckpts} modifiers={mods} />);
    // Singular/plural is derived, so a 1-model case must not read "1 models".
    expect(screen.getByTestId('gm-shape-preview').textContent).toContain('2 models × 3 styles');
  });

  it('says "1 model" and "1 style", not "1 models"', () => {
    render(<MatrixShapePreview c={c} checkpoints={[ckpts[0]]} modifiers={[mods[0]]} />);
    const text = screen.getByTestId('gm-shape-preview').textContent ?? '';

    expect(text).toContain('1 model × 1 style');
    expect(text).not.toMatch(/1 models|1 styles/);
  });

  it('keeps the empty placeholder boxes out of the accessibility tree', () => {
    render(<MatrixShapePreview c={c} checkpoints={ckpts} modifiers={mods} />);
    const cells = within(screen.getByRole('table')).getAllByRole('cell');

    // Every cell holds one aria-hidden box and no text: the axis headers already
    // name each cell, so announcing six empty boxes would be noise.
    for (const cell of cells) {
      expect(cell.textContent).toBe('');
      expect(cell.querySelector('[aria-hidden]')).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------

function buildProps(over: Record<string, unknown> = {}) {
  return {
    c,
    prompt: 'a cat',
    setPrompt: () => {},
    checkpoints: ckpts,
    modifiers: mods,
    selectedCkpts: new Set([1, 2]),
    selectedMods: new Set(['baseline', 'cine', 'anime']),
    toggleCkpt: () => {},
    toggleMod: () => {},
    billable: 6,
    over: false,
    previewLabel: { amount: '120', isCeiling: true, ceilingAmount: '120' },
    anon: false,
    picking: false,
    chosenCheckpoints: ckpts,
    chosenModifiers: mods,
    loraModifiers: [],
    setLoraStrength: () => {},
    onPickLora: () => {},
    onPickCheckpoint: () => {},
    onBrowseLora: () => {},
    onBrowseCheckpoint: () => {},
    onGenerate: () => {},
    ...over,
  };
}

describe('BuildPanel shows the shape only when there is a shape to show', () => {
  it('renders the preview when cells are selected', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<BuildPanel {...(buildProps() as any)} />);
    expect(screen.getByTestId('gm-shape-preview')).toBeTruthy();
  });

  it('withholds the preview at zero cells, rather than drawing an empty table', () => {
    // 🔴 The guard is `billable > 0`, and `billable` is the SAME number the
    // counter renders — so this pins that the preview and the count cannot
    // disagree about whether there is anything to generate. An empty table is
    // not a preview; the header's concept example covers that state instead.
    render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <BuildPanel {...(buildProps({ billable: 0, chosenCheckpoints: [], chosenModifiers: [] }) as any)} />,
    );
    expect(screen.queryByTestId('gm-shape-preview')).toBeNull();
  });

  it('places the preview ABOVE the cell count, not after it', () => {
    // Order is the point of the change: you see the grid you are buying, then
    // its size and price, then the button. A preview below the button would be
    // a decoration rather than part of the decision.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(<BuildPanel {...(buildProps() as any)} />);
    const preview = screen.getByTestId('gm-shape-preview');
    const count = screen.getByText(/of 12/).closest('div');

    expect(count).not.toBeNull();
    // compareDocumentPosition: FOLLOWING (4) means `count` comes after `preview`.
    expect(preview.compareDocumentPosition(count as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container).toBeTruthy();
  });
});
