// Curated model set for Gen Matrix v1.
//
// WHY A HARDCODED SET (the known platform gap):
//   A W10 page slot is entity=none — it carries NO model context (unlike a
//   model slot, which delivers modelId/modelVersionId via BLOCK_INIT) and the
//   SDK exposes NO page model-search / picker capability. So a page app cannot
//   let the user browse models; it must ship a known-good curated set. Each
//   entry below was verified live against the prod civitai DB (2026-06-18) to be
//   `availability='Public'` AND `GenerationCoverage.covered=true` AND SFW
//   (model.nsfw=false, nsfwLevel<=1), the same bar the buzz-generator dog-food
//   used for its single hardcoded SDXL base.
//
// A real in-app model browser needs a page model-search SDK + host capability
// (a "page resource picker" bridge). That is the documented platform follow-up.

export interface CheckpointOption {
  /** ModelVersion id submitted to the workflow as `modelVersionId`. */
  versionId: number;
  /** Parent Model id submitted as `modelId`. */
  modelId: number;
  /** Short display label for the grid row header. */
  label: string;
  /** Base-model family — display/label only; compatibility is a SERVER authority. */
  baseModel: string;
  /**
   * The model's own public name, WITHOUT the version folded in — the shared
   * `ResourceCard` renders the two on separate lines. OPTIONAL because state
   * persisted by a build before this field existed carries only `label`; see
   * {@link checkpointResource} for the fallback.
   */
  modelName?: string;
  /** The version's own public name ("v9"). Optional for the same reason. */
  versionName?: string;
}

/**
 * The second matrix axis. Two kinds of column:
 *   - PROMPT-STYLE modifiers (a `promptSuffix` folded into `params.prompt`) —
 *     every cell is a REAL, visibly-different generation that spends real Buzz.
 *   - LoRA modifiers (a `loraVersionId` + `loraStrength` + `baseModelFamily`) —
 *     submitted as an `additionalResources` entry layered on the cell's
 *     checkpoint.
 *
 * THE (FORMER) LoRA GAP — now CLOSED (civitai #2640/#2641 + #2660 GA):
 *   The literal "checkpoint × LoRA" matrix used to be unrealizable on a PAGE
 *   for two reasons, both now resolved upstream:
 *     1. The block workflow schema (`blockWorkflowBodySchema`) had NO LoRA /
 *        additional-resource field. #2641 ADDED an optional
 *        `additionalResources: Array<{ modelVersionId, strength? }>` (max 5,
 *        strength ∈ [-1, 2], default 1) to the workflow body, surfaced on the
 *        SDK's `WorkflowBody` type in app-sdk 0.10.0.
 *     2. A page couldn't pair a checkpoint with a LoRA. #2640 added page
 *        resource-pairing: a page submits its OWN checkpoint as
 *        `modelVersionId` AND the LoRA(s) inline via `additionalResources`, so
 *        no install / viewer-settings rows are needed.
 *   So `buildCellBody` now EMITS a LoRA as an `additionalResources` entry for a
 *   LoRA modifier, and EVERY cell is submitted. COMPATIBILITY IS A SERVER
 *   AUTHORITY — the block does NOT pre-block any pairing:
 *     - The page-LoRA gate went GA (#2660): it accepts platform-valid
 *       CROSS-ecosystem LoRAs (e.g. a Pony LoRA on an SDXL checkpoint =
 *       `'partial'` support) via `getResourceGenerationSupport`/
 *       `crossEcosystemRules`. The block CANNOT import those ecosystem tables
 *       (sandboxed iframe) and must NOT replicate them (it would rot), so it
 *       defers: the server rejects a genuinely-incompatible pair PRE-SPEND with
 *       a `BAD_REQUEST` ('not compatible with the checkpoint base model'), which
 *       the block maps per-cell to `blocked` (muted, costs 0 — see
 *       `isIncompatibleResourceError`). The earlier exact-string family check
 *       (`baseModelFamily !== checkpoint.baseModel`) was REMOVED — it
 *       false-blocked these now-valid cross-ecosystem combos.
 *   (Per-resource entitlement + cost are also enforced server-side; an
 *   over-budget cell returns the `insufficient` failed snapshot the block
 *   already handles.)
 */
