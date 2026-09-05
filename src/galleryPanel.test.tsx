import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GalleryPanel, type GalleryImages, type GalleryPanelProps } from './GalleryPanel.js';
import { PublishMatrixPanel } from './PublishMatrixPanel.js';
import {
  GALLERY_DATA_VERSION,
  indexGatedImages,
  type GalleryEntry,
  type GalleryLoad,
} from './gallery.js';
import { CHECKPOINTS, MODIFIERS } from './models.js';
import { palette } from './theme.js';

const c = palette();
const gate = { isLevelAllowed: (l: number) => l <= 1, isSfw: true };

function entry(over: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    // 🔴 91 ≠ the fixture viewer's 42, so the DEFAULT row in every test below is
    // somebody else's. The dangerous default is the one that reads as the app's.
    key: 'k_a',
    authorUserId: 91,
    title: 'Lighthouse study',
    body: 'Prompt: a lighthouse at dusk',
    count: 4,
    viewerVoted: false,
    updatedAt: new Date(1_700_000_000_000),
    data: {
      v: GALLERY_DATA_VERSION,
      rows: [{ row: 0, versionId: CHECKPOINTS[0].versionId }],
      cols: [
        { col: 0, key: MODIFIERS[0].key, loraVersionId: null },
        { col: 1, key: MODIFIERS[1].key, loraVersionId: null },
      ],
      images: [
        { imageId: 811, row: 0, col: 0 },
        { imageId: 812, row: 0, col: 1 },
      ],
    },
    ...over,
  };
}

function props(over: Partial<GalleryPanelProps> = {}): GalleryPanelProps {
  return {
    c,
    load: { kind: 'ok', entries: [entry()], truncated: false },
    images: {
      kind: 'ok',
      byId: indexGatedImages([
        { imageId: 811, status: 'visible', url: 'https://img/811', nsfwLevel: 1 },
        { imageId: 812, status: 'visible', url: 'https://img/812', nsfwLevel: 1 },
      ]),
    },
    maturityGate: gate,
    signedIn: true,
    viewerUserId: 42,
    ownKeys: new Set(),
    reportedKeys: new Set(),
    busyKeys: new Set(),
    actionErrors: new Map(),
    onToggleVote: vi.fn(),
    onReport: vi.fn(async () => {}),
    onWithdraw: vi.fn(),
    ...over,
  };
}

describe('GalleryPanel — the three load states are three different claims', () => {
  it('says it is loading before the read resolves, and claims nothing about contents', () => {
    render(<GalleryPanel {...props({ load: null, images: null })} />);
    expect(screen.getByTestId('gm-gallery-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-empty')).toBeNull();
    expect(screen.queryByTestId('gm-gallery-error')).toBeNull();
  });

  it('🔴 renders a FAILED read differently from an empty gallery', () => {
    // Until a version carrying `apps:storage:shared:read` is APPROVED, the read
    // fails for every viewer. Rendering that as "nothing published yet" would
    // state a claim about the gallery's contents this app cannot see.
    render(<GalleryPanel {...props({ load: { kind: 'error' }, images: null })} />);
    const err = screen.getByTestId('gm-gallery-error');
    expect(err.textContent).not.toMatch(/no matrices have been published/i);
    expect(err.textContent).toMatch(/couldn’t load the gallery/i);
    expect(screen.queryByTestId('gm-gallery-empty')).toBeNull();
    expect(screen.queryByTestId('gm-gallery-list')).toBeNull();
  });

  it('renders an honest empty state when the gallery really is empty', () => {
    const load: GalleryLoad = { kind: 'ok', entries: [], truncated: false };
    render(<GalleryPanel {...props({ load })} />);
    expect(screen.getByTestId('gm-gallery-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-error')).toBeNull();
  });
});

