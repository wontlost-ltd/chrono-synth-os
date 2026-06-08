import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ValueFlip } from './ValueFlip';

function installMatchMedia(reduced: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe('ValueFlip', () => {
  beforeEach(() => {
    installMatchMedia(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the initial value immediately', () => {
    render(<ValueFlip value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('accepts a custom format function', () => {
    render(<ValueFlip value={1234} format={(n) => n.toLocaleString('en-US')} />);
    /* en-US locale uses comma thousand separator */
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });

  it('jumps directly when prefers-reduced-motion is set', () => {
    installMatchMedia(true);
    const { rerender } = render(<ValueFlip value={10} />);
    rerender(<ValueFlip value={50} />);
    /* No animation; the new value should appear without a microtask. */
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('renders aria-live="polite" so screen readers see the value', () => {
    const { container } = render(<ValueFlip value={7} />);
    const span = container.querySelector('[aria-live="polite"]');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('7');
  });
});