export interface ModifierOption {
  /** Stable key used in the cell id (dedup / idempotency). */
  key: string;
  /** Short display label for the grid column header. */
  label: string;
  /**
   * Appended to the shared prompt for this column (comma-joined). Empty string
   * = the baseline column (the shared prompt verbatim, no modifier).
   */
  promptSuffix: string;
  /**
   * When non-null, this column is a LoRA submitted as an `additionalResources`
   * entry on top of the cell's checkpoint (see the LoRA note above). Every such
   * cell is SUBMITTED; the server decides compatibility and rejects an
   * incompatible pairing pre-spend → the block maps that to `blocked`.
   */
  loraVersionId?: number | null;
  /**
   * LoRA strength for the `additionalResources` entry. Server range [-1, 2],
   * default 1. Only meaningful when `loraVersionId` is set.
   */
  loraStrength?: number;
  /**
   * The LoRA's base-model family, carried for display / fallback labels only.
   * It NO LONGER drives blocking — compatibility is a server authority (the GA
   * page-LoRA gate accepts cross-ecosystem pairings). Only meaningful when
   * `loraVersionId` is set.
   */
  baseModelFamily?: string;
  /**
   * The LoRA's parent MODEL id. Carried for display only — the wire needs
   * `loraVersionId` alone (`additionalResources[].modelVersionId`).
   *
   * 🔴 ITS PRESENCE IS THE GATE for rendering this column as a resource rather
   * than a chip: see {@link loraResource}, which returns `null` without it. A
   * prompt-style column has no resource at all, and a LoRA column persisted by a
   * build before this field existed has an incomplete one — both must fall back
   * to the pill, and one nullable projection covers both.
   */
  loraModelId?: number;
  /** The LoRA model's own public name, without the version folded in. */
  modelName?: string;
  /** The LoRA version's own public name ("v2.0"). */
  versionName?: string;
}

/**
 * The shared baseline column. Always present so the grid has a "no modifier"
 * reference cell (the spec's "no-LoRA baseline"). Its key is reserved.
 */
export const BASELINE_MODIFIER: ModifierOption = {
  key: 'baseline',
  // "No style (plain prompt)" reads far clearer than the jargon "Baseline" — it
  // is literally the shared prompt with no modifier applied (the reference cell).
  label: 'No style (plain prompt)',
  promptSuffix: '',
  loraVersionId: null,
};

/**
 * Curated checkpoints. Both are foundational, multi-million-generation public
 * bases that will effectively never be deleted or lose coverage:
 *  - SD XL 1.0 (VAE fix) — the canonical SDXL base (101055/128078).
 *  - Pony Diffusion V6 XL — the single most-generated model on the platform
 *    (257749/290640).
 * Verified Public + covered + SFW on prod 2026-06-18.
 */
// 🔴 `label` STAYS SHORT AND `modelName`/`versionName` ARE THE REAL ONES. The
// label is a grid ROW HEADER — it sits in a narrow `<th>` beside every cell, so
// "Pony Diffusion V6 XL / V6 (start with this one)" cannot go there. The public
// names are carried separately for the axis card, which has room for both.
// Read from the live API 2026-09-05 (`/api/v1/model-versions/<id>`), not typed
// from memory: `128078` is model "SD XL" version "v1.0 VAE fix", `290640` is
// "Pony Diffusion V6 XL" version "V6 (start with this one)".
export const CHECKPOINTS: readonly CheckpointOption[] = [
  {
    versionId: 128078,
    modelId: 101055,
    label: 'SD XL 1.0',
    baseModel: 'SDXL 1.0',
    modelName: 'SD XL',
    versionName: 'v1.0 VAE fix',
  },
  {
    versionId: 290640,
    modelId: 257749,
    label: 'Pony V6 XL',
    baseModel: 'Pony',
    modelName: 'Pony Diffusion V6 XL',
    versionName: 'V6 (start with this one)',
  },
] as const;

/**
 * Curated style modifiers (the second axis). Each prompt-style entry is a short
 * suffix that produces a visibly different cell. Plus a sample LoRA modifier
 * that is now REAL (submitted via `additionalResources` — see the LoRA note
 * above): it is attempted on EVERY checkpoint and only renders as `blocked` if
 * the SERVER rejects the pairing as incompatible (the GA gate may accept some
 * cross-ecosystem pairings). The three style suffixes are neutral / SFW.
 */
