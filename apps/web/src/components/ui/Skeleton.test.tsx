import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton } from './Skeleton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('Skeleton', () => {
  it('renders with status role', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has accessible loading label', () => {
    render(<Skeleton />);
    expect(screen.getByLabelText('common.loading')).toBeInTheDocument();
  });

  it('includes sr-only text for screen readers', () => {
    render(<Skeleton />);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('applies card height by default', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.className).toContain('h-24');
  });

  it('applies chart height for chart variant', () => {
    const { container } = render(<Skeleton variant="chart" />);
    expect(container.firstElementChild?.className).toContain('h-64');
  });

  it('applies table height for table variant', () => {
    const { container } = render(<Skeleton variant="table" />);
    expect(container.firstElementChild?.className).toContain('h-40');
  });

  it('appends custom className', () => {
    const { container } = render(<Skeleton className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });

  it('has shimmer animation class', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.className).toContain('skeleton-shimmer');
  });
});
