import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CellView, CELL_CAPTION_HEIGHT, CELL_TOOLTIP_CLASS } from './App.js';
import { ALL_CELL_STATUSES, buildMatrix, type CellStatus, type MatrixCell } from './matrix.js';
import { palette } from './theme.js';
import type { CheckpointOption, ModifierOption } from './models.js';

const c = palette();
const gate = { isLevelAllowed: (l: number) => l <= 1, isSfw: true };

const ckpt: CheckpointOption = { versionId: 1, modelId: 11, label: 'SD XL', baseModel: 'SDXL 1.0' };
const cine: ModifierOption = { key: 'cine', label: 'Cinematic', promptSuffix: 'cinematic', loraVersionId: null };

/** One cell in a given status, with the fields that status would carry. */
function cellIn(status: CellStatus): MatrixCell {
  const base = buildMatrix('a serene lake', [ckpt], [cine])[0];
  return {
    ...base,
    status,
    // A done cell needs an image and a cost; the others are unaffected by them.
    workflowId: 'wf_1',
    imageUrl: status === 'done' ? 'https://img.example/out.jpeg' : null,
    cost: status === 'done' ? 7 : null,
    nsfwLevel: 1,
    error: status === 'failed' ? 'boom' : null,
  };
}

function shellOf(status: CellStatus): { shell: HTMLElement; caption: HTMLElement } {
  const { unmount } = render(
    <CellView c={c} cell={cellIn(status)} maturityGate={gate} onRecheck={vi.fn()} onEnlarge={vi.fn()} />,
  );
  const shell = screen.getByTestId('gm-cell-shell');
  const caption = screen.getByTestId('gm-cell-caption');
  // Clone before unmounting so each status is measured in isolation — rendering
  // ten cells into one container and querying by testid would return the first.
  const pair = {
    shell: shell.cloneNode(true) as HTMLElement,
    caption: caption.cloneNode(true) as HTMLElement,
  };
  unmount();
  return pair;
}

/**
 * 🔴 THE BUG THIS PINS: THE GRID MOVED UNDER THE VIEWER, MID-RUN.
 *
 * In-flight cells rendered `SkeletonCell` — a bare `aspectRatio: 1/1` square.
 * A `done` cell rendered that square PLUS a `<figcaption>` carrying its Buzz
 * cost, whose height was reserved nowhere else. So every cell that completed
 * became taller than its neighbours and pushed its entire row down. In a nine
 * cell run that is nine separate jumps, all of them while the viewer is trying
 * to compare images.
 *
 * The assertion is about the SHELL, not any one status's content: no status may
 * be taller than another. jsdom performs no layout, so a computed-height read
 * would return 0 for everything and pass vacuously — what is checkable, and what
 * actually decides the height, is that every status renders through the same
 * shell with the same row template and the same reserved caption slot.
 */
