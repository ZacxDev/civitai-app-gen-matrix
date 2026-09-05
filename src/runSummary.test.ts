import { describe, expect, it } from 'vitest';

import {
  ALL_CELL_STATUSES,
  buildMatrix,
  composeCellPrompt,
  formatElapsed,
  PROMPT_MAX,
  runElapsedLabel,
  runElapsedMs,
  sharedPromptFromCell,
  sharedPromptFromCells,
} from './matrix.js';
import type { CheckpointOption, ModifierOption } from './models.js';

// 🔴 Pairwise-distinct, and distinct from every constant these assertions name.
const ckpts: CheckpointOption[] = [
  { versionId: 1, modelId: 11, label: 'SD XL', baseModel: 'SDXL 1.0' },
  { versionId: 2, modelId: 22, label: 'Pony', baseModel: 'Pony' },
];
const baseline: ModifierOption = { key: 'baseline', label: 'Baseline', promptSuffix: '', loraVersionId: null };
const cine: ModifierOption = { key: 'cine', label: 'Cinematic', promptSuffix: 'cinematic', loraVersionId: null };
const anime: ModifierOption = { key: 'anime', label: 'Anime', promptSuffix: 'anime', loraVersionId: null };

// ---------------------------------------------------------------------------
// Change 5 — elapsed time
// ---------------------------------------------------------------------------

