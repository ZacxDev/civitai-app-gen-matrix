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
}

/**
 * The shared baseline column. Always present so the grid has a "no modifier"
 * reference cell (the spec's "no-LoRA baseline"). Its key is reserved.
 */
export const BASELINE_MODIFIER: ModifierOption = {
  key: 'baseline',
  label: 'Baseline',
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
export const CHECKPOINTS: readonly CheckpointOption[] = [
  { versionId: 128078, modelId: 101055, label: 'SD XL 1.0', baseModel: 'SDXL 1.0' },
  { versionId: 290640, modelId: 257749, label: 'Pony V6 XL', baseModel: 'Pony' },
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
  // Sample LoRA: "Sinfully Stylish" (versionId 407532), a public + covered +
  // SFW SDXL LoRA. `baseModelFamily` is display/label metadata only — it no
  // longer drives blocking. Every checkpoint × this-LoRA cell is attempted; the
  // server decides compatibility (and rejects an incompatible pairing pre-spend,
  // which the block shows as `blocked`, costing 0). Strength 1 (server default,
  // mid of the [-1, 2] range).
  //
  // This is now a DEFAULT SEED, not the only LoRA source: the user can add more
  // LoRA columns via the host's native resource picker (useResourcePicker —
  // see picked* helpers below + App.tsx). The seed keeps the grid useful out of
  // the box.
  {
    key: 'lora-sinfully-stylish',
    label: 'LoRA: Sinfully Stylish',
    promptSuffix: '',
    loraVersionId: 407532,
    loraStrength: 1,
    baseModelFamily: 'SDXL 1.0',
  },
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
  };
}

/** Turn a picked checkpoint into a `CheckpointOption` (a row). */
export function checkpointFromPick(picked: PickedResource): CheckpointOption {
  return {
    versionId: picked.versionId,
    modelId: picked.modelId,
    label: pickedCheckpointLabel(picked.versionId, picked.baseModel, picked),
    baseModel: picked.baseModel,
  };
}
