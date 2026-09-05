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
  /** How many cells of the open matrix can be published. */
  publishable: number;
  title: string;
  setTitle: (value: string) => void;
  phase: PublishPhase;
  /** The outcome line from `publishResultMessage`, or null before any attempt. */
  message: string | null;
  /** True when the last attempt did not fully succeed — colours the message. */
  messageIsProblem: boolean;
  /** False for an anonymous viewer — `publish` rejects for them. */
  signedIn: boolean;
  onPublish: () => void;
}

export function PublishMatrixPanel({
  c,
  publishable,
  title,
  setTitle,
  phase,
  message,
  messageIsProblem,
  signedIn,
  onPublish,
}: PublishMatrixPanelProps) {
  const busy = phase.kind === 'busy';
  const disabled = busy || publishable === 0 || !signedIn;

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
      <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-explainer">
        This creates {publishable} real, public {publishable === 1 ? 'image' : 'images'} on Civitai
        &mdash; one per finished cell &mdash; and adds this grid to the gallery every viewer can
        browse. Civitai asks you to confirm each image, and published images cannot be removed
        afterwards; only the gallery entry can.
      </p>

      {/* 🔴 THE COHORT GATE, SAID BEFORE THE CLICK. Publishing is restricted
          server-side to moderators and the app-dev-testers cohort, so for almost
          every viewer this control is an error waiting to happen. It is not
          hidden — the app cannot know who is in the cohort — but it must not be
          offered as though it will work for everyone. */}
      <p style={{ ...noteStyle(c), margin: 0 }} data-testid="gm-publish-cohort-note">
        Publishing is limited to Civitai moderators and app-developer testers. If your account
        isn&rsquo;t one of those, the request is declined and nothing is published.
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
          : `Publish ${publishable} ${publishable === 1 ? 'image' : 'images'}`}
      </button>

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