describe('GalleryPanel — an entry', () => {
  it('renders the moderated title and body, and derives every other label from ids', () => {
    render(<GalleryPanel {...props()} />);
    expect(screen.getByTestId('gm-gallery-title')).toHaveTextContent('Lighthouse study');
    expect(screen.getByTestId('gm-gallery-body')).toHaveTextContent('a lighthouse at dusk');
    // The row/column labels resolve through the app's OWN curated tables.
    expect(screen.getByTestId('gm-gallery-resources')).toHaveTextContent(CHECKPOINTS[0].label);
    expect(screen.getByTestId('gm-gallery-resources')).toHaveTextContent(MODIFIERS[0].label);
  });

  it('never paints a string that came out of the unmoderated data blob', () => {
    const hostile = entry({
      data: {
        ...entry().data,
        cols: [
          { col: 0, key: 'CLAIM YOUR FREE BUZZ', loraVersionId: null },
          { col: 1, key: 'ALSO NOT A LABEL', loraVersionId: null },
        ],
      },
    });
    render(<GalleryPanel {...props({ load: { kind: 'ok', entries: [hostile], truncated: false } })} />);
    expect(
      screen.getByTestId('gm-gallery').textContent,
      'the modifier key is a LOOKUP token from a client-written blob — an unknown one must fall back to a derived label, never reach the screen',
    ).not.toMatch(/FREE BUZZ|NOT A LABEL/);
    expect(screen.getByTestId('gm-gallery-grid')).toHaveTextContent('Style 1');
  });

  it('shows a hidden image as a placeholder carrying no url', () => {
    render(
      <GalleryPanel
        {...props({
          images: {
            kind: 'ok',
            byId: indexGatedImages([
              { imageId: 811, status: 'visible', url: 'https://img/811', nsfwLevel: 1 },
              { imageId: 812, status: 'hidden' },
            ]),
          } satisfies GalleryImages,
        })}
      />,
    );
    expect(screen.getByTestId('gm-gallery-cell-hidden')).toHaveTextContent(
      /hidden by your browsing settings/i,
    );
    expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(1);
  });

  it('marks an id the host omitted as gone, in its own cell', () => {
    render(
      <GalleryPanel
        {...props({
          images: {
            kind: 'ok',
            byId: indexGatedImages([
              { imageId: 812, status: 'visible', url: 'https://img/812', nsfwLevel: 1 },
            ]),
          },
        })}
      />,
    );
    expect(screen.getByTestId('gm-gallery-cell-gone')).toHaveTextContent(/no longer available/i);
    // The surviving image still renders — one missing id does not blank the grid.
    expect(screen.getAllByTestId('gm-maturity-image')).toHaveLength(1);
  });

  it('🔴 an entry whose images have ALL gone says so instead of drawing an empty grid', () => {
    render(<GalleryPanel {...props({ images: { kind: 'ok', byId: indexGatedImages([]) } })} />);
    // `queryByTestId`, not `getByTestId`: a `get*` that finds nothing throws
    // Testing Library's own error, which carries none of this message — so the
    // test would go red without ever naming the thing it is guarding.
    expect(
      screen.queryByTestId('gm-gallery-all-gone'),
      'an empty grid is what a LOADING grid looks like — a matrix whose images have all gone must say so rather than render the same as a grid still loading',
    ).not.toBeNull();
    expect(screen.getByTestId('gm-gallery-all-gone')).toHaveTextContent(/no longer available/i);
    expect(screen.queryByTestId('gm-gallery-grid')).toBeNull();
  });

  it('distinguishes an images read that FAILED from images that are gone', () => {
    render(<GalleryPanel {...props({ images: { kind: 'error' } })} />);
    expect(screen.getByTestId('gm-gallery-images-error')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-all-gone')).toBeNull();
    expect(screen.queryByTestId('gm-gallery-grid')).toBeNull();
  });
});

describe('GalleryPanel — vote', () => {
  it('hydrates the button from viewerVoted rather than guessing', () => {
    const { unmount } = render(<GalleryPanel {...props()} />);
    expect(screen.getByTestId('gm-gallery-vote')).toHaveAttribute('aria-pressed', 'false');
    unmount();

    render(
      <GalleryPanel
        {...props({
          load: { kind: 'ok', entries: [entry({ viewerVoted: true, count: 9 })], truncated: false },
        })}
      />,
    );
    const voted = screen.getByTestId('gm-gallery-vote');
    expect(
      voted,
      'the host resolves viewerVoted per viewer — assuming "not voted" on load is what makes the first click a no-op and forces a second one to unvote',
    ).toHaveAttribute('aria-pressed', 'true');
    expect(voted).toHaveTextContent('9');
    expect(voted).toHaveAccessibleName(/remove your vote/i);
  });

  it('is disabled for an anonymous viewer rather than offering an error', () => {
    render(<GalleryPanel {...props({ signedIn: false })} />);
    expect(screen.getByTestId('gm-gallery-vote')).toBeDisabled();
  });

  it('hands the whole entry to the toggle so the caller knows which way to go', async () => {
    const onToggleVote = vi.fn();
    render(<GalleryPanel {...props({ onToggleVote })} />);
    await userEvent.click(screen.getByTestId('gm-gallery-vote'));
    expect(onToggleVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k_a', viewerVoted: false }));
  });
});

describe('GalleryPanel — report and withdraw', () => {
  it('offers the SHARED ReportButton on someone else’s entry, to a signed-in viewer', async () => {
    const onReport = vi.fn(async () => {});
    render(<GalleryPanel {...props({ onReport })} />);
    await userEvent.click(screen.getByTestId('gm-gallery-k_a-report'));
    // The shared component's own two-step handshake, not a local re-implementation.
    await userEvent.click(await screen.findByTestId('gm-gallery-k_a-report-confirm'));
    await waitFor(() => expect(onReport).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('gm-gallery-k_a-report-done')).toHaveTextContent(
      /reported for review/i,
    );
  });

  it('settles the report control from the viewer’s own recorded reports', () => {
    render(<GalleryPanel {...props({ reportedKeys: new Set(['k_a']) })} />);
    expect(screen.getByTestId('gm-gallery-k_a-report-done')).toBeInTheDocument();
    expect(screen.queryByTestId('gm-gallery-k_a-report')).toBeNull();
  });

  it('does not offer Report to an anonymous viewer — report() rejects for them', () => {
    render(<GalleryPanel {...props({ signedIn: false })} />);
    expect(screen.queryByTestId('gm-gallery-k_a-report')).toBeNull();
  });

  it('🔴 offers Remove — not Report — on the viewer’s OWN entry', () => {
    render(<GalleryPanel {...props({ ownKeys: new Set(['k_a']) })} />);
    expect(screen.getByTestId('gm-gallery-withdraw')).toBeInTheDocument();
    expect(
      screen.queryByTestId('gm-gallery-k_a-report'),
      'withdraw is author-scoped server-side and report is documented for a viewer who does NOT own the row — offering the wrong one is offering an error',
    ).toBeNull();
  });

  it('does not offer Remove on an entry the viewer did not publish', () => {
    render(<GalleryPanel {...props()} />);
    expect(screen.queryByTestId('gm-gallery-withdraw')).toBeNull();
  });

  it('confirms before withdrawing, and says the images stay public', async () => {
    const onWithdraw = vi.fn();
    render(<GalleryPanel {...props({ ownKeys: new Set(['k_a']), onWithdraw })} />);
    await userEvent.click(screen.getByTestId('gm-gallery-withdraw'));
    expect(screen.getByTestId('gm-gallery-withdraw-prompt')).toHaveTextContent(
      /images stay public/i,
    );
    expect(onWithdraw).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('gm-gallery-withdraw-confirm'));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed vote/withdraw as an alert on that entry', () => {
    render(
      <GalleryPanel
        {...props({ actionErrors: new Map([['k_a', 'FORBIDDEN: apps:storage:shared:write']]) })}
      />,
    );
    expect(screen.getByTestId('gm-gallery-action-error')).toHaveTextContent(/FORBIDDEN/);
    expect(screen.getByTestId('gm-gallery-action-error')).toHaveAttribute('role', 'alert');
  });
});

describe('PublishMatrixPanel', () => {
  const publishProps = {
    c,
    publishable: 4,
    title: 'Lighthouse study',
    setTitle: vi.fn(),
    phase: { kind: 'idle' } as const,
    message: null,
    messageIsProblem: false,
    signedIn: true,
    alreadyPublished: false,
    alreadyPublishedCount: 0,
    onPublish: vi.fn(),
  };

  it('🔴 says publishing creates real public images, and that it cannot be undone', () => {
    render(<PublishMatrixPanel {...publishProps} />);
    const copy = screen.getByTestId('gm-publish-explainer').textContent ?? '';
    expect(
      copy,
      'publishing is a bigger act than saving — the viewer must be able to tell from the screen that real, public Civitai images are created',
    ).toMatch(/real, public/i);
    expect(copy).toMatch(/cannot be removed/i);
    expect(copy).toMatch(/confirm each image/i);
  });

  it('🔴 discloses the app-developer cohort gate BEFORE the click', () => {
    render(<PublishMatrixPanel {...publishProps} />);
    expect(
      screen.getByTestId('gm-publish-cohort-note').textContent,
      'publishing is restricted server-side to moderators + app-dev-testers, so the control must not be offered as if it will work for everyone',
    ).toMatch(/moderators and app-developer testers/i);
  });

  it('names how many images the click will create', () => {
    render(<PublishMatrixPanel {...publishProps} />);
    expect(screen.getByTestId('gm-publish')).toHaveTextContent('Publish 4 images');
  });

  it('shows which host confirm the viewer is looking at while publishing', () => {
    render(<PublishMatrixPanel {...publishProps} phase={{ kind: 'busy', done: 1, total: 4 }} />);
    const button = screen.getByTestId('gm-publish');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Confirming image 2 of 4');
  });

  it('does not offer publishing to an anonymous viewer', () => {
    render(<PublishMatrixPanel {...publishProps} signedIn={false} />);
    expect(screen.getByTestId('gm-publish')).toBeDisabled();
    expect(screen.getByTestId('gm-publish-anon')).toBeInTheDocument();
  });

  it('renders the outcome line as a live region', () => {
    render(
      <PublishMatrixPanel
        {...publishProps}
        message="Nothing was published. publishing is limited to app developers"
        messageIsProblem
      />,
    );
    const status = screen.getByTestId('gm-publish-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/limited to app developers/i);
  });
});

// ---------------------------------------------------------------------------
// F1 — provenance. The app cannot prove app-authorship, so it must not imply it.
// ---------------------------------------------------------------------------

describe('GalleryPanel — provenance', () => {
  it('🔴 never claims a row came from the app author', () => {
    render(<GalleryPanel {...props()} />);
    expect(
      screen.getByTestId('gm-gallery').textContent,
      'gallery-provenance-guard: creating the shared ENTRY is not cohort-gated — any authenticated viewer past min-trust can append a row pointing at ids they read out of the gallery, so a header claiming app-authorship lends the app’s voice to a stranger',
    ).not.toMatch(/app author/i);
  });

  it('labels a stranger’s row as a stranger’s, not as unlabelled', () => {
    render(<GalleryPanel {...props()} />);
    expect(
      screen.getByTestId('gm-gallery-provenance'),
      'gallery-provenance-badge-guard: a badge shown only on your OWN rows leaves every other row unlabelled, and an unlabelled row in an app’s gallery is read as the app’s own',
    ).toHaveTextContent('Published by another Civitai member');
  });

  it('labels the viewer’s own row from the host-stamped authorUserId', () => {
    render(
      <GalleryPanel
        {...props({ load: { kind: 'ok', entries: [entry({ authorUserId: 42 })], truncated: false } })}
      />,
    );
    expect(screen.getByTestId('gm-gallery-provenance')).toHaveTextContent('Published by you');
    expect(screen.getByTestId('gm-gallery-withdraw')).toBeInTheDocument();
  });

  it('🔴 fails CLOSED when the viewer id is unknown — nothing is yours', () => {
    render(
      <GalleryPanel
        {...props({
          viewerUserId: null,
          load: { kind: 'ok', entries: [entry({ authorUserId: 42 })], truncated: false },
        })}
      />,
    );
    expect(
      screen.queryByTestId('gm-gallery-withdraw'),
      'gallery-own-failclosed-guard: with no id to compare, withdraw (author-scoped server-side) must be withheld — offering it wrongly guarantees an error, withholding it costs one refresh',
    ).toBeNull();
    expect(screen.getByTestId('gm-gallery-provenance')).toHaveTextContent('another Civitai member');
  });

  it('🔴 a signed-OUT viewer owns nothing, even with keys left in state', () => {
    // F5: the own-keys effect used to early-return on sign-out WITHOUT clearing,
    // leaving an enabled Remove on rows the current viewer does not own.
    render(<GalleryPanel {...props({ signedIn: false, ownKeys: new Set(['k_a']) })} />);
    expect(
      screen.queryByTestId('gm-gallery-withdraw'),
      'gallery-signedout-own-guard: withdraw is author-scoped server-side, so a stale own-key surviving a sign-out offers a control that can only reject',
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F4 — text read off the wire is bounded on BOTH axes.
// ---------------------------------------------------------------------------

describe('GalleryPanel — hostile text cannot break the layout', () => {
  it('🔴 wraps an unbroken token instead of pushing the card past the iframe', () => {
    render(
      <GalleryPanel
        {...props({
          load: {
            kind: 'ok',
            entries: [entry({ title: 'A'.repeat(300), body: 'B'.repeat(300) })],
            truncated: false,
          },
        })}
      />,
    );
    expect(
      screen.getByTestId('gm-gallery-title').style.overflowWrap,
      'gallery-wrap-guard: a single unbroken token has no break opportunity, so without an explicit wrap it widens the card past the iframe — and nothing constrains the iframe’s width',
    ).toBe('anywhere');
    expect(screen.getByTestId('gm-gallery-body').style.overflowWrap).toBe('anywhere');
  });
});

// ---------------------------------------------------------------------------
// F2 — a published matrix cannot be published again.
// ---------------------------------------------------------------------------

describe('PublishMatrixPanel — already published', () => {
  const base = {
    c,
    publishable: 4,
    title: 'T',
    setTitle: vi.fn(),
    phase: { kind: 'idle' } as const,
    message: null,
    messageIsProblem: false,
    signedIn: true,
    alreadyPublished: false,
    alreadyPublishedCount: 0,
    onPublish: vi.fn(),
  };

  it('🔴 disables and RELABELS once this matrix is in the gallery', () => {
    render(<PublishMatrixPanel {...base} alreadyPublished />);
    const button = screen.getByTestId('gm-publish');
    expect(
      button,
      'gallery-republish-guard: publishing creates real, permanent public images with no un-publish, so the control must not return to enabled on a matrix already published',
    ).toBeDisabled();
    expect(button).toHaveTextContent(/already published/i);
    expect(screen.getByTestId('gm-publish-already')).toHaveTextContent(/cannot be undone/i);
  });

  it('stays armed for a matrix that has not been published', () => {
    render(<PublishMatrixPanel {...base} />);
    expect(screen.getByTestId('gm-publish')).toBeEnabled();
    expect(screen.queryByTestId('gm-publish-already')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-3 follow-ups.
// ---------------------------------------------------------------------------

describe('PublishMatrixPanel — extending a partly-published matrix', () => {
  const base = {
    c,
    publishable: 1,
    alreadyPublishedCount: 3,
    title: 'T',
    setTitle: vi.fn(),
    phase: { kind: 'idle' } as const,
    message: null,
    messageIsProblem: false,
    signedIn: true,
    alreadyPublished: false,
    onPublish: vi.fn(),
  };

  it('🔴 says it will publish only what is NEW, into the same entry', () => {
    render(<PublishMatrixPanel {...base} />);
    expect(
      screen.getByTestId('gm-publish'),
      'gallery-percell-ledger-guard: a retry grows the publishable set, and a control that offers "Publish 4 images" over three already-public cells republishes them permanently',
    ).toHaveTextContent('Publish 1 more image');
    expect(screen.getByTestId('gm-publish-extending')).toHaveTextContent(
      /3 cells of this matrix are already published/i,
    );
    expect(screen.getByTestId('gm-publish-extending')).toHaveTextContent(/same gallery entry/i);
  });

  it('says nothing about extending on a matrix published for the first time', () => {
    render(<PublishMatrixPanel {...base} alreadyPublishedCount={0} publishable={4} />);
    expect(screen.getByTestId('gm-publish')).toHaveTextContent('Publish 4 images');
    expect(screen.queryByTestId('gm-publish-extending')).toBeNull();
  });
});

describe('the two cohort sentences read together', () => {
  it('🔴 the gallery note says who can ADD a row, not just who can publish images', () => {
    render(<GalleryPanel {...props()} />);
    const note = screen.getByTestId('gm-gallery-provenance-note').textContent ?? '';
    expect(
      note,
      'gallery-cohort-legibility-guard: side by side with the publish panel’s "limited to moderators and app-developer testers", a bare "published by Civitai members" reads as a contradiction — the two describe different mechanisms and must say so',
    ).toMatch(/any signed-in civitai member can add an entry/i);
    expect(note).toMatch(/creating new images through this app is limited/i);
  });

  it('the publish panel names the same split from its own side', () => {
    render(
      <PublishMatrixPanel
        c={c}
        publishable={2}
        alreadyPublishedCount={0}
        title="T"
        setTitle={vi.fn()}
        phase={{ kind: 'idle' }}
        message={null}
        messageIsProblem={false}
        signedIn
        alreadyPublished={false}
        onPublish={vi.fn()}
      />,
    );
    const note = screen.getByTestId('gm-publish-cohort-note').textContent ?? '';
    // The sentence the server actually backs is untouched…
    expect(note).toMatch(/limited to Civitai moderators and app-developer testers/i);
    // …and the clarifier stops it colliding with the gallery header.
    expect(note).toMatch(/adding an entry to the gallery is open to any signed-in/i);
  });
});

describe('the image grid has its own overflow container', () => {
  it('🔴 scrolls the table rather than widening the card', () => {
    render(<GalleryPanel {...props()} />);
    const scroller = screen.getByTestId('gm-gallery-grid-scroll');
    expect(
      scroller.style.overflowX,
      'gallery-grid-overflow-guard: up to 12 columns at minWidth 90 is ~1080px of table, and text wrapping does nothing for it — the width comes from the cells’ own minimum',
    ).toBe('auto');
    expect(scroller.style.maxWidth).toBe('100%');
    expect(scroller.contains(screen.getByTestId('gm-gallery-grid'))).toBe(true);
  });
});
