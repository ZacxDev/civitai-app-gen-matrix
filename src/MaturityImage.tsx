// G1 — the result-image maturity gate. A `contentRating:"g"` page must never
// paint ungated mature UGC pixels, so every result image renders through here.
//
// The gate DECISION is the pure `shouldBlurResult(nsfwLevel, gate)` from
// persistence.ts (unit-tested in node): blur a known level above the domain
// ceiling, and — fail-closed — blur an UNKNOWN level on a SFW domain. This
// component is the thin visual: a blurred cover + a "tap to view" reveal, using
// the design-system `Image` primitive underneath.
//
// Prop-driven (the `gate` comes from the App's single `useDomainMaturity()`
// call) so it renders + tests without any host wiring.

import { useEffect, useState } from 'react';

import { Image } from '@civitai/components-react';

import { shouldBlurResult, type MaturityGate } from './persistence.js';

export interface MaturityImageProps {
  src: string;
  alt: string;
  /** Per-image maturity level (`null`/absent = unknown → fail-closed on SFW). */
  nsfwLevel: number | null | undefined;
  /** The domain ceiling from `useDomainMaturity()`. */
  gate: MaturityGate;
  /** Fallback shown when the image bytes fail to load (paid cell — never blank). */
  fallback?: React.ReactNode;
}

export function MaturityImage({ src, alt, nsfwLevel, gate, fallback }: MaturityImageProps) {
  const mustBlur = shouldBlurResult(nsfwLevel, gate);
  const [revealed, setRevealed] = useState(false);
  // Re-arm the gate whenever the underlying decision could change (new src, or a
  // gate/level change that now requires blurring) so a reused cell can't leak a
  // previously-revealed mature image under a stricter decision.
  useEffect(() => {
    setRevealed(false);
  }, [src, mustBlur]);

  const blurred = mustBlur && !revealed;

  return (
    <div
      data-testid="gm-maturity-image"
      data-blurred={blurred ? 'true' : 'false'}
      style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1' }}
    >
      <Image
        src={src}
        alt={blurred ? `${alt} — mature content hidden` : alt}
        loading="lazy"
        fallback={fallback ?? 'Image unavailable'}
        wrapperStyle={{ width: '100%', aspectRatio: '1 / 1', borderRadius: 6 }}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: 6,
          display: 'block',
          // Blur + slight dim while gated. This is a visual cover only — the
          // real safety is the reveal gate; a sensitive deployment that needs a
          // hard guarantee would route through useGatedImages() (server clamp).
          filter: blurred ? 'blur(28px)' : 'none',
          transform: blurred ? 'scale(1.05)' : 'none', // hide blurred edges
          transition: 'filter 120ms ease',
        }}
      />
      {blurred && (
        <button
          type="button"
          data-testid="gm-maturity-reveal"
          onClick={() => setRevealed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeContent: 'center',
            gap: 4,
            border: 'none',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--civitai-color-body) 55%, transparent)',
            color: 'var(--civitai-color-text)',
            cursor: 'pointer',
            fontWeight: 700,
            fontSize: 12,
            textAlign: 'center',
            padding: 8,
          }}
        >
          <span>Mature content</span>
          <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.85 }}>Tap to view</span>
        </button>
      )}
    </div>
  );
}
