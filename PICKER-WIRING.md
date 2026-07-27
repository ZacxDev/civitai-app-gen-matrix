# Resource-picker wiring (the LoRA axis goes from inert → user-driven)

Gen Matrix v0.2.0 wires the **native host resource picker** so the user PICKS
LoRAs (and optionally checkpoints) from Civitai's own modal, instead of the block
hard-coding a single sample LoRA version id. This closes the last v1 gap: the LoRA
second axis is no longer "wired but inert" — it's the real path.

## What changed

| File | Change |
|---|---|
| `package.json` | deps bumped: `@civitai/app-sdk ^0.10.0 → ^0.11.0`, `@civitai/blocks-react 0.6.0 → ^0.7.0` (the versions that ship `useResourcePicker` + the `OPEN_RESOURCE_PICKER` / `RESOURCE_PICKER_RESULT` message types). Version `0.1.1 → 0.2.0`. |
| `block.manifest.json` | version `0.1.1 → 0.2.0`. |
| `pnpm-workspace.yaml` | `minimumReleaseAgeExclude` pins updated to the two new versions. **No `link:`/`overrides`** — both versions are PUBLISHED on npm (see below). |
| `src/models.ts` | new `loraModifierFromPick()` / `checkpointFromPick()` (picked `BlockResourceInfo` → axis member), `pickedLoraLabel()` / `pickedCheckpointLabel()`, `PickedResource` type, `PICKED_LORA_DEFAULT_STRENGTH`. The sample LoRA is now a **default seed**, not the only LoRA source. |
| `src/App.tsx` | `useResourcePicker()` wired; "**+ Pick LoRA**" and "**+ Pick checkpoint**" affordances; picked members held in `pickedMods` / `pickedCkpts` state, merged with the curated set (`allModifiers` / `allCheckpoints`) and auto-selected. Sign-in gated; dedupe by versionId; in-flight `picking` guard. |
| `src/Harness.tsx` | mock host now answers `OPEN_RESOURCE_PICKER` → `RESOURCE_PICKER_RESULT` with a canned `BlockResourceInfo`, keyed off `?pick` (LoRA) / `?pickCkpt` (Checkpoint) query toggles. |
| `src/matrix.test.ts` | new `picker → axis member` suite (8 tests). |

### No local SDK link needed (correction to the task brief)

The task assumed `app-sdk@0.11.0` / `blocks-react@0.7.0` weren't on npm yet and
asked to `link:` a local `civitai-app-starters` build. **They ARE published**
(verified `npm view @civitai/app-sdk versions` → `…0.11.0`; `npm view
@civitai/blocks-react versions` → `…0.7.0`). So the block resolves them straight
from the registry — simpler and more robust than a `link:` override. The
`pnpm-workspace.yaml` keeps only the `minimumReleaseAgeExclude` pins (so pnpm's
freshness gate doesn't refuse a very-recent publish).

**Publish-time revert:** nothing to revert on the link front (there is no link).
If the registry's release-age gate ever stops mattering, the
`minimumReleaseAgeExclude` block can be dropped — purely cosmetic.

## How a pick becomes a matrix axis member

1. The user clicks **+ Pick LoRA** → `openResourcePicker({ resourceType: 'LORA' })`.
2. The host opens its OWN native resource modal as chrome; the block only gets the
   one picked resource back: a `BlockResourceInfo = { versionId, modelId,
   baseModel, modelType }` (or `null` on cancel).
3. `loraModifierFromPick(picked)` builds a `ModifierOption` with
   `loraVersionId = picked.versionId`, `baseModelFamily = picked.baseModel`,
   `loraStrength = 1` (server default), and `key = lora-picked-<versionId>` (so a
   re-pick **dedupes**).
4. It's appended to `pickedMods`, merged into `allModifiers`, and auto-selected →
   it becomes a real column in the grid.
5. From there it flows through the **unchanged** money-safety logic:
   `buildMatrix` keys/dedupes it, `isLoraGapBlocked` marks the cell `blocked` when
   `picked.baseModel` ≠ the cell checkpoint's family, `buildCellBody` emits
   `additionalResources: [{ modelVersionId, strength }]`, the `MAX_CELLS` cap +
   confirm-before-spend gate + insufficient-Buzz handling all apply identically.

Checkpoint picking is symmetric (`+ Pick checkpoint` → `checkpointFromPick` → a
new row); the curated SD XL / Pony checkpoints stay the default starting set.

## The label gap (assessment + recommendation)

The picker's `BlockResourceInfo` projection carries **no resource name** — only
`{ versionId, modelId, baseModel, modelType }`. So a picked column/row is labeled
deterministically from what we have:

- LoRA column → `LoRA #<versionId> (<baseModel>)` — e.g. `LoRA #666002 (SDXL 1.0)`
- Checkpoint row → `Model #<versionId> (<baseModel>)`

**Verdict: a mild UX wart, not a blocker for v1.** The base-model is the
load-bearing fact (it drives the blocked/compatible split and is shown), and the
id makes columns unambiguous + dedupable. But `LoRA #666002` reads worse than
`LoRA: Dramatic Lighting` — a user who picks several LoRAs can't tell them apart
at a glance without remembering version ids.

**Recommendation (small, worth doing — but NOT in this block):** add `modelName`
+ `versionName` to the **page picker projection** — the model-slot picker
post-back already includes them, so it's a matter of widening:
- civitai/civitai `PageBlockHost.tsx` `RESOURCE_PICKER_RESULT` projection, and
- the SDK `BlockResourceInfo` type (`@civitai/app-sdk` blocks/types).

Then this block swaps `pickedLoraLabel` to prefer the name when present (a
one-line change behind the existing helper). Until that lands, the id+baseModel
label is the honest v1.

## Tests + harness verification

- `pnpm test` → **94 passed** (86 prior + 8 new picker-helper tests covering:
  pick → LoRA column with the right `additionalResources`; family-incompat picked
  LoRA → `blocked` (never submitted); per-cell blocked split across checkpoints;
  dedupe; cap accounting; checkpoint-from-pick; the label-gap labels).
- `pnpm typecheck` + `pnpm build` → green against `app-sdk@0.11.0` /
  `blocks-react@0.7.0`.
- **Harness (Playwright, real postMessage bridge):**
  - `?pick=sdxl`: clicked **+ Pick LoRA** → harness returned a canned SDXL LoRA
    (v666002) → it became the column `LoRA #666002 (SDXL 1.0)`, cell count 1→2.
    Ran the matrix → the picked-LoRA cell's outbound `SUBMIT_WORKFLOW` body was
    `{ …modelVersionId:128078, additionalResources:[{modelVersionId:666002,
    strength:1}] }` (the baseline cell had none). Both cells rendered done (8 Buzz).
  - `?pick=pony`: picked a Pony LoRA (v555001) on the SD XL 1.0 checkpoint → the
    cell rendered **"LoRA incompatible / base model mismatch"** (`blocked`), the
    status line stayed at **1 billable cell** (blocked excluded from the cap), and
    the orchestrator log confirmed **v555001 was never submitted**.
  - `?pickCkpt=flux`: clicked **+ Pick checkpoint** → a new selected row
    `Model #691639 (Flux.1 D)` appeared, cell count 1→2.

## Deploy / publish gates (prod verification is BLOCKED on both)

The picker works **only in the harness** until BOTH of these land:

1. **SDK published** — ✅ already true (`app-sdk@0.11.0` + `blocks-react@0.7.0`
   are on npm, and the block resolves them). No action.
2. **Host handler deployed** — civitai **PR #2651** (the `OPEN_RESOURCE_PICKER`
   handler in `PageBlockHost.tsx`) must be **merged to `main` and reach prod via
   the `release` branch**. Until that deploys, a real page host won't answer
   `OPEN_RESOURCE_PICKER`, so the pick buttons will hang/cancel in prod.

