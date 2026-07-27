// Ecosystem-family grouping for the in-block resource browser (Pass 2).
//
// ⚠️ TEMPORARY CLIENT-SIDE MIRROR — REPLACE WITH THE PLATFORM ENDPOINT.
//   This is a SMALL, COARSE mirror of the server's `getBaseModelSetType`
//   grouping (civitai/civitai `src/shared/constants/generation.constants.ts`).
//   It exists ONLY so a sandboxed iframe (which cannot import those server
//   tables) can:
//     (a) drive the public REST `baseModels` filter when browsing LoRAs, and
//     (b) show a "N compatible for <family>" discovery count.
//
//   It is NOT a compatibility authority and MUST NOT hard-block anything. The
//   SERVER submit gate (`getResourceGenerationSupport` + `crossEcosystemRules`,
//   GA'd via civitai #2660) remains the SOLE authority — it can accept valid
//   CROSS-ecosystem pairings (e.g. a Pony LoRA on SDXL = 'partial') that this
//   coarse map would never know about. An incompatible pair is rejected
//   server-side pre-spend (Pass-0 maps that reject to a muted, zero-cost cell).
//
//   TODO(platform): delete this file and switch the browser to the forthcoming
//   `resource-search` endpoint, which will return authoritative
//   ecosystem/compatibility verdicts from `getResourceGenerationSupport`. Until
//   that ships, keep this list minimal — just the MAJOR ecosystems — so it rots
//   slowly and is obviously not the source of truth.

/** The coarse ecosystem families this block knows about. */
export type EcosystemFamily = 'SD1' | 'SDXL' | 'PONY' | 'ILLUSTRIOUS' | 'FLUX' | 'SD3' | 'VIDEO';

/**
 * baseModel NAME (as returned by the REST API / stored on a ModelVersion) →
 * coarse family. Lowercased keys; lookup is case-insensitive (see
 * `familyForBaseModel`). Mirrors the server's coarse buckets — kept minimal.
 *
 * NOTE: the server's SDXL "set" is broad (SDXL + Pony + Illustrious + NoobAI +
 * their distilled variants all generate against the SDXL ecosystem). For the
 * `baseModels` REST FILTER we keep them as DISTINCT families so the count is
 * specific ("N for Pony" vs "N for SDXL"), but `relatedFamilies` below expands a
 * family to the baseModel NAMES that should be requested together — this is how
 * we approximate the server's broader set when fetching, without claiming
 * authority.
 */
const BASE_MODEL_FAMILY: Readonly<Record<string, EcosystemFamily>> = {
  // SD 1.x
  'sd 1.4': 'SD1',
  'sd 1.5': 'SD1',
  'sd 1.5 lcm': 'SD1',
  'sd 1.5 hyper': 'SD1',
  // SDXL core + distilled
  'sdxl 0.9': 'SDXL',
  'sdxl 1.0': 'SDXL',
  'sdxl 1.0 lcm': 'SDXL',
  'sdxl lightning': 'SDXL',
  'sdxl hyper': 'SDXL',
  'sdxl turbo': 'SDXL',
  // Pony (SDXL-derived ecosystem, but its own LoRA pool)
  pony: 'PONY',
  // Illustrious / NoobAI (SDXL-derived anime ecosystem)
  illustrious: 'ILLUSTRIOUS',
  noobai: 'ILLUSTRIOUS',
  // Flux
  'flux.1 s': 'FLUX',
  'flux.1 d': 'FLUX',
  'flux.1 kontext': 'FLUX',
  // SD3
  'sd 3': 'SD3',
  'sd 3.5': 'SD3',
  'sd 3.5 medium': 'SD3',
  'sd 3.5 large': 'SD3',
  'sd 3.5 large turbo': 'SD3',
};

/**
 * Family → the baseModel NAMES to request together in the REST `baseModels`
 * filter. This approximates the server's broader "generation set" so a Pony
 * checkpoint also surfaces Illustrious/SDXL LoRAs that the server WILL accept
 * cross-ecosystem (we never block on it — the server decides). The exact-self
 * names are derived from BASE_MODEL_FAMILY; this just adds the related buckets.
 */
const RELATED_FAMILIES: Readonly<Record<EcosystemFamily, readonly EcosystemFamily[]>> = {
  // The whole SDXL super-ecosystem cross-generates per the server gate.
  SDXL: ['SDXL', 'PONY', 'ILLUSTRIOUS'],
  PONY: ['PONY', 'SDXL', 'ILLUSTRIOUS'],
  ILLUSTRIOUS: ['ILLUSTRIOUS', 'SDXL', 'PONY'],
  SD1: ['SD1'],
  FLUX: ['FLUX'],
  SD3: ['SD3'],
  VIDEO: ['VIDEO'],
};

/**
 * Resolve a baseModel name to its coarse family, or `null` when unknown. A
 * `null` family is the deliberate "fall back to UNFILTERED" signal for the
 * browser (show all LoRAs rather than an empty list) — see `loraBaseModelFilter`.
 */
