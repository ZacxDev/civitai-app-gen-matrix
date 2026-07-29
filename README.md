# Gen Matrix

A Civitai **App Block** — a full-page (W10) app, rendered at `/apps/run/gen-matrix`,
that generates a **bounded grid of generations** so you can compare how each
model / style changes the output. Pick N checkpoints × M styles, hit **Generate
Matrix**, and every cell renders side-by-side (rows = checkpoints, columns =
styles). Each cell spends **real Buzz** via the page money path.

It is a first-party dog-food for the "money on pages" feature and extends a
single-gen block into a bounded matrix + concurrency-limited queue.

> **This repo is a public OSS mirror.** It contains deployment-agnostic block
> source only — no infrastructure internals.

## What it does

1. **Build** — choose checkpoints (rows), styles (columns), and a shared prompt.
   The status line shows the live **cell count** and **estimated total Buzz**.
   LoRA columns expose a **strength slider**.
2. **Confirm** — an explicit spend gate: *"Generate N cells for an estimated X
   Buzz? Nothing is spent until you confirm."* (focus-trapped modal).
3. **Consent (lazy)** — `ai:write:budgeted` is consent-gated, so the first run
   asks the host to open the Civitai consent dialog; the grant auto-resumes the
   run (no second click).
4. **Run** — a **concurrency-limited queue** (3 in-flight) drives each cell
   through estimate → submit → poll. Cells render `idle → estimating →
   submitting → polling → done / failed / out-of-buzz / incompatible / timed-out`
   independently.
5. **Results** — a grid of images + per-cell cost, the **total spent**, a
   per-run **Top up Buzz** CTA when a cell runs out, and **Retry failed** (which
   never re-charges a cell that already succeeded).

Results **survive a reload**: the run is persisted to per-viewer app storage and
rebuilt on mount, reconciled against the host's own workflow read-model — so a
refresh, timeout, or device-switch never means "paid for nothing" (see
_Production hardening_ below).

## Money safety (the load-bearing invariants)

All money-safety decisions live in the pure, node-unit-tested modules
(`matrix.ts`, `persistence.ts`) so they're verified without a DOM:

- **Hard cell cap** (`MAX_CELLS = 12`). A page cannot read the viewer's balance
  (`buzz:read:self` is page-forbidden), so the only defense against a careless
  matrix marching toward the platform per-user daily cap (50,000 Buzz) is to
  bound the cell count up front. Generate is disabled above the cap. Worst case
  = 12 × the 1000 server per-cell ceiling = 12,000 << 50,000.
- **Per-cell budget** = manifest `page.buzzBudgetPerGen` (**200**), server-read
  and clamped to ≤1000. The real cost is a few Buzz per cell — copy never implies
  a cell spends the cap.
- **Confirm-before-spend** with the estimated total; the "≈" estimate falls back
  to an honest "up to N" ceiling whenever it could undercount (≥2 distinct LoRAs).
- **Dedup / idempotency** — cells are keyed `${versionId}::${modifier.key}`, and
  a **submit guard** prevents any cell double-firing under React re-entrancy.
- **Retry never re-charges** — only `failed`/`insufficient` cells re-run; `done`
  cells keep their cost + image untouched.
