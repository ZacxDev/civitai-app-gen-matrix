// An in-memory stand-in for the five REST families this app reaches after the
// port off the postMessage bridge: the workflow money path, this app's workflow
// read-model, per-viewer app storage, cross-user shared storage, and the gated
// image read. Used by the dev harness (`main.tsx`) and by the tests that used to
// seed those families through the mock host.
//
// 🔴 WHY THIS IS A `fetch` FAKE AND NOT A MOCK HOST, WHICH IS THE WHOLE POINT.
// Before the port, `useBuzzWorkflow`/`useAppWorkflows`/`useAppStorage`/
// `useSharedStorage`/`useGatedImages` were postMessage conversations and
// `@civitai/blocks-react/testing`'s mock host answered them. After it they are
// HTTP. A transport-level fake would therefore "answer a conversation nobody is
// having" — the suite would pass while exercising none of the code that now
// carries the traffic. The app's real boundary for these five is `fetch`, so the
// fake belongs there. Groups 1 and 2 (BLOCK_INIT, viewer, theme, token, consent,
// resize, sign-in, resource picker, Buzz purchase, publish) are STILL the bridge
// and are still the mock host's job — that is why both are installed together.
//
// 🔴 IT TAKES THE MOCK HOST'S OWN OPTION SHAPE, ON PURPOSE. `storage.seed`,
// `shared.seed`, `appWorkflows`, `generation.costPerGen`, `gatedImages`,
// `failNext` — same names, same meanings. Forty integration cases were written
// against those names; a fake with its own vocabulary would have made the port a
// rewrite of the suite rather than of the transport, and a rewritten assertion is
// one nobody can diff against what it used to claim.
//
// 🔴 WHAT IT IS NOT. It is not a second implementation of the platform's policy:
// no scope checks, no trust gates, no rate limits, no moderation, no spend caps.
// Those are the server's and they are NOT re-asserted here, because a fake that
// reimplemented them would drift and start certifying its own behaviour. What it
// does own is the ROUTE SHAPES — path, method, body, reply envelope — and those
// are taken from the route files under
// civitai `src/pages/api/v1/blocks/`, named per family below.

import type { AppWorkflow, BlockGatedImage, WorkflowBody } from '@civitai/app-sdk/blocks';

/** One seeded shared row. Mirrors the mock host's `MockSharedSeed`. */
export interface RestSharedSeed {
  value: { title: string; body?: string; data?: unknown };
  /** Defaults to the configured viewer, i.e. "the viewer wrote this". */
  authorUserId?: number;
  /** Viewer ids holding an up-vote. The row's `count` is this list's length. */
  voters?: number[];
  /**
   * Pin the row's key instead of taking the mint.
   *
   * 🔴 THIS EXISTS SO A TEST CAN SAY WHAT IT DEPENDS ON. The retired mock host
   * minted `shared_<n>`, and several cases here pair a storage-seeded publish
   * ledger (`entryKey: 'shared_1'`) with a shared seed whose key they never
   * named — an assertion against a fake's implementation detail. Pinning makes
   * the coupling visible at the seed instead of implicit in the mint.
   */
  key?: string;
}

export interface RestGenerationScenario {
  /** Buzz per generation. A function is called with the submitted body. */
  costPerGen?: number | ((body: WorkflowBody) => number);
  /** Image urls a succeeded workflow reports. */
  images?: string[] | ((body: WorkflowBody) => string[]);
  /** Fail the next N submits with the generic generation error. */
  failNext?: number;
  /** Refuse every submit as an insufficient-Buzz shortfall. */
  insufficient?: boolean;
  /** Polls before a workflow reports `succeeded`. Mirrors `pollsUntilDone`. */
  pollsUntilDone?: number;
}

export interface RestFakeOptions {
  /** The signed-in viewer's id — decides `viewerVoted` and default authorship. */
  viewer?: { id: number } | null;
  /** Per-viewer KV seed (key → JSON value). Mirrors `MockStorageScenario`. */
  storage?: { seed?: Record<string, unknown>; quotaBytes?: number; limitRows?: number; failNext?: number };
  /** Shared-store seed, listed newest-first in the order given. */
  shared?: { seed?: RestSharedSeed[]; failNext?: number };
  /** This app's workflow read-model, as `blocks/workflows/query` projects it. */
  appWorkflows?: { workflows: AppWorkflow[]; cursor?: string | null };
  /** Make `blocks/workflows/query` refuse. */
  appWorkflowsError?: boolean | string;
  /** The money path's simulated behaviour. */
  generation?: RestGenerationScenario;
  /** The per-viewer gated projection. Omit for {@link DEFAULT_GATED_IMAGES}. */
  gatedImages?: BlockGatedImage[];
  /** Make `blocks/gated-images` refuse. */
  gatedImagesError?: boolean | string;
  /**
   * Called for every request this fake answers. The observation seam a test needs
   * now that these five families are HTTP: a guard that used to watch an
   * `APP_STORAGE_SET` postMessage watches the `blocks/app-storage/set` call here.
   */
  onRequest?: (call: { path: string; method: string; body: Record<string, unknown> }) => void;
}

