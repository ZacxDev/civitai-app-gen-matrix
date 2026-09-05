import type { CSSProperties } from 'react';

// Design-system theme (STEP 2). The block renders in a sandboxed iframe where
// the host can't inject CSS, so it drives colour through inline styles. This
// module replaces the old hand-rolled hardcoded-hex `palette(dark)` with values
// sourced from the Civitai design-system tokens (`@civitai/theme` → the
// `--civitai-*` CSS custom properties, injected once at boot).
//
// Because the tokens are plain CSS custom properties that flip on the ancestor
// `data-theme` attribute (App sets `data-theme={theme}` on the root from
// `useBlockContext().theme`), the palette is now THEME-INVARIANT here: every
// value is a `var(--civitai-*)` reference (or a `color-mix()` derived from one),
// and light/dark resolve at paint time from the injected token blocks. No more
// two hardcoded hex tables to keep in sync.

/**
 * Elevate a recessed surface off the page body. In LIGHT theme the token
 * `surface`/`surface-2` can collapse to `body`, so a small text-tinted mix
 * guarantees inputs/cards stay visible; in dark it reads as a subtle lift.
 */
function elevate(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-text) ${pct}%, var(--civitai-color-body))`;
}

/** Translucent wash of a base token (for tints / skeleton shimmer). */
function wash(token: string, pct: number): string {
  return `color-mix(in srgb, ${token} ${pct}%, transparent)`;
}

export interface Palette {
  bg: string;
  fg: string;
  cardBg: string;
  border: string;
  inputBg: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerBg: string;
  muted: string;
  /** Translucent accent tint — used for the faint LoRA-chip marker. */
  accentTint: string;
  /** Skeleton shimmer base + highlight (consumed by index.css). */
  skelBase: string;
  skelShine: string;
  /** The color the mobile edge-fade fades toward (matches the page bg). */
  fadeColor: string;
}

/**
 * The token-driven palette. `dark` is accepted for call-site compatibility but
 * is intentionally IGNORED — the `--civitai-*` tokens already switch on the
 * root's `data-theme`, so one token-referencing palette serves both themes.
 */
export function palette(_dark?: boolean): Palette {
  return {
    bg: 'var(--civitai-color-body)',
    fg: 'var(--civitai-color-text)',
    cardBg: elevate(3),
    border: 'var(--civitai-color-border)',
    inputBg: elevate(5),
    accent: 'var(--civitai-color-primary)',
    accentFg: 'var(--civitai-color-primary-fg)',
    danger: 'var(--civitai-color-error)',
    dangerBg: wash('var(--civitai-color-error)', 10),
    muted: 'var(--civitai-color-text-dimmed)',
    accentTint: 'var(--civitai-color-primary-light)',
    skelBase: wash('var(--civitai-color-text)', 6),
    skelShine: wash('var(--civitai-color-text)', 14),
    fadeColor: 'var(--civitai-color-body)',
  };
}

// ---------------------------------------------------------------------------
// Shared control styles.
//
// These three live here rather than beside their first caller because more than
// one surface renders them — App's build/result panels and the gallery. A second
// copy of a button style is the cheap kind of drift, but it is still drift: the
// two diverge, and the screen ends up with two things that are meant to be the
// same control looking subtly different.
// ---------------------------------------------------------------------------

export function primaryBtn(c: Palette, disabled = false): CSSProperties {
  return {
    padding: '12px 18px',
    border: 'none',
    borderRadius: 8,
    background: disabled ? c.border : c.accent,
    color: disabled ? c.muted : c.accentFg,
    fontWeight: 700,
    fontSize: 15,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

export function secondaryBtn(c: Palette): CSSProperties {
  return {
    padding: '12px 18px',
    border: `1px solid ${c.border}`,
    borderRadius: 8,
    background: 'transparent',
    color: c.fg,
    fontWeight: 600,
    fontSize: 15,
    cursor: 'pointer',
  };
}

export function noteStyle(c: Palette): CSSProperties {
  return { fontSize: 13, color: c.muted, margin: 0, lineHeight: 1.5 };
}
