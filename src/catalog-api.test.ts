import { describe, expect, it, vi } from 'vitest';

import {
  CATALOG_API_BASE,
  CATALOG_API_BASE_BLOCKS,
  DEFAULT_LIMIT,
  THUMB_WIDTH,
  buildCatalogUrl,
  cardToCheckpoint,
  cardToLoraModifier,
  cardToPicked,
  edgeThumb,
  fetchCatalog,
  modelToCard,
  responseToPage,
  type CatalogCard,
  type FetchLike,
} from './catalog-api.js';

// A small helper to build a fake fetch returning a given body / status.
function fakeFetch(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwNetwork?: boolean;
  throwJson?: boolean;
}): FetchLike {
  return async () => {
    if (opts.throwNetwork) throw new Error('boom');
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.throwJson) throw new Error('bad json');
        return opts.body;
      },
    };
  };
}

/**
 * A spy fetch that records every (url, init) call and returns a programmable
 * sequence of responses (one per call, last repeats). Lets a test assert the
 * authoritative path's URL + Bearer header AND the fallback's public URL.
 */
function spyFetch(
  responses: Array<{ ok?: boolean; status?: number; body?: unknown }>,
): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: { headers?: Record<string, string> } }>;
} {
  const calls: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? { items: [] },
    };
  };
  return { fetch, calls };
}

const oneItemBody = { items: [{ id: 1, name: 'X', modelVersions: [{ id: 2, baseModel: 'Pony' }] }] };

describe('buildCatalogUrl', () => {
  it('sets types + default limit, omits empty query/baseModels', () => {
    const url = buildCatalogUrl({ type: 'Checkpoint' });
    expect(url.startsWith(`${CATALOG_API_BASE}?`)).toBe(true);
    expect(url).toContain('types=Checkpoint');
    expect(url).toContain(`limit=${DEFAULT_LIMIT}`);
    expect(url).not.toContain('query=');
    expect(url).not.toContain('baseModels=');
  });

  it('includes trimmed query when present', () => {
    const url = buildCatalogUrl({ type: 'LORA', query: '  anime  ' });
    expect(url).toContain('query=anime');
  });

  it('appends baseModels as a repeatable param', () => {
    const url = buildCatalogUrl({ type: 'LORA', baseModels: ['SDXL 1.0', 'Pony'] });
    const count = (url.match(/baseModels=/g) ?? []).length;
    expect(count).toBe(2);
    expect(url).toContain('baseModels=SDXL+1.0');
    expect(url).toContain('baseModels=Pony');
  });

  it('skips blank baseModel entries', () => {
    const url = buildCatalogUrl({ type: 'LORA', baseModels: ['', '  ', 'Pony'] });
    expect((url.match(/baseModels=/g) ?? []).length).toBe(1);
  });

  it('clamps limit to [1,100] and floors fractions', () => {
    expect(buildCatalogUrl({ type: 'LORA', limit: 999 })).toContain('limit=100');
    expect(buildCatalogUrl({ type: 'LORA', limit: 0 })).toContain('limit=1');
    expect(buildCatalogUrl({ type: 'LORA', limit: 24.9 })).toContain('limit=24');
    expect(buildCatalogUrl({ type: 'LORA', limit: NaN })).toContain(`limit=${DEFAULT_LIMIT}`);
  });

  it('includes sort + cursor when set', () => {
    const url = buildCatalogUrl({ type: 'LORA', sort: 'Most Downloaded', cursor: 'abc' });
    expect(url).toContain('sort=Most+Downloaded');
    expect(url).toContain('cursor=abc');
  });

  it('honors an overridden base', () => {
    expect(buildCatalogUrl({ type: 'LORA' }, 'https://x.test/models')).toContain('https://x.test/models?');
  });
});

