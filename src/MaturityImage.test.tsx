import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MaturityImage } from './MaturityImage.js';
import type { MaturityGate } from './persistence.js';

const sfwGate: MaturityGate = { isSfw: true, isLevelAllowed: (lvl) => lvl <= 1 };
const matureGate: MaturityGate = { isSfw: false, isLevelAllowed: (lvl) => lvl <= 8 };

describe('MaturityImage (G1 result gate)', () => {
  it('shows a known-safe image un-blurred on a SFW domain (no reveal button)', () => {
    render(<MaturityImage src="ok.jpg" alt="a landscape" nsfwLevel={1} gate={sfwGate} />);
    expect(screen.getByTestId('gm-maturity-image')).toHaveAttribute('data-blurred', 'false');
    expect(screen.queryByTestId('gm-maturity-reveal')).toBeNull();
  });

  it('BLURS a known-mature image above the SFW ceiling, with a tap-to-view gate', () => {
    render(<MaturityImage src="spicy.jpg" alt="x" nsfwLevel={16} gate={sfwGate} />);
    expect(screen.getByTestId('gm-maturity-image')).toHaveAttribute('data-blurred', 'true');
    expect(screen.getByTestId('gm-maturity-reveal')).toBeInTheDocument();
  });

  it('FAIL-CLOSED: blurs an UNKNOWN maturity image on a SFW domain (g-app safety)', () => {
    render(<MaturityImage src="unknown.jpg" alt="x" nsfwLevel={null} gate={sfwGate} />);
    expect(screen.getByTestId('gm-maturity-image')).toHaveAttribute('data-blurred', 'true');
  });

  it('reveals on tap', async () => {
    render(<MaturityImage src="spicy.jpg" alt="x" nsfwLevel={16} gate={sfwGate} />);
    await userEvent.click(screen.getByTestId('gm-maturity-reveal'));
    expect(screen.getByTestId('gm-maturity-image')).toHaveAttribute('data-blurred', 'false');
    expect(screen.queryByTestId('gm-maturity-reveal')).toBeNull();
  });

  it('does not blur an unknown image on a domain that permits mature content', () => {
    render(<MaturityImage src="ok.jpg" alt="x" nsfwLevel={null} gate={matureGate} />);
    expect(screen.getByTestId('gm-maturity-image')).toHaveAttribute('data-blurred', 'false');
  });
});

describe('MaturityImage — enlarge affordance + uncropped view (I1)', () => {
  it('shows an enlarge button on a NOT-blurred cropped thumbnail and fires onEnlarge', async () => {
    const onEnlarge = vi.fn();
    render(
      <MaturityImage src="ok.jpg" alt="a landscape" nsfwLevel={1} gate={sfwGate} onEnlarge={onEnlarge} />,
    );
    const btn = screen.getByTestId('gm-enlarge');
    await userEvent.click(btn);
    expect(onEnlarge).toHaveBeenCalledOnce();
  });

  it('does NOT expose enlarge while a mature image is still GATED (fail-closed)', () => {
    render(<MaturityImage src="spicy.jpg" alt="x" nsfwLevel={16} gate={sfwGate} onEnlarge={vi.fn()} />);
    // Blurred → the reveal gate is shown, but no enlarge yet.
    expect(screen.getByTestId('gm-maturity-reveal')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-enlarge')).toBeNull();
  });

  it('exposes enlarge only AFTER the mature image is revealed', async () => {
    render(<MaturityImage src="spicy.jpg" alt="x" nsfwLevel={16} gate={sfwGate} onEnlarge={vi.fn()} />);
    expect(screen.queryByTestId('gm-enlarge')).toBeNull();
    await userEvent.click(screen.getByTestId('gm-maturity-reveal'));
    expect(screen.getByTestId('gm-enlarge')).toBeInTheDocument();
  });

  it('the UNCROPPED (crop=false) view drops the 1:1 square crop and hides the in-image enlarge', () => {
    render(
      <MaturityImage src="ok.jpg" alt="x" nsfwLevel={1} gate={sfwGate} crop={false} onEnlarge={vi.fn()} />,
    );
    const wrapper = screen.getByTestId('gm-maturity-image');
    // No forced square aspect-ratio in the uncropped view.
    expect(wrapper.style.aspectRatio).toBe('');
    // The lightbox view never nests its own enlarge control.
    expect(screen.queryByTestId('gm-enlarge')).toBeNull();
  });
});
