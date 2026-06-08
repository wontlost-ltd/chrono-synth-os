import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RadioGroup } from './RadioGroup';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('RadioGroup', () => {
  it('renders radiogroup with correct label', () => {
    render(<RadioGroup options={OPTIONS} value="a" onChange={() => {}} label="测试" />);
    expect(screen.getByRole('radiogroup', { name: '测试' })).toBeInTheDocument();
  });

  it('renders all options as radio buttons', () => {
    render(<RadioGroup options={OPTIONS} value="a" onChange={() => {}} label="测试" />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('marks active option as checked', () => {
    render(<RadioGroup options={OPTIONS} value="b" onChange={() => {}} label="测试" />);
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'false');
  });

  it('sets tabIndex 0 on active, -1 on others', () => {
    render(<RadioGroup options={OPTIONS} value="a" onChange={() => {}} label="测试" />);
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  });

  it('calls onChange on click', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="a" onChange={onChange} label="测试" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('moves to next on ArrowRight', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="a" onChange={onChange} label="测试" />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('wraps around on ArrowLeft from first', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="a" onChange={onChange} label="测试" />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('wraps around on ArrowRight from last', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="c" onChange={onChange} label="测试" />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('applies custom className', () => {
    const { container } = render(<RadioGroup options={OPTIONS} value="a" onChange={() => {}} label="测试" className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
