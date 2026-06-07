import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EmptyState } from './EmptyState';

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('EmptyState (legacy API)', () => {
  it('renders message text', () => {
    wrap(<EmptyState message="无数据" />);
    expect(screen.getByText('无数据')).toBeInTheDocument();
  });

  it('uses status role by default', () => {
    wrap(<EmptyState message="空" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses alert role for error variant', () => {
    wrap(<EmptyState variant="error" message="加载失败: timeout" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('applies warning color to error variant text', () => {
    wrap(<EmptyState variant="error" message="错误" />);
    const text = screen.getByText('错误');
    expect(text.className).toContain('text-warning');
  });

  it('applies secondary color to empty variant text', () => {
    wrap(<EmptyState message="空" />);
    const text = screen.getByText('空');
    expect(text.className).toContain('text-text-secondary');
  });

  it('renders legacy action slot when provided', () => {
    wrap(<EmptyState message="无数据" action={<button>重试</button>} />);
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});

describe('EmptyState (P1.7.2 structured API)', () => {
  it('renders title above message when both provided', () => {
    wrap(<EmptyState title="还没有 persona" message="创建一个开始" />);
    const title = screen.getByRole('heading', { level: 2 });
    expect(title).toHaveTextContent('还没有 persona');
    expect(screen.getByText('创建一个开始')).toBeInTheDocument();
  });

  it('renders an SVG illustration when illustration prop is set', () => {
    const { container } = wrap(<EmptyState message="空" illustration="personas" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('auto-uses error illustration when variant=error and no illustration set', () => {
    const { container } = wrap(<EmptyState variant="error" message="加载失败" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders primaryAction as a Link when `to` is provided', () => {
    wrap(
      <EmptyState
        message="空"
        primaryAction={{ label: '创建', to: '/personas/new' }}
      />,
    );
    const link = screen.getByRole('link', { name: '创建' });
    expect(link).toHaveAttribute('href', '/personas/new');
  });

  it('renders primaryAction as an external anchor when `href` is provided', () => {
    wrap(
      <EmptyState
        message="空"
        primaryAction={{ label: 'docs', href: 'https://example.test' }}
      />,
    );
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders primaryAction as a button when only onClick is provided', () => {
    const onClick = vi.fn();
    wrap(
      <EmptyState
        message="空"
        primaryAction={{ label: '点我', onClick }}
      />,
    );
    const button = screen.getByRole('button', { name: '点我' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders both primary and secondary actions when both provided', () => {
    wrap(
      <EmptyState
        message="空"
        primaryAction={{ label: '主要', to: '/a' }}
        secondaryAction={{ label: '次要', href: 'https://x.test' }}
      />,
    );
    expect(screen.getByRole('link', { name: '主要' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '次要' })).toBeInTheDocument();
  });
});
