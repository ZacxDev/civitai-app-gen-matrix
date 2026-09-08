# Gen Matrix — agent guide

A Civitai **App Block**: a full-page (W10) app served at `/apps/run/gen-matrix`
that runs one prompt across a grid of checkpoints × styles. Every cell is a real
generation that **spends the viewer's Buzz**, so the money-safety invariants in
[`README.md`](./README.md#money-safety-the-load-bearing-invariants) are the part
of this codebase that must never regress. Read that section before changing
`matrix.ts`, `persistence.ts`, or the confirm gate.

This repo is a **public OSS mirror** — block source only, no infrastructure
internals. Keep it that way.

## Get a shell

`pnpm` is **not on PATH** outside the dev shell. The flake pins the toolchain:

```bash
direnv allow          # or: nix develop
pnpm install --frozen-lockfile
```

| Task | Command |
|---|---|
| The gates CI runs | `pnpm test && pnpm build` |
| Types only | `pnpm typecheck` |
| Mock host (SDK `<Harness>`) | `pnpm run dev:harness` → http://localhost:5187 |
| Platform approve-time validator | `civitai app validate` (the Go CLI, installed separately — the flake does not ship it) |

Harness URL toggles: `?consent=granted`, `?viewer=anon`, `?fail=insufficient`,
`?fail=some`, `?theme=light`, `?pick=…`, `?pickCkpt=…`.

**Toolchain pins.** `.nvmrc` is the single authority for the node major — the
flake reads it, and CI reads it via `node-version-file`. pnpm's major is stated
twice (`flake.nix`'s `pnpmMajor` and the `pnpm/action-setup` step) because the
action reads only its own input or a `packageManager` field this repo
deliberately does not declare — adding one would change what the *platform's*
builder does, since `block.manifest.json`'s `buildCommand` runs against the same
`package.json`. `src/toolchain-lockstep.test.ts` fails if those two drift, or if
someone hardcodes a node version back into the workflow.

Only `x86_64-linux` is exercised. The flake evaluates for `aarch64-linux` and
`aarch64-darwin` too; `x86_64-darwin` is absent because nixpkgs-unstable dropped
it.

## Where a change belongs

Most work that *looks* like a bug here is a gap one layer down. Canonical
checkouts live at `~/workspace/civit/<repo-name>`; sibling directories with a
suffix (`civitai-blocks-impl`, `civitai-app-starters-sdk`, …) are topic
worktrees of the same remotes, usually on someone's feature branch.

| The change is about | Repo | Local |
|---|---|---|
| This block's UI, money logic, grid, gallery, history | **`ZacxDev/civitai-app-gen-matrix`** (here) | — |
| A hook, a type, the mock host, the design system — anything imported from `@civitai/*` | **`civitai/civitai-app-starters`** | `civitai-app-starters` |
| Host/server behavior: the `/apps/run` page surface, block token + scope enforcement, the page money path, app storage, the workflow read-model, submit/approval | **`civitai/civitai`** | `civitai` |
| `civitai app init/validate/submit`, login, dev tunnel | **`civitai/cli`** (Go) | `cli` |
| Public developer docs (developer.civitai.com) | **`civitai/civitai-developer-docs`** | `civitai-developer-docs` |

**All five `@civitai/*` dependencies ship from the one starters repo** —
`packages/civitai-app-sdk`, `civitai-blocks-react`, `civitai-components`,
`civitai-components-react`, `civitai-theme`. A missing hook, a wrong type, a
mock host that doesn't simulate something: that is a PR there, not a workaround
here.

Useful landmarks in `civitai/civitai`: `src/pages/apps/run` (the page surface),
`src/pages/api/blocks/manifest-schema.ts` + `submit-version.ts`,
`src/server/services/blocks/`.

Sibling app blocks worth reading for prior art — they hit the same platform
edges and several guards here were ported from them:
`ZacxDev/civitai-app-model-benchmarking`, `…-playable-collections`,
`…-custom-generators`, `…-sensei`, `…-requests`.

## Documentation sources, in authority order

1. **The installed package itself.** `node_modules/@civitai/<pkg>/dist/*.d.ts`
   and its `README.md` are the only source guaranteed to describe *the version
   this repo builds against*. Check `package.json` for that version first.
   Subpaths matter: `@civitai/app-sdk` exports `./blocks`, `./scopes`,
   `./orchestrator`, `./schemas/app-block/v1.json`; `@civitai/blocks-react`
   exports `./ui` and `./testing`.
2. **https://developer.civitai.com/apps/** — `guide/{quickstart,concepts,embedding,theming,text-to-image,comfy-cloud}`
   and `reference/{hooks,manifest,messages,scopes,components,generation,cli}`.
   Best for *why* and for the message-bridge contract. ⚠️ The generated pages
   carry a `sources:` front-matter naming the package version they were built
   from, and it **lags** the version here — when the page and the `.d.ts`
   disagree, the `.d.ts` wins.
3. **The starters repo** — `docs/build-your-first-app-block.md`,
   `starters/examples/*` (one runnable example per feature), and
   `starters/civitai-block-starter` (what `civitai app init` clones). Real code
   beats prose for "how is this hook meant to be used".
4. **The host implementation** in `civitai/civitai` — last-resort ground truth
   for server behavior the docs don't specify (which errors the orchestrator
   returns, what a scope actually gates, how a workflow snapshot is shaped).

For React 19 / Vite / Vitest specifics, use the `context7` MCP tools rather than
recalling from memory.

## Verifying a change

`pnpm test` runs **two vitest projects** and both must be read — a failure in
one is invisible in the other:

- **`node`** — `src/*.test.ts`, pure logic, no DOM. Every money-safety decision
  lives here on purpose (`matrix.ts`, `persistence.ts`).
- **`dom`** — `src/*.test.tsx`, jsdom + Testing Library, against the SDK mock
  host or injected props.

**What cannot be verified here:** the real Buzz spend loop is Turnstile + auth
gated. No local run, harness run, or test proves a cell actually charged
correctly — that needs a human in a real mod-gated host. Say so plainly rather
than reporting a green suite as if it covered the money path.

New guards should pin a *relationship* that cannot rot on a routine bump, and be
watched failing before they are trusted. `src/version-lockstep.test.ts` and
`src/toolchain-lockstep.test.ts` are the pattern to copy — both explain, in the
file, the incident they exist to prevent.

## Release protocol

- `block.manifest.json` and `package.json` versions move **together**.
  `src/version-lockstep.test.ts` enforces it; a release that bumps one is a
  shippable defect that has actually shipped before.
- Bumping any `@civitai/*` dependency also means updating
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` — pnpm's freshness gate
  otherwise refuses the new version at install time.
- `.env.production` bakes the allowed parent origins into the bundle at build
  time. Wrong value = the transport drops every host message and the iframe
  renders blank.
