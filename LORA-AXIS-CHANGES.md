# LoRA axis — wired real (2026-06-18)

The Gen Matrix LoRA axis was previously **wired-but-inert** (`buildCellBody`
never emitted a LoRA; `isLoraGapBlocked` flagged every LoRA cell `blocked`). The
platform gap is now **closed** by civitai **#2640** (page resource-pairing) +
**#2641** (`additionalResources` on the block workflow body) + **SDK #40**
(`@civitai/app-sdk@0.10.0` surfaces the field on `WorkflowBody`). This makes the
LoRA axis generate for real.

## What changed

### `src/models.ts`
- `ModifierOption` gained two LoRA fields: `loraStrength?: number` (default 1,
  server range [-1, 2]) and `baseModelFamily?: string` (matched exactly against
  a checkpoint's `baseModel` for family-compat filtering).
- The sample LoRA modifier (`lora-sinfully-stylish`, versionId **407532**) now
  carries `baseModelFamily: 'SDXL 1.0'` (matching the SD XL 1.0 checkpoint's
  `baseModel`) and `loraStrength: 1`. It now **generates** on SDXL and shows
  `blocked` on Pony V6 XL (different family).
- The big "LoRA GAP" doc comment was rewritten: gap CLOSED, with a short note on
  the one remaining v1 constraint (exact-ecosystem family match + LoRA-only).

### `src/matrix.ts`
- **`buildCellBody(checkpoint, prompt, modifier?)`** — new optional `modifier`
  arg. When `modifier.loraVersionId != null` it emits:
  ```ts
  additionalResources: [{ modelVersionId: loraVersionId, strength: clampLoraStrength(loraStrength ?? 1) }]
  ```
  A baseline / prompt-only modifier (or no modifier) emits **no**
  `additionalResources` — backward-compatible, checkpoint-only.
- Added `clampLoraStrength()` + `DEFAULT_LORA_STRENGTH`/`LORA_STRENGTH_MIN`/`_MAX`
  to keep `strength` within the server-accepted [-1, 2] range.
- **`isLoraGapBlocked(checkpoint, modifier)`** — signature changed (now takes the
  checkpoint). Returns `true` **only** for a LoRA whose `baseModelFamily` differs
  from the cell's `checkpoint.baseModel` (would be a server `BAD_REQUEST`). A
  family-compatible LoRA, and every non-LoRA modifier, returns `false`.
- `buildMatrix` passes the checkpoint into `isLoraGapBlocked` so `blocked` is now
  **per-cell** (checkpoint-dependent), not per-modifier. The cap / cost / queue
  already excluded `blocked` cells, so compatible LoRA cells are first-class with
  no further change.
- `PAGE_BUZZ_BUDGET_PER_CELL` 10 → **25** (see budget decision below).

### `src/App.tsx`
- `runCell` now calls `buildCellBody(cell.checkpoint, cell.prompt, cell.modifier)`.
- The Styles chips no longer mark LoRA columns `blocked` at selection time (a LoRA
  is selectable; blocking is per-cell). The explanatory note + the blocked
  cell-tile label ("LoRA incompatible / base model mismatch") were updated.

### `block.manifest.json`
- `page.buzzBudgetPerGen` 10 → **25**.

### Tests (`src/matrix.test.ts`, `src/queue-driver.test.ts`)
- `buildCellBody`: emits `additionalResources` for a compatible LoRA (correct
  versionId + strength), emits **nothing** for baseline/prompt-only, defaults
  strength to 1, clamps out-of-range strength to [-1, 2].
- `isLoraGapBlocked`: false for prompt-style + family-compatible LoRA; true only
  for a family-incompatible LoRA × checkpoint.
- `buildMatrix`: family-incompatible LoRA cell is `blocked`; family-compatible is
  `idle`; the SAME LoRA blocks on the incompatible checkpoint only (per-cell).
- Curated-set invariant: the sample LoRA is family-compatible with a curated SDXL
  checkpoint and emits an `additionalResources` entry there.
- `queue-driver`: the `999`-LoRA fixture is now family-incompatible (`Pony` vs
  SDXL checkpoints) → still `blocked` + never started; a new test runs a
  family-COMPATIBLE LoRA cell to completion.
- **All 79 tests pass; `pnpm build` (tsc --noEmit + vite) is clean** against the
  linked 0.10.0 SDK.

## SDK link (TEMPORARY — reverse on publish)

`@civitai/app-sdk@0.10.0` (SDK #40) is **not published** yet. The new
`additionalResources` field on `WorkflowBody` lives in the local build at
`../civitai-app-starters-lora/packages/civitai-app-sdk/dist/`.

What was done (reversible, no copies):
1. Bumped that local package's `package.json` version 0.9.0 → **0.10.0** (so it
   represents the #40 build).
2. `package.json`: dependency `@civitai/app-sdk` `0.9.0` → **`^0.10.0`**.
3. `pnpm-workspace.yaml`: added an `overrides` entry
   `'@civitai/app-sdk': 'link:../civitai-app-starters-lora/packages/civitai-app-sdk'`
   and updated `minimumReleaseAgeExclude` to `@civitai/app-sdk@0.10.0`.
4. `pnpm install` materialized the symlink (verified: `node_modules/@civitai/app-sdk`
   → local build, version 0.10.0, `additionalResources` resolves on the real
   `WorkflowBody` type — not `any`).

**ON SDK PUBLISH:**
- Delete the `overrides:` block in `pnpm-workspace.yaml` (and the explanatory
  comment).
- Confirm `@civitai/app-sdk: ^0.10.0` resolves the published version; run
  `pnpm install`.
- If `@civitai/blocks-react`'s peer range requires it, bump that too. (As of now
  blocks-react@0.6.0's peer is `>=0.7.0 <1`, which 0.10.0 satisfies — **no bump
  needed**.)

## buzzBudgetPerGen decision — SPEND-AFFECTING, please confirm

Raised `page.buzzBudgetPerGen` **10 → 25**.

Rationale: a checkpoint + 1-LoRA gen costs more than a checkpoint alone. At 10,
a LoRA cell risked an immediate `insufficient` failed snapshot on every LoRA
generation. 25 covers a single SDXL + 1-LoRA generation with headroom while
staying far under the server ≤1000 clamp. Worst-case fleet spend is still tiny:
12 cells × 25 = **300 Buzz**, well under the 50,000 per-user daily cap.

This is a **client-side estimate/fallback + the manifest value the server reads
at mint**; the real per-cell ceiling is enforced server-side. The block still
surfaces `insufficient` gracefully (per-cell Top-Up CTA) if a particular pairing
exceeds the budget.

**Zach: confirm 25 is acceptable** (I did not inflate beyond what one LoRA gen
needs — adjust the manifest + `PAGE_BUZZ_BUDGET_PER_CELL` together if you want a
different number; the precise SDXL+LoRA cost wasn't readable from this repo, so
25 is a conservative covering estimate, not a measured figure).

## Harness verification — what was exercised

Ran `pnpm dev:harness` and drove the LoRA path via Playwright
(`?consent=granted`, prompt set, SD XL 1.0 + Pony V6 XL checkpoints × Baseline +
"LoRA: Sinfully Stylish" → 4 cells, 1 blocked, 3 billable). Captured the
`SUBMIT_WORKFLOW` bodies the block posted to the host:

- **SDXL + Baseline** → `{ modelVersionId: 128078, params:{prompt} }`, **no
  `additionalResources`** (checkpoint-only, backward-compatible). ✅
- **SDXL + LoRA** (compatible) → carries **`additionalResources: [{ modelVersionId:
  407532, strength: 1 }]`** on the SDXL checkpoint — the cell is **no longer
  `blocked`**; it submitted and rendered a result. ✅ (reproduces the
  originally-inert symptom as fixed)
- **Pony + Baseline** → checkpoint-only, no `additionalResources`. ✅
- **Pony + LoRA** (family-incompatible) → rendered **`blocked`** ("LoRA
  incompatible / base model mismatch"), **never submitted** (absent from the 3
  captured bodies). ✅
- The cost line showed **3 cells · 75 Buzz** (3 × 25), confirming the blocked cell
  is excluded from the cap/cost. ✅

**What was NOT exercised:** real Buzz spend / real orchestrator generation /
server-side LoRA-only + family enforcement. The harness is a mock host (no
orchestrator, no prod creds) — it answers the bridge round-trips and simulates a
succeeded snapshot. Real end-to-end generation requires the #2640/#2641 platform
code deployed to prod + the block published/approved (mod-gated submit), which is
**not** done here and was **not** attempted. The harness conclusively verifies
the **emitted body** (additionalResources present/absent correctly) and the
**gating** (compatible = submittable, incompatible = blocked).