export function familyForBaseModel(baseModel: string | undefined | null): EcosystemFamily | null {
  if (!baseModel) return null;
  return BASE_MODEL_FAMILY[baseModel.trim().toLowerCase()] ?? null;
}

/**
 * The list of baseModel NAMES to send as the REST `baseModels` filter when
 * browsing LoRAs compatible with the given checkpoint baseModels.
 *
 *  - Empty input, or ANY selected checkpoint whose family is unknown → returns
 *    `[]` = "do not filter" (the caller omits `baseModels`, showing ALL LoRAs).
 *    Falling back to unfiltered (never an empty result) is required by the spec.
 *  - Multiple checkpoints with DIFFERENT families → the UNION of all their
 *    related-family baseModel names (decision: union, not "mixed→none"; the UI
 *    shows a small "mixed ecosystems" note when >1 distinct family is present —
 *    see `distinctFamilies`).
 *
 * Returns a de-duped, stable-ordered array of baseModel NAME strings (the exact
 * strings the REST API expects), NOT family codes.
 */
export function loraBaseModelFilter(checkpointBaseModels: readonly (string | undefined)[]): string[] {
  if (checkpointBaseModels.length === 0) return [];
  const families: EcosystemFamily[] = [];
  for (const bm of checkpointBaseModels) {
    const fam = familyForBaseModel(bm);
    if (fam == null) return []; // unknown family → unfiltered fallback
    families.push(fam);
  }
  // Expand each selected family to its related families, then to baseModel names.
  const wanted = new Set<EcosystemFamily>();
  for (const fam of families) {
    for (const rel of RELATED_FAMILIES[fam]) wanted.add(rel);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  // Preserve BASE_MODEL_FAMILY insertion order for stable output.
  for (const [name, fam] of Object.entries(BASE_MODEL_FAMILY)) {
    if (wanted.has(fam) && !seen.has(name)) {
      seen.add(name);
      // Re-emit the canonical (original-cased) name from the source map keys.
      names.push(CANONICAL_NAME[name] ?? name);
    }
  }
  return names;
}

/**
 * The distinct coarse families across the selected checkpoints (unknowns
 * dropped). Used by the UI to decide whether to show the "mixed ecosystems"
 * note (>1 distinct family).
 */
export function distinctFamilies(
  checkpointBaseModels: readonly (string | undefined)[],
): EcosystemFamily[] {
  const out: EcosystemFamily[] = [];
  for (const bm of checkpointBaseModels) {
    const fam = familyForBaseModel(bm);
    if (fam != null && !out.includes(fam)) out.push(fam);
  }
  return out;
}

/**
 * A short human label for the "N compatible for X" count, given the selected
 * checkpoints. "for SDXL", "for Pony", "for SDXL + Pony" (mixed), or
 * "across all base models" when unfiltered (no/unknown family).
 */
export function compatibleForLabel(
  checkpointBaseModels: readonly (string | undefined)[],
): string {
  const fams = distinctFamilies(checkpointBaseModels);
  // Unfiltered case: empty selection OR any unknown family triggers no filter.
  if (fams.length === 0 || loraBaseModelFilter(checkpointBaseModels).length === 0) {
    return 'across all base models';
  }
  const names = fams.map((f) => FAMILY_LABEL[f]);
  return `for ${names.join(' + ')}`;
}

/** Display labels for the coarse families. */
const FAMILY_LABEL: Readonly<Record<EcosystemFamily, string>> = {
  SD1: 'SD 1.5',
  SDXL: 'SDXL',
  PONY: 'Pony',
  ILLUSTRIOUS: 'Illustrious / NoobAI',
  FLUX: 'Flux',
  SD3: 'SD 3.x',
  VIDEO: 'Video',
};

/** The friendly label for a family code (for pills + the dropdown options). */
export function familyLabel(fam: EcosystemFamily): string {
  return FAMILY_LABEL[fam];
}

// ---------------------------------------------------------------------------
// Explicit ecosystem filter (Fix 2). The dropdown lets the user pick families
// directly; these helpers are the PURE, node-tested core that (a) lists the
// selectable options (derived from the family map, never a divergent hardcoded
// list) and (b) turns an explicit family selection into the REST `baseModels`
// filter — taking PRECEDENCE over the implicit checkpoint-derived filter, with
// the same "empty → unfiltered" fallback.
// ---------------------------------------------------------------------------

/** A selectable ecosystem option for the multiselect dropdown. */
export interface EcosystemOption {
  family: EcosystemFamily;
  label: string;
}

/**
 * The ecosystem options the dropdown offers, DERIVED from the family map (every
 * distinct family that appears in BASE_MODEL_FAMILY), in a stable, sensible
 * display order. VIDEO is included only if a VIDEO baseModel is ever added to
 * the map (today it isn't), so the list never diverges from what we can filter.
 */
export function ecosystemOptions(): EcosystemOption[] {
  // Preferred display order; any family present in the map but missing here is
  // appended (defensive — keeps the list complete if the map grows).
  const ORDER: readonly EcosystemFamily[] = ['SDXL', 'PONY', 'ILLUSTRIOUS', 'SD1', 'FLUX', 'SD3', 'VIDEO'];
  const present = new Set<EcosystemFamily>(Object.values(BASE_MODEL_FAMILY));
  const ordered: EcosystemFamily[] = [];
  for (const fam of ORDER) if (present.has(fam) && !ordered.includes(fam)) ordered.push(fam);
  for (const fam of present) if (!ordered.includes(fam)) ordered.push(fam);
  return ordered.map((family) => ({ family, label: FAMILY_LABEL[family] }));
}

/**
 * The REST `baseModels` filter for an EXPLICIT family selection. Unlike the
 * checkpoint-derived `loraBaseModelFilter` (which expands each family to its
 * cross-generation related set), an explicit pick is treated as EXACT — we send
 * only the baseModel names that map to a SELECTED family, so "Pony" means Pony,
 * not the whole SDXL super-set. Empty selection → `[]` (= unfiltered fallback).
 * Returns a de-duped, stable-ordered array of canonical baseModel NAME strings.
 */
export function explicitBaseModelFilter(families: readonly EcosystemFamily[]): string[] {
  if (families.length === 0) return [];
  const wanted = new Set<EcosystemFamily>(families);
  const names: string[] = [];
  const seen = new Set<string>();
  // Preserve BASE_MODEL_FAMILY insertion order for stable output.
  for (const [name, fam] of Object.entries(BASE_MODEL_FAMILY)) {
    if (wanted.has(fam) && !seen.has(name)) {
      seen.add(name);
      names.push(CANONICAL_NAME[name] ?? name);
    }
  }
  return names;
}

/**
 * The effective REST `baseModels` filter, resolving PRECEDENCE between the
 * explicit dropdown selection and the implicit checkpoint-derived filter:
 *
 *  - explicit families selected → `explicitBaseModelFilter(explicit)` wins
 *    (applies to BOTH checkpoint and LoRA browse).
 *  - no explicit selection, LoRA browse → fall back to the implicit
 *    checkpoint-derived `loraBaseModelFilter(checkpointBaseModels)`.
 *  - no explicit selection, Checkpoint browse → `[]` (unfiltered), matching the
 *    current behavior (checkpoints aren't implicitly filtered).
 *
 * `[]` means "do not send baseModels" (show everything) in every case.
 */
export function effectiveBaseModelFilter(args: {
  explicitFamilies: readonly EcosystemFamily[];
  isLora: boolean;
  checkpointBaseModels: readonly (string | undefined)[];
}): string[] {
  if (args.explicitFamilies.length > 0) return explicitBaseModelFilter(args.explicitFamilies);
  if (args.isLora) return loraBaseModelFilter(args.checkpointBaseModels);
  return [];
}

// The REST API expects the canonical (original-cased) baseModel name; our map
// keys are lowercased for case-insensitive lookup, so keep the canonical forms
// for re-emission in the filter.
const CANONICAL_NAME: Readonly<Record<string, string>> = {
  'sd 1.4': 'SD 1.4',
  'sd 1.5': 'SD 1.5',
  'sd 1.5 lcm': 'SD 1.5 LCM',
  'sd 1.5 hyper': 'SD 1.5 Hyper',
  'sdxl 0.9': 'SDXL 0.9',
  'sdxl 1.0': 'SDXL 1.0',
  'sdxl 1.0 lcm': 'SDXL 1.0 LCM',
  'sdxl lightning': 'SDXL Lightning',
  'sdxl hyper': 'SDXL Hyper',
  'sdxl turbo': 'SDXL Turbo',
  pony: 'Pony',
  illustrious: 'Illustrious',
  noobai: 'NoobAI',
  'flux.1 s': 'Flux.1 S',
  'flux.1 d': 'Flux.1 D',
  'flux.1 kontext': 'Flux.1 Kontext',
  'sd 3': 'SD 3',
  'sd 3.5': 'SD 3.5',
  'sd 3.5 medium': 'SD 3.5 Medium',
  'sd 3.5 large': 'SD 3.5 Large',
  'sd 3.5 large turbo': 'SD 3.5 Large Turbo',
};

/**
 * Count how many of the returned LoRA cards are "compatible" with the selected
 * checkpoint families, for the "N compatible" indicator. Discovery-only — never
 * blocks. A card matches when its baseModel resolves to one of the families in
 * the (expanded) filter set; when unfiltered (no/unknown family) EVERY card
 * counts (the label is "across all base models").
 */
export function countCompatible(
  cardBaseModels: readonly (string | undefined)[],
  checkpointBaseModels: readonly (string | undefined)[],
): number {
  const filterNames = loraBaseModelFilter(checkpointBaseModels);
  if (filterNames.length === 0) return cardBaseModels.length; // unfiltered → all count
  const wanted = new Set(filterNames.map((n) => n.toLowerCase()));
  let n = 0;
  for (const bm of cardBaseModels) {
    if (bm && wanted.has(bm.trim().toLowerCase())) n += 1;
  }
  return n;
}