describe('edgeThumb', () => {
  // The cache-aligned target = the civitai web app's resource-picker thumbnail:
  // `width=450,optimized=true` (IMAGE_CARD_WIDTH=450 + shouldOptimize), emitted
  // as a single comma-joined transform segment. See THUMB_WIDTH docs.
  const SEG = `width=${THUMB_WIDTH},optimized=true`;

  it('uses 450 as the default thumb width (matches the app picker)', () => {
    expect(THUMB_WIDTH).toBe(450);
  });

  it('replaces an `original=true` segment (what the REST API returns) with the small optimized variant', () => {
    const apiUrl = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/uuid/original=true/5706937.jpeg';
    const out = edgeThumb(apiUrl);
    expect(out).toBe(`https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/uuid/${SEG}/5706937.jpeg`);
    // The original-size segment is gone (the bug being fixed).
    expect(out).not.toContain('original=true');
    expect(out).toContain('optimized=true');
  });

  it('replaces an existing width= transform segment', () => {
    expect(edgeThumb('https://image.civitai.com/abc/uuid/width=1024/file.jpeg')).toContain(`/${SEG}/`);
  });

  it('replaces a comma-joined width=NNN,... transform segment', () => {
    const out = edgeThumb('https://image.civitai.com/abc/uuid/width=1024,quality=90/file.jpeg');
    expect(out).toBe(`https://image.civitai.com/abc/uuid/${SEG}/file.jpeg`);
  });

  it('honors an explicit width override', () => {
    expect(edgeThumb('https://image.civitai.com/abc/uuid/original=true/f.jpeg', 320)).toContain(
      '/width=320,optimized=true/',
    );
  });

  it('injects the transform segment before the filename when there is none', () => {
    const out = edgeThumb('https://image.civitai.com/xyz/uuid/file.jpeg', 200);
    expect(out).toBe('https://image.civitai.com/xyz/uuid/width=200,optimized=true/file.jpeg');
  });

  it('leaves unknown (non-civitai) URL formats unchanged', () => {
    const other = 'https://example.com/no-transform.png';
    expect(edgeThumb(other)).toBe(other);
  });

  it('is total on weird input', () => {
    expect(edgeThumb('')).toBe('');
    // @ts-expect-error testing runtime robustness
    expect(edgeThumb(undefined)).toBe(undefined);
  });
});

