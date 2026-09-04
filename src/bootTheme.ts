/**
 * The theme to PAINT WITH before `ready`.
 *
 * 🔴 WHY THIS EXISTS. `useBlockContext().theme` is a SENTINEL before `ready`, not a
 * signal: the SDK's pre-init snapshot hardcodes `theme: 'light'`
 * (@civitai/blocks-react `dist/internal/transport.js`, EMPTY_SNAPSHOT) and the hook
 * returns it unchanged, so its value is indistinguishable from a host that really is
 * light. Painting with it makes every viewer light until BLOCK_INIT lands — and
 * because index.html's boot skeleton is dark, that is dark → light → dark, a NEW
 * flash introduced at exactly the moment `bootSkeleton: true` stands the host's veil
 * down. Never branch on `theme` in a `!ready` path; use this instead.
 *
 * 🔴 THE ATTRIBUTE READ IS FORWARD-COMPATIBLE, NOT LOAD-BEARING HERE. Nothing sets
 * `data-civitai-boot-theme` today, because index.html ships no inline reader — so
 * the OS query below is what actually answers, matching the stylesheet's
 * `@media (prefers-color-scheme: light)` exactly. The attribute branch is kept so
 * that adding the reader later needs no change here.
 *
 * 🔴 THE REASON FOR THAT GAP CHANGED, AND THE OLD REASON IS NO LONGER TRUE. This
 * comment used to read "this app's pinned SDK cannot decode the init fragment".
 * That was accurate at `@civitai/app-sdk@0.28.0` and is false as of the bump to
 * `0.37.0`, which ships `blocks/initFragment` — `parseBlockInitFragment(hash)`
 * returns `{ theme?, renderMode?, blockInstanceId? }` read SYNCHRONOUSLY at
 * document parse time, which is exactly the signal an inline reader needs and
 * strictly better than the OS guess (it is the HOST's theme, not the machine's).
 * Measured 2026-09-04: `dist/blocks/initFragment.d.ts` is present at 0.37.0 and
 * absent at 0.28.0. So the inline reader is now a CHOICE, not a blocker. It is
 * deliberately not taken in the same commit as a dependency bump — adding it is a
 * behaviour change to the boot path and belongs with the boot work, not here.
 * Closing condition: index.html gains the inline reader and the tripwire in
 * src/bootTokens.test.ts ("no `data-civitai-boot-theme` override blocks") is
 * updated in that same commit; whoever writes the reader is who checks it.
 *
 * Unknown means DARK, here and in index.html and in `<meta name="color-scheme">`.
 */
export type BootTheme = 'dark' | 'light';

export function bootThemeGuess(): BootTheme {
  try {
    const recorded = document.documentElement.getAttribute('data-civitai-boot-theme');
    if (recorded === 'dark' || recorded === 'light') return recorded;
    // The OS guess, asked the same way round as the stylesheet: LIGHT is the
    // positive case, so `no-preference` and any UA without the query land on dark.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch {
    // fall through
  }
  return 'dark';
}

/**
 * The value to stamp on the app root's `data-theme`.
 *
 * After `ready` the HOST's theme is authoritative and wins outright — this helper
 * exists only to keep the pre-`ready` commit off the sentinel.
 */
export function paintTheme(ready: boolean, hostTheme: string | undefined): string {
  return ready && hostTheme ? hostTheme : bootThemeGuess();
}
