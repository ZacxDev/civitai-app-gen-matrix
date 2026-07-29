import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary.js';

function Boom(): never {
  throw new Error('kaboom');
}

/**
 * A child whose throwing is driven by an EXTERNAL control object (not a
 * render-flipped flag — React double-invokes renders in dev, which would defeat
 * that). The test flips `shouldThrow` off before clicking Retry, modelling a
 * transient crash that clears on the re-mount.
 */
function makeFlakyChild() {
  const ctl = { shouldThrow: true };
  const Child = () => {
    if (ctl.shouldThrow) throw new Error('flaky');
    return <div data-testid="recovered">recovered</div>;
  };
  return { Child, ctl };
}

describe('ErrorBoundary (G2)', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">hi</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('catches a render throw, shows the recoverable fallback, and reports onError', () => {
    const onError = vi.fn();
    // Silence React's error logging for this expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('gm-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // Money-honesty copy: paid outputs are safe.
    expect(screen.getByTestId('gm-error-boundary').textContent).toMatch(/already paid for are safe/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it('Try again re-mounts the subtree (recovery)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Child, ctl } = makeFlakyChild();
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('gm-error-retry')).toBeInTheDocument();
    ctl.shouldThrow = false; // the transient cause has cleared
    await userEvent.click(screen.getByTestId('gm-error-retry'));
    expect(await screen.findByTestId('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