describe('modelToCard', () => {
  const goodModel = {
    id: 101055,
    name: 'SD XL',
    type: 'Checkpoint',
    nsfw: false,
    modelVersions: [
      {
        id: 128078,
        name: 'v1.0 VAE',
        baseModel: 'SDXL 1.0',
        images: [{ url: 'https://image.civitai.com/a/u/file.jpeg', nsfwLevel: 1 }],
      },
    ],
  };

  it('maps a healthy model to a card with a shrunk thumbnail', () => {
    const card = modelToCard(goodModel);
    expect(card).not.toBeNull();
    expect(card!.modelId).toBe(101055);
    expect(card!.versionId).toBe(128078);
    expect(card!.modelName).toBe('SD XL');
    expect(card!.versionName).toBe('v1.0 VAE');
    expect(card!.baseModel).toBe('SDXL 1.0');
    expect(card!.thumbnailUrl).toContain(`/width=${THUMB_WIDTH},optimized=true/`);
    expect(card!.nsfw).toBe(false);
  });

  it('returns null when there is no usable version id', () => {
    expect(modelToCard({ id: 1, modelVersions: [] })).toBeNull();
    expect(modelToCard({ id: 1, modelVersions: [{ baseModel: 'SDXL 1.0' }] })).toBeNull();
    expect(modelToCard(null)).toBeNull();
    expect(modelToCard(undefined)).toBeNull();
  });

  it('tolerates missing name / images (no throw, sensible fallbacks)', () => {
    const card = modelToCard({ id: 5, modelVersions: [{ id: 99 }] });
    expect(card).not.toBeNull();
    expect(card!.thumbnailUrl).toBeNull();
    expect(card!.modelName).toBe('Model #5');
    expect(card!.baseModel).toBe('');
  });

  it('shrinks a real REST `original=true` image URL to the cached small variant', () => {
    const card = modelToCard({
      id: 1,
      name: 'x',
      modelVersions: [
        {
          id: 2,
          images: [
            { url: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/uuid/original=true/123.jpeg' },
          ],
        },
      ],
    });
    expect(card!.thumbnailUrl).toContain(`width=${THUMB_WIDTH},optimized=true`);
    expect(card!.thumbnailUrl).not.toContain('original=true');
  });

  it('picks the first image that actually has a url', () => {
    const card = modelToCard({
      id: 1,
      name: 'x',
      modelVersions: [{ id: 2, images: [{ nsfwLevel: 1 }, { url: 'https://image.civitai.com/a/u/f.png' }] }],
    });
    expect(card!.thumbnailUrl).toContain('width=');
  });
});

describe('responseToPage', () => {
  it('maps items + nextCursor, dropping unusable rows', () => {
    const page = responseToPage({
      items: [
        { id: 1, name: 'A', modelVersions: [{ id: 10, baseModel: 'SDXL 1.0' }] },
        { id: 2, name: 'B', modelVersions: [] }, // dropped
      ],
      metadata: { nextCursor: 'next' },
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].versionId).toBe(10);
    expect(page.nextCursor).toBe('next');
  });

  it('returns empty page on missing / malformed body', () => {
    expect(responseToPage(null).cards).toEqual([]);
    expect(responseToPage({}).cards).toEqual([]);
    expect(responseToPage({ items: 'nope' as unknown as [] }).cards).toEqual([]);
  });

  it('normalizes a null / empty nextCursor to null', () => {
    expect(responseToPage({ items: [], metadata: { nextCursor: null } }).nextCursor).toBeNull();
    expect(responseToPage({ items: [], metadata: { nextCursor: '' } }).nextCursor).toBeNull();
  });
});

describe('card → axis member mappers', () => {
  const card: CatalogCard = {
    modelId: 257749,
    versionId: 290640,
    modelName: 'Pony',
    versionName: 'V6 XL',
    baseModel: 'Pony',
    modelType: 'Checkpoint',
    thumbnailUrl: null,
    nsfw: false,
  };

  it('cardToPicked carries the PickedResource fields', () => {
    expect(cardToPicked(card)).toEqual({
      versionId: 290640,
      modelId: 257749,
      modelName: 'Pony',
      versionName: 'V6 XL',
      baseModel: 'Pony',
      modelType: 'Checkpoint',
    });
  });

  it('cardToCheckpoint yields a CheckpointOption with the right ids + label', () => {
    const ck = cardToCheckpoint(card);
    expect(ck.versionId).toBe(290640);
    expect(ck.modelId).toBe(257749);
    expect(ck.baseModel).toBe('Pony');
    expect(ck.label).toContain('Pony');
  });

  it('cardToLoraModifier yields a deduping LoRA modifier keyed on versionId', () => {
    const mod = cardToLoraModifier({ ...card, modelType: 'LORA' });
    expect(mod.loraVersionId).toBe(290640);
    expect(mod.key).toBe('lora-picked-290640');
    expect(mod.baseModelFamily).toBe('Pony');
  });
});

describe('fetchCatalog (mocked fetch)', () => {
  const q = { type: 'LORA' as const, query: 'anime' };

  it('returns ok with a page on a healthy response', async () => {
    const res = await fetchCatalog(q, {
      fetch: fakeFetch({
        body: { items: [{ id: 1, name: 'X', modelVersions: [{ id: 2, baseModel: 'Pony' }] }] },
      }),
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.page.cards).toHaveLength(1);
  });

  it('returns empty when the request succeeds but yields no cards', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ body: { items: [] } }) });
    expect(res.kind).toBe('empty');
  });

  it('returns error on a non-OK status', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ ok: false, status: 503 }) });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.status).toBe(503);
  });

  it('returns error on a network throw', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ throwNetwork: true }) });
    expect(res.kind).toBe('error');
  });

  it('returns error on malformed JSON', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ throwJson: true }) });
    expect(res.kind).toBe('error');
  });

  it('handles a malformed (non-array items) payload as empty, not a throw', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ body: { items: { bad: true } } }) });
    expect(res.kind).toBe('empty');
  });

  it('passes the built URL (with baseModels) to fetch', async () => {
    let seen = '';
    const spy: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    await fetchCatalog({ type: 'LORA', baseModels: ['SDXL 1.0'] }, { fetch: spy });
    expect(seen).toContain('baseModels=SDXL+1.0');
    expect(seen).toContain('types=LORA');
  });

  it('flags an anon (no-token) ok result as non-authoritative', async () => {
    const res = await fetchCatalog(q, { fetch: fakeFetch({ body: oneItemBody }) });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.authoritative).toBe(false);
  });
});

