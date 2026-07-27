import { describe, expect, it } from 'vitest';

import {
  compatibleForLabel,
  countCompatible,
  distinctFamilies,
  ecosystemOptions,
  effectiveBaseModelFilter,
  explicitBaseModelFilter,
  familyForBaseModel,
  familyLabel,
  loraBaseModelFilter,
} from './ecosystem.js';

describe('familyForBaseModel', () => {
  it('maps known base models case-insensitively', () => {
    expect(familyForBaseModel('SDXL 1.0')).toBe('SDXL');
    expect(familyForBaseModel('sdxl 1.0')).toBe('SDXL');
    expect(familyForBaseModel('  SDXL 1.0  ')).toBe('SDXL');
    expect(familyForBaseModel('Pony')).toBe('PONY');
    expect(familyForBaseModel('Illustrious')).toBe('ILLUSTRIOUS');
    expect(familyForBaseModel('NoobAI')).toBe('ILLUSTRIOUS');
    expect(familyForBaseModel('SD 1.5')).toBe('SD1');
    expect(familyForBaseModel('Flux.1 D')).toBe('FLUX');
    expect(familyForBaseModel('SD 3.5')).toBe('SD3');
  });

  it('returns null for unknown / empty base models', () => {
    expect(familyForBaseModel('SomeFutureModel')).toBeNull();
    expect(familyForBaseModel('')).toBeNull();
    expect(familyForBaseModel(undefined)).toBeNull();
    expect(familyForBaseModel(null)).toBeNull();
  });
});

