// G2 — a render-error boundary so a throw mid-run can't blank the iframe AFTER
// the user has spent Buzz. A React error boundary MUST be a class (there is no
// hook equivalent for `componentDidCatch`), so this stays a small class + a
// functional `RootBoundary` wrapper that wires the host analytics sink.
//
// It is mounted INSIDE `<BlockGate>` (see main.tsx) so `useBlockAnalytics()`
// always has host context when it reports a caught crash.

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useBlockAnalytics } from '@civitai/blocks-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Reported the caught error (analytics). Fire-and-forget. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Optional custom fallback; defaults to the recoverable card below. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <DefaultFallback reset={this.reset} />;
  }
}

/**
 * The default recoverable fallback. Uses `var(--civitai-*)` tokens with hardcoded
 * fallbacks after the comma — this is the ONE place a raw hex is acceptable,
 * because the fallback must still render if the token stylesheet itself failed
 * to load (which is one of the failures this boundary exists to survive).
 *
 * MONEY HONESTY: the copy states outputs are safe — a render crash never un-does
 * a settled spend, and the persisted read-model (M1) rebuilds the paid matrix on
 * the next mount — so "Try again" re-mounts the subtree rather than losing it.
 */
function DefaultFallback({ reset }: { reset: () => void }): ReactNode {
  return (
    <div
      role="alert"
      data-testid="gm-error-boundary"
      style={{
        margin: '24px auto',
        maxWidth: 460,
        padding: 20,
        display: 'grid',
        gap: 10,
        textAlign: 'center',
        borderRadius: 12,
        border: '1px solid var(--civitai-color-border, #dee2e6)',
        background: 'var(--civitai-color-surface, #f8f9fa)',
        color: 'var(--civitai-color-text, #1a1b1e)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <strong style={{ fontSize: 16 }}>Something went wrong</strong>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--civitai-color-text-dimmed, #868e96)', lineHeight: 1.5 }}>
        The page hit an unexpected error. Any generations you already paid for are safe — they'll
        reappear when you reopen the matrix. Try again to reload this view.
      </p>
      <button
        type="button"
        onClick={reset}
        data-testid="gm-error-retry"
        style={{
          justifySelf: 'center',
          padding: '10px 18px',
          borderRadius: 8,
          border: 'none',
          background: 'var(--civitai-color-primary, #f08c00)',
          color: 'var(--civitai-color-primary-fg, #fff)',
          fontWeight: 700,
          fontSize: 14,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * The app-root boundary: wires the host analytics `track()` into the boundary's
 * `onError` so every caught crash emits a `render_error` event (name + message
 * only — never PII). Wrap the app in this INSIDE `<BlockGate>`.
 */
export function RootBoundary({ children }: { children: ReactNode }): ReactNode {
  const { track } = useBlockAnalytics();
  return (
    <ErrorBoundary
      onError={(error) => track('render_error', { message: error.message, name: error.name })}
    >
      {children}
    </ErrorBoundary>
  );
}