interface SharedRow {
  key: string;
  seq: number;
  authorUserId: number;
  value: { title: string; body?: string; data?: unknown };
  voters: Set<number>;
  createdAt: string;
  updatedAt: string;
}

/** A fixed instant, so nothing here reads a clock a test cannot control. */
const EPOCH = '2026-01-01T00:00:00.000Z';

/**
 * The gated projection reported when none is seeded.
 *
 * 🔴 COPIED FROM THE MOCK HOST ON PURPOSE (`@civitai/blocks-react`'s
 * `DEFAULT_GATED_IMAGES`), because this fake INHERITS the job of answering tests
 * that never seeded one — and one of them says so in a comment: *"The mock's
 * default projection: 9001 visible (with a url), 9002 hidden."* It deliberately
 * mixes a `visible` row with a `hidden` one so the placeholder path is exercised
 * out of the box.
 */
const DEFAULT_GATED_IMAGES: BlockGatedImage[] = [
  {
    imageId: 9001,
    status: 'visible',
    nsfwLevel: 1,
    contentRating: 'pg',
    url: 'https://image.civitai.com/mock/original=true/gated-9001.jpeg',
    width: 1024,
    height: 1024,
  },
  { imageId: 9002, status: 'hidden' },
] as unknown as BlockGatedImage[];

/** The mock host's own workflow read-model default. */
const DEFAULT_APP_WORKFLOWS: { workflows: AppWorkflow[]; cursor: string | null } = {
  workflows: [],
  cursor: null,
};

/** Mock-host error strings, reproduced VERBATIM — tests assert on them. */
const INSUFFICIENT_BUZZ_ERROR = 'Insufficient Buzz to run this generation.';
const GENERIC_GEN_ERROR = 'Generation failed (simulated).';
const DEFAULT_GATED_IMAGES_ERROR = 'gated images unavailable';
const DEFAULT_APP_WORKFLOWS_ERROR = 'app workflows unavailable';
/**
 * 🔴 THE SHARED-REFUSAL STRING IS LOAD-BEARING. `App.integration.test.tsx`
 * asserts `/SHARED_UNAVAILABLE/` on the gallery's action-error line, and the SDK
 * surfaces `ApiError.message` from the body's `error` key
 * (`@civitai/sdk` `dist/http/index.js` — `messageOf` reads `error` first). So the
 * word has to travel in `{ error }`, not in a status code.
 */
const SHARED_UNAVAILABLE = 'SHARED_UNAVAILABLE';
const STORAGE_UNAVAILABLE = 'STORAGE_UNAVAILABLE';

/** Default polls before a workflow succeeds. The mock host's own default. */
const DEFAULT_POLLS_UNTIL_DONE = 2;

/** Crockford base32, the ULID alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 26-character ULID-SHAPED key, derived from a counter.
 *
 * Not a real ULID — it is not time-ordered and carries no entropy — and it does
 * not pretend to be. What matters at this seam is that it looks nothing like an
 * index, so a test cannot accidentally hard-code `shared_2` and pass: the real
 * server GENERATES a ULID (`apps-shared.router.ts`), and a test pinned to a
 * fake's minting convention is asserting the fake rather than the platform. A
 * seed that needs a specific key says so via `RestSharedSeed.key`.
 */
function mintKey(n: number): string {
  let rest = n;
  const tail: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    tail.push(CROCKFORD[rest % 32] as string);
    rest = Math.floor(rest / 32) + 7;
  }
  return tail.reverse().join('');
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function messageOr(flag: boolean | string | undefined, fallback: string): string | undefined {
  if (flag === undefined || flag === false) return undefined;
  return typeof flag === 'string' && flag.length > 0 ? flag : fallback;
}