Submit/deploy of this block itself is a separate follow-up (this repo is left
buildable + tested in the working tree; it is not git-tracked). The pre-existing
mod-gate on `submitWorkflow` still applies (see README "Publish + verify").

---

## Update 2026-06-19 — picker now returns RESOURCE NAMES (block 0.2.1)

The "label gap" above is **closed**. The page picker projection gained the public
display names of the user-picked resource, so a picked column/row renders the
real name instead of `#<id>`:

- **Host** (civitai/civitai **PR #2655**, NOT yet merged/deployed): `PageBlockHost.tsx`'s
  `RESOURCE_PICKER_RESULT.selected` now carries `modelName` + `versionName`
  (sourced `resource.model.name` / `resource.name` — exactly how the model-slot
  `CHECKPOINT_PICKER_RESULT` in `IframeHost.tsx` already sources them). The
  adversarial leak test still proves no sensitive field crosses the bridge; the
  allowlist is now the six fields `{ versionId, modelId, modelName, versionName,
  baseModel, modelType }`.
- **SDK** (`@civitai/app-sdk`, **civitai-app-starters PR #47**, NOT yet merged/published):
  `BlockResourceInfo` gains `modelName: string` + `versionName: string` (mirrors
  the names `BlockCheckpointInfo` already has). Lands as **app-sdk 0.12.0**.
- **This block (0.2.1):** `pickedLoraLabel` / `pickedCheckpointLabel` now PREFER
  `"<modelName> — <versionName>"` when present, falling back to the old
  `LoRA #<id> (<baseModel>)` / `Model #<id> (<baseModel>)` for an older host/SDK
  or a name-less harness pick. `PickedResource` + the harness `CannedResource` /
  `cannedPick` carry the two names. Harness-verified (Playwright): **+ Pick LoRA**
  now adds a column **"Sinfully Stylish — v2.0"** and **+ Pick checkpoint** a row
  **"FLUX.1 [dev] — fp8"** (real names, not `#666002` / `#691639`).

### TEMP SDK link (publish-time path)

Because app-sdk 0.12.0 isn't on npm yet, `pnpm-workspace.yaml` has an
`overrides['@civitai/app-sdk']` pointing at a LOCAL build of the SDK worktree
(`../civitai-app-starters-picker-names/packages/civitai-app-sdk`, built via
`pnpm --filter @civitai/app-sdk build`). **Once app-sdk 0.12.0 publishes:**

1. delete the `overrides['@civitai/app-sdk']` link in `pnpm-workspace.yaml`,
2. bump `dependencies['@civitai/app-sdk']` in `package.json` `^0.11.0` → `^0.12.0`,
3. `pnpm install` + `pnpm build`.

### Updated deploy gates for the NAMES to show live

The pick buttons already worked once #2651 deployed (gate above). For the picked
resources to show their **names** in prod, additionally:

1. **civitai PR #2655** (host projection) merged to `main` and reaching prod via
   `release`, AND
2. **app-sdk 0.12.0** published (civitai-app-starters PR #47 merged) + this block
   rebuilt against it (drop the temp link, bump to `^0.12.0`) and redeployed.

Until both land, a real host returns the name-less projection and the labels
fall back to `#<id>` — degrades gracefully, no breakage.