describe('loraBaseModelFilter', () => {
  it('returns [] for empty selection (= unfiltered)', () => {
    expect(loraBaseModelFilter([])).toEqual([]);
  });

  it('returns [] (unfiltered fallback) when ANY family is unknown', () => {
    expect(loraBaseModelFilter(['SDXL 1.0', 'TotallyNewBase'])).toEqual([]);
    expect(loraBaseModelFilter(['Unknown'])).toEqual([]);
  });

  it('expands SDXL to the SDXL super-ecosystem (SDXL + Pony + Illustrious names)', () => {
    const names = loraBaseModelFilter(['SDXL 1.0']);
    expect(names).toContain('SDXL 1.0');
    expect(names).toContain('Pony');
    expect(names).toContain('Illustrious');
    expect(names).toContain('NoobAI');
    // Should NOT leak into unrelated families.
    expect(names).not.toContain('SD 1.5');
    expect(names).not.toContain('Flux.1 D');
  });

  it('expands Pony into the shared SDXL ecosystem too', () => {
    const names = loraBaseModelFilter(['Pony']);
    expect(names).toContain('Pony');
    expect(names).toContain('SDXL 1.0');
    expect(names).toContain('Illustrious');
  });

  it('keeps SD1 / Flux / SD3 isolated', () => {
    expect(loraBaseModelFilter(['SD 1.5'])).toEqual(['SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper']);
    const flux = loraBaseModelFilter(['Flux.1 D']);
    expect(flux).toContain('Flux.1 D');
    expect(flux).toContain('Flux.1 S');
    expect(flux).not.toContain('SDXL 1.0');
  });

  it('unions families when multiple distinct checkpoint families are selected', () => {
    const names = loraBaseModelFilter(['SDXL 1.0', 'Flux.1 D']);
    expect(names).toContain('SDXL 1.0');
    expect(names).toContain('Flux.1 D');
  });

  it('de-dupes overlapping expansions (no repeated names)', () => {
    const names = loraBaseModelFilter(['SDXL 1.0', 'Pony']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('emits canonical (original-cased) REST names, not lowercased keys', () => {
    const names = loraBaseModelFilter(['SD 1.5']);
    expect(names).toContain('SD 1.5');
    expect(names).not.toContain('sd 1.5');
  });
});

describe('distinctFamilies', () => {
  it('returns the distinct known families, dropping unknowns', () => {
    expect(distinctFamilies(['SDXL 1.0', 'Pony', 'SDXL 1.0'])).toEqual(['SDXL', 'PONY']);
    expect(distinctFamilies(['SDXL 1.0', 'Unknown'])).toEqual(['SDXL']);
    expect(distinctFamilies([])).toEqual([]);
  });
});

describe('compatibleForLabel', () => {
  it('labels a single family', () => {
    expect(compatibleForLabel(['SDXL 1.0'])).toBe('for SDXL');
    expect(compatibleForLabel(['Pony'])).toBe('for Pony');
    expect(compatibleForLabel(['SD 1.5'])).toBe('for SD 1.5');
  });

  it('labels mixed families with a +', () => {
    expect(compatibleForLabel(['SDXL 1.0', 'Flux.1 D'])).toBe('for SDXL + Flux');
  });

  it('falls back to "across all base models" when unfiltered (empty / unknown)', () => {
    expect(compatibleForLabel([])).toBe('across all base models');
    expect(compatibleForLabel(['Unknown'])).toBe('across all base models');
    // A known family mixed with an unknown → unfiltered fallback.
    expect(compatibleForLabel(['SDXL 1.0', 'Unknown'])).toBe('across all base models');
  });
});

describe('ecosystemOptions (dropdown source)', () => {
  it('derives options from the family map (no divergent hardcoded list)', () => {
    const opts = ecosystemOptions();
    const fams = opts.map((o) => o.family);
    // Every family that actually appears in the base-model map is offered.
    expect(fams).toContain('SDXL');
    expect(fams).toContain('PONY');
    expect(fams).toContain('ILLUSTRIOUS');
    expect(fams).toContain('SD1');
    expect(fams).toContain('FLUX');
    expect(fams).toContain('SD3');
    // VIDEO has no baseModel in the map today → not offered.
    expect(fams).not.toContain('VIDEO');
  });

  it('has no duplicate families and a stable leading order (SDXL first)', () => {
    const fams = ecosystemOptions().map((o) => o.family);
    expect(new Set(fams).size).toBe(fams.length);
    expect(fams[0]).toBe('SDXL');
  });

  it('uses the friendly labels (incl. the combined Illustrious / NoobAI)', () => {
    const byFam = new Map(ecosystemOptions().map((o) => [o.family, o.label]));
    expect(byFam.get('SDXL')).toBe('SDXL');
    expect(byFam.get('SD1')).toBe('SD 1.5');
    expect(byFam.get('SD3')).toBe('SD 3.x');
    expect(byFam.get('ILLUSTRIOUS')).toBe('Illustrious / NoobAI');
    expect(familyLabel('PONY')).toBe('Pony');
  });
});

describe('explicitBaseModelFilter (exact, not expanded)', () => {
  it('returns [] for an empty selection (= unfiltered)', () => {
    expect(explicitBaseModelFilter([])).toEqual([]);
  });

  it('maps a family to ONLY its own baseModel names (no cross-ecosystem expansion)', () => {
    const pony = explicitBaseModelFilter(['PONY']);
    expect(pony).toEqual(['Pony']);
    // Unlike the implicit checkpoint filter, Pony does NOT pull in SDXL/Illustrious.
    expect(pony).not.toContain('SDXL 1.0');
    expect(pony).not.toContain('Illustrious');
  });

  it('emits canonical REST names for SDXL core + distilled', () => {
    const sdxl = explicitBaseModelFilter(['SDXL']);
    expect(sdxl).toContain('SDXL 1.0');
    expect(sdxl).toContain('SDXL Lightning');
    expect(sdxl).not.toContain('Pony');
  });

  it('unions multiple selected families and de-dupes', () => {
    const names = explicitBaseModelFilter(['SD1', 'FLUX']);
    expect(names).toContain('SD 1.5');
    expect(names).toContain('Flux.1 D');
    expect(new Set(names).size).toBe(names.length);
  });

  it('maps ILLUSTRIOUS to both Illustrious and NoobAI', () => {
    expect(explicitBaseModelFilter(['ILLUSTRIOUS'])).toEqual(['Illustrious', 'NoobAI']);
  });
});

describe('effectiveBaseModelFilter (precedence)', () => {
  it('explicit selection takes precedence over the implicit checkpoint filter', () => {
    const out = effectiveBaseModelFilter({
      explicitFamilies: ['FLUX'],
      isLora: true,
      checkpointBaseModels: ['SDXL 1.0'], // would imply SDXL+Pony+Illustrious
    });
    expect(out).toContain('Flux.1 D');
    expect(out).not.toContain('SDXL 1.0');
  });

  it('explicit selection also filters the Checkpoint browser', () => {
    const out = effectiveBaseModelFilter({
      explicitFamilies: ['SD1'],
      isLora: false,
      checkpointBaseModels: [],
    });
    expect(out).toEqual(['SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper']);
  });

  it('no explicit + LoRA → falls back to implicit checkpoint-derived filter', () => {
    const out = effectiveBaseModelFilter({
      explicitFamilies: [],
      isLora: true,
      checkpointBaseModels: ['SDXL 1.0'],
    });
    expect(out).toEqual(loraBaseModelFilter(['SDXL 1.0']));
    expect(out).toContain('Pony'); // implicit expansion intact
  });

  it('no explicit + Checkpoint → unfiltered (matches current behavior)', () => {
    expect(
      effectiveBaseModelFilter({ explicitFamilies: [], isLora: false, checkpointBaseModels: ['SDXL 1.0'] }),
    ).toEqual([]);
  });

  it('no explicit + LoRA + empty checkpoints → unfiltered', () => {
    expect(
      effectiveBaseModelFilter({ explicitFamilies: [], isLora: true, checkpointBaseModels: [] }),
    ).toEqual([]);
  });
});

describe('countCompatible', () => {
  it('counts cards whose baseModel is in the filtered family set', () => {
    const cards = ['SDXL 1.0', 'Pony', 'SD 1.5', 'Flux.1 D'];
    // SDXL selection → SDXL family names include SDXL/Pony/Illustrious, not SD1/Flux.
    expect(countCompatible(cards, ['SDXL 1.0'])).toBe(2); // SDXL + Pony
  });

  it('counts ALL cards when unfiltered (empty / unknown checkpoint family)', () => {
    const cards = ['SDXL 1.0', 'SD 1.5', 'Whatever'];
    expect(countCompatible(cards, [])).toBe(3);
    expect(countCompatible(cards, ['UnknownBase'])).toBe(3);
  });

  it('is case-insensitive and ignores empty card baseModels', () => {
    const cards = ['sdxl 1.0', undefined, '', 'PONY'];
    expect(countCompatible(cards, ['SDXL 1.0'])).toBe(2);
  });

  it('returns 0 when no card matches the family', () => {
    expect(countCompatible(['SD 1.5', 'Flux.1 D'], ['SDXL 1.0'])).toBe(0);
  });
});
