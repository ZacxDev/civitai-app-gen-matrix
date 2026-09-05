// The published-matrix GALLERY — the browse surface every viewer gets.
//
// Presentational + prop-driven on purpose: every host call (list, vote, report,
// withdraw, gated-image read) is made by `App` and handed down as data or a
// callback, so this component renders in a plain `@testing-library/react` mount
// with no transport, and the pure decisions it renders live in `gallery.ts`.

import { useState } from 'react';

import { ReportButton } from '@civitai/blocks-react/ui';

import { MaturityImage } from './MaturityImage.js';
import type { MaturityGate } from './persistence.js';
import { noteStyle, secondaryBtn, type Palette } from './theme.js';
import {
  columnLabel,
  resolveEntryImages,
  rowLabel,
  type GalleryEntry,
  type GalleryLoad,
  type GatedImageLike,
} from './gallery.js';

/**
 * The per-viewer gated projection of every listed entry's images.
 *
 * `null` means "not read yet" and renders a loading cell — NOT an empty one.
 * Before the read resolves we know neither that an image is missing nor that it
 * is withheld, and a component that guesses at that moment shows one of those
 * two claims to a viewer for whom it is false.
 */
export type GalleryImages =
  | { kind: 'ok'; byId: ReadonlyMap<number, GatedImageLike> }
  | { kind: 'error' };

export interface GalleryPanelProps {
  c: Palette;
  /** `null` = the list read has not resolved yet. */
  load: GalleryLoad | null;
  images: GalleryImages | null;
  maturityGate: MaturityGate;
  /** False for an anonymous viewer: vote/report/withdraw all reject for them. */
  signedIn: boolean;
  /** Keys this viewer published — the only rows Withdraw may be offered on. */
  ownKeys: ReadonlySet<string>;
  /** Keys this viewer has already reported (settles `ReportButton` on load). */
  reportedKeys: ReadonlySet<string>;
  /** Keys whose vote/withdraw request is in flight. */
  busyKeys: ReadonlySet<string>;
  /** The last error surfaced by a vote/withdraw, keyed by entry. */
  actionErrors: ReadonlyMap<string, string>;
  onToggleVote: (entry: GalleryEntry) => void;
  onReport: (entry: GalleryEntry) => Promise<void>;
  onWithdraw: (entry: GalleryEntry) => void;
}

export function GalleryPanel(props: GalleryPanelProps) {
  const { c, load } = props;

  return (
    <section style={{ display: 'grid', gap: 8 }} data-testid="gm-gallery">
      <h2 style={{ fontSize: 14, margin: 0, fontWeight: 700 }}>Published matrices</h2>
      <p style={{ ...noteStyle(c), margin: 0 }}>
        Grids the app author has published. Each image is a real, public Civitai image, shown to
        you under your own browsing settings.
      </p>

      {load == null && (
        <p style={{ ...noteStyle(c), margin: 0 }} role="status" data-testid="gm-gallery-loading">
          Loading the gallery&hellip;
        </p>
      )}

      {/* 🔴 A FAILED READ AND AN EMPTY GALLERY ARE DIFFERENT FACTS, and the
          difference is not academic here: until a version carrying the
          shared-storage scopes is APPROVED, every viewer's read fails. Rendering
          that as "nothing has been published yet" would state, to everyone, a
          claim about the gallery's contents that this app cannot see. */}
      {load?.kind === 'error' && (
        <p style={{ ...noteStyle(c), margin: 0 }} role="status" data-testid="gm-gallery-error">
          We couldn&rsquo;t load the gallery just now. Nothing has been lost &mdash; reload to try
          again.
        </p>
      )}

      {load?.kind === 'ok' && load.entries.length === 0 && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-gallery-empty">
          No matrices have been published yet.
        </p>
      )}

      {load?.kind === 'ok' && load.entries.length > 0 && (
        <ul
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}
          data-testid="gm-gallery-list"
        >
          {load.entries.map((entry) => (
            <GalleryEntryCard key={entry.key} entry={entry} {...props} />
          ))}
        </ul>
      )}

      {load?.kind === 'ok' && load.truncated && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-gallery-truncated">
          Showing the most recent published matrices.
        </p>
      )}
    </section>
  );
}