export const MODIFIERS: readonly ModifierOption[] = [
  BASELINE_MODIFIER,
  {
    key: 'cinematic',
    label: 'Cinematic',
    promptSuffix: 'cinematic lighting, dramatic shadows, film still',
    loraVersionId: null,
  },
  {
    key: 'anime',
    label: 'Anime',
    promptSuffix: 'anime style, cel shading, vibrant colors',
    loraVersionId: null,
  },
  {
    key: 'watercolor',
    label: 'Watercolor',
    promptSuffix: 'watercolor painting, soft washes, paper texture',
    loraVersionId: null,
  },
  // 🔴 THE SEED LoRA COLUMN IS GONE, AND ITS ABSENCE IS THE FIX. This table
  // used to ship a fifth column, "LoRA: Sinfully Stylish" (versionId 407532),
  // described here as "a public + covered + SFW SDXL LoRA" verified on prod
  // 2026-06-18. Re-measured 2026-09-05, that resource is NOT IN THE ANON
  // CATALOG: `/api/v1/model-versions/407532` returns 404 "Model not found", and
  // a LORA search for the name returns 0 items. The positive control passes —
  // checkpoint `128078` returns 200 from the same endpoint with the same client
  // — so this is the resource being absent, not the reader being broken.
  //
  // 🔴 A DEAD SEED IS WORSE THAN NO SEED, which is why it is removed rather than
  // left in place with a note. It shipped pre-selected-able out of the box, so a
  // first-time viewer's likeliest second click added a column whose every cell
  // the server rejects pre-spend. The block renders that as `blocked`, which
  // reads as "this app cannot do LoRAs" rather than "this one model is gone".
  //
  // ⚠ NOT RULED OUT: both reads were ANONYMOUS, so a resource merely hidden from
  // anon (rather than deleted) looks identical from here. That does not change
  // the decision — a seed the anon catalog cannot see is a seed most viewers
  // cannot use — which is why this says "not in the anon catalog", not "deleted".
  //
  // LoRA columns are now entirely user-supplied, via the in-block browser
  // (`ResourceBrowser`) or the host's native picker (`useResourcePicker`) — see
  // the picked* helpers below. Both carry the FULL resource, which is what lets
  // the column axis render as `ResourceCard`s instead of bare name pills.
];

// ---------------------------------------------------------------------------
// Picker → axis-member helpers.
//
// The host's native resource picker (useResourcePicker) returns a
// BlockResourceInfo = { versionId, modelId, modelName, versionName, baseModel,
// modelType }. `versionName`/`modelName` are the public display names of the
// user-picked resource (civitai/civitai PageBlockHost #2655 + @civitai/app-sdk
// 0.12.0); the rest is DISCOVERY ONLY (the wire is re-validated server-side at
// estimate/submit). These turn a pick into a matrix-axis member, keeping the
// same money-safety + family invariants as the curated entries.
// ---------------------------------------------------------------------------

/** The default strength a picker-added LoRA starts at (server default, mid-range). */
export const PICKED_LORA_DEFAULT_STRENGTH = 1;

/**
 * Label a picked LoRA column. PREFER the public display name now that the picker
 * projection carries it (`@civitai/app-sdk` 0.12.0 / PageBlockHost #2655) —
 * "Sinfully Stylish — v2.0" reads far better than "#407532". Falls back to the
 * version id + base model ("LoRA #407532 (SDXL 1.0)") when no name is present
 * (older host/SDK, or the harness canned pick before the names were wired). The
 * fallback is deterministic, dedupes, and still tells the user the family.
 */
export function pickedLoraLabel(
  versionId: number,
  baseModel: string,
  names?: { modelName?: string; versionName?: string },
): string {
  const named = resourceDisplayName(names);
  return named ?? `LoRA #${versionId} (${baseModel})`;
}

/** Same idea for a picked checkpoint row header. */
export function pickedCheckpointLabel(
  versionId: number,
  baseModel: string,
  names?: { modelName?: string; versionName?: string },
): string {
  const named = resourceDisplayName(names);
  return named ?? `Model #${versionId} (${baseModel})`;
}

/**
 * Build a human display name from the picker's `modelName`/`versionName`, or
 * `undefined` when neither is present. Prefers "<model> — <version>" when both
 * exist (e.g. "Sinfully Stylish — v2.0"); falls back to whichever single name
 * is set. Whitespace-only names are treated as absent.
 */
function resourceDisplayName(names?: { modelName?: string; versionName?: string }): string | undefined {
  const model = names?.modelName?.trim();
  const version = names?.versionName?.trim();
  if (model && version) return `${model} — ${version}`;
  return model || version || undefined;
}

/** Minimal shape of a picked resource (mirrors the SDK's BlockResourceInfo). */
export interface PickedResource {
  versionId: number;
  modelId: number;
  /** Public display name of the picked model (e.g. "Sinfully Stylish"). */
  modelName: string;
  /** Public display name of the picked model version (e.g. "v2.0"). */
  versionName: string;
  baseModel: string;
  modelType: string;
}