describe('every cell status renders one shell of identical height', () => {
  // NOTE: every sweep below iterates `ALL_CELL_STATUSES`, which is compiler-
  // enforced against the `CellStatus` union (a `Record` keyed by it), so a newly
  // added status cannot silently escape these checks. That the list itself is
  // complete is owned by runSummary.test.ts — asserting it here as well would
  // mean one mutation reddening two files, and neither testing its own property.

  it('gives every status the same grid-template-rows on the shell', () => {
    const templates = new Map<CellStatus, string>();
    for (const status of ALL_CELL_STATUSES) {
      templates.set(status, shellOf(status).shell.style.gridTemplateRows);
    }

    const distinct = new Set(templates.values());
    expect(
      distinct.size,
      `every status must share one row template; got ${JSON.stringify([...templates])}`,
    ).toBe(1);
    // And it is the intended template, not merely a shared empty string — an
    // unstyled shell would also give a set of size one.
    expect([...distinct][0]).toBe(`1fr ${CELL_CAPTION_HEIGHT}px`);
  });

  it('reserves the caption row in every status, including the ones with no caption', () => {
    for (const status of ALL_CELL_STATUSES) {
      const { caption } = shellOf(status);
      expect(caption, `${status} must render a caption slot`).toBeTruthy();
      expect(caption.style.height, `${status} must reserve the caption height`).toBe(
        `${CELL_CAPTION_HEIGHT}px`,
      );
    }
  });

  it('leaves the reserved caption EMPTY until the cell is done', () => {
    // The reservation only prevents a shift if it is present while empty. A
    // caption rendered conditionally would put the jump straight back.
    for (const status of ALL_CELL_STATUSES) {
      if (status === 'done') continue;
      const { caption } = shellOf(status);
      expect(caption.textContent, `${status} must not caption anything`).toBe('');
    }
  });

  it('still shows the per-cell cost on a done cell', () => {
    // 🔴 The fix must not be "delete the caption". The per-cell Buzz cost is the
    // app's core money disclosure; trading a layout bug for a transparency one
    // would be the worse outcome, so this pins that it survived.
    const { caption } = shellOf('done');
    expect(caption.textContent).toBe('7 Buzz');
  });

  it('🔴 never lets a shrink-wrapping tooltip wrapper stand between the shell and the cell', () => {
    // 🔴 THE CLAIM "IDENTICAL BY CONSTRUCTION" WAS FALSE, AND THIS SUITE COULD
    // NOT SEE IT. The shell makes a cell's height a function of its WIDTH — the
    // media row is an `aspect-ratio: 1 / 1` square — which holds only while that
    // square receives the column's full width. `blocked` is wrapped in a
    // design-system `Tooltip`, whose wrapper is `inline-flex` and therefore
    // shrink-wraps to its content. Measured in Chromium at a 136px column:
    //
    //   idle/estimating/submitting/polling/done/failed/insufficient/
    //   canceled/timedout/missing = 156px   ·   blocked = 106px
    //
    // The wrapper was 86px wide, so the square was 86px. jsdom performs no
    // layout, so nothing here can assert 156 === 156 — and the existing
    // `gridTemplateRows` guard is TRUE in both states, because the shell was
    // uniform and only the content inside one branch was not. What IS checkable
    // is the relationship: any element sitting between the shell's media row and
    // the cell body must be width-normalized by `CELL_TOOLTIP_CLASS`.
    //
    // ⚠️ `aspect-ratio` on the inner span does NOT fix this — tried, and the
    // height stayed 106. The WIDTH is what is wrong.
    for (const status of ALL_CELL_STATUSES) {
      const { shell } = shellOf(status);
      const media = shell.firstElementChild as HTMLElement;
      // Walk down to the cell body — the first element that declares the square.
      let node: HTMLElement | null = media.firstElementChild as HTMLElement | null;
      const between: HTMLElement[] = [];
      while (node && node.style.aspectRatio !== '1 / 1') {
        between.push(node);
        node = node.firstElementChild as HTMLElement | null;
      }
      expect(node, `${status} must render a square cell body`).toBeTruthy();
      for (const el of between) {
        const normalized =
          el.classList.contains(CELL_TOOLTIP_CLASS) || el.style.display === 'block';
        expect(
          normalized,
          `${status}: <${el.tagName.toLowerCase()}> sits between the shell and the cell ` +
            `body without being width-normalized — it will shrink-wrap and shorten the cell`,
        ).toBe(true);
      }
    }
  });

  it('🔴 and the rule the class relies on actually forces a block box', () => {
    // The other half of the pair above. A wrapper can carry the class while the
    // rule that gives the class its meaning has been deleted, or weakened back
    // to an inline box — the DOM shape would still pass and the cell would be
    // 106px again. This reads the shipped stylesheet.
    //
    // 🔴 A TEXT ASSERTION, AND ONLY BECAUSE THE HARNESS ALLOWS NOTHING BETTER.
    // The honest version — inject the stylesheet, render the cell, read
    // `getComputedStyle(wrapper).display` — was tried and does not work: jsdom
    // fails to parse this file at all ("Could not parse CSS stylesheet") and
    // then returns `''` for every property, i.e. a vacuous pass in both
    // directions. So the CASCADE is unverifiable here; what remains checkable is
    // that the declaration exists and says `block`. The height equality it
    // produces is verified only in a real engine, by hand — see
    // `CELL_TOOLTIP_CLASS`.
    //
    // Read off disk rather than imported: vitest stubs CSS imports, so
    // `import css from './index.css?raw'` resolves to an EMPTY STRING and every
    // assertion over it passes vacuously (measured — `len: 0`).
    const appCss = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    expect(appCss.length, 'the stylesheet must actually have been read').toBeGreaterThan(500);
    const rule = new RegExp(`\\.${CELL_TOOLTIP_CLASS}\\s*\\{([^}]*)\\}`).exec(appCss);
    expect(rule, `index.css must carry a .${CELL_TOOLTIP_CLASS} rule`).toBeTruthy();
    expect(rule![1].replace(/\s+/g, ' ').trim()).toBe('display: block;');
  });

  it('renders a shell even for a missing cell, so a gap cannot shorten its row', () => {
    // Asserts PRESENCE only. The exact row template is the previous test's
    // property; repeating it here would mean one mutation to the template
    // reddening both, and this test would no longer be an independent guard of
    // the thing it names — that a cell the grid has no entry for still occupies
    // a full-height shell instead of collapsing its row.
    render(<CellView c={c} cell={undefined} maturityGate={gate} onRecheck={vi.fn()} onEnlarge={vi.fn()} />);
    expect(screen.getByTestId('gm-cell-shell')).toBeInTheDocument();
    expect(screen.getByTestId('gm-cell-caption')).toBeInTheDocument();
  });
});
