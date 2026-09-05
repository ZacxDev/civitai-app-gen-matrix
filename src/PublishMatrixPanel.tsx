// The PUBLISH control — the write side of the gallery.
//
// Presentational + prop-driven; `App` owns the host calls and the async
// orchestration (`publishMatrix` in gallery.ts).

import { noteStyle, primaryBtn, type Palette } from './theme.js';
import { GALLERY_TITLE_MAX } from './gallery.js';

/** Where a publish attempt currently is. */
export type PublishPhase =
  | { kind: 'idle' }
  /** `done` cells published so far, out of `total`. */
  | { kind: 'busy'; done: number; total: number };

export interface PublishMatrixPanelProps {
  c: Palette;
  /**
   * How many cells of the open matrix are NOT yet published by this viewer.
   *
   * The remainder, never the whole publishable set: a retry that adds a fourth
   * cell to a matrix whose three others are already in the gallery publishes ONE
   * image, and the button says so.
   */
  publishable: number;
  /** Cells of this matrix already published — drives the "N more" wording. */
  alreadyPublishedCount: number;
  title: string;
  setTitle: (value: string) => void;
  phase: PublishPhase;
  /** The outcome line from `publishResultMessage`, or null before any attempt. */
  message: string | null;
  /** True when the last attempt did not fully succeed — colours the message. */
  messageIsProblem: boolean;
  /** False for an anonymous viewer — `publish` rejects for them. */
  signedIn: boolean;
  /**
   * This exact matrix has already been published in this session.
   *
   * 🔴 THE CONTROL MUST NOT RE-ARM ON THE SAME GRID. Publishing creates real,
   * permanent public images and there is no un-publish, so a second click on a
   * matrix already published is unrecoverable duplication — measured: two clicks
   * produced two gallery rows and two sets of images, with the button enabled
   * and identically labelled in between.
   */
  alreadyPublished: boolean;
  onPublish: () => void;
}

export function PublishMatrixPanel({
  c,
  publishable,
  alreadyPublishedCount,
  title,
  setTitle,
  phase,
  message,
  messageIsProblem,
  signedIn,
  alreadyPublished,
  onPublish,
}: PublishMatrixPanelProps) {
  const busy = phase.kind === 'busy';
  // Some cells of this matrix are already in the gallery and some are not — the
  // shape a "Retry failed" run leaves behind.
  const extending = alreadyPublishedCount > 0 && publishable > 0;
  const disabled = busy || publishable === 0 || !signedIn || alreadyPublished;

  return (
    <section
      style={{
        display: 'grid',
        gap: 8,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: 10,
      }}
      data-testid="gm-publish-panel"
    >
      <h2 style={{ fontSize: 14, margin: 0, fontWeight: 700 }}>Publish to the gallery</h2>

      {/* 🔴 SAY WHAT IT DOES. "Publish" here is a bigger act than "save": the
          host re-uploads each output, runs the full image scan, and creates a
          REAL, PUBLIC Civitai image row per cell. There is no un-publish — the
          gallery entry can be withdrawn, the images cannot. A viewer must be
          able to tell that from the screen, not from the API docs. */}
      {/* 🔴 WITHHELD WHEN THERE IS NOTHING LEFT TO PUBLISH. This state is new:
          until the per-cell ledger landed, `publishable` was always > 0 wherever
          this panel rendered, so the sentence could not contradict itself. Now
          it can — "This creates 0 real, public images on Civitai" — and while
          the button is disabled and the note below is correct, a sentence that
          argues with the state next to it is how a reader stops trusting either.
          The `gm-publish-already` note says what is true instead. */}
      {!alreadyPublished && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-explainer">
          This creates {publishable} real, public {publishable === 1 ? 'image' : 'images'} on
          Civitai &mdash; one per finished cell &mdash; and{' '}
          {extending
            ? 'adds them to this matrix’s existing gallery entry'
            : 'adds this grid to the gallery every viewer can browse'}
          . Civitai asks you to confirm each image, and published images cannot be removed
          afterwards; only the gallery entry can.
        </p>
      )}

      {/* 🔴 THE COHORT GATE, SAID BEFORE THE CLICK. Publishing is restricted
          server-side to moderators and the app-dev-testers cohort, so for almost
          every viewer this control is an error waiting to happen. It is not
          hidden — the app cannot know who is in the cohort — but it must not be
          offered as though it will work for everyone. */}
      <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-cohort-note">
        Publishing is limited to Civitai moderators and app-developer testers. If your account
        isn&rsquo;t one of those, the request is declined and nothing is published. That limit is
        on creating the images &mdash; adding an entry to the gallery is open to any signed-in
        Civitai member.
      </p>

      <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
        Gallery title
        <input
          type="text"
          value={title}
          maxLength={GALLERY_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${c.border}`,
            background: c.inputBg,
            color: c.fg,
            fontSize: 14,
          }}
          data-testid="gm-publish-title"
        />
      </label>

      <button
        type="button"
        onClick={onPublish}
        disabled={disabled}
        style={primaryBtn(c, disabled)}
        data-testid="gm-publish"
      >
        {busy
          ? `Confirming image ${Math.min(phase.done + 1, phase.total)} of ${phase.total}…`
          : alreadyPublished
            ? 'Already published to the gallery'
            : extending
              ? `Publish ${publishable} more ${publishable === 1 ? 'image' : 'images'}`
              : `Publish ${publishable} ${publishable === 1 ? 'image' : 'images'}`}
      </button>

      {alreadyPublished && !busy && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-already">
          Every finished cell of this matrix is already in the gallery. Publishing it again would
          create a second set of public images, which cannot be undone &mdash; start a new matrix
          to publish a different grid.
        </p>
      )}

      {extending && !busy && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-extending">
          {alreadyPublishedCount} {alreadyPublishedCount === 1 ? 'cell' : 'cells'} of this matrix
          {alreadyPublishedCount === 1 ? ' is' : ' are'} already published. Only the rest will be
          added &mdash; to the same gallery entry where it still exists, keeping its votes and
          reports, or to a new one if it has been removed.
        </p>
      )}

      {!signedIn && (
        <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-anon">
          Sign in to publish.
        </p>
      )}

      {message != null && (
        <p
          style={{ ...noteStyle(c), margin: 0, ...(messageIsProblem ? { color: c.danger } : {}) }}
          role="status"
          data-testid="gm-publish-status"
        >
          {message}
        </p>
      )}
    </section>
  );
}