describe('runElapsedMs', () => {
  it('measures a finished run between its own two stamps, ignoring now', () => {
    // The `now` argument is deliberately far from both stamps: a mutant that
    // measures to NOW instead of to `finishedAt` cannot hide behind a fixture
    // where the two happen to be close.
    expect(runElapsedMs(1_000, 46_000, 9_999_999)).toBe(45_000);
  });

  it('measures a still-running run to now', () => {
    expect(runElapsedMs(1_000, null, 31_000)).toBe(30_000);
  });

  it('returns null when the start is unknown', () => {
    // A manifest written before the app recorded timings. There is no honest
    // number here — the alternative to null is invention.
    expect(runElapsedMs(null, 46_000, 99_000)).toBeNull();
    expect(runElapsedMs(undefined, undefined, 99_000)).toBeNull();
  });

  it('returns null rather than a negative duration', () => {
    expect(runElapsedMs(50_000, 20_000, 99_000)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours distinctly', () => {
    // Seconds deliberately ≥10 here so this case does NOT depend on the
    // zero-padding the next test owns — otherwise a single mutation to the pad
    // would redden both, and neither would be an independent guard.
    expect(formatElapsed(8_000)).toBe('8s');
    expect(formatElapsed(130_000)).toBe('2m 10s');
    expect(formatElapsed(7_440_000)).toBe('2h 04m');
  });

  it('zero-pads the seconds inside a minutes label so the width does not jitter', () => {
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
  });

  it('passes null straight through', () => {
    expect(formatElapsed(null)).toBeNull();
  });
});

describe('runElapsedLabel — the form the header actually calls', () => {
  it('shows a live duration while the run is in progress', () => {
    // `startedThisSession` is what makes measuring to NOW honest — this session
    // watched the clock start, so both ends of the arithmetic are stamps we own.
    expect(
      runElapsedLabel({ startedAt: 1_000, finishedAt: null }, true, 13_000, {
        startedThisSession: true,
      }),
    ).toBe('12s');
  });

  it('🔴 shows NOTHING for a RESTORED run that still reports `running`', () => {
    // 🔴 THE 247-DAY CLOCK. Any run interrupted mid-flight persists with a
    // re-pollable cell, so it rebuilds as `phase: 'running'` — and the old guard
    // (`!running && finishedAt == null`) keys on exactly the phase this case
    // reports, so it could not see it at all. The header then measured from a
    // `startedAt` read out of storage to now: a measured `5927h 42m`, ticking up
    // once a second, on a matrix that finished weeks earlier.
    //
    // `startedThisSession` defaults to false, so the same call that used to
    // fabricate a duration now omits one.
    const aWeek = 7 * 86_400_000;
    expect(runElapsedLabel({ startedAt: 1_000, finishedAt: null }, true, 1_000 + aWeek)).toBeNull();
  });

  it('still shows a RECORDED duration on a restored run, whatever its phase says', () => {
    // The witness rule must not swallow the case where both stamps are on the
    // manifest — that arithmetic never touches `now` and is exact.
    expect(
      runElapsedLabel({ startedAt: 1_000, finishedAt: 13_000 }, true, 9_999_999_999),
    ).toBe('12s');
  });

  it('shows the final duration once the run is done', () => {
    // `now` is pinned AT `finishedAt` so this case cannot also detect a
    // measure-to-now mutation — that is `runElapsedMs`'s own guard above, and
    // one mutation reddening both would leave neither testing its own property.
    expect(runElapsedLabel({ startedAt: 1_000, finishedAt: 13_000 }, false, 13_000)).toBe('12s');
  });

  it('🔴 shows NOTHING for a finished run whose end was never recorded', () => {
    // THE RESTORED-RUN GUARD. `runElapsedMs` treats a missing `finishedAt` as
    // "still going" and measures to now — correct for a live run, catastrophic
    // for a reopened one. A matrix generated a week ago would otherwise headline
    // a seven-day runtime. Unknown must render as nothing.
    const aWeek = 7 * 86_400_000;
    expect(runElapsedLabel({ startedAt: 1_000, finishedAt: null }, false, 1_000 + aWeek)).toBeNull();
  });

  it('shows nothing when the run carries no stamps at all', () => {
    expect(runElapsedLabel({}, false, 5_000)).toBeNull();
    expect(runElapsedLabel({}, true, 5_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Change 3 — recovering the shared prompt
// ---------------------------------------------------------------------------

describe('sharedPromptFromCell — the inverse of composeCellPrompt', () => {
  it('round-trips a styled cell back to the prompt the viewer typed', () => {
    const shared = 'a serene lake';
    const cell = { prompt: composeCellPrompt(shared, cine), modifier: cine };
    // The composed prompt really is different, or this test proves nothing.
    expect(cell.prompt).not.toBe(shared);
    expect(sharedPromptFromCell(cell)).toBe(shared);
  });

  it('round-trips a baseline cell, whose effective prompt IS the shared one', () => {
    const cell = { prompt: composeCellPrompt('a serene lake', baseline), modifier: baseline };
    expect(sharedPromptFromCell(cell)).toBe('a serene lake');
  });

  it('recovers an empty shared prompt from a bare-suffix cell', () => {
    const cell = { prompt: composeCellPrompt('', cine), modifier: cine };
    expect(cell.prompt).toBe('cinematic');
    expect(sharedPromptFromCell(cell)).toBe('');
  });

  it('returns null when the clamp truncated the suffix away', () => {
    // 🔴 An honest refusal. The suffix is no longer intact at the end, so the
    // original cannot be recovered exactly — and a near-miss shown as "your
    // prompt" is worse than showing none.
    const long = 'x'.repeat(PROMPT_MAX);
    const cell = { prompt: composeCellPrompt(long, cine), modifier: cine };
    expect(cell.prompt.endsWith('cinematic')).toBe(false);
    expect(sharedPromptFromCell(cell)).toBeNull();
  });

  it('🔴 refuses at the clamp, instead of returning a SILENTLY SHORTENED prompt', () => {
    // 🔴 THE CASE THE `endsWith` CHECK CANNOT SEE. When the shared prompt itself
    // ends with the suffix AND the composition hit `PROMPT_MAX`, the stored
    // prompt still ends with `, <suffix>` — so the strip fires and returns the
    // viewer's own prompt MINUS its last five characters, presented as
    // "Prompt:" with nothing to say it was altered. Both readings even
    // round-trip through `composeCellPrompt` to the same string, so no recompose
    // check can separate them; the answer is genuinely unknown and must be null.
    const shared = 'x'.repeat(PROMPT_MAX - 5) + ', oil';
    const oil: ModifierOption = { key: 'oil', label: 'Oil', promptSuffix: 'oil', loraVersionId: null };
    const cell = { prompt: composeCellPrompt(shared, oil), modifier: oil };

    // The clamp really did bite: the appended suffix is gone, and what remains
    // ends with the shared prompt's OWN trailing ', oil'.
    expect(cell.prompt).toBe(shared);
    expect(cell.prompt.endsWith(', oil')).toBe(true);
    expect(sharedPromptFromCell(cell)).toBeNull();
  });

  it('does not strip a suffix the cell only coincidentally contains', () => {
    // The word appears in the middle, not as the composed trailing suffix.
    const cell = { prompt: 'cinematic lighting over a lake', modifier: cine };
    expect(sharedPromptFromCell(cell)).toBeNull();
  });
});

describe('sharedPromptFromCells', () => {
  it('recovers one shared prompt from a whole 2x3 run', () => {
    // 2 models x 3 styles = 6 cells: a product equal to neither factor, so a
    // mutant that reads one axis twice cannot land on the same shape.
    const cells = buildMatrix('a serene lake', ckpts, [baseline, cine, anime]);
    expect(cells).toHaveLength(6);
    expect(sharedPromptFromCells(cells)).toBe('a serene lake');
  });

  it('skips a cell that cannot answer and uses one that can', () => {
    const truncated = { prompt: 'cinematic lighting over a lake', modifier: cine };
    const good = { prompt: composeCellPrompt('a serene lake', anime), modifier: anime };
    expect(sharedPromptFromCells([truncated, good])).toBe('a serene lake');
  });

  it('returns null when no cell can answer', () => {
    expect(sharedPromptFromCells([{ prompt: 'cinematic lighting', modifier: cine }])).toBeNull();
    expect(sharedPromptFromCells([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The exhaustive status list (used by the cell-shell guard)
// ---------------------------------------------------------------------------

describe('ALL_CELL_STATUSES', () => {
  it('lists every status exactly once', () => {
    expect(new Set(ALL_CELL_STATUSES).size).toBe(ALL_CELL_STATUSES.length);
  });

  it('covers the statuses the app actually produces', () => {
    // Pinned as literals on purpose. Every other assertion about statuses
    // derives from this same list, so a mutation that dropped a member would
    // keep all of those consistent and green; these literals are the only thing
    // that notices the list itself shrinking.
    for (const s of ['idle', 'estimating', 'submitting', 'polling', 'done', 'failed', 'insufficient', 'blocked', 'canceled', 'timedout']) {
      expect(ALL_CELL_STATUSES).toContain(s);
    }
    expect(ALL_CELL_STATUSES).toHaveLength(10);
  });
});
