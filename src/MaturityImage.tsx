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
  /**
   * Square-crop the image (thumbnail grid cell). Default `true` = the 1:1 cover
   * thumbnail. Pass `false` for the enlarge/lightbox view so the FULL paid output
   * is shown UNCROPPED (`object-fit: contain`, natural aspect). The maturity gate
   * still applies in both modes (fail-closed blur is preserved).
   */
  crop?: boolean;
  /**
   * When provided AND the image is not gated (revealed / known-safe), render a
   * small "enlarge" affordance that calls this. Enlarge is deliberately gated
   * behind the reveal so a mature image can't be enlarged before it's revealed.
   */
  onEnlarge?: () => void;
}

export function MaturityImage({
  src,
  alt,
  nsfwLevel,
  gate,
  fallback,
  crop = true,
  onEnlarge,
}: MaturityImageProps) {
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
      style={
        crop
          ? { position: 'relative', width: '100%', aspectRatio: '1 / 1' }
          : { position: 'relative', width: '100%', display: 'flex' }
      }
    >
      <Image
        src={src}
        alt={blurred ? `${alt} — mature content hidden` : alt}
        loading="lazy"
        fit={crop ? 'cover' : 'contain'}
        fallback={fallback ?? 'Image unavailable'}
        wrapperStyle={
          crop
            ? { width: '100%', aspectRatio: '1 / 1', borderRadius: 6 }
            : { width: '100%', maxHeight: '80dvh', borderRadius: 6 }
        }
        style={{
          width: '100%',
          height: crop ? '100%' : 'auto',
          maxHeight: crop ? undefined : '80dvh',
          objectFit: crop ? 'cover' : 'contain',
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
      {onEnlarge && !blurred && crop && (
        <button
          type="button"
          data-testid="gm-enlarge"
          onClick={onEnlarge}
          aria-label={`Enlarge ${alt}`}
          title="Enlarge"
          style={{
            position: 'absolute',
            bottom: 6,
            right: 6,
            display: 'grid',
            placeContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--civitai-color-body) 62%, transparent)',
            color: 'var(--civitai-color-text)',
            cursor: 'pointer',
          }}
        >
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden focusable="false">
            <path
              d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
