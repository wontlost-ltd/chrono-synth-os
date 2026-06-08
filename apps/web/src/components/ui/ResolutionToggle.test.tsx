import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResolutionToggle } from './ResolutionToggle';

describe('ResolutionToggle', () => {
  it('renders radiogroup with three options', () => {
    render(<ResolutionToggle value="year" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: '时间分辨率' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('marks the active value as checked', () => {
    render(<ResolutionToggle value="2y" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '2年' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '年' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when clicking a different option', () => {
    const onChange = vi.fn();
    render(<ResolutionToggle value="year" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '5年' }));
    expect(onChange).toHaveBeenCalledWith('5y');
  });

  it('sets tabIndex 0 on active, -1 on inactive', () => {
    render(<ResolutionToggle value="year" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '年' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '2年' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: '5年' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves to next option on ArrowRight', () => {
    const onChange = vi.fn();
    render(<ResolutionToggle value="year" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('2y');
  });

  it('wraps around on ArrowLeft from first option', () => {
    const onChange = vi.fn();
    render(<ResolutionToggle value="year" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('5y');
  });
});
