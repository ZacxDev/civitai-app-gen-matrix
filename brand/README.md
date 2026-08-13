# Gen Matrix — brand kit

> **Every model. Every style. Side by side.**

Vector sources are the source of truth. The store assets are derived from these files by
the pipeline below; if you change a mark, regenerate rather than editing a raster.

| | |
|---|---|
| Plate | `#DB6EC9` (orchid, hue 310°) |
| Mark | cubic array |
| Icon | `icon.svg` — 1024x1024 |
| Cover | `cover.svg` — 1600x900 |

## The mark

A 3x3 grid with the top row and left column lit — the two axes, checkpoints against styles. Uniform on purpose: nothing wins here, unlike Model Benchmarking's podium.

Shades are **tonal** — every element is the plate hue at a different lightness
(`-0.13` for bodies, `+0.30` for the hot element). Nothing introduces a second hue, which
is what lets the colour-normalisation step below correct the plate without dragging an
accent off its own value.

## How the store assets are built

Three stages. Each does something the others cannot:

1. **Author** (`icon.svg` / `cover.svg`) — exact geometry, exact hex, exact direction.
2. **Light** — img2img adds studio lighting while preserving composition:
   `civitai generate "<lighting prompt>" --ecosystem NanoBanana --checkpoint 2725610 --image <authored.png> --aspect-ratio 1:1` (covers: `--aspect-ratio 16:9`).
3. **Normalise** — a global modulate computed from the plate's own measured offset lands it
   back on `#DB6EC9` exactly.

🔴 **Why not generate the mark directly?** It was tried, twice. Text-to-image steers hue
well but cannot be relied on for *meaning*: a "disc with a wedge cut out" renders as a cone,
an "open cylinder" as a cup, and a triangle told to point right pointed up. Authoring
removes that whole class — a drawn triangle cannot render the wrong way.

🔴 **Why not author the whole thing?** A flat vector cannot carry the lit dimensional
grammar the suite uses. Stage 2 is what supplies it.

## Gates

Every asset is checked before it is attached:

- plate **dE <= 3.0** against `#DB6EC9` after normalisation
- icon aspect 0.9-1.1, 128-4096 px, <= 1 MiB · cover aspect 1.3-2.4, min width 640, <= 4 MiB
- renders legibly at **128 px** on both store themes (light `#F7F9FC` and dark `#0B0E14`)
- the plate is **edge to edge** — the margin lives inside it. Never a surround: JPEG has no
  alpha, so a baked surround cannot be cropped away and it destroys dual-theme survivability.

## Palette

The suite's seven hues are spaced at least **42°** apart, all at a common lightness, so a
row of them in the store reads as one family while each stays individually identifiable.
The full wheel and the method live in the cross-app brand book.
