# Screenshots — design-system migration + polish

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