function GalleryEntryCard({
  c,
  entry,
  images,
  maturityGate,
  signedIn,
  ownKeys,
  reportedKeys,
  busyKeys,
  actionErrors,
  onToggleVote,
  onReport,
  onWithdraw,
}: GalleryPanelProps & { entry: GalleryEntry }) {
  const isOwn = ownKeys.has(entry.key);
  const busy = busyKeys.has(entry.key);
  const actionError = actionErrors.get(entry.key);
  const view =
    images?.kind === 'ok' ? resolveEntryImages(entry, images.byId) : null;
  const rowRefs = new Map(entry.data.rows.map((r) => [r.row, r]));
  const colRefs = new Map(entry.data.cols.map((col) => [col.col, col]));
  // Grid shape from the entry's own coordinates so a partially-published matrix
  // renders the cells it has rather than a rectangle padded with blanks.
  const rows = [...new Set(entry.data.images.map((i) => i.row))].sort((a, b) => a - b);
  const cols = [...new Set(entry.data.images.map((i) => i.col))].sort((a, b) => a - b);
  const cellAt = (row: number, col: number) =>
    view?.cells.find((cell) => cell.row === row && cell.col === col) ?? null;

  return (
    <li
      style={{
        display: 'grid',
        gap: 8,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        background: c.cardBg,
        padding: 10,
      }}
      data-testid="gm-gallery-item"
    >
      {/* Moderated text. The title and body are the ONLY strings here that came
          from a person; everything else is derived from ids. */}
      <h3 style={{ fontSize: 14, margin: 0, fontWeight: 700 }} data-testid="gm-gallery-title">
        {entry.title}
      </h3>
      {entry.body != null && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-gallery-body">
          {entry.body}
        </p>
      )}

      {/* The resources this matrix compared.
          🔴 TEMPORARY RENDERING — a shared `ResourceCard` is being added to
          `@civitai/blocks-react/ui` in a parallel PR and is the intended
          replacement for these chips. Deliberately NOT a local component: a
          second `ResourceCard` in this repo would collide with it on arrival. */}
      <ul
        style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 4, margin: 0, padding: 0 }}
        data-testid="gm-gallery-resources"
      >
        {rows.map((row, i) => (
          <li key={`r${row}`} style={chipStyle(c)}>
            {rowLabel(rowRefs.get(row), i)}
          </li>
        ))}
        {cols.map((col, i) => (
          <li key={`c${col}`} style={chipStyle(c)}>
            {columnLabel(colRefs.get(col), i)}
          </li>
        ))}
      </ul>

      {images == null && (
        <p style={{ ...noteStyle(c), margin: 0 }} role="status" data-testid="gm-gallery-images-loading">
          Loading images&hellip;
        </p>
      )}

      {images?.kind === 'error' && (
        <p style={{ ...noteStyle(c), margin: 0 }} role="status" data-testid="gm-gallery-images-error">
          We couldn&rsquo;t load the images for this matrix.
        </p>
      )}

      {/* 🔴 EVERY IMAGE GONE IS NOT AN EMPTY GRID. An empty grid is what a grid
          still loading looks like, so a matrix whose images have all been
          removed says so instead of leaving the viewer waiting. */}
      {view?.allGone === true && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-gallery-all-gone">
          The images in this matrix are no longer available.
        </p>
      )}

      {view != null && !view.allGone && (
        <table style={{ borderCollapse: 'collapse' }} data-testid="gm-gallery-grid">
          <thead>
            <tr>
              <th style={{ ...headCell(c), width: 80 }} aria-hidden />
              {cols.map((col, i) => (
                <th key={col} scope="col" style={headCell(c)}>
                  {columnLabel(colRefs.get(col), i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row}>
                <th scope="row" style={{ ...headCell(c), textAlign: 'left' }}>
                  {rowLabel(rowRefs.get(row), i)}
                </th>
                {cols.map((col, ci) => {
                  const cell = cellAt(row, col);
                  return (
                    <td key={col} style={{ border: `1px solid ${c.border}`, padding: 4, minWidth: 90 }}>
                      {cell == null && (
                        <span style={{ ...noteStyle(c) }} data-testid="gm-gallery-cell-blank">
                          &mdash;
                        </span>
                      )}
                      {cell?.kind === 'visible' && (
                        <MaturityImage
                          src={cell.url}
                          alt={`${rowLabel(rowRefs.get(row), i)} · ${columnLabel(colRefs.get(col), ci)}`}
                          nsfwLevel={cell.nsfwLevel}
                          gate={maturityGate}
                        />
                      )}
                      {/* No url exists for a hidden image — the host never sends
                          one — so there is nothing to blur, only a placeholder. */}
                      {cell?.kind === 'hidden' && (
                        <span style={{ ...noteStyle(c) }} data-testid="gm-gallery-cell-hidden">
                          Hidden by your browsing settings
                        </span>
                      )}
                      {cell?.kind === 'gone' && (
                        <span style={{ ...noteStyle(c) }} data-testid="gm-gallery-cell-gone">
                          No longer available
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* 🔴 HYDRATED FROM `viewerVoted`, NEVER GUESSED. The host resolves it
            per viewer; a locally-assumed "not voted" is what produces the
            "click twice to unvote" bug on every reload. */}
        <button
          type="button"
          onClick={() => onToggleVote(entry)}
          disabled={!signedIn || busy}
          aria-pressed={entry.viewerVoted}
          aria-label={
            entry.viewerVoted
              ? `Remove your vote from ${entry.title}`
              : `Vote for ${entry.title}`
          }
          style={secondaryBtn(c)}
          className="gm-chip"
          data-testid="gm-gallery-vote"
        >
          {entry.viewerVoted ? '★' : '☆'} {entry.count}
        </button>

        {isOwn && (
          <WithdrawControl
            c={c}
            busy={busy}
            onWithdraw={() => onWithdraw(entry)}
          />
        )}

        {/* The shared control, not a local copy: its wording is pinned by the
            SDK's own tests so "Reported for review" cannot drift into implying a
            deletion. Offered only to a signed-in viewer who does not own the row
            — `report()` rejects for anyone anonymous, and an author has Remove. */}
        {!isOwn && signedIn && (
          <ReportButton
            noun="matrix"
            reported={reportedKeys.has(entry.key)}
            onReport={() => onReport(entry)}
            data-testid={`gm-gallery-${entry.key}-report`}
          />
        )}
      </div>

      {actionError != null && (
        <p
          style={{ ...noteStyle(c), margin: 0, color: c.danger }}
          role="alert"
          data-testid="gm-gallery-action-error"
        >
          {actionError}
        </p>
      )}
    </li>
  );
}

/**
 * Withdraw, behind a confirm.
 *
 * Two steps because the act is not symmetric: the entry can be republished only
 * by publishing again, which creates a SECOND set of real public images. So an
 * accidental Remove costs more than a click.
 */
function WithdrawControl({
  c,
  busy,
  onWithdraw,
}: {
  c: Palette;
  busy: boolean;
  onWithdraw: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        style={secondaryBtn(c)}
        className="gm-chip"
        data-testid="gm-gallery-withdraw"
      >
        Remove
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span style={noteStyle(c)} data-testid="gm-gallery-withdraw-prompt">
        Remove from the gallery? The images stay public on Civitai.
      </span>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          onWithdraw();
        }}
        disabled={busy}
        style={secondaryBtn(c)}
        className="gm-chip"
        data-testid="gm-gallery-withdraw-confirm"
      >
        Remove
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        style={secondaryBtn(c)}
        className="gm-chip"
        data-testid="gm-gallery-withdraw-cancel"
      >
        Cancel
      </button>
    </span>
  );
}

function chipStyle(c: Palette): React.CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid ${c.border}`,
    fontSize: 12,
    color: c.muted,
  };
}

function headCell(c: Palette): React.CSSProperties {
  return {
    border: `1px solid ${c.border}`,
    padding: 6,
    fontSize: 12,
    fontWeight: 700,
    background: c.cardBg,
  };
}
