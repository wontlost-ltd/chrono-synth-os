import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('StatusBadge', () => {
  it('renders with correct status label from i18n', () => {
    render(<StatusBadge status="active" />);
    expect(screen.getByText('statusBadge.active')).toBeInTheDocument();
  });

  it('uses custom label when provided', () => {
    render(<StatusBadge status="error" label="Custom Error" />);
    expect(screen.getByText('Custom Error')).toBeInTheDocument();
  });

  it('renders icon with aria-hidden', () => {
    const { container } = render(<StatusBadge status="syncing" />);
    const icon = container.querySelector('[aria-hidden="true"]');
    expect(icon).toBeInTheDocument();
    expect(icon?.textContent).toBe('↻');
  });

  it('applies sm size classes by default', () => {
    const { container } = render(<StatusBadge status="active" />);
    expect(container.firstElementChild?.className).toContain('text-xs');
  });

  it('applies md size classes when specified', () => {
    const { container } = render(<StatusBadge status="active" size="md" />);
    expect(container.firstElementChild?.className).toContain('text-sm');
  });

  it('has aria-label for accessibility', () => {
    render(<StatusBadge status="completed" />);
    expect(screen.getByLabelText('statusBadge.completed')).toBeInTheDocument();
  });
});
