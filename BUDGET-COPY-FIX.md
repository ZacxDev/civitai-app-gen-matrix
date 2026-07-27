# Budget-copy fix — 200 reads as a CAP, not the spend (2026-06-19)

## Problem

The block's wording made users think a generation would spend the per-gen
budget **ceiling** (`PAGE_BUZZ_BUDGET_PER_CELL = 200`), when the real cost is
only a few Buzz/cell (~3–9; the dev harness models 8). The 200 is the
server-side per-gen **spend cap** (a safety limit the orchestrator clamps to),
not the expected cost.

Two leaks:

1. **Header copy** presented `≈200` as the per-cell spend.
2. **Pre-estimate totals** (build summary + confirm gate) multiplied the 200
   ceiling by the cell count and showed e.g. `est. total 400 Buzz` /
   `an estimated 400 Buzz`, which reads as a 400 spend when the real total is
   ~16.

The VALUE (200 cap, manifest `page.buzzBudgetPerGen: 200`) is correct and
**unchanged** — only the framing was wrong.

## Fix (wording + honest estimate display)

New pure, node-unit-tested copy helpers in `src/matrix.ts`
(`perCellBudgetCopy()`, `matrixTotalLabel()`, `CostLabel`) keep all budget
wording in one tested place. The cap-based total is now tagged `isCeiling` and
surfaced as a **maximum** ("up to N"), never as expected spend.

### Before → after

**Header sub-copy** (`App.tsx`):
- BEFORE: `Each cell spends a small amount of yellow Buzz (≈200 budget per cell).`
- AFTER: `Each cell spends only its real cost — usually just a few Buzz. (Per-gen spend is capped at 200 Buzz as a safety limit.)`

**Build summary box** (`App.tsx`, pre-run, no estimate yet):
- BEFORE: `2 cells · est. total 400 Buzz`
- AFTER: `2 cells · up to 400 Buzz max — real cost is usually far less`

**Confirm gate — headline** (`ConfirmPanel`):
- BEFORE: `Generate 2 cells for an estimated 400 Buzz (estimate)?`
- AFTER (ceiling/no estimate): `Generate 2 cells for up to 400 Buzz at most?`
- AFTER (real estimate known): `Generate N cells for ≈ M Buzz?`

**Confirm gate — note** (`ConfirmPanel`):
- BEFORE: `This spends real Buzz — one charge per cell. Nothing is spent until you confirm.`
- AFTER: `This spends real Buzz — one charge per cell, only its real cost (usually a few Buzz). 200 Buzz per cell is the safety cap, not what you'll spend. Nothing is spent until you confirm.`

### How the pre-estimate total is now presented

`matrixTotalLabel(cells, perCellEstimate)` returns a `CostLabel`:
- estimate **unknown** (null/0/NaN) → `{ amount: "up to N", isCeiling: true }`
  (cap × cells, a worst-case MAXIMUM). The UI adds "max — real cost is usually
  far less".
- estimate **known** (real per-cell estimate landed) → `{ amount: "≈ N",
  isCeiling: false }` (the realistic total).

Note: in the current click-path the per-cell estimate is seeded *during* the run
(in `runCell`) and the reducer resets `perCellEstimate` on every `BUILD`, so the
confirm gate is always pre-estimate today → it shows the "up to N at most"
ceiling framing. The `≈` real-estimate branch is logic-tested and is what the
gate would show if/when an estimate is available before confirm.

### Top-up CTA audited

`handleTopUp` still calls `openPurchaseModal(200 * 10 * cells)` — this is a
suggested **purchase** amount (how much Buzz to buy), not a spend claim, and no
user-facing string implies spending the cap. Left as-is.

## Tests

`src/matrix.test.ts` (+6 tests, 86 total, all green):
- `perCellBudgetCopy()` states the real cost is small, frames 200 as a cap/limit,
  and does not say a cell *spends* 200.
- `matrixTotalLabel()` marks a ceiling as an "up to" maximum (not "≈"), treats
  0/NaN as unknown→ceiling, uses the real estimate as "≈" when known, and the
  realistic number is far below the cap-based maximum.

`pnpm test` (vitest, 86 pass) and `pnpm build` (tsc + vite) both green.

## Harness verification (`dev:harness`, Playwright)

Exercised the real click-path at `http://localhost:5187/?consent=granted`:
- Header renders the new cap framing.
- Build summary: `2 cells · up to 400 Buzz max — real cost is usually far less`.
- Confirm gate: `Generate 2 cells for up to 400 Buzz at most?` + the cap note.
- Confirmed & ran → grid showed each cell's **real** cost `8 Buzz`, total
  `Done · spent 16 Buzz` — i.e. the pre-run "up to 400" maximum vs the realized
  16 spend, exactly the honesty gap this fix closes.

## Value-change suggestion (Zach's call)

The 200 cap is generous relative to the ~8/cell real cost (25× headroom). It was
raised 10→25→200 to avoid an immediate `insufficient` on LoRA cells. With the
copy now honest about the cap-vs-spend distinction, the value is fine as-is. If
you'd prefer a tighter safety bound, a cap around **50–100** would still clear a
single SDXL+LoRA gen with comfortable headroom while making the worst-case
maximum smaller and friendlier. This is a spend-affecting change (must stay in
sync with `block.manifest.json`'s `page.buzzBudgetPerGen`), so it's flagged, not
made.

## Deploy

Changes are in the working tree only (standalone dir, not a git repo). To ship:
`civitai app submit` → mod re-approve → rebuild.
