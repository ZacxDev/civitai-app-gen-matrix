# Screenshots — design-system migration + polish

> 🔴 **The PNGs described below were removed from the working tree; they remain in git
> history at `12ba32d` (#1) and can be restored with
> `git checkout 12ba32d -- docs/screenshots/`.**
>
> They were 8.1 MB of the repo, and `civitai app submit` packages the whole tree — which
> pushed the release bundle to 8.20 MB and made the app **unreleasable**. The server
> rejected it with `400: Invalid JSON` (an error naming neither size nor the bundle);
> a known-good control bundle is 2.32 MB, so the real server ceiling sits between those
> two. The CLI's own client-side cap is 50 MiB, ~12× too permissive to catch it.
>
> One-time review evidence does not belong in a tree that ships on every release.

`before/` = `main` (the hand-rolled, amber-accented proof-of-concept).
`after/`  = this branch (migrated onto `@civitai/blocks-react@0.35.2` `/ui` +
`@civitai/theme@0.2.0` tokens, polished).

Each set covers the same surfaces in **both themes** and at **narrow (~420px)** +
**wide (~1180px)** viewports:

| File | Surface |
|---|---|
| `build-wide-{light,dark}` | build form — header, prompt, axis chips, cost summary, Generate |
| `build-narrow-{light,dark}` | build form at ~420px (resizable-iframe narrow) |
| `confirm-wide-{light,dark}` | the spend-confirm gate |
| `grid-wide-{light,dark}` | the results matrix (checkpoints × styles) |
| `grid-narrow-{light,dark}` | the matrix at ~420px (sticky row header + swipe cue) |
| `browse-wide-{light,dark}` | the in-block resource browser |

Captured against the standalone dev harness (`VITE_DEV_HARNESS=true`, the
`@civitai/blocks-react/testing` mock host) with Playwright + chromium. The grid
tiles are the mock host's `placehold.co` placeholders (`MOCK ####`); the browser
cards are live public catalog data. No real host / OAuth / Buzz is involved.
