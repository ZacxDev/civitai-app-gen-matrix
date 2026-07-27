// Design tokens for the app chrome the `@civitai/blocks-react/ui` pack doesn't
// cover (page background, muted text, the results-matrix grid scaffolding, sticky
// headers, cell states, the LoRA chip tint). Every value resolves to a
// `@civitai/theme` CSS custom property (`--civitai-*`) so there are ZERO
// hardcoded colors and light/dark is driven entirely by the `[data-theme]`
// attribute the host sets on the block root (see App.tsx). The pack
// (Button/Card/Badge/…) is self-themed off the same tokens, so the hand-rolled
// matrix reads as one system with it.
//
// Token source: `@civitai/theme@0.2.0` — imported once in main.tsx via
// `@civitai/theme/styles.css` (and also injected at runtime by the pack's
// injectBlocksStyles()).
//
// 🔴 Two token traps this module is built around:
//  1. `--civitai-color-gray-*` is theme-INVARIANT (not redefined under
//     [data-theme='dark']) — never used here for a theme-responsive surface.
//  2. In LIGHT theme `body == surface == surface-2` (all `#fefefe`) — a card
//     gets NO fill contrast in light, so panels are separated by BORDERS, and
//     any recess (inputs, skeleton, cell tiles) uses `elevate()` (a text↔surface
//     mix that reads in BOTH themes), never `surface-2`.

import type { CSSProperties } from 'react';

/** The theme-aware `--civitai-*` tokens this app consumes (all flip with `[data-theme]`). */
export const token = {
  text: 'var(--civitai-color-text)',
  dimmed: 'var(--civitai-color-text-dimmed)',
  body: 'var(--civitai-color-body)',
  surface: 'var(--civitai-color-surface)',
  surface2: 'var(--civitai-color-surface-2)',
  border: 'var(--civitai-color-border)',
  primary: 'var(--civitai-color-primary)',
  primaryHover: 'var(--civitai-color-primary-hover)',
  primaryFg: 'var(--civitai-color-primary-fg)',
  primaryLight: 'var(--civitai-color-primary-light)',
  error: 'var(--civitai-color-error)',
  success: 'var(--civitai-color-success)',
  warning: 'var(--civitai-color-warning)',
  info: 'var(--civitai-color-info)',
  radius: 'var(--civitai-radius)',
  font: 'var(--civitai-font)',
} as const;

/** `--civitai-radius` (0.25rem) and its common multiples, as strings. */
export const radius = {
  sm: token.radius,
  md: `calc(${token.radius} * 2)`,
  lg: `calc(${token.radius} * 3)`,
} as const;

/**
 * A subtle, theme-agnostic elevation tint derived from the tokens: mix a little
 * `text` into `surface`. Works in BOTH themes (in light this darkens white; in
 * dark it lightens the panel) without touching the invariant gray ramp — which
 * is why we don't just use `surface-2` (identical to `body` in light mode).
 */
export function elevate(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-text) ${pct}%, var(--civitai-color-surface))`;
}

/**
 * The app-chrome palette, entirely as `--civitai-*` var references (theme-
 * agnostic — light/dark is resolved by CSS at render, not a JS boolean). Threaded
 * as `c` into the matrix chrome (table, cell tiles, chips, skeletons) the pack
 * doesn't cover; the pack components self-theme off the same tokens.
 */
export interface Palette {
  /** page background */
  bg: string;
  /** primary text */
  fg: string;
  /** card / panel surface (== body in light → always pair with a border) */
  cardBg: string;
  /** hairline border */
  border: string;
  /** recessed input / tile / skeleton fill that reads in BOTH themes */
  inputBg: string;
  /** accent (design-system primary) */
  accent: string;
  /** text on an accent fill */
  accentFg: string;
  /** hover accent */
  accentHover: string;
  /** semantic error */
  danger: string;
  /** muted / secondary text */
  muted: string;
  /** translucent accent tint — the faint LoRA-chip marker */
  accentTint: string;
  /** skeleton shimmer base + highlight (theme-aware; consumed by index.css) */
  skelBase: string;
  skelShine: string;
  /** the color the mobile edge-fade fades toward (matches the page bg) */
  fadeColor: string;
}

export function palette(): Palette {
  return {
    bg: token.body,
    fg: token.text,
    cardBg: token.surface,
    border: token.border,
    inputBg: elevate(3), // recess that reads in both themes (NOT surface-2/gray)
    accent: token.primary,
    accentFg: token.primaryFg,
    accentHover: token.primaryHover,
    danger: token.error,
    muted: token.dimmed,
    accentTint: token.primaryLight,
    skelBase: elevate(4),
    skelShine: elevate(9),
    fadeColor: token.body,
  };
}

export function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: token.font,
    background: c.bg,
    color: c.fg,
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}

export const contentStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 900,
  padding: 'clamp(14px, 3vw, 24px)',
  display: 'grid',
  gap: 18,
  alignContent: 'start',
  boxSizing: 'border-box',
};

/** Muted secondary text — the dimmed token at full opacity (crisper than opacity-stacking). */
export const mutedText: CSSProperties = { color: token.dimmed, fontSize: 13, lineHeight: 1.5, margin: 0 };

/** Smaller meta / caption text. */
export const metaText: CSSProperties = { color: token.dimmed, fontSize: 12, lineHeight: 1.45, margin: 0 };
