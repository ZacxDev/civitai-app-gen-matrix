// Component a11y tests (jsdom). The design-system migration relies on a handful
// of accessibility affordances — the axis-chip toggle state (`aria-pressed`), the
// in-flight `role="status"` announcement, and the resource-card "added" toggle —
// which are invisible to the pure-logic node suites. Assert them here so a future
// refactor can't drop them silently (mirrors the reference block's
// VoteButton/ResultsGrid affordance tests).

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Chip, SkeletonCell } from './App.js';
import { CardTile } from './ResourceBrowser.js';
import { palette } from './theme.js';
import type { CatalogCard } from './catalog-api.js';

const c = palette();

describe('Chip (axis toggle)', () => {
  it('exposes aria-pressed reflecting the selected state, in BOTH states', () => {
    const { rerender } = render(
      <Chip c={c} label="JuggernautXL" selected={false} onToggle={() => {}} />,
    );
    const btn = screen.getByRole('button', { name: 'JuggernautXL' });
    // Unselected → aria-pressed="false" (announced as a toggle, off).
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    rerender(<Chip c={c} label="JuggernautXL" selected onToggle={() => {}} />);
    // Selected → aria-pressed="true".
    expect(screen.getByRole('button', { name: 'JuggernautXL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('has an accessible name from its label and fires onToggle on click', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Chip c={c} label="Anime" selected={false} onToggle={onToggle} />);
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
  // 🔴 EVERY FIELD PAIRWISE DISTINCT, and distinct from every literal this
  // suite asserts. A fixture that reuses one string across two fields cannot
  // see a projection that swaps them — `modelName: 'JuggernautXL', versionName:
  // 'JuggernautXL'` passes a `resource` mapper that reads the wrong key. These
  // values are also nothing `ResourceCard` can synthesise on its own: it has no
  // fallback that produces 'SDXL 1.0', so seeing it on screen proves the field
  // travelled rather than being reconstructed.
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
    render(<CardTile card={card} added={false} onAdd={onAdd} />);
    const tile = screen.getByRole('button', { name: /JuggernautXL/ });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile).not.toBeDisabled();
    await user.click(tile);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('reflects aria-pressed and is disabled once added (no double-add)', () => {
    render(<CardTile card={card} added onAdd={() => {}} />);
    const tile = screen.getByRole('button', { name: /JuggernautXL/ });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(tile).toBeDisabled();
  });

  // 🔴 THE SEAM GUARD, and the reason it is behavioural rather than structural.
  // `CardTile` is now three lines of prop-passing into a shared component, so
  // the only defect it can still HAVE is a mis-wired projection — and a
  // structural check ("we called ResourceCard with a resource") type-checks
  // past passing the wrong field. This renders the REAL component and reads the
  // screen, so a swapped key fails on the text.
  it('carries every catalog field through to the rendered card, not just the name', () => {
    render(<CardTile card={card} added={false} onAdd={() => {}} />);
    const tile = screen.getByTestId('gm-browse-card');
    // The name is the name — not the version, and not a composed "model —
    // version" string, which is what `pickedCheckpointLabel` would have made.
    expect(screen.getByTestId('gm-browse-card-name')).toHaveTextContent('JuggernautXL');
    // 🔴 The model TYPE, which this grid did not show AT ALL before the swap.
    // Both browse buttons opened a visually identical grid.
    expect(screen.getByTestId('gm-browse-card-type')).toHaveTextContent('Checkpoint');
    // The version name was previously only in a `title` attribute — invisible
    // to touch and to keyboard users.
    expect(tile).toHaveTextContent('v9');
    expect(tile).toHaveTextContent('SDXL 1.0');
  });

  it('shows a LoRA as "LoRA", so the two grids are told apart', () => {
    render(
      <CardTile
        card={{ ...card, modelType: 'LORA', modelName: 'Sinfully Stylish' }}
        added={false}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByTestId('gm-browse-card-type')).toHaveTextContent('LoRA');
  });

  // 🔴 A REGRESSION GUARD, not an invariant one: the OLD tile keyed its "no
  // preview" copy on the URL being ABSENT, so a URL that 404s rendered an empty
  // grey square with no text and nothing for assistive tech. gen-matrix is the
  // one consumer that supplies thumbnails, from a live catalog fetch, so it is
  // the likeliest to hit a dead CDN link. Red against the pre-swap CardTile.
  it('falls back to the placeholder for a thumbnail URL that fails to load', () => {
    render(
      <CardTile
        card={{ ...card, thumbnailUrl: 'https://example.invalid/dead.jpg' }}
        added={false}
        onAdd={() => {}}
      />,
    );
    const img = screen.getByTestId('gm-browse-card-image');
    expect(screen.queryByTestId('gm-browse-card-placeholder')).not.toBeInTheDocument();
    fireEvent.error(img);
    expect(screen.getByTestId('gm-browse-card-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-browse-card-image')).not.toBeInTheDocument();
  });

  // 🔴 The "Added" pill must not re-announce the selection: `aria-pressed`
  // already carries it, so an un-hidden pill makes the card say it twice.
  //
  // 🔴 ASSERTED ON THE OVERLAY NODE, NOT ON THE BUTTON'S ACCESSIBLE NAME — and
  // the first version of this test made exactly that mistake. `ResourceCard`
  // composes the button's `aria-label` from the RESOURCE fields alone, so it can
  // never contain "Added" whatever the overlay does: `expect(ariaLabel).not
  // .toMatch(/Added/)` was green with the pill hidden AND green with it exposed.
  // The pill is a SIBLING of the button, so what decides whether it is announced
  // is its own `aria-hidden`, which is what this reads.
  it('renders the "Added" pill visibly but hidden from assistive tech', () => {
    render(<CardTile card={card} added onAdd={() => {}} />);
    const overlay = screen.getByTestId('gm-browse-card-overlay');
    // Visible to a sighted viewer…
    expect(overlay).toHaveTextContent('Added');
    // …and hidden from the one that already heard it via aria-pressed.
    expect(overlay.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /JuggernautXL/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders no overlay at all before the resource is added', () => {
    render(<CardTile card={card} added={false} onAdd={() => {}} />);
    expect(screen.queryByTestId('gm-browse-card-overlay')).not.toBeInTheDocument();
  });
});