describe('buildCatalogUrl — sfwOnly + authoritative base', () => {
  it('appends nsfw=false when sfwOnly is set (public path)', () => {
    const url = buildCatalogUrl({ type: 'Checkpoint' }, { base: CATALOG_API_BASE, sfwOnly: true });
    expect(url).toContain('nsfw=false');
  });

  it('omits nsfw entirely by default (authoritative path)', () => {
    const url = buildCatalogUrl({ type: 'Checkpoint' }, { base: CATALOG_API_BASE_BLOCKS });
    expect(url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)).toBe(true);
    expect(url).not.toContain('nsfw=');
    expect(url).not.toContain('browsingLevel');
  });

  it('still accepts a bare base string (back-compat)', () => {
    expect(buildCatalogUrl({ type: 'LORA' }, 'https://x.test/m')).toContain('https://x.test/m?');
  });
});

describe('fetchCatalog — token-aware path selection + graceful fallback', () => {
  const q = { type: 'LORA' as const, query: 'anime' };

  it('token present → calls /blocks/models with a Bearer header and NO maturity params', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    const res = await fetchCatalog(q, { fetch, auth: { token: 'JWT123' } });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.authoritative).toBe(true);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)).toBe(true);
    expect(url).toContain('query=anime');
    expect(url).toContain('types=LORA');
    // Server clamps maturity — client must NOT send these.
    expect(url).not.toContain('nsfw=');
    expect(url).not.toContain('browsingLevel');
    expect(init?.headers?.Authorization).toBe('Bearer JWT123');
  });

  it('anon (no token) → calls the public /api/v1/models with nsfw=false, no auth header', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    const res = await fetchCatalog(q, { fetch });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.authoritative).toBe(false);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url.startsWith(`${CATALOG_API_BASE}?`)).toBe(true);
    expect(url).toContain('nsfw=false');
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  it.each([404, 401, 403])(
    'token present + authoritative %i → falls back to public /api/v1/models?nsfw=false',
    async (status) => {
      // First call (authoritative) returns the fallback status; second (public) ok.
      const { fetch, calls } = spyFetch([{ ok: false, status }, { body: oneItemBody }]);
      const onFallback = vi.fn();
      const res = await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, onFallback });

      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') expect(res.authoritative).toBe(false); // came from public

      expect(calls).toHaveLength(2);
      // 1st = authoritative w/ Bearer.
      expect(calls[0].url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)).toBe(true);
      expect(calls[0].init?.headers?.Authorization).toBe('Bearer JWT');
      // 2nd = public w/ nsfw=false, no auth.
      expect(calls[1].url.startsWith(`${CATALOG_API_BASE}?`)).toBe(true);
      expect(calls[1].url).toContain('nsfw=false');
      expect(calls[1].init?.headers?.Authorization).toBeUndefined();
      expect(onFallback).toHaveBeenCalledWith({ status });
    },
  );

  it('token present + a NON-fallback non-OK (503) → hard error, no fallback', async () => {
    const { fetch, calls } = spyFetch([{ ok: false, status: 503 }]);
    const onFallback = vi.fn();
    const res = await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, onFallback });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.status).toBe(503);
    expect(calls).toHaveLength(1); // did NOT fall back
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('response parsing is identical across the authoritative and public paths', async () => {
    const authRes = await fetchCatalog(q, {
      fetch: fakeFetch({ body: oneItemBody }),
      auth: { token: 'JWT' },
    });
    const pubRes = await fetchCatalog(q, { fetch: fakeFetch({ body: oneItemBody }) });
    expect(authRes.kind).toBe('ok');
    expect(pubRes.kind).toBe('ok');
    if (authRes.kind === 'ok' && pubRes.kind === 'ok') {
      expect(authRes.page.cards).toEqual(pubRes.page.cards);
    }
  });

  it('empty body on the authoritative path → empty result flagged authoritative', async () => {
    const res = await fetchCatalog(q, {
      fetch: fakeFetch({ body: { items: [] } }),
      auth: { token: 'JWT' },
    });
    expect(res.kind).toBe('empty');
    if (res.kind === 'empty') expect(res.authoritative).toBe(true);
  });

  it('THROW (CORS/network) on the authoritative path → falls back to public /api/v1/models?nsfw=false, onFallback({reason:network})', async () => {
    // First call (authoritative) THROWS; second call (public) succeeds. The spy
    // throws only for the authoritative URL so the public fallback returns ok.
    const calls: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)) throw new Error('CORS preflight failed');
      return { ok: true, status: 200, json: async () => oneItemBody };
    };
    const onFallback = vi.fn();
    const res = await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, onFallback });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.authoritative).toBe(false); // came from public

    expect(calls).toHaveLength(2);
    // 1st = authoritative w/ Bearer (the one that threw).
    expect(calls[0].url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)).toBe(true);
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer JWT');
    // 2nd = public w/ nsfw=false, no auth — the graceful fallback.
    expect(calls[1].url.startsWith(`${CATALOG_API_BASE}?`)).toBe(true);
    expect(calls[1].url).toContain('nsfw=false');
    expect(calls[1].init?.headers?.Authorization).toBeUndefined();
    // Debug hook fired with the network reason (distinct from a {status} fallback).
    expect(onFallback).toHaveBeenCalledWith({ reason: 'network' });
  });

  it('THROW on the authoritative path then a THROW on the public fallback → hard error (no infinite loop)', async () => {
    // Both URLs throw → the public fallback is itself a genuine error.
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      throw new Error('everything is down');
    };
    const onFallback = vi.fn();
    const res = await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, onFallback });
    expect(res.kind).toBe('error');
    expect(onFallback).toHaveBeenCalledWith({ reason: 'network' });
    // Authoritative attempt + ONE public fallback attempt — no further retries.
    expect(calls).toHaveLength(2);
  });

  it('honors overridden bases for both paths', async () => {
    const { fetch, calls } = spyFetch([{ ok: false, status: 404 }, { body: oneItemBody }]);
    await fetchCatalog(q, {
      fetch,
      auth: { token: 'JWT' },
      blocksBase: 'https://b.test/blocks',
      publicBase: 'https://p.test/pub',
    });
    expect(calls[0].url.startsWith('https://b.test/blocks?')).toBe(true);
    expect(calls[1].url.startsWith('https://p.test/pub?')).toBe(true);
  });
});

