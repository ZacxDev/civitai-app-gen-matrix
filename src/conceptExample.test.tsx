import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MatrixConceptExample } from './App.js';
import { palette } from './theme.js';

const c = palette();

/**
 * The concept band sits directly above BuildPanel's LIVE counter ("N of 12
 * cells") and the Generate button ("· N cells"), and its own numbers are
 * hardcoded. Measured live on 0.8.6 at the default selection, all three were on
 * screen at once reading 4, 2 and 2 — the example reuses the same "2" a small
 * selection has, so it reads as a fourth opinion about the current state rather
 * than as an illustration.
 *
 * 🔴 THESE ARE WORDING ASSERTIONS ON PURPOSE, AND THAT IS THE WEAK KIND. What
 * makes the defect real is a RELATIONSHIP — the band's number is fixed while the
 * counter's is derived — and no assertion here can see the counter. So the
 * narrow, honest claim these pin is: the fixed numbers are ACCOMPANIED BY A
 * VISIBLE MARKER SAYING THEY ARE AN EXAMPLE. A future change that makes the band
 * live should DELETE these tests, not satisfy them.
 */
describe('the matrix concept band marks its numbers as an example', () => {
  it('says "Example" in the VISIBLE text, not only to assistive tech', () => {
    const { container } = render(<MatrixConceptExample c={c} />);

    // textContent is what a sighted reader gets. An aria-label would NOT appear
    // here, which is exactly the failure this pins: the marker used to live only
    // in an aria-label on a role-less <div>.
    expect(container.textContent).toMatch(/example/i);
    expect(container.textContent).toContain('2 models × 2 styles = 4 cells');
  });

  it('does not carry an accessible name that disagrees with what is on screen', () => {
    const { container } = render(<MatrixConceptExample c={c} />);
    const root = container.firstElementChild as HTMLElement;

    // The band is decorative-but-labelled-by-its-own-text. A separate aria-label
    // is the specific thing that went wrong: it said "Example: …" while the
    // screen said something else, and on a role-less div it is not reliably
    // announced either — so the marker existed for nobody.
    expect(root.getAttribute('aria-label')).toBeNull();

    // Positive control for this assertion: the element the test IS looking at
    // must be the band, not an empty wrapper. If this ever reads empty, the
    // aria-label check above is passing vacuously.
    expect(root.textContent).toMatch(/models .* styles/);
  });

  it('keeps the dot glyph out of the accessibility tree', () => {
    const { container } = render(<MatrixConceptExample c={c} />);
    const hidden = container.querySelector('[aria-hidden]');

    expect(hidden).not.toBeNull();
    // The glyph is 4 dots; they carry no text, so anything readable in the band
    // comes from the label beside them.
    expect(hidden?.textContent).toBe('');
  });

  it('renders the same band regardless of how often it is mounted', () => {
    // Pins the rename: this was called `FirstRunExample`, but its call site is
    // `{inBuild && …}` and the build phase is re-entered via "New run", so it is
    // not first-run and never was. Nothing here is stateful; a second mount is
    // identical to the first. If someone makes it genuinely once-only, this test
    // is the one that should stop them silently: it will fail, and the comment
    // on the component explains why once-only is not reachable for an ordinary
    // viewer (the per-viewer KV that would remember a dismissal is gated to
    // mods + app-dev-testers).
    // 🔴 Deliberately says NOTHING about the "Example" marker. An earlier draft
    // called `screen.getByText(/Example/i)` here, and the marker mutation then
    // killed this test TOO — it died for the first test's reason, so "both went
    // red" would have overstated the coverage. A test that can only fail for
    // another test's cause is not a second guard.
    const first = render(<MatrixConceptExample c={c} />).container.textContent;
    const second = render(<MatrixConceptExample c={c} />).container.textContent;

    expect(second).toBe(first);
    expect(first).not.toBe('');
  });
});