/**
 * 🔴 THE IDEMPOTENCY-KEY REGEX IS THE PLATFORM'S, NOT A LOOKALIKE.
 * `BLOCK_IDEMPOTENCY_KEY_REGEX` in civitai `src/server/utils/block-gen-idempotency.ts`
 * is `/^[A-Za-z0-9_-]{1,64}$/`, and `blocks/workflows/submit` declares
 * `idempotencyKey: z.string().regex(...)` — NOT `.optional()`. The bridge hook
 * minted the key for its caller, so `App.tsx` calls `submit(body)` with none and
 * `sdk-runtime.ts` has to mint one. Enforcing the shape HERE is what makes that
 * minting testable: a fake that accepted anything would let a missing or
 * malformed key ship and 400 on the real spend path.
 */
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build a `fetch` that answers the app's REST surface from memory.
 *
 * Anything it does not recognise gets a 404 carrying the method and path — LOUD
 * on purpose. A fake that answered `{}` to an unknown route would turn a wrong
 * path into a quietly empty screen, which is the failure this whole port is most
 * able to introduce.
 */
export function createRestFake(options: RestFakeOptions = {}): typeof globalThis.fetch {
  const viewerUserId = options.viewer?.id ?? 0;

  // ---- per-viewer KV -------------------------------------------------------
  const kv = new Map<string, { value: unknown; updatedAt: string }>(
    Object.entries(options.storage?.seed ?? {}).map(([k, v]) => [k, { value: v, updatedAt: EPOCH }]),
  );
  const quotaBytes = options.storage?.quotaBytes ?? 50 * 1024 * 1024;
  const limitRows = options.storage?.limitRows ?? 1_000_000;
  let storageFailNext = options.storage?.failNext ?? 0;

  // ---- shared store --------------------------------------------------------
  // Seeded newest-LAST so the last seed has the highest seq, which is the order
  // `list` documents (newest-first) — the mock host's own convention.
  let sharedSeq = 0;
  const rows = new Map<string, SharedRow>();
  for (const seed of options.shared?.seed ?? []) {
    sharedSeq += 1;
    const key = seed.key ?? mintKey(sharedSeq);
    rows.set(key, {
      key,
      seq: sharedSeq,
      authorUserId: seed.authorUserId ?? viewerUserId,
      value: seed.value,
      voters: new Set(seed.voters ?? []),
      createdAt: EPOCH,
      updatedAt: EPOCH,
    });
  }
  let sharedFailNext = options.shared?.failNext ?? 0;

  // ---- the money path -----------------------------------------------------
  const gen = options.generation ?? {};
  const pollsUntilDone = gen.pollsUntilDone ?? DEFAULT_POLLS_UNTIL_DONE;
  let genFailNext = gen.failNext ?? 0;
  let submitCount = 0;
  const workflows = new Map<string, { polls: number; cost: number; body: WorkflowBody }>();
  const costFor = (body: WorkflowBody): number =>
    typeof gen.costPerGen === 'function' ? gen.costPerGen(body) : (gen.costPerGen ?? 8);
  const imagesFor = (workflowId: string, body: WorkflowBody): string[] => {
    if (gen.images) return typeof gen.images === 'function' ? gen.images(body) : gen.images;
    return [`https://placehold.co/512x512/1971c2/ffffff/png?text=MOCK%0A${workflowId.slice(-4)}`];
  };

  let appWorkflows = options.appWorkflows ?? DEFAULT_APP_WORKFLOWS;

  const projectShared = (row: SharedRow) => ({
    key: row.key,
    authorUserId: row.authorUserId,
    value: row.value,
    count: row.voters.size,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    viewerVoted: row.voters.has(viewerUserId),
  });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://civitai.com');
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> =
      init?.body == null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    options.onRequest?.({ path, method, body });

    // --- the money path: POST blocks/workflows/* ----------------------------
    // Shapes from src/pages/api/v1/blocks/workflows/{estimate,submit,poll,cancel,query}.ts
    // 🔴 ALL FOUR OF estimate/submit/poll/cancel REPLY `{ snapshot }`, WRAPPED.
    // Verified in blocks.router.ts: `estimateCustomComfyWorkflow`,
    // `submitCustomComfyWorkflow`, `pollWorkflow` and `cancelWorkflow` each
    // return `{ snapshot }` and the routes `res.json(result)` it unchanged.
    // `query` is the one that does NOT — it replies `{ workflows, cursor }`.
    if (path.startsWith('blocks/workflows/')) {
      const op = path.slice('blocks/workflows/'.length);
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);

      if (op === 'estimate') {
        const wfBody = body.body as WorkflowBody;
        return json({
          snapshot: {
            workflowId: 'wf_estimate',
            status: 'pending',
            cost: { total: costFor(wfBody) },
          },
        });
      }

      if (op === 'submit') {
        // The route REFUSES a missing or malformed key before anything else does.
        if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(body.idempotencyKey)) {
          return json({ error: 'Invalid request body', details: { idempotencyKey: ['invalid'] } }, 400);
        }
        submitCount += 1;
        const wfBody = body.body as WorkflowBody;
        const cost = costFor(wfBody);

        // 🔴 A REFUSAL CARRYING A COST IS A *RESULT*, NOT A THROW, and that is
        // what routes the Top-Up CTA. The platform answers a budget shortfall
        // with a `failed` snapshot that DOES carry `cost.total`
        // (`submitCustomComfyWorkflow`: `{ workflowId: 'failed', status:
        // 'failed', cost: { total: ceiling }, error: 'insufficient buzz budget…' }`),
        // and `sdk-runtime.ts`'s submit only throws when a failed snapshot has NO
        // numeric cost. Dropping `cost` here would make the cell go generic-red
        // instead of offering the top-up.
        if (gen.insufficient === true) {
          return json({
            snapshot: {
              workflowId: 'failed',
              status: 'failed',
              cost: { total: cost },
              error: INSUFFICIENT_BUZZ_ERROR,
            },
          });
        }
        if (genFailNext > 0) {
          genFailNext -= 1;
          // NO cost — so this one DOES throw, as the bridge's submit did.
          return json({
            snapshot: { workflowId: 'failed', status: 'failed', error: GENERIC_GEN_ERROR },
          });
        }

        const workflowId = `wf_${submitCount}`;
        workflows.set(workflowId, { polls: 0, cost, body: wfBody });
        return json({ snapshot: { workflowId, status: 'pending' } });
      }

      if (op === 'poll') {
        const workflowId = String(body.workflowId ?? '');
        const wf = workflows.get(workflowId);
        const polls = (wf?.polls ?? 0) + 1;
        if (wf) wf.polls = polls;
        if (polls >= pollsUntilDone) {
          return json({
            snapshot: {
              workflowId,
              status: 'succeeded',
              cost: { total: wf?.cost ?? costFor({} as WorkflowBody) },
              imageUrls: imagesFor(workflowId, (wf?.body ?? {}) as WorkflowBody),
            },
          });
        }
        return json({ snapshot: { workflowId, status: 'processing' } });
      }

      if (op === 'cancel') {
        const workflowId = String(body.workflowId ?? '');
        workflows.delete(workflowId);
        return json({ snapshot: { workflowId, status: 'canceled' } });
      }

      if (op === 'query') {
        const failure = messageOr(options.appWorkflowsError, DEFAULT_APP_WORKFLOWS_ERROR);
        if (failure !== undefined) return json({ error: failure }, 503);
        return json({ workflows: appWorkflows.workflows, cursor: appWorkflows.cursor ?? null });
      }
    }

    // --- the gated read: GET blocks/gated-images?ids=1,2,3 ------------------
    // Shape from src/pages/api/v1/blocks/gated-images.ts → `{ images }`.
    // 🔴 NOT `blocks/images?ids=`: those two routes read COMPLEMENTARY corpora
    // (`postId IS NOT NULL` vs `postId IS NULL`), so the other one answers EMPTY
    // for every id this app published — see `useGatedImages` in sdk-runtime.ts.
    if (path === 'blocks/gated-images') {
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const failure = messageOr(options.gatedImagesError, DEFAULT_GATED_IMAGES_ERROR);
      if (failure !== undefined) return json({ error: failure }, 503);
      const asked = new Set(
        (url.searchParams.get('ids') ?? '')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n)),
      );
      const projection = options.gatedImages ?? DEFAULT_GATED_IMAGES;
      // 🔴 MISSES ARE REPORTED BY OMISSION, which the route documents as
      // deliberate non-disclosure — an id the viewer may not see and an id that
      // does not exist are both simply ABSENT. Filtering (rather than returning
      // the whole projection) is what lets the `gone`-cell case be real: the
      // app must not be able to distinguish the two, and must not assume the
      // reply is as long as the request or in the same order.
      return json({ images: projection.filter((img) => asked.has(img.imageId)) });
    }

    // --- per-viewer KV: POST blocks/app-storage/* ---------------------------
    // Shapes from src/pages/api/v1/blocks/app-storage/{get,set,delete,list,quota}.ts
    if (path.startsWith('blocks/app-storage/')) {
      const op = path.slice('blocks/app-storage/'.length);
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const key = String(body.key ?? '');

      if (op === 'get') return json({ value: kv.get(key)?.value ?? null });

      if (op === 'set') {
        if (storageFailNext > 0) {
          storageFailNext -= 1;
          return json({ error: STORAGE_UNAVAILABLE }, 503);
        }
        const size = bytesOf(body.value);
        let used = 0;
        for (const [k, row] of kv) used += bytesOf(row.value) + k.length;
        const existing = kv.get(key);
        const existingBytes = existing ? bytesOf(existing.value) + key.length : 0;
        if (used - existingBytes + size + key.length > quotaBytes) {
          return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
        }
        kv.set(key, { value: body.value, updatedAt: EPOCH });
        // `{ ok: true, sizeBytes }`, and `sizeBytes` is REQUIRED — the SDK's
        // storage client throws without it, and the route's docblock says there
        // is "no 2xx path that means not written".
        return json({ ok: true, sizeBytes: size });
      }

      if (op === 'delete') {
        if (storageFailNext > 0) {
          storageFailNext -= 1;
          return json({ error: STORAGE_UNAVAILABLE }, 503);
        }
        return json({ ok: true, deleted: kv.delete(key) });
      }

      if (op === 'list') {
        const prefix = body.prefix === undefined ? '' : String(body.prefix);
        const limit = typeof body.limit === 'number' ? body.limit : 50;
        const all = [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const after = typeof body.cursor === 'string' ? body.cursor : undefined;
        const start = after === undefined ? 0 : all.findIndex(([k]) => k > after);
        const page = (start < 0 ? [] : all.slice(start)).slice(0, limit);
        const last = page[page.length - 1]?.[0];
        const hasMore =
          last !== undefined && all.findIndex(([k]) => k === last) < all.length - 1;
        return json({
          keys: page.map(([k, row]) => ({ key: k, updatedAt: row.updatedAt })),
          // `nextCursor` sits at the TOP level here — one level SHALLOWER than
          // shared storage's `metadata.nextCursor`. Reading the wrong level
          // leaves pagination silently dead while every page still parses.
          ...(hasMore && last !== undefined ? { nextCursor: last } : {}),
        });
      }

      if (op === 'quota') {
        let usedBytes = 0;
        for (const [k, row] of kv) usedBytes += bytesOf(row.value) + k.length;
        return json({ usedBytes, rowCount: kv.size, limitBytes: quotaBytes, limitRows });
      }
    }

    // --- shared store: blocks/shared-storage/* ------------------------------
    // Shapes from src/pages/api/v1/blocks/shared-storage/*.ts. Reads are GET with
    // a query string, writes are POST with a body — the route table's own split;
    // a read sent as POST is a 405 on the real surface.
    if (path.startsWith('blocks/shared-storage/')) {
      const op = path.slice('blocks/shared-storage/'.length);
      // Newest-first, which is the order `list` documents.
      const ordered = [...rows.values()].sort((a, b) => b.seq - a.seq);

      // 🔴 `list` DOES NOT CONSUME `failNext`, AND THAT IS COPIED RATHER THAN
      // CHOSEN. The mock host's `SHARED_LIST` arm has no `sharedFailNext` check
      // while every other shared arm does (`internal/mockHost.js` — compare
      // `case 'SHARED_LIST'` with `case 'SHARED_GET'`). It matters because the
      // gallery LISTS on mount, before the viewer can act: a budget the list ate
      // would refuse the gallery read instead of the vote/append the case is
      // about, and the assertion would pass or fail for the wrong reason.
      if (op === 'list' && method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const rawLimit = url.searchParams.get('limit');
        const filtered = ordered.filter((r) => r.key.startsWith(prefix));
        const page = rawLimit === null ? filtered : filtered.slice(0, Number(rawLimit));
        const last = page[page.length - 1]?.key;
        const hasMore =
          last !== undefined && filtered.findIndex((r) => r.key === last) < filtered.length - 1;
        // 🔴 `nextCursor` LIVES UNDER `metadata` HERE — one level DEEPER than
        // `app-storage/list`'s. The SDK guards `metadata`'s presence as strictly
        // as `items`, so it is always sent, even when empty.
        return json({
          items: page.map(projectShared),
          metadata: hasMore && last !== undefined ? { nextCursor: last } : {},
        });
      }

      if (op === 'item' && method === 'GET') {
        if (sharedFailNext > 0) {
          sharedFailNext -= 1;
          return json({ error: SHARED_UNAVAILABLE }, 503);
        }
        const found = rows.get(url.searchParams.get('key') ?? '');
        return json({ item: found ? projectShared(found) : null });
      }

      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);

      if (sharedFailNext > 0) {
        sharedFailNext -= 1;
        return json({ error: SHARED_UNAVAILABLE }, 503);
      }

      const key = String(body.key ?? '');

      if (op === 'append') {
        const value = body.value as RestSharedSeed['value'] | undefined;
        if (!value || typeof value.title !== 'string' || value.title.length === 0) {
          return json({ error: 'INVALID_VALUE' }, 400);
        }
        sharedSeq += 1;
        // `append` accepts NO key: the server mints a ULID, so one viewer cannot
        // overwrite another's row.
        const minted = mintKey(sharedSeq);
        rows.set(minted, {
          key: minted,
          seq: sharedSeq,
          authorUserId: viewerUserId,
          value,
          voters: new Set(),
          createdAt: EPOCH,
          updatedAt: EPOCH,
        });
        return json({ key: minted });
      }

      if (op === 'update') {
        const row = rows.get(key);
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        // Author-scoped, as the real route is.
        if (row.authorUserId !== viewerUserId) return json({ error: 'FORBIDDEN' }, 403);
        const value = body.value as RestSharedSeed['value'] | undefined;
        if (!value || typeof value.title !== 'string' || value.title.length === 0) {
          return json({ error: 'INVALID_VALUE' }, 400);
        }
        row.value = value;
        return json({ ok: true });
      }

      if (op === 'withdraw') {
        return json({ ok: true, deleted: rows.delete(key) });
      }

      if (op === 'vote' || op === 'unvote') {
        const row = rows.get(key);
        // The real routes pre-check existence and answer 404 for a missing or
        // hidden row, so neither is an oracle for withdrawn rows.
        if (!row) return json({ error: 'request not found' }, 404);
        // 🔴 IDEMPOTENT, because the platform's is: a `Set` reproduces
        // `voteSharedRow`'s "atomic insert-gated counter — a double vote is a
        // no-op and the tally never inflates".
        if (op === 'vote') row.voters.add(viewerUserId);
        else row.voters.delete(viewerUserId);
        return json({ count: row.voters.size });
      }

      if (op === 'report') {
        if (!rows.has(key)) return json({ error: 'request not found' }, 404);
        return json({ ok: true });
      }
    }

    return json({ error: `dev-rest: no route for ${method} ${path}` }, 404);
  }) as typeof globalThis.fetch;
}