describe('fetchCatalog — anon advisory SFW from the domain ceiling (useDomainMaturity)', () => {
  const q = { type: 'Checkpoint' as const };

  it('anon, anonSfwOnly omitted → fail-closed SFW (nsfw=false appended)', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    await fetchCatalog(q, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('nsfw=false');
  });

  it('anon, anonSfwOnly=true (isSfw=true green/blue) → SFW (nsfw=false appended)', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    await fetchCatalog(q, { fetch, anonSfwOnly: true });
    expect(calls[0].url).toContain('nsfw=false');
  });

  it('anon, anonSfwOnly=false (mature/red domain, isSfw=false) → nsfw NOT forced', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    await fetchCatalog(q, { fetch, anonSfwOnly: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('nsfw=');
  });

  it('anonSfwOnly is IGNORED on the authoritative (token) path — server clamps, no nsfw sent', async () => {
    const { fetch, calls } = spyFetch([{ body: oneItemBody }]);
    // Even with anonSfwOnly:false, the token path must never send nsfw/browsingLevel.
    await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, anonSfwOnly: false });
    expect(calls[0].url.startsWith(`${CATALOG_API_BASE_BLOCKS}?`)).toBe(true);
    expect(calls[0].url).not.toContain('nsfw=');
    expect(calls[0].url).not.toContain('browsingLevel');
  });

  it('post-fallback (404) advisory read stays SFW even when anonSfwOnly=false', async () => {
    // A red-domain block relaxes the ANON read, but the deploy-order fallback
    // (server-clamp unavailable) must fail-closed SFW.
    const { fetch, calls } = spyFetch([{ ok: false, status: 404 }, { body: oneItemBody }]);
    await fetchCatalog(q, { fetch, auth: { token: 'JWT' }, anonSfwOnly: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('nsfw=false');
  });
});