/**
 * Turn a picked LoRA into a `ModifierOption` (a LoRA column). `key` is derived
 * from the version id so the same LoRA picked twice DEDUPES (buildMatrix keys on
 * `${checkpoint}::${modifier.key}`). `baseModelFamily` = the picked baseModel,
 * carried for display/label fallback only (it no longer drives blocking —
 * compatibility is a server authority): this column is attempted on every
 * checkpoint and renders `blocked` only where the server rejects the pairing.
 */
export function loraModifierFromPick(picked: PickedResource): ModifierOption {
  return {
    key: `lora-picked-${picked.versionId}`,
    label: pickedLoraLabel(picked.versionId, picked.baseModel, picked),
    promptSuffix: '',
    loraVersionId: picked.versionId,
    loraStrength: PICKED_LORA_DEFAULT_STRENGTH,
    baseModelFamily: picked.baseModel,
    // The split fields the composed `label` cannot be taken apart into.
    loraModelId: picked.modelId,
    modelName: picked.modelName,
    versionName: picked.versionName,
  };
}

/**
 * The `ResourceCard` shape for a LoRA column, or `null` when this column is not
 * a renderable resource.
 *
 * 🔴 NULLABLE ON PURPOSE, AND THE NULL ARM IS THE COMMON ONE. Three distinct
 * cases reach here and only the first is a resource:
 *   1. A user-added LoRA (browsed or picked) — full data, renders as a card.
 *   2. A PROMPT-STYLE column (Cinematic, Watercolor, the baseline) — not a
 *      resource in any sense. There is no `versionId` to show and no model to
 *      name; forcing one into a `ResourceCard` would render "#undefined" at
 *      people, which is the exact failure the component's own name fallback
 *      exists to prevent.
 *   3. A LoRA column persisted by a build BEFORE `loraModelId` existed. Its
 *      `label` still works, so it keeps the pill it has always had rather than
 *      degrading into a half-filled card.
 *
 * Returning `null` rather than throwing is what lets one axis hold both shapes
 * without the caller re-deriving "is this a resource?" from three fields.
 */
export function loraResource(mod: ModifierOption): PickedResource | null {
  if (mod.loraVersionId == null || mod.loraModelId == null) return null;
  return {
    versionId: mod.loraVersionId,
    modelId: mod.loraModelId,
    modelName: mod.modelName?.trim() || mod.label,
    versionName: mod.versionName ?? '',
    baseModel: mod.baseModelFamily ?? '',
    modelType: 'LORA',
  };
}

/** Turn a picked checkpoint into a `CheckpointOption` (a row). */
export function checkpointFromPick(picked: PickedResource): CheckpointOption {
  return {
    versionId: picked.versionId,
    modelId: picked.modelId,
    label: pickedCheckpointLabel(picked.versionId, picked.baseModel, picked),
    baseModel: picked.baseModel,
    // 🔴 The SPLIT names, kept ALONGSIDE the composed `label` rather than
    // instead of it. `label` is one string ("Sinfully Stylish — v2.0") because
    // it has to fit a grid row/column header; the shared `ResourceCard` wants
    // the model and the version as separate fields so it can render the version
    // in its own muted meta row. Deriving one from the other is not possible in
    // either direction: an em-dash is legal inside a model name.
    modelName: picked.modelName,
    versionName: picked.versionName,
  };
}

/**
 * The shape `@civitai/blocks-react/ui`'s `ResourceCard` takes — this app's local
 * mirror of the SDK's `BlockResourceInfo`, which is `PickedResource` above.
 *
 * 🔴 WHY A PROJECTION FUNCTION RATHER THAN STORING ONE. A `CheckpointOption` is
 * PERSISTED (see `persistence.ts`, which round-trips these objects verbatim), so
 * every field added here is a field that must survive a reload written by an
 * older build. `modelType` and the label fallback are DERIVABLE — a
 * `CheckpointOption` is a checkpoint by construction — so deriving them costs
 * nothing at read time and adds nothing to the stored shape. Only the two names
 * that genuinely cannot be recovered from a composed label are stored.
 *
 * `modelName` is optional because state persisted by a build before this change
 * has only `label`; that case falls back to the label, which is what the app
 * showed then and is never worse.
 */
export function checkpointResource(ckpt: CheckpointOption): PickedResource {
  return {
    versionId: ckpt.versionId,
    modelId: ckpt.modelId,
    modelName: ckpt.modelName?.trim() || ckpt.label,
    versionName: ckpt.versionName ?? '',
    baseModel: ckpt.baseModel,
    modelType: 'Checkpoint',
  };
}
