// Component a11y tests (jsdom). The design-system migration relies on a handful
// of accessibility affordances — the axis-chip toggle state (`aria-pressed`), the
// in-flight `role="status"` announcement, and the resource-card "added" toggle —
// which are invisible to the pure-logic node suites. Assert them here so a future
// refactor can't drop them silently (mirrors the reference block's
// VoteButton/ResultsGrid affordance tests).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Chip, SkeletonCell } from './App.js';
import { CardTile } from './ResourceBrowser.js';
import { palette } from './theme.js';
import type { CatalogCard } from './catalog-api.js';

const c = palette();

describe('Chip (axis toggle)', () => {
  it('exposes aria-pressed reflecting the selected state, in BOTH states', () => {
    const { rerender } = render(<Chip label="JuggernautXL" selected={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'JuggernautXL' });
    // Unselected → aria-pressed="false" (announced as a toggle, off).
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    rerender(<Chip label="JuggernautXL" selected onToggle={() => {}} />);
    // Selected → aria-pressed="true".
    expect(screen.getByRole('button', { name: 'JuggernautXL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('has an accessible name from its label and fires onToggle on click', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Chip label="Anime" selected={false} isLora onToggle={onToggle} />);
    const btn = screen.getByRole('button', { name: 'Anime' });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('SkeletonCell (in-flight region)', () => {
  it('is a role="status" live region with the label as its accessible name', () => {
    render(<SkeletonCell c={c} label="Generating…" />);
    const status = screen.getByRole('status', { name: 'Generating…' });
    expect(status).toBeInTheDocument();
  });
});

describe('CardTile (resource add toggle)', () => {
  const card: CatalogCard = {
    modelId: 500,
    versionId: 1001,
    modelName: 'JuggernautXL',
    versionName: 'v9',
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    thumbnailUrl: null,
    nsfw: false,
  };

  it('is not pressed and clickable when not yet added', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<CardTile c={c} card={card} added={false} onAdd={onAdd} />);
    const tile = screen.getByRole('button', { name: /JuggernautXL/ });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile).not.toBeDisabled();
    await user.click(tile);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('reflects aria-pressed and is disabled once added (no double-add)', () => {
    render(<CardTile c={c} card={card} added onAdd={() => {}} />);
    const tile = screen.getByRole('button', { name: /JuggernautXL/ });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(tile).toBeDisabled();
  });
});