/**
 * Split `createMockHost`-shaped options into the half the MOCK HOST still owns
 * and the half this fake now answers.
 *
 * 🔴 THIS FUNCTION IS THE PORT'S SEAM, STATED AS DATA. Before the port one option
 * bag configured one fake; after it the bag spans two transports, and which key
 * belongs where is exactly the fact a reader needs and cannot infer from a call
 * site. Getting it wrong is silent in the worst direction: a group-3 key left on
 * the mock host is simply ignored (the host still HAS those handlers, nothing
 * reaches them any more), so the test would seed nothing and assert against an
 * empty store while looking correct.
 *
 * Group 1 + 2 — still the bridge, still the mock host's: `viewer`,
 * `consentGranted`, `consentGrantable`, `buzzBudget`, `publishImageIds`,
 * `publishError`, `cannedPicks`, `theme`, `context`, `domain`,
 * `maxBrowsingLevel`, `blockInstanceId`/`blockId`/`appId`.
 *
 * Group 3 — now HTTP, this fake's: `storage`, `shared`, `appWorkflows`,
 * `appWorkflowsError`, `generation`, `gatedImages`, `gatedImagesError`.
 *
 * `viewer` is the one key BOTH need: the host injects the identity and this fake
 * derives `viewerVoted` and default row authorship from the same id.
 */
const REST_OWNED_KEYS = [
  'storage',
  'shared',
  'appWorkflows',
  'appWorkflowsError',
  'generation',
  'gatedImages',
  'gatedImagesError',
] as const;

export function splitRestOptions(all: Record<string, unknown>): {
  host: Record<string, unknown>;
  rest: RestFakeOptions;
} {
  const host: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if ((REST_OWNED_KEYS as readonly string[]).includes(k)) rest[k] = v;
    else host[k] = v;
  }
  // Both sides need the viewer id.
  if ('viewer' in all) rest.viewer = all.viewer;
  return { host, rest: rest as RestFakeOptions };
}
