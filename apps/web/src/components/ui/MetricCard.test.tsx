import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricCard } from './MetricCard';

describe('MetricCard', () => {
  it('renders title and formatted value', () => {
    render(<MetricCard title="综合评分" value={0.85} />);
    expect(screen.getByText('综合评分')).toBeInTheDocument();
    expect(screen.getByText('0.850')).toBeInTheDocument();
  });

  it('renders up trend indicator', () => {
    render(<MetricCard title="分数" value={0.9} trend="up" />);
    expect(screen.getByText('↑')).toBeInTheDocument();
  });

  it('renders down trend indicator', () => {
    render(<MetricCard title="分数" value={0.3} trend="down" />);
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('renders flat trend indicator', () => {
    render(<MetricCard title="分数" value={0.5} trend="flat" />);
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('formats currency values', () => {
    render(<MetricCard title="财富" value={50000} unit="¥" />);
    expect(screen.getByText('¥5.0万')).toBeInTheDocument();
  });

  it('does not render trend when not provided', () => {
    const { container } = render(<MetricCard title="测试" value={0.5} />);
    expect(container.querySelector('.text-success')).toBeNull();
    expect(container.querySelector('.text-warning')).toBeNull();
  });

  it('applies custom className', () => {
    const { container } = render(<MetricCard title="测试" value={0} className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
