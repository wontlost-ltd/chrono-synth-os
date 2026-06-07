import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stepper } from './Stepper';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const steps = [
  { id: 'step1', label: 'First' },
  { id: 'step2', label: 'Second' },
  { id: 'step3', label: 'Third' },
];

describe('Stepper', () => {
  it('renders all step labels', () => {
    render(<Stepper steps={steps} currentId="step1" />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
  });

  it('marks current step with aria-current', () => {
    render(<Stepper steps={steps} currentId="step2" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.getAttribute('aria-current')).toBeNull();
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[2]?.getAttribute('aria-current')).toBeNull();
  });

  it('shows checkmark for completed steps', () => {
    render(<Stepper steps={steps} currentId="step3" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('✓');
    expect(items[1]?.textContent).toContain('✓');
    expect(items[2]?.textContent).toContain('3');
  });

  it('has nav with accessible label', () => {
    render(<Stepper steps={steps} currentId="step1" />);
    expect(screen.getByRole('navigation')).toHaveAttribute('aria-label', 'stepper.ariaLabel');
  });
});
