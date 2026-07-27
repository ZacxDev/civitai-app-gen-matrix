# Gen Matrix

A Civitai **App Block** — a full-page (W10) app, rendered at `/apps/run/gen-matrix`,
that generates a **bounded grid of generations** so you can compare how each
model / style changes the output. Pick N checkpoints × M styles, hit **Generate
Matrix**, and every cell renders side-by-side (rows = checkpoints, columns =
styles). Each cell spends **real Buzz** via the page money path.

It is the flagship first-party dog-food for the "money on pages" feature
(civitai #2612) and extends the single-gen
[`civitai-block-buzz-generator`](../civitai-block-buzz-generator) into a bounded
matrix + concurrency-limited queue.

## What it does (v1)

1. **Build** — choose checkpoints (rows), styles (columns), and a shared prompt.
   The status line shows the live **cell count** and **estimated total Buzz**.
2. **Confirm** — an explicit spend gate: *"Generate N cells for an estimated X
   Buzz? Nothing is spent until you confirm."*
3. **Consent (lazy)** — `ai:write:budgeted` is consent-gated, so the first run
   asks the host to open the Civitai consent dialog; the grant auto-resumes the
   run (no second click).
4. **Run** — a **concurrency-limited queue** (3 in-flight) drives each cell
   through estimate → submit → poll. Cells render `idle → estimating →
   submitting → polling → done / failed / out-of-buzz` independently.
5. **Results** — a grid of images + per-cell cost, the **total spent**, and a
   per-run **Top up Buzz** CTA when any cell ran out of Buzz.

### Polish & accessibility

- **Mobile grid** — at narrow widths the row-header (checkpoint) column freezes
  while the style columns scroll, with a swipe cue + edge fade so an off-screen
  column is never cut off without an affordance. Desktop keeps the plain table.
  Header `scope=col`/`scope=row` associations are preserved in both layouts.
- **Real spend modal** — the confirm gate is a focus-trapped dialog (backdrop,
  focus-on-open, Escape / backdrop-click to cancel, focus restored to the
  trigger on close).
- **Animation** — image fade-in on decode, shimmer skeletons for in-flight
  cells, staggered cell entry, chip press, and a dialog entry transition. All
  are transform/opacity-only and **disabled under `prefers-reduced-motion`**.
- **LoRA vs prompt-style** — LoRA columns carry a small resource glyph + faint
  accent tint so the two kinds of column read as different at a glance.
- **Disabled-Generate reason** — inline microcopy states why Generate is
  disabled (empty prompt / no selection / over the cell cap).

### Money safety (bounding)

- **Hard cell cap** (`MAX_CELLS = 12`). A page cannot read the viewer's balance
  (`buzz:read:self` is page-forbidden), so the only defense against a careless
  matrix marching toward the platform per-user daily cap (50,000 Buzz) is to
  bound the cell count up front. Generate is disabled above the cap. Worst case
  = 12 cells × the 1000 server per-cell ceiling = 12,000 << 50,000.
- **Per-cell budget** = manifest `page.buzzBudgetPerGen` (**200** — sized for the
  LoRA axis, since a checkpoint+LoRA gen costs more than a checkpoint alone; a
  low budget risked an immediate `insufficient` on every LoRA cell. Worst-case
  12 × 200 = 2,400 Buzz, far under the 50k daily cap), server-read and clamped to
  ≤1000.
- **Confirm-before-spend** with the estimated total, and **per-cell** insufficient
  -Buzz handling (a failed cell shows a Top-Up CTA and never hangs the queue).

## The model set (and the known gap)

A W10 page slot is **entity=none** — it carries no model context and the SDK
exposes **no page model-picker**. So v1 ships a small **curated set**, each
verified **Public + generation-covered + SFW** against the prod civitai DB
(2026-06-18):

| Axis | Members |
|---|---|
| **Checkpoints (rows)** | SD XL 1.0 (`101055/128078`), Pony Diffusion V6 XL (`257749/290640`) — foundational, multi-million-generation public bases that effectively never get deleted or lose coverage. |
| **Styles (columns)** | Baseline (no modifier), Cinematic, Anime, Watercolor — prompt-style suffixes the workflow schema fully supports, so every cell is a **real, visibly-different** generation. Plus one **real LoRA column** (Sinfully Stylish, SDXL — see below). |

> A real in-app **model browser** needs a page model-search SDK + host
> capability (a "page resource picker" bridge). That is a documented **platform
> follow-up**.

### The LoRA axis — gap now CLOSED (civitai #2640/#2641 + app-sdk 0.10.0)

The literal spec was *checkpoint × LoRA*. That used to be **unrealizable on a
page** for two reasons, **both now fixed upstream**:

1. ~~No LoRA field in the workflow contract.~~ **#2641** added an optional
   `additionalResources: Array<{ modelVersionId, strength? }>` (max 5,
   `strength` ∈ [-1, 2], default 1) to `blockWorkflowBodySchema`, surfaced on
   the SDK's `WorkflowBody` type in **app-sdk 0.10.0**.
2. ~~A page can't pair a checkpoint with a LoRA.~~ **#2640** added page
   resource-pairing: the page submits its **own** checkpoint as `modelVersionId`
   **and** the LoRA(s) inline via `additionalResources` — no install /
   viewer-settings rows needed.

So the second axis is a **pluggable "modifier"** abstraction: prompt-style
modifiers fold into `params.prompt`; a **LoRA modifier** (`loraVersionId` +
`loraStrength` + `baseModelFamily`) now emits a real `additionalResources` entry
on the cell's checkpoint. `buildCellBody` emits it; a baseline / prompt-only
modifier emits none (backward-compatible, checkpoint-only).

**Compatibility is a SERVER authority — the block does NOT decide it.** The
page-LoRA gate went GA (#2660): the server accepts platform-valid
**cross-ecosystem** LoRAs (e.g. a Pony LoRA on an SDXL checkpoint = `'partial'`
support) via its ecosystem rules. The block cannot import those tables (sandboxed
iframe) and must not replicate them (they'd rot), so it **defers**: every LoRA ×
checkpoint cell is **submitted**, and the server rejects a genuinely-incompatible
pair **pre-spend** with a `BAD_REQUEST`. The block maps that reject per-cell to a
muted **`blocked`** cell ("incompatible · no charge", costing 0). The earlier
exact-string family check was **removed** — it false-blocked the now-valid
cross-ecosystem combos. A compatible LoRA cell is a first-class member of the
matrix / queue / cap / cost logic.

The set ships one sample LoRA ("Sinfully Stylish", version `407532`, a
public+covered+SFW **SDXL** LoRA, strength `1`): it generates wherever the server
accepts the pairing and renders muted `blocked` (no charge) wherever the server
rejects it — exercising both paths end-to-end.

### Picking LoRAs + checkpoints (v0.2.0 — the user-driven path)

The hard-coded sample LoRA is now just a **default seed**. The real path is the
host's **native resource picker** (`useResourcePicker`, `@civitai/blocks-react`
0.7.0): **+ Pick LoRA** opens Civitai's own modal as chrome and the block gets
back the one picked resource (`{ versionId, modelId, baseModel, modelType }`),
which becomes a new LoRA **column** (auto-selected, deduped, family-checked like
any curated LoRA). **+ Pick checkpoint** does the same for a **row**. The picker
returns no resource *name*, so picked members are labeled `LoRA #<id> (<base>)` /
`Model #<id> (<base>)` — see **`PICKER-WIRING.md`** for the full wiring, the
label-gap assessment, and the deploy/publish gates.

> **SDKs (published — no local link):** `@civitai/app-sdk ^0.11.0` and
> `@civitai/blocks-react ^0.7.0` are on npm and resolve from the registry. The
> only `pnpm-workspace.yaml` entry is the `minimumReleaseAgeExclude` freshness
> pin. See `PICKER-WIRING.md`; the older `LORA-AXIS-CHANGES.md` describes the
> earlier `additionalResources` wiring.
>
> **Prod gate:** the picker works in the harness today, but a real page host
> only answers `OPEN_RESOURCE_PICKER` once civitai **PR #2651** (the host
> handler) is deployed to prod via `release`.

## Architecture

| File | Role |
|---|---|
| `src/matrix.ts` | **All load-bearing logic, pure + unit-tested** — combo/matrix builder (incl. baseline + dedup), cap enforcement, total-cost estimation, the queue/grid **reducer** (cell status transitions), pure **concurrency scheduling** (`nextCellsToStart`), insufficient-Buzz detection, snapshot→status mapping. |
| `src/models.ts` | The curated checkpoint + modifier set (+ the LoRA-gap notes). |
| `src/App.tsx` | Thin React driver: selection UI, confirm gate, lazy consent, and the async queue driver that dispatches into the reducer. |
| `src/Harness.tsx` | Local mock host (`pnpm dev:harness`) — answers the consent + token round-trip and simulates the orchestrator money path for many concurrent cells. |

The React layer is deliberately thin; every money-safety decision lives in the
tested pure module.

## Develop

```bash
npm install                 # or: pnpm install
npm run dev:harness         # http://localhost:5187 — mock host + simulated money path
```

Harness URL toggles: `?consent=granted`, `?viewer=anon`, `?fail=insufficient`,
`?fail=some` (mixed grid), `?theme=light`, `?pick=sdxl|pony|cancel` (canned LoRA
pick — sdxl=compatible, pony=blocked-on-SDXL, cancel=dismissed),
`?pickCkpt=flux|cancel` (canned checkpoint pick).

```bash
npm run build               # tsc --noEmit && vite build
npm test                    # vitest (pure-logic + queue-driver simulation)
```

## Validate

```bash
civitai app validate        # mirrors the platform approve-time validator
```

## Publish + verify end-to-end (the real dog-food — NOT done here)

This repo is left **buildable + validated** but **unpublished**. To take it live
and verify real Buzz spend:

1. **Publish**: `civitai login` then `civitai app submit` (packages the source;
   the platform rebuilds via `buildCommand`/`outputDir`).
2. **Approve**: a moderator approves the submission (Forgejo webhook → apply).
   Submit is currently **mod-gated** server-side (`assertViewerIsModerator` on
   `submitWorkflow`) — same gate the buzz-generator dog-food hit — so a non-mod
   cannot yet spend through it. Relaxing that gate for pages is a GA decision.
3. **Render**: hit `/apps/run/gen-matrix` (behind the `app-blocks` / pages flag,
   widened to your account) and confirm the iframe mounts. Add the preview
   origin to `.env.production` if verifying on a preview host first.
4. **Spend**: as a mod with Buzz, run a small (e.g. 2-cell) matrix and confirm
   real Buzz is deducted, images render per cell, and the total matches.

`.env.production` bakes the allowed parent origins (`civitai.com`) into the
bundle at build time — these must be correct for where the app is served.