- **Timed-out ≠ failed** — a poll that gives up marks the cell `timed-out` ("may
  still finish"); it is re-checkable by re-polling its existing workflow, never
  re-submitted.

## The model set (and the known gap)

A W10 page slot is **entity=none** — it carries no model context and the SDK
exposes no page model-picker, so v1 ships a small **curated set** (verified
Public + generation-covered + SFW), plus an **in-block resource browser** and the
host's **native resource picker** (`useResourcePicker`) to add more checkpoints /
LoRAs. LoRA × checkpoint **compatibility is a server authority**: every pairing is
submitted; the server rejects an incompatible one **pre-spend** (costs 0), shown
as a muted `incompatible` cell.

## Production hardening (v0.8.0)

| Item | What |
|---|---|
| **M1 — persistence** | The run is written to `useAppStorage` (per-viewer KV) and rebuilt on mount, then reconciled against `useAppWorkflows` (the host's app-scoped workflow read-model) for authoritative status / image / maturity / cost. A reload never loses paid outputs; an un-submitted cell restores as `canceled` (never auto-spends). |
| **M2 — timed-out recovery** | A `timed-out` cell is recovered automatically on reconcile, or manually via **Re-check** — both re-poll the existing workflow (no re-submit → no re-charge). |
| **M3 — insufficient-Buzz** | The insufficient-Buzz text sniff is tightened so it can't over-match an unrelated error that merely mentions "buzz"/"budget". Client-ready for a structured `errorCode` on the snapshot (a scoped upstream civitai change). |
| **G1 — maturity gate** | Result images render through a maturity gate: a level above the domain ceiling — or, fail-closed, an unknown level on a SFW domain — is blurred-until-tapped, so a `contentRating:"g"` page never paints ungated mature pixels. Per-image `nsfwLevel` comes from `useAppWorkflows`. |
| **G2 — error boundary** | The app is wrapped in a `RootBoundary` (a recoverable error boundary that reports to host analytics) so a render throw mid-run can't blank the iframe after a spend. |
| **M4 — submit guard** | A per-cell idempotency guard blocks a duplicate submit under StrictMode / re-entrancy (belt-and-suspenders to the platform's per-app Redis cap). |
| **Design system** | Retargeted to `@civitai/theme` `--civitai-*` tokens; adopts `@civitai/components-react` primitives — **Slider** (LoRA strength), **Image** (result cells), **Tooltip** (failed-cell detail), **SegmentedControl** (browser sort), **Toast** (failures). |

## Architecture

| File | Role |
|---|---|
| `src/matrix.ts` | **All load-bearing money logic, pure + unit-tested** — matrix builder, cap enforcement, cost estimation, the queue/grid **reducer** (incl. `RESTORE`/`RECONCILE`/`RECHECK_TIMEDOUT`), concurrency scheduling, insufficient-Buzz detection, snapshot→status mapping. |
| `src/persistence.ts` | **Pure** persistence + reconcile read-model (M1/M2) + the maturity-gate decision (G1). Node-unit-tested. |
| `src/models.ts` | The curated checkpoint + modifier set + picker→axis mappers. |
| `src/App.tsx` | Thin React driver: selection UI, confirm gate, lazy consent, the async queue driver, persistence wiring, and the panels (`BuildPanel`/`ConfirmPanel`/`ResultGrid`/`CellView`). |
| `src/theme.ts` | The design-system token palette (`--civitai-*`). |
| `src/ErrorBoundary.tsx` | `RootBoundary` + the `ErrorBoundary` class (G2). |
| `src/MaturityImage.tsx` | The maturity-gated result image (G1). |
| `src/ResourceBrowser.tsx` | In-block resource browser overlay. |
| `src/main.tsx` | Entry: injects design-system styles and mounts `BlockGate > RootBoundary > ToastProvider > App`. |

The React layer is deliberately thin; every money-safety decision lives in the
tested pure modules.

## Develop

This is a **pnpm** project (the platform builds strictly from `pnpm-lock.yaml`).

```bash
pnpm install
pnpm run dev:harness   # http://localhost:5187 — the shared SDK mock host
```

`pnpm run dev:harness` mounts `@civitai/blocks-react/testing`'s `<Harness>` — a
mock civitai host that answers the consent + token round-trip and simulates the
orchestrator money path plus the `useAppWorkflows` / `useAppStorage` read-model.
URL toggles: `?consent=granted`, `?viewer=anon`, `?fail=insufficient`,
`?fail=some`, `?theme=light`, `?pick=…`, `?pickCkpt=…`.

```bash
pnpm run build       # tsc --noEmit && vite build
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest — a `node` project (pure logic) + a `dom` project
                     # (component + integration tests in jsdom + Testing Library)
```

## Validate & publish

```bash
civitai app validate   # mirrors the platform approve-time validator
```

The real Buzz spend loop is Turnstile + auth-gated, so it is **not** headlessly
verifiable — correctness is covered by the pure-logic and jsdom test suites; the
live money round-trip must be verified by a human in a real (mod-gated) host.

`.env.production` bakes the allowed parent origins (`civitai.com`) into the
bundle at build time — these must be correct for where the app is served.
